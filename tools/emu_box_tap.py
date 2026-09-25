# -*- coding: utf-8 -*-
"""验证假设：矩形模式下「点已有框」没有删除，反而**新建了一个框**。

用户描述（2026-09-25）：
    「仍然是无法删除，然后我尝试改变分类，结果是增加后，
      旧分类到了框的右下角，然后再改，又增加了一个；
      但那个删除不掉的框上面的分类最多三个？」

假设：用户说的「分类」其实是**新建出来的框的标签**（.anno-box-tag）。
      「旧分类跑到右下角」= 旧框的标签，新框盖在上面，
      而新框比旧框小/位置偏，于是看起来像"旧标签移动到了右下"。

本脚本：画一个框 → 在框中心点一下 → 看框数量与每个框的 rect/tag。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

BOXES_JS = """
var out = [];
var bs = document.querySelectorAll('.anno-box');
for (var i = 0; i < bs.length; i++) {
    var b = bs[i], r = b.getBoundingClientRect();
    var tg = b.querySelector('.anno-box-tag');
    // 这个框的中心点上"最上面的是谁"
    var hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    out.push({
        index: b.getAttribute('data-index'),
        cls: b.className,
        tag: tg ? tg.textContent : null,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        hit: hit ? (hit.tagName + '.' + (hit.className||'').toString().split(' ').slice(0,3).join('.')) : 'null'
    });
}
return out;
"""


def boxes(cdp):
    return cdp.evaluate(BOXES_JS)


def show(cdp, label):
    b = boxes(cdp)
    print('\n--- %s ---（%d 个框）' % (label, len(b)))
    for x in b:
        print('    index=%s tag=%-10s rect=%-24s hit=%s'
              % (x['index'], x['tag'], x['rect'], x['hit']))
    return b


def tap(cdp, x, y, wait=0.6):
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.05)
    cdp.touch('touchEnd', [])
    time.sleep(wait)


def tap_sel(cdp, sel, wait=0.6):
    b = cdp.evaluate("""
        var e = document.querySelector(%s);
        if (!e) return null;
        var r = e.getBoundingClientRect();
        return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
    """ % json.dumps(sel))
    if not b:
        return None
    tap(cdp, b[0], b[1], wait)
    return b


def drag(cdp, x0, y0, x1, y1, steps=16):
    cdp.touch('touchStart', [(x0, y0)])
    time.sleep(0.04)
    for i in range(1, steps + 1):
        t = float(i) / steps
        cdp.touch('touchMove', [(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)])
        time.sleep(0.013)
    cdp.touch('touchEnd', [])
    time.sleep(0.5)


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        for _ in range(40):
            if cdp.evaluate("return !!document.getElementById('reader')") is True:
                break
            time.sleep(0.4)
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
        time.sleep(0.4)

        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-open')") is not True:
            tap_sel(cdp, '.doc-card', 1.0)
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-menu-open')") is not True:
            vp = cdp.evaluate('return [window.innerWidth, window.innerHeight]')
            tap(cdp, vp[0] // 2, vp[1] // 2, 0.6)
        if cdp.evaluate("return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 0.9)
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 1.0)
        # 选 formula（矩形）
        cur = cdp.evaluate("""
            var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
            return a ? a.getAttribute('data-edit-mode') : null;
        """)
        if cur != 'formula':
            tap_sel(cdp, '.reader-editbar [data-edit-mode="formula"]', 0.8)

        print('=== 开始：画第 1 个框 ===')
        # 找一个安全区域（避开顶栏底栏）
        r = cdp.evaluate("""
            var l = document.querySelector('.anno-layer');
            var b = l.getBoundingClientRect();
            return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
        """)
        x0 = r[0] + int(r[2] * 0.22)
        y0 = r[1] + int(r[3] * 0.22)
        x1 = r[0] + int(r[2] * 0.75)
        y1 = r[1] + int(r[3] * 0.62)
        drag(cdp, x0, y0, x1, y1)
        b1 = show(cdp, '画完第 1 个框')
        if len(b1) != 1:
            raise SystemExit('⚠️ 期望 1 个框，实得 %d' % len(b1))

        # === 关键：在框中心点一下 ===
        c = cdp.evaluate("""
            var b = document.querySelector('.anno-box');
            var r = b.getBoundingClientRect();
            return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
        """)
        print('\n=== 在框中心点一下 (%d,%d) ===' % (c[0], c[1]))
        print('  （用户预期：删除这个框）')
        tap(cdp, c[0], c[1], 0.7)
        show(cdp, '点了一下之后')

        # 再点一下（如果还在）
        if len(boxes(cdp)) > 0:
            c2 = cdp.evaluate("""
                var bs = document.querySelectorAll('.anno-box');
                var b = bs[bs.length - 1];
                var r = b.getBoundingClientRect();
                return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
            """)
            print('\n=== 再点一下 (%d,%d) ===' % (c2[0], c2[1]))
            tap(cdp, c2[0], c2[1], 0.7)
            show(cdp, '点第二下之后')

        if len(boxes(cdp)) > 0:
            c3 = cdp.evaluate("""
                var bs = document.querySelectorAll('.anno-box');
                var b = bs[bs.length - 1];
                var r = b.getBoundingClientRect();
                return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
            """)
            print('\n=== 点第三下 (%d,%d) ===' % (c3[0], c3[1]))
            tap(cdp, c3[0], c3[1], 0.7)
            show(cdp, '点第三下之后')

        print('\n=== anno 日志 ===')
        log = cdp.evaluate("""
            return (window.__bootLog || []).filter(function (l) {
                return /anno/.test(l);
            }).slice(-20);
        """)
        for l in log:
            print('  ' + str(l))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
