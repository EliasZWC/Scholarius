"""对比四篇论文的元数据字段，确定 venue 该从哪取。"""
import sys
from pathlib import Path

import pymupdf

READING = Path.home() / 'OneDrive' / '论文' / 'reading'
FILES = [
    r'02_deep\2015_深度学习里程碑综述_Nature_LeCun.pdf',
    r'02_deep\2017_Transformer提出纯注意力模型_NIPS_Vaswani.pdf',
    r'00_inbox\2016_残差连接提出_CVPR_He.pdf',
    r'00_inbox\2022_LLM思维链提出_NIPS_Wei.pdf',
]

for f in FILES:
    p = READING / f
    if not p.exists():
        continue
    doc = pymupdf.open(str(p))
    m = doc.metadata or {}
    print('=' * 74)
    print(p.name)
    print('=' * 74)
    for k in ('title', 'author', 'subject', 'keywords', 'creator', 'producer'):
        v = (m.get(k) or '').strip()
        if v:
            print(f'  {k:10}: {v[:150]}')
    # XMP 原始块
    import re
    try:
        xref = doc.xref_xml_metadata()
        xmp = doc.xref_stream(xref).decode('utf-8', 'replace') if xref else ''
    except Exception as e:
        xmp = ''
        print(f'  (xmp unreadable: {e})')
    if xmp:
        for pat in ('dc:source', 'prism:publicationName', 'dc:publisher',
                    'prism:doi', 'dc:subject', 'pdf:Keywords', 'dc:title'):
            esc = pat.replace(':', r'\:')
            for mm in re.finditer(r'<' + esc + r'[^>]*>([^<]{0,120})', xmp):
                print(f'  XMP {pat:22}: {mm.group(1).strip()[:120]}')
    print()
