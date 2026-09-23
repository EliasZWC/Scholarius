"""
Σ / Livolog 预览资源 —— 修复「分段 line 造成裂缝」

上一版的问题：
  把折线切成很多**独立**的短 line 分别绘制。PIL 的 line 端点是方头，
  且抗锯齿覆盖率在段端会衰减 → 段与段之间出现 1px 的缝，表现为：
    · 圆环裂开成一节一节
    · 斜线断裂

正确做法（PIL 原生支持）：
  ImageDraw.line(seq, width=..., joint="curve")
    —— seq 是**整条路径的所有点**，一次性传入，
       joint="curve" 会在每个拐点自动补圆角接缝，绝不出现缝。

  渐变怎么办？
    把整条路径按小步长细分（点足够密），然后**按点分别上色**是做不到的
    （line 只能一个颜色）。
    所以采用：**分成若干组，每组是一条 joint="curve" 的连续折线**，
    组内颜色相同，组间的颜色按渐变取。
    —— 组与组的接缝处用「重叠一个点」消除缝隙。
    步长取足够小（≈ 0.1 线宽）后，颜色是阶梯状渐变的，肉眼看不出分段。

  圆环同理：把弧细分成若干组，每组一条 joint="curve" 的折线。
"""

import math
import os
from PIL import Image, ImageDraw

VO = 108
SS = 8
BG = (27, 27, 27)
WHITE = (255, 255, 255)
SEAM = (0x7C, 0x7C, 0x7C)
DARK = (0x6E, 0x6E, 0x6E)

OUTDIR = r"e:\product\Scholarius\design\assets"
PATH = [(1, 1), (-1, 1), (0, 0), (-1, -1), (1, -1)]


def lerp(c0, c1, k):
    k = max(0.0, min(1.0, k))
    return tuple(int(round(c0[i] + (c1[i] - c0[i]) * k)) for i in range(3))


def sweep_color(x, y, cx=54.0, cy=54.0):
    ang = math.degrees(math.atan2(y - cy, x - cx))
    if ang < 0:
        ang += 360
    o = ang / 360
    stops = [(0.0, SEAM), (0.75, WHITE), (0.9167, DARK), (1.0, SEAM)]
    for i in range(len(stops) - 1):
        o0, c0 = stops[i]
        o1, c1 = stops[i + 1]
        if o0 <= o <= o1:
            return lerp(c0, c1, (o - o0) / (o1 - o0) if o1 > o0 else 0)
    return WHITE


def new_canvas():
    S = VO * SS
    return Image.new("RGB", (S, S), BG), S


# ===========================================================================
#  Σ
# ===========================================================================
def sigma_samples(box, sw, step_viewport, cut_head=0.0, cut_tail=0.0):
    """沿整条折线均匀采样（视口坐标），返回 [(x, y, raw_progress), ...]

    cut_head / cut_tail: 从首端 / 末端截断的长度（视口单位）。
    截断在**采样之前**施加到路径端点上，这样生成的折线本身就是短的，
    不会出现「端点挪了但中间采样点还在原位」造成的横跨线段。

    raw_progress 以**未截断**路径的总长为基准，这样渐变不会因截断而整体偏移。
    """
    h = box / 2 - sw / 2
    P = [(54 + x * h, 54 - y * h) for x, y in PATH]
    lens_full = [math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1])
                 for i in range(len(P) - 1)]
    total = sum(lens_full)

    # 首端沿首段方向前进 cut_head；末段沿末段方向回退 cut_tail
    if cut_head > 0:
        L = lens_full[0]
        ux = (P[1][0] - P[0][0]) / L
        uy = (P[1][1] - P[0][1]) / L
        P[0] = (P[0][0] + ux * cut_head, P[0][1] + uy * cut_head)
    if cut_tail > 0:
        L = lens_full[-1]
        ux = (P[-1][0] - P[-2][0]) / L
        uy = (P[-1][1] - P[-2][1]) / L
        P[-1] = (P[-1][0] - ux * cut_tail, P[-1][1] - uy * cut_tail)

    lens = [math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1])
            for i in range(len(P) - 1)]

    acc, s = [], 0.0
    for L in lens:
        acc.append(s)
        s += L
    drawn = sum(lens)

    out = []
    for i in range(len(P) - 1):
        n = max(1, int(math.ceil(lens[i] / step_viewport)))
        for k in range(n + 1):
            t = k / n
            x = P[i][0] + (P[i + 1][0] - P[i][0]) * t
            y = P[i][1] + (P[i + 1][1] - P[i][1]) * t
            raw = (acc[i] + lens[i] * t) / total
            out.append((x, y, raw))
    return out, lens, total, lens[0] / total, drawn / total


