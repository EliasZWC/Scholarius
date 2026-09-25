# -*- coding: utf-8 -*-
"""验证「建立区域」全流程（系统级触摸 + 冷启动 + 截图）。

流程：冷启动 → 点卡片 → 点页面唤起菜单 → 点眼睛进原始视图
     → 横拖选字 → 点「建立区域」→ 选类型 → 确认标注已写入
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
OUT = os.path.join(os.environ.get('TEMP', '.'), 'region_shots')
os.makedirs(OUT, exist_ok=True)


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


def shot(name):
    adb('shell', 'screencap', '-p', '/sdcard/_r.png')
    p = os.path.join(OUT, name)
    adb('pull', '/sdcard/_r.png', p)
    print('    📸 %s' % p)
    return p


print('=== ① 冷启动 ===')
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(13)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')
print('dpr=%s' % DPR)


def pp(v):
    return str(int(round(v * DPR)))


def tap(x, y, wait=1.6):
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


def swipe(x1, y1, x2, y2, ms=1000, wait=1.6):
    adb('shell', 'input', 'swipe', pp(x1), pp(y1), pp(x2), pp(y2), str(ms))
    time.sleep(wait)


def rect_of(e):
    return js("""var x=%s; if(!x) return null; var r=x.getBoundingClientRect();
                 return (r.width||r.height)?[r.left,r.top,r.width,r.height]:null;""" % e)


def center_of(e):
    r = rect_of(e)
    return [r[0] + r[2] / 2, r[1] + r[3] / 2] if r else None


for _ in range(60):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
if js("return !!document.querySelector('.login.is-open')") is True:
    print('  注入已登录（模拟你的状态）')
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(1.6)

print()
print('=== ② 打开文献 → 原始视图 ===')
if js("return document.getElementById('reader').classList.contains('is-open')") is not True:
    c = center_of("document.querySelector('.doc-card')")
    if not c:
        raise SystemExit('找不到文献卡片')
    tap(c[0], c[1], 4.5)
print('  reader=%s' % js("return document.getElementById('reader').className"))
if js("return document.getElementById('reader').classList.contains('is-open')") is not True:
    # 可能又被登录页挡住 —— 注入后再点
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(1.5)
    c = center_of("document.querySelector('.doc-card')")
    tap(c[0], c[1], 4.5)
    print('  重试后 reader=%s' % js("return document.getElementById('reader').className"))

r = rect_of("document.getElementById('reader-top')")
if not r or r[1] < 0:
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
assert js("return document.querySelectorAll('.pdf-text-line').length") > 0, '没有文字层'
shot('1-raw.png')

print()
print('=== ③ 横拖选字 ===')
row = js("""
    var ls=document.querySelectorAll('.pdf-text-line');
    for(var i=0;i<ls.length;i++){
      var r=ls[i].getBoundingClientRect();
      if(r.top<180||r.bottom>window.innerHeight-220) continue;
      if(r.width<12||r.height<4) continue;
      return {i:i,x:r.left,y:r.top,w:r.width,h:r.height,t:(ls[i].textContent||'')};
    }
    return null;
""")
sx, sy = row['x'] + 2, row['y'] + row['h'] * 0.5
print('  目标词 "%s" @(%.0f,%.0f)' % (row['t'][:18], sx, sy))
js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")
swipe(sx, sy, sx + 160, sy, 1000, 1.5)

sel_len = js("var s=getSelection(); return s?String(s).length:-1")
n_hl = js("return document.querySelectorAll('.pdf-text-line.is-selected').length")
print('  选区=%s  is-selected 行数=%s' % (sel_len, n_hl))
shot('2-selected.png')

print()
print('=== ④ 「建立区域」按钮出现了吗 ===')
fab = rect_of("document.getElementById('reader-sel-fab')")
print('  FAB rect=%s' % (fab,))
print('  FAB hidden=%s' % js("var b=document.getElementById('reader-sel-fab');"
                            "return b?b.hidden:'no el'"))
print('  FAB 文案=%s' % js("var b=document.getElementById('reader-sel-fab-label');"
                           "return b?b.textContent:'-'"))
if not fab:
    print('  ❌ FAB 没出现')
    shot('3-no-fab.png')
    cdp.close()
    raise SystemExit(1)
print('  FAB 命中=%s' % js("""
    var e=document.elementFromPoint(%.0f,%.0f);
    return e?(e.id||e.tagName):'null';
""" % (fab[0] + fab[2] / 2, fab[1] + fab[3] / 2)))
shot('3-fab.png')

print()
print('=== ⑤ 点「建立区域」 ===')
tap(fab[0] + fab[2] / 2, fab[1] + fab[3] / 2, 2.0)
sheet = js("return document.querySelectorAll('.anno-typesheet').length")
print('  类型弹层数=%s' % sheet)
print('  弹层选项=%s' % js("""
    var o = document.querySelectorAll('.anno-typeopt');
    var out = [];
    for (var i = 0; i < o.length; i++) {
        out.push((o[i].textContent || '').trim());
    }
    return JSON.stringify(out);
"""))
shot('4-typesheet.png')

if not sheet:
    print('  ❌ 类型弹层没出现')
    cdp.close()
    raise SystemExit(1)

print()
print('=== ⑥ 选「章节标题」验证真正落笔 ===')
before = js("return document.querySelectorAll('.rd-region-title, .rd-region-section').length")
target = js("""
    var o = document.querySelectorAll('.anno-typeopt');
    for (var i = 0; i < o.length; i++) {
        if ((o[i].textContent || '').indexOf('标题') >= 0
            || (o[i].textContent || '').toLowerCase().indexOf('heading') >= 0) {
            var r = o[i].getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2,
                    (o[i].textContent || '').trim()];
        }
    }
    return null;
""")
print('  目标选项: %s' % (target[2] if target else '找不到'))
if target:
    tap(target[0], target[1], 2.0)
    # 章节标题会再弹层级选择
    lv = js("""
        var o = document.querySelectorAll('.anno-levelopt, .anno-typeopt');
        if (!o.length) return null;
        var r = o[0].getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2, (o[0].textContent || '').trim()];
    """)
    if lv and lv[1] > 0:
        print('  层级选项: %s' % lv[2])
        tap(lv[0], lv[1], 1.8)

print()
print('=== ⑦ 结果 ===')
print('  弹层已关: %s' % (js("return document.querySelectorAll('.anno-typesheet').length") == 0))
print('  FAB 已收: %s' % js("var b=document.getElementById('reader-sel-fab');"
                           "return b?b.hidden:'-'"))
print('  高亮已清: %s' % js("return document.querySelectorAll('.pdf-text-line.is-selected').length"))
print('  textMarks（内存）: %s' % js("""
    try {
        return JSON.stringify((window.ScholariusReader.getTextMarks
                ? window.ScholariusReader.getTextMarks() : null) || 'no api');
    } catch (e) { return 'err ' + e.message; }
"""))
shot('5-after-mark.png')
print()
print('截图: %s' % OUT)
cdp.close()
