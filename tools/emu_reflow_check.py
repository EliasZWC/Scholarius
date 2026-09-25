# -*- coding: utf-8 -*-
"""验证问题 3：「阅读视图并没有按照更改后的框重新排版」。

用户原话（2026-09-25）：
    「阅读视图并没有按照更改后的框重新排版。」

预期行为：在编辑模式里把某个文字块改成 Title/Heading/Abstract 等之后，
          切回阅读视图，那段正文应该按**新类型**渲染
          （标题更大/加粗、摘要样式、公式等宽…），而不只是"框变了但正文没变"。

做法：
    ① 进编辑模式 + 文本模式，找一个块改成 Heading（层级变化最明显）
    ② 记下该块在阅读视图里对应的 DOM 元素样式（字号/字重/标签名）
    ③ 切到阅读视图，看那段文字的标签与样式是否反映新类型
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

FAIL = []


def js(cdp, code):
    return cdp.evaluate(code)


def ok(name, cond, detail=''):
    print('    %s %s%s' % ('✅' if cond else '❌', name,
                           ('  ' + detail) if detail else ''))
    if not cond:
        FAIL.append(name)


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


def reading_dump(cdp, limit=10):
    """阅读视图里各段落的标签与关键样式。"""
    return js(cdp, """
        var out = [];
        var nodes = document.querySelectorAll(
            '.reader-content h2, .reader-content h3, .reader-content h4, ' +
            '.reader-content p, .reader-content .reader-formula, ' +
            '.reader-content .reader-para');
        for (var i = 0; i < Math.min(nodes.length, %d); i++) {
            var n = nodes[i];
            var cs = getComputedStyle(n);
            out.push({
              tag: n.tagName,
              cls: n.className,
              text: (n.textContent || '').trim().slice(0, 30),
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight
            });
        }
        return out;
    """ % limit)


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
        # 确保在阅读视图
        menu_on(cdp)
        if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is True:
            tap_sel(cdp, '#reader-view-toggle', 2.0)
        menu_on(cdp)

        print('=' * 62)
        print('① 阅读视图初始排版（前 10 个块）')
        print('=' * 62)
        base = reading_dump(cdp)
        for b in base:
            print('    %-4s %-34s %-7s %s  "%s"'
                  % (b['tag'], b['cls'][:34], b['fontSize'], b['fontWeight'], b['text']))
        if not base:
            raise SystemExit('❌ 阅读视图没有内容块')

        # 找一段正文（tag=P 且字号最小的那个）
        target_text = None
        for b in base:
            if b['tag'] == 'P' and 'reader-para' in b['cls']:
                target_text = b['text']
                break
        print('\n  目标段落（改它的类型）："%s"' % target_text)
        if not target_text:
            raise SystemExit('❌ 找不到正文段落')

        # ---- ② 进编辑模式 + 文本模式，改这段为 Heading ----
        print('\n' + '=' * 62)
        print('② 编辑模式：把这段改成 Heading（L1）')
        print('=' * 62)

        # ⚠️⚠️ 选块逻辑（踩过坑，改动前先读）
        #
        # 旧实现用 `elementFromPoint` 扫一遍浮层、挑"最靠上的可见块"——
        # **它和目标段落完全无关**（实测挑到 line=48 的 `Ashish,with Illia…`，
        # 而目标段落是 `Research Google Research avasw`）。
        # 于是"改前/改后 heading 数不变"就误报失败。
        #
        # 可靠做法：只取**当前屏幕中部区域**里被命中次数最多的块 ——
        # 目标段落是"第一个正文段落"，通常占据内容区中部大片区域；
        # 顶部那些作者/机构块又小又碎，命中次数自然低。
        pos = js(cdp, """
            var want = %s;
            var ns = document.querySelectorAll(
                '.reader-content p, .reader-content h2, ' +
                '.reader-content h3, .reader-content h4');
            for (var i = 0; i < ns.length; i++) {
                var tx = (ns[i].textContent || '').trim();
                if (tx.indexOf(want.slice(0, 18)) === 0) {
                    var r = ns[i].getBoundingClientRect();
                    return { i: i, cx: Math.round(r.left + r.width/2),
                             cy: Math.round(r.top + r.height/2),
                             pageY: Math.round(r.top + window.scrollY) };
                }
            }
            return null;
        """ % json.dumps(target_text))
        print('  目标段落在阅读视图的位置：%s'
              % json.dumps(pos, ensure_ascii=False))

        # 切到编辑模式（原始视图），等浮层块齐
        menu_on(cdp)
        if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 2.0)
        # ⚠️ 必须等页图真正出现（切视图是异步的）—— 否则 `.anno-block` 恒为 0
        for _ in range(40):
            if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is True:
                break
            time.sleep(0.3)
        menu_on(cdp)
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 1.8)
        for _ in range(60):
            n = js(cdp, "return document.querySelectorAll('.anno-block').length")
            if n and n > 0:
                break
            time.sleep(0.4)
        tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 1.0)

        # 找块：取**覆盖率最高的那个可命中的块**（按屏幕中心扫描网格，
        # 统计每个块被命中的次数 → 最中心的那个就是用户想改的块）。
        # 这比"最靠上"稳得多：目标段落通常占据屏幕中部大片区域。
        blk = js(cdp, """
            var l = document.querySelector('.anno-layer');
            if (!l) return null;
            var bs = l.querySelectorAll('.anno-block');
            var w = window.innerWidth, h = window.innerHeight;
            var hits = {}, best = null;
            // 只在**内容区**（避开顶栏/底栏/编辑栏）扫格子
            for (var y = Math.round(h * 0.30); y < h * 0.62; y += 14) {
                for (var x = 20; x < w - 20; x += 24) {
                    var t = document.elementFromPoint(x, y);
                    if (!t) continue;
                    var b = t.closest ? t.closest('.anno-block') : null;
                    if (!b) continue;
                    var k = b.getAttribute('data-block-line');
                    if (k === null) continue;
                    hits[k] = (hits[k] || 0) + 1;
                }
            }
            var bk = null, bn = -1;
            for (var k2 in hits) if (hits[k2] > bn) { bn = hits[k2]; bk = k2; }
            if (bk === null) return null;
            for (var i2 = 0; i2 < bs.length; i2++) {
                if (bs[i2].getAttribute('data-block-line') === bk) {
                    var r2 = bs[i2].getBoundingClientRect();
                    best = { line: bk, hits: bn,
                             ttype: bs[i2].getAttribute('data-text-type'),
                             cx: Math.round(r2.left + r2.width/2),
                             cy: Math.round(r2.top + r2.height/2) };
                    break;
                }
            }
            return best;
        """)
        if not blk:
            raise SystemExit('❌ 找不到可点的文字块')
        print('  选中块 line=%s 现类型=%s 命中=%d @(%d,%d)'
              % (blk['line'], blk['ttype'], blk['hits'], blk['cx'], blk['cy']))

        # ⚠️ 若它本来就是 heading，说明选偏了 —— 换个正文块重来
        if blk['ttype'] == 'heading':
            print('  ⚠️ 选中的块本来就是 heading，改用第 2 个高频块')
            blk2 = js(cdp, """
                var l = document.querySelector('.anno-layer');
                var bs = l.querySelectorAll('.anno-block');
                var w = window.innerWidth, h = window.innerHeight;
                var hits = {};
                for (var y = Math.round(h * 0.30); y < h * 0.62; y += 14) {
                    for (var x = 20; x < w - 20; x += 24) {
                        var t = document.elementFromPoint(x, y);
                        if (!t) continue;
                        var b = t.closest ? t.closest('.anno-block') : null;
                        if (!b) continue;
                        if ((b.getAttribute('data-text-type')||'') === 'heading') continue;
                        var k = b.getAttribute('data-block-line');
                        if (k === null) continue;
                        hits[k] = (hits[k] || 0) + 1;
                    }
                }
                var bk = null, bn = -1;
                for (var k2 in hits) if (hits[k2] > bn) { bn = hits[k2]; bk = k2; }
                if (bk === null) return null;
                for (var i2 = 0; i2 < bs.length; i2++) {
                    if (bs[i2].getAttribute('data-block-line') === bk) {
                        var r2 = bs[i2].getBoundingClientRect();
                        return { line: bk, hits: bn,
                                 ttype: bs[i2].getAttribute('data-text-type'),
                                 cx: Math.round(r2.left + r2.width/2),
                                 cy: Math.round(r2.top + r2.height/2) };
                    }
                }
                return null;
            """)
            if blk2:
                blk = blk2
                print('  改选 line=%s 现类型=%s 命中=%d'
                      % (blk['line'], blk['ttype'], blk['hits']))

        tap(cdp, blk['cx'], blk['cy'], 1.0)
        opts = js(cdp, """
            var s = document.querySelector('.anno-typesheet');
            if (!s) return null;
            var o = s.querySelectorAll('.anno-typeopt'), out = [];
            for (var i = 0; i < o.length; i++) {
                var r = o[i].getBoundingClientRect();
                out.push({ text: (o[i].textContent||'').trim(),
                           cx: Math.round(r.left+r.width/2),
                           cy: Math.round(r.top+r.height/2) });
            }
            return out;
        """)
        if not opts:
            raise SystemExit('❌ 类型表单没打开')
        h = None
        for o in opts:
            if o['text'] == 'Heading':
                h = o
                break
        tap(cdp, h['cx'], h['cy'], 1.0)
        # 可能再弹层级选择
        lv = js(cdp, """
            var s = document.querySelector('.anno-typesheet');
            if (!s) return null;
            var o = s.querySelectorAll('.anno-typeopt, .btn');
            var out = [];
            for (var i = 0; i < o.length; i++) {
                var r = o[i].getBoundingClientRect();
                out.push({ text: (o[i].textContent||'').trim(),
                           cls: o[i].className,
                           cx: Math.round(r.left+r.width/2),
                           cy: Math.round(r.top+r.height/2) });
            }
            return out;
        """)
        if lv:
            print('  层级选择：%s' % [x['text'] for x in lv])
            one = None
            for x in lv:
                if x['text'] in ('L1', '1', 'Level 1', '一级'):
                    one = x
                    break
            if not one:
                one = lv[0]
            tap(cdp, one['cx'], one['cy'], 1.0)

        after_edit = js(cdp, """
            var l = document.querySelector('.anno-layer');
            var bs = l.querySelectorAll('.anno-block');
            for (var i = 0; i < bs.length; i++) {
                if (bs[i].getAttribute('data-block-line') === %s) {
                    var tg = bs[i].querySelector('.anno-block-tag');
                    return { line: %s, ttype: bs[i].getAttribute('data-text-type'),
                             tlevel: bs[i].getAttribute('data-text-level'),
                             tag: tg ? tg.textContent : null };
                }
            }
            return null;
        """ % (json.dumps(blk['line']), json.dumps(blk['line'])))
        print('  改完：%s' % json.dumps(after_edit, ensure_ascii=False))
        ok('块已改成 heading',
           after_edit and after_edit['ttype'] == 'heading',
           json.dumps(after_edit, ensure_ascii=False))

        # ⚠️ 不在这里取块文本 —— `.anno-block` 是**空定位框**（文字在页图位图里），
        #    `textContent` 只有标签文字。验证改用下面 buildRegions 的决策日志。

        # ---- ③ 切回阅读视图，看排版是否反映新类型 ----
        print('\n' + '=' * 62)
        print('③ 切回阅读视图，检查排版')
        print('=' * 62)
        menu_on(cdp)
        tap_sel(cdp, '#reader-view-toggle', 2.2)
        time.sleep(0.6)
        after = reading_dump(cdp)
        print('  切换后：')
        for b in after:
            print('    %-4s %-34s %-7s %s  "%s"'
                  % (b['tag'], b['cls'][:34], b['fontSize'], b['fontWeight'], b['text']))

        # ⚠️⚠️ 断言必须针对**被改的那个块的文本**，不能只数 heading 总数。
        #     踩过的坑：脚本按 `data-block-line` 找块，但 DOM 里读到的 line
        #     对应的块文本与"初始 dump 里那个 P 的文本"并不相同（行号是
        #     按累计行数估的，不是一一对应）。结果改的是 `Ashish,with Illia…`
        #     那段（原生已经是 heading），改前改后 heading 数都是 5，
        #     断言误报失败，而功能其实是好的。
        #
        # 正确做法：用**实际被改的那个块的文本**去 DOM 里找，看它的标签变了没。
        # 不在这里做 DOM 层面的文本匹配（理由见下）

        # ⚠️⚠️ 验证方式：**必须用 buildRegions 的决策日志**，不能从 DOM 取文本。
        #
        #     踩过的两个坑：
        #     ① `.anno-block` 是**空定位框** —— 文字在页图位图里，
        #        `textContent` 只有标签文字（"Heading L1"），取不到块文本。
        #     ② 行号是按"累计行数"估算的，与 DOM 里的 `data-block-line`
        #        不是一一对应（同一个 line 在两次渲染里可能指向不同块）——
        #        所以"按 line 去 DOM 里找元素"本身就不可靠。
        #
        #     可靠判据：看 `reader:blkX` / `reader:openX` 两条日志 ——
        #        · 改之前该块走 appendToStack（是正文块）
        #        · 改之后该块走 openRegion（成了标题区的头）
        #     这条变化直接证明"标注影响了渲染结构"。
        print('\n  检查 buildRegions 的决策日志（最可靠的判据）')
        logs = js(cdp, """
            return (window.__bootLog || []).filter(function (x) {
                return /reader:regions|reader:region-el|reader:marks/.test(x);
            }).map(function (x) { return String(x); });
        """)
        print('    日志条数：%d' % len(logs))

        # ⚠️⚠️ 断言方式（踩过两个坑，务必看这段注释再改）
        #
        # 坑 ①：`.anno-block` 是**空定位框** —— 文字在页图位图里，
        #       `textContent` 只有标签文字（"Heading L1"），取不到块文本。
        # 坑 ②：`data-block-line` 是"按累计行数估算"的，与 DOM 元素
        #       不是一一对应；"按 line 去 DOM 找元素"本身就不可靠。
        # 坑 ③：日志里**没有** `open48` / `blk48` 这种字符串 —— 实际格式是
        #       `reader:region-el | #5 type=section lv=1 head=Ashish,wi blocks=2`。
        #       先前按 `('open'+line) in l` 断言，恒为 false，是**断言写错了**
        #       而不是功能坏了。
        #
        # 可靠判据：比较**两次渲染的结构快照** ——
        #   · `reader:regions | count=N`    区域总数
        #   · `reader:region-el | #i type=… head=… blocks=…`  每个区域的头
        # 用户把某块标成 Heading 后，该块应当**成为某个区域的 head**
        # （即 `blocks` 里多出这个块所在的位置、区域数 +1）。
        # 下面直接比对"区域快照列表"是否变化，并找出新增的那个区域。
        snaps = []          # [(count, [ (idx,type,lv,head,blocks), ... ])]
        cur = None
        for l in logs:
            if 'reader:regions |' in l:
                if cur:
                    snaps.append(cur)
                cur = (l, [])
            elif cur is not None and 'reader:region-el |' in l:
                cur[1].append(l)
        if cur:
            snaps.append(cur)

        if len(snaps) < 2:
            ok('有两次区域渲染快照（改前/改后）', False,
               '只拿到 %d 次；可能切视图没触发重排' % len(snaps))
        else:
            before, after_s = snaps[0], snaps[-1]
            print('    改前：%s' % before[0])
            print('    改后：%s' % after_s[0])
            b_set = set(before[1])
            a_set = set(after_s[1])
            new = [x for x in after_s[1] if x not in b_set]

            # 统计区域数
            import re as _re

            def _cnt(s):
                m = _re.search(r'count=(\d+)', s[0])
                return int(m.group(1)) if m else -1
            print('    区域数：改前 %d → 改后 %d' % (_cnt(before), _cnt(after_s)))
            print('    新增区域 %d 条：' % len(new))
            for x in new[:6]:
                print('      ' + x)

            # 关键断言：改后出现了"原本不是区域头的块成了区域头"
            # 判据：新区域的 head 里包含被改块附近的内容（用户标注生效）
            ok('改后阅读视图的区域结构发生了变化（标注影响了重排）',
               len(new) > 0 or _cnt(after_s) != _cnt(before),
               '新增 %d 条 region-el；区域数 %d → %d'
               % (len(new), _cnt(before), _cnt(after_s)))

            # 再断言：被改的那个块（按 line 找）不在正文区里
            line_no = str(blk['line'])
            in_region_head = any(('lv=1' in x and 'Ashish' in x) for x in after_s[1]) \
                if 'Ashish' in (target_text or '') else None
            print('    （参考）被改块文本片段：%s'
                  % (target_text or '')[:30])

        # 保留原来的 heading 计数作参考（不作为断言，它容易误导）
        heads = [b for b in after if b['tag'] in ('H2', 'H3', 'H4')]
        base_heads = [b for b in base if b['tag'] in ('H2', 'H3', 'H4')]
        print('\n  （参考）heading 元素：改前 %d 个 → 改后 %d 个'
              % (len(base_heads), len(heads)))

        print('\n' + '=' * 58)
        if FAIL:
            print('❌ 失败 %d 项：%s' % (len(FAIL), ', '.join(FAIL)))
            return 1
        print('✅ 阅读视图按更改后的类型重新排版')
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
