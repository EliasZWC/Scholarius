# -*- coding: utf-8 -*-
"""用**真实论文**（Transformer）完整复现用户报告的流程。

用户描述的完整流程（2026-09-25，逐步澄清后）：
    1. 打开论文，进编辑模式（文本模式）
    2. **一开始自动识别的框是乱的**
    3. 点「清除」→ 清掉
    4. **清除后又增加了一个框**（点某个文字块 → 升起表单 → 选一个分类）
    5. **那个框删不掉了**
    6. 在它上面改分类 → **旧分类跑到框的右下角**、**再改又增加一个**
    7. **并且也无法增加其他的框**

本脚本逐步走完并逐步 dump，重点抓第 4~7 步。

⚠️ 用**真实论文**而不是自造 PDF：
   自造 PDF 每个文本块只有 1 行（Tm 每行重设 → PdfText 切成单行块），
   而真实论文一个段落是**一个多行块**。这个差别直接影响
   textMarks 的区间计算（to = from + 行数 - 1），
   用户报的"删不掉"很可能只在多行块下出现。
"""
import argparse
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
        return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
    """ % json.dumps(sel))
    if not b:
        return None
    tap(cdp, b[0], b[1], wait)
    return b


def menu_on(cdp):
    """确保阅读器菜单展开（底栏/顶栏按钮才点得到）。

    ⚠️ 点屏幕正中是切菜单的手势，所以要**先读状态再决定点不点**（见 emu_regress）。
    """
    if js(cdp, "return document.getElementById('reader')"
               ".classList.contains('is-menu-open')") is True:
        return True
    vp = js(cdp, 'return [window.innerWidth, window.innerHeight]')
    tap(cdp, vp[0] // 2, int(vp[1] * 0.45), 0.8)
    return js(cdp, "return document.getElementById('reader')"
                  ".classList.contains('is-menu-open')") is True


# ---- 状态 dump：块（含行号/类型/rect/可见性）+ 原始标注 -------------------
STATE_JS = """
var l = document.querySelector('.anno-layer');
var bs = l ? l.querySelectorAll('.anno-block') : [];
var blocks = [], vis = [];
for (var i = 0; i < bs.length; i++) {
  var b = bs[i], tg = b.querySelector('.anno-block-tag');
  var r = b.getBoundingClientRect();
  var shown = tg && getComputedStyle(tg).display !== 'none';
  var rec = { i: i, line: b.getAttribute('data-block-line'),
              ttype: b.getAttribute('data-text-type'),
              tlevel: b.getAttribute('data-text-level'),
              tag: tg ? tg.textContent : null, vis: !!shown,
              rect: [Math.round(r.left), Math.round(r.top),
                     Math.round(r.width), Math.round(r.height)] };
  blocks.push(rec);
  if (shown) vis.push(rec);
}
var marks = null;
try {
  var raw = window.ScholariusNative.getAnnotations('devtest1');
  var doc = JSON.parse(raw);
  var t = (doc.texts || []).slice();
  marks = { regions: (doc.regions || []).length, texts: t.length,
            detail: t.map(function (m) {
              return m.type + ':' + m.from + '-' + m.to;
            }) };
} catch (e) { marks = 'err: ' + e.message; }
return { layerExists: !!l, blocks: blocks.length, visible: vis.length,
         visList: vis.map(function (v) { return [v.line, v.ttype, v.rect]; }),
         marks: marks };
