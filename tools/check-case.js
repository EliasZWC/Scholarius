/*
  英文文案大小写规范检查。

  ══ 规范（用户 2026-09-24 澄清）══

  **短语必须每个词首字母大写**（Title Case）；
  **完整句子不用** —— 句子按正常英文书写（只句首大写）。

  例（短语，Title Case）：
    'Import PDF' / 'No Documents Yet' / 'Delete?' / 'Not Set'
    'Reader Coming Soon' / 'Code Copied' / 'Open Browser'
    'Checking For Updates' 这个词组**若单独用**是短语，
    但 'Checking for updates...' 是句子 → 不检查

  例（句子，不检查）：
    'Waiting for authorization...'
    'Both fields are required.'
    'The code expired. Please try again.'
    'Could not import this file. Is it a valid PDF?'

  ══ 怎么区分 ══

  ⚠️ 判据：**看它有没有「主语 + 谓语」构成一个完整句子**。

     实用近似：**含主语代词或主语名词 + 动词，且不止一个词组** → 句子。

     更稳的近似（本脚本采用）：
       ① 以 `-ing` / `-ed` 开头的进行时/完成时片段 → 句子的开头
          （'Waiting for...' / 'Downloaded, installing...' /
            'Checking for updates...'）
       ② 含「主语代词 + be 动词」（you are / it is / this cannot…）
          → 句子
       ③ 含句号且有两个以上小句 → 句子

     其余按短语处理，要求 Title Case。

  ⚠️ 这条判据会有边界情况，所以脚本对**句子型不报错**，
     只对短语型报错。若某条短语被误判成句子而漏检，
     下次改到它时人工纠正即可 —— 比误报一堆句子要轻。
*/

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const i18n = fs.readFileSync(
    path.join(ROOT, 'app/src/main/assets/www/i18n.js'), 'utf8');

