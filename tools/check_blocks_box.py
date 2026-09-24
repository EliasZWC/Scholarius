"""检查 dev-library.js 里块包围盒的质量。

用途：预览里「文本」标注模式靠块的包围盒把文字块画在页图上。
      如果生成器算错（全空、越界、错页），预览里就点不到任何文字区域 ——
      而界面上不会报错，只是"点了没反应"。

用法: python tools/check_blocks_box.py
"""
import io
import json
import os
import sys

PATH = os.path.join("app", "src", "main", "assets", "www", "dev-library.js")
MARK_START = "window.ScholariusDevLibrary = "
MARK_END = ";"


def main():
    if not os.path.isfile(PATH):
        print("找不到 %s（先跑 make_dev_library.py）" % PATH)
        return 1

    src = io.open(PATH, encoding="utf-8").read()
    i = src.index(MARK_START) + len(MARK_START)
    # 数据是**一行** JSON，后跟 ';'
    j = src.index("\n", i)
    payload = src[i:j].rstrip()
    if payload.endswith(";"):
        payload = payload[:-1]
    data = json.loads(payload)

    bad = 0
    for d in data["docs"]:
        blocks = d.get("_blocks") or []
        with_box = [b for b in blocks
                    if b.get("x1", 0) > b.get("x0", 0) and b.get("y1", 0) > b.get("y0", 0)]
        pct = 100 * len(with_box) // max(1, len(blocks))
        flag = "" if pct >= 50 else "   <-- 偏低，文本模式可能点不到"
        print("%-34s blocks=%4d  withBox=%4d (%d%%)%s"
              % (d["title"][:34], len(blocks), len(with_box), pct, flag))
        if pct < 50:
            bad += 1

        # 越界检查
        out_of_range = [b for b in with_box
                        if not (0 <= b["x0"] <= 1 and 0 <= b["y0"] <= 1
                                and 0 <= b["x1"] <= 1 and 0 <= b["y1"] <= 1)]
        if out_of_range:
            print("    ⚠️ %d 个块坐标越界（应全在 0~1）" % len(out_of_range))
            for b in out_of_range[:3]:
                print("       x=[%s,%s] y=[%s,%s]"
                      % (b["x0"], b["x1"], b["y0"], b["y1"]))
            bad += 1

        # 页数范围检查
        pages = d.get("pages") or 0
        wrong_page = [b for b in with_box if not (1 <= b.get("page", 0) <= pages)]
        if wrong_page:
            print("    ⚠️ %d 个块的页码超出 1~%d" % (len(wrong_page), pages))
            bad += 1

    if bad:
        print("\n%d 篇有问题" % bad)
        return 1
    print("\nOK: 全部块的包围盒正常")
    return 0


if __name__ == "__main__":
    sys.exit(main())
