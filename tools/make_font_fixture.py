"""生成带字体元数据的夹具（模拟 PDFBox LineCollector 的输出）。

PDFBox 侧的输出 = {fonts:[名], lines:[[fontIdx, sizeX10, page]]}
正文行 = 已合并段落的行文本（PDFBox mergeParagraphs 的产物）。

这里用 PyMuPDF 逐行取 (文本, 主字体, 主字号, 页码)，
再按与 mergeParagraphs 相同的规则合并，尽量贴近真实输入。
"""
import json
import sys
from collections import Counter
from pathlib import Path

import pymupdf

pdf = Path(sys.argv[1])
doc = pymupdf.open(str(pdf))

raw = []          # (text, font, size, page)
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
            # 主字体/主字号按字符数加权（与 LineCollector.describe 一致）
            w = Counter()
            sw = Counter()
            for sp in spans:
                n = len(sp.get('text', ''))
                w[sp['font']] += n
                sw[round(sp['size'] * 10)] += n
            font = w.most_common(1)[0][0]
            size = sw.most_common(1)[0][0] / 10
            raw.append((text.strip(), font, size, pno))

# --- 近似 mergeParagraphs ---
SENT_END = set('.?!:;。？！：；」』）)"')
SHORT = 60
NUMBER_ONLY = None
import re
NUMBER_ONLY = re.compile(r'^§?\s*(\d+(\.\d+)*|[IVXLC]+)[.、]?$')
UPPER_HEAD = re.compile(r"^[A-Z][A-Z0-9 \-,:&'()/]{2,}$")


def looks_like_head(s):
    if not s:
        return False
    if NUMBER_ONLY.match(s):
        return True
    if UPPER_HEAD.match(s):
        return True
    return len(s) <= SHORT and s[-1] not in SENT_END


out_lines = []
para = ''
meta = None
for text, font, size, page in raw:
    t = text.strip()
    if not t:
        if para:
            out_lines.append((para, meta))
            para, meta = '', None
        continue
    if looks_like_head(para):
        if para:
            out_lines.append((para, meta))
        para, meta = t, (font, size, page)
        continue
    if para and para[-1] in SENT_END:
        out_lines.append((para, meta))
        para, meta = t, (font, size, page)
    else:
        if para:
            a, b = para[-1], t[0]
            if a != '-' and a.isalnum() and a.isascii() and b.isalnum() and b.isascii():
                para += ' '
            para += t
        else:
            para = t
            meta = (font, size, page)
if para:
    out_lines.append((para, meta))

# --- 序列化成 MainActivity.linesToJson 的形态 ---
fonts = []
font_index = {}
rows = []
for text, m in out_lines:
    font, size, page = m
    if font not in font_index:
        font_index[font] = len(fonts)
        fonts.append(font)
    rows.append([font_index[font], round(size * 10), page])

data = {
    'source': pdf.name,
    'text': '\n'.join(t for t, _ in out_lines),
    'meta': {'fonts': fonts, 'lines': rows},
    'outline': [{'level': l, 'title': ti, 'page': pg} for l, ti, pg in doc.get_toc()],
}

dest = Path('tools/smoke/_font_' + pdf.stem.split('_')[0] + '.json')
dest.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
print(f'{pdf.name}')
print(f'  merged lines : {len(out_lines)}')
print(f'  fonts        : {len(fonts)}')
print(f'  outline      : {len(data["outline"])}')
print(f'  -> {dest}')
