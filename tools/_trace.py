# -*- coding: utf-8 -*-
"""row=1 的词逐词追踪：每个词配到了哪个块。"""
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
    /* 本页块（按 lastBlocks 顺序） */
    var pb = [];
    for (var i = 0; i < b.length; i++) {
        if (b[i].page === 2 && b[i].line != null && b[i].text) pb.push(b[i]);
    }
    out.push('page2 块数 = ' + pb.length);
    out.push('前 6 个块:');
    for (var j = 0; j < 6; j++) {
        out.push('  [' + j + '] line=' + pb[j].line
                 + ' ' + JSON.stringify(pb[j].text.slice(0, 60)));
    }

    /* 模拟 row=1 的配对 */
    var words = ['sequences.', 'Aligning', 'the', 'positions', 'to', 'steps',
                 'in', 'computation', 'time,', 'they', 'generate',
                 'sequence', 'of', 'hidden'];
    var at = 0, firstHit = -1, lastHit = -1, budget = 3;
    out.push('');
    out.push('逐词配对（初始 at=0）:');
    for (var k = 0; k < words.length; k++) {
        var w = words[k], found = false;
        for (var look = at; look < pb.length; look++) {
            if (pb[look].text.indexOf(w) >= 0) {
                at = look;
                if (firstHit < 0) firstHit = look;
                lastHit = look;
                found = true;
                out.push('  「' + w + '」→ 块[' + look + '] line='
                         + pb[look].line + '  ' + JSON.stringify(pb[look].text.slice(0, 40)));
                break;
            }
            if (budget <= 0) break;
            budget--;
        }
        if (!found) {
            out.push('  「' + w + '」→ ❌ 没找到（at=' + at + ' budget=' + budget + '）');
            if (firstHit >= 0) lastHit = at;
        }
    }
    out.push('');
    out.push('结果 from=' + (firstHit >= 0 ? pb[firstHit].line : '-')
             + ' to=' + (lastHit >= 0 ? pb[lastHit].line : '-')
             + ' at=' + at + ' budget=' + budget);
    return out.join('\\n');
"""))
cdp.close()
