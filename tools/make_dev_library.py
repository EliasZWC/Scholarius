"""为浏览器预览生成**真实**的文库数据（非手写假数据）。

为什么需要：
    共享页面（VS Code 里的 file:// 预览）没有 Android 原生侧，
    MainActivity.pushLibraryToWeb() 不会执行，文库永远是空的 ——
    出了问题在预览里看不出来。

做法：
    用一个 Python 复刻 LibraryStore 的元数据提取（PdfMeta 的逻辑），
    并把真实 PDF 的正文 + 字体元数据一并导出，
    生成 app/src/main/assets/www/dev-library.js。
    浏览器预览时手工引入它，就能看到与手机一致的数据。

⚠️ 生成物**不进版本库**（见 tools/.gitignore）：
   它含有论文全文，受版权保护。

用法：
    python tools/make_dev_library.py                # 用内置的默认论文
    python tools/make_dev_library.py a.pdf b.pdf    # 指定 PDF
"""
import json
import sys
from pathlib import Path

import datetime
import pymupdf

READING = Path.home() / 'OneDrive' / '论文' / 'reading'

DEFAULT = [
    r'02_deep\2015_深度学习里程碑综述_Nature_LeCun.pdf',
    r'02_deep\2017_Transformer提出纯注意力模型_NIPS_Vaswani.pdf',
    r'00_inbox\2016_残差连接提出_CVPR_He.pdf',
    r'00_inbox\2022_LLM思维链提出_NIPS_Wei.pdf',
]

OUT = Path('app/src/main/assets/www/dev-library.js')

# 预览用的人工标注（真机上这些由用户在设置里自己设）
VENUE_TYPE = {
    '2015_深度学习里程碑综述_Nature_LeCun.pdf': 'journal',
    '2017_Transformer提出纯注意力模型_NIPS_Vaswani.pdf': 'conference',
    '2016_残差连接提出_CVPR_He.pdf': 'conference',
    '2022_LLM思维链提出_NIPS_Wei.pdf': 'conference',
}

# ⚠️⚠️ 已删除 `VENUE_SHORT`（原来把 NIPS / CVPR 写进 doc.shortTitle）。
#
#    它原来是这么用的：
#        'venueShort': VENUE_SHORT.get(d['venue'], '')
#    而 VENUE_SHORT 里是：
#        'Neural Information Processing Systems': 'NIPS'
#
#    这**混淆了两个不同的概念**（用户 2026-09-24 专门指出）：
#      · 发表物简称（NIPS / CVPR）= 会议/期刊**名字**的缩写，
#        是一张全局映射表，服务所有发表在同一载体的文献，
#        存在 localStorage（见 www/shortcut.js），在设置页里配；
#      · 短标题（Short Title）= **这一篇文献**标题的短形式，
#        一篇一个值，存在 doc.shortTitle，填了顶替卡片①行的标题。
#
#    NIPS 是对 **venue 的缩写**，不是对 **这篇文献标题的缩写** ——
#    把它写进 shortTitle 是类别错误。而且它还是**全局映射**里
#    才该有的东西，放到单篇文献上就变成"每篇都要手工重复"。
#
#    所以这里不再生成任何 shortTitle 预览值：让它为**空串**，
#    预览时正好验证"未填短标题 → 卡片显示原标题"这条路径。
#    要测"填了短标题"的形态，在详情页里手填即可。

# 预览用的短标题。**与载体无关**，是给这一篇文献起的短名。
# 同理只给两条，让"有 / 无短标题"两种卡片形态都能看到。
SHORT_TITLE = {
    '2017_Transformer提出纯注意力模型_NIPS_Vaswani.pdf': 'Transformer',
    '2016_残差连接提出_CVPR_He.pdf': 'ResNet',
}


# --- 与 PdfText.kt 的 mergeParagraphs 保持一致 -------------------------------

SENT_END = set('.?!:;。？！：；」』）)"')
SHORT_LINE = 60
import re

