"""终检：按「定稿规格(弧长渐变)」与「我的实现(4 段线性渐变)」各自
用同一个光栅器渲染，逐像素比对。

不依赖浏览器/截图，避免 devicePixelRatio 与 LANCZOS 的干扰。
两边都用自己的 PIL 光栅化路径：
  · 定稿  = gen_assets4.draw_sigma(38, 4.67, 'arc', 'far', 'seg', 'seg')
  · 我的  = 4 段各自线性渐变，round cap，共享折点
"""
import math
import sys

sys.path.insert(0, 'tools') if False else None
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'tools'))

from PIL import Image, ImageDraw
import numpy as np

from gen_assets4 import draw_sigma, SS, BG

SW = 4.67
HALF = SW / 2
WHITE, DARK = 255, 110

A = (70.665, 37.335)
B = (37.335, 37.335)
C = (54.000, 54.000)
D = (37.335, 70.665)
E = (61.325, 70.665)
pts = [A, B, C, D, E]
segs = [math.dist(pts[i], pts[i + 1]) for i in range(4)]
drawn = sum(segs)


def col(g):
    v = round(WHITE + (DARK - WHITE) * max(0.0, min(1.0, g)))
    return (v, v, v)


# ---------- ① 定稿 ----------
ref = draw_sigma(38, SW, 'arc', 'far', 'seg', 'seg')
ref = ref.convert('RGB')
print('定稿渲染尺寸', ref.size)


# ---------- ② 我的实现 ----------
S = ref.size[0]
mine = Image.new('RGB', (S, S), BG)


def draw_seg(p0, p1, c0, c1):
    """一条线性渐变线段，round cap，逐像素填色（步进 0.05 视口单位）"""
    L = math.dist(p0, p1)
    ux, uy = (p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L
    n = max(2, int(L / 0.05))
    r = HALF * SS
    d = ImageDraw.Draw(mine)
    for i in range(n + 1):
        t = i / n
        cx, cy = p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t
        c = tuple(round(c0[k] + (c1[k] - c0[k]) * t) for k in range(3))
        d.ellipse([cx * SS - r, cy * SS - r, cx * SS + r, cy * SS + r], fill=c)


cum = 0.0
for i in range(4):
    g0, g1 = cum / drawn, (cum + segs[i]) / drawn
    draw_seg(pts[i], pts[i + 1], col(g0), col(g1))
    cum += segs[i]

# 端点短线（纯色）
d = ImageDraw.Draw(mine)
for (x0, y0), (x1, y1), c in [
    ((70.665, 37.335), (70.665, 46.000), (255, 255, 255)),
    ((70.665, 70.665), (70.665, 62.000), (110, 110, 110)),
]:
    L = math.dist((x0, y0), (x1, y1))
    n = max(2, int(L / 0.05))
    r = HALF * SS
    for i in range(n + 1):
        t = i / n
        cx, cy = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        d.ellipse([cx * SS - r, cy * SS - r, cx * SS + r, cy * SS + r], fill=c)

a = np.asarray(ref).astype(int)
b = np.asarray(mine).astype(int)
diff = np.abs(a - b).max(axis=2)

print()
print('=== 同一光栅器下：定稿(弧长) vs 我的(4段线性) ===')
print(f'平均像素差 : {diff.mean():.3f} / 255')
print(f'最大像素差 : {diff.max()}')
print(f'>48 的像素 : {(diff > 48).sum()} ({(diff > 48).mean() * 100:.4f}%)')
print(f'>16 的像素 : {(diff > 16).sum()} ({(diff > 16).mean() * 100:.4f}%)')

# 中心线点位
print()
print('点位         定稿         我的')
for nm, p in [('A 左上', A), ('段1中', ((A[0] + B[0]) / 2, A[1])), ('B 右上', B),
              ('段2中', ((B[0] + C[0]) / 2, (B[1] + C[1]) / 2)), ('C 中间', C),
              ('段3中', ((C[0] + D[0]) / 2, (C[1] + D[1]) / 2)), ('D 左下', D),
              ('段4中', ((D[0] + E[0]) / 2, D[1])), ('E 右下', E)]:
    px, py = int(round(p[0] * SS)), int(round(p[1] * SS))
    print(f'{nm:8s} {str(tuple(a[py, px])):18s} {tuple(b[py, px])}')

out = Image.new('RGB', (S // 2 * 2 + 12, S // 2), (60, 60, 60))
out.paste(ref.resize((S // 2, S // 2), Image.LANCZOS), (0, 0))
out.paste(mine.resize((S // 2, S // 2), Image.LANCZOS), (S // 2 + 12, 0))
out.save('assets/_AUDIT.png')
print()
print('对比图 assets/_AUDIT.png（左=定稿 右=我的实现）')
