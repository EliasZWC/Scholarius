# -*- coding: utf-8 -*-
"""直接看 page=2 的块的 y 范围，与词的 style.top 比对。"""
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


print('=== page=2 的最前面 14 个块 ===')
print(js("""
    var out = [];
    var b = window.ScholariusReader.getBlocks();
    var n = 0;
    for (var i = 0; i < b.length && n < 14; i++) {
        if (b[i].page !== 2) continue;
        out.push('    #' + i + ' line=' + b[i].line
                 + ' y0=' + b[i].y0.toFixed(4)
                 + ' y1=' + b[i].y1.toFixed(4)
                 + ' ' + b[i].kind
                 + ' 「' + (b[i].text || '').replace(/\\n/g, '⏎').slice(0, 34) + '」');
        n++;
    }
    return out.join('\\n');
"""))

print()
print('=== 有内容的两个文字层：词数、style.top 分布、所属 slot 的 data-page ===')
print(js("""
    var out = [];
    var lays = document.querySelectorAll('.pdf-text-layer');
    for (var i = 0; i < lays.length; i++) {
        var ls = lays[i].querySelectorAll('.pdf-text-line');
        if (!ls.length) continue;
        var slot = lays[i].closest('.pdf-slot');
        var tops = [];
        for (var j = 0; j < ls.length; j++) {
            var t = parseFloat(ls[j].style.top);
            if (!isNaN(t)) tops.push(t);
        }
        tops.sort(function (a, b) { return a - b; });
        out.push('  层[' + i + '] slot.data-page=' + (slot ? slot.dataset.page : '-')
                 + ' 词数=' + ls.length
                 + ' 词 y 范围=' + tops[0].toFixed(4) + '..'
                 + tops[tops.length - 1].toFixed(4));
        out.push('       第一个词「' + ls[0].textContent + '」top='
                 + ls[0].style.top);
        out.push('       row=0 的词: 「'
                 + Array.prototype.filter.call(ls, function (s) {
                       return s.dataset.row === '0'; })
                     .map(function (s) { return s.textContent; })
                     .join(' ').slice(0, 60) + '」');
    }
    var all = document.querySelectorAll('.pdf-slot');
    out.push('  slots: ' + Array.prototype.map.call(all, function (s) {
        return s.dataset.page + '(' + s.querySelectorAll('.pdf-text-line').length + ')';
    }).join(' '));
    return out.join('\\n');
"""))
cdp.close()
