# -*- coding: utf-8 -*-
"""row=1 到底怎么配的？在真机上复刻完整配对过程（含 row 0 的影响）。"""
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
    var pb = [];
    for (var i = 0; i < b.length; i++) {
        if (b[i].page === 2 && b[i].line != null && b[i].text) pb.push(b[i]);
    }

    /* 复刻真正跑过的顺序：先 row0 再 row1 */
    function run(words, at) {
        var firstHit = -1, lastHit = -1, moved = false;
        var log = [];
        for (var k = 0; k < words.length; k++) {
            var w = words[k];
            if (!w) continue;
            if (pb[at].text.indexOf(w) >= 0) {
                if (firstHit < 0) firstHit = at;
                lastHit = at;
                log.push('  「' + w + '」→ 块[' + at + '] line=' + pb[at].line);
                continue;
            }
            if (firstHit >= 0 && moved) {
                log.push('  「' + w + '」→ 跳过(已移动过)');
                continue;
            }
            var nxt = at + 1;
            if (nxt < pb.length && pb[nxt].text.indexOf(w) >= 0) {
                at = nxt;
                if (firstHit < 0) firstHit = nxt; else moved = true;
                lastHit = nxt;
                log.push('  「' + w + '」→ 前进到块[' + at + '] line=' + pb[at].line);
                continue;
            }
            log.push('  「' + w + '」→ 跳过');
        }
        return { from: firstHit, to: lastHit, at: at, log: log };
    }

    var w0 = ['Recurrent','models','typically','factor','computation','along',
              'the','symbol','positions','of','the','input','and','output'];
    var r0 = run(w0, 0);
    out.push('row0: at 0 → ' + r0.at
             + '  from=' + (r0.from >= 0 ? pb[r0.from].line : '-')
             + ' to=' + (r0.to >= 0 ? pb[r0.to].line : '-'));
    out.push(r0.log.join('\\n'));

    var w1 = ['sequences.','Aligning','the','positions','to','steps','in',
              'computation','time,','they','generate','sequence','of','hidden'];
    var r1 = run(w1, r0.at);
    out.push('');
    out.push('row1: 起点 at=' + r0.at + ' → ' + r1.at
             + '  from=' + (r1.from >= 0 ? pb[r1.from].line : '-')
             + ' to=' + (r1.to >= 0 ? pb[r1.to].line : '-'));
    out.push(r1.log.join('\\n'));

    /* 打印这些块原文 */
    out.push('');
    out.push('涉及的块:');
    for (var q = 4; q < 12 && q < pb.length; q++) {
        out.push('  [' + q + '] line=' + pb[q].line
                 + ' ' + JSON.stringify(pb[q].text.slice(0, 70)));
    }
    return out.join('\\n');
"""))
cdp.close()
