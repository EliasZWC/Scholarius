# -*- coding: utf-8 -*-
"""关键实验：改标注 → 退出编辑模式 → 再进来，看标注是否**正确保存/恢复**。

为什么怀疑这里（2026-09-25）：
    前几轮实测发现：在编辑模式里改完分类，`annotations.json` 仍是 `texts=0`
    （`saveAnnotations` 只在退出编辑模式时才写盘）。
    而真实论文有 100 个块、行号 0~500+，
    如果保存/恢复时**行号与块的对应关系**对不上，
    就会出现"改了没生效 / 删了又回来 / 越改越多"这类现象。

本脚本验证三件事：
    A. 改一个分类 → 退出编辑 → 查 annotations.json 是否写入
    B. 重新进编辑模式 → 看那个块的类型是否恢复
    C. 再删掉它 → 退出 → 重进 → 看是否真的没了
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ADB = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk',
                   'platform-tools', 'adb.exe')
PKG = 'com.eliaszwc.scholarius.debug'


def read_anno():
    p = subprocess.run([ADB, 'shell', 'run-as', PKG, 'cat',
                        'files/library/devtest1/annotations.json'],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       timeout=60)
    return (p.stdout or b'').decode('utf-8', 'replace').strip()


def _anno_summary(raw):
    """把 annotations.json 压成一行摘要。

    ⚠️ 为什么不直接 print 全文（踩过的坑）：
       一篇论文的 texts 数组有几百条，全文一次打印就是几万字符。
       在 PowerShell 里这会被管道截断，看起来像"命令失败"，
       而脚本其实返回了 0 —— 回归汇总里就会报假失败。
       这里只给条数 + regions 的类型，足够判断标注存没存。
    """
    if not raw:
        return '(空/不存在)'
    try:
        d = json.loads(raw)
    except Exception:
        return '(解析失败) %s' % raw[:80]
    regs = d.get('regions') or []
    texts = d.get('texts') or []
    types = {}
    for r in regs:
        k = r.get('type', '?')
        types[k] = types.get(k, 0) + 1
    return 'regions=%d %s  texts=%d' % (
        len(regs), json.dumps(types, ensure_ascii=False), len(texts))


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
        return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
    """ % json.dumps(sel))
    if not b:
        return None
    tap(cdp, b[0], b[1], wait)
    return b


