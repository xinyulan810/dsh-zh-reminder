/**
 * dsh-zh-reminder —— 中文思考提醒插件（host-only bundle，零运行时依赖）
 *
 * 功能一：会话开头提醒「用中文思考与回答」，每个会话恰好注入一次。
 * 功能二：有界抽检助手回复的英文占比，任意一段（代码块之外）超过阈值就再次提醒。
 *
 * 性能约定：检测只在 assistant/message 事件里对回复开头做一次 O(maxScanChars) 的
 * 有界扫描，命中第一段超标即返回；会话状态由投影单元折叠成几个标量，不订阅
 * session/event、不重扫会话日志、不加定时器、不产生额外请求、不改写系统提示词。
 */

import { DEFAULTS, detectEnglish, normalizeConfig } from './detect.js';

export const name = 'dsh-zh-reminder';

export const inject = ['sessionProjections'];

const PROJECTION_KEY = 'dsh-zh-reminder/state';
const STATE_VERSION = 1;

const START_LABEL = 'dsh-zh-reminder:start';
const REPEAT_LABEL = 'dsh-zh-reminder:repeat';

/* ------------------------------------------------------------ 消息工具 */

/** 自定义消息 id，避免为了一个字符串引入官方包依赖。 */
function messageId() {
    const cryptoRef = globalThis.crypto;
    if (cryptoRef !== undefined && typeof cryptoRef.randomUUID === 'function') {
        return cryptoRef.randomUUID().replaceAll('-', '');
    }
    return Math.random().toString(16).slice(2).padEnd(16, '0');
}

function reminderMessage(label, text) {
    return {
        id: messageId(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: label, text }] },
    };
}

/** 本插件提醒消息的标签；非本插件消息返回 undefined。 */
function reminderLabel(message) {
    if (message === null || typeof message !== 'object') return undefined;
    const source = message.source;
    if (source === null || typeof source !== 'object' || source.plugin !== name) return undefined;
    const sections = source.sections;
    return Array.isArray(sections) && sections.length > 0 ? sections[0]?.name : undefined;
}

/** 取一条助手消息里的全部正文（只保留 text 块，忽略 reasoning 与 tool-call）。 */
function messageText(message) {
    const content = message === null || typeof message !== 'object' ? undefined : message.content;
    if (!Array.isArray(content)) return '';
    let out = '';
    for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            out += `${block.text}\n`;
        }
    }
    return out;
}

function createState() {
    return {
        turn: 0,
        step: 0,
        waitingStart: true,
        awaitingRepeat: false,
        repeatTurn: 0,
        repeatStep: 0,
    };
}

/* ------------------------------------------------------------------ 插件 */

export function apply(ctx, config) {
    const options = normalizeConfig(config);

    ctx.sessionProjections.register({
        key: PROJECTION_KEY,
        stateVersion: STATE_VERSION,
        init: () => createState(),
        /**
         * 纯 fold：只维护轮次与「是否需要提醒」的标量，对无关事件一律返回同一引用。
         *
         * pre-step 只能读状态、不能回写状态，因此「已提醒」以会话日志为准：本插件
         * 注入的提醒消息落入日志后会再以 user/message 事件回到这里，把对应 flag 落定。
         * 这样即使同一轮内多次经过 pre-step，也不会重复注入同一条提醒。
         *
         * @param state 上一状态
         * @param event 会话事件
         * @returns 新状态，或原状态引用
         */
        apply(state, event) {
            if (event.type === 'turn/start') {
                const turn = event.data?.turn ?? state.turn;
                return turn === state.turn ? state : { ...state, turn };
            }
            if (event.type === 'step/start') {
                const turn = event.data?.turn ?? state.turn;
                const step = event.data?.step ?? state.step;
                return turn === state.turn && step === state.step ? state : { ...state, turn, step };
            }
            if (event.type === 'user/message') {
                const label = reminderLabel(event.data);
                if (label === START_LABEL) return state.waitingStart ? { ...state, waitingStart: false } : state;
                if (label === REPEAT_LABEL) return state.awaitingRepeat ? { ...state, awaitingRepeat: false } : state;
                return state;
            }
            if (event.type === 'assistant/message') {
                const data = event.data ?? {};
                const turn = data.turn ?? state.turn;
                const step = data.step ?? state.step;
                const settled = turn === state.turn && step === state.step;
                // 被中断的回复不完整，不判定；已有未消费的提醒也不再重复检测。
                if (data.interrupted === true || state.awaitingRepeat) {
                    return settled ? state : { ...state, turn, step };
                }
                const hit = detectEnglish(messageText(data.message), options);
                if (!hit.triggered) return settled ? state : { ...state, turn, step };
                return { ...state, turn, step, awaitingRepeat: true, repeatTurn: turn, repeatStep: step };
            }
            return state;
        },
    });

    ctx.on(
        'agent/pre-step',
        async ({ agent, turn, step, signal }, next) => {
            const decision = await next();
            try {
                if (decision.kind === 'reject' || (signal !== undefined && signal.aborted)) return decision;
                const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
                if (state === undefined) return decision;

                // 功能一：会话第一步注入一次中文提醒；功能二：上一段回复出现超标英文，
                // 在其之后的下一次 pre-step 提醒一次。位置比较（而非仅比轮次）是为了让
                // 同一轮内的后续 step 不会重复拿到同一条提醒。
                const startOpen = state.waitingStart === true && step === 1;
                const repeatDue = state.awaitingRepeat === true
                    && (turn > state.repeatTurn || (turn === state.repeatTurn && step > state.repeatStep));
                if (!startOpen && !repeatDue) return decision;

                const label = startOpen ? START_LABEL : REPEAT_LABEL;
                const text = startOpen ? options.startReminder : options.repeatReminder;
                // 展开 decision 保留 startsRequestSeries 等字段；提醒插在最前，先于本轮真实输入。
                return { ...decision, messages: [reminderMessage(label, text), ...decision.messages] };
            } catch {
                // 提醒属于增强能力：任何异常都不能影响会话主流程。
                return decision;
            }
        },
        { prepend: true },
    );
}

export { DEFAULTS };