NUMBER_ONLY = re.compile(r'^§?\s*(\d+(\.\d+)*|[IVXLC]+)[.、]?$')
UPPER_HEAD = re.compile(r"^[A-Z][A-Z0-9 \-,:&'()/]{2,}$")


def looks_like_head(s: str) -> bool:
    """一行是否「自成一段」（标题 / 作者 / 单位 / 编号）。与 Kotlin 一致。

    ⚠️ 以连字符结尾的行是**断词续行**，永远不是标题 ——
       否则 `…scientific re-` 会被当成独立块，把一句话硬断成两段。
       实测：HAL 版 LeCun《Deep learning》封面页被断成
         `for the deposit and dissemination of scientific re-`
         `search documents, whether they are published or not.`
    """
    if not s:
        return False
    if NUMBER_ONLY.match(s) or UPPER_HEAD.match(s):
        return True
    if s[-1] in ('-', '\u2013', '\u2014'):
        return False
    return len(s) <= SHORT_LINE and s[-1] not in SENT_END


def starts_new_block(t: str) -> bool:
    """这一行是否应**独立成块**（标题 / 页码 / 页眉）。

    ⚠️ 与 Kotlin 的 startsNewBlock 一致。

    ⚠️ 存在的理由：原来只在「已积累的内容是标题」时 flush，
       于是**新标题会被并进上一段正文**。实测证据：
         「…averaged over all the training examples, can Deep le…」
       正文与下一节标题黏在一起。
       所以必须**双向检查**：到达的行像标题时也要先 flush。
    """
    if not t:
        return True
    if looks_like_page_artifact(t):
        return True
    return looks_like_head(t)


def is_math_fragment(t: str) -> bool:
    """单个数学符号 / 项目符号（公式被拆行时的碎片）。"""
    return len(t) == 1 and (t in MATH_SYMBOLS or t in BULLET_CHARS)


def is_math_run(t: str) -> bool:
    """公式变量的孤字（`x` `y` `z` `W` `yl` `zk` `wjk` …）。

    与 Kotlin 的 isMathRun 一致。只作**黏合**用。
    """
    if not t or len(t) > MATH_RUN_MAX:
        return False
    # ⚠️ 页码 / 页眉优先（否则 `13.5` 会黏住 `14`）
    if PAGE_NUMBER.match(t) or PAGE_HEADER.match(t):
        return False
    if ' ' in t or '\t' in t:
        return False
    if any(c in PROSE_END for c in t) or ',' in t or '\u3001' in t:
        return False
    if not any(c.isalnum() for c in t):
        return False
    return all(c.isalnum() or c in MATH_SYMBOLS for c in t)


def needs_space_between(a: str, b: str) -> bool:
    """合并两段文字时是否需要补空格。与 Kotlin 的 needsSpaceBetween 一致。

    ⚠️ 只在「前末字符是拉丁字母/数字」且「后首字符是字母/数字」时补。
    """
    if not a or not b:
        return False
    last, first = a[-1], b[0]
    if last == '-':
        return False
    last_word = last.isalnum() and ord(last) < 0x2E80
    first_word = first.isalnum() and ord(first) < 0x2E80
    return last_word and first_word


