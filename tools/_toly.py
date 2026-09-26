# -*- coding: utf-8 -*-
"""测行距，以及"点在不同 y 上会命中哪一行"的容差窗口。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


print('=== 行的 y 分布与行距 ===')
print(js("""
    var out = [];
    var ls = document.querySelectorAll('.pdf-text-line');
    /* 按 data-row 聚行，取每行的 top */
    var byRow = {};
    var order = [];
    for (var i = 0; i < ls.length; i++) {
        var k = ls[i].dataset.row;
        if (!byRow[k]) { byRow[k] = []; order.push(parseInt(k, 10)); }
        byRow[k].push(ls[i]);
    }
    order.sort(function (a, b) { return a - b; });
    var mids = [];
    for (var j = 0; j < order.length; j++) {
        var w = byRow[order[j]][0];
        var r = w.getBoundingClientRect();
        mids.push({ row: order[j], top: r.top, h: r.height,
                    mid: r.top + r.height / 2 });
    }
    out.push('  行数: ' + mids.length);
    out.push('  每行渲染顺序的前 16 行（屏幕 y）:');
    for (var m = 0; m < Math.min(16, mids.length); m++) {
        var gap = (m > 0) ? (mids[m].mid - mids[m - 1].mid) : 0;
        out.push('    row=' + mids[m].row
                 + '  y=' + mids[m].top.toFixed(1)
                 + '..' + (mids[m].top + mids[m].h).toFixed(1)
                 + '  中线=' + mids[m].mid.toFixed(1)
                 + (m > 0 ? '  与上行距=' + gap.toFixed(1) + 'px' : ''));
    }
    /* 统计相邻行距的分布 */
    var gaps = [];
    for (var n = 1; n < mids.length; n++) {
        var g = mids[n].mid - mids[n - 1].mid;
        if (g > 1) gaps.push(g);
    }
    gaps.sort(function (a, b) { return a - b; });
    out.push('');
    out.push('  相邻行中线间距: n=' + gaps.length
             + '  最小=' + (gaps.length ? gaps[0].toFixed(1) : '-')
             + '  中位=' + (gaps.length ? gaps[Math.floor(gaps.length / 2)].toFixed(1) : '-')
             + '  最大=' + (gaps.length ? gaps[gaps.length - 1].toFixed(1) : '-'));
    var h = mids.length ? mids[0].h : 0;
    out.push('  行高 = ' + h.toFixed(1) + 'px');
    out.push('  ⚠️ 现在的 y 容差 = max(行高*0.5, 3) = '
             + Math.max(h * 0.5, 3).toFixed(1) + 'px  ← 手指很难落在这个窗口里');
    return out.join('\\n');
"""))

print()
print('=== 逐像素扫：点在不同 y 上，pointToCaret 会选到哪一行 ===')
print(js("""
    var out = [];
    var ls = document.querySelectorAll('.pdf-text-line');
    /* 找第一行的盒子作为基准 x */
    var base = null;
    for (var i = 0; i < ls.length; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.width > 20 && r.top > 0 && r.bottom < window.innerHeight) {
            base = r; break;
        }
    }
    if (!base) return '  没有可用行';
    var x = base.left + base.width / 2;
    out.push('  固定 x=' + x.toFixed(0) + '，y 从 ' + (base.top - 8).toFixed(0)
             + ' 扫到 ' + (base.bottom + 8).toFixed(0) + '：');
    for (var y = Math.floor(base.top - 8); y <= Math.ceil(base.bottom + 8); y++) {
        /* 复刻 pointToCaret 的逻辑 */
        var best = null, bestScore = Infinity;
        for (var j = 0; j < ls.length; j++) {
            var rr = ls[j].getBoundingClientRect();
            if (!rr.width) continue;
            var midY = rr.top + rr.height / 2;
            var dy = Math.abs(y - midY);
            var yTol = Math.max(rr.height * 0.5, 3);
            if (dy > yTol) continue;
            var dxx = 0;
            if (x < rr.left) dxx = rr.left - x;
            else if (x > rr.right) dxx = x - rr.right;
            var sc = dy * 20 + dxx;
            if (sc < bestScore) { bestScore = sc; best = rr; }
        }
        out.push('    y=' + y + ' → ' + (best
            ? '命中 y=' + best.top.toFixed(0) + '..' + best.bottom.toFixed(0)
              + ' (row ' + (function () {
                    for (var q = 0; q < ls.length; q++) {
                        if (ls[q].getBoundingClientRect().top === best.top) {
                            return ls[q].dataset.row;
                        }
                    }
                    return '?';
                 })() + ')'
            : '❌ 什么都没命中'));
    }
    return out.join('\\n');
"""))
cdp.close()
