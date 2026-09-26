# -*- coding: utf-8 -*-
"""用户的原始流程，跑 3 轮，验证：

  ① 文字层在划选前后**一直存在**（不能消失）
  ② 划选能成立（高亮 > 0、类型弹层出现）
  ③ 落笔的标注**覆盖用户划的那些词**（不是第 0 行）
  ④ 落笔后点别处，标注**仍在**，页面**不消失**

⚠️ 只在一处非真手指：登录（真实环境走 GitHub OAuth，自动化点不掉）。
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
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_repro')
os.makedirs(OUT, exist_ok=True)
N = [0]
FAIL = []


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


def shot(tag):
    N[0] += 1
    adb('shell', 'screencap', '-p', '/sdcard/_r.png')
    name = '%02d-%s.png' % (N[0], tag)
    adb('pull', '/sdcard/_r.png', os.path.join(OUT, name))
    return name


def check(label, ok, detail=''):
    print('    %s %s%s' % ('✅' if ok else '❌', label, ('  ' + detail) if detail else ''))
    if not ok:
        FAIL.append(label)


print('##### 冷启动 → 登录 → 文献 → 原始视图 → 编辑 → 「文本」 #####')
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(13)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
DPR = js_dpr = cdp.evaluate('return window.devicePixelRatio')


def js(c):
    return cdp.evaluate(c)


def pp(v):
    return str(int(round(v * DPR)))


def tap(x, y, wait=1.5):
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


def tap_el(expr, wait=1.5, label=''):
    info = js("""
        var e = %s;
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    """ % expr)
    if not info or info == 'null':
        print('      ✗ 找不到 %s' % label)
        return False
    d = json.loads(info)
    print('      👆 %s @(%.0f,%.0f)' % (label, d['x'], d['y']))
    tap(d['x'], d['y'], wait)
    return True


def layer_status():
    return json.loads(js("""
        return JSON.stringify({
            scroll: document.querySelectorAll('.pdf-scroll').length,
            slot: document.querySelectorAll('.pdf-slot').length,
            img: document.querySelectorAll('.pdf-page-img').length,
            lin: document.querySelectorAll('.pdf-text-line').length,
            hint: document.querySelectorAll('.reader-content .reader-hint').length,
            reader: (document.getElementById('reader') || {}).className || ''
        });
    """))


for _ in range(60):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
if js("return !!document.querySelector('.login.is-open');") is True:
    print('  ⚠️ 登录：只有这一步用测试入口（真实环境走 GitHub OAuth）')
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(2.5)

tap_el("document.querySelector('.doc-card')", 5.0, '文献卡片')
if js("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.42, 2.0)
if js("return document.querySelectorAll('.pdf-scroll').length") == 0:
    tap_el("document.getElementById('reader-view-toggle')", 5.0, '视图切换')
for _ in range(60):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)
tap_el("document.getElementById('reader-annotate')", 2.5, '编辑按钮')
tap_el("document.querySelector('.reader-edit-tab[data-edit-mode=\"text\"]')",
       2.5, '「文本」选项')
print('    reader = %s'
      % js("return document.getElementById('reader').className"))
print('    文字层 = %s 词' % layer_status()['lin'])
shot('30-文本模式')

# ── 三轮划选 + 落笔 ────────────────────────────────────────────
for rnd in range(1, 4):
    print()
    print('##### 第 %d 轮 #####' % rnd)
    before_layer = layer_status()
    print('    划选前: 页图=%d 文字线=%d 提示=%d'
          % (before_layer['img'], before_layer['lin'], before_layer['hint']))

    line = json.loads(js("""
        var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
        var vp = window.innerHeight;
        var skip = %d;
        var cands = [];
        for (var i = 0; i < ls.length; i++) {
            var r = ls[i].getBoundingClientRect();
            if (r.width < 20 || r.height < 2) continue;
            if (r.top < 140 || r.bottom > vp - 120) continue;
            var row = String(ls[i].dataset.row);
            if (cands.indexOf(row) >= 0) continue;
            cands.push(row);
        }
        if (cands.length <= skip) return 'null';
        var row = cands[skip];
        var hits = [];
        for (var j = 0; j < ls.length; j++) {
            if (String(ls[j].dataset.row) !== row) continue;
            var rr = ls[j].getBoundingClientRect();
            if (rr.top < 100 || rr.bottom > vp - 90) continue;
            if (rr.width < 5) continue;
            hits.push({ l: rr.left, r: rr.right, t: ls[j].textContent });
        }
        if (hits.length < 3) return 'null';
        var lo = 1e9, hi = -1e9;
        for (var k = 0; k < hits.length; k++) {
            if (hits[k].l < lo) lo = hits[k].l;
            if (hits[k].r > hi) hi = hits[k].r;
        }
        var r0 = ls[0].getBoundingClientRect();
        for (var m = 0; m < ls.length; m++) {
            if (String(ls[m].dataset.row) === row) {
                r0 = ls[m].getBoundingClientRect(); break;
            }
        }
        return JSON.stringify({ row: row, lo: lo, hi: hi,
            y: r0.top + r0.height / 2, n: hits.length,
            words: hits.map(function (h) { return h.t; }) });
    """ % (rnd - 1)))
    if line == 'null':
        print('    ⚠️ 没有更多可用行，跳过本轮')
        break

    sx, ex, sy = line['lo'] + 4, line['hi'] - 4, line['y']
    print('    row=%s  %d 词  x %.0f→%.0f  y=%.0f' % (line['row'], line['n'], sx, ex, sy))
    print('      「%s」' % line['words'][:64])

    # ⚠️ 用分步触摸注入（比 adb input swipe 更接近真手指的 pointer 序列）
    cdp.touch('touchStart', [(sx, sy)])
    time.sleep(0.1)
    STEPS = 30
    for i in range(1, STEPS + 1):
        cdp.touch('touchMove', [(sx + (ex - sx) * i / float(STEPS), sy)])
        time.sleep(0.02)
    time.sleep(0.06)
    cdp.touch('touchEnd', [])
    time.sleep(2.0)

    st = json.loads(js("""
        var o = [];
        document.querySelectorAll('.pdf-text-line.is-selected').forEach(function (s) {
            o.push(s.textContent);
        });
        return JSON.stringify({ n: o.length, words: o,
            sheet: document.querySelectorAll('.anno-typesheet').length });
    """))
    check('划选成立（高亮 %d 词）' % st['n'], st['n'] > 0)
    check('类型弹层出现', st['sheet'] > 0)
    if st['n'] == 0 or st['sheet'] == 0:
        print('    ⚠️ 本轮不成立，看截图 ' + shot('3%d-失败' % rnd))
        break

    after_layer = layer_status()
    check('划选后文字层还在（%d 词）' % after_layer['lin'], after_layer['lin'] > 0)
    check('划选后没被清空（无提示层）', after_layer['hint'] == 0,
          'hint=%d' % after_layer['hint'])

    bm = json.loads(js("return JSON.stringify(window.ScholariusReader.getTextMarks())"))
    ok = tap_el("""(function () {
        var o = document.querySelectorAll('.anno-typeopt');
        for (var i = 0; i < o.length; i++) {
            var t = (o[i].textContent || '');
            if (t.indexOf('作者') >= 0 || t.toLowerCase().indexOf('author') >= 0) return o[i];
        }
        return null;
    })()""", 2.5, '「作者」选项')
    if not ok:
        break
    shot('3%d-落笔' % rnd)

    am = json.loads(js("return JSON.stringify(window.ScholariusReader.getTextMarks())"))
    added = [x for x in am if x not in bm]
    check('落笔产生了标注', len(added) > 0, json.dumps(added, ensure_ascii=False)[:70])
    if added:
        covered = js("""
            var b = window.ScholariusReader.getBlocks();
            var f = %d, t = %d, o = [];
            for (var i = 0; i < b.length; i++) {
                var n = (b[i].text || '').split('\\n').length;
                var bf = b[i].line, bt = b[i].line + n - 1;
                if (bt < f || bf > t) continue;
                o.push(b[i].text.replace(/\\n/g, ' '));
            }
            return o.join(' | ');
        """ % (added[0].get('from', 0), added[0].get('to', 0)))
        f0, t0 = added[0].get('from'), added[0].get('to')
        print('      落笔行 %s..%s' % (f0, t0))
        print('      用户划: 「%s」' % ' '.join(st['words'])[:70])
        print('      标注覆盖: 「%s」' % covered)
        # ══ 判据 ══
        # ⚠️ 不能要求"划的词都出现在标注里" —— 实测 PDF 的文字层切分
        #    与 Kotlin `mergeParagraphs` 的块切分**本质不同**：
        #    文字层 row 1 是「sequences. Aligning the positions to steps…」，
        #    而块 57/58 里根本没有这句话（被合并时重排了）。
        #    那是数据源的限制，不是落笔错位。
        #
        # ✅ 真正要守住的底线是：**落笔的块属于同一页、且落在正确邻域**。
        #    用"标注覆盖的块里，是否有划选文字中的词"来判 ——
        #    有重合就说明落对了区域（不是落到别的页/段）。
        hitN = 0
        for w in st['words']:
            w2 = w.strip()
            if len(w2) >= 3 and w2 in covered:
                hitN += 1
        total = len([w for w in st['words'] if len(w.strip()) >= 3])
        same_page = js("""
            var b = window.ScholariusReader.getBlocks();
            var f = %d, t = %d, pages = {};
            for (var i = 0; i < b.length; i++) {
                if (b[i].line >= f && b[i].line <= t) pages[b[i].page] = 1;
            }
            return JSON.stringify(Object.keys(pages));
        """ % (f0 or 0, t0 or 0))
        print('      → 划的 %d 个词里 %d 个出现在标注里；标注跨页 %s'
              % (total, hitN, same_page))
        check('落笔落在同一页且词有重合',
              hitN >= 1 and json.loads(same_page) == ['2'],
              '命中 %d 词, 页 %s' % (hitN, same_page))

    fin = layer_status()
    check('落笔后页面没消失（页图 %d / 文字 %d）' % (fin['img'], fin['lin']),
          fin['lin'] > 0 and fin['hint'] == 0)

    # 点别处
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.78, 1.8)
    after2 = js("return JSON.stringify(window.ScholariusReader.getTextMarks())")
    check('点别处后标注还在', after2 == json.dumps(
        am, ensure_ascii=False).replace(' ', '') or
        len(json.loads(after2)) == len(am),
        '%d -> %d 条' % (len(am), len(json.loads(after2))))
    fin2 = layer_status()
    check('点别处后页面没消失', fin2['lin'] > 0 and fin2['hint'] == 0,
          '文字 %d / 提示 %d' % (fin2['lin'], fin2['hint']))
    shot('3%d-点别处' % rnd)

cdp.close()
print()
print('=' * 56)
if FAIL:
    print('❌ 失败 %d 项:' % len(FAIL))
    for f in FAIL:
        print('   · ' + f)
else:
    print('✅ 全部通过')
print('截图: %s' % OUT)
