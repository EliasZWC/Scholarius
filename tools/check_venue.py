"""验证 clean_venue 对全部本地论文的结果（真数据，不是构造的用例）。

起因：用户指出「发表物不一定是期刊，可能是会议或者预印本、专著啥的」。
这里把 Subject / Keywords 全量过一遍 clean_venue，确认：
  · 真载体名不被误杀（CVPR / ICML / NIPS）
  · 噪声被拦掉（HAL 分类串 / URL / ACL 卷期号）
"""
import re
import sys
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path('tools')))
from make_dev_library import clean_venue  # noqa: E402

READING = Path.home() / 'OneDrive' / '论文' / 'reading'

print(f'{"文件":46} {"raw subject":46} -> clean')
print('-' * 118)
killed = kept = 0
for p in sorted(READING.rglob('*.pdf')):
    try:
        doc = pymupdf.open(str(p))
        m = doc.metadata or {}
    except Exception as e:
        print(f'{p.name[:44]:46} (unreadable: {e})')
        continue
    raw = (m.get('subject') or '').strip()
    kw = (m.get('keywords') or '').strip()
    out = clean_venue(raw)
    if not out and kw:
        out = clean_venue(kw)
        if out:
            raw = f'{raw} | kw:{kw}'.strip(' |')
    if out:
        kept += 1
    else:
        killed += 1
    flag = 'KEEP' if out else 'DROP'
    print(f'{p.name[:44]:46} {raw[:46]:46} {flag} {out[:40]}')

print('-' * 118)
print(f'kept {kept} / dropped {killed} / total {kept + killed}')
