# -*- coding: utf-8 -*-
"""textLines 与服务端 blocks 到底怎么对应？"""
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


print(js("""
    var out = [];
    var b = window.ScholariusReader.getBlocks();
    out.push('blocks 数 = ' + b.length);
    /* 有多少块的 text 含 \\n */
    var withNl = 0, rows = 0;
    for (var i = 0; i < b.length; i++) {
        var n = (b[i].text || '').split('\\n').length;
        rows += n;
        if (n > 1) withNl++;
    }
    out.push('含 \\n 的块 = ' + withNl);
    out.push('块的"行数"合计 = ' + rows);
    out.push('最大 line 值 = ' + Math.max.apply(null,
        b.map(function (x) { return x.line; })));
    out.push('');
    out.push('最后 5 个块:');
    for (var j = Math.max(0, b.length - 5); j < b.length; j++) {
        out.push('  #' + j + ' line=' + b[j].line
                 + ' page=' + b[j].page
                 + ' 「' + (b[j].text || '').replace(/\\n/g, '⏎').slice(0, 30) + '」');
    }
    return out.join('\\n');
"""))
cdp.close()
