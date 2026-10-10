/**
 * 会话格式 v4 的 source 形状复核。
 *
 * 起因：本插件曾经用 `{ kind: 'plugin', plugin: '<包名>' }` 这种退役写法注入提醒消息，
 * 一重启就让会话炸在 `format v4 message requires a producer-owned source kind`。
 *
 * 注意这里刻意走**两条**官方校验路径：
 *   1) assertV4RowAdmission —— 物理行准入，只在 kind === 'plugin' 时才查 source，
 *      所以它拒得了退役写法，却证明不了新写法合格（单独用它属于弱验证）。
 *   2) assertReleasedV4Relationships —— 原生 V4 artifact 级校验，会对**每条**消息
 *      调用 source()，也就是真正采纳消息时的那条路。
 *
 * 用法：
 *   node probe/format-check.mjs <dsh 解包目录>/app/dsh/node_modules
 * 例如：
 *   node probe/format-check.mjs D:/Android/tun_debug/asar_work/dsh_full/app/dsh/node_modules
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const nodeModules = process.argv[2];
if (nodeModules === undefined) {
    console.error('用法：node probe/format-check.mjs <dsh 解包目录>/app/dsh/node_modules');
    process.exit(2);
}

const entry = path.join(nodeModules, '@deepseek-ai', 'dsh-session-format-v3-to-v4', 'lib', 'index.js');
const { assertV4RowAdmission, assertReleasedV4Relationships } = await import(pathToFileURL(entry).href);
assert.equal(typeof assertV4RowAdmission, 'function', '迁移包没有导出 assertV4RowAdmission，复核脚本需要更新');
assert.equal(typeof assertReleasedV4Relationships, 'function', '迁移包没有导出 assertReleasedV4Relationships，复核脚本需要更新');

const PROBE_TEXT = '请用中文回答。';
const PRODUCER = /producer-owned source kind/;

/** 退役写法：kind 固定为 'plugin'，真正的生产者放在 plugin 字段里。 */
const legacySource = () => ({ kind: 'plugin', plugin: 'dsh-zh-reminder', form: 'snapshot', sections: [{ name: 'x', text: PROBE_TEXT }] });
/** 当前写法：生产者直接写进 kind。 */
const currentSource = () => ({ kind: 'plugin:dsh-zh-reminder', form: 'snapshot', sections: [{ name: 'dsh-zh-reminder:start', text: PROBE_TEXT }] });
/** 边界：空 kind。 */
const emptySource = () => ({ kind: '', form: 'snapshot' });

function messageWith(source) {
    return { id: 'a'.repeat(16), role: 'user', content: [{ type: 'text', text: PROBE_TEXT }], source };
}

/** 物理行准入。 */
function rowFailure(source) {
    try {
        assertV4RowAdmission({ type: 'user/message', data: messageWith(source) });
        return undefined;
    } catch (error) {
        return error;
    }
}

/** 原生 V4 artifact 级校验：真正会逐条消息调用 source() 的入口。 */
function artifactFailure(source) {
    const artifact = {
        header: { id: 'probe-session', createdAt: 0, delegationDepth: 0, isSeeded: false },
        events: [{ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: messageWith(source) }],
        inheritedEventCount: 0,
    };
    try {
        assertReleasedV4Relationships(artifact, new Set(['user/message']));
        return undefined;
    } catch (error) {
        return error;
    }
}

// 1. 退役写法必须在物理行准入就被拒。
const legacyRow = rowFailure(legacySource());
assert.ok(legacyRow !== undefined, '退役写法在行级必须被拒绝');
assert.match(String(legacyRow.message), PRODUCER, `退役写法的行级报错不对：${legacyRow.message}`);

// 2. 退役写法在原生采纳路径上也会被拒。
const legacyArtifact = artifactFailure(legacySource());
assert.ok(legacyArtifact !== undefined, '退役写法在 artifact 级必须被拒绝');
assert.match(String(legacyArtifact.message), PRODUCER, `退役写法的 artifact 级报错不对：${legacyArtifact.message}`);

// 3. 空 kind 同样被拒。
assert.match(String(artifactFailure(emptySource())?.message), PRODUCER, '空 kind 必须被拒绝');

// 4. 当前写法必须通过源归属准入。
const current = artifactFailure(currentSource());
assert.ok(current === undefined || !PRODUCER.test(String(current.message)), `当前写法被源归属准入拒绝：${current?.message}`);

console.log('source 形状复核通过：退役写法与空 kind 都被拒（producer-owned source kind），当前写法通过源归属准入。');
if (current !== undefined) {
    console.log(`（当前写法仍触发了其它断言，需要复核：${current.message}）`);
}
