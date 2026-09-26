# -*- coding: utf-8 -*-
"""文字层的词盒子 vs 页图上的实际文字 —— 宽度对得上吗？

用户问题①：「很难选中（我不知道是不是因为大小关系）」。
实测：词「Recurrent」盒子只有 27px 宽，而屏幕上那行字明显更宽。
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


print('=== 文字层 vs 页图的几何关系 ===')
print(js("""
    var out = [];
    var slot = document.querySelector('.pdf-slot');
    var img = slot ? slot.querySelector('.pdf-page-img') : null;
    var layer = slot ? slot.querySelector('.pdf-text-layer') : null;

    function box(name, el) {
        if (!el) { out.push('  ' + name + ': 没有'); return null; }
        var r = el.getBoundingClientRect();
        out.push('  ' + name + ': rect=[' + Math.round(r.left) + ','
                 + Math.round(r.top) + ' ' + Math.round(r.width) + 'x'
                 + Math.round(r.height) + ']'
                 + ' offset=' + el.offsetWidth + 'x' + el.offsetHeight);
        return r;
    }
    var rs = box('.pdf-slot', slot);
    var ri = box('.pdf-page-img', img);
    var rl = box('.pdf-text-layer', layer);

    if (layer) {
        out.push('  text-layer 的 style: width=' + layer.style.width
                 + ' top=' + layer.style.top + ' left=' + layer.style.left
                 + ' height=' + layer.style.height);
        var cs = getComputedStyle(layer);
        out.push('  text-layer 计算宽高: ' + cs.width + ' x ' + cs.height
                 + '  position=' + cs.position
                 + '  transform=' + cs.transform);
    }
    if (img) {
        out.push('  img 的 style: width=' + img.style.width
                 + ' height=' + img.style.height);
        var ci = getComputedStyle(img);
        out.push('  img 计算宽高: ' + ci.width + ' x ' + ci.height
                 + '  object-fit=' + ci.objectFit);
    }

    out.push('');
    out.push('  前 8 个词（盒子 px 宽 / 文字 / 归一化 left,width）:');
    var ls = document.querySelectorAll('.pdf-text-line');
    for (var i = 0; i < 8 && i < ls.length; i++) {
        var r = ls[i].getBoundingClientRect();
        out.push('    ' + Math.round(r.width) + 'px  「'
                 + ls[i].textContent + '」  left=' + ls[i].style.left
                 + ' w=' + ls[i].style.width
                 + ' font=' + ls[i].style.fontSize);
    }
    return out.join('\\n');
"""))
cdp.close()
