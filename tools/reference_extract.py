"""
用成熟库提取同一篇 PDF，作为「正确答案」参照。

用途：确定我们自己的 PdfText 应该输出成什么样，以及在 Android 上
      手写实现要覆盖哪些环节（ToUnicode CMap、字距、空格推断、坐标排序）。
"""
import sys
from pathlib import Path

import fitz  # PyMuPDF
from pypdf import PdfReader

pdf = Path(sys.argv[1])

print("=" * 78)
print("PyMuPDF (fitz) —— 业界基准")
print("=" * 78)
doc = fitz.open(str(pdf))
print(f"pages: {doc.page_count}")
for i in range(min(2, doc.page_count)):
    text = doc[i].get_text()
    print(f"--- page {i + 1} ---")
    print(text[:900] if text.strip() else "(EMPTY)")
    print()

print("=" * 78)
print("pypdf")
print("=" * 78)
r = PdfReader(str(pdf))
print(f"pages: {len(r.pages)}")
for i in range(min(2, len(r.pages))):
    t = r.pages[i].extract_text() or ""
    print(f"--- page {i + 1} ---")
    print(t[:900] if t.strip() else "(EMPTY)")
    print()
