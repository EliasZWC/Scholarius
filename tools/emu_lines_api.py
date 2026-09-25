# -*- coding: utf-8 -*-
"""验证 getPdfPageLines 真的能取到该页的文字行（含坐标）。

这是「在 PDF 上选中文字」的第一步 —— 没有这个数据，
网页就叠不出透明文字层。

用真实触摸把应用走到原始视图，然后直接调桥接口看返回。
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
        return { x: cx, y: cy,
                 ok: !!(t && (t === e || e.contains(t))) };
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

        # 打开论文
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-open')") is not True:
            tap_sel(cdp, '.doc-card', 3.0, '打开论文')

        print('=' * 62)
        print('① 桥接口存在吗')
        print('=' * 62)
        print(js(cdp, """
            var b = window.ScholariusNative;
            if (!b) return '❌ 没有 ScholariusNative';
            var keys = [];
            for (var k in b) { keys.push(k); }
            var has = keys.indexOf('getPdfPageLines') >= 0;
            return (has ? '✅' : '❌') + ' getPdfPageLines 在桥上；' +
                   '相关方法：' +
                   keys.filter(function (k) {
                       return /Pdf|page|Page/.test(k);
                   }).join(', ');
        """))

        print()
        print('=' * 62)
        print('② 取第 1 页的文字行')
        print('=' * 62)
        doc_id = js(cdp, """
            // ⚠️ 从文库卡片拿 id —— 属性名先试两个常见的
            var cards = document.querySelectorAll('.doc-card');
            for (var i = 0; i < cards.length; i++) {
                var id = cards[i].getAttribute('data-doc-id') ||
                         cards[i].getAttribute('data-id');
                if (id) return id;
            }
            return null;
        """)
        print('  （网页里找到的 doc id: %s）' % doc_id)
        if not doc_id:
            print('  ⚠️ 卡片上没有 data-doc-id/data-id —— 直接用实测 id 试探')
            doc_id = 'devtest1'

        raw = js(cdp, """
            var b = window.ScholariusNative;
            if (!b || !b.getPdfPageLines) return '__NO_API__';
            try {
                return b.getPdfPageLines(%s, 1);
            } catch (e) {
                return '__EXC__ ' + (e && e.message ? e.message : String(e));
            }
        """ % (json.dumps(doc_id) if doc_id else "'devtest1'"))
        if raw in ('__NO_API__',) or (isinstance(raw, str) and raw.startswith('__EXC__')):
            print('  ❌ 调用失败: %s' % raw)
        else:
            try:
                arr = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                print('  ❌ 返回不是 JSON: %s' % str(raw)[:200])
                arr = []
            print('  行数: %d' % len(arr))
            print()
            print('  前 8 行:')
            for o in arr[:8]:
                print('    (%.3f,%.3f)-(%.3f,%.3f) s=%-6.1f "%s"'
                      % (o.get('x0', 0), o.get('y0', 0), o.get('x1', 0),
                         o.get('y1', 0), o.get('s', 0),
                         (o.get('t') or '')[:40]))
            if arr:
                print()
                print('  ✅ 文字行数据可用 —— 下一步：在页图上叠透明文字层')
            else:
                print()
                print('  ❌ 返回空 —— 检查 doc id 与 PdfText.pageLines')

        print()
        print('=' * 62)
        print('③ 各页行数（确认不是只有第 1 页有）')
        print('=' * 62)
        for p in (1, 2, 3):
            n = js(cdp, """
                var b = window.ScholariusNative;
                if (!b || !b.getPdfPageLines) return -1;
                try {
                    var a = JSON.parse(b.getPdfPageLines(%s, %d));
                    return a.length;
                } catch (e) { return -2; }
            """ % (json.dumps(doc_id) if doc_id else "'devtest1'", p))
            print('    第 %d 页: %s 行' % (p, n))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
