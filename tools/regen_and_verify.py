"""
用修正后的规则重新生成夹具，并对**更多论文**做批量验证。

⚠️ 为什么要重新生成（不是新增）：旧的 _font_*.json 是用**有 bug 的规则**
   生成的（tools/make_font_fixture.py 旧版里 SHORT=60 的那个），
   拿它验证新规则等于"用 bug 衡量 bug"。
   详见 /memories/repo/pdf-extract.md。

用法：
    python tools/regen_and_verify.py            # 重新生成 4 篇 + 报告
    python tools/regen_and_verify.py --wide 20  # 额外抽 20 篇做泛化验证
"""
import io
import json
import os
import re
import subprocess
import sys
from collections import Counter

ROOT = r"C:\Users\zwc20\OneDrive\论文"

# 由 _font_*.json 里的 source 字段反查原始 PDF 的路径
SOURCES = {
    2015: "2015_深度学习里程碑综述_Nature_LeCun.pdf",
    2016: "2016_残差连接提出_CVPR_He.pdf",
    2017: "2017_Transformer提出纯注意力模型_NIPS_Vaswani.pdf",
    2022: "2022_LLM思维链提出_NIPS_Wei.pdf",
}


def find_all(root):
    out = []
    for dp, dn, fn in os.walk(root):
        for f in fn:
            if f.lower().endswith(".pdf"):
                out.append(os.path.join(dp, f))
    return out


def analyze(fixture_path):
    """跑一遍新规则，输出健康度指标。"""
    with io.open(fixture_path, encoding="utf-8") as f:
        d = json.load(f)
    text = d["text"]
    meta = d["meta"]["lines"]
    fonts = d["meta"]["fonts"]
    lines = text.split("\n")

    # 正文字号（页级众数再投票，与新版一致）
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
    body = votes.most_common(1)[0][0] if votes else 0.0

    # 统计：标题候选 / 段落长度分布
    heads = 0
    plens = []
    tiny = 0
    for i, l in enumerate(lines):
        if i >= len(meta):
            break
        t = l.strip()
        if not t:
            continue
        fi, sz10, pg = meta[i]
        sz = sz10 / 10.0
        fn = fonts[fi] if 0 <= fi < len(fonts) else ""
        # 字号远小于正文的是图表刻度/脚注，不算正文（见生成器 MIN_BODY_RATIO）
        if body > 0 and sz < body * 0.75:
            tiny += 1
            continue
        bold = any(k in fn.lower() for k in ("bold", "black", "heavy", "medi", "cbx", "cbb"))
        if (body > 0 and sz > body + 0.35) or (bold and len(t) <= 90):
            heads += 1
        else:
            plens.append(len(t))

    med = sorted(plens)[len(plens) // 2] if plens else 0
    short = sum(1 for n in plens if n < 40)
    return {
        "lines": len(lines),
        "body": body,
        "heads": heads,
        "paras": len(plens),
        "median": med,
        "short_pct": round(100.0 * short / max(1, len(plens)), 1),
        "tiny": tiny,
        "lig": sum(text.count(c) for c in "\ufb00\ufb01\ufb02\ufb03\ufb04"),
        "hyphen_break": len(re.findall(r"\w- \w", text)),
    }


def main():
    wide = 0
    if "--wide" in sys.argv:
        i = sys.argv.index("--wide")
        wide = int(sys.argv[i + 1]) if i + 1 < len(sys.argv) else 10

    all_pdfs = find_all(ROOT)

    # ---- 第一步：重新生成 4 篇原始夹具 ---------------------------------
    print("=" * 78)
    print("STEP 1  用修正后的规则重新生成 4 篇原始夹具")
    print("=" * 78)
    for year, name in SOURCES.items():
        hit = [p for p in all_pdfs if os.path.basename(p) == name]
        if not hit:
            print(f"  !! 找不到 {name}")
            continue
        r = subprocess.run(
            [sys.executable, "tools/make_font_fixture.py", hit[0]],
            capture_output=True, text=True, encoding="utf-8",
        )
        if r.returncode != 0:
            print(f"  !! 生成失败 {name}")
            print(r.stdout[-800:], r.stderr[-800:])
            continue
        print(f"  {year} OK")

    # ---- 第二步：报告新夹具的健康度 -----------------------------------
    print()
    print("=" * 78)
    print("STEP 2  新夹具健康度（重新生成后）")
    print("=" * 78)
    print("%-8s %-6s %-7s %-7s %-7s %-8s %-7s %-6s %s" % (
        "fixture", "lines", "body", "heads", "paras", "median", "short%", "tiny", "lig/hyphen"
    ))
    print("-" * 84)
    for year in SOURCES:
        p = f"tools/smoke/_font_{year}.json"
        if not os.path.isfile(p):
            continue
        s = analyze(p)
        print("%-8s %-6d %-7s %-7d %-7d %-8d %-7s %-6d %d/%d" % (
            year, s["lines"], s["body"], s["heads"], s["paras"],
            s["median"], s["short_pct"], s["tiny"], s["lig"], s["hyphen_break"]
        ))

    # ---- 第三步：泛化验证（可选，抽更多论文）--------------------------
    if wide > 0:
        print()
        print("=" * 78)
        print(f"STEP 3  泛化验证：随机抽 {wide} 篇其他论文")
        print("=" * 78)
        import random
        random.seed(20260924)
        pool = [p for p in all_pdfs
                if os.path.basename(p) not in SOURCES.values()
                and os.path.getsize(p) < 6 * 1024 * 1024]
        sample = random.sample(pool, min(wide, len(pool)))
        print("%-46s %-5s %-6s %-6s %-7s %-5s" % (
            "file", "lines", "body", "heads", "median", "short%"
        ))
        print("-" * 78)
        for p in sample:
            tmp = "tools/smoke/_wide_tmp.json"
            r = subprocess.run(
                [sys.executable, "tools/make_font_fixture.py", p, tmp],
                capture_output=True, text=True, encoding="utf-8",
            )
            if r.returncode != 0 or not os.path.isfile(tmp):
                print("%-46s  !! parse failed" % os.path.basename(p)[:44])
                continue
            s = analyze(tmp)
            print("%-46s %-5d %-6s %-6d %-7d %-5s" % (
                os.path.basename(p)[:44], s["lines"], s["body"],
                s["heads"], s["median"], s["short_pct"]
            ))
            os.remove(tmp)


if __name__ == "__main__":
    main()
