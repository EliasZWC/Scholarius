# -*- coding: utf-8 -*-
"""把 rowsToGlobalFrom 的入参和块数据打出来 —— 直接看数字。"""
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


print('=== 选中一个词，直接读它的 style.top 与所属 slot ===')
print(js("""
    var out = [];
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    var vp = window.innerHeight;
    var target = null;
    for (var i = 0; i < ls.length; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.width < 20 || r.height < 2) continue;
        if (r.top < 140 || r.bottom > vp - 120) continue;
        target = ls[i]; break;
    }
    if (!target) return '  没有可用行';
    var lay = target.closest('.pdf-text-layer');
    var slot = target.closest('.pdf-slot');
    out.push('  词「' + target.textContent + '」');
    out.push('    style.top   = ' + target.style.top);
    out.push('    parseFloat  = ' + parseFloat(target.style.top));
    out.push('    dataset.row = ' + target.dataset.row);
    out.push('    slot.dataset.page = ' + (slot ? slot.dataset.page : '无 slot'));
    out.push('    slot 是第几个 = '
             + (slot ? Array.prototype.indexOf.call(
                   document.querySelectorAll('.pdf-slot'), slot) : -1));

    var all = document.querySelectorAll('.pdf-slot');
    out.push('  ── 所有 slot ──');
    for (var j = 0; j < all.length; j++) {
        var rr = all[j].getBoundingClientRect();
        out.push('    [' + j + '] data-page=' + all[j].dataset.page
                 + ' y=' + Math.round(rr.top) + '..' + Math.round(rr.bottom)
                 + ' 词数=' + all[j].querySelectorAll('.pdf-text-line').length);
    }

    out.push('  ── lastBlocks 首页的 y 范围 ──');
    var b = window.ScholariusReader.getBlocks();
    var n = 0;
    for (var k = 0; k < b.length && n < 10; k++) {
        if (b[k].page !== 1) continue;
        out.push('    #' + k + ' page=' + b[k].page
                 + ' line=' + b[k].line
                 + ' y0=' + b[k].y0.toFixed(4)
                 + ' y1=' + b[k].y1.toFixed(4)
                 + ' 「' + (b[k].text || '').replace(/\\n/g, '⏎').slice(0, 22) + '」');
        n++;
    }
    out.push('  blocks 里 page 的取值: '
             + JSON.stringify(Array.from(new Set(b.map(function (x) {
                   return x.page; }))).slice(0, 12)));
    return out.join('\\n');
"""))
cdp.close()
