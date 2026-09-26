# -*- coding: utf-8 -*-
"""录屏：在模拟器上真实走一遍「划选文字 → 落笔成标注」的全过程。

⚠️ 用 adb shell screenrecord 录真机（模拟器）画面，不是合成演示。
   录的同时用真手指（adb input）操作，所以画面里看到的每一步都是
   真实发生的触摸结果。

⚠️ 唯一非真手指处：登录（真实环境走 GitHub OAuth，自动化点不掉）。
   这一步在画面里会显示登录页一闪而过 —— 录屏里会标注出来。
"""
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
VID = os.path.join(OUT, 'demo.mp4')


def adb(*a, **kw):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True, **kw)


print('##### 冷启动 #####')
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
    d = __import__('json').loads(info)
    print('  👆 %s @(%.0f,%.0f)' % (label, d['x'], d['y']))
    tap(d['x'], d['y'], wait)
    return True


# ── 先把应用走到"文本模式"（正式录制前的准备，不录这段）─────────────
for _ in range(60):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
if js("return !!document.querySelector('.login.is-open');") is True:
    print('  ⚠️（准备阶段）登录：用测试入口，真实环境走 OAuth')
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(2.5)

tap_el("document.querySelector('.doc-card')", 5.0, '文献卡片')
if js("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.42, 2.0)
if js("return document.querySelectorAll('.pdf-scroll').length") == 0:
    tap_el("document.getElementById('reader-view-toggle')", 6.0, '视图切换(眼睛)')
for _ in range(60):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)

tap_el("document.getElementById('reader-annotate')", 2.5, '编辑(铅笔)')
tap_el("document.querySelector('.reader-edit-tab[data-edit-mode=\"text\"]')",
       2.5, '底栏「文本」')

print('  准备就绪，文字层 %s 词'
      % js("return document.querySelectorAll('.pdf-text-line').length;"))

# ── 开始录屏 ──────────────────────────────────────────────────
print()
print('##### 开始录屏 #####')
adb('shell', 'rm', '-f', '/sdcard/_demo.mp4')
rec = subprocess.Popen(
    [ADB, 'shell', 'screenrecord', '--time-limit', '60',
     '--bit-rate', '6000000', '/sdcard/_demo.mp4'],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(2.0)   # 让 screenrecord 起好

try:
    vw = js('return [innerWidth, innerHeight]')
    print('  视口 %.0f x %.0f' % (vw[0], vw[1]))

    # ★ 先滚到页面中部，让"第 2 页正文"占据屏幕（录制更清楚）
    print('  滚动到正文位置…')
    adb('shell', 'input', 'swipe', pp(vw[0] / 2), pp(vw[1] * 0.30),
        pp(vw[0] / 2), pp(vw[1] * 0.62), '500')
    time.sleep(2.0)

    for rnd in range(1, 4):
        print()
        print('  ── 第 %d 轮：划选 + 落笔 ──' % rnd)

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
                hits.push({ l: rr.left, r: rr.right });
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
            return JSON.stringify({ lo: lo, hi: hi, y: y });
        """ % (rnd - 1, rnd - 1))
        if line == 'null':
            print('    （没有更多可用行）')
            break
        import json as _json
        ln = _json.loads(line)
        sx, ex, sy = ln['lo'] + 4, ln['hi'] - 4, ln['y']
        print('    划选 (%.0f,%.0f) → (%.0f,%.0f)' % (sx, sy, ex, sy))
        adb('shell', 'input', 'swipe', pp(sx), pp(sy), pp(ex), pp(sy), '1100')
        time.sleep(2.0)

        n = js("return document.querySelectorAll('.pdf-text-line.is-selected').length")
        sh = js("return document.querySelectorAll('.anno-typesheet').length")
        print('    → 高亮 %s 词，类型弹层 %s' % (n, sh))
        if not sh:
            print('    ⚠️ 弹层没出来，跳过落笔')
            continue
        time.sleep(1.0)

        ok = tap_el("""(function () {
            var o = document.querySelectorAll('.anno-typeopt');
            for (var i = 0; i < o.length; i++) {
                var t = (o[i].textContent || '');
                if (t.indexOf('作者') >= 0 || t.toLowerCase().indexOf('author') >= 0) return o[i];
            }
            return null;
        })()""", 2.5, '「作者」')
        time.sleep(1.5)

        m = js("""
            var b = window.ScholariusReader.getTextMarks();
            var best = null;
            for (var i = 0; i < b.length; i++) {
                if (b[i].type === 'author') best = b[i];
            }
            return best ? JSON.stringify(best) : 'none';
        """)
        print('    → 落笔结果 %s' % m)

        # 点别处，证明"标注不会消失、页面不会消失"
        tap(vw[0] / 2, vw[1] * 0.80, 2.0)
        left = js("return document.querySelectorAll('.pdf-text-line').length")
        hint = js("return document.querySelectorAll('.reader-content .reader-hint').length")
        print('    → 点别处后：文字层 %s 词，提示层 %s（0 才对）' % (left, hint))
        time.sleep(1.0)

    print()
    print('  ── 再展示：切回阅读视图看标注生效 ──')
    if js("return document.querySelectorAll('.pdf-scroll').length") > 0:
        tap_el("document.getElementById('reader-view-toggle')", 4.0, '视图切换')
    time.sleep(2.0)
    print('  reader = %s' % js("return document.getElementById('reader').className"))
    time.sleep(2.0)

finally:
    print()
    print('##### 停止录屏 #####')
    try:
        adb('shell', 'pkill', '-INT', 'screenrecord')
    except Exception:
        pass
    time.sleep(3.0)
    try:
        rec.terminate()
        rec.wait(timeout=8)
    except Exception:
        pass
    adb('pull', '/sdcard/_demo.mp4', VID)
    cdp.close()

size = os.path.getsize(VID) if os.path.exists(VID) else 0
print()
print('视频: %s  (%.1f MB)' % (VID, size / 1024.0 / 1024.0))
