# -*- coding: utf-8 -*-
"""复现「改分类 → 旧分类跑到右下角、越加越多」的问题。

用户原话（2026-09-25）：
    「我尝试改变分类，结果是增加后，旧分类到了框的右下角，
      然后再改，又增加了一个；但那个删除不掉的框上面的分类最多三个」

关键疑问：这些"分类标签"到底是什么 DOM 元素？
    · .anno-block-tag  （文字块上的标签，CSS 里 display:none 用于 body）
    · .anno-box-tag    （矩形框上的标签）
    · 还是别的？

所以本脚本的核心是**把每次改分类后页面上所有 anno 元素都 dump 出来**，
而不是只看数量。

用法：
    python tools/emu_type_check.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

DUMP_JS = """
var out = { blocks: [], boxes: [], tags: [], misc: [] };
var tags = document.querySelectorAll('.anno-block-tag, .anno-box-tag');
for (var i = 0; i < tags.length; i++) {
    var e = tags[i], r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    out.tags.push({
        cls: e.className,
        text: (e.textContent || '').trim(),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        display: cs.display,
        parent: e.parentNode ? e.parentNode.className : null
    });
}
var bs = document.querySelectorAll('.anno-block');
for (var k = 0; k < bs.length; k++) {
    var b = bs[k], br = b.getBoundingClientRect();
    out.blocks.push({
        i: k, line: b.getAttribute('data-block-line'),
        ttype: b.getAttribute('data-text-type'),
        tlevel: b.getAttribute('data-text-level'),
        cls: b.className,
        rect: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)]
    });
}
var xs = document.querySelectorAll('.anno-box');
for (var m = 0; m < xs.length; m++) {
    var x = xs[m], xr = x.getBoundingClientRect();
    out.boxes.push({
        index: x.getAttribute('data-index'), cls: x.className,
        rect: [Math.round(xr.left), Math.round(xr.top), Math.round(xr.width), Math.round(xr.height)],
        tagText: (function () {
            var tg = x.querySelector('.anno-box-tag');
            return tg ? tg.textContent : null;
        })()
    });
}
// 任何带 anno 前缀但既不是 layer 也不是 block/box 的元素（找"跑出来的标签"）
var all = document.querySelectorAll('[class*="anno"]');
for (var q = 0; q < all.length; q++) {
    var el = all[q];
    if (el.classList.contains('anno-layer') || el.classList.contains('anno-block') ||
        el.classList.contains('anno-box') || el.classList.contains('anno-box-tag') ||
        el.classList.contains('anno-block-tag')) continue;
    var er = el.getBoundingClientRect();
    out.misc.push({
        cls: el.className, tag: el.tagName,
        rect: [Math.round(er.left), Math.round(er.top), Math.round(er.width), Math.round(er.height)],
        text: (el.textContent || '').trim().slice(0, 30)
    });
}
return out;
"""


def dump(cdp, label):
    d = cdp.evaluate(DUMP_JS)
    print('\n--- %s ---' % label)
    print('  .anno-block-tag / .anno-box-tag：%d 个' % len(d['tags']))
    for t in d['tags']:
        print('    %-30s "%s" rect=%s display=%s parent=%s'
              % (t['cls'], t['text'], t['rect'], t['display'], t['parent']))
    print('  .anno-block：%d 个（前 6）' % len(d['blocks']))
    for b in d['blocks'][:6]:
        print('    i=%s line=%-4s type=%-10s lv=%-3s cls=%s rect=%s'
              % (b['i'], b['line'], b['ttype'], b['tlevel'], b['cls'], b['rect']))
    print('  .anno-box：%d 个' % len(d['boxes']))
    for x in d['boxes']:
        print('    index=%s tagText=%s rect=%s cls=%s'
              % (x['index'], x['tagText'], x['rect'], x['cls']))
    if d['misc']:
        print('  ⚠️ 其它 anno 元素：%d 个' % len(d['misc']))
        for m in d['misc']:
            print('    %s.%s rect=%s text="%s"'
                  % (m['tag'], m['cls'], m['rect'], m['text']))
    return d


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


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        # 就绪
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

        # 进阅读器
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-open')") is not True:
            tap_sel(cdp, '.doc-card', 1.0)
        # 唤醒菜单
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-menu-open')") is not True:
            vp = cdp.evaluate('return [window.innerWidth, window.innerHeight]')
            tap(cdp, vp[0] // 2, vp[1] // 2, 0.6)
        # 原始视图
        if cdp.evaluate("return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 0.9)
        # 进编辑模式
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 1.0)
        # 选 Text 模式
        tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 0.8)

        print('=== 初始状态 ===')
        st = cdp.evaluate("""
            var r = document.getElementById('reader');
            return { cls: r.className,
                     pressed: (function () {
                        var a = document.querySelector('.reader-editbar [data-edit-mode][aria-pressed="true"]');
                        return a ? a.getAttribute('data-edit-mode') : 'none';
                     })() };
        """)
        print('  reader=%s  selected=%s' % (st['cls'], st['pressed']))
        dump(cdp, '初始')

        # 找一个文字块，点它开类型选择
        blk = cdp.evaluate("""
            var l = document.querySelector('.anno-layer');
            if (!l) return null;
            var bs = l.querySelectorAll('.anno-block');
            if (!bs.length) return null;
            // 取靠中间的块，避开顶栏/底栏
            var best = null;
            for (var i = 0; i < bs.length; i++) {
                var r = bs[i].getBoundingClientRect();
                if (r.top < 120 || r.bottom > 800) continue;
                if (!best || Math.abs(r.top - 400) < Math.abs(best.r.top - 400)) {
                    best = { i: i, r: r, el: bs[i] };
                }
            }
            if (!best) best = { i: 0, r: bs[0].getBoundingClientRect(), el: bs[0] };
            var rr = best.el.getBoundingClientRect();
            return { i: best.i, line: best.el.getAttribute('data-block-line'),
                     rect: [Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height)],
                     cx: Math.round(rr.left + rr.width/2), cy: Math.round(rr.top + rr.height/2) };
        """)
        if not blk:
            raise SystemExit('没有文字块可点')
        print('\n选中块 i=%s line=%s rect=%s' % (blk['i'], blk['line'], blk['rect']))

        print('\n=== 点块 → 打开类型选择 ===')
        tap(cdp, blk['cx'], blk['cy'], 0.8)
        sheet = cdp.evaluate("""
            var s = document.querySelector('.anno-typesheet');
            if (!s) return null;
            var opts = s.querySelectorAll('.anno-typeopt');
            var out = [];
            for (var i = 0; i < opts.length; i++) {
                var o = opts[i], r = o.getBoundingClientRect();
                out.push({ text: (o.textContent || '').trim(),
                           pressed: o.getAttribute('aria-pressed'),
                           cx: Math.round(r.left + r.width/2),
                           cy: Math.round(r.top + r.height/2) });
            }
            return { exists: true, opts: out };
        """)
        if not sheet:
            raise SystemExit('❌ 类型选择弹层没打开')
        for o in sheet['opts']:
            print('    %-12s pressed=%-6s @(%d,%d)'
                  % (o['text'], o['pressed'], o['cx'], o['cy']))

        # 第一次改分类：选一个与当前不同的
        target = None
        for o in sheet['opts']:
            if o['pressed'] != 'true' and o['text']:
                target = o
                break
        if not target:
            raise SystemExit('没有可选的其它类型')
        print('\n=== 第 1 次改分类 → "%s" ===' % target['text'])
        tap(cdp, target['cx'], target['cy'], 0.8)
        dump(cdp, '第 1 次改分类后')

        # 第二次：再点同一个块，换成另一个类型
        print('\n=== 再点同一个块 ===')
        blk2 = cdp.evaluate("""
            var l = document.querySelector('.anno-layer');
            var bs = l.querySelectorAll('.anno-block');
            var t = null;
            for (var i = 0; i < bs.length; i++) {
                if (bs[i].getAttribute('data-block-line') === %s) { t = bs[i]; break; }
            }
            if (!t) return null;
            var r = t.getBoundingClientRect();
            return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) };
        """ % json.dumps(blk['line']))
        if blk2:
            tap(cdp, blk2['cx'], blk2['cy'], 0.8)
            sheet2 = cdp.evaluate("""
                var s = document.querySelector('.anno-typesheet');
                if (!s) return null;
                var opts = s.querySelectorAll('.anno-typeopt');
                var out = [];
                for (var i = 0; i < opts.length; i++) {
                    var o = opts[i], r = o.getBoundingClientRect();
                    out.push({ text: (o.textContent || '').trim(),
                               pressed: o.getAttribute('aria-pressed'),
                               cx: Math.round(r.left + r.width/2),
                               cy: Math.round(r.top + r.height/2) });
                }
                return out;
            """)
            if sheet2:
                for o in sheet2:
                    print('    %-12s pressed=%-6s' % (o['text'], o['pressed']))
                t2 = None
                for o in sheet2:
                    if o['pressed'] != 'true' and o['text']:
                        t2 = o
                        break
                if t2:
                    print('\n=== 第 2 次改分类 → "%s" ===' % t2['text'])
                    tap(cdp, t2['cx'], t2['cy'], 0.8)
                    dump(cdp, '第 2 次改分类后')

        print('\n=== 内部 textMarks ===')
        tm = cdp.evaluate("""
            // 从 AnnotationStore 或暴露的接口读
            if (window.ScholariusReader && window.ScholariusReader.debugMarks) {
                return window.ScholariusReader.debugMarks();
            }
            return 'no-debug-api';
        """)
        print('  %s' % json.dumps(tm, ensure_ascii=False))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
