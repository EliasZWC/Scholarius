# -*- coding: utf-8 -*-
"""专查「类型表单里的 Delete 按钮能不能点到」。

背景（tools/emu_box_kill.py 实测）：
    文字块的类型表单弹出来后，选项位置是：
        Cancel  (44,850)
        Delete  (368,850)     ← 屏幕高度 915，它贴在 y=850
    用户报「框也消不掉」。

怀疑：Delete 位于屏幕最底部、又是右下角 —— 可能
  ① 被系统导航栏 / 手势区盖住（真机上更明显）
  ② 被其它元素挡住（elementFromPoint 会告诉我们是谁）
  ③ 可点区域太小（记忆 §0.0.2：40×40 在手机上就算点不中）

本脚本：弹表单 → 对 Delete 做完整的可达性检查 → 真实点它 → 看删没删。
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
    hit = js(cdp, """
        var t = document.elementFromPoint(%d, %d);
        return t ? (t.tagName + '.' + (t.className||'').toString()
                    .split(' ').slice(0,3).join('.')) : 'null';
    """ % (x, y))
    print('    → 点 (%d,%d) 命中 %s  %s' % (x, y, hit, why))
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
                       .split(' ').slice(0,3).join('.')) : 'null' };
    """ % json.dumps(sel))
    if not b:
        print('    ✗ %s 不存在或不可见' % sel)
        return False
    if not b['ok']:
        print('    ✗ %s 被 %s 挡住' % (sel, b['hit']))
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
        print('屏幕尺寸: %s' % vp)

        def menu_on():
            if js(cdp, "return document.getElementById('reader')"
                       ".classList.contains('is-menu-open')") is True:
                return
            tap_finger(cdp, vp[0] // 2, int(vp[1] * 0.45), 0.8, '唤出菜单')

        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-open')") is not True:
            tap_sel(cdp, '.doc-card', 2.5, '打开论文')
        menu_on()
        if js(cdp, "return !!document.querySelector('.pdf-slot')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 2.5, '原始视图')
        for _ in range(40):
            if js(cdp, "return document.querySelectorAll('.pdf-slot').length") > 0:
                break
            time.sleep(0.3)
        js(cdp, "var b=document.querySelector('.reader-body'); if(b) b.scrollTop=0; return 1")
        time.sleep(0.5)
        menu_on()
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 2.0, '进编辑模式')
        for _ in range(60):
            if js(cdp, "return document.querySelectorAll('.anno-block').length") > 0:
                break
            time.sleep(0.4)
        menu_on()
        cur = js(cdp, """
            var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
            return a ? a.getAttribute('data-edit-mode') : null;
        """)
        if cur != 'text':
            tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 1.0, '文本模式')

        print()
        print('=' * 62)
        print('① 先标一个块为 heading（制造"框"），再点它弹表单')
        print('=' * 62)
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
                return { x: cx, y: cy, line: bs[i].getAttribute('data-block-line') };
            }
            return null;
        """)
        if not blk:
            raise SystemExit('找不到可点的文字块')
        print('  目标块 line=%s' % blk['line'])
        tap_finger(cdp, blk['x'], blk['y'], 1.0, '点块 → 弹表单')

        # 选 Heading
        hi = js(cdp, """
            var s = document.querySelector('.anno-typesheet');
            if (!s) return null;
            var o = s.querySelectorAll('.anno-typeopt');
            for (var i = 0; i < o.length; i++) {
                if ((o[i].textContent||'').trim() === 'Heading') {
                    var r = o[i].getBoundingClientRect();
                    return { x: Math.round(r.left+r.width/2),
                             y: Math.round(r.top+r.height/2) };
                }
            }
            return null;
        """)
        if hi:
            tap_finger(cdp, hi['x'], hi['y'], 0.9, '选 Heading')
            lv = js(cdp, """
                var s = document.querySelector('.anno-typesheet');
                if (!s) return null;
                var o = s.querySelectorAll('.anno-typeopt');
                for (var i = 0; i < o.length; i++) {
                    if (/^L1/.test((o[i].textContent||'').trim())) {
                        var r = o[i].getBoundingClientRect();
                        return { x: Math.round(r.left+r.width/2),
                                 y: Math.round(r.top+r.height/2) };
                    }
                }
                return null;
            """)
            if lv:
                tap_finger(cdp, lv['x'], lv['y'], 0.9, '选 L1')
        st = js(cdp, """
            var l = document.querySelector('.anno-layer');
            var bs = l.querySelectorAll('.anno-block');
            for (var i = 0; i < bs.length; i++) {
                if (bs[i].getAttribute('data-block-line') === '%s') {
                    var tg = bs[i].querySelector('.anno-block-tag');
                    return (bs[i].getAttribute('data-text-type') || '?') +
                           ' / 标签可见=' + (tg ?
                             (getComputedStyle(tg).display !== 'none') : '无标签');
                }
            }
            return '找不到';
        """ % blk['line'])
        print('  标完状态: %s' % st)

        print()
        print('=' * 62)
        print('② 再点这个块 → 表单里 Delete 的可达性全面检查')
        print('=' * 62)
        menu_on()
        tap_finger(cdp, blk['x'], blk['y'], 1.0, '点块 → 弹表单')
        info = js(cdp, """
            var s = document.querySelector('.anno-typesheet');
            if (!s) return null;
            var del = null;
            var bs = s.querySelectorAll('.btn, .anno-typeopt');
            for (var i = 0; i < bs.length; i++) {
                if ((bs[i].textContent||'').trim() === 'Delete') { del = bs[i]; break; }
            }
            if (!del) return 'NO_DELETE_BUTTON';
            var r = del.getBoundingClientRect();
            var cx = Math.round(r.left + r.width/2);
            var cy = Math.round(r.top + r.height/2);
            var t = document.elementFromPoint(cx, cy);
            return JSON.stringify({
              rect: [Math.round(r.left), Math.round(r.top),
                     Math.round(r.width), Math.round(r.height)],
              center: [cx, cy],
              viewport: [window.innerWidth, window.innerHeight],
              bottomGap: Math.round(window.innerHeight - r.bottom),
              hitTag: t ? t.tagName + '.' + (t.className||'').toString().slice(0,50) : 'null',
              hitIsSelf: !!(t && (t === del || del.contains(t))),
              parentOfHit: t && t.parentElement ?
                (t.parentElement.tagName + '.' +
                 (t.parentElement.className||'').toString().slice(0,40)) : null
            }, null, 1);
        """)
        print('  Delete 按钮: %s' % info)
        if info and info != 'NO_DELETE_BUTTON':
            d = json.loads(info)
            print('    ⚠️ 距屏幕下沿只剩 %d px' % d['bottomGap'])
            print('    点它会命中: %s   是它自己: %s' % (d['hitTag'], d['hitIsSelf']))

        print()
        print('=' * 62)
        print('③ 真实点 Delete，看有没有删掉')
        print('=' * 62)
        before = js(cdp, """
            var l = document.querySelector('.anno-layer');
            var bs = l.querySelectorAll('.anno-block');
            for (var i = 0; i < bs.length; i++) {
                if (bs[i].getAttribute('data-block-line') === '%s') {
                    var tg = bs[i].querySelector('.anno-block-tag');
                    return { tt: bs[i].getAttribute('data-text-type'),
                             vis: tg ? (getComputedStyle(tg).display !== 'none') : false };
                }
            }
            return null;
        """ % blk['line'])
        print('  点前: %s' % json.dumps(before, ensure_ascii=False))
        if info and info != 'NO_DELETE_BUTTON':
            d = json.loads(info)
            tap_finger(cdp, d['center'][0], d['center'][1], 1.2, '点 Delete')
        after = js(cdp, """
            var l = document.querySelector('.anno-layer');
            var bs = l.querySelectorAll('.anno-block');
            for (var i = 0; i < bs.length; i++) {
                if (bs[i].getAttribute('data-block-line') === '%s') {
                    var tg = bs[i].querySelector('.anno-block-tag');
                    return { tt: bs[i].getAttribute('data-text-type'),
                             vis: tg ? (getComputedStyle(tg).display !== 'none') : false };
                }
            }
            return null;
        """ % blk['line'])
        print('  点后: %s' % json.dumps(after, ensure_ascii=False))
        print('  --- annotate 日志 ---')
        for l in js(cdp, """
            return (window.__bootLog||[]).filter(function(x){
                return /annotate|clear/.test(x);
            }).slice(-6).map(String);
        """):
            print('    ' + str(l))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
