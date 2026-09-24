"""拉取 Material Symbols 官方 SVG 的 `<path d="...">`。

⚠️ 为什么写成文件而不是在终端里直接贴命令：
   PowerShell 里多行命令 paste 会进 `>>` 续行提示符卡住（踩过多次）。
   本项目的一贯做法：需要脚本就写成文件再执行。

⚠️ 为什么不用 fetch_webpage：它会把 SVG 当**图片**渲染，看不到路径文本。

用法：
    python tools/fetch_icon.py visibility
"""
import re
import sys
import urllib.request

BASE = (
    "https://raw.githubusercontent.com/google/material-design-icons/master/"
    "symbols/web/{name}/materialsymbolsoutlined/{name}{suffix}_24px.svg"
)
# 变体：默认（无后缀）与 fill1（填充版）
VARIANTS = ["", "_fill1"]


def fetch(url):
    with urllib.request.urlopen(url, timeout=25) as r:
        return r.read().decode("utf-8")


def main():
    if len(sys.argv) < 2:
        print("用法: python tools/fetch_icon.py <icon-name>")
        return 1
    name = sys.argv[1]
    for suffix in VARIANTS:
        url = BASE.format(name=name, suffix=suffix)
        label = "(filled)" if suffix else "(outlined default)"
        try:
            svg = fetch(url)
        except Exception as e:                                  # noqa: BLE001
            print(f"--- {name} {label}: FAILED {e}")
            continue
        vb = re.search(r'viewBox="([^"]+)"', svg)
        paths = re.findall(r'<path[^>]*\sd="([^"]+)"', svg)
        print(f"--- {name} {label}")
        print(f"    viewBox: {vb.group(1) if vb else '(none)'}")
        for p in paths:
            print(f"    path: {p}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
