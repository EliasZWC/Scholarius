# -*- coding: utf-8 -*-
"""检查「PDF 正文是否 100% 进入阅读视图」—— **词级**，按块报告。

══ 为什么换了三版 ══

v1 逐块「整段 in 全文」→ 误报 81/204。原因：
   · `ﬁ` 连字、行尾断词、跨块拼接全都导致字符串对不上
v2 字符级子序列覆盖率 → 仍报 3 块。原因：
   · 子序列对**公式符号**（`β1` `ϵ` `−`）极度敏感，
     视图把公式归一掉了几个字符，整块就被判成"只覆盖 25%"
   · 但人眼一看，那些块的**正文文字**明明都在

v3（本版）：**只比"词"**，不比符号。
   · 词 = 连续字母数字，长度 >= 2（单字符全是公式下标，没有判别力）
   · 逐块报告 "缺了哪些词"
   · 判据：缺词率 > 15% 才算真问题

用法：
    python tools/check_block_parity.py --pdf "<path>"
"""
import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter

try:
    import pymupdf
except ImportError:
    import fitz as pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

LIGATURES = {"\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
             "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st",
             "\ufb06": "st", "\u00ad": ""}

# ⚠️ 词长 >= 2：单字符全是公式下标（`Q` `K` `h` `n`），
#    它们被 PDF 单独切出来，与正文是否完整无关。
WORD_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff]{2,}")


def words(s):
    t = s or ""
    for k, v in LIGATURES.items():
        t = t.replace(k, v)
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"-\n", "", t)
    return [w.lower() for w in WORD_RE.findall(t)]


def view_blocks():
    js = ("return JSON.stringify((window.ScholariusReader && "
          "window.ScholariusReader.getBlocks()) || [])")
    p = subprocess.run([sys.executable, os.path.join(HERE, "emu_js.py"), js],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=ROOT)
    out = (p.stdout or b"").decode("utf-8", "replace")
    line = None
    for ln in out.splitlines():
        if ln.strip().startswith("["):
            line = ln.strip()
    if line is None:
        raise SystemExit("拿不到 blocks:\n" + out[:1500])
    return json.loads(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--min-words", type=int, default=4,
                    help="只看词数 >= 该值的 PDF 文字块")
    ap.add_argument("--threshold", type=float, default=0.15,
                    help="缺词率超过该值才报告")
    args = ap.parse_args()

    blocks = view_blocks()
    vc = Counter(words("\n".join((b.get("text") or "") for b in blocks)))
    total_view_words = sum(vc.values())

    doc = pymupdf.open(args.pdf)
    checked = 0
    bad = []
    total_pdf = 0
    total_hit = 0
    for pi, page in enumerate(doc, 1):
        for b in page.get_text("blocks"):
            if b[6] != 0:
                continue
            txt = (b[4] or "").strip()
            ws = words(txt)
            if len(ws) < args.min_words:
                continue
            checked += 1
            c = Counter(ws)
            hit = sum(min(n, vc[w]) for w, n in c.items())
            total_pdf += len(ws)
            total_hit += hit
            miss_rate = 1.0 - hit / len(ws)
            if miss_rate > args.threshold:
                bad.append((pi, miss_rate, txt, c - vc))

    doc.close()

    print("=" * 72)
    print("视图块数        : %d（%d 词）" % (len(blocks), total_view_words))
    print("PDF 文字块      : %d 个（%d 词）" % (checked, total_pdf))
    print("正文词召回率    : %.2f%%" % (100.0 * total_hit / max(1, total_pdf)))
    print("缺词率 > %.0f%% 的块 : %d 个" % (args.threshold * 100, len(bad)))
    print("=" * 72)
    for pi, rate, txt, miss in bad:
        print("\n── p%-2d 缺词 %.1f%% ─────────────────────" % (pi, rate * 100))
        print(txt[:300].replace("\n", " ⏎ "))
        top = [w for w, _ in miss.most_common(12)]
        print("   缺: %s" % " ".join(top))


if __name__ == "__main__":
    main()
