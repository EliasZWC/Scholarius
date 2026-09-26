# -*- coding: utf-8 -*-
"""对比 page2 的块与文字层的行，找出为什么配不上。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


print(js("""
    var out = [];
    var b = window.ScholariusReader.getBlocks();
    out.push('page2 块（line 53..62）:');
    var n = 0;
    for (var i = 0; i < b.length; i++) {
        if (b[i].page !== 2) continue;
        if (b[i].line < 53 || b[i].line > 62) continue;
        out.push('  line=' + b[i].line
                 + ' y0=' + b[i].y0.toFixed(4)
                 + ' y1=' + b[i].y1.toFixed(4)
                 + ' ' + JSON.stringify(b[i].text.slice(0, 95)));
        n++;
    }
    out.push('  （' + n + ' 个）');

    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    var byRow = {};
    var order = [];
    for (var j = 0; j < ls.length; j++) {
        var k = ls[j].dataset.row;
        if (!byRow[k]) { byRow[k] = []; order.push(parseInt(k, 10)); }
        byRow[k].push(ls[j]);
    }
    order.sort(function (a, c) { return a - c; });
    out.push('');
    out.push('文字层的行（前 10 行）:');
    for (var m = 0; m < 10 && m < order.length; m++) {
        var w = byRow[order[m]];
        out.push('  row=' + order[m]
                 + ' top=' + w[0].style.top
                 + ' gf=' + (w[0].dataset.gf || '-')
                 + ' gt=' + (w[0].dataset.gt || '-')
                 + ' 「' + w.map(function (e) { return e.textContent; })
                     .join(' ').slice(0, 95) + '」');
    }
    return out.join('\\n');
"""))
cdp.close()
