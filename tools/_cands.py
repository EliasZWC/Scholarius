# -*- coding: utf-8 -*-
"""在真机里直接调 textToBlockRange 的等价逻辑，看候选集。"""
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
    var pageBlocks = [];
    for (var i = 0; i < b.length; i++) {
        if (b[i].page === 2 && b[i].line != null && b[i].text) pageBlocks.push(b[i]);
    }

    /* 取文字层里 row=1 的词，看它们的 y0/y1 与命中块 */
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    var rowWords = [];
    for (var j = 0; j < ls.length; j++) {
        if (String(ls[j].dataset.row) === '1') rowWords.push(ls[j]);
    }
    out.push('row=1 的词数 = ' + rowWords.length);
    var w0 = rowWords[0];
    out.push('第一个词「' + w0.textContent + '」 style.top='
             + w0.style.top + ' gf=' + w0.dataset.gf
             + ' gt=' + w0.dataset.gt);
    out.push('最后一个词「' + rowWords[rowWords.length - 1].textContent
             + '」 style.top=' + rowWords[rowWords.length - 1].style.top
             + ' gf=' + rowWords[rowWords.length - 1].dataset.gf);

    /* 把 style.top 转成归一化 y，再算候选集 */
    var y0 = parseFloat(w0.style.top) / 100;
    var h = parseFloat(w0.style.fontSize) / 100;  /* font-size 就是行高占比 */
    var y1 = y0 + h;
    out.push('');
    out.push('row=1 的 y0=' + y0.toFixed(4) + ' y1=' + y1.toFixed(4)
             + '（fontSize=' + w0.style.fontSize + '）');

    var eps = Math.max((y1 - y0) * 0.5, 0.002);
    out.push('eps = ' + eps.toFixed(4));
    out.push('');
    out.push('候选块（纵向相交）:');
    for (var c = 0; c < pageBlocks.length; c++) {
        var pb = pageBlocks[c];
        if (pb.y1 <= pb.y0) continue;
        if (pb.y1 < y0 - eps) continue;
        if (pb.y0 > y1 + eps) continue;
        out.push('  [' + c + '] line=' + pb.line
                 + ' y0=' + pb.y0.toFixed(4) + ' y1=' + pb.y1.toFixed(4)
                 + '  ' + JSON.stringify(pb.text.slice(0, 50)));
    }

    /* 全部 75 个块的 index → line 映射（找 216 是谁） */
    out.push('');
    out.push('line=216 在 pageBlocks 里的位置: '
             + pageBlocks.findIndex(function (x) { return x.line === 216; }));
    var idx216 = pageBlocks.findIndex(function (x) { return x.line === 216; });
    if (idx216 >= 0) {
        out.push('  → ' + JSON.stringify(pageBlocks[idx216].text.slice(0, 60)));
    }
    return out.join('\\n');
"""))
cdp.close()
