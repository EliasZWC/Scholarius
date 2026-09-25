# -*- coding: utf-8 -*-
"""从**干净状态**（无残留框）拖拽一次，验证能不能真的画出框。

背景：上一次实测（emu_pcancel_diag.py）证明 pointercancel 已经修好
（13 次 pointermove 全收到），但拖拽起点撞上了一个已存在的框，
于是走了「点框删除」分支 —— 所以画框本身还没被验证过。

本脚本：找一块确定没有框、命中 anno-layer 的空白，拖一次，看框数 +1 不 +1。
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


def tap(cdp, x, y, wait=1.0):
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.06)
    cdp.touch('touchEnd', [])
    time.sleep(wait)


def tap_sel(cdp, sel, wait=1.2):
    b = js(cdp, """
        var e = document.querySelector(%s);
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width) return null;
        return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
    """ % json.dumps(sel))
    if b:
        tap(cdp, b[0], b[1], wait)
    return b


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
                var c = getComputedStyle(s);
                return c.display === 'none' || c.opacity === '0' || s.hidden === true;
            """)
            if v:
                break
            time.sleep(0.4)
        js(cdp, """
            if (window.ScholariusShell && window.ScholariusShell.setAccount &&
                !window.__fakeSignedIn) {
                window.ScholariusShell.setAccount(true, 'eliaszwc', 'EliasZWC',
                    '', 't');
                window.__fakeSignedIn = true;
            }
            return 1;
        """)
        time.sleep(0.5)

        def menu_on():
            if js(cdp, "return document.getElementById('reader')"
                       ".classList.contains('is-menu-open')") is True:
                return
            vp = js(cdp, 'return [window.innerWidth, window.innerHeight]')
            tap(cdp, vp[0] // 2, int(vp[1] * 0.45), 0.8)

        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-open')") is not True:
            tap_sel(cdp, '.doc-card', 2.5)
        menu_on()
        if js(cdp, "return !!document.querySelector('.pdf-slot')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 2.5)
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-slot').length") > 0:
                break
            time.sleep(0.3)
        js(cdp, "var b=document.querySelector('.reader-body'); if(b) b.scrollTop=0; return 1")
        time.sleep(0.5)

        menu_on()
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 2.0)
        for _ in range(60):
            if js(cdp, "return document.querySelectorAll('.anno-layer').length") > 0:
                break
            time.sleep(0.4)
        cur = js(cdp, """
            var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
            return a ? a.getAttribute('data-edit-mode') : null;
        """)
        if cur != 'figure':
            menu_on()
            tap_sel(cdp, '.reader-editbar [data-edit-mode="figure"]', 1.2)
        time.sleep(0.5)

        print('reader:', js(cdp, "return document.getElementById('reader').className"))
        print('boxes :', js(cdp, "return document.querySelectorAll('.anno-box').length"))

        # ⚠️⚠️ 先清掉页面上已有的框（幂等，踩过的坑）
        #
        # 本脚本的断言是「拖完框数 +1」，并按图层找一块"干净起手点"。
        # 但前面的脚本（emu_draw_check / emu_persist_check …）会留下框，
        # 于是本脚本在**序列中**运行时可能：
        #   · 找不到完全不重叠的起手点（框太多）→ 报失败
        #   · 或者起点仍落在某个框边上 → 走"点框删除"分支
        # 单独跑却是绿的 —— 典型的状态残留假失败。
        # 所以进来先自己把框删干净，不依赖外部状态。
        n_old = js(cdp, "return document.querySelectorAll('.anno-box').length")
        if n_old:
            print('  清理已有 %d 个框（幂等）' % n_old)
            for _ in range(n_old + 3):
                b = js(cdp, """
                    var bs = document.querySelectorAll('.anno-box:not(.is-ghost)');
                    if (!bs.length) return null;
                    var r = bs[bs.length - 1].getBoundingClientRect();
                    if (!r.width) return null;
                    return [Math.round(r.left + r.width/2),
                            Math.round(r.top + r.height/2)];
                """)
                if not b:
                    break
                tap(cdp, b[0], b[1], 0.6)
            left = js(cdp, "return document.querySelectorAll('.anno-box').length")
            print('  清理后剩 %d 个框' % left)

        spot = js(cdp, """
            var l = document.querySelector('.anno-layer');
            if (!l) return null;
            var lr = l.getBoundingClientRect();
            for (var fy = 0.10; fy < 0.60; fy += 0.05) {
                for (var fx = 0.08; fx < 0.85; fx += 0.05) {
                    var x0 = Math.round(lr.left + lr.width*fx);
                    var y0 = Math.round(lr.top + lr.height*fy);
                    var x1 = Math.round(x0 + lr.width*0.35);
                    var y1 = Math.round(y0 + lr.height*0.22);
                    if (x1 > lr.right - 8 || y1 > lr.bottom - 8) continue;
                    var a = document.elementFromPoint(x0, y0);
                    var b = document.elementFromPoint(x1, y1);
                    if (!a || !b) continue;
                    if (!a.classList.contains('anno-layer')) continue;
                    if (!b.classList.contains('anno-layer')) continue;
                    return { x0: x0, y0: y0, x1: x1, y1: y1 };
                }
            }
            return null;
        """)
        print('起手点:', json.dumps(spot, ensure_ascii=False))
        if not spot:
            print('❌ 找不到干净起手点')
            return 1

        js(cdp, """
            window.__capLog = [];
            if (!window.__capBound) {
                window.__capBound = true;
                ['pointerdown','pointermove','pointerup','pointercancel']
                  .forEach(function (n) {
                    document.addEventListener(n, function (e) {
                        window.__capLog.push(e.type);
                    }, true);
                  });
            }
            return 1;
        """)
        nb = js(cdp, "return document.querySelectorAll('.anno-box').length")
        print('拖前框数: %d' % nb)
        cdp.touch('touchStart', [(spot['x0'], spot['y0'])])
        time.sleep(0.08)
        for i in range(1, 13):
            t = float(i) / 12
            cdp.touch('touchMove', [(
                spot['x0'] + (spot['x1'] - spot['x0']) * t,
                spot['y0'] + (spot['y1'] - spot['y0']) * t)])
            time.sleep(0.025)
        cdp.touch('touchEnd', [])
        time.sleep(0.8)

        print('pointer 事件:', js(cdp, 'return JSON.stringify(window.__capLog)'))
        na = js(cdp, "return document.querySelectorAll('.anno-box').length")
        print('拖后框数: %d   (期望 %d)' % (na, nb + 1))
        print('--- anno 日志 ---')
        for l in js(cdp, """
            return (window.__bootLog||[]).filter(function(x){
                return /anno:/.test(x);
            }).slice(-10).map(String);
        """):
            print('  ' + str(l))
        print()
        if na == nb + 1:
            print('✅ 画框成功')
            return 0
        print('❌ 画框失败')
        return 1
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
