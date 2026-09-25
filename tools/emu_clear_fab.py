# -*- coding: utf-8 -*-
"""复现「清空后阅读视图没变化」—— 这次用**真实的清空按钮**。

用户原话（2026-09-25）：
    「我在编辑模式里面清空了所有区域，怎么阅读试图还没有变化？」

上一版脚本失败的原因：它找 `.reader-editbar` 里的按钮，
但「清空」其实是 **FAB**（`.anno-fab`，见 reader.js 的 mountClearFab），
所以 `清空按钮: null` —— 那一步根本没执行，实测无效。

本脚本：
  ① 阅读视图初始快照
  ② 进编辑模式，用真实 FAB 走一遍清空（含确认表单）
  ③ 每一步都打印 textMarks 生效类型分布 + 阅读视图标签
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


def snap(cdp, label):
    """阅读视图前 10 个元素的标签 + 首块类型分布。"""
    arr = json.loads(js(cdp, """
        var o = [];
        var ns = document.querySelectorAll(
            '.reader-content h2, .reader-content h3, .reader-content h4, ' +
            '.reader-content p, .reader-content .reader-para');
        for (var i = 0; i < Math.min(ns.length, 10); i++) {
            var n = ns[i];
            o.push([n.tagName, getComputedStyle(n).fontSize,
                    (n.textContent || '').trim().slice(0, 24)]);
        }
        return JSON.stringify(o);
    """) or '[]')
    dist = js(cdp, """
        var bs = window.ScholariusReader && window.ScholariusReader.getBlocks
                 ? window.ScholariusReader.getBlocks() : null;
        if (!bs) return 'no-blocks';
        var m = {};
        for (var i = 0; i < bs.length; i++) {
            var k = bs[i].textType || ('kind:' + bs[i].kind);
            m[k] = (m[k] || 0) + 1;
        }
        return JSON.stringify(m);
    """)
    print('  [%s]' % label)
    print('    类型分布: %s' % dist)
    for t, fs, tx in arr[:8]:
        print('      %-4s %-8s "%s"' % (t, fs, tx))
    return arr


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
        print('① 阅读视图初始')
        print('=' * 64)
        if js(cdp, "return !!document.querySelector('.pdf-slot')") is True:
            tap_sel(cdp, '#reader-view-toggle', 2.5)
        time.sleep(0.6)
        base = snap(cdp, '初始')

        print()
        print('=' * 64)
        print('② 进原始视图 + 编辑模式 → 用真实 FAB 清空')
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
        # FAB 只在菜单收起时才不会被底栏遮住 —— 先收起菜单
        menu_on()
        time.sleep(0.4)

        fab = js(cdp, """
            var f = document.querySelector('.anno-fab');
            if (!f) return null;
            var cs = getComputedStyle(f);
            var r = f.getBoundingClientRect();
            var top = document.elementFromPoint(r.left + r.width/2,
                                                r.top + r.height/2);
            return { hidden: f.hidden, display: cs.display,
                     rect: [Math.round(r.left), Math.round(r.top),
                            Math.round(r.width), Math.round(r.height)],
                     cx: Math.round(r.left + r.width/2),
                     cy: Math.round(r.top + r.height/2),
                     covered: top ? (top.tagName + '.' +
                              (top.className||'').toString().split(' ')[0]) : null,
                     isSelf: top === f || (f.contains && f.contains(top)) };
        """)
        print('  FAB: %s' % json.dumps(fab, ensure_ascii=False))
        if not fab:
            raise SystemExit('❌ 没有 .anno-fab（进编辑模式失败？）')

        before = js(cdp, """
            var bs = window.ScholariusReader.getBlocks() || [];
            var m = {};
            for (var i = 0; i < bs.length; i++) {
                var k = bs[i].textType || ('kind:' + bs[i].kind);
                m[k] = (m[k] || 0) + 1;
            }
            return JSON.stringify(m);
        """)
        print('  清空前 类型分布: %s' % before)

        tap(cdp, fab['cx'], fab['cy'], 1.0)
        print('  点了 FAB')
        # 可能弹确认
        conf = js(cdp, """
            var s = document.querySelector('.sheet-scrim') || document;
            var b = s.querySelector('.btn-primary, .btn-danger, [data-confirm]');
            if (!b) {
                var all = document.querySelectorAll('button');
                for (var i = 0; i < all.length; i++) {
                    var tx = (all[i].textContent || '').trim();
                    if (/^(Clear|清空|确定|Confirm)$/i.test(tx)) {
                        var r = all[i].getBoundingClientRect();
                        if (r.width) return [Math.round(r.left+r.width/2),
                                             Math.round(r.top+r.height/2)];
                    }
                }
                return null;
            }
            var r2 = b.getBoundingClientRect();
            if (!r2.width) return null;
            return [Math.round(r2.left+r2.width/2), Math.round(r2.top+r2.height/2)];
        """)
        print('  确认按钮: %s' % json.dumps(conf))
        if conf:
            tap(cdp, conf[0], conf[1], 1.2)

        after = js(cdp, """
            var bs = window.ScholariusReader.getBlocks() || [];
            var m = {};
            for (var i = 0; i < bs.length; i++) {
                var k = bs[i].textType || ('kind:' + bs[i].kind);
                m[k] = (m[k] || 0) + 1;
            }
            return JSON.stringify(m);
        """)
        print('  清空后 类型分布: %s' % after)
        print('  框数: %s' % js(cdp, "return document.querySelectorAll('.anno-box').length"))
        print('  --- 清空相关日志 ---')
        for l in js(cdp, """
            return (window.__bootLog||[]).filter(function(x){
                return /clear|annotate/.test(x);
            }).slice(-8).map(String);
        """):
            print('    ' + str(l))

        print()
        print('=' * 64)
        print('③ 切回阅读视图')
        print('=' * 64)
        menu_on()
        tap_sel(cdp, '#reader-view-toggle', 2.8)
        time.sleep(0.8)
        after_clear = snap(cdp, '清空后')

        print()
        print('=' * 64)
        print('④ 判据')
        print('=' * 64)
        print('  清空让类型分布变了: %s' % ('是' if before != after else '否'))
        print('  清空让阅读视图变了: %s'
              % ('否  ← ❌ 这就是你报的问题' if after_clear == base
                 else '是'))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
