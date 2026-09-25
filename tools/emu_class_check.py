# -*- coding: utf-8 -*-
"""验证：编辑态类（is-annotating / is-text-mode / is-drawing）在
「退出编辑 → 关闭阅读器 → 重开文献」之后不再残留。

用户实测（2026-09-25，emu_watch.py 旁观记录）抓到的残留：
    打开论文后 reader 类 = "reader is-text-mode is-open"
                                   ^^^^^^^^^^^^ 不该有

真因：open() 里只 `classList.remove('is-annotating')`，
      漏了 is-text-mode / is-drawing。

本脚本用真实触摸走完整来回，每一步都打印三个类。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

FAIL = []


def js(cdp, code):
    return cdp.evaluate(code)


def ok(name, cond, detail=''):
    print('    %s %s%s' % ('✅' if cond else '❌', name,
                           ('  ' + detail) if detail else ''))
    if not cond:
        FAIL.append(name)


def tap_finger(cdp, x, y, wait=1.0, why=''):
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.06)
    cdp.touch('touchEnd', [])
    time.sleep(wait)
    return why


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
    if not b or not b['ok']:
        print('    ✗ %s 点不到（%s）' % (sel, b['hit'] if b else '不存在'))
        return False
    tap_finger(cdp, b['x'], b['y'], wait, why)
    return True


def classes(cdp):
    return js(cdp, """
        var r = document.getElementById('reader');
        if (!r) return null;
        return JSON.stringify({
          cls: r.className,
          annotating: r.classList.contains('is-annotating'),
          textMode: r.classList.contains('is-text-mode'),
          drawing: r.classList.contains('is-drawing'),
          raw: r.classList.contains('is-raw'),
          open: r.classList.contains('is-open'),
          layers: document.querySelectorAll('.anno-layer').length,
          blocks: document.querySelectorAll('.anno-block').length
        });
    """)


def show(cdp, label):
    c = classes(cdp)
    print('  [%s] %s' % (label, c))
    return json.loads(c) if c else {}


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

        vp = js(cdp, 'return [window.innerWidth, window.innerHeight]')

        def menu_on():
            if js(cdp, "return document.getElementById('reader')"
                       ".classList.contains('is-menu-open')") is True:
                return
            tap_finger(cdp, vp[0] // 2, int(vp[1] * 0.45), 0.8, '唤菜单')

        # 从零开始
        js(cdp, "if (window.ScholariusReader && window.ScholariusReader.close) "
                "window.ScholariusReader.close(); return 1")
        time.sleep(1.5)

        print('=' * 62)
        print('① 打开论文 → 原始视图 → 编辑模式 → 选「文本」')
        print('=' * 62)
        tap_sel(cdp, '.doc-card', 3.0, '打开')
        menu_on()
        tap_sel(cdp, '#reader-view-toggle', 3.0, '原始视图')
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-slot').length") > 0:
                break
            time.sleep(0.3)
        menu_on()
        tap_sel(cdp, '#reader-annotate', 2.5, '进编辑模式')
        for _ in range(60):
            if js(cdp, "return document.querySelectorAll('.anno-layer').length") > 0:
                break
            time.sleep(0.4)
        menu_on()
        cur = js(cdp, """
            var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
            return a ? a.getAttribute('data-edit-mode') : null;
        """)
        if cur != 'text':
            tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 1.0, '文本模式')
        s = show(cdp, '编辑中·文本模式')
        ok('编辑中应有 is-annotating', s.get('annotating') is True)
        ok('编辑中应有 is-text-mode', s.get('textMode') is True)
        ok('编辑中应有层与块', s.get('layers', 0) > 0 and s.get('blocks', 0) > 0,
           '层=%s 块=%s' % (s.get('layers'), s.get('blocks')))

        print()
        print('=' * 62)
        print('② 退出编辑模式 → 三个类都应清掉')
        print('=' * 62)
        menu_on()
        tap_sel(cdp, '#reader-annotate', 2.0, '退出编辑')
        s = show(cdp, '退出编辑后')
        ok('退出后 is-annotating 应清', s.get('annotating') is False)
        ok('退出后 is-text-mode 应清', s.get('textMode') is False)
        ok('退出后 is-drawing 应清', s.get('drawing') is False)

        print()
        print('=' * 62)
        print('③ 关闭阅读器 → 重开文献 —— 用户踩到的场景')
        print('=' * 62)
        tap_sel(cdp, '#reader-back', 2.0, '返回（关阅读器）')
        time.sleep(1.5)
        show(cdp, '关闭后')
        tap_sel(cdp, '.doc-card', 3.0, '重新打开')
        s = show(cdp, '重开后')
        ok('重开后 is-text-mode 不应残留', s.get('textMode') is False,
           'cls=%s' % s.get('cls'))
        ok('重开后 is-annotating 不应残留', s.get('annotating') is False)
        ok('重开后 is-drawing 不应残留', s.get('drawing') is False)

        print()
        print('=' * 62)
        print('④ 重进编辑模式 —— 层与块要正常挂上')
        print('=' * 62)
        menu_on()
        tap_sel(cdp, '#reader-view-toggle', 3.0, '原始视图')
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-slot').length") > 0:
                break
            time.sleep(0.3)
        menu_on()
        tap_sel(cdp, '#reader-annotate', 2.5, '进编辑模式')
        for _ in range(60):
            if js(cdp, "return document.querySelectorAll('.anno-layer').length") > 0:
                break
            time.sleep(0.4)
        s = show(cdp, '重进编辑模式')
        ok('重进编辑模式后层挂上了', s.get('layers', 0) > 0,
           '层=%s' % s.get('layers'))
        ok('重进编辑模式后块挂上了', s.get('blocks', 0) > 0,
           '块=%s' % s.get('blocks'))

        print()
        print('=' * 58)
        if FAIL:
            print('❌ 失败 %d 项：%s' % (len(FAIL), '；'.join(FAIL)))
            return 1
        print('✅ 编辑态类不再残留')
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