/** 抠出某个语言的对象体（与 check-meta.js 同一套解析逻辑） */
function extractLocale(name) {
    const m = new RegExp('\\b' + name + '\\s*:\\s*\\{').exec(i18n);
    if (!m) return '';
    let i = m.index + m[0].length;
    let depth = 1;
    let q = null;
    let bodyStart = i;
    for (; i < i18n.length && depth > 0; i++) {
        const c = i18n[i];
        if (q) {
            if (c === '\\') { i++; continue; }
            if (c === q) q = null;
            continue;
        }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === '/' && i18n[i + 1] === '/') {
            while (i < i18n.length && i18n[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && i18n[i + 1] === '*') {
            i += 2;
            while (i < i18n.length && !(i18n[i] === '*' && i18n[i + 1] === '/')) i++;
            i++;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
    }
    return i18n.slice(bodyStart, i - 1);
}

function pairs(body) {
    const out = new Map();
    const re = /^\s*(?:'([^']+)'|"([^"]+)")\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gm;
    let m;
    while ((m = re.exec(body)) !== null) {
        out.set(m[1] || m[2], m[3] !== undefined ? m[3] : m[4]);
    }
    return out;
}

const en = pairs(extractLocale('en'));

/*
  ⚠️ 允许小写的词。

  两类：
    ① 专有名词与缩写 —— 它们本来就不该改大小写
    ② 短语里的虚词位置 —— 本项目既有文案连 a / the / and 都大写了
       （见 'Tap + To Import a PDF' 里的 'a' 是小写的，
        但 'No Documents Yet' 里没有虚词可参考）

       实测既有文案里 'a' 是小写的（'Tap + To Import a PDF'），
       所以 a/an/the 放进白名单，其余虚词要求大写。
*/
const ALLOWED_LOWER = new Set([
    'doi', 'isbn', 'arxiv', 'nips', 'cvpr', 'icml', 'acl', 'neurips',
    'phd', 'pdf', 'github', 'onedrive', 'apk',
    'a', 'an', 'the',
    // ⚠️ 2026-09-25 补：`of` 是标准 Title Case 里该小写的短介词
    //    （与 a/an/the 同类）。之前漏了导致 'Shown Instead of Title'
    //    被报成违规。同时补上其它常见短介词，避免下次再撞。
    'of', 'in', 'on', 'at', 'by', 'to', 'for', 'from', 'with',
    // ⚠️ 但 'To' 在不定式里也常大写（见 'Tap + To Import a PDF'）——
    //    白名单只影响"全小写不报错"，写 'To' 同样不报错，两种都放过。
    'e.g.', 'i.e.', 's'
]);

/*
  ⚠️ 整体豁免的文案（按 key）。

  目前只有一条：字体分类是**专有术语**，
  "Sans-serif" 的标准写法就是小写 s（见 Google Fonts / W3C 文档）。
  改成 "Sans-Serif" 反而错了。
  它与 'Serif' / 'Monospace' 并列显示时大小写不一致，
  但那是术语本身的要求，不是我们的疏忽。
*/
const EXEMPT_KEYS = new Set([
    'reader.font.sans'
]);

/**
 * 判断一条文案是「句子」还是「短语」。
 *
 * ⚠️ 只用来**跳过句子**（句子不要求 Title Case）。
 *    判错的方向要偏向「当成句子」—— 漏检一条短语的代价
 *    （下次改到时人工纠正）远小于误报一堆句子。
 *
 * 判据（命中任一即视为句子）：
 *   ① 以 -ing / -ed 分词开头 → 进行时/完成时的句子开头
 *   ② 含「主语代词 + be/助动词」→ 完整主谓结构
 *   ③ 含两个以上小句（≥2 个句末标点）
 *   ④ 含**祈使句动词**（Add / Allow / Sign / Open / Pick）且词数 ≥ 4
 *      —— 祈使句是完整句子，不是短语
 *   ⑤ 含「动词 + 介词」构成的谓语片段（... are required / was denied）
 *   ⑥ 有一条内嵌从句（to + 动词 / that + 从句）
 */
const SENTENCE_HEAD_RE = /^(waiting|downloaded|checking|installing|loading|signing|opening)\b/i;
const SUBJECT_VERB_RE = /\b(you|it|this|that|these|those|they|we|i)\s+(are|is|was|were|has|have|had|will|would|can|could|should|may|might|must|do|does|did|not|cannot|can't)\b/i;
const SENTENCE_START_RE = /^(could|can|cannot|can't|please|the|your|we|you|it|this|that)\b/i;

/* 祈使句动词 —— 这些词开头且句子较长时，整句是句子而非短语 */
const IMPERATIVE_RE = /^(add|allow|sign|open|pick|enter|check|tap|try|select|choose|set|use|make|keep|let|stay|wait)\b/i;

/* 「主语 + be 动词 + 补语」的被动/系表结构 ⇒ 完整句子 */
const BE_PREDICATE_RE = /\b(are|is|was|were|has been|have been|will be)\s+\w+/i;

/* 内嵌从句：to + 动词 / that + 从句 */
const CLAUSE_EMBED_RE = /\b(to\s+\w+|that\s+\w+)\b/i;

/*
  ⑧ **名词主语 + 助动词/情态动词** —— 完整主谓结构。

  ⚠️ 2026-09-25 补：`"Cards will show the full venue name again."`
     是明显的句子，但上面 7 条一条都不命中 ——
     因为主语 `Cards` 是普通名词，不在 SUBJECT_VERB_RE 的代词白名单里。

     判据：紧跟冠词/名词之后的助动词或情态动词。
     `\w+s?\s+(will|would|can|could|should|may|must|is|are|was|were|
              has|have|had|does|do|did)\b`
     要求**词数 ≥ 5**，避免把 `Cancel Changes` 这种名词短语误判。
     仍偏向"当成句子"（见上面注释里说明的取舍）。
*/
const NOUN_VERB_RE = /\b[a-z]+s?\s+(will|would|can|could|should|may|might|must|is|are|was|were|has|have|had|does|do|did|shows?|showed)\b/i;

function isSentence(value) {
    const v = value.trim();
    const wordCount = (v.match(/[A-Za-z][A-Za-z'’]*/g) || []).length;

    // ① 分词开头
    if (SENTENCE_HEAD_RE.test(v)) return true;
    // ② 主语代词 + 助动词
    if (SUBJECT_VERB_RE.test(v)) return true;
    // ③ 两个以上小句
    if ((v.match(/[.!?](\s|$)/g) || []).length >= 2) return true;
    // ④ 祈使句开头且够长（'Add' 单独是短语，'Add one to shorten…' 是句子）
    if (wordCount >= 4 && IMPERATIVE_RE.test(v)) return true;
    // ⑤ 系表/被动结构
    if (wordCount >= 4 && BE_PREDICATE_RE.test(v)) return true;
    // ⑥ 内嵌从句
    if (wordCount >= 5 && CLAUSE_EMBED_RE.test(v)) return true;
    // ⑦ 句子典型开头且够长
    if (wordCount >= 4 && SENTENCE_START_RE.test(v)) return true;
    // ⑧ 名词主语 + 助动词/情态动词
    if (wordCount >= 5 && NOUN_VERB_RE.test(v)) return true;

    return false;
}

const problems = [];
let checked = 0;
let skipped = 0;

for (const [key, value] of en) {
    // 占位符示例不是 UI 文案（它是给用户看的填写样例）
    if (/^e\.g\./i.test(value.trim())) continue;

    // 整体豁免的术语（见 EXEMPT_KEYS）
    if (EXEMPT_KEYS.has(key)) continue;

    // 句子不要求 Title Case，跳过
    if (isSentence(value)) {
        skipped++;
        continue;
    }

    checked++;

    /*
      ⚠️ 先把占位符 `{n}` / `{title}` **整段剥掉**，再取词检查。

         否则占位符的变量名会被当成普通单词扫到
         （如 `{n} Pages` 里的 `n`），而变量名小写是天经地义的。
    */
    const stripped = value.replace(/\{[a-zA-Z_]\w*\}/g, ' ');

    const words = stripped.match(/[A-Za-z][A-Za-z'’]*/g) || [];
    words.forEach((w) => {
        const bare = w.replace(/['’]s$/, '').toLowerCase();
        if (ALLOWED_LOWER.has(w.toLowerCase()) || ALLOWED_LOWER.has(bare)) return;
        // 首字母小写 → 违反 Title Case
        if (/^[a-z]/.test(w)) {
            problems.push({ key, value, word: w });
        }
    });
}

console.log('\n英文文案大小写检查');
console.log('─'.repeat(72));
console.log('  短语 ' + checked + ' 条（要求 Title Case）· 句子 '
    + skipped + ' 条（不检查）\n');

if (!problems.length) {
    console.log('  ok    所有短语都是 Title Case');
} else {
    const byKey = new Map();
    problems.forEach((p) => {
        if (!byKey.has(p.key)) byKey.set(p.key, []);
        byKey.get(p.key).push(p.word);
    });
    for (const [key, words] of byKey) {
        console.log('  FAIL  ' + key);
        console.log('        "' + en.get(key) + '"');
        console.log('        → 应为大写: ' + [...new Set(words)].join(', '));
    }
}

console.log('\n' + (problems.length
    ? problems.length + ' 处违反 Title Case\n'
    : '全部通过\n'));

process.exit(problems.length ? 1 : 0);
