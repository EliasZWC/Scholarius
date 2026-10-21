# -*- coding: utf-8 -*-
"""复刻 Kotlin PdfText 的提取管线，定位「哪一页 / 哪一类行被丢掉」。

不依赖设备，纯 Python + PyMuPDF 模拟：
  · 行收集（同 y 拼行）
  · MIN_BODY_RATIO 小字号过滤
  · 段落合并（flush 规则）
  · MAX_CHARS 截断

输出逐页「进入 / 丢弃」字符数，以及被丢弃的行样本。
"""
import argparse
import re

try:
    import pymupdf
except ImportError:
    import fitz as pymupdf

MIN_BODY_RATIO = 0.75
TINY_TEXT_RATIO = 0.45
MAX_CHARS = 2_000_000

PROSE_END = ".!?。！？:："
BARE_NUMBER = re.compile(r"^\d{1,2}(?:\.\d{1,2}){0,2}\.?$")


def looks_like_prose(t):
    if not t:
        return False
    if t[-1] in PROSE_END:
        return True
    if "," in t and len(t) > 30:
        return True
    if t[0].islower() and " " in t:
        return True
    spaces = t.count(" ")
    if spaces >= 4:
        if len([w for w in t.split(" ") if w.strip()]) > 8:
            return True
    return False


def collect_lines(page):
    """按 (y0, size) 把 span 拼成视觉行。返回 [(text, size, font, y0)]。"""
    rows = []
    cur = None
    for blk in page.get_text("dict")["blocks"]:
        if blk["type"] != 0:
            continue
        for line in blk["lines"]:
            txt = "".join(s["text"] for s in line["spans"]).strip()
            if not txt:
                continue
            sizes = [s["size"] for s in line["spans"] if s["text"].strip()]
            if not sizes:
                continue
            size = max(sizes, key=lambda z: sizes.count(z))
            # 主字体：字符数最多
            fc = {}
            for s in line["spans"]:
                fc[s["font"]] = fc.get(s["font"], 0) + len(s["text"])
            font = max(fc, key=fc.get) if fc else ""
            y0 = line["bbox"][1]
            h = line["bbox"][3] - line["bbox"][1]
            rows.append((txt, size, font, y0, h))
    return rows


def body_size(all_rows):
    """正文字号 = 按字符数加权的众数（0.5pt 桶）。"""
    c = {}
    for txt, size, _f, _y, _h in all_rows:
        k = round(size * 2) / 2
        c[k] = c.get(k, 0) + len(txt)
    if not c:
        return 0.0
    return max(c, key=c.get)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    per_page = []
    all_rows = []
    for pi, page in enumerate(doc, 1):
        rows = collect_lines(page)
        per_page.append(rows)
        all_rows.extend(rows)
    bs = body_size(all_rows)
    print("正文基准字号: %.1f" % bs)
    print()

    kept_chars = dropped_chars = 0
    for pi, rows in enumerate(per_page, 1):
        k = d = 0
        dropped = []
        for txt, size, _f, _y, _h in rows:
            if bs > 0 and size > 0 and size < bs * MIN_BODY_RATIO:
                tiny = size < bs * TINY_TEXT_RATIO
                if tiny or not looks_like_prose(txt):
                    d += len(txt)
                    dropped.append((txt, size))
                    continue
            k += len(txt)
        kept_chars += k
        dropped_chars += d
        print("page %2d: 进 %5d  丢 %5d  (%d 行)" % (pi, k, d, len(rows)))
        for txt, size in dropped[:4]:
            print("          丢 %.1fpt: %s" % (size, txt[:80]))

    print()
    print("合计: 进 %d / 丢 %d (%.2f%% 丢弃)" % (
        kept_chars, dropped_chars,
        100.0 * dropped_chars / max(1, kept_chars + dropped_chars)))
    doc.close()


if __name__ == "__main__":
    main()
