# -*- coding: utf-8 -*-
"""验证：在原始视图里，手指划过 PDF 上的文字**能不能选中**。

用户原话（2026-09-25）：
    「字体根本无法选中啊」「面对任何形式的拖拽都没有办法识别」
    「我说的是原始视图」

本脚本用真实触摸拖拽，然后查 `window.getSelection()` ——
这是"选中"的唯一可靠判据（不看样式、不看元素，只看浏览器有没有选区）。
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


def tap_sel(cdp, sel, wait=1.2, why=''):
    b = js(cdp, """
        var e = document.querySelector(%s);
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width) return null;
        var cx = Math.round(r.left + r.width/2);
        var cy = Math.round(r.top + r.height/2);
        var t = document.elementFromPoint(cx, cy);
        return { x: cx, y: cy, ok: !!(t && (t === e || e.contains(t))) };
    """ % json.dumps(sel))
    if not b or not b['ok']:
        print('    ✗ %s 点不到' % sel)
        return False
    tap_finger(cdp, b['x'], b['y'], wait, why)
    return True


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

        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-open')") is not True:
            tap_sel(cdp, '.doc-card', 3.0, '打开论文')

        print('=' * 62)
        print('① 切到原始视图 → 文字层挂上了吗')
        print('=' * 62)
        menu_on()
        if js(cdp, "return !!document.querySelector('.pdf-text-layer')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 3.0, '原始视图')
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-text-layer').length") > 0:
                break
            time.sleep(0.4)
        st = js(cdp, """
            var layers = document.querySelectorAll('.pdf-text-layer');
            var lines = document.querySelectorAll('.pdf-text-line');
            var first = layers[0];
            return JSON.stringify({
              layers: layers.length,
              lines: lines.length,
              firstCls: first ? first.className : null,
              firstPE: first ? getComputedStyle(first).pointerEvents : null,
              firstUS: first ? getComputedStyle(first).userSelect : null,
              firstZ: first ? getComputedStyle(first).zIndex : null,
              sampleText: lines.length ? (lines[0].textContent || '') : '',
              sampleFS: lines.length ? getComputedStyle(lines[0]).fontSize : null,
              sampleColor: lines.length ? getComputedStyle(lines[0]).color : null
            }, null, 1);
        """)
        print('  %s' % st)
        d = json.loads(st)
        ok('文字层挂上了', d['layers'] > 0, '层=%d 行=%d' % (d['layers'], d['lines']))
        ok('非编辑模式下文字层接手势', d['firstPE'] == 'auto', d['firstPE'])
        ok('文字层允许选中', d['firstUS'] == 'text', d['firstUS'])
        ok('文字是透明的（看不见但可选中）',
           'rgba(0, 0, 0, 0)' in (d['sampleColor'] or ''), d['sampleColor'])

        print()
        print('=' * 62)
        print('② 真实触摸拖拽 —— 能不能选中文字')
        print('=' * 62)
        # 清掉可能的旧选区
        js(cdp, "window.getSelection().removeAllRanges(); return 1")

        # 找两行文字的目标坐标（用文字层自己的盒子）
        pos = js(cdp, """
            var lines = document.querySelectorAll('.pdf-text-line');
            var vis = [];
            for (var i = 0; i < lines.length; i++) {
                var r = lines[i].getBoundingClientRect();
                if (r.top < 180 || r.bottom > 700) continue;
                if (r.width < 20 || r.height < 4) continue;
                vis.push({ x: r.left, y: r.top, w: r.width, h: r.height,
                           i: i, t: (lines[i].textContent || '').slice(0, 18) });
            }
            if (vis.length < 4) return null;
            var a = vis[0], b = vis[vis.length - 1];
            return { fx: Math.round(a.x + 2), fy: Math.round(a.y + a.h/2),
                     tx: Math.round(b.x + Math.min(b.w, 120)),
                     ty: Math.round(b.y + b.h/2),
                     aT: a.t, bT: b.t, n: vis.length };
        """)
        if not pos:
            print('  ✗ 找不到可见的文字行')
        else:
            print('  可见文字行 %d 个' % pos['n'])
            print('  从 "%s" 拖到 "%s"' % (pos['aT'], pos['bT']))
            print('  坐标 (%d,%d) → (%d,%d)'
                  % (pos['fx'], pos['fy'], pos['tx'], pos['ty']))
            hit = js(cdp, """
                var t = document.elementFromPoint(%d, %d);
                return t ? (t.tagName + '.' +
                       (t.className||'').toString().split(' ').slice(0,2).join('.')) : 'null';
            """ % (pos['fx'], pos['fy']))
            print('  起点命中: %s' % hit)

            cdp.touch('touchStart', [(pos['fx'], pos['fy'])])
            time.sleep(0.15)
            steps = 14
            for i in range(1, steps + 1):
                t = float(i) / steps
                cdp.touch('touchMove', [(
                    pos['fx'] + (pos['tx'] - pos['fx']) * t,
                    pos['fy'] + (pos['ty'] - pos['fy']) * t)])
                time.sleep(0.03)
            cdp.touch('touchEnd', [])
            time.sleep(0.8)

            sel = js(cdp, """
                var s = window.getSelection();
                return JSON.stringify({
                  n: s ? s.rangeCount : -1,
                  text: s ? String(s) : '',
                  len: s ? String(s).length : 0
                });
            """)
            sd = json.loads(sel)
            print('  选区: %s' % sel)
            ok('拖拽选中了文字', sd['len'] > 0,
               '选中 %d 字符：%s' % (sd['len'], sd['text'][:50]))

        print()
        print('=' * 62)
        print('③ 编辑模式画框时，文字层**不能**抢手势')
        print('=' * 62)
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
        if cur != 'formula':
            tap_sel(cdp, '.reader-editbar [data-edit-mode="formula"]', 1.0, '公式模式')
        pe = js(cdp, """
            var l = document.querySelector('.pdf-text-layer');
            return l ? getComputedStyle(l).pointerEvents : null;
        """)
        print('  画框模式下文字层 pointer-events = %s' % pe)
        ok('画框模式下文字层不接手势', pe == 'none', str(pe))

        print()
        print('=' * 58)
        if FAIL:
            print('❌ 失败 %d 项：%s' % (len(FAIL), '；'.join(FAIL)))
            return 1
        print('✅ 文字层可用，能选中')
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
