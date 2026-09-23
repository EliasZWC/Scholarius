"""验证「分段线性渐变」是否精确等价于定稿的「按累计弧长渐变」。

不渲染，直接按 SVG 语义算：
  对画布上每个像素，取它在「分段渐变」下得到的颜色，
  与定稿 colorize 在「弧长渐变」下给出的颜色逐点比较。

分段渐变语义（SVG linearGradient, userSpaceOnUse）：
  点在段 i 上的投影 t = clamp(dot(p - a_i, b_i - a_i) / |b_i - a_i|^2, 0, 1)
  颜色 = lerp(c_i0, c_i1, t)
  覆盖顺序：后段覆盖前段（段4 最上）
"""
import math

import numpy as np

SW = 4.67
HALF = SW / 2

A = (70.665, 37.335)
B = (37.335, 37.335)
C = (54.000, 54.000)
D = (37.335, 70.665)
E = (61.325, 70.665)

WHITE, DARK = 255.0, 110.0


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------- 定稿：按累计弧长 ----------------
pts = [A, B, C, D, E]
segs = [math.dist(pts[i], pts[i + 1]) for i in range(4)]
drawn = sum(segs)
print(f'定稿总弧长 drawn_frac = {drawn:.4f}')


def dist_to_seg(p, a, b):
    """点 p 到线段 ab 的距离，以及投影参数 t"""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2
    tc = max(0.0, min(1.0, t))
    cx, cy = ax + dx * tc, ay + dy * tc
    return math.hypot(p[0] - cx, p[1] - cy), t


def arc_color(p):
    """定稿：找最近路径点，取其累计弧长对应的颜色"""
    best = None
    cum = 0.0
    for i in range(4):
        a, b = pts[i], pts[i + 1]
        d, t = dist_to_seg(p, a, b)
        if best is None or d < best[0]:
            arc = cum + segs[i] * max(0.0, min(1.0, t))
            best = (d, arc)
        cum += segs[i]
    g = min(1.0, best[1] / drawn)
    return lerp(WHITE, DARK, g)


# ---------------- 我们的方案：分段线性渐变 ----------------
cum = 0.0
seg_meta = []
for i in range(4):
    p0, p1 = pts[i], pts[i + 1]
    g0, g1 = cum / drawn, (cum + segs[i]) / drawn
    L = segs[i]
    ux, uy = (p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L
    ext0 = 0.0 if i == 0 else HALF
    a = (p0[0] - ux * ext0, p0[1] - uy * ext0)
    slope = (g1 - g0) / L
    c0 = lerp(WHITE, DARK, g0 + slope * (-ext0))
    c1 = lerp(WHITE, DARK, g1)
    seg_meta.append((a, p1, c0, c1))
    cum += segs[i]


def seg_color(p):
    """分段渐变：后段覆盖前段"""
    result = None
    for (a, b, c0, c1) in seg_meta:          # 段1→段4，后者覆盖前者
        _, t = dist_to_seg(p, a, b)
        if 0.0 <= t <= 1.0:
            d, _ = dist_to_seg(p, a, b)
            if d <= SW / 2 + 1e-6:
                result = lerp(c0, c1, t)
    return result


# ---------------- 逐点比较 ----------------
# 沿路径密集采样（比较点落在笔画中心线上）
print()
print('=== 沿笔画中心线逐点比较（分段线性 vs 弧长）===')
worst = 0.0
worst_at = None
cum = 0.0
N = 40
for i in range(4):
    a, b = pts[i], pts[i + 1]
    for k in range(N + 1):
        f = k / N
        x = a[0] + (b[0] - a[0]) * f
        y = a[1] + (b[1] - a[1]) * f
        ref = arc_color((x, y))          # 定稿
        got = seg_color((x, y))          # 我们的
        if got is None:
            continue
        diff = abs(ref - got)
        if diff > worst:
            worst, worst_at = diff, (i + 1, round(f, 3), round(ref), round(got))

print(f'中心线上最大色差 = {worst:.2f} / 255  ({worst / 255 * 100:.2f}%)')
print(f'出现位置：段{worst_at[0]} 参数{worst_at[1]}  定稿{worst_at[2]} vs 分段{worst_at[3]}')
print()

# 折点单独检查
print('=== 折点颜色 ===')
for nm, p in [('A', A), ('B', B), ('C', C), ('D', D), ('E', E)]:
    ref, got = arc_color(p), seg_color(p)
    flag = 'OK ' if got is not None and abs(ref - got) < 2 else 'XX '
    print(f'  {flag}{nm}  定稿={ref:6.1f}  分段={got if got is None else round(got, 1)}')
