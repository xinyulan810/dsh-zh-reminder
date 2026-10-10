/**
 * 安装前探针：不依赖任何第三方包，只做零依赖与清单自检。
 *
 * 用法：node probe/check.mjs ./cordis.patch.yml ./package.json
 * 传入的相对路径以项目根目录为基准解析。
 * 在 dsh 的 shell 里执行时，如果这些外部模块真的可解析，会打印 OK；打印
 * MISSING 说明第三方插件目录里的模块解析不可用——本插件因此刻意不 import 它们。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = new URL('../', import.meta.url); // 注意结尾斜杠：否则 URL 会按“文件”语义解析掉最后一节路径
const report = [];

/* 1. 清单元数据 */
const manifest = JSON.parse(readFileSync(new URL('package.json', here), 'utf8'));
report.push(`manifest: ${manifest.name}@${manifest.version} type=${manifest.type}`);
report.push(`manifest.exports: ${JSON.stringify(manifest.exports)}`);
report.push(`manifest.dsh: ${JSON.stringify(manifest.dsh)}`);

/* 2. 入口与 patch 清单可读 */
try {
    const entry = new URL(manifest.exports['.'], here);
    await import(entry.href);
    report.push(`entry OK: ${fileURLToPath(entry)}`);
}
catch (error) {
    report.push(`entry FAIL: ${error.message}`);
}

for (const patch of process.argv.slice(2)) {
    const url = patch.startsWith('file:') ? patch : new URL(patch, here);
    try {
        const body = readFileSync(url, 'utf8');
        report.push(`patch OK: ${fileURLToPath(url)} (${body.length} chars)`);
    }
    catch (error) {
        report.push(`patch FAIL: ${patch}: ${error.message}`);
    }
}

/* 3. 零依赖验证：这些 import 在本机第三方插件上下文里解析不了，必须不被使用 */
for (const specifier of ['@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery', '@deepseek-ai/cordis']) {
    try {
        await import(specifier);
        report.push(`resolve ${specifier}: OK（本机恰好可解析，但本插件不依赖它）`);
    }
    catch {
        report.push(`resolve ${specifier}: MISSING（符合预期，本插件不 import 任何 @deepseek-ai 包）`);
    }
}

console.log(report.join('\n'));