def merge_paragraphs(raw_lines):
    """raw_lines: [(text, font, size, page)] -> (text, [(font, size, page)])"""
    out = []
    para = ''
    meta = None

    def flush():
        nonlocal para, meta
        if para:
            out.append((para, meta))
        para, meta = '', None

    for text, font, size, page in raw_lines:
        t = text.strip()
        if not t:
            flush()
            continue
        # ⚠️ 顺序要紧：**先**排掉页码/页眉（独立成块），**再**判公式碎片（黏合）。
        #    反例（实测回归）：先判公式碎片 → 页码 `13.5` 被当成变量
        #    黏到页眉 `14` 上，产出 `13.5 14` 伪标题。
        if looks_like_page_artifact(t):
            flush()
            para, meta = t, (font, size, page)
            continue
        # 单个数学符号 / 变量孤字 → 黏合，不判句末
        # ⚠️ 空格规则与 Kotlin 一致：只在两侧都是字母/数字时补空格。
        #    `x` + `=` → `x=`；`yl` + `yj` → `yl yj`
        if is_math_fragment(t) or is_math_run(t):
            if needs_space_between(para, t):
                para += ' '
            para += t
            if meta is None:
                meta = (font, size, page)
            continue
        # 到达的行像标题/页码 → 先收掉上一段（修复"标题黏进正文"）
        if starts_new_block(t):
            flush()
            para, meta = t, (font, size, page)
            continue
        if looks_like_head(para):
            flush()
            para, meta = t, (font, size, page)
            continue
        if para and para[-1] in SENT_END:
            flush()
            para, meta = t, (font, size, page)
        else:
            # 上一行以连字符结尾 + 新行以字母开头 → 断词续行，去连字符直接接
            if para and para[-1] in ('-', '\u2010', '\u2011') and t[0].isalpha() \
                    and ord(t[0]) < 0x2E80:
                para = para[:-1] + t
            elif para:
                if needs_space_between(para, t):
                    para += ' '
                para += t
            else:
                para, meta = t, (font, size, page)
    flush()
    return out


# --- 与 PdfText.kt 的 classifyBlock / estimateBodySize / looksLikeFormula 一致 ---
#
# ⚠️ 同样是**复刻**，不是重写。预览里看到的排版必须与真机一致，
#    否则「预览好看、真机难看」这类问题会白跑一轮。
#    改 Kotlin 侧时这里必须同步（反之亦然）。

BODY_SIZE_MIN_LINE = SHORT_LINE   # 只统计长行来估计正文字号

# ⚠️ 与 Kotlin 的 FORMULA_MAX_CHARS / FORMULA_MIN_SYMBOL_RATIO 一致
FORMULA_MAX_CHARS = 300
FORMULA_MIN_SYMBOL_RATIO = 0.08
TITLE_MAX_CHARS = 80

# ⚠️ 只保留**真正的数学运算符** —— 不含 ()[]/<>，那些是普通标点。
#    与 Kotlin 的 looksLikeFormula 里的字符集一致。
MATH_SYMBOLS = set('=+−×÷±∑∏∫√∞≤≥≠≈∈∉⊂⊆∪∩→←↔∂∇^_*<>|()[]{}−-')

# 项目符号（Symbol 字体的 • 落在私用区 U+F0B6）—— 与 Kotlin 的 BULLET_CHARS 一致
BULLET_CHARS = set('\uF0B6\uF0B7\u2022\u25CF\u25AA\u00B7')

# 公式变量孤字的长度上限（与 Kotlin 的 MATH_RUN_MAX 一致）
MATH_RUN_MAX = 6

# 明显不是公式的标记
NOT_FORMULA_MARKS = ('://', 'pp.', 'vol.', 'no.', 'issn')
NUMBER_ONLY_LINE = re.compile(r'^[\s\d|()\[\].\-–—]+$')

WORD_RE = re.compile(r'[A-Za-z]{4,}')
HEADING_NUM_RE = re.compile(r'^§?\s*(\d+(?:\.\d+)*)')
HEADING_NUM_PREFIX = re.compile(r'^§?\s*\d+(?:\.\d+)*\s+\S')


def estimate_body_size(raw_lines):
    """正文字号 = 长行的字号众数（0.5pt 分桶）。与 Kotlin 一致。"""
    buckets = {}
    for text, _font, size, _page in raw_lines:
        if not size or len(text.strip()) <= BODY_SIZE_MIN_LINE:
            continue
        key = round(size * 2)
        buckets[key] = buckets.get(key, 0) + 1
    if not buckets:
        return 0.0
    best = max(buckets.items(), key=lambda kv: kv[1])[0]
    return best / 2


def is_bold_font(name: str) -> bool:
    if not name:
        return False
    n = name.lower()
    return ('bold' in n) or ('black' in n) or ('heavy' in n) or n.startswith('cmbx')


