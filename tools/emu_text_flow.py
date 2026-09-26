# -*- coding: utf-8 -*-
"""验证「文本选项 → 划选 → 直接出类型」全流程（系统级触摸 + 冷启动 + 截图）。

⚠️ 流程按用户 2026-09-26 的要求：
   进编辑模式 → 点「文本」选项 → 在文字上横拖 → 类型选项**直接**浮出
   → 选类型 → 落笔

⚠️ 还要验证**负例**：非编辑模式下划选**不该**生效（否则「文本」选项就空置了）。
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
OUT = os.path.join(os.environ.get('TEMP', '.'), 'txtflow')
os.makedirs(OUT, exist_ok=True)


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


def shot(name):
    adb('shell', 'screencap', '-p', '/sdcard/_t.png')
    p = os.path.join(OUT, name)
    adb('pull', '/sdcard/_t.png', p)
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


def swipe(x1, y1, x2, y2, ms=900, wait=1.6):
    adb('shell', 'input', 'swipe', pp(x1), pp(y1), pp(x2), pp(y2), str(ms))
    time.sleep(wait)


def rect_of(e):
    return js("""var x=%s; if(!x) return null; var r=x.getBoundingClientRect();
                 return (r.width||r.height)?[r.left,r.top,r.width,r.height]:null;""" % e)


def center_of(e):
    r = rect_of(e)
    return [r[0] + r[2] / 2, r[1] + r[3] / 2] if r else None


def ensure_view_raw():
    """走到「原始视图 + 有文字层」"""
    for _ in range(60):
        if js("var s=document.querySelector('.splash'); if(!s) return true;"
              "var c=getComputedStyle(s);"
              "return c.display==='none'||s.hidden===true;") is True:
            break
        time.sleep(0.4)
    if js("return !!document.querySelector('.login.is-open')") is True:
        js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
           "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
        time.sleep(1.6)
    if js("return document.getElementById('reader').classList.contains('is-open')") is not True:
        c = center_of("document.querySelector('.doc-card')")
        if not c:
            raise SystemExit('找不到卡片')
        tap(c[0], c[1], 4.5)
    if js("return document.getElementById('reader').classList.contains('is-open')") is not True:
        js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
           "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
        time.sleep(1.5)
        c = center_of("document.querySelector('.doc-card')")
        tap(c[0], c[1], 4.5)
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


def find_row():
    """
    ⚠️ 进编辑模式后 `.reader-body` 会加 `padding-top: var(--reader-top-h)`
       （113px，见 styles.css 的说明），页面内容整体下移 ——
       所以"可见范围"不能按固定边距筛，要按**当前视口**放宽。
    """
    return js("""
        var ls=document.querySelectorAll('.pdf-text-line');
        var vh = window.innerHeight;
        for(var i=0;i<ls.length;i++){
          var r=ls[i].getBoundingClientRect();
          if(r.top < 160 || r.bottom > vh - 160) continue;
          if(r.width < 12 || r.height < 4) continue;
          return {i:i,x:r.left,y:r.top,w:r.width,h:r.height,t:(ls[i].textContent||'')};
        }
        /* 放宽一档：只要在视口内且不被顶栏/底栏压住 */
        for(var j=0;j<ls.length;j++){
          var r2=ls[j].getBoundingClientRect();
          if(r2.top < 130 || r2.bottom > vh - 130) continue;
          if(r2.width < 10 || r2.height < 3) continue;
          return {i:j,x:r2.left,y:r2.top,w:r2.width,h:r2.height,
                  t:(ls[j].textContent||'')};
        }
        /* 最后一档：只要在视口内 */
        for(var k=0;k<ls.length;k++){
          var r3=ls[k].getBoundingClientRect();
          if(r3.top < 125 || r3.bottom > vh - 125) continue;
          if(r3.width < 8) continue;
          return {i:k,x:r3.left,y:r3.top,w:r3.width,h:r3.height,
                  t:(ls[k].textContent||'')};
        }
        return null;
    """)


ensure_view_raw()
print('  文字行数=%s' % js("return document.querySelectorAll('.pdf-text-line').length"))
shot('1-raw.png')

print()
print('=== ② 负例：非编辑模式下划选**不该**生效 ===')
row = find_row()
sx, sy = row['x'] + 2, row['y'] + row['h'] * 0.5
js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")
swipe(sx, sy, sx + 150, sy, 900, 1.5)
n_sel = js("return document.querySelectorAll('.pdf-text-line.is-selected').length")
n_sheet = js("return document.querySelectorAll('.anno-typesheet').length")
print('  is-selected=%s  类型弹层=%s' % (n_sel, n_sheet))
neg_ok = (n_sel == 0 and n_sheet == 0)
print('  → %s' % ('✅ 非编辑模式下划选无效（「文本」选项没有被空置）'
                   if neg_ok else '❌ 划选竟然生效了 —— 「文本」选项形同虚设'))
shot('2-negative.png')

print()
print('=== ③ 进编辑模式 → 点「文本」选项 ===')
b = center_of("document.getElementById('reader-annotate')")
if not b or b[1] <= 0:
    raise SystemExit('编辑按钮不可见')
tap(b[0], b[1], 2.5)
print('  is-annotating=%s'
      % js("return document.getElementById('reader').classList.contains('is-annotating')"))
print('  编辑栏选项: %s' % js("""
    var tabs = document.querySelectorAll('.reader-edit-tab');
    var out = [];
    for (var i = 0; i < tabs.length; i++) {
        out.push((tabs[i].getAttribute('data-edit-mode') || '?') + ':'
                 + (tabs[i].textContent || '').trim());
    }
    return JSON.stringify(out);
