# -*- coding: utf-8 -*-
"""审计 components.js 里的图标表：找出漏登记 viewBox 的 960 体系图标。

事故背景（2026-09-25）：`add` / `trash` 加进 ICON_PATHS 时漏了
ICON_VIEWBOX，于是 viewBox 落到默认 0 0 24 24，而路径是 960 体系的
（y ∈ [-960, 0]）→ 图形整体在视口外 → inkPixels = 0，一个像素都不渲染。

这个脚本就是防这一类漏登记。本机无 JDK 也能跑。
"""
import io
import re
import sys

SRC = 'app/src/main/assets/www/components.js'


def block(src, var):
    m = re.search(r'var ' + var + r' = \{(.*?)\n    \};', src, re.S)
    return m.group(1) if m else ''


def names(body):
    return set(re.findall(r'^\s{8}([a-zA-Z]+):', body, re.M))


def paths_map(body):
    """名字 -> 路径字符串"""
    out = {}
    for m in re.finditer(r"^\s{8}([a-zA-Z]+): '([^']*)'", body, re.M):
        out[m.group(1)] = m.group(2)
    return out


def looks_like_symbols(d):
    """判断路径是否属于 Material Symbols 的 960 体系。

    ⚠️ 判据必须收紧到"**无小数点的整数且 >= 100**"。

       不能只看"出现过 3 位以上数字" —— 那会把 24 体系误判：
       `refresh` 的路径里有 `7.958`、`-2.35`，含 3 位数字但**带小数点**，
       它是正经的 24 体系。第一版判据因此报了一条假阳性。

       24 体系：坐标全在 0~24，常见三位是小数（7.958）
       960 体系：坐标是 -960~960 的整数（480、-520、120）

       所以：**整数 + >= 100** 才是 960 体系的可靠特征。
    """
    return bool(re.search(r'(?<![\d.])-?\d{3,}(?![\d.])', d))


def main():
    src = io.open(SRC, encoding='utf-8').read()
    pb = block(src, 'ICON_PATHS')
    fb = block(src, 'ICON_PATHS_FILL')
    vb = block(src, 'ICON_VIEWBOX')

    p = paths_map(pb)
    f = paths_map(fb)
    registered = names(vb)

    problems = []

    # 1. 登记了 viewBox 但 ICON_PATHS 里没有 -> 悬空登记
    for n in sorted(registered - set(p)):
        problems.append('悬空登记：ICON_VIEWBOX 有 `%s`，但 ICON_PATHS 里没有' % n)

    # 2. 路径像 960 体系但没登记 viewBox -> 会渲染不出来
    for n in sorted(set(p) - registered):
        if looks_like_symbols(p[n]):
            problems.append(
                '⚠️ 未登记 viewBox：`%s` 的路径像 960 体系（含 3 位以上数字），'
                '但不在 ICON_VIEWBOX 里 -> viewBox 会落到 0 0 24 24，'
                '图形落在视口外，**一个像素都不渲染**' % n)

    # 3. 填充表里的名字必须也在 ICON_PATHS 里（否则 iconPathFilled 回退不到）
    for n in sorted(set(f) - set(p)):
        problems.append('填充表多余：ICON_PATHS_FILL 有 `%s`，但 ICON_PATHS 里没有' % n)

    # 4. 填充表的 viewBox 也要登记（iconFilled 用的是同一张表）
    for n in sorted(set(f) - registered):
        if looks_like_symbols(f[n]):
            problems.append('⚠️ 未登记 viewBox（填充版）：`%s`' % n)

    print('ICON_PATHS        : %d 个' % len(p))
    print('ICON_PATHS_FILL   : %d 个' % len(f))
    print('ICON_VIEWBOX 登记 : %d 个' % len(registered))
    print()

    if problems:
        for x in problems:
            print(x)
        print()
        print('共 %d 个问题' % len(problems))
        return 1

    print('OK: 图标表一致，没有漏登记 viewBox')
    return 0


if __name__ == '__main__':
    sys.exit(main())
