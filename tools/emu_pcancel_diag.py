# -*- coding: utf-8 -*-
"""修 pointercancel：把当前真实状态一次看全。

不改代码、不提方案，只取数据：
  · 进编辑模式后，整条祖先链的 touch-action 实际值
  · is-raw / is-annotating / is-drawing 三个类在不在
  · 拖拽时的完整事件序列
  · anno:down / anno:drag / anno:up 日志
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

        def menu_on():
            if js(cdp, "return document.getElementById('reader')"
                       ".classList.contains('is-menu-open')") is True:
                return
            vp = js(cdp, 'return [window.innerWidth, window.innerHeight]')
            tap(cdp, vp[0] // 2, int(vp[1] * 0.45), 0.8)

        def tap_sel(sel, wait=1.2):
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

        # 阅读器 + 原始视图
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-open')") is not True:
            tap_sel('.doc-card', 2.5)
        menu_on()
        if js(cdp, "return !!document.querySelector('.pdf-slot')") is not True:
            tap_sel('#reader-view-toggle', 2.5)
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-slot').length") > 0:
                break
            time.sleep(0.3)
        js(cdp, "var b=document.querySelector('.reader-body'); if(b) b.scrollTop=0; return 1")
        time.sleep(0.5)

        print('=' * 64)
        print('① 进编辑模式 + 选「图片」')
        print('=' * 64)
        menu_on()
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-annotating')") is not True:
            tap_sel('#reader-annotate', 2.0)
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
            tap_sel('.reader-editbar [data-edit-mode="figure"]', 1.2)
        time.sleep(0.5)

        print()
        print('-' * 64)
        print('② 三个类在不在')
        print('-' * 64)
        print(js(cdp, """
            var r = document.getElementById('reader');
            return JSON.stringify({
              reader: r.className,
              is_raw: r.classList.contains('is-raw'),
              is_annotating: r.classList.contains('is-annotating'),
              is_drawing: r.classList.contains('is-drawing'),
              is_text_mode: r.classList.contains('is-text-mode'),
              body_ta: getComputedStyle(document.body).touchAction,
              has_rule: (function () {
                for (var i = 0; i < document.styleSheets.length; i++) {
                  var sh = document.styleSheets[i], rs;
                  try { rs = sh.cssRules; } catch (e) { continue; }
                  for (var k = 0; k < rs.length; k++) {
                    if (rs[k].selectorText &&
                        rs[k].selectorText.indexOf('is-raw') >= 0) {
                      return rs[k].selectorText + ' => ' + rs[k].style.touchAction;
                    }
                  }
                }
                return 'NOT FOUND';
              })()
            }, null, 1);
        """))

        print()
        print('-' * 64)
        print('③ elementFromPoint 命中什么')
        print('-' * 64)
        print(js(cdp, """
            var l = document.querySelector('.anno-layer');
            if (!l) return 'no layer';
            var lr = l.getBoundingClientRect();
            var chain = [];
            var x = Math.round(lr.left + lr.width*0.5);
            var y = Math.round(lr.top + lr.height*0.4);
            var e = document.elementFromPoint(x, y);
            while (e && e !== document.documentElement) {
                var cs = getComputedStyle(e);
                chain.push(e.tagName + '.' + (e.className||'').toString().split(' ').slice(0,2).join('.')
                           + '  ta=' + cs.touchAction + ' pe=' + cs.pointerEvents);
                e = e.parentElement;
            }
            return '(' + x + ',' + y + ')\\n' + chain.join('\\n');
        """))

        print()
        print('-' * 64)
        print('④ 真实拖拽')
        print('-' * 64)
        js(cdp, """
            window.__capLog = [];
            if (!window.__capBound) {
                window.__capBound = true;
                ['touchstart','touchmove','touchend','touchcancel',
                 'pointerdown','pointermove','pointerup','pointercancel'].forEach(function (n) {
                    document.addEventListener(n, function (ev) {
                        var t = ev.target;
                        window.__capLog.push(ev.type + ' @' +
                            (ev.touches && ev.touches[0] ?
                             Math.round(ev.touches[0].clientX) + ',' +
                             Math.round(ev.touches[0].clientY) : '-') +
                            ' -> ' + (t ? t.tagName + '.' +
                            (t.className||'').toString().split(' ')[0] : '?'));
                    }, true);
                });
            }
            return 1;
        """)
        js(cdp, """
            var l = document.querySelector('.anno-layer');
            var lr = l.getBoundingClientRect();
            window.__dragPt = [Math.round(lr.left + lr.width*0.3),
                               Math.round(lr.top + lr.height*0.35),
                               Math.round(lr.left + lr.width*0.7),
                               Math.round(lr.top + lr.height*0.5)];
            return 1;
        """)
        pt = js(cdp, 'return window.__dragPt')
        print('  拖 (%d,%d) -> (%d,%d)' % tuple(pt))
        nb = js(cdp, "return document.querySelectorAll('.anno-box').length")
        cdp.touch('touchStart', [(pt[0], pt[1])])
        time.sleep(0.08)
        for i in range(1, 13):
            t = float(i) / 12
            cdp.touch('touchMove', [(
                pt[0] + (pt[2] - pt[0]) * t,
                pt[1] + (pt[3] - pt[1]) * t)])
            time.sleep(0.025)
        cdp.touch('touchEnd', [])
        time.sleep(0.8)
        print('  --- 事件 ---')
        for l in js(cdp, 'return window.__capLog || []'):
            print('    ' + str(l))
        na = js(cdp, "return document.querySelectorAll('.anno-box').length")
        print('  框数 %d -> %d' % (nb, na))
        print('  --- anno 日志 ---')
        for l in js(cdp, """
            return (window.__bootLog||[]).filter(function(x){
                return /anno:/.test(x);
            }).slice(-10).map(String);
        """):
            print('    ' + str(l))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