"""


def dump(cdp, label):
    d = js(cdp, STATE_JS)
    print('\n  ── %s ──' % label)
    print('     层=%s  块=%s  可见框=%s'
          % (d['layerExists'], d['blocks'], d['visible']))
    for v in d['visList'][:14]:
        print('       line=%-4s type=%-10s rect=%s' % (v[0], v[1], v[2]))
    if len(d['visList']) > 14:
        print('       ... 还有 %d 个' % (len(d['visList']) - 14))
    m = d['marks']
    if isinstance(m, dict):
        print('     节点存储: regions=%s texts=%s' % (m['regions'], m['texts']))
        print('       %s' % m['detail'][:14])
    else:
        print('     节点存储: %s' % m)
    return d


def enter_editing(cdp):
    """把应用带到「阅读器 + 原始视图 + 编辑模式 + 文本模式」。

    ⚠️ 必须**先确保是干净状态**（2026-09-25 踩坑）：
       上一轮跑完可能停在"已退出编辑模式"或"阅读视图"，
       直接往下走会得到 `层=False 块=0` 的假象。
       所以先无条件退出编辑模式、切回阅读视图，再重进。
    """
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

    is_open = js(cdp, "return document.getElementById('reader')"
                      ".classList.contains('is-open')")
    is_ann = js(cdp, "return document.getElementById('reader')"
                     ".classList.contains('is-annotating')")
    is_raw = js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')")

    # ① 不在阅读器 → 打开
    if is_open is not True:
        tap_sel(cdp, '.doc-card', 1.8)

    # ② 已在编辑模式 → 先退出（回到已知状态）
    if is_ann is True:
        menu_on(cdp)
        tap_sel(cdp, '#reader-annotate', 1.6)   # 退出编辑
        is_ann = False

    # ③ 唤醒菜单
    menu_on(cdp)

    # ④ 切原始视图
    if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
        tap_sel(cdp, '#reader-view-toggle', 1.6)

    # ⑤ 切视图后菜单可能收起，再确保一次
    menu_on(cdp)

    # ⑥ 进编辑模式
    if js(cdp, "return document.getElementById('reader')"
               ".classList.contains('is-annotating')") is not True:
        # ⚠️ 标注按钮只在**原始视图**下可见（见 reader.js 的 syncAnnotate）。
        #    若上一步切视图没成功，这里会连按钮都点不到 →
        #    必须再确认一次视图，否则后面拿到的是"层=False 块=0"的假状态。
        if js(cdp, "return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
            menu_on(cdp)
            tap_sel(cdp, '#reader-view-toggle', 1.4)
        menu_on(cdp)
        ok_click = tap_sel(cdp, '#reader-annotate', 1.6)
        if not ok_click:
            raise SystemExit('❌ 点不到 #reader-annotate 按钮（视图不对？）')

    # ⑦ 等标注层挂上（块渲染是异步的：要等 PdfText 的块数据）
    #    ⚠️ 最多等 20 秒 —— 真实论文 100 个块、要抽取正文，比自造 PDF 慢得多
    n = 0
    for _ in range(50):
        n = js(cdp, "return document.querySelectorAll('.anno-block').length")
        if n and n > 0:
            break
        time.sleep(0.4)
    if not n:
        raise SystemExit('❌ 编辑模式已进但标注层没有块（抽取失败？）')

    # ⑧ 选文本模式
    tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 1.0)
    time.sleep(0.5)


def open_picker(cdp, cx, cy):
    tap(cdp, cx, cy, 1.0)
    return js(cdp, """
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


