# -*- coding: utf-8 -*-
"""验证：文字层上的纵向拖拽 = 滚页面，不选字。"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


def tap(x, y, wait=1.2):
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.08)
    cdp.touch('touchEnd', [])
    time.sleep(wait)


def tap_sel(sel, wait=1.2):
    b = js("""
        var e = document.querySelector(%s);
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width) return null;
        return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
    """ % json.dumps(sel))
    if b:
        tap(b[0], b[1], wait)
    return b


# 确保在 raw 且层已挂
for _ in range(40):
    if js("return !!document.getElementById('reader')") is True:
        break
    time.sleep(0.4)
for _ in range(40):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||c.opacity==='0'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
js("if(window.ScholariusShell&&window.ScholariusShell.setAccount&&"
   "!window.__fakeSignedIn){window.ScholariusShell.setAccount(true,"
   "'eliaszwc','EliasZWC','','t');window.__fakeSignedIn=true;} return 1")
time.sleep(0.5)

# 已在 reader 且 raw 但没层 → 切两次
if js("return document.querySelectorAll('.pdf-text-layer').length") == 0:
    if js("return !document.getElementById('reader').classList.contains('is-open')") is True:
        tap_sel('.doc-card', 3.0)
    b = tap_sel('#reader-view-toggle', 2.5)
    if b and js("return document.querySelectorAll('.pdf-text-layer').length") == 0:
        tap(b[0], b[1], 3.5)

# ⚠️ 必须退出编辑/画框态 —— 那时层是 pointer-events: none，测不了滚动
for _ in range(12):
    if js("return !document.getElementById('reader')"
          ".classList.contains('is-annotating')") is True:
        break
    tap_sel('#reader-annotate', 1.2)
time.sleep(0.8)

print('reader class: %s' % js("return document.getElementById('reader').className"))
print('层 0 的 pe: %s' % js("""
    var l = document.querySelector('.pdf-text-layer');
    return l ? getComputedStyle(l).pointerEvents + ' ta=' + getComputedStyle(l).touchAction
             : 'no layer';
"""))

print('层数: %s 行数: %s'
      % (js("return document.querySelectorAll('.pdf-text-layer').length"),
         js("return document.querySelectorAll('.pdf-text-line').length")))

before = js("var b=document.querySelector('.reader-body'); return b?Math.round(b.scrollTop):-1")
print('拖前 scrollTop: %s' % before)

# 清掉选区
js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")

# 找一条可见行作为起点
pos = js("""
    var lines = document.querySelectorAll('.pdf-text-line');
    for (var i = 0; i < lines.length; i++) {
        var r = lines[i].getBoundingClientRect();
        if (r.top < 150 || r.bottom > window.innerHeight - 150) continue;
        if (r.width < 12 || r.height < 4) continue;
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
                 t: lines[i].textContent.slice(0, 14) };
    }
    return null;
""")
if not pos:
    raise SystemExit('找不到可见文字行')

print()
print('在 "%s" @(%d,%d) 上纵向拖 -260px' % (pos['t'], pos['x'], pos['y']))
cdp.touch('touchStart', [(pos['x'], pos['y'])])
time.sleep(0.12)
for i in range(1, 21):
    cdp.touch('touchMove', [(pos['x'] + 2, pos['y'] - i * 13)])
    time.sleep(0.03)
cdp.touch('touchEnd', [])
time.sleep(0.8)

after = js("var b=document.querySelector('.reader-body'); return b?Math.round(b.scrollTop):-1")
sel = js("""
    var s = window.getSelection();
    return JSON.stringify({ len: s ? String(s).length : -1 });
""")
print()
print('拖后 scrollTop: %s   (差 %+d)' % (after, after - before))
print('选区: %s' % sel)
print('__gesture: %s' % js("var l=document.querySelector('.pdf-text-layer');"
                           "return l ? String(l.__gesture) : '-'"))

ok_pan = after > before + 100
ok_nosel = json.loads(sel)['len'] == 0
print()
print('滚动: %s' % ('✅ 滚了' if ok_pan else '❌ 没滚'))
print('未误选: %s' % ('✅ 没选字' if ok_nosel else '❌ 误选了字'))
cdp.close()
