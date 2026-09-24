"""查看 PDF 原始内容流片段 —— 诊断子集字体编码用。"""
import re
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from probe_pdftext import for_each_stream  # noqa: E402

pdf = Path(sys.argv[1])
d = pdf.read_bytes()

shown = 0
for body in for_each_stream(d):
    try:
        inf = zlib.decompress(body)
    except Exception:
        continue
    if b"Tj" not in inf and b"TJ" not in inf:
        continue
    m = re.search(rb"BT(.{0,700}?)ET", inf, re.S)
    if not m:
        continue
    print("=" * 70)
    print(m.group(0)[:700].decode("latin-1"))
    print()
    shown += 1
    if shown >= 3:
        break
print(f"(showed {shown} blocks)")
