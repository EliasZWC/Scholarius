"""验证 guessHead / cleanVenue 对四篇真实论文的结果。

复刻 PdfText.guessHead 与 PdfMeta.cleanVenue 的判据，
用真实首页行喂进去，看能否补出正确的标题与作者。
"""
import re
from pathlib import Path

import pymupdf

READING = Path.home() / 'OneDrive' / '论文' / 'reading'
FILES = [
    (r'02_deep\2015_深度学习里程碑综述_Nature_LeCun.pdf', 'Deep learning',
     'Yann Lecun, Yoshua Bengio, Geoffrey Hinton'),
    (r'02_deep\2017_Transformer提出纯注意力模型_NIPS_Vaswani.pdf', 'Attention is All you Need',
     'Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit'),
    (r'00_inbox\2016_残差连接提出_CVPR_He.pdf', 'Deep Residual Learning for Image Recognition',
     'Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun'),
    (r'00_inbox\2022_LLM思维链提出_NIPS_Wei.pdf', 'Chain-of-Thought Prompting Elicits Reasoning',
     'Jason Wei, Xuezhi Wang, Dale Schuurmans'),
]

ABSTRACT_START = re.compile(r'^\s*(abstract|摘要|introduction|1\s+introduction)\b', re.I)
UNIT_START = re.compile(
    r'^\s*(department|university|institute|school|college|google|facebook|microsoft|'
    r'openai|deepmind|research|center|centre|laborator|faculty|abstract)\b', re.I)

MAX_VENUE_LEN = 80


def clean_venue(value: str) -> str:
    s = re.sub(r'\s+', ' ', value or '').strip()
    if not s:
        return ''
    s = re.sub(r'https?://\S+', ' ', s)
    s = re.sub(r'\bwww\.\S+', ' ', s)
    s = re.sub(r'\s+[A-Za-z0-9-]+\.[A-Za-z]{2,6}/?(?=\s|$)', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip().strip(',;/').strip()
    if len(re.findall(r'\[[a-zA-Z]{2}\.[A-Za-z]{2,4}\]', s)) >= 1:
        return ''
    if s.count('/') >= 2 and s.count(',') >= 1:
        return ''
    if len(s) > MAX_VENUE_LEN:
        return ''
    return s


def page1_lines(pdf: Path):
    doc = pymupdf.open(str(pdf))
    out = []
    d = doc[0].get_text('dict')
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
            out.append((text.strip(), max(fw, key=fw.get), max(sw, key=sw.get) / 10))
    return out


def guess_head(lines):
    """lines: [(text, font, size)]"""
    title_idx, max_size = -1, 0.0
    for i, (t, _, sz) in enumerate(lines):
        if len(t) < 8:
            continue
        if sz > max_size:
            max_size, title_idx = sz, i
    if title_idx < 0:
        return None, None

    parts = [lines[title_idx][0]]
    k = title_idx + 1
    while k < len(lines) and len(parts) < 4:
        t, _, sz = lines[k]
        if not t:
            k += 1
            continue
        if abs(sz - max_size) <= 0.3 and 1 <= len(t) <= 120:
            parts.append(t)
            k += 1
            continue
        break
    title = re.sub(r'\s+', ' ', ' '.join(parts)).strip()

    # authors
    i, skipped = k, 0
    while i < len(lines) and skipped < 3:
        if not lines[i][0]:
            i += 1
            skipped += 1
            continue
        break
    a_parts, scanned = [], 0
    while i < len(lines) and scanned < 8 and len(a_parts) < 4:
        t, _, sz = lines[i]
        i += 1
        scanned += 1
        if not t:
            continue
        if sz > max_size + 0.3:
            continue
        if len(t) > 160:
            break
        if ABSTRACT_START.match(t):
            break
        if '@' in t and ',' not in t:
            break
        if UNIT_START.match(t):
            break
        is_list = ',' in t or re.search(r'\band\b', t, re.I)
        is_single = 2 <= len(t.split()) <= 5 and not any(ch.isdigit() for ch in t) and len(t) <= 60
        if is_list or is_single:
            a_parts.append(t)
            continue
        break
    author = re.sub(r'\s*,\s*', ', ', ', '.join(a_parts))
    author = re.sub(r'\s+', ' ', author).strip().strip(',')
    return title, author


print('=' * 78)
for rel, want_title, want_author in FILES:
    p = READING / rel
    if not p.exists():
        print('missing:', rel)
        continue
    lines = page1_lines(p)
    t, a = guess_head(lines)
    doc = pymupdf.open(str(p))
    m = doc.metadata or {}
    cv = clean_venue(m.get('subject') or '')

    print(p.name)
    print(f'  meta.title  : {(m.get("title") or "(空)")[:70]}')
    print(f'  guess.title : {t}')
    print(f'  meta.author : {(m.get("author") or "(空)")[:70]}')
    print(f'  guess.author: {a}')
    print(f'  raw subject : {(m.get("subject") or "(空)")[:80]}')
    print(f'  clean_venue : {cv!r}')
    print(f'  TITLE match : {"OK" if t and want_title.lower()[:24] in t.lower() else "??"}')
    print(f'  AUTHOR match: {"OK" if a and want_author.split(",")[0].strip().lower() in a.lower() else "??"}')
    print()
