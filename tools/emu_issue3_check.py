# -*- coding: utf-8 -*-
"""复现用户报的三个问题（2026-09-25 第二轮）。

用户原话：
  1. 「清除按钮可以清除框，但单独框点开表单选择清除依旧无法清除。」
  2. 「无法拖拽形成框，相当于整个选中功能不可用；点击可用，
      但这是错误的逻辑，因为单纯点击应该是唤出菜单，而不是形成一个框
      （且框的大小无法确定）。」
  3. 「阅读视图并没有按照更改后的框重新排版。」

本脚本只做**观察**，逐步 dump，不改任何东西。
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


def sheet(cdp):
    """当前弹层的按钮和选项。"""
    return js(cdp, """
        var s = document.querySelector('.anno-typesheet');
        if (!s) return null;
        var out = { title: null, opts: [], btns: [] };
        var t = s.querySelector('.anno-typesheet-title');
        out.title = t ? t.textContent : null;
        var o = s.querySelectorAll('.anno-typeopt');
        for (var i = 0; i < o.length; i++) {
            var r = o[i].getBoundingClientRect();
            out.opts.push({ text: (o[i].textContent||'').trim(),
                            pressed: o[i].getAttribute('aria-pressed'),
                            cx: Math.round(r.left+r.width/2),
                            cy: Math.round(r.top+r.height/2) });
        }
        var b = s.querySelectorAll('.btn');
        for (var k = 0; k < b.length; k++) {
            var br = b[k].getBoundingClientRect();
            out.btns.push({ text: (b[k].textContent||'').trim(),
                            cls: b[k].className,
                            cx: Math.round(br.left+br.width/2),
                            cy: Math.round(br.top+br.height/2) });
        }
        return out;
    """)


def state(cdp):
    return js(cdp, """
        var r = document.getElementById('reader');
        return {
          readerClass: r ? r.className : null,
          hasPageImg: !!document.querySelector('.pdf-slot .pdf-page-img'),
          hasPara: !!document.querySelector('.reader-para'),
          layers: document.querySelectorAll('.anno-layer').length,
          boxes: document.querySelectorAll('.anno-box').length,
          blocks: document.querySelectorAll('.anno-block').length,
          visTags: (function () {
            var n = 0, bs = document.querySelectorAll('.anno-block-tag');
            for (var i = 0; i < bs.length; i++)
              if (getComputedStyle(bs[i]).display !== 'none') n++;
            return n;
          })(),
          pressed: (function () {
            var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
            return a ? a.getAttribute('data-edit-mode') : null;
          })()
        };
    """)


def show(cdp, label):
    d = state(cdp)
    print('  [%s] view=%s layers=%s boxes=%s blocks=%s visTag=%s pressed=%s'
          % (label,
             'RAW' if d['hasPageImg'] else ('READ' if d['hasPara'] else '?'),
             d['layers'], d['boxes'], d['blocks'], d['visTags'], d['pressed']))
    return d


def enter_raw_editing(cdp, mode='formula'):
    """幂等：进 阅读器 + 原始视图 + 编辑模式 + 指定模式。"""
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
    # 已在编辑模式 → 先退出
    if js(cdp, "return document.getElementById('reader')"
               ".classList.contains('is-annotating')") is True:
        menu_on(cdp)
        tap_sel(cdp, '#reader-annotate', 1.6)
    menu_on(cdp)
    if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
        tap_sel(cdp, '#reader-view-toggle', 2.0)
    menu_on(cdp)
    if js(cdp, "return document.getElementById('reader')"
               ".classList.contains('is-annotating')") is not True:
        tap_sel(cdp, '#reader-annotate', 1.8)
    for _ in range(50):
        n = js(cdp, "return document.querySelectorAll('.anno-block').length")
        if n and n > 0:
            break
        time.sleep(0.4)
    # 切模式
    cur = js(cdp, """
        var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
        return a ? a.getAttribute('data-edit-mode') : null;
    """)
    if cur != mode:
        tap_sel(cdp, '.reader-editbar [data-edit-mode="%s"]' % mode, 1.0)
    return state(cdp)


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        print('=' * 62)
        print('准备：进 原始视图 + 编辑模式 + formula（矩形）')
        print('=' * 62)
        st = enter_raw_editing(cdp)
        show(cdp, '就绪')
        if not st['hasPageImg']:
            raise SystemExit('❌ 没能切到原始视图')
        if st['layers'] == 0:
            raise SystemExit('❌ 原始视图下没有标注层')

        # ---- 问题 2：拖拽画框 ----
        print('\n' + '=' * 62)
        print('问题 2：拖拽画框')
        print('=' * 62)
        layer = js(cdp, """
            var l = document.querySelector('.anno-layer[data-page="1"]');
            if (!l) return null;
            var b = l.getBoundingClientRect();
            var cs = getComputedStyle(l);
            return { rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
                     pe: cs.pointerEvents, ta: cs.touchAction, cls: l.className };
        """)
        print('  第1页标注层: %s' % json.dumps(layer, ensure_ascii=False))
        if not layer:
            raise SystemExit('❌ 第1页没有标注层')

        r = layer['rect']
        x0 = r[0] + int(r[2] * 0.25)
        y0 = r[1] + int(r[3] * 0.25)
        x1 = r[0] + int(r[2] * 0.75)
        y1 = r[1] + int(r[3] * 0.60)
        print('  起点 (%d,%d) 终点 (%d,%d)' % (x0, y0, x1, y1))
        print('  起点命中: %s' % js(cdp, """
            var t = document.elementFromPoint(%d, %d);
            return t ? (t.tagName + '.' + (t.className||'').toString().split(' ').slice(0,3).join('.')) : 'null';
        """ % (x0, y0)))

        cdp.evaluate('window.__touchRec = []; window.__rec2 = window.__touchRec; return 1')
        js(cdp, """
            if (!window.__rec3) {
              window.__rec3 = [];
              ['pointerdown','pointermove','pointerup','pointercancel','touchstart','touchend','click']
                .forEach(function (n) {
                  document.addEventListener(n, function (ev) {
                    var t = ev.target;
                    window.__rec3.push(n + ' -> ' + (t ? (t.tagName + '.' +
                      (t.className||'').toString().split(' ').slice(0,2).join('.')) : 'null'));
                    if (window.__rec3.length > 200) window.__rec3.shift();
                  }, true);
                });
            }
            window.__rec3 = [];
            return 1;
        """)

        cdp.touch('touchStart', [(x0, y0)])
        time.sleep(0.04)
        for i in range(1, 19):
            t = float(i) / 18
            cdp.touch('touchMove', [(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)])
            time.sleep(0.013)
        cdp.touch('touchEnd', [])
        time.sleep(0.6)

        rec = js(cdp, 'return (window.__rec3 || []).slice()')
        print('  事件序列 (%d 条，只看关键):' % len(rec))
        seen = {}
        for e in rec:
            k = e.split(' ')[0]
            if k not in seen:
                seen[k] = e
        for k in ('pointerdown', 'pointermove', 'pointercancel', 'pointerup', 'click'):
            print('    %-14s %s' % (k, seen.get(k, '(未出现)')))
        show(cdp, '拖拽后')

        # ---- 问题 2b：点击不应生成框 ----
        print('\n' + '=' * 62)
        print('问题 2b：纯点击（应唤出菜单，不应生成框）')
        print('=' * 62)
        before = js(cdp, "return document.querySelectorAll('.anno-box').length")
        menu_before = js(cdp, "return document.getElementById('reader')"
                              ".classList.contains('is-menu-open')")
        cx = r[0] + int(r[2] * 0.5)
        cy = r[1] + int(r[3] * 0.85)
        print('  点击 (%d,%d) 前：框=%s 菜单=%s' % (cx, cy, before, menu_before))
        tap(cdp, cx, cy, 0.8)
        after = js(cdp, "return document.querySelectorAll('.anno-box').length")
        menu_after = js(cdp, "return document.getElementById('reader')"
                            ".classList.contains('is-menu-open')")
        print('  点击后：框=%s 菜单=%s' % (after, menu_after))
        if after > before:
            print('  ❌ 生成了框（用户报的问题）')
        else:
            print('  ✅ 未生成框')
        if menu_after != menu_before:
            print('  ✅ 菜单已切换')
        else:
            print('  ❌ 菜单没变（用户期望唤出菜单）')

        # ---- 问题 1：点框 → 表单 → 清除 ----
        print('\n' + '=' * 62)
        print('问题 1：点已有框 → 表单里的「清除」')
        print('=' * 62)
        n = js(cdp, "return document.querySelectorAll('.anno-box').length")
        if n == 0:
            print('  没有框可点 —— 先画一个')
            cdp.touch('touchStart', [(x0, y0)])
            time.sleep(0.04)
            for i in range(1, 13):
                t = float(i) / 12
                cdp.touch('touchMove', [(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)])
                time.sleep(0.013)
            cdp.touch('touchEnd', [])
            time.sleep(0.6)
            n = js(cdp, "return document.querySelectorAll('.anno-box').length")
            print('  画完：框=%s' % n)

        if n > 0:
            c = js(cdp, """
                var b = document.querySelector('.anno-box');
                var r = b.getBoundingClientRect();
                return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
            """)
            print('  点框中心 (%d,%d)' % (c[0], c[1]))
            tap(cdp, c[0], c[1], 1.0)
            s = sheet(cdp)
            if s:
                print('  ⚠️ 点框弹出了表单！标题="%s"' % s['title'])
                print('     选项：%s' % [o['text'] for o in s['opts']])
                print('     按钮：%s' % [(b['text'], b['cls']) for b in s['btns']])
            else:
                print('  ✅ 点框没有弹出表单（应直接删除）')
            show(cdp, '点框后')

        print('\n=== anno 日志 ===')
        for line in js(cdp, """
            return (window.__bootLog || []).filter(function (x) {
                return /annotate|anno:/.test(x);
            }).slice(-18);
        """):
            print('  ' + str(line))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
