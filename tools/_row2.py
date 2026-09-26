# -*- coding: utf-8 -*-
"""row=2 的 19 个词，逐词打印 gf/gt 与 style.top（只在本层内）。"""
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
    /* ⚠️ 必须按**层**遍历 —— 每层各自有自己的 data-row。
          直接 document.querySelectorAll 会把不同页的 row=2 混在一起。 */
    var lays = document.querySelectorAll('.pdf-text-layer');
    for (var L = 0; L < lays.length; L++) {
        var ls = lays[L].querySelectorAll('.pdf-text-line');
        if (!ls.length) continue;
        var slot = lays[L].closest('.pdf-slot');
        out.push('层[' + L + '] page=' + (slot ? slot.dataset.page : '-')
                 + ' 词数=' + ls.length);
        for (var i = 0; i < ls.length; i++) {
            if (String(ls[i].dataset.row) !== '2') continue;
            out.push('  「' + ls[i].textContent.slice(0, 18)
                     + '」 top=' + ls[i].style.top
                     + ' gf=' + ls[i].dataset.gf
                     + ' gt=' + ls[i].dataset.gt);
        }
    }
    return out.join('\\n');
"""))
cdp.close()
