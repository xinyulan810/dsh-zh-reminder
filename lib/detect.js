/**
 * 检测内核与配置规范化：纯函数、零依赖，可单独测试。
 *
 * 判定规则依据用户需求：
 * - 不做全文累计统计，而是把回复里的连续文字切成自然段，逐段看英文占比；
 * - 不遍历全文，而是有界抽检：最多看 maxScanChars 个字符、maxChecks 个段落；
 * - 任意一段（代码块之外）英文占比超标就立刻返回，用于及时提醒。
 */

export const DEFAULTS = {
    startReminder: '请始终使用简体中文思考和回答用户的问题，不要使用英文（代码、命令、专有名词除外）。',
    repeatReminder: '你刚才的回复里有一整段是英文。请改用简体中文重新表述这部分内容——必须用中文思考，也要用中文回答用户。',
    threshold: 0.8,
    minChars: 20,
    minLetters: 8,
    maxChecks: 8,
    maxScanChars: 2000,
};

const FENCED_BLOCK = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;

/*
 * 下面这些「非叙述性片段」同样不该算作「在用英文说话」。中文技术回答里它们往往占去
 * 大部分 ASCII 字母——文件路径、配置键值、包名与标识符列表——只看字母占比会把这些
 * 段落整体误判成英文。它们在 stripCode 里被逐条替换成空格，既不进分子也不进分母。
 */
const URL = /[a-z][a-z0-9+.-]*:\/\/[^\s，。；、）)】]+/gi;
const FILE_PATH = /[\w.@$~-]+(?:[\\/][\w.@$~-]+)+/g;
const FILE_NAME = /\b[\w-]+\.(?:cfg|toml|conf|json|ya?ml|ini|properties|lock|js|mjs|cjs|ts|tsx|md|txt|log|jar|zip|gz|exe|dll|so|py|ps1|sh|bat|cmd|xml|html|css|png|jpe?g|dat|nbt|mo|class)\b/gi;
/** key = value / key = "value"，配置项整体不算英文叙述。 */
const ASSIGNMENT = /\b[A-Za-z_][\w.-]*\s*(?:===?|!==?|=>|=)\s*(?:["'][^"']*["']|[^\s，。；、）)】]*)/g;
/** 「→ false」这类箭头后的取值。 */
const ARROW_VALUE = /(?:->|=>|→)\s*[^\s，。；、）)】]*/g;
const SECTION_NAME = /\[[\w.\- ]+\]/g;
const SLASH_LIST = /\b[A-Za-z][\w.-]*(?:\s*\/\s*[A-Za-z][\w.-]*)+\b/g;
const SNAKE_IDENT = /\b[A-Za-z]\w*_\w+\b/g;
const CAMEL_IDENT = /\b(?:[a-z]+\d*[A-Z]\w*|[A-Z][a-z]+\d*[A-Z]\w*)\b/g;
/**
 * 引号里的内容通常是「引用原文」或术语强调，不是自己在用英文说话。中文回答里引用一段
 * 英文原文（配置注释、报错信息、文档原文）是常见写法，必须排除——否则一整句英文引用
 * 就足以把该段的英文占比拉过阈值。
 */
const QUOTED_CJK = /[“”‘’][^“”‘’]*[“”‘’]/g;
const QUOTED_ASCII = /"[^"\n]*"/g;

/** 连续两行以上的空白视为段落分隔。 */
const PARAGRAPH_BREAK = /[ \t]*\r?\n(?:[ \t]*\r?\n)+[ \t]*/;
/** 段落内部的换行折叠成空格，便于按字符统计。 */
const SOFT_WRAP = /[ \t]*\r?\n[ \t]*/g;
const ASCII_LETTER = /[A-Za-z]/g;
const COUNTED_CHAR = /[0-9A-Za-z\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;

/**
 * 规范插件配置：缺省或非法值回落到默认值。
 * @param {unknown} config 插件行内配置
 * @returns {typeof DEFAULTS} 完整配置
 */
export function normalizeConfig(config) {
    const raw = config !== null && typeof config === 'object' ? config : {};
    const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
    const ratio = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback);
    const text = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback);
    return {
        startReminder: text(raw.startReminder, DEFAULTS.startReminder),
        repeatReminder: text(raw.repeatReminder, DEFAULTS.repeatReminder),
        threshold: ratio(raw.threshold, DEFAULTS.threshold),
        minChars: positive(raw.minChars, DEFAULTS.minChars),
        minLetters: positive(raw.minLetters, DEFAULTS.minLetters),
        maxChecks: positive(raw.maxChecks, DEFAULTS.maxChecks),
        maxScanChars: positive(raw.maxScanChars, DEFAULTS.maxScanChars),
    };
}

/**
 * 去掉 fenced code block 与行内代码，只留下正文。
 * @param {string} text 原始文本
 * @returns {string} 去掉代码后的正文
 */
export function stripCode(text) {
    return text
        .replace(FENCED_BLOCK, '\n')
        .replace(INLINE_CODE, ' ')
        .replace(URL, ' ')
        .replace(FILE_PATH, ' ')
        .replace(FILE_NAME, ' ')
        .replace(ASSIGNMENT, ' ')
        .replace(ARROW_VALUE, ' ')
        .replace(SECTION_NAME, ' ')
        .replace(SLASH_LIST, ' ')
        .replace(SNAKE_IDENT, ' ')
        .replace(CAMEL_IDENT, ' ')
        .replace(QUOTED_CJK, ' ')
        .replace(QUOTED_ASCII, ' ');
}

/**
 * 把正文切成自然段并做基本清理。
 * @param {string} text 去掉代码后的正文
 * @returns {string[]} 非空段落数组
 */
export function splitParagraphs(text) {
    return text
        .split(PARAGRAPH_BREAK)
        .map(part => part.replace(SOFT_WRAP, ' ').trim())
        .filter(part => part.length > 0);
}

/**
 * 统计一段文字的有效字符构成：分母排除空白与标点，只数中英文字母、数字与 CJK 字符。
 * @param {string} text 单段文字
 * @returns {{ letters: number, counted: number, ratio: number }} 英文占比
 */
export function measure(text) {
    const letters = text.match(ASCII_LETTER)?.length ?? 0;
    const counted = text.match(COUNTED_CHAR)?.length ?? 0;
    return { letters, counted, ratio: counted === 0 ? 0 : letters / counted };
}

/**
 * 有界抽检英文占比：只在回复开头 maxScanChars 个字符内、最多 maxChecks 个段落中
 * 抽样判断，命中第一段超标就立即返回，不遍历全文。
 * @param {string} text 助手回复的正文（可含 markdown 代码块）
 * @param {Partial<typeof DEFAULTS>} [config] 判定阈值
 * @returns {{ triggered: boolean, ratio: number, scanned: number }} 判定结果
 */
export function detectEnglish(text, config = {}) {
    const options = { ...DEFAULTS, ...config };
    const miss = { triggered: false, ratio: 0, scanned: 0 };
    if (typeof text !== 'string' || text.length === 0) return miss;
    const paragraphs = splitParagraphs(stripCode(text.slice(0, options.maxScanChars)));
    const limit = Math.min(paragraphs.length, Math.max(1, options.maxChecks));
    for (let index = 0; index < limit; index++) {
        const paragraph = paragraphs[index];
        if (paragraph.length < options.minChars) continue;
        const stats = measure(paragraph);
        if (stats.letters < options.minLetters || stats.counted === 0) continue;
        if (stats.ratio > options.threshold) return { triggered: true, ratio: stats.ratio, scanned: index + 1 };
    }
    return { ...miss, scanned: limit };
}
