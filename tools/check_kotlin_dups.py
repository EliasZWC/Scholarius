"""检查 Kotlin 文件里是否有**重复的局部声明**（同一函数内同名 val）。

CI 报 "Conflicting declarations" 就是这类问题 ——
本地没有 JDK 发现不了，所以用这个脚本自查。

做法：按函数作用域分组（用缩进 4 空格的 `private fun` 当边界），
     收集缩进 8 空格及更深的 `val x` / `var x`，查同名。

用法: python tools/check_kotlin_dups.py app/src/main/java/.../PdfText.kt
"""
import io
import re
import sys
from collections import Counter

path = sys.argv[1]
with io.open(path, encoding="utf-8") as f:
    lines = f.read().split("\n")

# 找函数边界（缩进 4 空格的 fun/class/object 声明）
boundaries = []
for i, l in enumerate(lines):
    if re.match(r"^    (private |internal )?(fun|class|object|data class|companion|val|const val)\b", l):
        boundaries.append(i)

problems = 0
for bi, start in enumerate(boundaries):
    end = boundaries[bi + 1] if bi + 1 < len(boundaries) else len(lines)
    # 收集这个作用域内的局部 val/var（缩进 >= 8）
    vals = []
    for j in range(start + 1, end):
        m = re.match(r"^        (val|var) ([A-Za-z0-9_]+)", lines[j])
        if m:
            vals.append(m.group(2))
    c = Counter(vals)
    dups = {k: v for k, v in c.items() if v > 1}
    if dups:
        problems += 1
        print("!! 重复声明 at line %d: %s" % (start + 1, lines[start].strip()[:66]))
        for k, v in dups.items():
            print("     %s x%d" % (k, v))

if problems == 0:
    print("OK: 没有重复的局部声明")
