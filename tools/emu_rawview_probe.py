# -*- coding: utf-8 -*-
"""只查一件事：原始视图上，触摸事件到底被谁吃了。

用户明确（2026-09-25）：
    「我说的是原始视图」「画框也画不了啊」
    「面对任何形式的拖拽都没有办法识别啊」

上一次实测（emu_drag_anywhere.py ④）的结果：
    位置: hit: "IMG.pdf-page-img"
    --- 事件序列 ---
    （空 —— 一个新事件都没记录）
    → 拖拽连一个事件都没产生。不是画框逻辑的问题，
      是**触摸根本没到达任何监听器**。

本脚本在 document 上装**捕获阶段**监听（最先收到事件），
把 touchstart/touchmove/pointerdown 的真实目标打出来，
再逐层看 pointer-events / touch-action。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402


def js(cdp, code):
    return cdp.evaluate(code)


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        for _ in range(40):
            if js(cdp, "return !!document.getElementById('reader')") is True:
                break
            time.sleep(0.4)
        for _ in range(40):
            v = js(cdp, """
                var s = document.querySelector('.splash');
                if (!s) return true;
                var cs = getComputedStyle(s);
                return cs.display === 'none' || cs.opacity === '0' || s.hidden === true;
            """)
            if v:
                break
            time.sleep(0.4)
        js(cdp, """
            if (window.ScholariusShell && window.ScholariusShell.setAccount &&
                !window.__fakeSignedIn) {
                window.ScholariusShell.setAccount(true, 'eliaszwc', 'EliasZWC',
                    '', 'test-account-id');
                window.__fakeSignedIn = true;
            }
            return 1;
        """)
        time.sleep(0.5)

        # 确保在阅读器里 + 原始视图
        print('=' * 60)
        print('准备：阅读器 + 原始视图')
        print('=' * 60)
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-open')") is not True:
            b = js(cdp, """
                var c = document.querySelector('.doc-card');
                if (!c) return null;
                var r = c.getBoundingClientRect();
                return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
            """)
            if b:
                cdp.touch('touchStart', [(b[0], b[1])])
                time.sleep(0.06)
                cdp.touch('touchEnd', [])
                time.sleep(2.5)

        def menu_on():
            if js(cdp, "return document.getElementById('reader')"
                       ".classList.contains('is-menu-open')") is True:
                return
            vp = js(cdp, 'return [window.innerWidth, window.innerHeight]')
            cdp.touch('touchStart', [(vp[0] // 2, int(vp[1] * 0.45))])
            time.sleep(0.06)
            cdp.touch('touchEnd', [])
            time.sleep(0.8)

        menu_on()
        if js(cdp, "return !!document.querySelector('.pdf-slot')") is not True:
            b = js(cdp, """
                var e = document.getElementById('reader-view-toggle');
                if (!e) return null;
                var r = e.getBoundingClientRect();
                return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
            """)
            if b:
                cdp.touch('touchStart', [(b[0], b[1])])
                time.sleep(0.06)
                cdp.touch('touchEnd', [])
                time.sleep(2.5)
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-slot').length") > 0:
                break
            time.sleep(0.3)
        js(cdp, "var b=document.querySelector('.reader-body'); if(b) b.scrollTop=0; return 1")
        time.sleep(0.5)

        print()
        print('--- 原始视图元素层级（从 img 往上）---')
        print(js(cdp, """
            var img = document.querySelector('.pdf-page-img');
            if (!img) return '无 img';
            var out = [];
            var e = img;
            while (e && e !== document.documentElement) {
                var cs = getComputedStyle(e);
                var r = e.getBoundingClientRect();
                out.push({
                    tag: e.tagName,
                    cls: (e.className || '').toString().slice(0, 40),
                    pe: cs.pointerEvents,
                    ta: cs.touchAction,
                    us: cs.userSelect,
                    ov: cs.overflowY,
                    rect: [Math.round(r.left), Math.round(r.top),
                           Math.round(r.width), Math.round(r.height)]
                });
                e = e.parentElement;
            }
            return JSON.stringify(out, null, 1);
        """))

        print()
        print('--- 有没有元素盖在 img 上面？(elementFromPoint 逐点) ---')
        print(js(cdp, """
            var img = document.querySelector('.pdf-page-img');
            var r = img.getBoundingClientRect();
            var out = [];
            var pts = [[0.5,0.3],[0.5,0.5],[0.15,0.4],[0.8,0.6]];
            for (var i = 0; i < pts.length; i++) {
                var x = Math.round(r.left + r.width*pts[i][0]);
                var y = Math.round(r.top + r.height*pts[i][1]);
                var t = document.elementFromPoint(x, y);
                var chain = [];
                var e = t;
                for (var k = 0; k < 4 && e; k++) {
                    chain.push(e.tagName + '.' + (e.className||'').toString().split(' ')[0]);
                    e = e.parentElement;
                }
                out.push({ x: x, y: y, hit: chain });
            }
            return JSON.stringify(out, null, 1);
        """))

        print()
        print('--- 装捕获监听，派发真实拖拽 ---')
        js(cdp, """
            if (!window.__capLog) {
                window.__capLog = [];
                var rec = function (ev) {
                    var t = ev.target;
                    window.__capLog.push({
                        ev: ev.type,
                        x: ev.touches && ev.touches[0] ? Math.round(ev.touches[0].clientX) : null,
                        y: ev.touches && ev.touches[0] ? Math.round(ev.touches[0].clientY) : null,
                        target: t ? (t.tagName + '.' + (t.className||'').toString().split(' ').slice(0,2).join('.')) : null
                    });
                };
                ['touchstart','touchmove','touchend','touchcancel',
                 'pointerdown','pointermove','pointerup','pointercancel',
                 'scroll'].forEach(function (n) {
                    document.addEventListener(n, rec, true);
                });
            }
            window.__capLog = [];
            return 1;
        """)

        spot = js(cdp, """
            var img = document.querySelector('.pdf-page-img');
            var r = img.getBoundingClientRect();
            return { x0: Math.round(r.left + r.width*0.25),
                     y0: Math.round(r.top + r.height*0.35),
                     x1: Math.round(r.left + r.width*0.75),
                     y1: Math.round(r.top + r.height*0.45) };
        """)
        print('  拖 (%d,%d) -> (%d,%d)' % (spot['x0'], spot['y0'], spot['x1'], spot['y1']))
        cdp.touch('touchStart', [(spot['x0'], spot['y0'])])
        time.sleep(0.08)
        for i in range(1, 13):
            t = float(i) / 12
            cdp.touch('touchMove', [(
                spot['x0'] + (spot['x1'] - spot['x0']) * t,
                spot['y0'] + (spot['y1'] - spot['y0']) * t)])
            time.sleep(0.025)
        cdp.touch('touchEnd', [])
        time.sleep(0.7)

        print()
        print('--- 捕获阶段收到的事件 ---')
        print(js(cdp, "return JSON.stringify(window.__capLog||[], null, 1)"))
        print()
        print('--- 有没有 any 的 anno 日志 ---')
        print(js(cdp, "return JSON.stringify((window.__bootLog||[])"
                      ".filter(function(x){return /anno/.test(x);}).slice(-8))"))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
