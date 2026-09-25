# -*- coding: utf-8 -*-
"""完全按用户手指路径：冷启动 → 点卡片 → 点页面唤起菜单 → 点视图切换
   → 拖拽选字。全程 adb shell input（系统级触摸，物理像素）。"""
import json
import os
import subprocess
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ADB = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk',
                   'platform-tools', 'adb.exe')
PKG = 'com.eliaszwc.scholarius.debug'


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')


def phys(v):
    return str(int(round(v * DPR)))


def tap(x, y, wait=1.5, label=''):
    if label:
        print('  👆 tap %s (%.0f,%.0f)' % (label, x, y))
    adb('shell', 'input', 'tap', phys(x), phys(y))
    time.sleep(wait)


def swipe(x1, y1, x2, y2, ms=300, wait=1.2, label=''):
    if label:
        print('  👆 swipe %s (%.0f,%.0f)→(%.0f,%.0f)' % (label, x1, y1, x2, y2))
    adb('shell', 'input', 'swipe', phys(x1), phys(y1), phys(x2), phys(y2), str(ms))
    time.sleep(wait)


def rect_of(expr):
    return js("""
        var e = %s;
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return [r.left, r.top, r.width, r.height];
    """ % expr)


def center_of(expr):
    r = rect_of(expr)
    if not r:
        return None
    return [r[0] + r[2] / 2, r[1] + r[3] / 2]


print('=== ① 冷启动 ===')
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.0)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(12)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
DPR = js('return window.devicePixelRatio')
print('dpr=%s' % DPR)

for _ in range(50):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
if js("return !!document.querySelector('.login.is-open')") is True:
    print('  （注入已登录，模拟你的状态）')
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(1.5)

print()
print('=== ② 点文献卡片 ===')
c = center_of("document.querySelector('.doc-card')")
tap(c[0], c[1], 4.0, '文献卡片')
print('  reader: %s' % js("return document.getElementById('reader').className"))

print()
print('=== ③ 等顶栏滑入 ===')
print('  reader-top rect: %s' % rect_of("document.getElementById('reader-top')"))
print('  is-menu-open: %s' % js("return document.getElementById('reader').classList.contains('is-menu-open')"))

if rect_of("document.getElementById('reader-top')")[1] < 0:
    print('  顶栏在屏幕外 → 需要点一下页面唤起菜单')
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.45, 1.5, '页面中间')
    print('  is-menu-open: %s' % js("return document.getElementById('reader').classList.contains('is-menu-open')"))
    print('  reader-top rect: %s' % rect_of("document.getElementById('reader-top')"))

r = rect_of("document.getElementById('reader-top')")
if not r or r[1] < 0:
    print('  ⚠️ 顶栏仍在屏幕外，再点一次')
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.45, 1.5, '页面中间(再)')
    print('  reader-top rect: %s' % rect_of("document.getElementById('reader-top')"))

print()
print('=== ④ 点「视图切换」进原始视图 ===')
b = center_of("document.getElementById('reader-view-toggle')")
if not b or b[1] < 0:
    raise SystemExit('❌ 视图按钮仍不可点')
print('  按钮 (%.0f,%.0f)  命中=%s'
      % (b[0], b[1], js("""
        var e = document.elementFromPoint(%.0f, %.0f);
        return e ? (e.id || e.tagName) : 'null';
      """ % (b[0], b[1]))))
tap(b[0], b[1], 3.0, '视图切换')
print('  scroll=%s layer=%s'
      % (js("return document.querySelectorAll('.pdf-scroll').length"),
         js("return document.querySelectorAll('.pdf-text-layer').length")))

for _ in range(40):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)
n = js("return document.querySelectorAll('.pdf-text-line').length")
print('  文字行数: %s' % n)
if not n:
    raise SystemExit('❌ 没有文字层')

print()
print('=== ⑤ 手指横拖选字（系统级触摸）===')
js("""
    window.__ev4 = [];
    if (!window.__ev4Wrapped) {
        window.__ev4Wrapped = true;
        ['pointerdown','pointermove','pointerup','pointercancel',
         'touchstart','touchmove','touchend'].forEach(function (n) {
            document.addEventListener(n, function (e) {
                if (window.__ev4.length > 300) return;
                var t = e.target;
                window.__ev4.push(n + '|' + (t ? t.tagName : '?')
                    + '|' + Math.round(e.clientX || 0) + ',' + Math.round(e.clientY || 0));
            }, true);
        });
    }
    return 'ok';
""")

row = js("""
    var lines = document.querySelectorAll('.pdf-text-line');
    for (var i = 0; i < lines.length; i++) {
        var r = lines[i].getBoundingClientRect();
        if (r.top < 150 || r.bottom > window.innerHeight - 150) continue;
        if (r.width < 14 || r.height < 4) continue;
        return { x: r.left, y: r.top, w: r.width, h: r.height,
                 t: (lines[i].textContent || '') };
    }
    return null;
""")
if not row:
    raise SystemExit('找不到可见文字行')

# 一次词太短，横向拖 140px（跨多个词）—— 模拟真实"划过一行"
fx, fy = row['x'] + 2, row['y'] + row['h'] / 2
tx, ty = row['x'] + 140, fy
print('  目标行 "%s"（宽 %.0f）' % (row['t'][:34], row['w']))
print('  起点命中: %s' % js("""
    var e = document.elementFromPoint(%.0f, %.0f);
    return e ? (e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')) : 'null';
""" % (fx, fy)))

js("var s=getSelection(); if(s) s.removeAllRanges(); window.__ev4=[]; return 1")
swipe(fx, fy, tx, ty, 300, 1.5, '横向选字')

sel = js("""
    var s = window.getSelection();
    return JSON.stringify({ len: s ? String(s).length : 0,
                            text: s ? String(s).slice(0, 70) : '' });
""")
print()
print('  选区: %s' % sel)
d = json.loads(sel)
if d['len']:
    print('  ✅ 选中 %d 字符：%s' % (d['len'], d['text']))
else:
    print('  ❌ 没选中')

evs = js('return window.__ev4 || []')
print()
print('  事件统计: %s' % dict(Counter(x.split('|')[0] for x in evs)))
for e in evs[:10]:
    print('    ' + e)

print()
print('  可见高亮 rect: %s' % js("""
    var s = window.getSelection();
    if (!s || !s.rangeCount) return '无';
    var r = s.getRangeAt(0).getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top),
            Math.round(r.width), Math.round(r.height)].join(',');
"""))
cdp.close()
