# -*- coding: utf-8 -*-
"""冷启动 → 进编辑模式 → 验证顶部/底部补偿 + 框可见性。

⚠️ 每步都用真实触摸（adb shell input，物理像素）。
⚠️ 登录页处理：先注入已登录（模拟用户的实际状态）。
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
OUT = os.path.join(os.environ.get('TEMP', '.'), 'edge_shots')
os.makedirs(OUT, exist_ok=True)


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


def shot(name):
    adb('shell', 'screencap', '-p', '/sdcard/_e.png')
    p = os.path.join(OUT, name)
    adb('pull', '/sdcard/_e.png', p)
    print('    📸 %s' % p)


print('=== 冷启动 ===')
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(13)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')


def pp(v):
    return str(int(round(v * DPR)))


def tap(x, y, wait=1.6):
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


def center_of(e):
    return js("""var x=%s; if(!x) return null; var r=x.getBoundingClientRect();
                 return (r.width||r.height)?[r.left+r.width/2, r.top+r.height/2]:null;""" % e)


for _ in range(60):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)

if js("return !!document.querySelector('.login.is-open')") is True:
    print('  有登录页 → 注入已登录（模拟你的状态）')
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(1.8)

print()
print('=== 打开文献 ===')
c = center_of("document.querySelector('.doc-card')")
if not c:
    raise SystemExit('没有卡片')
tap(c[0], c[1], 4.5)
print('  reader=%s' % js("return document.getElementById('reader').className"))

r = js("var t=document.getElementById('reader-top');"
       "return t?Math.round(t.getBoundingClientRect().top):null")
if r is None or r < 0:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.42, 1.8)

if js("return document.querySelectorAll('.pdf-scroll').length") == 0:
    b = center_of("document.getElementById('reader-view-toggle')")
    if b and b[1] > 0:
        tap(b[0], b[1], 4.0)

for _ in range(50):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)
print('  文字行数=%s' % js("return document.querySelectorAll('.pdf-text-line').length"))

print()
print('=== 进编辑模式 ===')
b = center_of("document.getElementById('reader-annotate')")
if b and b[1] > 0:
    tap(b[0], b[1], 2.5)
print('  reader=%s' % js("return document.getElementById('reader').className"))

print()
print('=== 结果 ①：顶/底补偿 ===')
print(js("""
    var b = document.querySelector('.reader-body');
    var cs = getComputedStyle(b);
    return '  padding-top=' + cs.paddingTop + '  padding-bottom=' + cs.paddingBottom;
"""))
shot('1-edit-mode.png')

print()
print('=== 结果 ②：滚到最底，最后一块有没有被底栏盖住 ===')
js("var b=document.querySelector('.reader-body'); b.scrollTop = b.scrollHeight; return 1")
time.sleep(0.9)
print(js("""
    var vh = window.innerHeight;
    var bot = document.getElementById('reader-bottom');
    var botTop = bot ? bot.getBoundingClientRect().top : 0;
    var worst = null;
    document.querySelectorAll('.anno-block').forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.height < 1) return;
        if (!worst || r.bottom > worst.r.bottom) worst = { e: e, r: r };
    });
    var out = [];
    out.push('  底栏顶边 y = ' + Math.round(botTop));
    if (worst) {
        out.push('  最低的块 bottom = ' + Math.round(worst.r.bottom)
                 + ' 类型=' + (worst.e.getAttribute('data-text-type') || '?'));
        out.push('  → ' + (worst.r.bottom <= botTop
                 ? '✅ 不被底栏盖住' : '❌ 仍被盖住 ' + Math.round(worst.r.bottom - botTop) + 'px'));
    }
    var b = document.querySelector('.reader-body');
    out.push('  maxScroll 时的可见下边界 = '
             + Math.round(b.scrollHeight - b.scrollTop));
    return out.join('\\n');
"""))
shot('2-bottom.png')

print()
print('=== 结果 ③：标过的框还看不看得见 ===')
js("var b=document.querySelector('.reader-body'); b.scrollTop = 0; return 1")
time.sleep(0.7)
print(js("""
    var out = [];
    var marks = document.querySelectorAll('.anno-block:not(.anno-block-body)');
    out.push('  已标注的块（非 body）: ' + marks.length + ' 个');
    var visible = 0;
    marks.forEach(function (e) {
        var cs = getComputedStyle(e);
        var r = e.getBoundingClientRect();
        if (cs.display === 'none' || r.width < 1) return;
        if (parseFloat(cs.opacity) === 0) return;
        /* 有背景或左边框 = 视觉上看得出来 */
        if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
            || parseFloat(cs.borderLeftWidth) > 0) visible++;
    });
    out.push('  其中视觉可见（有底色/左边条）: ' + visible + ' 个');
    var z = document.querySelector('.anno-block');
    out.push('  .anno-block z-index = ' + (z ? getComputedStyle(z).zIndex : '-'));
    var l = document.querySelector('.pdf-text-layer');
    out.push('  .pdf-text-layer z-index = ' + (l ? getComputedStyle(l).zIndex : '-'));
    return out.join('\\n');
"""))
shot('3-marks.png')
print()
print('截图目录: %s' % OUT)
cdp.close()
