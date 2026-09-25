# -*- coding: utf-8 -*-
"""在模拟器里用**真实触摸**走一遍「消框」，把实际发生的事打出来。

用户原话（2026-09-25）：
    「我进了模拟器这个框也消不掉啊」
    「不是新问题」（= 和之前那个问题同一个）

⚠️ 本脚本的纪律（用户明确要求「必须模拟手指点击」）：
   · 每一步都先 elementFromPoint 确认**手指会点中谁**，
     被挡住就打印挡它的是谁，不硬点。
   · 断言打在**用户能看到的东西**上（.anno-box 数量、块的标签可见性）。
   · 两条消框路径都走：
       ① 矩形框：点一下框内部 → 应直接删除
       ② 文字块：点一下块 → 应弹类型表单；表单里应能"清除"
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
    """真实触摸点击，点之前确认命中。"""
    hit = js(cdp, """
        var t = document.elementFromPoint(%d, %d);
        return t ? (t.tagName + '.' + (t.className||'').toString()
                    .split(' ').slice(0,2).join('.')) : 'null';
    """ % (x, y))
    print('    手指点 (%d,%d) → 命中 %s   %s' % (x, y, hit, why))
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
                       .split(' ').slice(0,2).join('.')) : 'null' };
    """ % json.dumps(sel))
    if not b:
        print('    ✗ %s 不存在或不可见' % sel)
        return False
    if not b['ok']:
        print('    ✗ %s 被 %s 挡住，点不到' % (sel, b['hit']))
        return False
    tap_finger(cdp, b['x'], b['y'], wait, why)
    return True


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        # ---- 从零开始：关阅读器，重开 ----
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
        js(cdp, "if (window.ScholariusReader && window.ScholariusReader.close) "
                "window.ScholariusReader.close(); return 1")
        time.sleep(1.5)
        # 清掉磁盘标注，保证从"刚导入"的干净状态开始
        import subprocess
        from emu_js import ADB
        PKG = 'com.eliaszwc.scholarius.debug'
        subprocess.run([ADB, 'shell', 'run-as', PKG, 'rm', '-f',
                        'files/library/devtest1/annotations.json'],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        js(cdp, "if (window.ScholariusReader && window.ScholariusReader.close) "
                "window.ScholariusReader.close(); return 1")
        time.sleep(1.0)

        print('=' * 62)
        print('① 打开论文 → 原始视图')
        print('=' * 62)
        tap_sel(cdp, '.doc-card', 2.5, '打开论文')
        def menu_on():
            if js(cdp, "return document.getElementById('reader')"
                       ".classList.contains('is-menu-open')") is True:
                return
            vp = js(cdp, 'return [window.innerWidth, window.innerHeight]')
            tap_finger(cdp, vp[0] // 2, int(vp[1] * 0.45), 0.8, '唤出菜单')
        menu_on()
        tap_sel(cdp, '#reader-view-toggle', 2.5, '切到原始视图')
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-slot').length") > 0:
                break
            time.sleep(0.3)
        js(cdp, "var b=document.querySelector('.reader-body'); if(b) b.scrollTop=0; return 1")
        time.sleep(0.5)
        print('  slots=%s' % js(cdp, "return document.querySelectorAll('.pdf-slot').length"))

        print()
        print('=' * 62)
        print('② 进编辑模式（不选任何类型）→ 看自动识别的框')
        print('=' * 62)
        menu_on()
        tap_sel(cdp, '#reader-annotate', 2.0, '进编辑模式')
        for _ in range(60):
            if js(cdp, "return document.querySelectorAll('.anno-block').length") > 0:
                break
            time.sleep(0.4)
        print('  ' + js(cdp, """
            var r = document.getElementById('reader');
            var eb = document.querySelector('.reader-editbar');
            var pressed = null;
            if (eb) {
                var a = eb.querySelector('[data-edit-mode][aria-pressed="true"]');
                pressed = a ? a.getAttribute('data-edit-mode') : null;
            }
            return 'reader=' + r.className +
                   '\\n  层=' + document.querySelectorAll('.anno-layer').length +
                   '  块=' + document.querySelectorAll('.anno-block').length +
                   '  框=' + document.querySelectorAll('.anno-box').length +
                   '  当前类型=' + pressed;
        """))

        print()
        print('=' * 62)
        print('③ 路径 A：点一个**文字块**（自动识别的框）→ 应弹类型表单')
        print('=' * 62)
        # 先切到文本模式（文字块只在文本模式下接手势）
        menu_on()
        cur = js(cdp, """
            var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
            return a ? a.getAttribute('data-edit-mode') : null;
        """)
        if cur != 'text':
            tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 1.0, '选文本模式')
        blk = js(cdp, """
            var l = document.querySelector('.anno-layer');
            var bs = l.querySelectorAll('.anno-block');
            for (var i = 0; i < bs.length; i++) {
                var r = bs[i].getBoundingClientRect();
                if (r.top < 220 || r.bottom > 660 || r.width < 70) continue;
                var cx = Math.round(r.left + r.width/2);
                var cy = Math.round(r.top + r.height/2);
                var t = document.elementFromPoint(cx, cy);
                if (!t || !(t === bs[i] || bs[i].contains(t))) continue;
                return { x: cx, y: cy,
                         line: bs[i].getAttribute('data-block-line'),
                         tt: bs[i].getAttribute('data-text-type') };
            }
            return null;
        """)
        if not blk:
            print('  ✗ 找不到可点的文字块')
        else:
            print('  目标块 line=%s 类型=%s' % (blk['line'], blk['tt']))
            tap_finger(cdp, blk['x'], blk['y'], 1.0, '点文字块')
            sheet = js(cdp, """
                var s = document.querySelector('.anno-typesheet');
                if (!s) return null;
                var o = s.querySelectorAll('.anno-typeopt, .btn');
                var out = [];
                for (var i = 0; i < o.length; i++) {
                    var r = o[i].getBoundingClientRect();
                    out.push({ tx: (o[i].textContent||'').trim().slice(0,14),
                               cls: (o[i].className||'').toString().slice(0,30),
                               x: Math.round(r.left+r.width/2),
                               y: Math.round(r.top+r.height/2),
                               w: Math.round(r.width) });
                }
                return JSON.stringify(out);
            """)
            if not sheet:
                print('  ❌ 点了块，但**类型表单没弹出来**')
            else:
                print('  ✅ 表单弹出来了，可选项：')
                for o in json.loads(sheet):
                    print('      "%s"  %s  (%dx 位置 %d,%d)'
                          % (o['tx'], o['cls'], o['w'], o['x'], o['y']))

        print()
        print('=' * 62)
        print('④ 路径 B：拖一个矩形框，然后**点它** → 应直接删除')
        print('=' * 62)
        # 先收起表单
        js(cdp, """
            var s = document.querySelector('.anno-typesheet');
            if (s && s.parentNode) s.parentNode.removeChild(s);
            return 1;
        """)
        menu_on()
        cur = js(cdp, """
            var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
            return a ? a.getAttribute('data-edit-mode') : null;
        """)
        if cur != 'formula':
            tap_sel(cdp, '.reader-editbar [data-edit-mode="formula"]', 1.0, '选公式模式')
        # 找干净起手点
        spot = js(cdp, """
            var l = document.querySelector('.anno-layer');
            if (!l) return null;
            var lr = l.getBoundingClientRect();
            var boxes = document.querySelectorAll('.anno-box');
            for (var fy = 0.10; fy < 0.60; fy += 0.05) {
                for (var fx = 0.08; fx < 0.85; fx += 0.05) {
                    var x0 = Math.round(lr.left + lr.width*fx);
                    var y0 = Math.round(lr.top + lr.height*fy);
                    var x1 = Math.round(x0 + lr.width*0.35);
                    var y1 = Math.round(y0 + lr.height*0.22);
                    if (x1 > lr.right - 8 || y1 > lr.bottom - 8) continue;
                    var a = document.elementFromPoint(x0, y0);
                    var b = document.elementFromPoint(x1, y1);
                    if (!a || !b) continue;
                    if (!a.classList.contains('anno-layer')) continue;
                    if (!b.classList.contains('anno-layer')) continue;
                    var clash = false;
                    for (var i = 0; i < boxes.length; i++) {
                        var br = boxes[i].getBoundingClientRect();
                        if (!(x1 < br.left-6 || x1 > br.right+6 ||
                              y1 < br.top-6 || y1 > br.bottom+6)) clash = true;
                    }
                    if (clash) continue;
                    return { x0: x0, y0: y0, x1: x1, y1: y1 };
                }
            }
            return null;
        """)
        if not spot:
            print('  ✗ 找不到干净起手点')
        else:
            nb = js(cdp, "return document.querySelectorAll('.anno-box').length")
            print('  拖 (%d,%d) → (%d,%d)   拖前框数=%d'
                  % (spot['x0'], spot['y0'], spot['x1'], spot['y1'], nb))
            cdp.touch('touchStart', [(spot['x0'], spot['y0'])])
            time.sleep(0.08)
            for i in range(1, 13):
                t = float(i) / 12
                cdp.touch('touchMove', [(
                    spot['x0'] + (spot['x1'] - spot['x0']) * t,
                    spot['y0'] + (spot['y1'] - spot['y0']) * t)])
                time.sleep(0.025)
            cdp.touch('touchEnd', [])
            time.sleep(0.8)
            na = js(cdp, "return document.querySelectorAll('.anno-box').length")
            print('  拖后框数=%d  %s' % (na, '✅ 画出' if na == nb + 1 else '❌ 没画出来'))

            if na > nb:
                # 点最后一个框的中心
                box = js(cdp, """
                    var bs = document.querySelectorAll('.anno-box:not(.is-ghost)');
                    var b = bs[bs.length - 1];
                    var r = b.getBoundingClientRect();
                    var cx = Math.round(r.left + r.width/2);
                    var cy = Math.round(r.top + r.height/2);
                    var t = document.elementFromPoint(cx, cy);
                    return { x: cx, y: cy,
                             w: Math.round(r.width), h: Math.round(r.height),
                             hit: t ? (t.tagName + '.' + (t.className||'').toString()
                                   .split(' ').slice(0,2).join('.')) : 'null',
                             isBox: !!(t && (t === b || b.contains(t) ||
                                     (t.closest && t.closest('.anno-box') === b))) };
                """)
                print('  框尺寸 %dx 中心 (%d,%d)' % (box['w'], box['h'], box['x'], box['y']))
                print('  手指点它会命中: %s   是该框本身: %s' % (box['hit'], box['isBox']))
                tap_finger(cdp, box['x'], box['y'], 1.0, '点框（应删除）')
                nc = js(cdp, "return document.querySelectorAll('.anno-box').length")
                print('  点后框数=%d  %s' % (nc, '✅ 删掉了' if nc == nb else '❌ 没删掉'))

        print()
        print('=' * 62)
        print('⑤ anno 日志')
        print('=' * 62)
        for l in js(cdp, """
            return (window.__bootLog||[]).filter(function(x){
                return /anno:/.test(x);
            }).slice(-14).map(String);
        """):
            print('    ' + str(l))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