def find_visible_reachable(cdp, index=0):
    """找第 index 个「可见 + 可达」的文字块。"""
    return js(cdp, """
        var l = document.querySelector('.anno-layer');
        if (!l) return null;
        var bs = l.querySelectorAll('.anno-block');
        var hits = [];
        for (var i = 0; i < bs.length; i++) {
            var b = bs[i], tg = b.querySelector('.anno-block-tag');
            if (!tg || getComputedStyle(tg).display === 'none') continue;
            var r = b.getBoundingClientRect();
            var cx = r.left + r.width/2, cy = r.top + r.height/2;
            if (cy < 140 || cy > 800) continue;
            var t = document.elementFromPoint(cx, cy);
            if (!t || !(t === b || b.contains(t))) continue;
            hits.push({ line: b.getAttribute('data-block-line'),
                        type: b.getAttribute('data-text-type'),
                        cx: Math.round(cx), cy: Math.round(cy),
                        rect: [Math.round(r.left), Math.round(r.top),
                               Math.round(r.width), Math.round(r.height)] });
        }
        if (!hits.length) return null;
        return { count: hits.length, pick: hits[Math.min(%d, hits.length - 1)] };
    """ % index)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--skip-clear', action='store_true', help='跳过清除步骤')
    args = ap.parse_args()

    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        enter_editing(cdp)

        print('=' * 62)
        print('步骤 1~2：打开论文 + 进编辑模式（看自动识别结果）')
        print('=' * 62)
        d0 = dump(cdp, '自动识别结果')

        if not args.skip_clear:
            print('\n' + '=' * 62)
            print('步骤 3：点「清除」')
            print('=' * 62)
            r = tap_sel(cdp, '.anno-fab', 0.9)
            print('  FAB 点击：%s' % ('ok' if r else 'FAIL'))
            conf = js(cdp, """
                var out = [];
                var bs = document.querySelectorAll('.sheet button, .form-actions button');
                for (var i = 0; i < bs.length; i++) {
                    var rr = bs[i].getBoundingClientRect();
                    if (!rr.width) continue;
                    out.push({ text: (bs[i].textContent || '').trim(),
                               cls: bs[i].className,
                               cx: Math.round(rr.left + rr.width/2),
                               cy: Math.round(rr.top + rr.height/2) });
                }
                return out;
            """)
            print('  确认表单：%s' % json.dumps(conf, ensure_ascii=False))
            tgt = None
            for x in (conf or []):
                if 'danger' in x['cls'] or 'primary' in x['cls']:
                    tgt = x
                    break
            if tgt:
                tap(cdp, tgt['cx'], tgt['cy'], 1.0)
                dump(cdp, '清除后')
            else:
                print('  ⚠️ 没找到确认按钮（可能提示"没有可清空的"）')
                tip = js(cdp, "var t=document.querySelector('.anno-tip');"
                              "return t ? t.textContent : null;")
                print('  提示语：%s' % tip)

        print('\n' + '=' * 62)
        print('步骤 4：**清除后新增一个框**（点块 → 升起表单 → 选分类）')
        print('=' * 62)
        # 清除后可见框通常是 0，所以这里直接找**任意可点的块**
        blk = js(cdp, """
            var l = document.querySelector('.anno-layer');
            if (!l) return null;
            var bs = l.querySelectorAll('.anno-block');
            var hits = [];
            for (var i = 0; i < bs.length; i++) {
                var b = bs[i];
                var line = b.getAttribute('data-block-line');
                if (line === '-1') continue;
                var r = b.getBoundingClientRect();
                var cx = r.left + r.width/2, cy = r.top + r.height/2;
                if (cy < 150 || cy > 790) continue;
                var t = document.elementFromPoint(cx, cy);
                if (!t || !(t === b || b.contains(t))) continue;
                hits.push({ line: line, type: b.getAttribute('data-text-type'),
                            cx: Math.round(cx), cy: Math.round(cy),
                            rect: [Math.round(r.left), Math.round(r.top),
                                   Math.round(r.width), Math.round(r.height)] });
            }
            if (!hits.length) return null;
            return { count: hits.length, pick: hits[Math.floor(hits.length/2)] };
        """)
        if not blk:
            raise SystemExit('  ❌ 找不到可点的块')
        p = blk['pick']
        print('  可点块 %d 个，取中间那个：line=%s type=%s @(%d,%d) rect=%s'
              % (blk['count'], p['line'], p['type'], p['cx'], p['cy'], p['rect']))

        pk = open_picker(cdp, p['cx'], p['cy'])
        if not pk:
            raise SystemExit('  ❌ 表单没打开')
        print('  当前选中：%s'
              % [o['text'] for o in pk['opts'] if o['pressed'] == 'true'])
        tgt2 = None
        for o in pk['opts']:
            if o['pressed'] != 'true':
                tgt2 = o
                break
        print('  选 "%s"' % tgt2['text'])
        tap(cdp, tgt2['cx'], tgt2['cy'], 1.0)
        d1 = dump(cdp, '新增框之后')

        print('\n' + '=' * 62)
        print('步骤 5~7：再点这个框 → 改分类/删除，看能否删掉')
        print('=' * 62)
        for attempt in range(1, 4):
            print('\n  ▸ 第 %d 次尝试' % attempt)
            # 找这个 line 的块
            info = js(cdp, """
                var l = document.querySelector('.anno-layer');
                var bs = l.querySelectorAll('.anno-block');
                for (var i = 0; i < bs.length; i++) {
                    if (bs[i].getAttribute('data-block-line') === %s) {
                        var r = bs[i].getBoundingClientRect();
                        return { cx: Math.round(r.left + r.width/2),
                                 cy: Math.round(r.top + r.height/2),
                                 rect: [Math.round(r.left), Math.round(r.top),
                                        Math.round(r.width), Math.round(r.height)],
                                 ttype: bs[i].getAttribute('data-text-type') };
                    }
                }
                return null;
            """ % json.dumps(p['line']))
            if not info:
                print('    ❌ 找不到 line=%s 的块' % p['line'])
                break
            print('    line=%s type=%s @(%d,%d) rect=%s'
                  % (p['line'], info['ttype'], info['cx'], info['cy'], info['rect']))

            pk2 = open_picker(cdp, info['cx'], info['cy'])
            if not pk2:
                print('    ❌ 表单没打开 —— **块点不到**（被什么盖住了？）')
                hit = js(cdp, """
                    var t = document.elementFromPoint(%d, %d);
                    return t ? (t.tagName + '.' + (t.className||'').toString()
                                .split(' ').slice(0,3).join('.')) : 'null';
                """ % (info['cx'], info['cy']))
                print('    (该点命中：%s)' % hit)
                break
            print('    当前=%s' % [o['text'] for o in pk2['opts'] if o['pressed'] == 'true'])
            dele = None
            for b in pk2['btns']:
                if 'danger' in b['cls']:
                    dele = b
                    break
            if not dele:
                print('    ❌ 没有删除按钮')
                break
            tap(cdp, dele['cx'], dele['cy'], 1.0)
            d2 = dump(cdp, '点删除后')
            still = [v for v in d2['visList'] if v[0] == p['line']]
            if still:
                print('    ❌ **删不掉**：line=%s 仍可见 type=%s'
                      % (p['line'], still[0][1]))
            else:
                print('    ✅ 已删除')

        print('\n  ▸ 最后再试「增加其他框」')
        blk3 = js(cdp, """
            var l = document.querySelector('.anno-layer');
            if (!l) return null;
            var bs = l.querySelectorAll('.anno-block');
            var n = 0;
            for (var i = 0; i < bs.length; i++) {
                var r = bs[i].getBoundingClientRect();
                var cx = r.left + r.width/2, cy = r.top + r.height/2;
                if (cy < 150 || cy > 790) continue;
                var t = document.elementFromPoint(cx, cy);
                if (t && (t === bs[i] || bs[i].contains(t))) n++;
            }
            return n;
        """)
        print('    当前可点的块数 = %s' % blk3)

        print('\n=== anno 日志 ===')
        for line in js(cdp, """
            return (window.__bootLog || []).filter(function (x) {
                return /annotate|clear/.test(x);
            }).slice(-24);
        """):
            print('  ' + str(line))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
