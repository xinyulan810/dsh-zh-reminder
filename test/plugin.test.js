import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

const ENGLISH = 'The quick brown fox jumps over the lazy dog near the river bank.';
const CHINESE = '这是一段完全用中文写的说明文字，内容比较长，足以越过最小段落长度限制并真正参与判定。';

/**
 * 最小可用的宿主替身：只实现本插件用到的 ctx.on 与 ctx.sessionProjections。
 * 投影状态用内存里的 (state, event) 双参数 fold 模拟注册表的驱动方式。
 */
function createHarness() {
    const session = {};
    let preStep;
    let state;
    let definition;

    const ctx = {
        on(eventName, listener) {
            if (eventName === 'agent/pre-step') preStep = listener;
            return () => {};
        },
        sessionProjections: {
            register(def) {
                definition = def;
                state = def.init({}, 0);
                return () => {};
            },
            stateOf(subject, key) {
                return subject === session && key === definition?.key ? state : undefined;
            },
        },
    };

    apply(ctx, {});

    return {
        /** 注册给 sessionProjections 的原始定义，用于断言注册表契约。 */
        get definition() {
            return definition;
        },
        /** 驱动一个会话事件，返回 fold 后的新状态。 */
        tick(event) {
            state = definition.apply(state, event);
            return state;
        },
        /** 以给定轮次与步号调用一次 pre-step，返回追加的消息数组。 */
        async preStep(step, turn, { reject = false, aborted = false } = {}) {
            const signal = { aborted };
            const decision = await preStep(
                { agent: { session }, turn, step, signal },
                async () => (reject ? { kind: 'reject' } : { kind: 'enter', messages: [] }),
            );
            return decision;
        },
        labels(decision) {
            return (decision.messages ?? []).map(message => message.source?.sections?.[0]?.name);
        },
    };
}

function assistantMessage(text, { turn, step, interrupted = false }) {
    return {
        type: 'assistant/message',
        data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] }, interrupted },
    };
}

function reminderOf(label) {
    return {
        type: 'user/message',
        data: { role: 'user', content: [{ type: 'text', text: label }], source: { kind: 'plugin', plugin: 'dsh-zh-reminder', form: 'snapshot', sections: [{ name: label, text: label }] } },
    };
}

test('会话第一步注入一次中文提醒，且不会重复注入', async () => {
    const harness = createHarness();
    harness.tick({ type: 'turn/start', data: { turn: 1 } });
    harness.tick({ type: 'step/start', data: { turn: 1, step: 1 } });

    const first = await harness.preStep(1, 1);
    assert.deepEqual(harness.labels(first), ['dsh-zh-reminder:start']);
    assert.equal(first.kind, 'enter');

    // 提醒落入日志后，状态以日志为准：同一轮内不再重复注入。
    harness.tick(reminderOf('dsh-zh-reminder:start'));
    const again = await harness.preStep(1, 1);
    assert.deepEqual(harness.labels(again), []);

    // 第二步同样不再注入。
    harness.tick({ type: 'step/start', data: { turn: 1, step: 2 } });
    const second = await harness.preStep(2, 1);
    assert.deepEqual(harness.labels(second), []);
});

test('普通用户消息不会顶掉会话开头提醒', async () => {
    const harness = createHarness();
    harness.tick({ type: 'turn/start', data: { turn: 1 } });
    harness.tick({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } });
    const decision = await harness.preStep(1, 1);
    assert.deepEqual(harness.labels(decision), ['dsh-zh-reminder:start']);
});

test('检测到大段英文后，在下一次 pre-step 注入一次重复提醒且不重复', async () => {
    const harness = createHarness();
    harness.tick({ type: 'turn/start', data: { turn: 1 } });
    harness.tick({ type: 'step/start', data: { turn: 1, step: 1 } });
    await harness.preStep(1, 1);
    harness.tick(reminderOf('dsh-zh-reminder:start'));

    // 第 2 轮：模型用英文回答（超标）。
    harness.tick({ type: 'turn/start', data: { turn: 2 } });
    harness.tick({ type: 'step/start', data: { turn: 2, step: 1 } });
    harness.tick(assistantMessage(ENGLISH, { turn: 2, step: 1 }));

    // 第 3 轮第一步被提醒。
    harness.tick({ type: 'turn/start', data: { turn: 3 } });
    harness.tick({ type: 'step/start', data: { turn: 3, step: 1 } });
    const repeat = await harness.preStep(1, 3);
    assert.deepEqual(harness.labels(repeat), ['dsh-zh-reminder:repeat']);

    // 提醒落日志后，下一次 pre-step 不再注入。
    harness.tick(reminderOf('dsh-zh-reminder:repeat'));
    const settled = await harness.preStep(1, 3);
    assert.deepEqual(harness.labels(settled), []);
});

