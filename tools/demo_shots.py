# -*- coding: utf-8 -*-
"""在录屏的同时抓关键帧截图 —— 作为"视频里确实发生了这些事"的静态证据。

⚠️ 主机没有 ffmpeg，所以无法从 mp4 抽帧；改为在同样流程里
   在关键时刻 adb screencap，与 mp4 一一对应。
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
N = [0]


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


def shot(tag):
    N[0] += 1
    adb('shell', 'screencap', '-p', '/sdcard/_f.png')
    name = 'demo-%02d-%s.png' % (N[0], tag)
    adb('pull', '/sdcard/_f.png', os.path.join(OUT, name))
    print('    📸 %s' % name)
    return name


print('##### 冷启动 → 编辑 + 文本模式 #####')
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(14)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
DPR = cdp.evaluate('return window.devicePixelRatio')


def js(c):
    return cdp.evaluate(c)


def pp(v):
    return str(int(round(v * DPR)))


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
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(2.5)

tap_el("document.querySelector('.doc-card')", 5.0, '文献卡片')
if js("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.42, 2.0)
if js("return document.querySelectorAll('.pdf-scroll').length") == 0:
    tap_el("document.getElementById('reader-view-toggle')", 6.0, '视图切换')
for _ in range(60):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)
tap_el("document.getElementById('reader-annotate')", 2.5, '编辑')
tap_el("document.querySelector('.reader-edit-tab[data-edit-mode=\"text\"]')",
       2.5, '「文本」')
shot('01-文本模式')

vw = js('return [innerWidth, innerHeight]')
for rnd in range(1, 4):
    print()
    print('  ── 第 %d 轮 ──' % rnd)
    line = js("""
        var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
        var vp = window.innerHeight;
        var cands = [];
        for (var i = 0; i < ls.length; i++) {
            var r = ls[i].getBoundingClientRect();
            if (r.width < 20 || r.height < 2) continue;
            if (r.top < 150 || r.bottom > vp - 130) continue;
            var row = String(ls[i].dataset.row);
            if (cands.indexOf(row) >= 0) continue;
            cands.push(row);
        }
        if (cands.length <= %d) return 'null';
        var row = cands[%d];
        var hits = [];
        for (var j = 0; j < ls.length; j++) {
            if (String(ls[j].dataset.row) !== row) continue;
            var rr = ls[j].getBoundingClientRect();
            if (rr.top < 120 || rr.bottom > vp - 110) continue;
            if (rr.width < 5) continue;
            hits.push({ l: rr.left, r: rr.right, t: ls[j].textContent });
        }
        if (hits.length < 3) return 'null';
        var lo = 1e9, hi = -1e9, y = 0;
        for (var k = 0; k < hits.length; k++) {
            if (hits[k].l < lo) lo = hits[k].l;
            if (hits[k].r > hi) hi = hits[k].r;
        }
        for (var m = 0; m < ls.length; m++) {
            if (String(ls[m].dataset.row) === row) {
                var r0 = ls[m].getBoundingClientRect();
                y = r0.top + r0.height / 2; break;
            }
        }
        return JSON.stringify({ lo: lo, hi: hi, y: y,
            words: hits.map(function (h) { return h.t; }).join(' ') });
    """ % (rnd - 1, rnd - 1))
    if line == 'null':
        print('    （没有更多可用行）')
        break
    ln = json.loads(line)
    sx, ex, sy = ln['lo'] + 4, ln['hi'] - 4, ln['y']
    print('    划 "%.60s"' % ln['words'])
    adb('shell', 'input', 'swipe', pp(sx), pp(sy), pp(ex), pp(sy), '1100')
    time.sleep(2.0)
    shot('1%d-划选后' % rnd)
    n = js("return document.querySelectorAll('.pdf-text-line.is-selected').length")
    sh = js("return document.querySelectorAll('.anno-typesheet').length")
    print('    高亮 %s 词 / 弹层 %s' % (n, sh))
    if not sh:
        continue
    tap_el("""(function () {
        var o = document.querySelectorAll('.anno-typeopt');
        for (var i = 0; i < o.length; i++) {
            var t = (o[i].textContent || '');
            if (t.indexOf('作者') >= 0 || t.toLowerCase().indexOf('author') >= 0) return o[i];
        }
        return null;
    })()""", 2.5, '「作者」')
    shot('2%d-落笔' % rnd)
    m = js("""
        var b = window.ScholariusReader.getTextMarks();
        var best = null;
        for (var i = 0; i < b.length; i++) if (b[i].type === 'author') best = b[i];
        return best ? JSON.stringify(best) : 'none';
    """)
    print('    落笔 → %s' % m)
    tap(vw[0] / 2, vw[1] * 0.80, 2.0)
    shot('3%d-点别处' % rnd)
    left = js("return document.querySelectorAll('.pdf-text-line').length")
    hint = js("return document.querySelectorAll('.reader-content .reader-hint').length")
    print('    点别处后 文字 %s / 提示 %s' % (left, hint))

print()
print('  ── 切阅读视图 ──')
if js("return document.querySelectorAll('.pdf-scroll').length") > 0:
    tap_el("document.getElementById('reader-view-toggle')", 4.0, '视图切换')
time.sleep(2.0)
shot('40-阅读视图')
print('  reader = %s' % js("return document.getElementById('reader').className"))
cdp.close()
print()
print('截图: %s' % OUT)
