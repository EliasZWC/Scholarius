# -*- coding: utf-8 -*-
"""批量检查多篇论文的「正文是否都进了阅读视图」。

对每篇 PDF：
  1. seed 进模拟器（重装会清数据，这里是按 id 逐篇塞）
  2. 打开 → 等提取完成
  3. 跑词级覆盖率比对

用法：
    python tools/check_coverage_batch.py --dir "<论文目录>" [--limit 5]
"""
import argparse
import glob
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
PY = sys.executable

LIGATURES = {"\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
             "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st",
             "\ufb06": "st", "\u00ad": ""}
WORD_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff]{2,}")


def words(s):
    t = s or ""
    for k, v in LIGATURES.items():
        t = t.replace(k, v)
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"-\n", "", t)
    return [w.lower() for w in WORD_RE.findall(t)]


def emu_js(js, timeout=90):
    p = subprocess.run([PY, os.path.join(HERE, "emu_js.py"), js],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       cwd=ROOT, timeout=timeout)
    return (p.stdout or b"").decode("utf-8", "replace")


def blocks_now():
    out = emu_js("return JSON.stringify((window.ScholariusReader && "
                 "window.ScholariusReader.getBlocks()) || [])")
    line = None
    for ln in out.splitlines():
        if ln.strip().startswith("["):
            line = ln.strip()
    return json.loads(line) if line else []


def wait_blocks(expect_at_least=1, stable=3, timeout=40):
    """等 blocks 稳定。

    ⚠️ **必须等到"非空且连续 N 次不变"**（2026-10-21 踩过）：
       打开新文献时 lastBlocks 会先被清成 null，
       若只等 `len > 0`，会读到**上一篇**还没清掉的旧数据 ——
       实测因此误判"第 10-12 页缺失"（其实是上篇只有 9 页）。
    """
    import time
    last = -1
    same = 0
    for _ in range(timeout):
        time.sleep(1)
        bs = blocks_now()
        n = len(bs)
        if n >= expect_at_least and n == last:
            same += 1
            if same >= stable:
                return bs
        else:
            same = 0
        last = n
    return blocks_now()


def check(pdf, doc_id):
    """seed → 打开 → 等 → 取 blocks → 比对。返回 (召回率, 缺词率>15%块数, 块数, 缺页)。"""
    subprocess.run([PY, os.path.join(HERE, "seed_emu_library.py"),
                    "--pdf", pdf, "--id", doc_id],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   cwd=ROOT, timeout=180)

    # ⚠️ seed 会**重启应用**，必须等它起来再过 CDP，
    #    否则 `emu_js.py` 找不到 target，返回空 → 误判"0 块/缺全部页"。
    import time
    for _ in range(20):
        time.sleep(1)
        out = emu_js("return 'ready'", timeout=20)
        if "ready" in out:
            break

    # 先关掉上一篇，确认 blocks 真的清空了，再打开新的
    emu_js("(function(){var l=document.querySelector('.login');"
           "if(l){l.classList.remove('is-open');l.hidden=true}"
           "if(window.ScholariusReader)window.ScholariusReader.close();"
           "return 1})()")
    time.sleep(1)
    emu_js("(function(){window.ScholariusReader.open({id:'%s',title:'t'});return 1})()" % doc_id)

    bs = wait_blocks()

    vc = Counter(words("\n".join((b.get("text") or "") for b in bs)))

    # ⚠️ 必须核对"视图块里出现的页码"是否覆盖了 PDF 的全部页码，
    #    否则纯按词算召回会把"整页没进来"平均掉。
    doc = pymupdf.open(pdf)
    pdf_pages = doc.page_count
    seen_pages = set()
    for b in bs:
        p = b.get("page")
        if isinstance(p, int) and p > 0:
            seen_pages.add(p)

    total = hit = 0
    bad = 0
    for page in doc:
        for b in page.get_text("blocks"):
            if b[6] != 0:
                continue
            ws = words((b[4] or "").strip())
            if len(ws) < 4:
                continue
            c = Counter(ws)
            h = sum(min(n, vc[w]) for w, n in c.items())
            total += len(ws)
            hit += h
            if 1.0 - h / len(ws) > 0.15:
                bad += 1
    doc.close()
    missing_pages = [p for p in range(1, pdf_pages + 1) if p not in seen_pages]
    return (100.0 * hit / max(1, total), bad, len(bs), missing_pages)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--limit", type=int, default=5)
    args = ap.parse_args()

    pdfs = sorted(glob.glob(os.path.join(args.dir, "**", "*.pdf"), recursive=True))
    pdfs = pdfs[:args.limit]

    print("%-42s %8s %6s %6s  %s" % ("文件", "召回", "差块", "块数", "缺页"))
    print("-" * 78)
    for i, pdf in enumerate(pdfs, 1):
        name = os.path.basename(pdf)
        try:
            r, bad, n, mp = check(pdf, "batch%d" % i)
            flag = ("缺页 " + ",".join(str(p) for p in mp)) if mp else "—"
            print("%-42s %7.2f%% %5d %6d  %s" % (name[:40], r, bad, n, flag))
        except Exception as e:
            print("%-42s  ERROR %s" % (name[:40], str(e)[:40]))


if __name__ == "__main__":
    main()
