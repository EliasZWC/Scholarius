# -*- coding: utf-8 -*-
"""验证：清空后 blk.textType 是否被 guessKind 重新填成 heading。

用户原话（2026-09-25）：
    「我在编辑模式里面清空了所有区域，怎么阅读试图还没有变化？」

上一轮实测的关键矛盾（tools/emu_clear_fab.py）：
    清空后 textType 分布 = {"body": 624}      ← 全是 body
    但阅读视图标签 = H2 21.25px × 5           ← 还是标题样式
    → textType 是 body，却渲染成 H2。说明渲染时拿到的不是这个值。

假设：buildRegions 里 `var type = mark ? mark.type : guessKind(...)`
      —— 清空后 mark 为 null → type 走 guessKind → 位置启发式又猜成 heading
      → `blk.textType = 'heading'` → 阅读视图当然不变。

本脚本用**真实触摸**操作，然后把渲染那一刻的真实数据打出来。
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
        var cx = Math.round(r.left + r.width/2);
        var cy = Math.round(r.top + r.height/2);
        var top = document.elementFromPoint(cx, cy);
        return { x: cx, y: cy,
                 hit: top ? (top.tagName + '.' +
                        (top.className||'').toString().split(' ')[0]) : null,
                 ok: !!(top && (top === e || e.contains(top))) };
    """ % json.dumps(sel))
    if not b:
        return None
    if not b['ok']:
        print('    ⚠️ %s 被 %s 挡住，点不到' % (sel, b['hit']))
        return None
    tap(cdp, b['x'], b['y'], wait)
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
                window.ScholariusShell.setAccount(true, 'eliaszwc', 'EliasZWC', '', 't');
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

        print('=' * 64)
        print('① 阅读视图：谁渲染成了 H2')
        print('=' * 64)
        if js(cdp, "return !!document.querySelector('.pdf-slot')") is True:
            tap_sel(cdp, '#reader-view-toggle', 2.5)
        time.sleep(0.6)
        print(js(cdp, """
            var o = [];
            var ns = document.querySelectorAll(
                '.reader-content h2, .reader-content h3, .reader-content h4, ' +
                '.reader-content p, .reader-content .reader-para');
            for (var i = 0; i < Math.min(ns.length, 8); i++) {
                var n = ns[i];
                var blk = n.__blk;
                o.push(n.tagName + '  "' +
                       (n.textContent||'').trim().slice(0, 22) + '"');
            }
            return o.join('\\n');
        """))

        print()
        print('=' * 64)
        print('② 直接查 buildRegions 的判据：这些块的 mark 与 guessKind')
        print('=' * 64)
        print(js(cdp, """
            var bs = window.ScholariusReader.getBlocks() || [];
            var o = [];
            for (var i = 0; i < Math.min(bs.length, 10); i++) {
                var b = bs[i];
                o.push('line=' + b.line +
                       '  kind=' + b.kind +
                       '  textType=' + (b.textType || '(空)') +
                       '  level=' + b.level +
                       '  text="' + (b.text || '').slice(0, 24) + '"');
            }
            return o.join('\\n');
        """))

        print()
        print('=' * 64)
        print('③ 进编辑模式 → 真实点 FAB 清空 → 再看')
        print('=' * 64)
        menu_on()
        if js(cdp, "return !!document.querySelector('.pdf-slot')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 2.5)
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-slot').length") > 0:
                break
            time.sleep(0.3)
        js(cdp, "var b=document.querySelector('.reader-body'); if(b) b.scrollTop=0; return 1")
        time.sleep(0.4)
        menu_on()
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 2.0)
        for _ in range(60):
            if js(cdp, "return document.querySelectorAll('.anno-layer').length") > 0:
                break
            time.sleep(0.4)

        # 先人为标两块 heading（制造"用户改过"的状态）
        cur = js(cdp, """
            var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
            return a ? a.getAttribute('data-edit-mode') : null;
        """)
        if cur != 'text':
            menu_on()
            tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 1.0)
        marked = 0
        for _ in range(2):
            b = js(cdp, """
                var l = document.querySelector('.anno-layer');
                if (!l) return null;
                var bs = l.querySelectorAll('.anno-block');
                for (var i = 0; i < bs.length; i++) {
                    var r = bs[i].getBoundingClientRect();
                    if (r.top < 200 || r.bottom > 680 || r.width < 80) continue;
                    if (bs[i].getAttribute('data-text-type') === 'heading') continue;
                    var cx = r.left + r.width/2, cy = r.top + r.height/2;
                    var t = document.elementFromPoint(cx, cy);
                    if (!t || !(t === bs[i] || bs[i].contains(t))) continue;
                    return { x: Math.round(cx), y: Math.round(cy),
                             line: bs[i].getAttribute('data-block-line') };
                }
                return null;
            """)
            if not b:
                break
            tap(cdp, b['x'], b['y'], 0.9)
            hi = js(cdp, """
                var s = document.querySelector('.anno-typesheet');
                if (!s) return null;
                var o = s.querySelectorAll('.anno-typeopt');
                for (var i = 0; i < o.length; i++) {
                    if ((o[i].textContent||'').trim() === 'Heading') {
                        var r = o[i].getBoundingClientRect();
                        var cx = Math.round(r.left+r.width/2),
                            cy = Math.round(r.top+r.height/2);
                        var t = document.elementFromPoint(cx, cy);
                        if (!t || !o[i].contains(t)) continue;
                        return { x: cx, y: cy };
                    }
                }
                return null;
            """)
            if not hi:
                break
            tap(cdp, hi['x'], hi['y'], 0.9)
            lv = js(cdp, """
                var s = document.querySelector('.anno-typesheet');
                if (!s) return null;
                var o = s.querySelectorAll('.anno-typeopt');
                for (var i = 0; i < o.length; i++) {
                    if (/^L1/.test((o[i].textContent||'').trim())) {
                        var r = o[i].getBoundingClientRect();
                        return { x: Math.round(r.left+r.width/2),
                                 y: Math.round(r.top+r.height/2) };
                    }
                }
                return null;
            """)
            if lv:
                tap(cdp, lv['x'], lv['y'], 0.9)
            marked += 1
            print('    标了第 %d 块 line=%s' % (marked, b['line']))

        print('  标完后 textType 分布:')
        print(js(cdp, """
            var bs = window.ScholariusReader.getBlocks() || [];
            var m = {};
            for (var i = 0; i < bs.length; i++) {
                var k = bs[i].textType || '(空)';
                m[k] = (m[k] || 0) + 1;
            }
            return JSON.stringify(m);
        """))

        # 点 FAB（真实触摸，先确认命中）
        fab = js(cdp, """
            var f = document.querySelector('.anno-fab');
            if (!f || f.hidden) return null;
            var r = f.getBoundingClientRect();
            var cx = Math.round(r.left + r.width/2);
            var cy = Math.round(r.top + r.height/2);
            var t = document.elementFromPoint(cx, cy);
            return { x: cx, y: cy,
                     ok: !!(t && (t === f || f.contains(t))),
                     hit: t ? (t.tagName + '.' +
                           (t.className||'').toString().split(' ')[0]) : null };
        """)
        print('  FAB 命中检查: %s' % json.dumps(fab, ensure_ascii=False))
        if fab and fab['ok']:
            tap(cdp, fab['x'], fab['y'], 1.0)
            conf = js(cdp, """
                var all = document.querySelectorAll('button');
                for (var i = 0; i < all.length; i++) {
                    var tx = (all[i].textContent || '').trim();
                    if (/^(Clear|清空|确定|Confirm)$/i.test(tx)) {
                        var r = all[i].getBoundingClientRect();
                        if (!r.width) continue;
                        var cx = Math.round(r.left+r.width/2),
                            cy = Math.round(r.top+r.height/2);
                        var t = document.elementFromPoint(cx, cy);
                        if (!t || !(t === all[i] || all[i].contains(t))) continue;
                        return { x: cx, y: cy, tx: tx };
                    }
                }
                return null;
            """)
            print('  确认按钮: %s' % json.dumps(conf, ensure_ascii=False))
            if conf:
                tap(cdp, conf['x'], conf['y'], 1.2)

        print('  清空后 textType 分布:')
        print(js(cdp, """
            var bs = window.ScholariusReader.getBlocks() || [];
            var m = {};
            for (var i = 0; i < bs.length; i++) {
                var k = bs[i].textType || '(空)';
                m[k] = (m[k] || 0) + 1;
            }
            return JSON.stringify(m);
        """))
        print('  --- clear 日志 ---')
        for l in js(cdp, """
            return (window.__bootLog||[]).filter(function(x){
                return /clear/.test(x);
            }).slice(-4).map(String);
        """):
            print('    ' + str(l))

        print()
        print('=' * 64)
        print('④ 切阅读视图（真实触摸点按钮）')
        print('=' * 64)
        menu_on()
        tap_sel(cdp, '#reader-view-toggle', 2.8)
        time.sleep(0.8)
        print(js(cdp, """
            var o = [];
            var ns = document.querySelectorAll(
                '.reader-content h2, .reader-content h3, .reader-content h4, ' +
                '.reader-content p, .reader-content .reader-para');
            for (var i = 0; i < Math.min(ns.length, 8); i++) {
                var n = ns[i];
                o.push(n.tagName + '  ' + getComputedStyle(n).fontSize +
                       '  "' + (n.textContent||'').trim().slice(0, 22) + '"');
            }
            return o.join('\\n');
        """))
        print()
        print('  切回后 textType 分布:')
        print(js(cdp, """
            var bs = window.ScholariusReader.getBlocks() || [];
            var m = {};
            for (var i = 0; i < bs.length; i++) {
                var k = bs[i].textType || '(空)';
                m[k] = (m[k] || 0) + 1;
            }
            return JSON.stringify(m);
        """))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
