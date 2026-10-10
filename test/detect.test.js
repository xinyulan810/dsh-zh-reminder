import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, detectEnglish, measure, normalizeConfig, splitParagraphs, stripCode } from '../lib/detect.js';

/** 纯英文自然段（有效性远超默认阈值）。 */
const PURE_ENGLISH = 'The quick brown fox jumps over the lazy dog near the river bank.';

test('纯英文段落触发提醒', () => {
    const hit = detectEnglish(PURE_ENGLISH);
    assert.equal(hit.triggered, true);
    assert.ok(hit.ratio > DEFAULTS.threshold, `ratio=${hit.ratio}`);
    assert.equal(hit.scanned, 1);
});

test('纯中文段落不触发', () => {
    const text = '这是一段完全用中文写的说明文字，内容比较长，足以超过最小段落长度限制，因此会被真正参与判定而不会被跳过。';
    assert.equal(detectEnglish(text).triggered, false);
});

test('中英混排：中文占多数时不触发', () => {
    const text = '这段说明主要用中文写成，只是在句尾提到了 DeepSeek 与 Node 两个名字，整体仍然以中文为主，因此不应该触发提醒。';
    assert.equal(detectEnglish(text).triggered, false);
});

test('代码块内的英文被排除', () => {
    const text = [
        '下面是示例代码，说明这个接口的用法，正文本身是中文。',
        '',
        '```js',
        'const value = await collectEverythingFromTheRemoteService(options);',
        '```',
        '',
        '代码结束后继续用中文补充说明，这一段同样是中文，不会被判定为英文段落。',
    ].join('\n');
    assert.equal(detectEnglish(text).triggered, false);
});

test('行内代码内的英文被排除', () => {
    const text = '调用 `runTheWholeBenchmarkSuite` 就可以开始跑整套基准测试，这里说的是中文说明，英文只出现在行内代码里。';
    assert.equal(detectEnglish(text).triggered, false);
});

test('第二段超标也会被抽检到（逐段判定，不做全文累计）', () => {
    const text = [
        '第一段是正常的中文说明，长度足够但全部是中文，不构成超标。',
        '',
        PURE_ENGLISH,
    ].join('\n\n');
    const hit = detectEnglish(text);
    assert.equal(hit.triggered, true);
    assert.equal(hit.scanned, 2);
});

test('maxChecks 限制抽检段落数', () => {
    const text = ['中'.repeat(60), '中'.repeat(60), PURE_ENGLISH].join('\n\n');
    assert.equal(detectEnglish(text, { maxChecks: 1 }).triggered, false);
    assert.equal(detectEnglish(text, { maxChecks: 3 }).triggered, true);
});

test('maxScanChars 限制扫描长度', () => {
    const head = `${PURE_ENGLISH}\n\n`;
    const filler = `${'中'.repeat(2200)}`;
    // 英文段在最前面：一定处于扫描窗口内。
    assert.equal(detectEnglish(`${head}${filler}`, { maxScanChars: 200 }).triggered, true);
    // 英文段被推到扫描窗口之外：窗口内只剩中文，因此不触发。
    assert.equal(detectEnglish(`${filler}${head}`, { maxScanChars: 200 }).triggered, false);
});

test('过短段落与字母过少的段落被跳过', () => {
    assert.equal(detectEnglish('OK').triggered, false);
    assert.equal(detectEnglish('ok go').triggered, false);
});

test('空输入与非字符串输入安全返回', () => {
    for (const value of ['', null, undefined, 42, {}]) {
        const hit = detectEnglish(value);
        assert.equal(hit.triggered, false);
        assert.equal(hit.scanned, 0);
    }
});

test('stripCode 与 splitParagraphs 的基本行为', () => {
    assert.equal(stripCode('前面 `code` 后面').includes('code'), false);
    assert.equal(splitParagraphs('甲\n\n乙\n丙').length, 2);
    assert.equal(measure('中文 ab').letters, 2);
});

test('normalizeConfig 回落到默认值并保留合法覆盖', () => {
    const fallback = normalizeConfig({ threshold: 7, minChars: -1, maxChecks: 'x' });
    assert.equal(fallback.threshold, DEFAULTS.threshold);
    assert.equal(fallback.minChars, DEFAULTS.minChars);
    assert.equal(fallback.maxChecks, DEFAULTS.maxChecks);
    const custom = normalizeConfig({ threshold: 0.5, minChars: 10, repeatReminder: '用中文' });
    assert.equal(custom.threshold, 0.5);
    assert.equal(custom.minChars, 10);
    assert.equal(custom.repeatReminder, '用中文');
    assert.equal(custom.startReminder, DEFAULTS.startReminder);
});