def menu_on(cdp):
    if js(cdp, "return document.getElementById('reader')"
               ".classList.contains('is-menu-open')") is not True:
        vp = js(cdp, 'return [window.innerWidth, window.innerHeight]')
        tap(cdp, vp[0] // 2, vp[1] // 2, 0.8)


def clear_boxes(cdp):
    """清掉页面上已有的矩形框（幂等）。

    ⚠️ 为什么需要（踩过的坑）：
       本脚本测的是**文字块**标注的持久化，但前面的脚本
       （emu_draw_clean / emu_draw_check …）会留下矩形框。
       框浮在文字块上面（z-index 更高），于是后面 `tap` 文字块时
       点到的是框 —— 走"点框删除"分支，断言就假失败。
       单独跑是绿的、序列里是红的，就是这个原因。
    """
    n = js(cdp, "return document.querySelectorAll('.anno-box').length")
    if not n:
        return 0
    print('  （清理 %d 个遗留框，保证幂等）' % n)
    for _ in range(n + 3):
        b = js(cdp, """
            var bs = document.querySelectorAll('.anno-box:not(.is-ghost)');
            if (!bs.length) return null;
            var r = bs[bs.length - 1].getBoundingClientRect();
            if (!r.width) return null;
            return [Math.round(r.left + r.width/2),
                    Math.round(r.top + r.height/2)];
        """)
        if not b:
            break
        tap(cdp, b[0], b[1], 0.6)
    return js(cdp, "return document.querySelectorAll('.anno-box').length")


def block_state(cdp, line):
    return js(cdp, """
        var l = document.querySelector('.anno-layer');
        if (!l) return null;
        var bs = l.querySelectorAll('.anno-block');
        for (var i = 0; i < bs.length; i++) {
            if (bs[i].getAttribute('data-block-line') === %s) {
                var tg = bs[i].querySelector('.anno-block-tag');
                var r = bs[i].getBoundingClientRect();
                return { line: %s,
                         ttype: bs[i].getAttribute('data-text-type'),
                         tlevel: bs[i].getAttribute('data-text-level'),
                         tag: tg ? tg.textContent : null,
                         vis: !!(tg && getComputedStyle(tg).display !== 'none'),
                         cx: Math.round(r.left + r.width/2),
                         cy: Math.round(r.top + r.height/2) };
            }
        }
        return null;
    """ % (json.dumps(line), json.dumps(line)))


def visible_count(cdp):
    return js(cdp, """
        var l = document.querySelector('.anno-layer');
        if (!l) return -1;
        var bs = l.querySelectorAll('.anno-block'), n = 0;
        for (var i = 0; i < bs.length; i++) {
            var tg = bs[i].querySelector('.anno-block-tag');
            if (tg && getComputedStyle(tg).display !== 'none') n++;
        }
        return n;
    """)


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    ok = []
    try:
        # ---- ⚠️ 先清掉磁盘上的标注（幂等，踩过的坑）----
        #
        # 本脚本测的是"标注存/取/删"的持久化，断言依赖"初始时没有标注"。
        # 但前面的脚本（emu_clear_why / emu_clear_fab …）会把标注状态
        # 改成"整篇拍平成 body"并写盘，于是本脚本跑起来时：
        #   · 所有块都是 body → 文字块在页图上被大量覆盖
        #   · 点块时命中不到目标 → 报「找不到可测的块」
        # 单独跑是绿的、序列里是红的，就是这个原因。
        # 所以进来先删除文件，再重进阅读器让它重新加载。
        subprocess.run([ADB, 'shell', 'run-as', PKG, 'rm', '-f',
                        'files/library/devtest1/annotations.json'],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       timeout=60)
        js(cdp, """
            if (window.ScholariusReader && window.ScholariusReader.close) {
                window.ScholariusReader.close();
            }
            return 1;
        """)
        time.sleep(1.5)

        # ---- 就绪 ----
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
            tap_sel(cdp, '.doc-card', 1.6)
        menu_on(cdp)
        if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 1.4)
        # ⚠️ 切视图后**必须等页图真正出现**，否则下一步 `.anno-block` 会是 0，
        #    报「找不到可测的块」—— 看着像功能坏了，其实是时序问题（踩过）。
        for _ in range(30):
            if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is True:
                break
            time.sleep(0.3)
        menu_on(cdp)
        if js(cdp, "return document.getElementById('reader')"
                   ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 1.6)
        for _ in range(50):
            n = js(cdp, "return document.querySelectorAll('.anno-block').length")
            if n and n > 0:
                break
            time.sleep(0.4)
        tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 1.0)
        # 再确认浮层真的挂上了
        for _ in range(20):
            if js(cdp, "return document.querySelectorAll('.anno-block').length") > 0:
                break
            time.sleep(0.3)

        # ⚠️ 清掉遗留矩形框 —— 它们 z-index 更高，会挡住文字块的点击
        clear_boxes(cdp)

        print('初始：可见框 %s 个' % visible_count(cdp))
        print('annotations.json: %s' % _anno_summary(read_anno()))

        # ---- 找一个可点的块 ----
        blk = js(cdp, """
            var l = document.querySelector('.anno-layer');
            var bs = l.querySelectorAll('.anno-block');
            var best = null;
            for (var i = 0; i < bs.length; i++) {
                var r = bs[i].getBoundingClientRect();
                var cx = r.left + r.width/2, cy = r.top + r.height/2;
                if (cy < 200 || cy > 700) continue;
                if (r.width < 60) continue;
                var t = document.elementFromPoint(cx, cy);
                if (!t || !(t === bs[i] || bs[i].contains(t))) continue;
                best = { line: bs[i].getAttribute('data-block-line'),
                         ttype: bs[i].getAttribute('data-text-type'),
                         cx: Math.round(cx), cy: Math.round(cy),
                         rect: [Math.round(r.left), Math.round(r.top),
                                Math.round(r.width), Math.round(r.height)] };
                break;
            }
            return best;
        """)
        if not blk:
            raise SystemExit('找不到可测的块')
        line = blk['line']
        print('\n★ 目标块 line=%s 初始 type=%s @(%d,%d) rect=%s'
              % (line, blk['ttype'], blk['cx'], blk['cy'], blk['rect']))

        # ---- A. 改成 Title ----
        print('\n[A] 改成 Title')
        tap(cdp, blk['cx'], blk['cy'], 1.0)
        opts = js(cdp, """
            var s = document.querySelector('.anno-typesheet');
            if (!s) return null;
            var o = s.querySelectorAll('.anno-typeopt'), out = [];
            for (var i = 0; i < o.length; i++) {
                var r = o[i].getBoundingClientRect();
                out.push({ text: (o[i].textContent||'').trim(),
                           pressed: o[i].getAttribute('aria-pressed'),
                           cx: Math.round(r.left+r.width/2),
                           cy: Math.round(r.top+r.height/2) });
            }
            return out;
        """)
        if not opts:
            raise SystemExit('表单没打开')
        t = None
        for o in opts:
            if o['text'] == 'Title':
                t = o
                break
        tap(cdp, t['cx'], t['cy'], 1.0)
        st = block_state(cdp, line)
        print('    DOM: type=%s tag=%s vis=%s' % (st['ttype'], st['tag'], st['vis']))
        print('    annotations.json: %s' % _anno_summary(read_anno()))

        # ---- B. 退出编辑模式（触发保存）----
        print('\n[B] 退出编辑模式（应触发 saveAnnotations）')
        menu_on(cdp)
        tap_sel(cdp, '#reader-annotate', 1.6)
        raw = read_anno()
        print('    annotations.json: %s' % _anno_summary(raw))
        saved = False
        if raw and '"title"' in raw:
            saved = True
            print('    ✅ 已写入 title')
        else:
            print('    ❌ 未写入 title（改动丢失！）')
        ok.append(('A→B 保存标注', saved))

        # ---- C. 重进编辑模式，看是否恢复 ----
        print('\n[C] 重进编辑模式，看是否恢复')
        menu_on(cdp)
        if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 1.4)
            menu_on(cdp)
        tap_sel(cdp, '#reader-annotate', 1.6)
        for _ in range(30):
            n = js(cdp, "return document.querySelectorAll('.anno-block').length")
            if n and n > 0:
                break
            time.sleep(0.4)
        tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 1.0)
        st2 = block_state(cdp, line)
        if st2:
            print('    DOM: type=%s tag=%s vis=%s' % (st2['ttype'], st2['tag'], st2['vis']))
            restored = (st2['ttype'] == 'title' and st2['vis'])
            print('    %s 恢复' % ('✅' if restored else '❌ 未恢复'))
            ok.append(('B→C 恢复标注', restored))
        else:
            print('    ❌ 找不到 line=%s 的块' % line)
            ok.append(('B→C 恢复标注', False))

        # ---- D. 删掉它 → 退出 → 重进 ----
        print('\n[D] 删除它 → 退出 → 重进')
        st3 = block_state(cdp, line)
        if st3:
            tap(cdp, st3['cx'], st3['cy'], 1.0)
            btns = js(cdp, """
                var s = document.querySelector('.anno-typesheet');
                if (!s) return null;
                var b = s.querySelectorAll('.btn'), out = [];
                for (var i = 0; i < b.length; i++) {
                    var r = b[i].getBoundingClientRect();
                    out.push({ text: (b[i].textContent||'').trim(),
                               cls: b[i].className,
                               cx: Math.round(r.left+r.width/2),
                               cy: Math.round(r.top+r.height/2) });
                }
                return out;
            """)
            d = None
            for x in (btns or []):
                if 'danger' in x['cls']:
                    d = x
                    break
            if d:
                tap(cdp, d['cx'], d['cy'], 1.0)
                print('    删除后 DOM: vis=%s' % (block_state(cdp, line) or {}).get('vis'))

        menu_on(cdp)
        tap_sel(cdp, '#reader-annotate', 1.6)
        raw2 = read_anno()
        print('    annotations.json: %s' % _anno_summary(raw2))
        gone = not (raw2 and '"title"' in raw2)
        print('    %s title 已从存储中移除' % ('✅' if gone else '❌'))
        ok.append(('D 删除并持久化', gone))

        print('\n' + '=' * 50)
        print('=== 汇总 ===')
        for name, v in ok:
            print('  %s %s' % ('✅' if v else '❌', name))
        return 0 if all(v for _, v in ok) else 1
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
