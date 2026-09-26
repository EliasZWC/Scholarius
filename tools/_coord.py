# -*- coding: utf-8 -*-
"""查清：data-row（页内行号） ↔ textMarks 的 from/to（全局行号） 该怎么换算。

⚠️ 用户问题③「似乎跳到了最开头」—— 落笔到了 from:0,to:0。
   根因怀疑：rowsToGlobalFrom() 的换算错了。
"""
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


print('=== ① textLines（全局行号体系）===')
print('  textLines 长度: %s' % js("""
    var r = window.ScholariusReader;
    if (!r || !r.getTextLines) return 'no api';
    return r.getTextLines().length;
"""))
print('  前 5 行内容:')
print(js("""
    var r = window.ScholariusReader;
    if (!r || !r.getTextLines) return '  no api';
    var t = r.getTextLines();
    var out = [];
    for (var i = 0; i < Math.min(5, t.length); i++) {
        out.push('  [' + i + '] ' + JSON.stringify((t[i] || '').slice(0, 50)));
    }
    return out.join('\\n');
"""))

print()
print('=== ② lastBlocks 的 page 与 line ===')
print(js("""
    var r = window.ScholariusReader;
    if (!r || !r.getBlocks) return 'no api';
    var b = r.getBlocks() || [];
    var out = [];
    out.push('  块总数: ' + b.length);
    /* 前几个块 */
    for (var i = 0; i < Math.min(6, b.length); i++) {
        out.push('  [' + i + '] page=' + b[i].page + ' line=' + b[i].line
                 + ' kind=' + b[i].kind
                 + ' text=' + JSON.stringify((b[i].text || '').slice(0, 30)));
    }
    /* 每页的 line 范围 */
    var byPage = {};
    for (var j = 0; j < b.length; j++) {
        var p = b[j].page;
        if (!byPage[p]) byPage[p] = { min: 1e9, max: -1, n: 0 };
        if (b[j].line < byPage[p].min) byPage[p].min = b[j].line;
        if (b[j].line > byPage[p].max) byPage[p].max = b[j].line;
        byPage[p].n++;
    }
    out.push('  按页:');
    var keys = Object.keys(byPage).sort(function (a, c) { return a - c; });
    for (var k = 0; k < Math.min(keys.length, 8); k++) {
        var p = keys[k];
        out.push('    page=' + p + ': line ' + byPage[p].min + '..' + byPage[p].max
                 + ' (' + byPage[p].n + ' 块)');
    }
    return out.join('\\n');
"""))

print()
print('=== ③ 文字层的 data-row 范围 ===')
print(js("""
    var out = [];
    document.querySelectorAll('.pdf-text-layer').forEach(function (l, i) {
        if (i > 3) return;
        var rows = [];
        l.querySelectorAll('.pdf-text-line').forEach(function (s) {
            var v = parseInt(s.dataset.row, 10);
            if (!isNaN(v)) rows.push(v);
        });
        if (!rows.length) { out.push('  layer' + i + ': 无 data-row'); return; }
        var mn = Math.min.apply(null, rows), mx = Math.max.apply(null, rows);
        out.push('  layer' + i + ': data-row ' + mn + '..' + mx
                 + ' (' + rows.length + ' 个词)');
    });
    return out.join('\\n');
"""))

print()
print('=== ④ 已有的 author/abstract 标注落在哪些行 ===')
print(js("""
    var r = window.ScholariusReader;
    if (!r || !r.getTextMarks) return 'no api';
    var m = r.getTextMarks();
    var nb = m.filter(function (x) { return x.type !== 'body'; });
    return '  非 body 标注 ' + nb.length + ' 条:\\n'
         + nb.map(function (x) {
               return '    ' + JSON.stringify(x);
           }).join('\\n');
"""))
cdp.close()