def looks_like_formula(text: str) -> bool:
    t = text.strip()
    if len(t) < 2 or len(t) > FORMULA_MAX_CHARS:
        return False
    if len(WORD_RE.findall(t)) > 2:
        return False
    low = t.lower()
    if '://' in low or low.startswith('www.'):
        return False
    if any(m in low for m in NOT_FORMULA_MARKS):
        return False
    if NUMBER_ONLY_LINE.match(t):
        return False
    symbols = sum(1 for c in t if c in MATH_SYMBOLS or c in '-*')
    return (symbols / len(t)) >= FORMULA_MIN_SYMBOL_RATIO


def heading_level(text: str) -> int:
    m = HEADING_NUM_RE.match(text.strip())
    if m:
        return min(m.group(1).count('.') + 1, 3)
    return 1


def classify_block(text: str, font: str, size: float, body_size: float) -> dict:
    """返回 {kind, level}。与 Kotlin 的 classifyBlock 判据一致。"""
    t = text.strip()

    if looks_like_formula(t):
        return {'kind': 'formula', 'level': 0}

    # 页码 / 页眉 / 纯编号 → 绝不当标题（实测误判重灾区）
    if looks_like_page_artifact(t):
        return {'kind': 'paragraph', 'level': 0}

    has_numbered_title = bool(HEADING_NUM_PREFIX.match(t))
    all_caps = bool(UPPER_HEAD.match(t)) and len(t) >= 3
    boldish = is_bold_font(font)
    bigger = bool(body_size > 0 and size and size > body_size + 0.3)

    if len(t) > TITLE_MAX_CHARS:
        return {'kind': 'paragraph', 'level': 0}

    # 只靠字体/字号时必须是短行，且不像散文（与 Kotlin 一致）
    font_only = (boldish or bigger) and len(t) <= SHORT_LINE \
        and not looks_like_prose(t)

    if has_numbered_title or all_caps or font_only:
        return {'kind': 'heading', 'level': heading_level(t)}

    return {'kind': 'paragraph', 'level': 0}


PAGE_NUMBER = re.compile(r'^\d+(?:\.\d+)?$|^[IVXLC]{1,6}\.?$')
PAGE_HEADER = re.compile(r'^\d+\s*(?:\||/|of)\s*\d+$')

PROSE_END = set('.?!;。？！；')


def looks_like_prose(t: str) -> bool:
    """是否像散文句子（而非标题）。与 Kotlin 的 looksLikeProse 一致。"""
    if not t:
        return False
    if t[-1] in PROSE_END:
        return True
    if ',' in t and len(t) > 30:
        return True
    if t[0].islower() and ' ' in t:
        return True
    return False


def looks_like_page_artifact(t: str) -> bool:
    """页码 / 页眉 / 纯编号 —— 与 Kotlin 的 looksLikePageArtifact 一致。"""
    if not t:
        return True
    if PAGE_NUMBER.match(t):
        return True
    if PAGE_HEADER.match(t):
        return True
    # ⚠️ 单个数学符号 / 项目符号不算页面残留：PDF 里公式常被拆成「一行一个符号」，
    #    当残留丢掉则公式残缺，当新块则正文散落单字符段落。
    #    返回 False 让它走 is_math_fragment / is_math_run 分支黏到相邻块。
    if len(t) <= 1:
        return t not in MATH_SYMBOLS and t not in BULLET_CHARS
    return False


