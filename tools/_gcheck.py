# -*- coding: utf-8 -*-
"""原生给的 g 到底是什么？"""
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


print('=== 桥直接返回的 pageLines（page=2）===')
print(js("""
    var b = window.ScholariusNative;
    if (!b) return '  没有桥';
    var raw = b.getPdfPageLines('devtest1', 2);
    var a = JSON.parse(raw);
    var out = ['  共 ' + a.length + ' 行'];
    for (var i = 0; i < Math.min(20, a.length); i++) {
        out.push('    [' + i + '] g=' + a[i].g
                 + ' y0=' + a[i].y0.toFixed(4)
                 + '  ' + JSON.stringify(a[i].t.slice(0, 42)));
    }
    /* g 的分布 */
    var gs = a.map(function (x) { return x.g; });
    var bad = gs.filter(function (v) { return v == null || v < 0; }).length;
    out.push('  g 为 -1/缺失 的行数 = ' + bad + ' / ' + a.length);
    var ok = gs.filter(function (v) { return v >= 0; });
    if (ok.length) {
        out.push('  g 范围 = ' + Math.min.apply(null, ok)
                 + '..' + Math.max.apply(null, ok));
    }
    return out.join('\\n');
"""))

print()
print('=== 对照：textLines 的真实行号（用块推算）===')
print(js("""
    var out = [];
    var r = window.ScholariusReader;
    var bl = r.getBlocks();
    /* blocks[i].line 就是 textLines 下标，找 'Recurrent' 相关的 */
    var want = ['Recurrent models', 'typically factor', 'sequences', 'Aligning',
                'sequence of hidden', 'previous hidden'];
    want.forEach(function (w) {
        var hits = [];
        for (var i = 0; i < bl.length; i++) {
            if ((bl[i].text || '').indexOf(w) >= 0) {
                hits.push('line' + bl[i].line + '(p' + bl[i].page + ')');
            }
        }
        out.push('  「' + w + '」 → ' + (hits.length ? hits.slice(0, 4).join(', ') : '❌'));
    });
    return out.join('\\n');
"""))
cdp.close()
