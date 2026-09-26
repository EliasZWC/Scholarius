# -*- coding: utf-8 -*-
"""为什么文字层的 .pdf-text-line 找不到（宽度全 0？）。

截图显示：编辑+文本模式下，页面上没有可划选的行。
脚本报「找到 0 条不同高度的行」（我筛 r.width >= 8）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


print('reader: %s' % js("return document.getElementById('reader').className"))
print()
print('=== 文字层 / 行 计数 ===')
print('  layer: %s' % js("return document.querySelectorAll('.pdf-text-layer').length"))
print('  line:  %s' % js("return document.querySelectorAll('.pdf-text-line').length"))

print()
print('=== 前 6 个 .pdf-text-line 的几何 + 计算样式 ===')
print(js("""
    var ls = document.querySelectorAll('.pdf-text-line');
    var out = [];
    for (var i = 0; i < Math.min(6, ls.length); i++) {
        var e = ls[i];
        var r = e.getBoundingClientRect();
        var cs = getComputedStyle(e);
        out.push(JSON.stringify({
            i: i,
            text: (e.textContent || '').slice(0, 12),
            rect: [Math.round(r.left), Math.round(r.top),
                   Math.round(r.width), Math.round(r.height)],
            styleLeft: e.style.left, styleTop: e.style.top,
            styleWidth: e.style.width, styleFontSize: e.style.fontSize,
            display: cs.display, visibility: cs.visibility,
            opacity: cs.opacity, position: cs.position,
            lineHeight: cs.lineHeight, fontSize: cs.fontSize
        }));
    }
    return out.join('\\n');
"""))

print()
print('=== 文字层自己的几何 ===')
print(js("""
    var l = document.querySelector('.pdf-text-layer');
    if (!l) return 'no layer';
    var r = l.getBoundingClientRect();
    var cs = getComputedStyle(l);
    return JSON.stringify({
        rect: [Math.round(r.left), Math.round(r.top),
               Math.round(r.width), Math.round(r.height)],
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        pointerEvents: cs.pointerEvents, zIndex: cs.zIndex, overflow: cs.overflow,
        position: cs.position, inset: cs.inset, width: cs.width, height: cs.height
    }, null, 1);
"""))

print()
print('=== 它的父级 .pdf-slot ===')
print(js("""
    var l = document.querySelector('.pdf-text-layer');
    var s = l ? l.parentNode : null;
    if (!s) return 'no parent';
    var r = s.getBoundingClientRect();
    var cs = getComputedStyle(s);
    return JSON.stringify({
        cls: s.className,
        rect: [Math.round(r.left), Math.round(r.top),
               Math.round(r.width), Math.round(r.height)],
        position: cs.position, overflow: cs.overflow
    }, null, 1);
"""))

print()
print('=== elementFromPoint 在几处返回什么 ===')
print(js("""
    var out = [];
    var pts = [[200, 300], [200, 400], [200, 500], [200, 600], [200, 700]];
    for (var i = 0; i < pts.length; i++) {
        var e = document.elementFromPoint(pts[i][0], pts[i][1]);
        out.push(pts[i].join(',') + ' -> '
            + (e ? (e.tagName + '.' + (typeof e.className === 'string'
                    ? e.className.split(' ')[0] : '')) : 'null'));
    }
    return out.join('\\n');
"""))
cdp.close()
