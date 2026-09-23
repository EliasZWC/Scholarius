"""手工按路径几何算弧长占比（不依赖采样点折点检测）。

定稿路径（box=38, sw=4.67）：
    A (70.665, 37.335)   左上起点          <- 头部不截断，A 是真实起点
    B (37.335, 37.335)   右上折点
    C (54.000, 54.000)   中间折点
    D (37.335, 70.665)   左下折点
    E (61.325, 70.665)   右下终点（尾部截断 2*sw = 9.34 后）

颜色 = lerp(#FFFFFF, #6E6E6E, 累计弧长 / drawn_frac)，仅字形主体。
"""
import math

A = (70.665, 37.335)
B = (37.335, 37.335)
C = (54.000, 54.000)
D = (37.335, 70.665)
E = (61.325, 70.665)   # 原始终点 (70.665, 70.665) 截断 9.34 后

pts = [A, B, C, D, E]
names = ['A 左上起点', 'B 右上折点', 'C 中间折点', 'D 左下折点', 'E 右下终点(截断后)']

segs = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
drawn = sum(segs)

print('各段长度: ' + ', '.join(f'{s:.4f}' for s in segs))
print(f'drawn_frac(总弧长) = {drawn:.4f}')
print()

cum = 0.0
for i, (p, nm) in enumerate(zip(pts, names)):
    g = min(1.0, cum / drawn)
    v = round(255 + (110 - 255) * g)
    print(f'{nm:22s} ({p[0]:7.3f},{p[1]:7.3f})  '
          f'累计弧长={cum:7.3f}  占比={g:.4f}  #{v:02X}{v:02X}{v:02X}')
    if i < len(segs):
        cum += segs[i]

print()
print('--- 各段中点（用于插入中间 stop 逼近弧长渐变）---')
cum = 0.0
for i in range(len(segs)):
    mid = cum + segs[i] / 2
    cum += segs[i]
    g = min(1.0, mid / drawn)
    v = round(255 + (110 - 255) * g)
    p0, p1 = pts[i], pts[i + 1]
    mx, my = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    print(f'段{i + 1} {names[i]} -> {names[i + 1]:22s} '
          f'中点({mx:7.3f},{my:7.3f}) 占比={g:.4f}  #{v:02X}{v:02X}{v:02X}')

print()
print('--- 对照：我错用的对角线线性渐变 (35,35)->(73,73) ---')
x1, y1, x2, y2 = 35.0, 35.0, 73.0, 73.0
dx, dy = x2 - x1, y2 - y1
L2 = dx * dx + dy * dy
for p, nm in zip(pts, names):
    t = max(0.0, min(1.0, ((p[0] - x1) * dx + (p[1] - y1) * dy) / L2))
    v = round(255 + (110 - 255) * t)
    print(f'{nm:22s} 投影={t:.4f}  #{v:02X}{v:02X}{v:02X}')
