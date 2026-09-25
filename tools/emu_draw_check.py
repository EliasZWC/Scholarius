# -*- coding: utf-8 -*-
"""一键复现「画框」流程，用于真机回归验证。

流程（每一步都断点断言，失败立刻停，避免后面步骤在错的状态上瞎跑）：
    1. 打开阅读器（从文库点第一张卡片）
    2. 进编辑模式（点 reader-annotate）
    3. 选一个矩形类型（formula）
    4. 断言 .anno-layer.is-drawing 的 pointer-events === auto
    5. 真实触摸拖拽画框
    6. 断言产生了 1 个 .anno-box
    7. 真实触摸点该框（应删除）
    8. 断言回到 0 个 .anno-box

用法：
    python tools/emu_draw_check.py            # 全流程
    python tools/emu_draw_check.py --keep     # 画完不删，留着看图

背景见 tools/emu_touch.py 顶部说明。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp, RECORDER_JS  # noqa: E402


def wait_js(cdp, expr, want, tries=20, gap=0.3, what=''):
    """轮询直到 expr 求值 === want（或 want(val) 为真）。"""
    last = None
    for _ in range(tries):
        last = cdp.evaluate(expr)
        if callable(want):
            if want(last):
                return last
        elif last == want:
            return last
        time.sleep(gap)
    raise SystemExit('等待超时 %s：最后一次 = %r' % (what or expr, last))


def tap_css(cdp, sel, label=''):
    """按元素中心点做真实触摸点击。"""
    box = cdp.evaluate("""
        var e = document.querySelector(%s);
        if (!e) return null;
        var r = e.getBoundingClientRect();
        return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
    """ % json.dumps(sel))
    if not box:
        raise SystemExit('找不到元素：%s' % sel)
    cdp.touch('touchStart', [(box[0], box[1])])
    time.sleep(0.05)
    cdp.touch('touchEnd', [])
    time.sleep(0.45)
    print('  tap %s %s @ (%d,%d)' % (sel, label, box[0], box[1]))
    return box


def layer_rect(cdp, page=1):
    r = cdp.evaluate("""
        var l = document.querySelector('.anno-layer[data-page="%d"]');
        if (!l) return null;
        var b = l.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.top),
                Math.round(b.width), Math.round(b.height)];
    """ % page)
    if not r:
        raise SystemExit('第 %d 页没有标注层' % page)
    return r


def count_boxes(cdp):
    return cdp.evaluate("return document.querySelectorAll('.anno-box').length")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--keep', action='store_true', help='画完不删')
    args = ap.parse_args()

    if not ensure_ready():
        raise SystemExit('没找到 WebView socket（应用在前台？）')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        cdp.evaluate(RECORDER_JS)

        print('[0] 等启动页退场 + 设登录态')
        # splash 会盖住整个界面（z-index 40），不等它退场后面全部点不中
        wait_js(cdp, """
            var s = document.querySelector('.splash');
            if (!s) return true;
            var cs = getComputedStyle(s);
            return cs.display === 'none' || cs.opacity === '0' ||
                   cs.visibility === 'hidden' || s.hidden === true;
        """, True, tries=40, gap=0.4, what='splash 退场')
        # 强制登录：登录层 z-index 50 会盖住文库
        cdp.evaluate("""
            if (window.ScholariusShell && window.ScholariusShell.setAccount &&
                !window.__fakeSignedIn) {
                window.ScholariusShell.setAccount(true, 'eliaszwc', 'EliasZWC',
                    '', 'test-account-id');
                window.__fakeSignedIn = true;
            }
            return 1;
        """)
        time.sleep(0.4)

        print('[1] 打开阅读器')
        # 若已在阅读器里就跳过
        if cdp.evaluate("return document.getElementById('reader').classList.contains('is-open')") is not True:
            tap_css(cdp, '.doc-card', '(卡片)')
            wait_js(cdp, "return document.getElementById('reader').classList.contains('is-open')",
                    True, what='阅读器打开')

        # 阅读器刚打开时底栏是收起的，点屏幕中间唤起菜单
        if cdp.evaluate("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
            vp = cdp.evaluate('return [window.innerWidth, window.innerHeight]')
            cdp.touch('touchStart', [(vp[0] // 2, vp[1] // 2)])
            time.sleep(0.05)
            cdp.touch('touchEnd', [])
            time.sleep(0.5)
            wait_js(cdp, "return document.getElementById('reader').classList.contains('is-menu-open')",
                    True, what='菜单唤起')

        print('[2] 切原始视图 + 进编辑模式')
        if cdp.evaluate("return document.getElementById('reader').classList.contains('is-annotating')") is not True:
            # 先确保在原始视图（编辑按钮只在 raw 下出现）
            if cdp.evaluate("return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
                tap_css(cdp, '#reader-view-toggle', '(切换视图)')
                wait_js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')",
                        True, what='原始视图')
            tap_css(cdp, '#reader-annotate', '(进入编辑)')
            wait_js(cdp, "return document.getElementById('reader').classList.contains('is-annotating')",
                    True, what='编辑模式')

        print('[3] 选矩形类型 (formula)')
        tap_css(cdp, '.reader-editbar [data-edit-mode="formula"]', '(Formula)')

        print('[4] 断言层可交互')
        st = wait_js(cdp, """
            var l = document.querySelector('.anno-layer');
            if (!l) return null;
            var cs = getComputedStyle(l);
            return { cls: l.className, pe: cs.pointerEvents, ta: cs.touchAction };
        """, lambda v: v and v.get('pe') == 'auto', what='层 pointer-events=auto')
        print('  %s' % json.dumps(st, ensure_ascii=False))
        if 'is-drawing' not in st['cls']:
            raise SystemExit('❌ 层没有 is-drawing：%s' % st['cls'])
        # ⚠️ 必须 none：manipulation 允许 pan，浏览器会判成滚动并 pointercancel
        if st['ta'] != 'none':
            raise SystemExit('❌ touch-action 是 %r，应为 none —— '
                             '否则拖拽会被浏览器当成滚动而取消' % st['ta'])

        # 断言块不再抢事件
        # ⚠️ 必须用 elementFromPoint ——
        #    `getComputedStyle(el).pointerEvents` 对未显式设置的元素返回
        #    初始值 "auto"，**即使父层是 none**。用它判断会永远误判。
        probe = cdp.evaluate("""
            var l = document.querySelector('.anno-layer');
            var b = l.querySelector('.anno-block');
            if (!b) return { blocks: 0, note: 'no-blocks' };
            var r = b.getBoundingClientRect();
            // ⚠️ 取**上边缘内侧**而不是中心：底部编辑栏浮在页图之上，
            //    块中心可能正好落在编辑栏里，那样测到的是编辑栏而非块。
            var top = document.elementFromPoint(r.left + r.width/2, r.top + 3);
            return {
                blocks: 1,
                blockPE: getComputedStyle(b).pointerEvents,
                hit: top ? (top.tagName + '.' + (top.className||'').toString()
                            .split(' ').slice(0,3).join('.')) : 'null',
                hitIsLayer: !!(top && top.classList &&
                               top.classList.contains('anno-layer'))
            };
        """)
        print('  块命中测试: %s' % json.dumps(probe, ensure_ascii=False))
        if probe.get('blocks') and not probe.get('hitIsLayer'):
            raise SystemExit('❌ 文字块仍在抢事件（命中 %s）—— 拖拽会被 pointercancel 掐断'
                             % probe.get('hit'))

        print('[5] 真实拖拽画框')
        r = layer_rect(cdp, 1)
        x0 = r[0] + int(r[2] * 0.20)
        y0 = r[1] + int(r[3] * 0.20)
        x1 = r[0] + int(r[2] * 0.78)
        y1 = r[1] + int(r[3] * 0.70)
        cdp.evaluate('window.__touchRec = []; return 1')
        cdp.touch('touchStart', [(x0, y0)])
        time.sleep(0.04)
        steps = 18
        for i in range(1, steps + 1):
            t = float(i) / steps
            cdp.touch('touchMove', [(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)])
            time.sleep(0.013)
        cdp.touch('touchEnd', [])
        time.sleep(0.5)
        print('  drag (%d,%d) -> (%d,%d)' % (x0, y0, x1, y1))

        rec = cdp.evaluate('return (window.__touchRec||[]).slice()')
        print('  --- 事件序列 ---')
        for e in rec:
            print('  %-13s (%4d,%4d) -> %-34s' % (e['ev'], e['x'], e['y'], e['target']))
        if any(e['ev'] == 'pointercancel' for e in rec):
            print('  ⚠️ 出现 pointercancel！')

        n = count_boxes(cdp)
        print('[6] 框数量 = %d' % n)
        if n != 1:
            # 打印诊断日志
            log = cdp.evaluate('return (window.__bootLog||[]).filter(function(l){return /anno/.test(l)}).slice(-15)')
            print('  --- anno 日志 ---')
            for l in log:
                print('  ' + str(l))
            raise SystemExit('❌ 期望 1 个框，实得 %d' % n)

        if args.keep:
            print('✅ 画框成功（--keep，未删）')
            return 0

        print('[7] 点击该框（应删除）')
        c = cdp.evaluate("""
            var b = document.querySelector('.anno-box');
            var r = b.getBoundingClientRect();
            return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
        """)
        cdp.touch('touchStart', [(c[0], c[1])])
        time.sleep(0.05)
        cdp.touch('touchEnd', [])
        time.sleep(0.5)
        print('  tap (%d,%d)' % (c[0], c[1]))

        n2 = wait_js(cdp, "return document.querySelectorAll('.anno-box').length",
                     lambda v: v == 0, tries=8, gap=0.3, what='框被删除')
        print('[8] 删除后框数量 = %d' % n2)
        print('✅ 画框 + 删除 全流程通过')
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