def stroke_mask(pts, sw, size_px, round_caps=True):
    """把整条折线画成一张「覆盖度」蒙版（L 模式，0~255）。

    不用 ImageDraw.line()，因为它的 width 只能是**整数像素**：
      4.67 × 8 = 37.36 px，取 37 则线本体 4.625（比圆头细 → 圆头外凸），
      取 38 则线本体 4.750（比圆头粗 → 圆头内缩）。两头不讨好。

    改为自建多边形填充，宽度是**亚像素精确**的：
      · 每段沿法线左右各偏移 sw/2，得到该段的矩形四角；
      · 相邻段的矩形用联合（union）叠加 —— 拐点处天然补满，无裂缝；
      · 端头按 round_caps 决定画半圆（圆弧多边形）还是直角。
    这样线本体与圆头用的是同一套 sw，端头绝不会凸出或内缩。
    """
    S = size_px
    m = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(m)

    hw = sw / 2 * SS
    P = [(p[0] * SS, p[1] * SS) for p in pts]

    def seg_quad(a, b):
        """线段 a→b 的矩形四角（沿法线偏移 ±hw）"""
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy)
        if n < 1e-9:
            return None
        # 法线单位向量
        nx, ny = -dy / n, dx / n
        return [a[0] + nx * hw, a[1] + ny * hw,
                b[0] + nx * hw, b[1] + ny * hw,
                b[0] - nx * hw, b[1] - ny * hw,
                a[0] - nx * hw, a[1] - ny * hw]

    # 每段画成矩形（重叠处自动并集），拐点处因两侧矩形交叠而自然补满
    for i in range(len(P) - 1):
        q = seg_quad(P[i], P[i + 1])
        if q:
            md.polygon(q, fill=255)

    def circle(cx, cy, r):
        md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)

    if round_caps:
        for p in (P[0], P[-1]):
            circle(p[0], p[1], hw)
    else:
        # 平头：在两端补一个「端面矩形」使端面与段方向垂直
        for p, q in ((P[0], P[1]), (P[-1], P[-2])):
            dx, dy = q[0] - p[0], q[1] - p[1]
            n = math.hypot(dx, dy)
            if n > 1e-9:
                md.polygon(seg_quad(p, (p[0] - dx / n * 0.5,
                                        p[1] - dy / n * 0.5)), fill=255)

    # 拐点补圆：折角外侧可能出现缺口，按顶点铺一个半径 hw 的圆填满
    for i in range(1, len(P) - 1):
        circle(P[i][0], P[i][1], hw)
    return m


