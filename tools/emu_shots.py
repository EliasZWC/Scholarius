# -*- coding: utf-8 -*-
"""走完整手指路径，并在「选中后」截图 —— 让人眼能验证。"""
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
OUT = os.path.join(os.environ.get('TEMP', '.'), 'scholarius_shots')
os.makedirs(OUT, exist_ok=True)


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


def shot(name):
    p = os.path.join(OUT, name)
    adb('shell', 'screencap', '-p', '/sdcard/_s.png')
    adb('pull', '/sdcard/_s.png', p)
    print('  📸 %s' % p)
    return p


ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.0)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(12)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
DPR = js('return window.devicePixelRatio')


def pp(v):
    return str(int(round(v * DPR)))


def tap(x, y, wait=1.5):
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


def swipe(x1, y1, x2, y2, ms=300, wait=1.4):
    adb('shell', 'input', 'swipe', pp(x1), pp(y1), pp(x2), pp(y2), str(ms))
    time.sleep(wait)


def rect_of(e):
    return js("""
        var x = %s; if (!x) return null;
        var r = x.getBoundingClientRect();
        return (r.width || r.height) ? [r.left, r.top, r.width, r.height] : null;
    """ % e)


def center_of(e):
    r = rect_of(e)
    return [r[0] + r[2] / 2, r[1] + r[3] / 2] if r else None


for _ in range(50):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)

print('① 冷启动后的画面')
shot('1-cold.png')

if js("return !!document.querySelector('.login.is-open')") is True:
    print('  有登录页（你已登录，这里注入跳过）')
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(1.5)
    shot('2-logged-in.png')

print('② 点文献卡片')
c = center_of("document.querySelector('.doc-card')")
tap(c[0], c[1], 4.0)
print('  reader=%s' % js("return document.getElementById('reader').className"))

r = rect_of("document.getElementById('reader-top')")
print('  顶栏 rect=%s' % (r,))
if r and r[1] < 0:
    print('  顶栏在屏幕外 → 点页面唤起')
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.45, 1.6)
shot('3-reader-menu-open.png')

print('③ 进原始视图')
b = center_of("document.getElementById('reader-view-toggle')")
if b and b[1] > 0:
    tap(b[0], b[1], 3.5)
for _ in range(40):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)
print('  文字行数=%s' % js("return document.querySelectorAll('.pdf-text-line').length"))
shot('4-raw-view.png')

print('④ 横拖选字')
row = js("""
    var ls = document.querySelectorAll('.pdf-text-line');
    for (var i = 0; i < ls.length; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.top < 160 || r.bottom > window.innerHeight - 200) continue;
        if (r.width < 14 || r.height < 4) continue;
        return { x: r.left, y: r.top, w: r.width, h: r.height,
                 t: (ls[i].textContent || '') };
    }
    return null;
""")
sx = row['x'] + 3
sy = row['y'] + row['h'] / 2
js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")
swipe(sx, sy, sx + 150, sy, 300, 1.6)
print('  选区长度=%s' % js("var s=getSelection(); return s?String(s).length:0"))
shot('5-after-select.png')
print()
print('截图目录: %s' % OUT)
cdp.close()
