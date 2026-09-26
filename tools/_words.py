# -*- coding: utf-8 -*-
"""第 2 轮的词去哪了？直接查块文本。"""
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


print('=== page=2 line 50..70 的块全文 ===')
print(js("""
    var out = [];
    var b = window.ScholariusReader.getBlocks();
    for (var i = 0; i < b.length; i++) {
        if (b[i].page !== 2) continue;
        if (b[i].line < 50 || b[i].line > 70) continue;
        out.push('  line=' + b[i].line
                 + ' y0=' + b[i].y0.toFixed(4)
                 + ' y1=' + b[i].y1.toFixed(4)
                 + '  ' + JSON.stringify(b[i].text));
    }
    return out.join('\\n');
"""))

print()
print('=== 搜 "sequences." 与 "Aligning" 出现在哪些块 ===')
print(js("""
    var out = [];
    var b = window.ScholariusReader.getBlocks();
    ['sequences.', 'Aligning', 'states', 'inherently', 'Recurrent']
        .forEach(function (w) {
            var hits = [];
            for (var i = 0; i < b.length; i++) {
                if ((b[i].text || '').indexOf(w) >= 0) {
                    hits.push('p' + b[i].page + '/line' + b[i].line);
                }
            }
            out.push('  「' + w + '」 → ' + (hits.length ? hits.join(', ') : '❌ 找不到'));
        });
    return out.join('\\n');
"""))

print()
print('=== textLines 里 "sequences." 在哪一行 ===')
print(js("""
    var r = window.ScholariusReader;
    if (!r.getTextLines) return '  没有 getTextLines API';
    var t = r.getTextLines();
    var out = ['  textLines 共 ' + t.length + ' 行'];
    ['sequences.', 'Aligning', 'inherently'].forEach(function (w) {
        var hits = [];
        for (var i = 0; i < t.length; i++) {
            if ((t[i] || '').indexOf(w) >= 0) hits.push(i);
        }
        out.push('  「' + w + '」 在行 ' + (hits.length ? hits.join(', ') : '❌ 无'));
    });
    return out.join('\\n');
"""))
cdp.close()