def draw_sigma(box=44.0, sw=4.67, grad='arc', end='far', tail='seg',
               head='seg'):
    """tail / head:
         tail='seg'  尾部**保留截断 2×线宽**，并在原端点处画一条圆头短线段
         head='seg'  头部**不截断**（保持圆头），只加一条圆头短线段
         'round'     不截断、不加线段，圆头收尾
         'flat'      不截断、不加线段，平头收尾
         'dot'       截断 2×线宽 + 在原端点处画一个圆点（v7 方案）

    ⚠ 截断规则（用户明确要求）：
      · 尾部 'seg' / 'dot' 都会截断 —— 截断是尾部既有的设计，与附加元素无关
      · 头部只有 'dot' 才截断；'seg' **不动头部路径**

    线段几何（见 seg_endpoints.py）
      · 尾部：从 (1,-1) 到 (1,-0.5)，即自**原端点**沿 +y 走 0.5*h = 8.333
      · 头部：从 (1, 1) 到 (1, 0.5)，即自**原端点**沿 -y 走 0.5*h = 8.333
      · 线宽 = 字形线宽；**无渐变**，颜色取该端字形色
      · 圆头使外缘达 54 ± (h + sw/2) = 73.000 / 35.000，正好等于外接框边缘
    """
    im, S = new_canvas()
    w_px = max(1, int(round(sw * SS)))
    r = sw / 2 * SS

    h = box / 2 - sw / 2

    # 尾部：seg / dot 都截断；头部：只有 dot 截断
    cut_head = 2.0 * sw if head == 'dot' else 0.0
    cut_tail = 2.0 * sw if tail in ('seg', 'dot') else 0.0

    # 采样步长 ≈ 0.12 线宽：足够密，渐变过渡细腻
    step = sw * 0.12
    pts, lens, total, first_frac, drawn_frac = sigma_samples(
        box, sw, step, cut_head=cut_head, cut_tail=cut_tail)

    def color_of(raw):
        # 渐变端点以「实际画出的路径」为准
        g = min(1.0, raw / first_frac) if end == 'second' else raw / drawn_frac
        return lerp(WHITE, DARK, g)

    def color_at(p):
        return sweep_color(p[0], p[1]) if grad == 'ang' else color_of(p[2])

    # ---- 渐变色源层 ----
    # 用「沿路径铺圆笔刷、按弧长递增颜色」生成：笔刷半径 = 线宽/2，
    # 圆心按密集采样点排布，从后往前画，使路径上更靠后的点覆盖更靠前的点。
    # 采样极密（≈0.56 视口单位），「最后经过」与「最近点」几乎等同，
    # 于是颜色沿弧长单调变化，不会出现色平台。
    col_layer = colorize(pts, sw, S, grad, end, first_frac, drawn_frac)

    # ---- 笔画蒙版：自建多边形填充，宽度亚像素精确 ----
    # 只有明写 flat 的端才是平头；其余（round / seg / dot）均补圆头
    caps_round = (head != 'flat') or (tail != 'flat')
    mask = stroke_mask(pts, sw, S, round_caps=caps_round)

    # ---- 用蒙版把色层贴到背景上 ----
    out = Image.new("RGB", (S, S), BG)
    out.paste(col_layer, (0, 0), mask)

    # ---- 端点附加元素（无渐变） ----
    def disc(cx, cy, col):
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).ellipse(
            [cx * SS - r, cy * SS - r, cx * SS + r, cy * SS + r], fill=255)
        out.paste(Image.new("RGB", (S, S), col), (0, 0), m)

    def seg(a, b, col):
        """无渐变的短线段：**圆头**胶囊形（矩形 + 两端半圆），亚像素精确。

        用「矩形 + 两端半径 hw 的圆」拼出 capsule，避免 PIL line() 的整数宽度问题。
        """
        m = Image.new("L", (S, S), 0)
        md = ImageDraw.Draw(m)
        hw = sw / 2 * SS
        ax, ay, bx, by = a[0] * SS, a[1] * SS, b[0] * SS, b[1] * SS
        dx, dy = bx - ax, by - ay
        n = math.hypot(dx, dy)
        if n > 1e-9:
            nx, ny = -dy / n, dx / n
            # 矩形主体
            md.polygon([ax + nx * hw, ay + ny * hw,
                        bx + nx * hw, by + ny * hw,
                        bx - nx * hw, by - ny * hw,
                        ax - nx * hw, ay - ny * hw], fill=255)
        # 两端圆头（圆心在端点）
        for (px_, py_) in (a, b):
            cx_, cy_ = px_ * SS, py_ * SS
            md.ellipse([cx_ - hw, cy_ - hw, cx_ + hw, cy_ + hw], fill=255)
        out.paste(Image.new("RGB", (S, S), col), (0, 0), m)

    # 头部：从 (1,1) 到 (1,0.5)；自原端点沿 +y 走 0.5*h；颜色 = 字形头部色
    if head == 'seg':
        a = (54 + h, 54 - h)
        seg(a, (a[0], a[1] + 0.5 * h), color_of(0.0))
    # 尾部：从 (1,-1) 到 (1,-0.5)；自原端点沿 -y 走 0.5*h；颜色 = 字形尾部色
    if tail == 'seg':
        a = (54 + h, 54 + h)
        seg(a, (a[0], a[1] - 0.5 * h), color_of(1.0))

    if head == 'dot':
        # 首端方向（(1,1) → (-1,1)）为 -x；圆点圆心 = 截断后首端再前进 2*sw
        d0 = math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
        u0 = ((pts[1][0] - pts[0][0]) / d0, (pts[1][1] - pts[0][1]) / d0)
        disc(pts[0][0] - u0[0] * 2 * sw, pts[0][1] - u0[1] * 2 * sw,
             color_at(pts[0]))
    if tail == 'dot':
        # 末段方向（(-1,-1) → (1,-1)）为 +x；圆点圆心 = 截断后尾端再前进 2*sw
        d1 = math.hypot(pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1])
        u1 = ((pts[-1][0] - pts[-2][0]) / d1, (pts[-1][1] - pts[-2][1]) / d1)
        disc(pts[-1][0] + u1[0] * 2 * sw, pts[-1][1] + u1[1] * 2 * sw,
             color_at(pts[-1]))
    return out


