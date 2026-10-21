# -*- coding: utf-8 -*-
"""检查「PDF 里的正文是否都进了阅读视图」。

做法：
  1. 用 PyMuPDF **独立**抽取 PDF 全文（与 Kotlin 的 PdfText 是两套实现，
     互为对照 —— 只用我们自己那套会把"我们漏了什么"也一起漏掉）
  2. 通过 CDP 拿阅读视图实际渲染出来的块文本
  3. 分词后做**双向**比对：
     - 召回（PDF → 视图）：PDF 里的词有多少出现在视图里  ← 本任务重点
     - 精确（视图 → PDF）：视图里的词有多少真在 PDF 里（查幻觉/串页）

用法：
    python tools/check_text_coverage.py --pdf "<path>" [--doc-id devtest1]
    python tools/check_text_coverage.py --pdf "<path>" --detail 30
"""
import argparse
import json
import os
import re
import subprocess
import sys

try:
    import pymupdf
except ImportError:
    import fitz as pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def pdf_words(path):
    """PDF 全文 → 归一化后的词列表（保留重复次数，用于覆盖率）。"""
    doc = pymupdf.open(path)
    chunks = []
    for page in doc:
        chunks.append(page.get_text("text"))
    doc.close()
    return normalise_words("\n".join(chunks))


def pdf_pages_text(path):
    doc = pymupdf.open(path)
    pages = [p.get_text("text") for p in doc]
    doc.close()
    return pages


# 只保留"内容字符"：字母、数字、CJK。
# ⚠️ 不用 \w —— 它把下划线也算进来，而 PDF 里没有语义。
# ⚠️ 保留 CJK：中文论文里汉字之间不加空格，按空格分词会整段粘成一坨。
CONTENT_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff]+")


def normalise_words(text):
    """统一的词切分：小写 + 只取内容字符。

    ⚠️ 连字符断词必须**两侧都拼回**（2026-10-21 踩过）。

       PDF 里 `computa-\ntion` 被 PyMuPDF 抽成两行，拼回成 `computation`；
       而 Kotlin 的 PdfText 会把整行拼好直接给 `computation`。
       如果只在 PDF 侧拼回、视图侧不拼，那么 PDF 侧有 `computation`、
       视图侧也有 `computation` —— 看起来是对的。

       但**反过来**的情形才是坑：视图侧的正文如果被切成
       `signi` + `cantly`（我们自己拼行失败），而 PDF 侧是 `significantly`，
       逐词比对只会报"漏了 significantly"，看不到"其实是我们切碎了"。

       ⚠️ 更常见的误判：`efﬁcient`（连字 ﬁ U+FB01）等**连字字符**，
       PDF 侧是单字符、视图侧若被拆开成 `ef` + `cient` 就永远匹配不上。
       所以两侧都要做 **连字归一** + **断词拼回**。

    ⚠️ 不能简单把所有 `-` 都删掉 —— `state-of-the-art` 会被粘成一词，
       与两侧任一侧的分词都不同。只处理**行尾连字符**（`-\n`）。
    """
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    # 连字（ligature）→ 普通字母
    for lig, plain in (("\ufb00", "ff"), ("\ufb01", "fi"), ("\ufb02", "fl"),
                       ("\ufb03", "ffi"), ("\ufb04", "ffl"), ("\ufb05", "st"),
                       ("\ufb06", "st")):
        t = t.replace(lig, plain)
    # 行尾连字符断词拼回
    t = re.sub(r"-\n", "", t)
    t = re.sub(r"[­-]\n", "", t)      # 软连字符 U+00AD
    t = re.sub(r"\s+", " ", t)
    return [w.lower() for w in CONTENT_RE.findall(t)]


def view_blocks(doc_id):
    """通过 CDP 取阅读视图的块文本。"""
    js = (
        "return JSON.stringify((window.ScholariusReader && "
        "window.ScholariusReader.getBlocks()) || [])"
    )
    p = subprocess.run(
        [sys.executable, os.path.join(HERE, "emu_js.py"), js],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=ROOT,
    )
    out = (p.stdout or b"").decode("utf-8", "replace").strip()
    # emu_js.py 只输出结果本身（可能带一点提示行）
    line = None
    for ln in out.splitlines():
        s = ln.strip()
        if s.startswith("["):
            line = s
    if line is None:
        raise SystemExit("拿不到 blocks：\n" + out[:2000])
    return json.loads(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--doc-id", default="devtest1")
    ap.add_argument("--detail", type=int, default=0,
                    help="打印前 N 条漏掉的内容片段")
    args = ap.parse_args()

    pdfw = pdf_words(args.pdf)
    blocks = view_blocks(args.doc_id)
    view_text = "\n".join((b.get("text") or "") for b in blocks)
    vieww = normalise_words(view_text)

    from collections import Counter
    pc = Counter(pdfw)
    vc = Counter(vieww)

    total = sum(pc.values())
    matched = sum(min(c, vc[w]) for w, c in pc.items())
    missing = sum(max(0, c - vc[w]) for w, c in pc.items())

    print("=" * 68)
    print("PDF 词数 : %d" % total)
    print("视图词数 : %d" % sum(vc.values()))
    print("块数     : %d" % len(blocks))
    print("召回     : %.2f%%  （漏 %d 词）" % (100.0 * matched / max(1, total), missing))
    if vieww:
        extra = sum(max(0, c - pc[w]) for w, c in vc.items())
        print("精确     : %.2f%%  （视图里多出 %d 词）"
              % (100.0 * (sum(vc.values()) - extra) / sum(vc.values()), extra))
    print("=" * 68)

    # 漏掉的词按出现次数排
    miss = [(w, pc[w] - vc.get(w, 0)) for w in pc if pc[w] > vc.get(w, 0)]
    miss.sort(key=lambda x: -x[1])
    print("\n漏词 top %d：" % min(30, len(miss)))
    for w, n in miss[:30]:
        print("   %-24s x%d" % (w, n))

    if args.detail:
        # 按页找"整段没进视图"的正文 —— 比逐词更能定位问题
        print("\n按页统计（PDF 页面召回）：")
        for i, page_text in enumerate(pdf_pages_text(args.pdf), 1):
            pw = normalise_words(page_text)
            if not pw:
                continue
            c = Counter(pw)
            hit = sum(min(n, vc[w]) for w, n in c.items())
            print("   page %2d: %5.1f%%  (%d/%d 词)"
                  % (i, 100.0 * hit / len(pw), hit, len(pw)))

        print("\n视图里没有的整行（PDF 原文，按页，最多 %d 条）：" % args.detail)
        shown = 0
        for i, page_text in enumerate(pdf_pages_text(args.pdf), 1):
            for raw in page_text.splitlines():
                s = raw.strip()
                if len(CONTENT_RE.findall(s)) < 6:
                    continue
                ws = normalise_words(s)
                if not ws:
                    continue
                if all(vc.get(w, 0) == 0 for w in set(ws)):
                    print("   p%-2d %s" % (i, s[:100]))
                    shown += 1
                    if shown >= args.detail:
                        return


if __name__ == "__main__":
    main()
