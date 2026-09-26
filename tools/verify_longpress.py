# -*- coding: utf-8 -*-
"""验证长按门槛（用户问题 4）。

要验三件事：
  ① 快速轻点/短拖（<450ms）→ **不**进入划选（不高亮、不弹层）
  ② 长按（>=450ms）→ 震动 + 进入划选
  ③ 长按后拖动 → 高亮成立、弹层出现

⚠️ 真手指：用 CDP 触摸注入，可控时长（adb input swipe 不能精确控"按住不动"）。
⚠️ 震动本身在模拟器上**没有物理反馈**，但可以 hook `navigator.vibrate`
   验证"是否被调用、参数是多少"。
"""
import io
import json
import os
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402
from emu_js import PORT  # noqa: E402

ADB = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk',
                   'platform-tools', 'adb.exe')
PKG = 'com.eliaszwc.scholarius.debug'

import subprocess  # noqa: E402


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


# ⚠️ 应用没在前台时 ensure_ready 会失败（devtools socket 不存在）。
#    必须先拉起来，再找 socket。
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(3)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')


def pp(v):
    return str(int(round(v * DPR)))


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


print('##### 冷启动 → 登录 → 文献 → 原始视图 → 编辑 → 「文本」 #####')
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(14)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
DPR = js('return window.devicePixelRatio')

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

# ── hook navigator.vibrate，记录调用 ──────────────────────────
print()
print('  挂 vibrate 钩子…')
print(js("""
    window.__vib = [];
    if (!window.__vibHooked) {
        window.__vibHooked = true;
        try {
            var orig = navigator.vibrate ? navigator.vibrate.bind(navigator) : null;
            navigator.vibrate = function (a) {
                window.__vib.push(a);
                if (orig) { try { return orig(a); } catch (e) {} }
                return true;
            };
        } catch (e) { return '钩不上: ' + e; }
    }
    return '已挂';
"""))

FAIL = []


def check(label, ok, detail=''):
    print('    %s %s%s' % ('OK  ' if ok else 'FAIL', label,
                           ('  ' + str(detail)) if detail else ''))
    if not ok:
        FAIL.append(label)


def find_line(skip=0):
    return json.loads(js("""
        var lays = document.querySelectorAll('.pdf-text-layer');
        var vp = window.innerHeight;
        var cands = [];
        for (var L = 0; L < lays.length; L++) {
            var ls = lays[L].querySelectorAll('.pdf-text-line');
            for (var i = 0; i < ls.length; i++) {
                var r = ls[i].getBoundingClientRect();
                if (r.width < 60 || r.height < 2) continue;
                if (r.top < 140 || r.bottom > vp - 130) continue;
                var row = L + ':' + ls[i].dataset.row;
                if (cands.indexOf(row) >= 0) continue;
                cands.push(row);
            }
        }
        if (cands.length <= %d) return 'null';
        var row = cands[%d];
        var parts = row.split(':');
        var lay = lays[parseInt(parts[0], 10)];
        var ls2 = lay.querySelectorAll('.pdf-text-line');
        for (var j = 0; j < ls2.length; j++) {
            if (String(ls2[j].dataset.row) !== parts[1]) continue;
            var r2 = ls2[j].getBoundingClientRect();
            return JSON.stringify({ lo: r2.left, hi: r2.right,
                y: r2.top + r2.height / 2,
                words: ls2[j].textContent });
        }
        return 'null';
    """ % (skip, skip)))


def state():
    return json.loads(js("""
        return JSON.stringify({
            hl: document.querySelectorAll('.pdf-text-line.is-selected').length,
            sheet: document.querySelectorAll('.anno-typesheet').length,
            vib: (window.__vib || []).length
        });
    """))


ln = find_line(0)
print()
print('  目标行: 「%s」 x %.0f..%.0f y=%.0f'
      % (ln['words'][:50], ln['lo'], ln['hi'], ln['y']))
sx, ex, sy = ln['lo'] + 6, ln['hi'] - 6, ln['y']

# ── ① 快速短拖（110ms，远小于 450ms）→ 不该选上 ─────────────
print()
print('  ── ① 快速短拖 110ms（应无效）──')
js("window.__vib = []; return 1")
cdp.touch('touchStart', [(sx, sy)])
time.sleep(0.03)
for i in range(1, 5):
    cdp.touch('touchMove', [(sx + (ex - sx) * i / 5.0, sy)])
    time.sleep(0.02)
cdp.touch('touchEnd', [])
time.sleep(1.2)
s = state()
print('    高亮=%s 弹层=%s 震动次数=%s' % (s['hl'], s['sheet'], s['vib']))
check('快速短拖不选中', s['hl'] == 0 and s['sheet'] == 0,
      'hl=%d sheet=%d' % (s['hl'], s['sheet']))

# ── ② 长按 600ms（按住不动）→ 应震动 ────────────────────────
print()
print('  ── ② 长按 600ms 不动（应震动）──')
js("window.__vib = []; return 1")
cdp.touch('touchStart', [(sx, sy)])
time.sleep(0.62)
vib_after_press = js("return JSON.stringify(window.__vib || [])")
print('    按住期间震动记录: %s' % vib_after_press)
# 长按后拖动
for i in range(1, 9):
    cdp.touch('touchMove', [(sx + (ex - sx) * i / 8.0, sy)])
    time.sleep(0.025)
time.sleep(0.1)
cdp.touch('touchEnd', [])
time.sleep(1.5)
s2 = state()
print('    高亮=%s 弹层=%s' % (s2['hl'], s2['sheet']))
check('长按触发了震动', json.loads(vib_after_press) != [],
      vib_after_press)
check('长按后能选中', s2['hl'] > 0, 'hl=%d' % s2['hl'])
check('松手后弹层出现', s2['sheet'] > 0, 'sheet=%d' % s2['sheet'])

# ── ③ 轻点一下（不移动）→ 不该触发震动 ─────────────────────
print()
print('  ── ③ 轻点 120ms 不移动（不该震动）──')
if s2['sheet'] > 0:
    js("var b=document.querySelector('.anno-typebackdrop'); if(b) b.click(); return 1")
    time.sleep(0.8)
js("window.__vib = []; return 1")
cdp.touch('touchStart', [(sx, sy)])
time.sleep(0.12)
cdp.touch('touchEnd', [])
time.sleep(1.2)
vib3 = js("return JSON.stringify(window.__vib || [])")
s3 = state()
print('    震动记录=%s 高亮=%s 弹层=%s' % (vib3, s3['hl'], s3['sheet']))
check('轻点不震动', json.loads(vib3) == [], vib3)

print()
print('=' * 52)
if FAIL:
    print('FAIL %d 项:' % len(FAIL))
    for f in FAIL:
        print('   · ' + f)
else:
    print('OK 全部通过')
cdp.close()
