# -*- coding: utf-8 -*-
"""划选失败的那一刻，页面到底是什么样。不再猜。"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ADB = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk',
                   'platform-tools', 'adb.exe')
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')
pp = lambda v: str(int(round(v * DPR)))  # noqa: E731


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


print('=== 当前视图状态 ===')
print(js("""
    var out = [];
    var rd = document.getElementById('reader');
    out.push('  reader.className = ' + (rd ? rd.className : '-'));
    out.push('  视口 = ' + innerWidth + 'x' + innerHeight);
    out.push('');
    out.push('  .pdf-scroll 数量 = ' + document.querySelectorAll('.pdf-scroll').length);
    out.push('  .pdf-slot   数量 = ' + document.querySelectorAll('.pdf-slot').length);
    out.push('  .pdf-page-img 数量 = ' + document.querySelectorAll('.pdf-page-img').length);
    out.push('  .pdf-text-layer 数量 = ' + document.querySelectorAll('.pdf-text-layer').length);
    out.push('  .pdf-text-line 数量 = ' + document.querySelectorAll('.pdf-text-line').length);
    out.push('');
    /* 每个 slot 的状况 */
    var slots = document.querySelectorAll('.pdf-slot');
    out.push('  ── 每个 slot ──');
    for (var i = 0; i < Math.min(slots.length, 12); i++) {
        var s = slots[i];
        var r = s.getBoundingClientRect();
        var img = s.querySelector('.pdf-page-img');
        var lay = s.querySelector('.pdf-text-layer');
        var ir = img ? img.getBoundingClientRect() : null;
        out.push('    slot[' + i + '] page=' + s.dataset.page
                 + ' y=' + Math.round(r.top) + '..' + Math.round(r.bottom)
                 + ' img=' + (img ? ('y=' + Math.round(ir.top) + '..'
                     + Math.round(ir.bottom) + ' 有 src=' + !!img.src
                     + ' complete=' + img.complete
                     + ' nw=' + img.naturalWidth) : '无')
                 + ' 层=' + (lay ? lay.querySelectorAll('.pdf-text-line').length + '词' : '无'));
    }
    out.push('');
    out.push('  ── 视口中心点上是谁 ──');
    var probes = [0.2, 0.35, 0.5, 0.65, 0.8];
    for (var p = 0; p < probes.length; p++) {
        var y = innerHeight * probes[p];
        var e = document.elementFromPoint(innerWidth / 2, y);
        out.push('    y=' + Math.round(y) + ' → ' + (e ? (e.tagName + '.'
            + (typeof e.className === 'string'
               ? e.className.split(' ').slice(0, 2).join('.') : '')) : 'null'));
    }
    out.push('');
    out.push('  ── 阅读视图的正文元素 ──');
    var c = document.querySelector('.reader-content, #reader-content');
    if (c) {
        var cs = getComputedStyle(c);
        out.push('    reader-content display=' + cs.display
                 + ' 文字前 60: 「' + (c.textContent || '').trim().slice(0, 60) + '」');
    } else {
        out.push('    没有 reader-content');
    }
    return out.join('\\n');
"""))
cdp.close()
