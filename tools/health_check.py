"""健康度评估：只看**正文区**（排除封面/作者/脚注/参考文献）。

⚠️ 为什么要排除：上一篇文档的前几页是
   标题、作者、单位、邮箱、脚注，它们**本来就短**（15-42 字符）。
   把它们算进"段落长度分布"会让中位数严重偏低 ——
   实测 2017 的 Transformer：中位数 24，
   但真正的问题是**它前 17 行全是作者信息**，正文从第 18 行才开始。

   只看正文，才能回答"段落有没有被切碎"这个真正的问题。

判据：正文 = 字号等于正文字号、且**长度 > 80 字符**的行。
      （短行无法区分"被切碎的段落"与"作者名/脚注"，
        所以用长度门槛把它们排除在**指标**之外 ——
        注意这是**评估口径**，不是生成规则。）

用法: python tools/health_check.py
"""
import io
import json
import os
import sys
from collections import Counter

SENT_END = set(".?!:;。？！：；")


def body_size(lines, meta):
    per_page = {}
    for i, l in enumerate(lines):
        if i >= len(meta):
            break
        _, sz10, pg = meta[i]
        if sz10 <= 0 or len(l.strip()) <= 24:
            continue
        per_page.setdefault(pg, Counter())[round(sz10 / 10.0, 1)] += 1
    votes = Counter()
    for pg, c in per_page.items():
        votes[c.most_common(1)[0][0]] += 1
    return votes.most_common(1)[0][0] if votes else 0.0


def health(path):
    with io.open(path, encoding="utf-8") as f:
        d = json.load(f)
    text = d["text"]
    lines = text.split("\n")
    meta = d["meta"]["lines"]
    fonts = d["meta"]["fonts"]
    body = body_size(lines, meta)

    # 只看正文行（字号≈正文 且 足够长）
    prose = []
    for i, l in enumerate(lines):
        if i >= len(meta):
            break
        t = l.strip()
        if not t:
            continue
        fi, sz10, pg = meta[i]
        sz = sz10 / 10.0
        if body > 0 and abs(sz - body) > 0.35:
            continue
        if len(t) <= 80:
            continue
        prose.append(t)

    if not prose:
        return {"n": 0}

    lens = sorted(len(t) for t in prose)
    med = lens[len(lens) // 2]
    p10 = lens[max(0, len(lens) // 10)]

    # 有多少"段落"看起来是被切断的（结尾不是句末标点）
    broken = sum(1 for t in prose if t and t[-1] not in SENT_END)
    return {
        "n": len(prose),
        "median": med,
        "p10": p10,
        "broken": broken,
        "broken_pct": round(100.0 * broken / len(prose), 1),
    }


def main():
    # ⚠️ 允许显式传文件（排查单篇用）。
    #    不传则扫描 tools/smoke 下的全部 _font_*.json 夹具。
    if len(sys.argv) > 1:
        files = sys.argv[1:]
    else:
        d = "tools/smoke"
        files = [os.path.join(d, f) for f in sorted(os.listdir(d))
                 if f.startswith("_font_") and f.endswith(".json")]

    print("%-44s %-6s %-8s %-8s %-13s %s" % (
        "fixture", "paras", "median", "p10", "unterminated", "verdict"
    ))
    print("-" * 96)
    for path in files:
        s = health(path)
        name = os.path.basename(path)
        if not s.get("n"):
            print("%-44s  (no prose found)" % name)
            continue
        # 判据：正文段落中位数 >= 180 且 未终止率 < 20% 视为健康
        ok = s["median"] >= 180 and s["broken_pct"] < 20
        print("%-44s %-6d %-8d %-8d %-13s %s" % (
            name[:42], s["n"], s["median"], s["p10"],
            f'{s["broken_pct"]}%',
            "OK" if ok else "NEEDS WORK",
        ))


if __name__ == "__main__":
    main()
