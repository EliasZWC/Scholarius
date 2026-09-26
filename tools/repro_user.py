# -*- coding: utf-8 -*-
"""按用户的**真实操作顺序**复现三个问题。

⚠️ 铁律（这次不偷懒）：
  1. 全程 `adb shell input`（系统级触摸），**不用 JS 算坐标点击**
  2. 找元素只用 JS **读矩形**，点击一律走真实触摸
  3. 每一步截图，存到 tools/_repro/
  4. 断言用"屏幕上能不能看到"，不用内存变量

用户报的三个问题：
  ① 很难选中（可能和大小有关）
  ② 清空所有区域后还剩一个公式删不掉
  ③ 随机挑一处改成"作者"→ 没成功，**似乎跳到了最开头**；
     然后**选中的地方一点其他区域就没了**（选中与建立区域脱节）
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ADB = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk',
                   'platform-tools', 'adb.exe')
PKG = 'com.eliaszwc.scholarius.debug'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_repro')
os.makedirs(OUT, exist_ok=True)
SHOT_N = [0]


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


def shot(tag):
    SHOT_N[0] += 1
    remote = '/sdcard/_r.png'
    adb('shell', 'screencap', '-p', remote)
    name = '%02d-%s.png' % (SHOT_N[0], tag)
    p = os.path.join(OUT, name)
    adb('pull', remote, p)
    print('    📸 %s' % name)
    return p


ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')
print('dpr = %s' % DPR)


def pp(v):
    return str(int(round(v * DPR)))


def tap(x, y, wait=1.5):
    """真实点击（CSS 坐标 → 物理像素）"""
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


def tap_el(expr, wait=1.5, label=''):
    """
    ⚠️ 只用来**读矩形**再真实点击 —— 不是"用 JS 点元素"。
       并且会打印 elementFromPoint 的结果，便于核对没点错东西。
    """
    info = js("""
        var e = %s;
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var hit = document.elementFromPoint(cx, cy);
        return JSON.stringify({
            cx: cx, cy: cy,
            rect: [Math.round(r.left), Math.round(r.top),
                   Math.round(r.width), Math.round(r.height)],
            hit: hit ? (hit.id || hit.tagName) + '.'
                 + (typeof hit.className === 'string' ? hit.className.split(' ')[0] : '')
                 : 'null'
        });
    """ % expr)
    if not info:
        print('    ✗ 找不到 %s' % label)
        return None
    d = json.loads(info)
    print('    👆 %s @(%.0f,%.0f) 命中=%s' % (label, d['cx'], d['cy'], d['hit']))
    tap(d['cx'], d['cy'], wait)
    return d


def swipe(x1, y1, x2, y2, ms=1000, wait=1.6, label=''):
    print('    👉 %s (%.0f,%.0f)→(%.0f,%.0f) %dms' % (label, x1, y1, x2, y2, ms))
    adb('shell', 'input', 'swipe', pp(x1), pp(y1), pp(x2), pp(y2), str(ms))
    time.sleep(wait)


def rect_of(expr):
    return js("""var x=%s; if(!x) return null; var r=x.getBoundingClientRect();
                 return (r.width||r.height)?[r.left,r.top,r.width,r.height]:null;""" % expr)


def center_of(expr):
    r = rect_of(expr)
    return [r[0] + r[2] / 2, r[1] + r[3] / 2] if r else None


# ══════════════════════════════════════════════════════════════════
print()
print('##### 冷启动 #####')
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(13)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
DPR = js('return window.devicePixelRatio')

for _ in range(60):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
shot('01-启动后')

if js("return !!document.querySelector('.login.is-open')") is True:
    print('登录页在 → 注入已登录（你已登录，这一步只是跳过登录）')
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(1.8)
    shot('02-已登录')

print()
print('##### 打开文献 → 原始视图 #####')
tap_el("document.querySelector('.doc-card')", 4.5, '文献卡片')
print('    reader=%s' % js("return document.getElementById('reader').className"))

if js("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.42, 1.8)

if js("return document.querySelectorAll('.pdf-scroll').length") == 0:
    tap_el("document.getElementById('reader-view-toggle')", 4.0, '视图切换')

for _ in range(50):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)
print('    文字行数=%s' % js("return document.querySelectorAll('.pdf-text-line').length"))
shot('03-原始视图')


# ══════════════════════════════════════════════════════════════════
# ① 很难选中 —— 在多种行上各划一次，量命中率
# ══════════════════════════════════════════════════════════════════
print()
print('##### 问题① 选中的难易：在不同行上各划一次 #####')

candidates = js("""
    var ls = document.querySelectorAll('.pdf-text-line');
    var vh = window.innerHeight;
    var out = [];
    for (var i = 0; i < ls.length && out.length < 6; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.top < 130 || r.bottom > vh - 130) continue;
        if (r.width < 8 || r.height < 3) continue;
        /* 跳过离上一个太近的（要覆盖不同高度/字号） */
        var dup = false;
        for (var j = 0; j < out.length; j++) {
            if (Math.abs(out[j].y - (r.top + r.height / 2)) < 25) dup = true;
        }
        if (dup) continue;
        out.push({ x: r.left, y: r.top, w: r.width, h: r.height,
                   t: (ls[i].textContent || '').slice(0, 22) });
    }
    return JSON.stringify(out);
""")
rows = json.loads(candidates)
print('    找到 %d 条不同高度的行' % len(rows))

hit_ok = 0
for k, row in enumerate(rows):
    # 起点：词内 20% 处（模拟"手指落在词上但不在正中"）
    sx = row['x'] + row['w'] * 0.2
    sy = row['y'] + row['h'] / 2
    hit = js("""
        var e = document.elementFromPoint(%.1f, %.1f);
        return e ? (e.tagName + '.' + (typeof e.className === 'string'
                    ? e.className.split(' ')[0] : '')) : 'null';
    """ % (sx, sy))
    ok = 'pdf-text-line' in (hit or '')
    if ok:
        hit_ok += 1
    # 拖 120px（约 5~6 个词）
    js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")
    swipe(sx, sy, sx + 120, sy, 900, 1.2,
          '行%d h=%.0f "%s" 起点命中=%s' % (k + 1, row['h'], row['t'][:12], hit))
    n = js("return document.querySelectorAll('.pdf-text-line.is-selected').length")
    ln = js("var s=getSelection(); return s?String(s).length:0")
    print('        → 高亮词数=%s 选区字符=%s %s' % (n, ln, '✅' if n else '❌ 没选上'))
    if k == 0:
        shot('04-第一次划选')

print('    起点命中率: %d/%d' % (hit_ok, len(rows)))

cdp.close()
print()
print('截图目录: %s' % OUT)
