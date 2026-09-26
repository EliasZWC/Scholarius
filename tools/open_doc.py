# -*- coding: utf-8 -*-
"""打开文献（真手指），供 extract_baseline.py 采集。"""
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

ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')
pp = lambda v: str(int(round(v * DPR)))  # noqa: E731


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


def tap(x, y, wait=1.5):
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


def tap_el(expr, wait=1.5, label=''):
    info = js("""
        var e = %s;
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    """ % expr)
    if not info or info == 'null':
        print('  ✗ 找不到 %s' % label)
        return False
    d = json.loads(info)
    print('  👆 %s @(%.0f,%.0f)' % (label, d['x'], d['y']))
    tap(d['x'], d['y'], wait)
    return True


for _ in range(60):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)

if js("return !!document.querySelector('.login.is-open');") is True:
    print('  ⚠️ 登录：用测试入口（真实环境走 OAuth）')
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(2.5)

tap_el("document.querySelector('.doc-card')", 6.0, '文献卡片')
if js("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.42, 2.0)

for _ in range(60):
    n = js("var r=window.ScholariusReader; return (r&&r.getBlocks)?(r.getBlocks()||[]).length:0")
    if n and n > 0:
        break
    time.sleep(1)

print('  块数 = %s' % js("var r=window.ScholariusReader; return (r.getBlocks()||[]).length"))
cdp.close()