def colorize(pts, sw, size_px, grad, end, first_frac, drawn_frac):
    """生成覆盖整幅画布的彩色层：每个像素取最近路径点的颜色。

    用「沿路径铺圆形笔刷、按弧长递增颜色」近似：
    笔刷半径 = 线宽/2，圆心按密集采样点排布，
    后画的笔刷覆盖先画的 → 等价于取「最后经过该像素的点」的颜色。
    因为采样点极密（0.56 视口单位），「最后经过」与「最近点」几乎等同，
    于是颜色沿弧长单调变化，无台阶。
    """
    col = Image.new("RGB", (size_px, size_px), BG)
    cd = ImageDraw.Draw(col)
    r = sw / 2 * SS

    def col_of(p):
        if grad == 'ang':
            return sweep_color(p[0], p[1])
        g = min(1.0, p[2] / first_frac) if end == 'second' else p[2] / drawn_frac
        return lerp(WHITE, DARK, g)

    # 从后往前画：让「路径上更靠后的点」覆盖更靠前的点
    for i in range(len(pts) - 1, -1, -1):
        p = pts[i]
        cx, cy = p[0] * SS, p[1] * SS
        c = col_of(p)
        cd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    return col


# ===========================================================================
def draw_livolog():
    im, S = new_canvas()
    d = ImageDraw.Draw(im)
    R_MID = 19.665
    W = 4.67
    w_px = max(1, int(round(W * SS)))

    phi0, phi1 = 60.0, 360.0
    arc_len = math.radians(phi1 - phi0) * R_MID
    step = W * 0.12
    n_all = max(1, int(math.ceil(arc_len / step)))

    def pt(phi):
        a = math.radians(phi - 90)
        return (54 + R_MID * math.cos(a), 54 + R_MID * math.sin(a))

    STEP_PTS = 8
    i = 0
    while i < n_all:
        j = min(i + STEP_PTS, n_all)
        grp = [pt(phi0 + (phi1 - phi0) * (k / n_all)) for k in range(i, j + 1)]
        mx = sum(p[0] for p in grp) / len(grp)
        my = sum(p[1] for p in grp) / len(grp)
        col = sweep_color(mx, my)
        d.line([(p[0] * SS, p[1] * SS) for p in grp], fill=col,
               width=w_px, joint="curve")
        i = j if j == n_all else max(i + 1, j - 1)

    def disc(cx, cy, r, col):
        R = r * SS
        d.ellipse([cx * SS - R, cy * SS - R, cx * SS + R, cy * SS + R], fill=col)

    disc(54.00, 34.33, 2.33, WHITE)
    disc(71.03, 44.17, 2.33, DARK)
    disc(63.83, 36.97, 2.33, DARK)

    for (x0, y0, x1, y1) in [(54, 54, 54, 43.33), (54, 54, 47.65, 57.67)]:
        d.line([(x0 * SS, y0 * SS), (x1 * SS, y1 * SS)], fill=WHITE,
               width=max(1, int(round(4.0 * SS))))
        disc(x0, y0, 2.0, WHITE)
        disc(x1, y1, 2.0, WHITE)
    disc(54, 54, 2.0, WHITE)
    return im


# ===========================================================================
def save_all():
    for f in os.listdir(OUTDIR):
        if f.startswith(('v3_', 'v4_', 'v5_', 'v6_', 'v7_')):
            os.remove(os.path.join(OUTDIR, f))

    def out(im, name, size):
        im.resize((size, size), Image.LANCZOS).save(
            os.path.join(OUTDIR, name), optimize=True)

    # Livolog 仅作参照（其圆环在分段绘制下会裂开，不再修）
    liv = draw_livolog()
    out(liv, 'v8_livolog.png', 420)
    out(liv, 'v8_livolog_230.png', 230)

    for tail in ('seg', 'dot', 'round', 'flat'):
        for head in ('seg', 'round', 'flat'):
            for box in (38, 44):
                for grad in ('arc', 'ang'):
                    for end in ('far', 'second'):
                        im = draw_sigma(box, 4.67, grad, end, tail, head)
                        k = f"v8_s_b{box}_{grad}_{end}_{tail}_{head}"
                        out(im, k + '.png', 420)
                        out(im, k + '_230.png', 230)

    base = draw_sigma(38, 4.67, 'arc', 'far', 'seg', 'seg')
    for s in (108, 72, 48, 36, 24):
        out(base, f"v8_size_{s}.png", s)

    S = VO * SS
    for name, (cx, cy) in {'head_dot': (66, 37.3), 'center': (54, 54),
                           'tail_dot': (66, 70.7)}.items():
        half_v = 9
        x0 = int((cx - half_v) * SS)
        y0 = int((cy - half_v) * SS)
        w = int(half_v * 2 * SS)
        base.crop((x0, y0, x0 + w, y0 + w)).resize(
            (432, 432), Image.LANCZOS).save(
            os.path.join(OUTDIR, f"v8_crop_{name}.png"), optimize=True)

    print("done")
    for f in ('v8_livolog.png', 'v8_s_b38_arc_far_seg_seg.png'):
        print(' ', f, os.path.getsize(os.path.join(OUTDIR, f)))


if __name__ == "__main__":
    save_all()