test('同一轮内、超标之后的后续 step 也会被提醒', async () => {
    const harness = createHarness();
    harness.tick({ type: 'turn/start', data: { turn: 1 } });
    harness.tick({ type: 'step/start', data: { turn: 1, step: 1 } });
    await harness.preStep(1, 1);
    harness.tick(reminderOf('dsh-zh-reminder:start'));
    harness.tick(assistantMessage(ENGLISH, { turn: 1, step: 1 }));

    harness.tick({ type: 'step/start', data: { turn: 1, step: 2 } });
    const decision = await harness.preStep(2, 1);
    assert.deepEqual(harness.labels(decision), ['dsh-zh-reminder:repeat']);
});

test('中文回复不产生重复提醒', async () => {
    const harness = createHarness();
    harness.tick({ type: 'turn/start', data: { turn: 1 } });
    harness.tick({ type: 'step/start', data: { turn: 1, step: 1 } });
    await harness.preStep(1, 1);
    harness.tick(reminderOf('dsh-zh-reminder:start'));
    harness.tick(assistantMessage(CHINESE, { turn: 1, step: 1 }));

    harness.tick({ type: 'turn/start', data: { turn: 2 } });
    harness.tick({ type: 'step/start', data: { turn: 2, step: 1 } });
    const decision = await harness.preStep(1, 2);
    assert.deepEqual(harness.labels(decision), []);
});

test('被中断的回复不参与判定', async () => {
    const harness = createHarness();
    harness.tick({ type: 'turn/start', data: { turn: 1 } });
    harness.tick({ type: 'step/start', data: { turn: 1, step: 1 } });
    await harness.preStep(1, 1);
    harness.tick(reminderOf('dsh-zh-reminder:start'));
    harness.tick(assistantMessage(ENGLISH, { turn: 1, step: 1, interrupted: true }));

    harness.tick({ type: 'turn/start', data: { turn: 2 } });
    harness.tick({ type: 'step/start', data: { turn: 2, step: 1 } });
    const decision = await harness.preStep(1, 2);
    assert.deepEqual(harness.labels(decision), []);
});

test('reject 决策与已中止的信号都不注入提醒', async () => {
    const harness = createHarness();
    harness.tick({ type: 'turn/start', data: { turn: 1 } });
    harness.tick({ type: 'step/start', data: { turn: 1, step: 1 } });

    const rejected = await harness.preStep(1, 1, { reject: true });
    assert.equal(rejected.kind, 'reject');
    assert.equal(rejected.messages, undefined);

    const aborted = await harness.preStep(1, 1, { aborted: true });
    assert.deepEqual(harness.labels(aborted), []);
});

test('提醒消息结构可被框架识别', async () => {
    const harness = createHarness();
    harness.tick({ type: 'turn/start', data: { turn: 1 } });
    harness.tick({ type: 'step/start', data: { turn: 1, step: 1 } });
    const decision = await harness.preStep(1, 1);
    const [message] = decision.messages;
    assert.equal(message.role, 'user');
    assert.equal(typeof message.id, 'string');
    assert.ok(message.id.length > 0);
    assert.equal(message.content[0].type, 'text');
    assert.ok(message.content[0].text.includes('中文'));
    assert.equal(message.source.plugin, 'dsh-zh-reminder');
    assert.equal(message.source.form, 'snapshot');
});

test('投影单元的注册表契约完整（key / stateVersion / stateSchema）', () => {
    const { definition } = createHarness();
    assert.equal(definition.key, 'dsh-zh-reminder/state');
    assert.ok(Number.isSafeInteger(definition.stateVersion) && definition.stateVersion >= 0);
    assert.equal(typeof definition.init, 'function');
    assert.equal(typeof definition.apply, 'function');
    // 注册表在 restore 路径里会无条件调用 stateSchema.parse，缺了会让会话无法重开。
    assert.equal(typeof definition.stateSchema?.parse, 'function');
});

test('stateSchema 会把持久化状态收敛成合法值，坏值回落默认而不抛错', () => {
    const { parse } = createHarness().definition.stateSchema;
    const full = { turn: 3, step: 2, waitingStart: false, awaitingRepeat: true, repeatTurn: 2, repeatStep: 1 };
    const empty = { turn: 0, step: 0, waitingStart: true, awaitingRepeat: false, repeatTurn: 0, repeatStep: 0 };

    assert.deepEqual(parse(full), full);
    assert.deepEqual(parse(undefined), empty);
    assert.deepEqual(parse('nope'), empty);
    assert.deepEqual(parse({ turn: -1, step: 1.5, awaitingRepeat: 'yes' }), empty);
    // waitingStart 显式为 false 时必须保留，否则会话开头会重复提醒。
    assert.equal(parse({ waitingStart: false }).waitingStart, false);
});