def extract(path: Path):
    doc = pymupdf.open(str(path))

    # 正文行 + 主字体/主字号/页
    raw = []
    for pno, page in enumerate(doc, 1):
        d = page.get_text('dict')
        for b in d.get('blocks', []):
            if b.get('type') != 0:
                continue
            for ln in b.get('lines', []):
                spans = ln.get('spans', [])
                if not spans:
                    continue
                text = ''.join(sp.get('text', '') for sp in spans)
                if not text.strip():
                    continue
                fw, sw = {}, {}
                for sp in spans:
                    n = len(sp.get('text', ''))
                    fw[sp['font']] = fw.get(sp['font'], 0) + n
                    k = round(sp['size'] * 10)
                    sw[k] = sw.get(k, 0) + n
                raw.append((text.strip(),
                            max(fw, key=fw.get),
                            max(sw, key=sw.get) / 10,
                            pno))

    merged = merge_paragraphs(raw)

    fonts, font_index, rows = [], {}, []
    for text, m in merged:
        font, size, page = m
        if font not in font_index:
            font_index[font] = len(fonts)
            fonts.append(font)
        rows.append([font_index[font], round(size * 10), page])

    # 结构化块（v0.1.6）：阅读页按它分块渲染，这是「能读」的关键。
    # ⚠️ 正文字号要在**原始行**上估（不是在合并后的段上）——
    #    合并后段落变长，长短行的比例失真，众数会偏。
    body_size = estimate_body_size(raw)
    blocks = []
    for text, m in merged:
        font, size, page = m
        cls = classify_block(text, font, size, body_size)
        blocks.append({
            'kind': cls['kind'],
            'text': text,
            'level': cls['level'],
            'page': page,
        })

    meta = doc.metadata or {}
    title = (meta.get('title') or '').strip()
    author = (meta.get('author') or '').strip()
    venue = clean_venue(meta.get('subject') or '')

    # 与 LibraryStore.import 一致：缺字段时从首页兜底
    if not title or not author:
        ht, ha = guess_head(raw[:80])
        if not title and ht:
            title = ht
        if not author and ha:
            author = ha
    if not title:
        title = path.stem

    outline = [{'level': l, 'title': t, 'page': p} for l, t, p in doc.get_toc()]

    return {
        'title': title[:200],
        'author': author[:200],
        'venue': venue[:120],
        'year': extract_year(meta),
        'pages': doc.page_count,
        'size': path.stat().st_size,
        'sourceName': path.name,
        'text': '\n'.join(t for t, _ in merged),
        'meta': {'fonts': fonts, 'lines': rows},
        'outline': outline,
        'blocks': blocks,
    }


# --- 与 PdfMeta.extractYearFromInfo 保持一致 ---------------------------------
#
# ⚠️ 这是**复刻**，不是「重写一遍」。两处规则必须一致，否则预览里
#    看到的年份和真机上的不一样，调试时会被带偏。
#
# ⚠️ 刻意**不使用** /Info 的 CreationDate/ModDate。
#    实测证据：LeCun《Deep learning》(2015) 的 PDF 里 CreationDate = 2026，
#    Rumelhart (1986) 的是 2004 —— 这些是 PDF 重新导出/下载的时间，
#    与发表年无关。用它们会产出系统性错误的年份。

YEAR_MIN = 1850

YEAR_PATTERNS = [
    # 2015 IEEE / 2016 ACM / 2015 Springer —— 年份 + 出版方
    re.compile(
        r'\b((?:19|20)\d{2})\s+'
        r'(?:IEEE|ACM|Springer|Elsevier|Wiley|Cambridge|Oxford|MIT Press)\b',
        re.IGNORECASE),
    # CVPR 2016 / ICML 2015 / NeurIPS 2017 —— 会议缩写 + 年份
    re.compile(
        r"\b(?:CVPR|ICCV|ECCV|ICML|ICLR|NIPS|NeurIPS|ACL|EMNLP|NAACL|AAAI|"
        r"IJCAI|SIGIR|KDD|WWW|ICDM|CIKM)[\s'’]*((?:19|20)\d{2})\b",
        re.IGNORECASE),
    # © 2015 / (c) 2015 / Copyright 2015 —— 版权年
    re.compile(
        r'(?:©|\(c\)|copyright)[^\n]{0,24}?\b((?:19|20)\d{2})\b',
        re.IGNORECASE),
]


def _is_plausible_year(year: str) -> bool:
    """年份是否落在合理区间（与 PdfMeta.isPlausibleYear 一致）。"""
    if not year.isdigit():
        return False
    n = int(year)
    return YEAR_MIN <= n <= datetime.date.today().year + 1


