/**
 * 用**真实的** session-projection 注册表复核本插件的投影单元契约。
 *
 * 为什么需要它：注册表在会话从持久化检查点恢复时会无条件调用
 * `stateSchema.parse(row.val)`（dsh-session-projection 的 restore 路径），缺少该字段
 * 会让会话无法重开。本脚本把插件注册进真实注册表、走一遍 restore，并留一个
 * 「去掉 stateSchema 必然抛错」的对照，因此能在 dsh 升级、契约变化时第一时间发现。
 *
 * 用法（需要一个 app.asar 解包出来的 dsh 依赖目录，本机 profile 里没有 @deepseek-ai）：
 *   node probe/registry-check.mjs D:/somewhere/app/dsh/node_modules
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { apply } from '../lib/index.js';

const modulesRoot = (process.argv[2] ?? '').replace(/[\\/]+$/, '');
if (modulesRoot === '') {
    console.error('用法：node probe/registry-check.mjs <dsh 解包目录下的 node_modules 绝对路径>');
    process.exit(2);
}

const load = relative => import(pathToFileURL(`${modulesRoot}/${relative}`).href);

let definition;
apply(
    {
        effect: () => () => {},
        on: () => () => {},
        sessionProjections: {
            register(def) {
                definition = def;
                return () => {};
            },
            stateOf: () => undefined,
        },
    },
    {},
);

const { Context } = await load('@deepseek-ai/cordis/lib/index.js');
const { default: Registry } = await load('@deepseek-ai/dsh-session-projection/lib/index.js');

const context = new Context();
const registry = new Registry(context);
registry.register(definition);
assert.deepEqual([...registry.registrations.keys()], ['dsh-zh-reminder/state'], '注册后应有且仅有本插件的单元');

const events = [
    { type: 'turn/start', data: { turn: 1 }, time: 0, seq: 0 },
    { type: 'step/start', data: { turn: 1, step: 1 }, time: 1, seq: 1 },
    {
        type: 'assistant/message',
        data: {
            turn: 1,
            step: 1,
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'The quick brown fox jumps over the lazy dog near the river bank.' }],
            },
        },
        time: 2,
        seq: 2,
    },
];
const checkpoint = {
    'dsh-zh-reminder/state': {
        ver: definition.stateVersion,
        seq: 1,
        val: { turn: 1, step: 1, waitingStart: false, awaitingRepeat: false, repeatTurn: 0, repeatStep: 0 },
    },
};

const restored = registry.restore(checkpoint, events, 0, {}, 0);
const row = restored.checkpoint['dsh-zh-reminder/state'];
assert.equal(restored.snapshot.asOfSeq, 2, 'restore 应折到最后一个事件');
assert.equal(row.val.waitingStart, false, '检查点里的等待标志应被 schema 保留');
assert.equal(row.val.awaitingRepeat, true, '英文段落应被检出并置为待提醒');

const { stateSchema, ...withoutSchema } = definition;
assert.equal(typeof stateSchema?.parse, 'function');
const control = new Registry(new Context());
control.register(withoutSchema);
assert.throws(() => control.restore(checkpoint, events, 0, {}, 0), TypeError, '去掉 stateSchema 必须复现崩溃');

console.log('注册表契约复核通过：register / restore 正常，stateSchema 必需性已复现');
