"""生成「分段线性渐变」SVG。

接缝方案（v2，修掉圆头鼓出）：
  折点处如果让后段的 round cap 覆盖过去，圆头会在折点**外侧**鼓出一块方角。
  正确做法：后段从折点**起笔、不延长**，折点的圆角**由前段的 round cap 单独提供**；
  后段段首再加一个**平头短延伸**（butt cap 不受 linecap 影响？—— 受影响，
  所以改用「后段起点反推到折点、颜色取折点色」的方式）。

  实际上是：后段起点 = 折点本身，颜色 = 折点色；前段终点 = 折点，颜色 = 折点色。
  两段在折点处颜色相同 → 视觉连续；圆角由前段的 round cap 提供；
  后段起点也是 round cap，圆心正好在折点上，与前段 cap 完全重合，不鼓出。
"""
import math

SW = 4.67

A = (70.665, 37.335)
B = (37.335, 37.335)
C = (54.000, 54.000)
D = (37.335, 70.665)
E = (61.325, 70.665)
pts = [A, B, C, D, E]

segs = [math.dist(pts[i], pts[i + 1]) for i in range(4)]
drawn = sum(segs)


def col(g):
    v = round(255 + (110 - 255) * max(0.0, min(1.0, g)))
    return f'#{v:02X}{v:02X}{v:02X}'


cum = 0.0
seg_data = []
for i in range(4):
    seg_data.append((pts[i], pts[i + 1], cum / drawn, (cum + segs[i]) / drawn))
    cum += segs[i]

lines = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" '
    'width="216" height="216">',
    '  <defs>',
]
for i, (a, b, g0, g1) in enumerate(seg_data):
    lines.append(
        f'    <linearGradient id="g{i}" gradientUnits="userSpaceOnUse" '
        f'x1="{a[0]:.4f}" y1="{a[1]:.4f}" x2="{b[0]:.4f}" y2="{b[1]:.4f}">'
        f'<stop offset="0" stop-color="{col(g0)}"/>'
        f'<stop offset="1" stop-color="{col(g1)}"/></linearGradient>')
lines += ['  </defs>', '  <rect width="108" height="108" fill="#1B1B1B"/>']
for i, (a, b, g0, g1) in enumerate(seg_data):
    lines.append(
        f'  <path d="M{a[0]:.4f},{a[1]:.4f} L{b[0]:.4f},{b[1]:.4f}" '
        f'stroke="url(#g{i})" stroke-width="{SW}" '
        f'stroke-linecap="round" fill="none"/>')
lines.append(f'  <path d="M70.665,37.335 L70.665,46.000" stroke="#FFFFFF" '
             f'stroke-width="{SW}" stroke-linecap="round" fill="none"/>')
lines.append(f'  <path d="M70.665,70.665 L70.665,62.000" stroke="#6E6E6E" '
             f'stroke-width="{SW}" stroke-linecap="round" fill="none"/>')
lines.append('</svg>')

with open('../assets/_test_segmented.svg', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print('各段（端点即折点，不延长）：')
for i, (a, b, g0, g1) in enumerate(seg_data):
    print(f'  段{i + 1} ({a[0]:8.4f},{a[1]:8.4f}) -> ({b[0]:8.4f},{b[1]:8.4f})  '
          f'{col(g0)} -> {col(g1)}')