def extract_year(meta: dict) -> str:
    """从 /Info 的 Subject / Keywords 里找发表年。找不到返回空串。"""
    haystack = ' '.join(
        v for v in (meta.get('subject'), meta.get('keywords')) if v
    )
    if not haystack.strip():
        return ''
    for pattern in YEAR_PATTERNS:
        m = pattern.search(haystack)
        if m and _is_plausible_year(m.group(1)):
            return m.group(1)
    return ''


# --- 与 PdfMeta.cleanVenue 保持一致 ------------------------------------------

MAX_VENUE_LEN = 80

CATEGORY_RE = re.compile(r'\[[a-zA-Z]{2}\.[A-Za-z]{2,4}]')
URL_RE = re.compile(r'https?://\S+')
WWW_RE = re.compile(r'\bwww\.\S+')
BARE_DOMAIN_RE = re.compile(r'\s+[A-Za-z0-9-]+\.[A-Za-z]{2,6}/?(?=\s|$)')


def clean_venue(value: str) -> str:
    """清理 venue（发表载体）：去 URL、剥离学科分类、拒绝噪声。

    ⚠️ 术语：venue 可能是会议、预印本、专著、学位论文、技术报告……
       不一定是期刊，所以判据不能假设它是期刊名。

    实测：HAL 的 Subject 是学科分类串，NIPS 的带 URL 尾巴，
    CVPR 的才是正确会议名，BERT 的是 ACL 卷期号碎片（"N19-1 2019"）
    —— 所以不能简单地「有就用」或「一律丢弃」。
    """
    s = re.sub(r'\s+', ' ', value or '').strip()
    if not s:
        return ''
    s = URL_RE.sub(' ', s)
    s = WWW_RE.sub(' ', s)
    s = BARE_DOMAIN_RE.sub(' ', s)
    s = re.sub(r'\s+', ' ', s).strip().strip(',;/').strip()
    # 学科分类串
    if CATEGORY_RE.search(s):
        return ''
    if s.count('/') >= 2 and s.count(',') >= 1:
        return ''
    # 卷期号碎片：去掉数字与分隔符后字母不足 3 个（"N19-1 2019" → "N"）
    if len(re.sub(r'[^A-Za-z\u4e00-\u9fff]', '', s)) < 3:
        return ''
    if len(s) > MAX_VENUE_LEN:
        return ''
    return s


# --- 与 PdfText.guessHead 保持一致 -------------------------------------------

ABSTRACT_START = re.compile(r'^\s*(abstract|摘要|introduction|1\s+introduction)\b', re.I)
UNIT_START = re.compile(
    r'^\s*(department|university|institute|school|college|google|facebook|microsoft|'
    r'openai|deepmind|research|center|centre|laborator|faculty|abstract|'
    r'to cite|cite this|this version|submitted|published|preprint|'
    r'hal\b|doi\b|arxiv\b|proceedings|conference on|journal of)', re.I)


def guess_head(raw_lines):
    """raw_lines: [(text, font, size, page)] -> (title, author)

    取首页字号最大的行当标题，其后紧邻的姓名行当作者。
    与 PdfText.guessHead / guessAuthors 同一套判据。
    """
    lines = [(t, sz) for (t, _f, sz, _p) in raw_lines if t.strip()]
    if not lines:
        return '', ''

    title_idx, max_size = -1, 0.0
    for i, (t, sz) in enumerate(lines):
        if len(t) < 8:
            continue
        if sz > max_size:
            max_size, title_idx = sz, i
    if title_idx < 0:
        return '', ''

    parts = [lines[title_idx][0]]
    k = title_idx + 1
    while k < len(lines) and len(parts) < 4:
        t, sz = lines[k]
        if abs(sz - max_size) <= 0.3 and 1 <= len(t) <= 120:
            parts.append(t)
            k += 1
            continue
        break
    title = re.sub(r'\s+', ' ', ' '.join(parts)).strip()

    # 跳过空行
    i, skipped = k, 0
    while i < len(lines) and skipped < 3:
        if not lines[i][0].strip():
            i += 1
            skipped += 1
            continue
        break

    a_parts, scanned = [], 0
    while i < len(lines) and scanned < 60 and len(a_parts) < 30:
        t, sz = lines[i]
        i += 1
        scanned += 1
        if not t.strip():
            continue
        if ABSTRACT_START.match(t):
            break
        if len(t) > 160:
            break
        if sz > max_size + 0.3:
            continue
        # 单位行与邮箱 → 跳过继续（NIPS 是「姓名/单位/邮箱」三行循环）
        if '@' in t:
            continue
        if UNIT_START.match(t):
            continue
        if len(re.sub(r'[^A-Za-z\u4e00-\u9fff]', '', t)) < 2:
            continue
        words = t.split()
        is_list = ',' in t or re.search(r'\band\b', t, re.I)
        is_single = 2 <= len(words) <= 5 and not any(c.isdigit() for c in t) and len(t) <= 60
        if is_list or is_single:
            a_parts.append(t)
            continue
        break

    author = re.sub(r'\s*,\s*', ', ', ', '.join(a_parts))
    author = re.sub(r'\s+', ' ', author).strip().strip(',')
    return title, author


