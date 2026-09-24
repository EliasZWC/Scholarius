/*
  i18n 中英对照一致性检查。

  起因：i18n.js 里中英是两份独立的字面量对象，加文案时极易
  「只加了一边」。缺的那边会直接显示 key 本身（如 `vault.field.doi`），
  在界面上非常难看，但**不会报任何错** —— 只有点到那一屏才发现。

  本脚本做三件事：
    ① 两个语言的 key 集合必须完全相同
    ② 值不能是空的（空串会让界面出现空白按钮）
    ③ 占位符 `{x}` 必须两边一致（`{n} pages` vs `{n} 页` 对得上）

  另外校验 meta.js 的字段表与 Kotlin 侧的顶层键一致 ——
  这两处对不上会导致「前端存了后端读不到」。
*/

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const ok = (msg) => console.log('  ok    ' + msg);

const i18n = read('app/src/main/assets/www/i18n.js');

/**
 * 从 i18n.js 里抠出两个语言对象。
 *
 * ⚠️ 不用 `eval` —— 那会执行整个文件（虽然它只是定义表）。
 *    这里用「块首/块尾」切分：`en: {` … `}` 与 `zh: {` … `}`。
 */
function extractLocale(name) {
    const startRe = new RegExp('\\b' + name + '\\s*:\\s*\\{');
    const m = startRe.exec(i18n);
    if (!m) return null;
    let i = m.index + m[0].length;
    let depth = 1;
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    let bodyStart = i;

    for (; i < i18n.length && depth > 0; i++) {
        const c = i18n[i];
        const next = i18n[i + 1];

        if (inLineComment) {
            if (c === '\n') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (c === '*' && next === '/') { inBlockComment = false; i++; }
            continue;
        }
        if (inSingle) {
            if (c === '\\') { i++; continue; }
            if (c === "'") inSingle = false;
            continue;
        }
        if (inDouble) {
            if (c === '\\') { i++; continue; }
            if (c === '"') inDouble = false;
            continue;
        }

        if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
        if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
        if (c === "'") { inSingle = true; continue; }
        if (c === '"') { inDouble = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
    }

    return i18n.slice(bodyStart, i - 1);
}

/** 从对象体里取出 `'key': 'value'` 对（值可能是单引号或双引号字符串） */
function pairs(body) {
    const out = new Map();
    const re = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gm;
    let m;
    while ((m = re.exec(body)) !== null) {
        const key = m[1] || m[2] || m[3];
        const value = m[4] !== undefined ? m[4] : m[5];
        out.set(key, value);
    }
    return out;
}

const en = pairs(extractLocale('en') || '');
const zh = pairs(extractLocale('zh') || '');

console.log('\n[1] 中英 key 集合一致');

if (!en.size || !zh.size) {
    fail('解析不到语言对象（en=' + en.size + ', zh=' + zh.size + '）');
} else {
    const onlyEn = [...en.keys()].filter((k) => !zh.has(k));
    const onlyZh = [...zh.keys()].filter((k) => !en.has(k));
    if (onlyEn.length) fail('只有英文，缺中文: ' + onlyEn.join(', '));
    if (onlyZh.length) fail('只有中文，缺英文: ' + onlyZh.join(', '));
    if (!onlyEn.length && !onlyZh.length) {
        ok(en.size + ' 条文案双语齐全');
    }
}

console.log('\n[2] 文案不为空');

const emptyEn = [...en.entries()].filter(([, v]) => v === '').map(([k]) => k);
const emptyZh = [...zh.entries()].filter(([, v]) => v === '').map(([k]) => k);
if (emptyEn.length) fail('英文空值: ' + emptyEn.join(', '));
if (emptyZh.length) fail('中文空值: ' + emptyZh.join(', '));
if (!emptyEn.length && !emptyZh.length) ok('无空值');

console.log('\n[3] 占位符一致');

const holes = (s) => (s.match(/\{[a-zA-Z_][\w]*\}/g) || []).sort().join(',');
let holeBad = 0;
for (const [k, v] of en) {
    if (!zh.has(k)) continue;
    if (holes(v) !== holes(zh.get(k))) {
        holeBad++;
        fail(k + ' 占位符不一致: en=[' + holes(v) + '] zh=[' + holes(zh.get(k)) + ']');
    }
}
if (!holeBad) ok('占位符全部对得上');

console.log('\n[4] meta.js 字段表与 Kotlin 顶层键一致');

const meta = read('app/src/main/assets/www/meta.js');
const store = read('app/src/main/java/com/eliaszwc/scholarius/LibraryStore.kt');

// 前端定义的字段 key
const commonKeys = [...meta.matchAll(/key:\s*'(\w+)'/g)].map((m) => m[1]);
const uniqueKeys = [...new Set(commonKeys)];

// Kotlin 侧写入索引的顶层键。两种写法都要抓到：
//   put("id", doc.id)                        ← 普通字段
//   put("fields", JSONObject().apply { ... }) ← 子对象
const topLevel = [
    ...store.matchAll(/put\("(\w+)",\s*doc\./g),
    ...store.matchAll(/put\("(\w+)",\s*JSONObject\(\)/g)
].map((m) => m[1]);
const storeTop = new Set(topLevel);

if (storeTop.size < 5) {
    fail('从 LibraryStore.kt 里只读到 ' + storeTop.size + ' 个索引键，提取规则可能失效');
}

/*
  ⚠️ 字段分两类，落到索引里的位置不同：

    ① **顶层键**：title / author / year / venueType / venue
       —— 它们在 Doc 上有独立属性，`put("xxx", doc.xxx)`

    ② **fields 子对象**：其余全部（journalName / doi / isbn …）
       —— Doc.fields 是一个 Map，整个作为 `fields` 键写进去，
          `put("fields", JSONObject{...})`

  所以校验的规则是：
    · 属于 ① 的 key，必须在 `put("...", doc....)` 里出现；
    · 属于 ② 的 key，只要 `fields` 这个顶层键存在即可
      （其内部键是动态的，Kotlin 不逐一认识 ——
        这正是用 Map 的代价，见 LibraryStore.Doc.fields 的注释）。
*/
const TOP_LEVEL_FIELD_KEYS = new Set(['title', 'author', 'year']);

if (!storeTop.has('fields')) {
    fail('索引里没有 fields 键 —— 类别专属字段会全部丢失');
} else {
    ok('索引里有 fields 子对象（类别专属字段的落点）');
}

const missingInStore = uniqueKeys.filter(
    (k) => TOP_LEVEL_FIELD_KEYS.has(k) && !storeTop.has(k)
);
if (missingInStore.length) {
    fail('前端定义了但索引里不存的顶层字段: ' + missingInStore.join(', '));
} else {
    const direct = uniqueKeys.filter((k) => TOP_LEVEL_FIELD_KEYS.has(k));
    const nested = uniqueKeys.filter((k) => !TOP_LEVEL_FIELD_KEYS.has(k));
    ok(direct.length + ' 个顶层字段 + ' + nested.length + ' 个嵌套字段，落点齐全');
}

// venueType 的特殊值集合必须两边一致
const metaTypes = [...meta.matchAll(/value:\s*'(\w+)',\s*icon:/g)].map((m) => m[1]).sort();
const ktTypes = (/private val VENUE_TYPES = setOf\(([\s\S]*?)\)/.exec(store) || [, ''])
    [1].match(/"(\w+)"/g)?.map((s) => s.replace(/"/g, '')).sort() || [];
if (!ktTypes.length) {
    fail('读不到 Kotlin 的 VENUE_TYPES');
} else if (metaTypes.join(',') !== ktTypes.join(',')) {
    fail('类别集合不一致\n        前端: ' + metaTypes.join(', ') + '\n        后端: ' + ktTypes.join(', '));
} else {
    ok('类别集合一致（' + metaTypes.length + ' 项）');
}

console.log('\n' + (failures ? failures + ' 项未通过\n' : '全部通过\n'));
process.exit(failures ? 1 : 0);
