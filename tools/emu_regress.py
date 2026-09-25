# -*- coding: utf-8 -*-
"""手势回归：确认画框修复没破坏其它交互。

覆盖（全部走**真实触摸**）：
    A. 编辑模式下**点空白处**不应生成框（用户报的「点一下就生成框」）
    B. 编辑模式下**轻微抖动**（< slop 3mm）不应生成框
    C. 编辑模式下**拖拽**应生成框
    D. 文本模式：文字块应可点（回去确认没把文本模式弄坏）
    E. 非编辑模式：页面**能正常滚动**（touch-action 改动的主要风险）

用法：python tools/emu_regress.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

FAIL = []


def ok(name, cond, detail=''):
    print('  %s %s%s' % ('✅' if cond else '❌', name,
                         ('  ' + detail) if detail else ''))
    if not cond:
        FAIL.append(name)
    return cond


def boxes(cdp):
    return cdp.evaluate("return document.querySelectorAll('.anno-box').length")


def ensure_menu_open(cdp, tries=6):
    """确保菜单展开 —— 否则底栏滑到屏外（y≈923 > 视口 915），按钮点不到。

    ⚠️ 点屏幕正中空白处是切菜单的手势，所以这里点一次就切一次状态。
       要**先读状态再决定点不点**，不能盲点（盲点两次等于没点）。
    """
    for _ in range(tries):
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-menu-open')") is True:
            return True
        vp = cdp.evaluate('return [window.innerWidth, window.innerHeight]')
        cdp.touch('touchStart', [(vp[0] // 2, int(vp[1] * 0.45))])
        time.sleep(0.05)
        cdp.touch('touchEnd', [])
        time.sleep(0.5)
    return False


def ensure_reader_editing(cdp):
    """确保在：阅读器 + 原始视图 + 编辑模式 + formula 模式。"""
    # ⚠️ 刚 force-stop 重启后 DOM 还没建好，先等 #reader 出现
    for _ in range(40):
        if cdp.evaluate("return !!document.getElementById('reader')") is True:
            break
        time.sleep(0.4)
    else:
        raise SystemExit('#reader 一直没出现（应用起来了吗？）')

    # splash
    for _ in range(40):
        v = cdp.evaluate("""
            var s = document.querySelector('.splash');
            if (!s) return true;
            var cs = getComputedStyle(s);
            return cs.display === 'none' || cs.opacity === '0' || s.hidden === true;
        """)
        if v:
            break
        time.sleep(0.4)
    cdp.evaluate("""
        if (window.ScholariusShell && window.ScholariusShell.setAccount &&
            !window.__fakeSignedIn) {
            window.ScholariusShell.setAccount(true, 'eliaszwc', 'EliasZWC',
                '', 'test-account-id');
            window.__fakeSignedIn = true;
        }
        return 1;
    """)
    time.sleep(0.3)

    def tap_sel(sel):
        b = cdp.evaluate("""
            var e = document.querySelector(%s);
            if (!e) return null;
            var r = e.getBoundingClientRect();
            return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
        """ % json.dumps(sel))
        if not b:
            return False
        cdp.touch('touchStart', [(b[0], b[1])])
        time.sleep(0.05)
        cdp.touch('touchEnd', [])
        time.sleep(0.45)
        return True

    if cdp.evaluate("return document.getElementById('reader').classList.contains('is-open')") is not True:
        tap_sel('.doc-card')
        time.sleep(0.8)
    if cdp.evaluate("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
        vp = cdp.evaluate('return [window.innerWidth, window.innerHeight]')
        cdp.touch('touchStart', [(vp[0] // 2, vp[1] // 2)])
        time.sleep(0.05)
        cdp.touch('touchEnd', [])
        time.sleep(0.5)
    if cdp.evaluate("return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
        tap_sel('#reader-view-toggle')
        time.sleep(0.8)
    if cdp.evaluate("return document.getElementById('reader').classList.contains('is-annotating')") is not True:
        tap_sel('#reader-annotate')
        time.sleep(0.9)
    # 选 formula（矩形模式）
    if cdp.evaluate("""
        var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
        return a ? a.getAttribute('data-edit-mode') : null;
    """) != 'formula':
        tap_sel('.reader-editbar [data-edit-mode="formula"]')
        time.sleep(0.5)


def layer_rect(cdp, page=1):
    return cdp.evaluate("""
        var l = document.querySelector('.anno-layer[data-page="%d"]');
        if (!l) return null;
        var b = l.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.top),
                Math.round(b.width), Math.round(b.height)];
    """ % page)


def pick_point(cdp, x, y):
    """在 (x,y) 上命中测试，返回命中的元素描述。"""
    return cdp.evaluate("""
        var t = document.elementFromPoint(%d, %d);
        return t ? (t.tagName + '.' + (t.className||'').toString()
                    .split(' ').slice(0,3).join('.')) : 'null';
    """ % (x, y))


def safe_pts(cdp, r):
    """在层里挑两个**确定命中的是层本身**的点（避开顶栏/编辑栏的浮层）。

    ⚠️ 不能想当然按百分比取 —— 页图从 y=25 起，但顶栏 .reader-top 浮在最上面，
       底部编辑栏也浮着。必须逐点 elementFromPoint 验证。
    """
    cands = []
    for fy in (0.25, 0.35, 0.45, 0.55, 0.30, 0.40):
        for fx in (0.30, 0.45, 0.60):
            cands.append((r[0] + int(r[2] * fx), r[1] + int(r[3] * fy)))
    good = [p for p in cands if 'anno-layer' in pick_point(cdp, p[0], p[1])]
    if len(good) < 2:
        raise SystemExit('找不到两个落在标注层上的测试点（命中：%s）'
                         % [pick_point(cdp, p[0], p[1]) for p in cands])
    # 取相距最远的一对，保证拖拽位移足够
    best = max(((a, b) for a in good for b in good),
               key=lambda ab: (ab[0][0] - ab[1][0]) ** 2 + (ab[0][1] - ab[1][1]) ** 2)
    return best[0], best[1]


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        ensure_reader_editing(cdp)
        r = layer_rect(cdp, 1)
        print('第1页标注层 rect = %s' % r)
        # ⚠️ 必须逐点验证命中层本身 —— 顶栏/编辑栏是浮层，按百分比取的
        #    点很容易落在它们上面（实测 y=0.15 命中的是 header.reader-top）
        (x0, y0), (x1, y1) = safe_pts(cdp, r)
        print('测试点：起点 (%d,%d) -> %s ；终点 (%d,%d) -> %s'
              % (x0, y0, pick_point(cdp, x0, y0),
                 x1, y1, pick_point(cdp, x1, y1)))

        print('\nA. 点空白处不应生成框')
        n0 = boxes(cdp)
        cdp.touch('touchStart', [(x0, y0)])
        time.sleep(0.08)
        cdp.touch('touchEnd', [])
        time.sleep(0.45)
        ok('点一下不生成框', boxes(cdp) == n0, '前%d 后%d' % (n0, boxes(cdp)))

        print('\nB. 轻微抖动不应生成框（位移 < 3mm slop）')
        n0 = boxes(cdp)
        cdp.touch('touchStart', [(x0, y0)])
        time.sleep(0.05)
        # ⚠️ 累积位移必须 **小于** slop（3mm ≈ 11.3 CSS px）。
        #    用欧氏距离：√(dx²+dy²)。(10,8) 已经是 12.8px —— 超了，
        #    会被正确判成拖拽。所以这里最大只到 (7,6) ≈ 9.2px。
        for dx, dy in ((2, 1), (4, 3), (6, 5), (7, 6)):
            cdp.touch('touchMove', [(x0 + dx, y0 + dy)])
            time.sleep(0.03)
        cdp.touch('touchEnd', [])
        time.sleep(0.45)
        ok('抖动不生成框', boxes(cdp) == n0, '前%d 后%d' % (n0, boxes(cdp)))

        print('\nC. 拖拽应生成框')
        # ⚠️ 起点必须**避开已有框**（不然会被判成"点框"→ 删除）。
        #    B 如果意外画出了框，先清掉，保证 C 从干净状态开始。
        clean = cdp.evaluate("""
            var n = 0;
            var bs = document.querySelectorAll('.anno-box');
            for (var i = 0; i < bs.length; i++) {
                var b = bs[i], r = b.getBoundingClientRect();
                var cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2);
                if (window.ScholariusUI && window.ScholariusUI.markDragged) {
                    window.ScholariusUI.markDragged();
                }
            }
            return bs.length;
        """)
        if clean:
            # 用真实触摸逐个点掉
            for _ in range(clean):
                c = cdp.evaluate("""
                    var b = document.querySelector('.anno-box');
                    if (!b) return null;
                    var r = b.getBoundingClientRect();
                    return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
                """)
                if not c:
                    break
                cdp.touch('touchStart', [(c[0], c[1])])
                time.sleep(0.06)
                cdp.touch('touchEnd', [])
                time.sleep(0.4)
            print('  （清掉 %d 个残留框，现在 %d 个）' % (clean, boxes(cdp)))

        n0 = boxes(cdp)
        cdp.touch('touchStart', [(x0, y0)])
        time.sleep(0.04)
        steps = 16
        for i in range(1, steps + 1):
            t = float(i) / steps
            cdp.touch('touchMove', [(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)])
            time.sleep(0.013)
        cdp.touch('touchEnd', [])
        time.sleep(0.5)
        ok('拖拽生成 1 个框', boxes(cdp) == n0 + 1,
           '前%d 后%d' % (n0, boxes(cdp)))

        print('\nD. 点已有框应删除')
        if boxes(cdp) == 0:
            ok('点框删除', False, '没有框可删（C 失败导致）')
        else:
            n0 = boxes(cdp)
            c = cdp.evaluate("""
                var b = document.querySelector('.anno-box');
                if (!b) return null;
                var r = b.getBoundingClientRect();
                return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
            """)
            cdp.touch('touchStart', [(c[0], c[1])])
            time.sleep(0.06)
            cdp.touch('touchEnd', [])
            time.sleep(0.5)
            ok('点框删除', boxes(cdp) == n0 - 1, '前%d 后%d' % (n0, boxes(cdp)))

        print('\nE. 切回文本模式，文字块应可点')
        # ⚠️ A/B 两次点空白会各 toggle 一次菜单，所以这里菜单状态不确定。
        #    必须先确保菜单是开的，否则底栏在屏外（y≈923 > 视口 915），点不到。
        ensure_menu_open(cdp)
        b = cdp.evaluate("""
            var e = document.querySelector('.reader-editbar [data-edit-mode="text"]');
            if (!e) return null;
            var r = e.getBoundingClientRect();
            return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
        """)
        if not b:
            ok('文本模式类已加', False, '找不到 text 选项按钮')
        else:
            cdp.touch('touchStart', [(b[0], b[1])])
            time.sleep(0.05)
            cdp.touch('touchEnd', [])
            time.sleep(0.5)
        st = cdp.evaluate("""
            var root = document.getElementById('reader');
            var l = document.querySelector('.anno-layer');
            var bk = l ? l.querySelector('.anno-block') : null;
            var hit = null;
            if (bk) {
                var r = bk.getBoundingClientRect();
                var t = document.elementFromPoint(r.left + r.width/2, r.top + 3);
                hit = t ? (t.tagName + '.' + (t.className||'').toString().split(' ').slice(0,3).join('.')) : 'null';
            }
            return { textMode: root.classList.contains('is-text-mode'),
                     layerPE: l ? getComputedStyle(l).pointerEvents : null,
                     hit: hit };
        """)
        print('  %s' % json.dumps(st, ensure_ascii=False))
        ok('文本模式类已加', st['textMode'] is True)
        ok('文本模式下层不接手势', st['layerPE'] == 'none')
        if st['hit'] and st['hit'] != 'null':
            ok('文本模式下文字块可命中', 'anno-block' in st['hit'],
               '命中 %s' % st['hit'])

        print('\nF. 退出编辑模式后页面能滚动')
        ensure_menu_open(cdp)
        b = cdp.evaluate("""
            var e = document.getElementById('reader-annotate');
            if (!e) return null;
            var r = e.getBoundingClientRect();
            return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
        """)
        if not b:
            ok('非编辑模式可滚动', False, '找不到 annotate 按钮')
        else:
            cdp.touch('touchStart', [(b[0], b[1])])
            time.sleep(0.05)
            cdp.touch('touchEnd', [])
            time.sleep(0.7)
            before = cdp.evaluate("""
                var b = document.querySelector('.reader-body');
                return b ? b.scrollTop : -1;
            """)
            vp = cdp.evaluate('return [window.innerWidth, window.innerHeight]')
            sy = int(vp[1] * 0.7)
            ey = int(vp[1] * 0.35)
            cdp.touch('touchStart', [(vp[0] // 2, sy)])
            time.sleep(0.05)
            for i in range(1, 15):
                t = float(i) / 14
                cdp.touch('touchMove', [(vp[0] // 2, sy + (ey - sy) * t)])
                time.sleep(0.014)
            cdp.touch('touchEnd', [])
            time.sleep(0.6)
            after = cdp.evaluate("""
                var b = document.querySelector('.reader-body');
                return b ? b.scrollTop : -1;
            """)
            ok('非编辑模式可滚动', after > before,
               'scrollTop %s -> %s' % (before, after))

    finally:
        cdp.close()

    print('\n' + ('=' * 46))
    if FAIL:
        print('❌ 失败 %d 项：%s' % (len(FAIL), ', '.join(FAIL)))
        return 1
    print('✅ 全部手势回归通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
