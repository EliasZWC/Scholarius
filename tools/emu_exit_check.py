# -*- coding: utf-8 -*-
"""验证：**退出编辑模式后，编辑相关的 UI 全部恢复**。

要恢复的东西（缺一项都是 bug）：
    · .reader 上的 is-annotating / is-text-mode 类
    · 标注层 .anno-layer / 文字块 .anno-block 应卸载
    · .reader-body 的 padding-top 应撤掉（新加的顶栏下推规则，
      不撤的话阅读模式下正文顶部会凭空多一条 113px 空白）
    · 底栏：编辑选项栏应隐藏，「目录 / 设置」应显示
    · .anno-fab（清空按钮）应隐藏
    · .anno-tip 提示气泡应收起

用法：python tools/emu_exit_check.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

STATE_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             '_diag14.js'), encoding='utf-8').read()


def js(cdp, code):
    return cdp.evaluate(code)


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


def show(cdp, label):
    d = js(cdp, STATE_JS)
    print('\n  ── %s ──' % label)
    print('     readerClass      : %s' % d['readerClass'])
    print('     is-annotating    : %s     is-text-mode : %s'
          % (d['hasIsAnnotating'], d['hasIsTextMode']))
    print('     标注层/文字块     : %s / %s' % (d['layers'], d['blocks']))
    print('     body padding-top : %s' % d['bodyPaddingTop'])
    print('     editbar hidden   : %s' % d['editbarHidden'])
    print('     普通按钮 hidden   : %s'
          % [(b['id'], b['hidden'], b['rect']) for b in d['normalBtns']])
    print('     anno-fab         : %s' % d['fab'])
    print('     anno-tip         : %s' % d['tip'])
    return d


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    fails = []
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
        time.sleep(0.4)
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-open')") is not True:
            tap_sel(cdp, '.doc-card', 1.8)
        menu_on(cdp)
        if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 1.6)
        menu_on(cdp)

        base = show(cdp, '① 基线：未进编辑模式')

        # ---- 进编辑模式 ----
        print('\n>>> 进编辑模式')
        menu_on(cdp)
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 1.8)
        for _ in range(50):
            n = js(cdp, "return document.querySelectorAll('.anno-block').length")
            if n and n > 0:
                break
            time.sleep(0.4)
        tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 1.0)
        # 顺手改一个块，确保 annotateDirty 也是脏的（更接近真实使用）
        blk = js(cdp, """
            var l = document.querySelector('.anno-layer');
            if (!l) return null;
            var bs = l.querySelectorAll('.anno-block');
            for (var i = 0; i < bs.length; i++) {
                var r = bs[i].getBoundingClientRect();
                var cx = r.left + r.width/2, cy = r.top + r.height/2;
                if (cy < 220 || cy > 700 || r.width < 60) continue;
                var t = document.elementFromPoint(cx, cy);
                if (!t || !(t === bs[i] || bs[i].contains(t))) continue;
                return { cx: Math.round(cx), cy: Math.round(cy),
                         line: bs[i].getAttribute('data-block-line') };
            }
            return null;
        """)
        if blk:
            tap(cdp, blk['cx'], blk['cy'], 1.0)
            o = js(cdp, """
                var s = document.querySelector('.anno-typesheet');
                if (!s) return null;
                var os = s.querySelectorAll('.anno-typeopt');
                for (var i = 0; i < os.length; i++) {
                    if (os[i].getAttribute('aria-pressed') !== 'true') {
                        var r = os[i].getBoundingClientRect();
                        return [Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)];
                    }
                }
                return null;
            """)
            if o:
                tap(cdp, o[0], o[1], 1.0)
                print('  （已改一个块：line=%s）' % blk['line'])
        editing = show(cdp, '② 编辑模式中')

        # ---- 退出编辑模式 ----
        print('\n>>> 退出编辑模式')
        menu_on(cdp)
        tap_sel(cdp, '#reader-annotate', 2.0)
        time.sleep(0.8)
        after = show(cdp, '③ 退出后')

        # ---- 断言 ----
        print('\n' + '=' * 56)
        print('=== 恢复检查 ===')

        def chk(name, cond, detail=''):
            print('  %s %s%s' % ('✅' if cond else '❌', name,
                                 ('  ' + detail) if detail else ''))
            if not cond:
                fails.append(name)

        chk('is-annotating 类已清', after['hasIsAnnotating'] is False,
            '实际 %s' % after['hasIsAnnotating'])
        chk('is-text-mode 类已清', after['hasIsTextMode'] is False,
            '实际 %s' % after['hasIsTextMode'])
        chk('标注层已卸载', after['layers'] == 0, '实际 %s' % after['layers'])
        chk('文字块已卸载', after['blocks'] == 0, '实际 %s' % after['blocks'])
        # ⚠️ 最关键：新加的 padding-top 必须撤掉
        base_pad = base['bodyPaddingTop']
        chk('body padding-top 已复原', after['bodyPaddingTop'] == base_pad,
            '基线 %s → 退出后 %s' % (base_pad, after['bodyPaddingTop']))
        chk('编辑选项栏已隐藏', after['editbarHidden'] is True,
            '实际 %s' % after['editbarHidden'])
        chk('底栏普通按钮已显示',
            all(b['hidden'] is False for b in after['normalBtns']) and
            all(b['rect'] is not None for b in after['normalBtns']),
            '%s' % [(b['id'], b['hidden'], b['rect']) for b in after['normalBtns']])
        chk('anno-fab 已隐藏',
            (after['fab'] is None) or after['fab']['hidden'] is True
            or after['fab']['rect'] is None,
            '%s' % after['fab'])
        chk('提示气泡已收起',
            (after['tip'] is None) or after['tip']['visible'] is False,
            '%s' % after['tip'])

        print('\n' + '=' * 56)
        if fails:
            print('❌ 未恢复 %d 项：%s' % (len(fails), ', '.join(fails)))
            return 1
        print('✅ 退出编辑模式后全部恢复')
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
