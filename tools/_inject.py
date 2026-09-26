# -*- coding: utf-8 -*-
"""哪种注入方式能让 pointer 事件真的到达文字层？

A. adb shell input swipe   （系统 InputManager）
B. CDP Input.dispatchTouchEvent （浏览器内核触摸路径）
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
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')
pp = lambda v: str(int(round(v * DPR)))  # noqa: E731

RECORDER = """
if (!window.__rec) {
    window.__rec = [];
    ['pointerdown','pointermove','pointerup','pointercancel',
     'touchstart','touchmove','touchend','touchcancel'
    ].forEach(function (n) {
        document.addEventListener(n, function (ev) {
            if (window.__rec.length > 300) return;
            var t = ev.target;
            window.__rec.push({
                ev: n,
                x: Math.round(ev.clientX !== undefined ? ev.clientX
                     : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : -1)),
                y: Math.round(ev.clientY !== undefined ? ev.clientY
                     : (ev.touches && ev.touches[0] ? ev.touches[0].clientY : -1)),
                tgt: t ? (t.tagName + '.' + (typeof t.className === 'string'
                     ? t.className.split(' ')[0] : '')) : 'null'
            });
        }, true);
    });
}
return 'ok';
"""


def reset_rec():
    js("window.__rec = []; return 1")


def show_rec(tag):
    r = js("return JSON.stringify(window.__rec || [])")
    arr = json.loads(r)
    print('    %s: 共 %d 条事件' % (tag, len(arr)))
    if arr:
        # 汇总：事件类型 → 次数，以及目标分布
        kinds = {}
        tgts = {}
        for e in arr:
            kinds[e['ev']] = (kinds[e['ev']] or 0) + 1
            tgts[e['tgt']] = (tgts[e['tgt']] or 0) + 1
        print('      类型: %s' % kinds)
        print('      目标: %s' % dict(list(tgts.items())[:6]))
        print('      首: %s' % arr[0])
        print('      末: %s' % arr[-1])
    return arr


def get_line():
    return json.loads(js("""
        var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
        var vp = window.innerHeight;
        var first = null;
        for (var i = 0; i < ls.length; i++) {
            var r = ls[i].getBoundingClientRect();
            if (r.width < 20 || r.height < 2) continue;
            if (r.top < 130 || r.bottom > vp - 110) continue;
            first = ls[i]; break;
        }
        if (!first) return 'null';
        var row = String(first.dataset.row);
        var hits = [];
        for (var j = 0; j < ls.length; j++) {
            if (String(ls[j].dataset.row) !== row) continue;
            var rr = ls[j].getBoundingClientRect();
            if (rr.top < 100 || rr.bottom > vp - 90) continue;
            hits.push({ l: rr.left, r: rr.right });
        }
        var lo = 1e9, hi = -1e9;
        for (var k = 0; k < hits.length; k++) {
            if (hits[k].l < lo) lo = hits[k].l;
            if (hits[k].r > hi) hi = hits[k].r;
        }
        var r0 = first.getBoundingClientRect();
        return JSON.stringify({ lo: lo, hi: hi, y: r0.top + r0.height / 2 });
    """))


def state():
    return js("""
        var sel = document.querySelectorAll('.pdf-text-line.is-selected').length;
        var sh = document.querySelectorAll('.anno-typesheet').length;
        var s = getSelection();
        return JSON.stringify({ hl: sel, sheet: sh,
            text: s ? String(s).length : 0 });
    """)


print('=== 准备 ===')
js(RECORDER)

line = get_line()
if line is None:
    print('  ⚠️ 取不到行 —— 当前 DOM:')
    print(js("""
        var out = [];
        var rd = document.getElementById('reader');
        out.push('    reader: ' + (rd ? rd.className : '-'));
        ['.pdf-scroll', '.pdf-slot', '.pdf-page-img', '.pdf-text-layer',
         '.pdf-text-line', '.anno-block'].forEach(function (s) {
            out.push('    ' + s + ' = ' + document.querySelectorAll(s).length);
        });
        var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
        var vp = window.innerHeight;
        var n = 0;
        for (var i = 0; i < ls.length && n < 12; i++) {
            var r = ls[i].getBoundingClientRect();
            if (r.width < 5) continue;
            out.push('    词 y=' + Math.round(r.top) + '..' + Math.round(r.bottom)
                     + ' x=' + Math.round(r.left) + '..' + Math.round(r.right)
                     + ' 「' + ls[i].textContent.slice(0, 14) + '」');
            n++;
        }
        out.push('    视口 ' + innerWidth + 'x' + vp);
        return out.join('\\n');
    """))
    raise SystemExit('取不到行')

sx, ex, sy = line['lo'] + 4, line['hi'] - 4, line['y']
print('  目标行 y=%.0f，x %.0f→%.0f' % (sy, sx, ex))

print()
print('=== A. adb shell input swipe ===')
reset_rec()
subprocess.run([ADB, 'shell', 'input', 'swipe', pp(sx), pp(sy),
                pp(ex), pp(sy), '1100'], capture_output=True, text=True)
time.sleep(1.5)
show_rec('A')
print('    结果: %s' % state())

print()
print('=== B. CDP Input.dispatchTouchEvent ===')
reset_rec()
cdp.touch('touchStart', [(sx, sy)])
time.sleep(0.06)
N = 24
for i in range(1, N + 1):
    cdp.touch('touchMove', [(sx + (ex - sx) * i / float(N), sy)])
    time.sleep(0.015)
time.sleep(0.05)
cdp.touch('touchEnd', [])
time.sleep(1.5)
show_rec('B')
print('    结果: %s' % state())

print()
print('=== C. CDP 但分更多步 + 稍慢（模拟真人拖拽节奏）===')
reset_rec()
cdp.touch('touchStart', [(sx, sy)])
time.sleep(0.12)
N = 40
for i in range(1, N + 1):
    cdp.touch('touchMove', [(sx + (ex - sx) * i / float(N), sy)])
    time.sleep(0.025)
time.sleep(0.08)
cdp.touch('touchEnd', [])
time.sleep(1.5)
show_rec('C')
print('    结果: %s' % state())
cdp.close()
