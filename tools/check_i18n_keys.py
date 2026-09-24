"""检查 i18n.js 的语言键对称性。

用途：本项目有两个语言块（en / zh），键必须成对出现。
      只加一种语言的话，另一种语言下会显示**原始键名**（如
      `reader.typeText`），比缺文案更糟 —— 用户看到的是一串标识符。

用法: python tools/check_i18n_keys.py
"""
import io
import os
import re
import sys
from collections import Counter

PATH = os.path.join("app", "src", "main", "assets", "www", "i18n.js")


def main():
    if not os.path.isfile(PATH):
        print("找不到 %s（要在项目根目录运行）" % PATH)
        return 1

    src = io.open(PATH, encoding="utf-8").read()

    # 只匹配「行首缩进 + 单引号键 + 冒号」这种键定义形态，
    # 避免把注释里的 `reader.foo` 也算进来。
    keys = re.findall(r"^\s*'([A-Za-z][A-Za-z0-9._]*)':", src, re.M)
    counts = Counter(keys)

    problems = []

    # ① 数量为奇数的键 = 只加了一种语言
    for k, v in sorted(counts.items()):
        if v % 2 != 0:
            problems.append("键 `%s` 只出现 %d 次（应为偶数，两种语言各一次）" % (k, v))

    # ② 重复定义的键（同一语言里写了两遍，后者会静默覆盖前者）
    for k, v in sorted(counts.items()):
        if v > 2 and v % 2 == 0:
            problems.append("键 `%s` 出现 %d 次（疑似重复定义）" % (k, v))

    # ③ 值里出现原始键名特征（说明某处漏了翻译，直接抄了键）
    #    只查形如 'x.y': 'x.y' 或值以 reader./action./setting. 开头的
    for m in re.finditer(r"^\s*'([A-Za-z][A-Za-z0-9._]*)':\s*'([^']*)'", src, re.M):
        k, val = m.group(1), m.group(2)
        if val and re.match(r"^(reader|action|setting|vault|explore|profile)\.", val):
            problems.append("键 `%s` 的值看起来还是键名：`%s`" % (k, val))

    if problems:
        for p in problems:
            print("  " + p)
        print("\n共 %d 个问题" % len(problems))
        return 1

    print("OK: %d 个键，双语对称" % len(counts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