"""))

tb = js("""
    var t = document.querySelector('.reader-edit-tab[data-edit-mode="text"]');
    if (!t) return null;
    var r = t.getBoundingClientRect();
    if (!r.width) return null;
    return [r.left + r.width / 2, r.top + r.height / 2];
""")
if not tb:
    raise SystemExit('找不到「文本」选项')
print('  「文本」选项位置 (%.0f,%.0f)' % (tb[0], tb[1]))
tap(tb[0], tb[1], 2.0)
print('  is-text-mode=%s'
      % js("return document.getElementById('reader').classList.contains('is-text-mode')"))
print('  文字层 pointer-events=%s' % js("""
    var l = document.querySelector('.pdf-text-layer');
    return l ? getComputedStyle(l).pointerEvents : '-';
"""))
print('  .anno-block pointer-events=%s' % js("""
    var b = document.querySelector('.anno-block');
    return b ? getComputedStyle(b).pointerEvents : '-';
"""))
shot('3-text-mode.png')

print()
print('=== ④ 划选 → 类型应**直接**浮出 ===')
row = find_row()
if not row:
    raise SystemExit('找不到可见文字行')
sx, sy = row['x'] + 2, row['y'] + row['h'] * 0.5
print('  目标词 "%s" @(%.0f,%.0f)' % (row['t'][:18], sx, sy))
print('  起点命中: %s' % js("""
    var e = document.elementFromPoint(%.0f, %.0f);
    return e ? (e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')) : 'null';
""" % (sx, sy)))

js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")
swipe(sx, sy, sx + 150, sy, 900, 2.5)

n_hl = js("return document.querySelectorAll('.pdf-text-line.is-selected').length")
n_sheet = js("return document.querySelectorAll('.anno-typesheet').length")
opts = js("""
    var o = document.querySelectorAll('.anno-typeopt');
    var out = [];
    for (var i = 0; i < o.length; i++) out.push((o[i].textContent || '').trim());
    return JSON.stringify(out);
""")
print('  is-selected=%s  类型弹层=%s' % (n_hl, n_sheet))
print('  类型选项=%s' % opts)
shot('4-type-sheet.png')

if not n_sheet:
    print('  ❌ 划选后类型没有直接浮出')
    cdp.close()
    raise SystemExit(1)
print('  ✅ 划选后类型**直接**浮出')

print()
print('=== ⑤ 选类型 → 落笔 ===')
before = js("JSON.stringify((window.ScholariusReader.getTextMarks||function(){return[]})())")
print('  落笔前 textMarks: %s' % before)

tgt = js("""
    var o = document.querySelectorAll('.anno-typeopt');
    for (var i = 0; i < o.length; i++) {
        var tx = (o[i].textContent || '');
        if (tx.indexOf('摘要') >= 0 || tx.toLowerCase().indexOf('abstract') >= 0) {
            var r = o[i].getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2, tx.trim()];
        }
    }
    return null;
""")
if not tgt:
    raise SystemExit('找不到「摘要」选项')
print('  选「%s」' % tgt[2])
tap(tgt[0], tgt[1], 2.0)

after = js("JSON.stringify((window.ScholariusReader.getTextMarks||function(){return[]})())")
print('  落笔后 textMarks: %s' % after)
print('  弹层已关: %s' % (js("return document.querySelectorAll('.anno-typesheet').length") == 0))
print('  高亮已清: %s' % js("return document.querySelectorAll('.pdf-text-line.is-selected').length"))
print('  仍在文本模式: %s'
      % js("return document.getElementById('reader').classList.contains('is-text-mode')"))
shot('5-after.png')

print()
print('=== ⑥ 再划一次（验证可连续标注）===')
row2 = find_row()
if row2:
    s2x, s2y = row2['x'] + 2, row2['y'] + row2['h'] * 0.5
    js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")
    swipe(s2x, s2y, s2x + 140, s2y, 900, 2.2)
    print('  第二次划选后类型弹层=%s'
          % js("return document.querySelectorAll('.anno-typesheet').length"))
    shot('6-second.png')
print()
print('截图: %s' % OUT)
cdp.close()
