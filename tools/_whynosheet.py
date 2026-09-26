# -*- coding: utf-8 -*-
"""为什么 finish 没触发类型弹层？观测 pointer 事件与 currentSelection。"""
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


print('=== 记录 pointer 事件（文字层上）===')
print(js("""
    if (!window.__p) {
        window.__p = [];
        ['pointerdown','pointermove','pointerup','pointercancel'].forEach(function (n) {
            document.addEventListener(n, function (ev) {
                if (window.__p.length > 200) return;
                var t = ev.target;
                window.__p.push(n + ' @' + Math.round(ev.clientX) + ','
                    + Math.round(ev.clientY) + ' ' + (t ? (t.tagName + '.'
                    + (typeof t.className === 'string'
                       ? t.className.split(' ')[0] : '')) : 'null'));
            }, true);
        });
    }
    return 'ok';
"""))

line = json.loads(js("""
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    var vp = window.innerHeight;
    var byRow = {};
    for (var i = 0; i < ls.length; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.width < 20 || r.height < 2) continue;
        if (r.top < 140 || r.bottom > vp - 120) continue;
        var k = String(ls[i].dataset.row);
        if (!byRow[k]) byRow[k] = [];
        byRow[k].push(r);
    }
    var ks = Object.keys(byRow);
    if (!ks.length) return 'null';
    var row = ks[0];
    var rs = byRow[row];
    var lo = 1e9, hi = -1e9, y = 0;
    for (var j = 0; j < rs.length; j++) {
        if (rs[j].left < lo) lo = rs[j].left;
        if (rs[j].right > hi) hi = rs[j].right;
        y = rs[j].top + rs[j].height / 2;
    }
    return JSON.stringify({ row: row, lo: lo, hi: hi, y: y });
"""))
print('  行 row=%s x %.0f→%.0f y=%.0f' % (line['row'], line['lo'], line['hi'], line['y']))

sx, ex, sy = line['lo'] + 4, line['hi'] - 4, line['y']
js("window.__p = []; return 1")

cdp.touch('touchStart', [(sx, sy)])
time.sleep(0.1)
for i in range(1, 31):
    cdp.touch('touchMove', [(sx + (ex - sx) * i / 30.0, sy)])
    time.sleep(0.02)
time.sleep(0.06)
cdp.touch('touchEnd', [])
time.sleep(2.0)

print()
print('=== pointer 事件 ===')
print(js("""
    var a = window.__p;
    return '  共 ' + a.length + ' 条:\\n' + a.slice(0, 6).map(function (x) {
        return '    ' + x; }).join('\\n') + '\\n    ...\\n'
        + a.slice(-5).map(function (x) { return '    ' + x; }).join('\\n');
"""))
print()
print('=== 结果 ===')
print(js("""
    var out = [];
    out.push('  高亮词 = '
             + document.querySelectorAll('.pdf-text-line.is-selected').length);
    out.push('  类型弹层 = '
             + document.querySelectorAll('.anno-typesheet').length);
    out.push('  提示(hint) = '
             + document.querySelectorAll('.reader-content .reader-hint').length);
    out.push('  文字线 = '
             + document.querySelectorAll('.pdf-text-line').length);
    var st = document.querySelector('.anno-tip');
    out.push('  anno-tip = ' + (st ? ('「' + st.textContent + '」 visible='
             + st.classList.contains('is-visible') + ')') : '没有'));
    return out.join('\\n');
"""))
cdp.close()