def main():
    args = sys.argv[1:]
    paths = [Path(a) for a in args] if args else [READING / p for p in DEFAULT]

    docs = []
    for i, p in enumerate(paths):
        if not p.exists():
            print(f'!! 跳过（不存在）: {p}')
            continue
        d = extract(p)
        docs.append({
            'id': f'dev{i + 1}',
            'title': d['title'],
            'author': d['author'],
            'venue': d['venue'],
            'year': d['year'],
            # 人工标注的载体类型（模拟将来用户自己设置的结果）
            'venueType': VENUE_TYPE.get(d['sourceName'], 'unknown'),
            # 短标题（这一篇文献的短名，不是载体缩写 —— 见上面 SHORT_TITLE 的注释）
            'shortTitle': SHORT_TITLE.get(d['sourceName'], ''),
            # 详情页要编辑的类别字段。预览里给空表 ——
            # 让「从未填过」和「填了值」两种状态都能测到。
            'fields': {},
            'addedAt': 1758700000000 - i * 86400000,
            'pages': d['pages'],
            'size': d['size'],
            'sourceName': d['sourceName'],
            # 阅读页要用
            '_text': d['text'],
            '_meta': d['meta'],
            '_outline': d['outline'],
            '_blocks': d['blocks'],
        })
        print(f'  {d["sourceName"]}')
        print(f'    title  : {d["title"][:60]}')
        print(f'    year   : {d["year"] or "(空)"}')
        print(f'    pages  : {d["pages"]}  size: {d["size"]:,}')
        print(f'    lines  : {len(d["meta"]["lines"])}  fonts: {len(d["meta"]["fonts"])}'
              f'  outline: {len(d["outline"])}')
        print(f'    text   : {len(d["text"]):,} chars')

    OUT.write_text(
        '/* 由 tools/make_dev_library.py 生成 —— 含真实论文全文，请勿提交。\n'
        '   浏览器预览用：<script src="dev-library.js"></script>\n'
        '   然后 window.ScholariusDevLibrary.load() 灌入文库。\n'
        '\n'
        '   ⚠️ 这个文件是**生成物**，不要手改 —— 重跑脚本就覆盖了。\n'
        '      要改预览行为，改 tools/make_dev_library.py。 */\n'
        'window.ScholariusDevLibrary = ' + json.dumps(
            {'docs': docs}, ensure_ascii=False) + ';\n'
        + DEV_SHIM,
        encoding='utf-8')
    print(f'\n-> {OUT}  ({OUT.stat().st_size:,} bytes)')
    print('   在预览页控制台执行:  ScholariusDevLibrary.load()')


