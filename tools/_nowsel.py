# -*- coding: utf-8 -*-
"""在当前（正确的）状态下：文字层能被点到吗？划选能成立吗？"""
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


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


print('=== ① 文字层上的点，hit-test 返回谁 ===')
print(js("""
    var out = [];
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    var vp = window.innerHeight;
    var n = 0, own = 0, other = {};
    for (var i = 0; i < ls.length; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.width < 20 || r.height < 2) continue;
        if (r.top < 0 || r.bottom > vp) continue;
        var cx = r.left + 4, cy = r.top + r.height / 2;
        var h = document.elementFromPoint(cx, cy);
        n++;
        var k = h ? (h.tagName + '.' + (typeof h.className === 'string'
            ? h.className.split(' ').slice(0, 2).join('.') : '')) : 'null';
        if (h && h.classList && h.classList.contains('pdf-text-line')) own++;
        else other[k] = (other[k] || 0) + 1;
        if (n >= 40) break;
    }
    out.push('  检查 ' + n + ' 个可见词：自命中 ' + own + ' 个');
    var ks = Object.keys(other);
    if (ks.length) {
        out.push('  被挡住的（谁在上面）:');
        ks.forEach(function (k) { out.push('    ' + k + ' × ' + other[k]); });
    } else {
        out.push('  ✅ 没有被挡住的');
    }
    /* 各层 pointer-events */
    out.push('');
    out.push('  关键元素的 pointer-events / z-index:');
    ['.pdf-text-layer', '.anno-layer', '.anno-block', '.pdf-page-img',
     '.pdf-slot', '.reader-body', 'body'].forEach(function (sel) {
        var e = document.querySelector(sel);
        if (!e) { out.push('    ' + sel + ': 没有'); return; }
        var cs = getComputedStyle(e);
        out.push('    ' + sel + ': pointer-events=' + cs.pointerEvents
                 + ' z-index=' + cs.zIndex
                 + ' touch-action=' + cs.touchAction
                 + ' position=' + cs.position);
    });
    /* 祖先链的 touch-action */
    out.push('');
    out.push('  文字层祖先链的 touch-action:');
    var e2 = ls.length ? ls[0] : null;
    while (e2 && e2 !== document.documentElement) {
        var cs2 = getComputedStyle(e2);
        out.push('    ' + e2.tagName + '.'
                 + (typeof e2.className === 'string'
                    ? e2.className.split(' ').slice(0, 2).join('.') : '')
                 + ' → ' + cs2.touchAction);
        e2 = e2.parentElement;
    }
    return out.join('\\n');
"""))

print()
print('=== ② 在一整行上真手指横拖 ===')
line = json.loads(js("""
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    var vp = window.innerHeight;
    var picks = [];
    for (var i = 0; i < ls.length; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.width < 20 || r.height < 2) continue;
        if (r.top < 130 || r.bottom > vp - 110) continue;
        picks.push(i);
    }
    if (!picks.length) return 'null';
    var first = ls[picks[0]];
    var row = String(first.dataset.row);
    var hits = [];
    for (var j = 0; j < ls.length; j++) {
        if (String(ls[j].dataset.row) !== row) continue;
        var rr = ls[j].getBoundingClientRect();
        if (rr.top < 100 || rr.bottom > vp - 90) continue;
        hits.push({ l: rr.left, r: rr.right, t: ls[j].textContent });
    }
    if (!hits.length) return 'null';
    var lo = 1e9, hi = -1e9;
    for (var k = 0; k < hits.length; k++) {
        if (hits[k].l < lo) lo = hits[k].l;
        if (hits[k].r > hi) hi = hits[k].r;
    }
    var r0 = first.getBoundingClientRect();
    return JSON.stringify({ row: row, lo: lo, hi: hi,
        y: r0.top + r0.height / 2, n: hits.length,
        words: hits.map(function (h) { return h.t; }).join(' ') });
"""))
print('  行 row=%s，%d 个词，x %.0f..%.0f，y=%.0f'
      % (line['row'], line['n'], line['lo'], line['hi'], line['y']))
print('    「%s」' % line['words'][:70])

sx, ex, sy = line['lo'] + 4, line['hi'] - 4, line['y']
print('  👉 swipe (%.0f,%.0f)→(%.0f,%.0f)' % (sx, sy, ex, sy))
adb('shell', 'input', 'swipe', pp(sx), pp(sy), pp(ex), pp(sy), '1100')
time.sleep(2.0)

print()
print(js("""
    var out = [];
    var sel = document.querySelectorAll('.pdf-text-line.is-selected');
    out.push('  高亮词数 = ' + sel.length);
    out.push('  高亮内容 = 「'
             + Array.prototype.map.call(sel, function (s) {
                   return s.textContent; }).join(' ').slice(0, 80) + '」');
    out.push('  data-row = '
             + Array.prototype.map.call(sel, function (s) {
                   return s.dataset.row; }).join(','));
    out.push('  类型弹层 = ' + document.querySelectorAll('.anno-typesheet').length);
    out.push('  浏览器选区 len = '
             + (getSelection() ? String(getSelection()).length : '-'));
    return out.join('\\n');
"""))
cdp.close()
