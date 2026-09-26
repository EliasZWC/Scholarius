# -*- coding: utf-8 -*-
"""看 lastBlocks 的 y0/y1 有没有 —— 决定能不能用 y 对齐换算行号。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


print('=== lastBlocks 的字段（含 y0/y1 吗）===')
print(js("""
    var r = window.ScholariusReader;
    var b = r.getBlocks();
    var out = [];
    out.push('  第 0 个块的字段: ' + JSON.stringify(Object.keys(b[0])));
    out.push('  第 0 个块: ' + JSON.stringify(b[0]).slice(0, 260));
    out.push('');
    out.push('  前 14 个块（page / line / y0 / y1 / kind / text）:');
    for (var i = 0; i < 14 && i < b.length; i++) {
        out.push('   #' + i
                 + ' p' + b[i].page
                 + ' line=' + b[i].line
                 + ' y0=' + (b[i].y0 != null ? b[i].y0.toFixed(4) : 'null')
                 + ' y1=' + (b[i].y1 != null ? b[i].y1.toFixed(4) : 'null')
                 + ' ' + b[i].kind
                 + ' 「' + (b[i].text || '').replace(/\\n/g, '⏎').slice(0, 26) + '」');
    }
    return out.join('\\n');
"""))
cdp.close()
