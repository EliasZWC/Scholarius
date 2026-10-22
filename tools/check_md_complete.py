# -*- coding: utf-8 -*-
"""审计：PDF 提取的正文 → doc.md，**一个字都不能少**（v0.1.92）。

用法：
    python tools/check_md_complete.py <doc.md> [blocks.json]

blocks.json 由
    python tools/emu_js.py "return JSON.stringify(window.ScholariusReader.getBlocks())"
生成（含 {line, kind, text, lines}）。

════ ⚠️ 比对口径 ════

md 里有三种"非正文"字符：
  ① 记号：行首的 `#` / `- ` / `1. `
  ② 注释：`<!--@a:0-22=name-->`
  ③ 结构空白：块之间的空行

把这些剥掉之后，剩下的**必须是原文的逐字内容**（只允许空白差异）。
"""
import json
import re
import sys


MARK_RE = re.compile(r'^[ \t]*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)', re.MULTILINE)
COMMENT_RE = re.compile(r'<!--@[^>]*-->')
WS_RE = re.compile(r'\s+')


def squash(s):
    """去掉所有空白 —— 用来比对"字"是否齐全。

    ⚠️ 不区分空白是因为 md 允许调整换行/空行；
       丢字才是真正的问题。
    """
    return WS_RE.sub('', s)


def main():
    if len(sys.argv) < 2:
        print('用法: python tools/check_md_complete.py <doc.md> [blocks.json]')
        return 2

    md = open(sys.argv[1], encoding='utf-8-sig').read()

    stripped = COMMENT_RE.sub('', md)
    stripped = MARK_RE.sub('', stripped)

    if len(sys.argv) >= 3:
        # ⚠️ `utf-8-sig` 而不是 `utf-8`：PowerShell 的 `Out-File -Encoding utf8`
        #    会写 BOM，用 `utf-8` 读会抛 "Unexpected UTF-8 BOM"。
        blocks = json.load(open(sys.argv[2], encoding='utf-8-sig'))
        src = ''.join(b.get('text') or '' for b in blocks)
    else:
        print('⚠️ 未提供 blocks.json → 只做格式检查，不做丢字比对')
        src = None

    dst = squash(stripped)

    ok = True
    if src is not None:
        a, b = squash(src), dst
        if a == b:
            print('OK   正文逐字一致（%d 字）' % len(a))
        else:
            ok = False
            print('FAIL 正文不一致：源 %d 字 / md %d 字' % (len(a), len(b)))
            # 找出第一处差异
            n = min(len(a), len(b))
            i = 0
            while i < n and a[i] == b[i]:
                i += 1
            print('  第一处差异在第 %d 字' % i)
            print('  源: ...%r' % a[max(0, i - 40):i + 40])
            print('  md: ...%r' % b[max(0, i - 40):i + 40])
            # 缺失的字符
            if len(a) > len(b):
                print('  ⚠️ md 比源少 %d 字' % (len(a) - len(b)))

    # ② 残留的 markdown 记号必须在行首（不能出现在正文中间）
    bad_marks = []
    for ln, line in enumerate(stripped.split('\n'), 1):
        if re.search(r'(?<!^)\s#{1,6}\s', line):
            bad_marks.append((ln, line[:60]))
    if bad_marks:
        print('⚠️ 正文中间出现 `#` 记号 %d 处' % len(bad_marks))
        for ln, s in bad_marks[:3]:
            print('   L%d: %s' % (ln, s))
    else:
        print('OK   正文中间没有残留记号')

    # ③ 标点后缺空格（与 check_punct_space.py 同一判据）
    #
    # ⚠️ 缩写是**高频误报**：`A.C. Popat` / `F.J. Och` / `J. Dean` / `i.e.`
    #    这类点号后面本来就紧跟字母，缺的不是空格而是"这个人名就是这么写的"。
    #    判据：点号**前面**是单个大写字母、且**后面**也是单个大写字母 + 点
    #    （`A.C.` 的形态）→ 跳过。
    re_p = re.compile(r'[.,;:?!)\]}][A-Za-z0-9]')
    sus = []
    for m in re_p.finditer(stripped):
        tail = stripped[m.start():]
        if re.match(r'^\.[0-9]+(\s|$)', tail):
            continue  # 章节号 2.1 / 小数 1.5
        head = stripped[max(0, m.start() - 3):m.start()]
        # 缩写形态：`X.` 或 `X.Y.`（单字母 + 点，可重复）
        if re.search(r'(?<![A-Za-z])[A-Za-z]\.[A-Za-z]\.$', head + stripped[m.start()]):
            continue
        if re.fullmatch(r'[A-Za-z]\.$', head + stripped[m.start()]):
            continue
        sus.append(stripped[max(0, m.start() - 20):m.start() + 20])
    real = [s for s in sus
            if not re.search(r'(e\.g\.|i\.e\.|et al\.|vs\.|\d\.\d|[A-Z]\.)', s)]
    if real:
        print('⚠️ 标点后缺空格 %d 处' % len(real))
        for s in real[:5]:
            print('   %r' % s)
    else:
        print('OK   标点后空格正常')

    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
