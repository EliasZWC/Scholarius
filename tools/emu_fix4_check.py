# -*- coding: utf-8 -*-
"""验证本轮三处修复（2026-09-25 第二轮用户反馈）。

用户三个问题：
  1. 「清除按钮可以清除框，但单独框点开表单选择清除依旧无法清除。」
  2. 「无法拖拽形成框，整个选中功能不可用；点击可用，但单纯点击应该是
      唤出菜单，而不是形成一个框（且框的大小无法确定）。」
  3. 「阅读视图并没有按照更改后的框重新排版。」

本轮改动：
  A. setView() 切视图时**自动退出编辑模式**（修"状态错乱"→ 三个问题的共同根源）
  B. 画框的 MIN 从 0.012 提到 0.05（≈4.9px → ≈20.6px）→ 点击不再生成小框
  C. 矩形模式下"未超 slop 的点击"主动 toggleMenu()（点击唤出菜单）
  D. annotateMode === null 时拖拽/点击给提示（不再静默无反应）

本脚本逐项验证 A~D。
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


def tap(cdp, x, y, wait=0.8):
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.05)
    cdp.touch('touchEnd', [])
    time.sleep(wait)


def tap_sel(cdp, sel, wait=0.8):
    b = js(cdp, """
        var e = document.querySelector(%s);
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width) return null;
        return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
    """ % json.dumps(sel))
    if not b:
        return None
    tap(cdp, b[0], b[1], wait)
    return b


def menu_on(cdp):
    if js(cdp, "return document.getElementById('reader')"
               ".classList.contains('is-menu-open')") is True:
        return True
    vp = js(cdp, 'return [window.innerWidth, window.innerHeight]')
    tap(cdp, vp[0] // 2, int(vp[1] * 0.45), 0.8)
    return True


def drag(cdp, x0, y0, x1, y1, steps=18):
    cdp.touch('touchStart', [(x0, y0)])
    time.sleep(0.04)
    for i in range(1, steps + 1):
        t = float(i) / steps
        cdp.touch('touchMove', [(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)])
        time.sleep(0.013)
    cdp.touch('touchEnd', [])
    time.sleep(0.6)


def st(cdp):
    return js(cdp, """
        var r = document.getElementById('reader');
        return {
          readerClass: r ? r.className : null,
          raw: !!document.querySelector('.pdf-slot .pdf-page-img'),
          read: !!document.querySelector('.reader-para'),
          layers: document.querySelectorAll('.anno-layer').length,
          drawing: document.querySelectorAll('.anno-layer.is-drawing').length,
          boxes: document.querySelectorAll('.anno-box').length,
          menu: r ? r.classList.contains('is-menu-open') : null,
          pressed: (function () {
            var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
            return a ? a.getAttribute('data-edit-mode') : null;
          })(),
          tipVisible: (function () {
            var t = document.querySelector('.anno-tip');
            return t ? t.classList.contains('is-visible') : null;
          })(),
          tipText: (function () {
            var t = document.querySelector('.anno-tip');
            return t ? (t.textContent || '').slice(0, 40) : null;
          })()
        };
    """)


def setup_raw_formula(cdp):
    """幂等：阅读器 + 原始视图 + 编辑模式 + formula。"""
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
    time.sleep(0.4)
    if js(cdp, "return document.getElementById('reader')"
               ".classList.contains('is-open')") is not True:
        tap_sel(cdp, '.doc-card', 1.8)
    if js(cdp, "return document.getElementById('reader')"
               ".classList.contains('is-annotating')") is True:
        menu_on(cdp)
        tap_sel(cdp, '#reader-annotate', 1.6)
    menu_on(cdp)
    if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
        tap_sel(cdp, '#reader-view-toggle', 2.0)
    # ⚠️ 必须等页图真正出现（切视图是异步的）
    for _ in range(40):
        if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is True:
            break
        time.sleep(0.3)
    # ⚠️⚠️ 滚回顶部（踩过的坑）
    #
    # `emu_regress.py` 最后一步测的是"退出编辑后页面能滚动"，它把 `.reader-body`
    # 滚到了 312px。本脚本紧接着跑时，页面停在中间：
    #   · 后面按层矩形比例算出的起手点可能落到另一页/页缝上
    #   · `elementFromPoint` 的命中结果与"页面顶部"完全不同
    # 于是"大拖拽生成框"失败 —— 看着像功能坏了，其实是**脚本间状态残留**。
    # 修：进来先无条件滚回顶部。
    js(cdp, """
        var b = document.querySelector('.reader-body');
        if (b) b.scrollTop = 0;
        window.scrollTo(0, 0);
        return 1;
    """)
    time.sleep(0.4)
    menu_on(cdp)
    if js(cdp, "return document.getElementById('reader')"
               ".classList.contains('is-annotating')") is not True:
        tap_sel(cdp, '#reader-annotate', 1.8)
    for _ in range(50):
        n = js(cdp, "return document.querySelectorAll('.anno-block').length")
        if n and n > 0:
            break
        time.sleep(0.4)
    cur = js(cdp, """
        var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
        return a ? a.getAttribute('data-edit-mode') : null;
    """)
    if cur != 'formula':
        tap_sel(cdp, '.reader-editbar [data-edit-mode="formula"]', 1.0)


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        print('=' * 62)
        print('[C+D] 矩形模式：点击唤出菜单 / 未选类型时给提示')
        print('=' * 62)
        setup_raw_formula(cdp)
        s = st(cdp)
        print('  就绪: raw=%s layers=%s drawing=%s pressed=%s'
              % (s['raw'], s['layers'], s['drawing'], s['pressed']))
        if s['layers'] == 0 or s['drawing'] == 0:
            raise SystemExit('❌ 就绪失败')

        # 找块空白区（避开已有框与文字块命中问题）
        r = js(cdp, """
            var l = document.querySelector('.anno-layer.is-drawing');
            var b = l.getBoundingClientRect();
            return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
        """)
        # 页面下部空白（避开顶栏/编辑栏）
        cx = r[0] + int(r[2] * 0.5)
        cy = r[1] + int(r[3] * 0.78)
        hit = js(cdp, """
            var t = document.elementFromPoint(%d, %d);
            return t ? (t.tagName + '.' + (t.className||'').toString().split(' ').slice(0,3).join('.')) : 'null';
        """ % (cx, cy))
        print('  点击点 (%d,%d) 命中: %s' % (cx, cy, hit))

        menu_before = st(cdp)['menu']
        boxes_before = st(cdp)['boxes']
        tap(cdp, cx, cy, 0.9)
        after = st(cdp)
        ok('点击未生成框', after['boxes'] == boxes_before,
           '%d -> %d' % (boxes_before, after['boxes']))
        ok('点击切换了菜单', after['menu'] != menu_before,
           '%s -> %s' % (menu_before, after['menu']))

        # ---- 取消 formula → 应为 null → 点击给提示 ----
        print('\n  取消 formula（点已选中的 = 开关取消）')
        menu_on(cdp)
        tap_sel(cdp, '.reader-editbar [data-edit-mode="formula"]', 1.0)
        s2 = st(cdp)
        print('  取消后: pressed=%s drawing=%s' % (s2['pressed'], s2['drawing']))
        ok('取消后 annotateMode 为 null', s2['pressed'] is None)
        ok('取消后层不再 is-drawing', s2['drawing'] == 0, '%d' % s2['drawing'])

        # 此时点击应给提示
        menu_on(cdp)
        tap(cdp, cx, cy, 0.9)
        s3 = st(cdp)
        print('  点击后 tip: visible=%s text="%s"' % (s3['tipVisible'], s3['tipText']))
        ok('未选类型时点击给出提示', s3['tipVisible'] is True,
           'visible=%s' % s3['tipVisible'])

        # 恢复 formula
        menu_on(cdp)
        tap_sel(cdp, '.reader-editbar [data-edit-mode="formula"]', 1.0)

        # ---- B. MIN 提高：微小位移不生成框 ----
        print('\n' + '=' * 62)
        print('[B] 微小位移（15px）不应生成框（MIN 已提到 ≈20.6px）')
        print('=' * 62)
        b0 = st(cdp)['boxes']
        # 15px 位移：超过 slop(11.3) 但小于 MIN(20.6) → 应被 reject
        drag(cdp, cx, cy, cx + 11, cy + 10, steps=8)
        b1 = st(cdp)['boxes']
        ok('15px 拖拽不生成框', b1 == b0, '%d -> %d' % (b0, b1))
        log = js(cdp, """
            return (window.__bootLog || []).filter(function (x) {
                return /anno:reject|anno:added/.test(x);
            }).slice(-3);
        """)
        for l in log:
            print('      ' + str(l))

        print('\n  正常拖拽（>100px）应生成框')
        # ⚠️ 起手点必须避开已有框（否则走"点框删除"分支，画不出来）——
        #    同 emu_draw_check.py 的处理。前一个断言可能已留下标注。
        spot = js(cdp, """
            var l = document.querySelector('.anno-layer');
            if (!l) return null;
            var lr = l.getBoundingClientRect();
            var boxes = document.querySelectorAll('.anno-box');
            for (var fy = 0.12; fy < 0.55; fy += 0.06) {
                for (var fx = 0.10; fx < 0.85; fx += 0.06) {
                    var x0 = Math.round(lr.left + lr.width * fx);
                    var y0 = Math.round(lr.top + lr.height * fy);
                    var t0 = document.elementFromPoint(x0, y0);
                    if (!t0 || !t0.classList ||
                        !t0.classList.contains('anno-layer')) continue;
                    var x1 = Math.round(x0 + lr.width * 0.40);
                    var y1 = Math.round(y0 + lr.height * 0.28);
                    if (x1 > lr.right - 8 || y1 > lr.bottom - 8) continue;
                    var t1 = document.elementFromPoint(x1, y1);
                    if (!t1 || !t1.classList ||
                        !t1.classList.contains('anno-layer')) continue;
                    var clash = false;
                    for (var i = 0; i < boxes.length; i++) {
                        var br = boxes[i].getBoundingClientRect();
                        if (!(x1 < br.left - 6 || x1 > br.right + 6 ||
                              y1 < br.top - 6 || y1 > br.bottom + 6)) clash = true;
                    }
                    if (clash) continue;
                    return { x0: x0, y0: y0, x1: x1, y1: y1 };
                }
            }
            return null;
        """)
        if not spot:
            print('      ⚠️ 找不到空白起手点，退回固定比例')
            spot = {'x0': r[0] + int(r[2] * 0.2), 'y0': r[1] + int(r[3] * 0.2),
                    'x1': r[0] + int(r[2] * 0.8), 'y1': r[1] + int(r[3] * 0.6)}
        drag(cdp, spot['x0'], spot['y0'], spot['x1'], spot['y1'])
        b2 = st(cdp)['boxes']
        ok('大拖拽生成框', b2 == b0 + 1, '%d -> %d' % (b0, b2))

        # ---- A. 切视图自动退出编辑模式 ----
        print('\n' + '=' * 62)
        print('[A] 编辑模式下切到阅读视图 → 应自动退出编辑模式')
        print('=' * 62)
        before = st(cdp)
        print('  切换前: %s' % before['readerClass'])
        menu_on(cdp)
        tap_sel(cdp, '#reader-view-toggle', 2.0)
        after2 = st(cdp)
        print('  切换后: %s' % after2['readerClass'])
        print('          raw=%s read=%s layers=%s drawing=%s pressed=%s'
              % (after2['raw'], after2['read'], after2['layers'],
                 after2['drawing'], after2['pressed']))
        ok('已切到阅读视图', after2['read'] is True)
        ok('自动退出了编辑模式',
           'is-annotating' not in (after2['readerClass'] or ''),
           after2['readerClass'])
        ok('is-text-mode 也清了',
           'is-text-mode' not in (after2['readerClass'] or ''),
           after2['readerClass'])
        ok('标注层已卸载', after2['layers'] == 0, '%d' % after2['layers'])
        pad = js(cdp, """
            var b = document.querySelector('.reader-body');
            return b ? getComputedStyle(b).paddingTop : null;
        """)
        ok('body padding-top 已复原', pad == '0px', pad)

        # ---- A2. 阅读视图下编辑按钮应不可进（或提示） ----
        print('\n[A2] 阅读视图下点编辑按钮 → 不应进入"无层的编辑模式"')
        menu_on(cdp)
        tap_sel(cdp, '#reader-annotate', 1.2)
        after3 = st(cdp)
        print('  点击后: %s' % after3['readerClass'])
        bad = ('is-annotating' in (after3['readerClass'] or '')) and after3['layers'] == 0
        ok('未出现"编辑模式但无层"的矛盾状态', not bad,
           'cls=%s layers=%s' % (after3['readerClass'], after3['layers']))

        print('\n' + '=' * 58)
        if FAIL:
            print('❌ 失败 %d 项：%s' % (len(FAIL), ', '.join(FAIL)))
            return 1
        print('✅ 本轮三处修复全部通过')
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
