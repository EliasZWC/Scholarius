"""定位括号不匹配的具体行（配合 check_kotlin_structure.py 使用）。

用法: python tools/_depth_trace.py <file.kt> [起始行] [结束行]
      打印指定区间内每行的「行前深度 / 行后深度」，
      深度突然变小的地方就是多了一个 `}`。
"""
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_kotlin_structure import strip_code  # noqa: E402


def main():
    path = sys.argv[1]
    lo = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    hi = int(sys.argv[3]) if len(sys.argv) > 3 else 10 ** 9

    with io.open(path, encoding="utf-8") as f:
        src = f.read()
    code = strip_code(src)
    clean = code.split("\n")
    raw = src.split("\n")

    depth = 0
    for i in range(len(clean)):
        before = depth
        depth += clean[i].count("{") - clean[i].count("}")
        line_no = i + 1
        if line_no < lo or line_no > hi:
            continue
        flag = ""
        if depth < before:
            flag = "  <<< 减少"
        if "{" in raw[i] or "}" in raw[i]:
            print("%5d  %2d -> %2d%s  %s" % (line_no, before, depth, flag,
                                             raw[i].rstrip()[:90]))
    print("最终深度 = %d" % depth)


if __name__ == "__main__":
    main()
