# -*- coding: utf-8 -*-
"""复现「清除后新增的框删不掉」。

用户完整描述（2026-09-25，逐步澄清后）：
    1. 一开始自动识别的框是乱的
    2. 点清除
    3. **清除后又增加了一个框**
    4. 那个框删不掉了
    5. 在它上面改分类 → 旧分类跑到框右下角、越加越多
    6. **并且也无法增加其他的框**

本脚本针对第 3~6 步：从「已清除」状态开始，
    ① 在空白块上点开表单 → 选一个分类（= 用户说的"增加了一个框"）
    ② 再点这个框 → 点表单里的「删除」
    ③ 看它是否真的消失
    ④ 反复几次，看是否有累积
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

STATE_JS = """
var l = document.querySelector('.anno-layer');
if (!l) return { err: 'no layer' };
var bs = l.querySelectorAll('.anno-block');
var vis = [];
for (var i = 0; i < bs.length; i++) {
    var b = bs[i], tg = b.querySelector('.anno-block-tag');
    if (!tg || getComputedStyle(tg).display === 'none') continue;
    var r = b.getBoundingClientRect();
    vis.push({ line: b.getAttribute('data-block-line'),
               type: b.getAttribute('data-text-type'),
               tag: tg.textContent,
               rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
}
return { totalBlocks: bs.length, visible: vis, visibleCount: vis.length };
"""


def show(cdp, label):
    d = cdp.evaluate(STATE_JS)
    if d.get('err'):
        print('  [%s] %s' % (label, d['err']))
        return d
    print('  [%s] 可见框 %d 个：%s' % (label, d['visibleCount'],
          json.dumps([[v['line'], v['type']] for v in d['visible']], ensure_ascii=False)))
    return d


def tap(cdp, x, y, wait=0.8):
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.05)
    cdp.touch('touchEnd', [])
    time.sleep(wait)


def tap_sel(cdp, sel, wait=0.8):
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


def find_blockable(cdp, which='middle'):
    """找一个可点的文字块（返回中心点与 line）。"""
    return cdp.evaluate("""
        var l = document.querySelector('.anno-layer');
        if (!l) return null;
        var bs = l.querySelectorAll('.anno-block');
        var cands = [];
        for (var i = 0; i < bs.length; i++) {
            var b = bs[i], r = b.getBoundingClientRect();
            var cx = r.left + r.width/2, cy = r.top + r.height/2;
            if (cy < 140 || cy > 800) continue;              // 避开顶栏/底栏
            var t = document.elementFromPoint(cx, cy);
            if (!t || !(t === b || b.contains(t))) continue; // 要可达
            cands.push({ i: i, line: b.getAttribute('data-block-line'),
                         cx: Math.round(cx), cy: Math.round(cy),
                         rect: [Math.round(r.left), Math.round(r.top),
                                Math.round(r.width), Math.round(r.height)] });
        }
        if (!cands.length) return null;
        return cands[Math.floor(cands.length / 2)];   // 取中间的
    """)


def open_picker(cdp, cx, cy):
    tap(cdp, cx, cy, 0.9)
    return cdp.evaluate("""
        var s = document.querySelector('.anno-typesheet');
        if (!s) return null;
        var out = { opts: [], btns: [] };
        var o = s.querySelectorAll('.anno-typeopt');
        for (var i = 0; i < o.length; i++) {
            var r = o[i].getBoundingClientRect();
            out.opts.push({ text: (o[i].textContent || '').trim(),
                            pressed: o[i].getAttribute('aria-pressed'),
                            cx: Math.round(r.left + r.width/2),
                            cy: Math.round(r.top + r.height/2) });
        }
        var b = s.querySelectorAll('.btn');
        for (var k = 0; k < b.length; k++) {
            var br = b[k].getBoundingClientRect();
            out.btns.push({ text: (b[k].textContent || '').trim(),
                            cls: b[k].className,
                            cx: Math.round(br.left + br.width/2),
                            cy: Math.round(br.top + br.height/2) });
        }
        return out;
    """)


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
            tap_sel(cdp, '.doc-card', 1.2)
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-menu-open')") is not True:
            vp = cdp.evaluate('return [window.innerWidth, window.innerHeight]')
            tap(cdp, vp[0] // 2, vp[1] // 2, 0.7)
        if cdp.evaluate("return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 1.0)
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 1.2)
        tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 0.9)

        show(cdp, '起点')

        # 用户第 3~6 步的循环：点块 → 选分类 → 再点块 → 删除
        for round_no in range(1, 4):
            print('\n========== 第 %d 轮 ==========' % round_no)
            blk = find_blockable(cdp)
            if not blk:
                print('  ❌ 找不到可点的块')
                break
            print('  点块 line=%s @(%d,%d)' % (blk['line'], blk['cx'], blk['cy']))

            # ① 选一个分类（= "增加了一个框"）
            pk = open_picker(cdp, blk['cx'], blk['cy'])
            if not pk:
                print('  ❌ 表单没打开')
                break
            cur = [o['text'] for o in pk['opts'] if o['pressed'] == 'true']
            tgt = None
            for o in pk['opts']:
                if o['pressed'] != 'true' and o['text'] in ('Title', 'Author', 'Abstract'):
                    tgt = o
                    break
            print('  当前=%s → 选 "%s"' % (cur, tgt['text'] if tgt else None))
            if not tgt:
                break
            tap(cdp, tgt['cx'], tgt['cy'], 0.9)
            d1 = show(cdp, '选完分类后')

            # ② 再点同一个块 → 点「删除」
            blk2 = cdp.evaluate("""
                var l = document.querySelector('.anno-layer');
                var bs = l.querySelectorAll('.anno-block');
                var t = null;
                for (var i = 0; i < bs.length; i++) {
                    if (bs[i].getAttribute('data-block-line') === %s) { t = bs[i]; break; }
                }
                if (!t) return null;
                var r = t.getBoundingClientRect();
                return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2),
                         rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
            """ % json.dumps(blk['line']))
            if not blk2:
                print('  ❌ 找不到原块')
                break
            pk2 = open_picker(cdp, blk2['cx'], blk2['cy'])
            if not pk2:
                print('  ❌ 第二次表单没打开（块点不到？rect=%s）' % blk2['rect'])
                continue
            print('  表单按钮：%s' % json.dumps(pk2['btns'], ensure_ascii=False))
            dele = None
            for b in pk2['btns']:
                if 'danger' in b['cls'] or b['text'] in ('Delete', '删除'):
                    dele = b
                    break
            if not dele:
                print('  ❌ 找不到删除按钮')
                break
            tap(cdp, dele['cx'], dele['cy'], 0.9)
            visit = show(cdp, '点「删除」后')

            # 判定：原来那个 line 应该不再可见
            still = [v for v in visit.get('visible', [])
                     if v['line'] == blk['line']]
            if still:
                print('  ❌ **删不掉**：line=%s 仍然可见（%s）'
                      % (blk['line'], still[0]['type']))
            else:
                print('  ✅ 已删除（line=%s 不再可见）' % blk['line'])

        print('\n=== anno 日志 ===')
        for l in cdp.evaluate("""
            return (window.__bootLog || []).filter(function (x) {
                return /annotate|clear/.test(x);
            }).slice(-20);
        """):
            print('  ' + str(l))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