# --- 浏览器预览用的桥垫片 ----------------------------------------------------
#
# ⚠️ 这段必须由脚本生成，不能手写进 dev-library.js。
#
#    实测踩过：手写版本里补了 requestDocText 却漏了 updateDoc，
#    于是浏览器里点「保存」毫无反应 —— 看起来像保存功能坏了，
#    实际只是预览缺桥。生成物每次重跑都会带上完整的垫片，
#    不会再出现「补了一个漏了一个」。
#
# ⚠️ 只在桥不存在时装。真机上 ScholariusNative 由原生注入，
#    不能被这里覆盖，否则真机会读到假数据。
DEV_SHIM = r'''
window.ScholariusDevLibrary.load = function () {
  var list = this.docs.map(function (d) {
    return { id: d.id, title: d.title, author: d.author, venue: d.venue,
             venueType: d.venueType, shortTitle: d.shortTitle,
             fields: d.fields || {}, year: d.year || '',
             addedAt: d.addedAt, pages: d.pages, size: d.size,
             sourceName: d.sourceName };
  });
  window.ScholariusShell.setLibrary(list);
  return list.length;
};
window.ScholariusDevLibrary.readerText = function (id) {
  var d = this.docs.filter(function (x) { return x.id === id; })[0];
  if (!d) return null;
  window.ScholariusShell.readerText(id, d._text, d._outline, d._meta, d._blocks);
  return d._text.length;
};

/* ---- 桥垫片：只补真机由原生提供、浏览器里缺的那几个 ---- */
if (!window.ScholariusNative) {
  window.ScholariusNative = {};
}

/* 阅读页取正文。异步推回，模拟原生在后台线程提取的行为。 */
if (typeof window.ScholariusNative.requestDocText !== 'function') {
  window.ScholariusNative.requestDocText = function (id) {
    setTimeout(function () {
      window.ScholariusDevLibrary.readerText(id);
    }, 60);
  };
}

/*
  详情页保存。语义必须与原生 LibraryStore.update **完全一致**：
    出现的键   -> 改成该值
    值为空串   -> 清空（顶层 title 除外，它落回文件名）
    没出现的键 -> 保持原值

  ⚠️ 还要走 Shell.docUpdated(id, ok) 回报 —— 详情页正是靠它收起面板的。
     少这一步，浏览器里点保存后界面毫无反应，会误判成保存坏了。

  ⚠️ TOP 白名单必须与 meta.js 的 TOP_LEVEL_KEYS / Kotlin 的
     LibraryStore.TOP_LEVEL_KEYS **逐字一致**。

     ⚠️⚠️ 这里曾经写的是 `venueShort`，而**同时**：
        · Kotlin 的 TOP_LEVEL_KEYS 里没有它；
        · Kotlin 的 Doc / parseDoc / writeIndex 四处都没有它。
        于是出现最贵的一类 bug：
          · 浏览器预览（用这个垫片）→ 存顶层 → 一切正常；
          · 真机（走 Kotlin）→ 被当 fields 的键写进 fields，
            而 parseDoc 只读顶层 → 读不到。
          · 表现：短标题保存后消失，**本地怎么测都是绿的**。

     所以这个白名单不是可选的便利设施 —— 它是唯一能提前发现
     JS/Kotlin 键名不一致的地方。已由 tools/check-meta.js 机械校验，
     改了这边不改那边会直接报错。
*/
if (typeof window.ScholariusNative.updateDoc !== 'function') {
  window.ScholariusNative.updateDoc = function (id, patchJson) {
    var ok = false;
    try {
      var patch = JSON.parse(patchJson);
      var d = window.ScholariusDevLibrary.docs.filter(function (x) {
        return x.id === id;
      })[0];
      if (d) {
        var TOP = {
          title: 1, author: 1, year: 1, venueType: 1, venue: 1,
          shortTitle: 1
        };
        if (typeof patch.title === 'string' && !patch.title.trim()) {
          patch.title = d.sourceName || 'Untitled';
        }
        if (!d.fields) d.fields = {};
        Object.keys(patch).forEach(function (k) {
          if (TOP[k]) {
            d[k] = patch[k];
          } else if (String(patch[k]).trim() === '') {
            delete d.fields[k];
          } else {
            d.fields[k] = String(patch[k]).trim();
          }
        });
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    setTimeout(function () {
      window.ScholariusDevLibrary.load();
      window.ScholariusShell.docUpdated(id, ok);
    }, 80);
  };
}
'''


if __name__ == '__main__':
    main()
