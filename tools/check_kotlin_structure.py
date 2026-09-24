"""Kotlin 源码结构自查（本机无 JDK，只能这样提前发现问题）。

检查三件事：
  ① 每个 `private fun` / `private val` 声明处的**括号深度是否合理**
     （应在 object 内 = 1；嵌套的本地函数允许 2）。
     深度异常 = 有未闭合的块，CI 会报一堆 "Unresolved reference"。
  ② 同一作用域内**重复的局部声明**（CI 报 "Conflicting declarations"）。
  ③ 顶层花括号最终是否闭合。

⚠️ 为什么需要它（2026-09-24 的教训）：
   我两次因为编辑工具吞掉 `}` 而推了会编译失败的提交，
   CI 一轮要 3 分钟 —— 这个脚本 0.1 秒就能查出来。

用法: python tools/check_kotlin_structure.py [文件...]
      不传参数则检查 app/src/main/java/com/eliaszwc/scholarius/*.kt
"""
import io
import glob
import os
import re
import sys
from collections import Counter


def strip_code(src):
    ''''把 Kotlin 源码里的**注释和字符串内容**剥掉，只留下「结构字符」。

    ⚠️ 必须**逐字符**扫描，不能按行。
       Kotlin 的三引号字符串（连续三个双引号）可以跨行，里面能出现
       `{`、`}`、`//`、`/*`，按行处理会把它们当成真代码。
       （第一版按行剥离，于是 PdfText.kt 的注释里写了 "{" 就把深度顶到 4，
         满屏假警报 —— 一个都不能信，比没有还糟。）

    返回等长字符串：被剥掉的位置换成空格，保留换行以便报行号。
    '''
    out = []
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        # 行注释
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                out.append(" ")
                i += 1
            continue
        # 块注释（Kotlin 允许嵌套）
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            depth_c = 1
            out.append(" ")
            out.append(" ")
            i += 2
            while i < n and depth_c > 0:
                if src[i] == "/" and i + 1 < n and src[i + 1] == "*":
                    depth_c += 1
                    out.append(" ")
                    out.append(" ")
                    i += 2
                    continue
                if src[i] == "*" and i + 1 < n and src[i + 1] == "/":
                    depth_c -= 1
                    out.append(" ")
                    out.append(" ")
                    i += 2
                    continue
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            continue
        # 字符字面量 'x' —— **必须剥掉**。
        # Kotlin 里 sb.append('{') / sb.append('}') 是**字符**，不是代码结构。
        # 不剥的话每出现一次就凭空多/少一层深度
        # （本项目实测差 2 层，全由 '}' 与 '{' 字符字面量造成）。
        if ch == "'":
            out.append(" ")
            i += 1
            while i < n:
                c = src[i]
                if c == "\\":
                    out.append(" ")
                    i += 1
                    if i < n:
                        out.append("\n" if src[i] == "\n" else " ")
                        i += 1
                    continue
                if c == "'":
                    out.append(" ")
                    i += 1
                    break
                if c == "\n":
                    break
                out.append(" ")
                i += 1
            continue
        # 三引号原始字符串
        if ch == '"' and src.startswith('"""', i):
            out.append("   ")
            i += 3
            while i < n and not src.startswith('"""', i):
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            if i < n:
                out.append("   ")
                i += 3
            continue
        # 普通字符串（可含 ${...}，里面是真代码）
        if ch == '"':
            out.append(" ")
            i += 1
            while i < n:
                c = src[i]
                if c == "\\":
                    out.append(" ")
                    i += 1
                    if i < n:
                        out.append("\n" if src[i] == "\n" else " ")
                        i += 1
                    continue
                if c == "$" and i + 1 < n and src[i + 1] == "{":
                    # 模板表达式：内部是代码，原样保留（含大括号配对）
                    out.append("${")
                    i += 2
                    d = 1
                    while i < n and d > 0:
                        if src[i] == "{":
                            d += 1
                        elif src[i] == "}":
                            d -= 1
                        out.append(src[i])
                        i += 1
                    continue
                if c == "\n":
                    # 未闭合的字符串（跨行写法少见），保险起见停止
                    out.append("\n")
                    i += 1
                    break
                if c == '"':
                    out.append(" ")
                    i += 1
                    break
                out.append(" ")
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def analyse(path):
    with io.open(path, encoding="utf-8") as f:
        src = f.read()

    problems = []
    code = strip_code(src)

    # 用来报行号：把「结构字符」切回按行
    clean_lines = code.split("\n")
    raw_lines = src.split("\n")

    # ① 括号深度
    depth = 0
    for i, s in enumerate(clean_lines, 1):
        stripped = raw_lines[i - 1].strip()
        if stripped.startswith(("private fun", "private const val", "private val",
                                "fun ", "data class", "private class",
                                "internal fun", "internal val")):
            if depth > 2:
                problems.append(
                    "line %d: depth=%d 异常（应为 1 或 2）: %s"
                    % (i, depth, stripped[:60]))
        depth += s.count("{") - s.count("}")

    # ② 重复的局部声明
    scopes = []
    cur = None
    for i, raw in enumerate(raw_lines, 1):
        stripped = raw.strip()
        if re.match(r"^    (private |internal )?(fun|class|object|data class|companion|val|const val)\b",
                    raw):
            if cur is not None:
                scopes.append(cur)
            cur = {"line": i, "vals": []}
        elif cur is not None:
            m = re.match(r"^        (?:private )?(?:const )?(val|var) ([A-Za-z0-9_]+)", raw)
            if m:
                cur["vals"].append(m.group(2))
    if cur is not None:
        scopes.append(cur)

    for sc in scopes:
        c = Counter(sc["vals"])
        for k, v in c.items():
            if v > 1:
                problems.append("line %d: 局部变量 `%s` 重复声明 %d 次"
                                % (sc["line"], k, v))

    return depth, problems


def main():
    if len(sys.argv) > 1:
        files = sys.argv[1:]
    else:
        files = sorted(glob.glob("app/src/main/java/com/eliaszwc/scholarius/*.kt"))

    bad = 0
    for path in files:
        depth, problems = analyse(path)
        name = os.path.basename(path)
        if problems:
            bad += 1
            print("== %s ==" % name)
            for p in problems[:20]:
                print("   " + p)
        if depth != 0:
            bad += 1
            print("== %s == 最终括号深度 %d（应为 0）" % (name, depth))

    if bad == 0:
        print("OK: %d 个文件结构正常" % len(files))


if __name__ == "__main__":
    main()
