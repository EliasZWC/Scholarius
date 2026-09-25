# -*- coding: utf-8 -*-
"""查：编辑模式下自动识别的框为什么一个都不出现。

旁观记录（用户 2026-09-25 亲手操作，tools/emu_watch.py）显示：
    821ms 之后，整轮操作里
        .anno-layer = 0
        .anno-block = 0
        .anno-box   = 0
    而 reader 类是 "reader is-open is-raw is-annotating is-text-mode"
    —— 编辑模式开着，但页面上一个可点/可拖的东西都没有。

mountAnnotateLayer() 的循环头是：
    for (var i = 0; i < pdfPageEls.length; i++)
所以怀疑 pdfPageEls 是空的。

本脚本**不点击**，只读状态：
  ① 用真实触摸把应用走到「原始视图 + 编辑模式」，
  ② 逐步打印 pdfPageEls 长度（通过 DOM 间接判断）、
     槽位结构、层的父节点、以及 mountAnnotateLayer 的 trace。
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


def tap_finger(cdp, x, y, wait=1.0, why=''):
    hit = js(cdp, """
        var t = document.elementFromPoint(%d, %d);
        return t ? (t.tagName + '.' + (t.className||'').toString()
                    .split(' ').slice(0,3).join('.')) : 'null';
    """ % (x, y))
    print('    → 点 (%d,%d) 命中 %s  %s' % (x, y, hit, why))
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.06)
    cdp.touch('touchEnd', [])
    time.sleep(wait)
    return hit


def tap_sel(cdp, sel, wait=1.2, why=''):
    b = js(cdp, """
        var e = document.querySelector(%s);
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width) return null;
        var cx = Math.round(r.left + r.width/2);
        var cy = Math.round(r.top + r.height/2);
        var t = document.elementFromPoint(cx, cy);
        return { x: cx, y: cy,
                 ok: !!(t && (t === e || e.contains(t))),
                 hit: t ? (t.tagName + '.' + (t.className||'').toString()
                       .split(' ').slice(0,3).join('.')) : 'null' };
    """ % json.dumps(sel))
    if not b:
        print('    ✗ %s 不存在或不可见' % sel)
        return False
    if not b['ok']:
        print('    ✗ %s 被 %s 挡住' % (sel, b['hit']))
        return False
    tap_finger(cdp, b['x'], b['y'], wait, why)
    return True


def report(cdp, label):
    s = js(cdp, """
        var r = document.getElementById('reader');
        var scroller = document.querySelector('.pdf-scroll');
        var slots = document.querySelectorAll('.pdf-slot');
        return JSON.stringify({
          reader: r ? r.className : '-',
          pdfScroll: !!scroller,
          slots: slots.length,
          layers: document.querySelectorAll('.anno-layer').length,
          blocks: document.querySelectorAll('.anno-block').length,
          boxes: document.querySelectorAll('.anno-box').length,
          editbar: !!document.querySelector('.reader-editbar'),
          fab: (function () {
            var f = document.querySelector('.anno-fab');
            return f ? (f.hidden ? 'hidden' : 'visible') : 'none';
          })(),
          pageImg: document.querySelectorAll('.pdf-page-img').length
        });
    """)
    print('  [%s] %s' % (label, s))
    return json.loads(s)


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

        # 记录 mountAnnotateLayer 的 trace
        js(cdp, "window.__bootLog = []; return 1")

        vp = js(cdp, 'return [window.innerWidth, window.innerHeight]')

        def menu_on():
            if js(cdp, "return document.getElementById('reader')"
                       ".classList.contains('is-menu-open')") is True:
                return
            tap_finger(cdp, vp[0] // 2, int(vp[1] * 0.45), 0.8, '唤出菜单')

        # 干净起步
        js(cdp, "if (window.ScholariusReader && window.ScholariusReader.close) "
                "window.ScholariusReader.close(); return 1")
        time.sleep(1.5)
        report(cdp, '关闭后')

        print()
        print('=' * 62)
        print('① 打开论文（阅读视图）')
        print('=' * 62)
        tap_sel(cdp, '.doc-card', 3.0, '打开论文')
        report(cdp, '阅读视图')

        print()
        print('=' * 62)
        print('② 切原始视图')
        print('=' * 62)
        menu_on()
        tap_sel(cdp, '#reader-view-toggle', 3.0, '切原始视图')
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-slot').length") > 0:
                break
            time.sleep(0.3)
        r = report(cdp, '原始视图')

        print()
        print('=' * 62)
        print('③ 进编辑模式 —— 关键：层挂上了吗')
        print('=' * 62)
        menu_on()
        tap_sel(cdp, '#reader-annotate', 2.5, '进编辑模式')
        for _ in range(60):
            if js(cdp, "return document.querySelectorAll('.anno-layer').length") > 0:
                break
            time.sleep(0.4)
        r2 = report(cdp, '编辑模式')

        if r2['slots'] > 0 and r2['layers'] == 0:
            print()
            print('  ❌❌ 槽位有 %d 个，但一层都没挂上！' % r2['slots'])
            print('     → mountAnnotateLayer 的循环没执行 或 中途抛异常')
            print()
            print('  --- 手工调用一次，看抛什么错 ---')
            err = js(cdp, """
                try {
                    // 复刻 mountAnnotateLayer 的第一步，看能不能拿到槽位
                    var slots = document.querySelectorAll('.pdf-slot');
                    if (!slots.length) return 'no slots';
                    var s0 = slots[0];
                    var page = parseInt(s0.getAttribute('data-page'), 10) || 0;
                    return 'first slot page=' + page + ' cls=' + s0.className +
                           ' children=' + s0.children.length;
                } catch (e) {
                    return 'EXC: ' + (e && e.message ? e.message : String(e));
                }
            """)
            print('    %s' % err)
            print()
            print('  --- 最近的 reader/anno 日志 ---')
            for l in js(cdp, """
                return (window.__bootLog||[]).filter(function(x){
                    return /reader:|anno:/.test(x);
                }).slice(-20).map(String);
            """):
                print('      ' + str(l))
        elif r2['layers'] > 0:
            print('  ✅ 层挂上了 %d 层，块 %d 个' % (r2['layers'], r2['blocks']))

        print()
        print('=' * 62)
        print('④ 底部编辑栏有哪些选项')
        print('=' * 62)
        print(js(cdp, """
            var eb = document.querySelector('.reader-editbar');
            if (!eb) return '(无 editbar)';
            var out = [];
            var bs = eb.querySelectorAll('[data-edit-mode]');
            for (var i = 0; i < bs.length; i++) {
                var r = bs[i].getBoundingClientRect();
                out.push(bs[i].getAttribute('data-edit-mode') +
                         '  pressed=' + bs[i].getAttribute('aria-pressed') +
                         '  rect=' + [Math.round(r.left), Math.round(r.top),
                                     Math.round(r.width), Math.round(r.height)].join(',') +
                         '  可见=' + (r.width > 0));
            }
            return out.join('\\n');
        """))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
