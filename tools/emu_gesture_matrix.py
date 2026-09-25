# -*- coding: utf-8 -*-
"""用系统级触摸测：纵向拖到底滚不滚？横向拖到底选不选？

这是用户说「什么都没发生」的直接验证。
"""
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


def pp(v):
    return str(int(round(v * DPR)))


def tap(x, y, wait=1.5):
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


def swipe(x1, y1, x2, y2, ms=300, wait=1.2):
    adb('shell', 'input', 'swipe', pp(x1), pp(y1), pp(x2), pp(y2), str(ms))
    time.sleep(wait)


def rect_of(e):
    return js("""
        var x = %s;
        if (!x) return null;
        var r = x.getBoundingClientRect();
        return (r.width || r.height) ? [r.left, r.top, r.width, r.height] : null;
    """ % e)


def center_of(e):
    r = rect_of(e)
    return [r[0] + r[2] / 2, r[1] + r[3] / 2] if r else None


# ── 走到「原始视图 + 文字层」 ──────────────────────────────
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.0)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(12)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
DPR = js('return window.devicePixelRatio')

for _ in range(50):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
if js("return !!document.querySelector('.login.is-open')") is True:
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(1.5)

c = center_of("document.querySelector('.doc-card')")
tap(c[0], c[1], 4.0)
print('① 打开阅读页: %s' % js("return document.getElementById('reader').className"))

r = rect_of("document.getElementById('reader-top')")
if r and r[1] < 0:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.45, 1.5)
print('② 顶栏: %s  menu-open=%s'
      % (rect_of("document.getElementById('reader-top')"),
         js("return document.getElementById('reader').classList.contains('is-menu-open')")))

b = center_of("document.getElementById('reader-view-toggle')")
if b and b[1] > 0:
    tap(b[0], b[1], 3.0)
print('③ 原始视图: scroll=%s line=%s'
      % (js("return document.querySelectorAll('.pdf-scroll').length"),
         js("return document.querySelectorAll('.pdf-text-line').length")))

for _ in range(40):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)
print('   line=%s' % js("return document.querySelectorAll('.pdf-text-line').length"))
if not js("return document.querySelectorAll('.pdf-text-line').length"):
    raise SystemExit('没有文字层')

js("""
    window.__ev5 = [];
    if (!window.__ev5Wrapped) {
        window.__ev5Wrapped = true;
        ['pointerdown','pointermove','pointerup','pointercancel',
         'touchstart','touchmove','touchend'].forEach(function (n) {
            document.addEventListener(n, function (e) {
                if (window.__ev5.length > 400) return;
                window.__ev5.push(n + '|' + (e.target ? e.target.tagName : '?')
                    + '|' + Math.round(e.clientX || 0) + ',' + Math.round(e.clientY || 0));
            }, true);
        });
    }
    return 'ok';
""")

body = "document.querySelector('.reader-body')"


def state():
    return {
        'scroll': js("var b=%s; return b ? Math.round(b.scrollTop) : -1" % body),
        'sel': js("var s=window.getSelection(); return s ? String(s).length : -1"),
    }


row = js("""
    var ls = document.querySelectorAll('.pdf-text-line');
    for (var i = 0; i < ls.length; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.top < 160 || r.bottom > window.innerHeight - 220) continue;
        if (r.width < 14 || r.height < 4) continue;
        return { x: r.left, y: r.top, w: r.width, h: r.height,
                 t: (ls[i].textContent || '') };
    }
    return null;
""")
if not row:
    raise SystemExit('找不到可见文字行')
sx = row['x'] + 3
sy = row['y'] + row['h'] / 2
print()
print('起点行 "%s" @(%.0f,%.0f)' % (row['t'][:20], sx, sy))

print()
print('=== 测试 A：横向拖 140px（应选字，不滚）===')
js("var s=getSelection(); if(s) s.removeAllRanges(); window.__ev5=[]; return 1")
before = state()
swipe(sx, sy, sx + 140, sy, 300, 1.5)
after = state()
print('  scroll %s → %s   (差 %+d)' % (before['scroll'], after['scroll'],
                                       after['scroll'] - before['scroll']))
print('  选区 %s → %s' % (before['sel'], after['sel']))
ev = js('return window.__ev5 || []')
print('  事件: %s' % dict(Counter(x.split('|')[0] for x in ev)))
print('  → %s' % ('✅ 横向选中，且没滚' if after['sel'] > 0 and
                   abs(after['scroll'] - before['scroll']) < 20 else '⚠️ 需人工判断'))

print()
print('=== 测试 B：纵向拖 -300px（应滚页面，不选字）===')
js("var s=getSelection(); if(s) s.removeAllRanges(); window.__ev5=[]; return 1")
before = state()
swipe(sx, sy, sx + 10, sy - 300, 350, 1.5)
after = state()
print('  scroll %s → %s   (差 %+d)' % (before['scroll'], after['scroll'],
                                       after['scroll'] - before['scroll']))
print('  选区 %s → %s' % (before['sel'], after['sel']))
ev = js('return window.__ev5 || []')
print('  事件: %s' % dict(Counter(x.split('|')[0] for x in ev)))
print('  → %s' % ('✅ 纵向滚动，且没误选' if after['scroll'] - before['scroll'] > 100
                   and after['sel'] == 0 else '⚠️ 需人工判断'))

print()
print('=== 测试 C：斜向拖（45°，dx=100 dy=-100）===')
js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")
before = state()
swipe(sx, sy, sx + 100, sy - 100, 320, 1.5)
after = state()
print('  scroll 差 %+d   选区 %s' % (after['scroll'] - before['scroll'], after['sel']))
print('  → %s' % ('判成滚动（纵向分量相等时 ady>adx 为假 → 选字）'
                   if after['sel'] > 0 else '判成滚动'))

cdp.close()
