# -*- coding: utf-8 -*-
"""按用户真实顺序复现全部三个问题（含进编辑模式 + 点「文本」）。

用户的三条：
  ① 很难选中（可能和大小关系）
  ② 清空所有区域后还剩一个公式删不掉
  ③ 随机挑一处改「作者」→ 没成功、**似乎跳到最开头**；
     然后**选中的地方一点其他区域就没了**（选中与建立区域脱节）
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


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


def shot(tag):
    N[0] += 1
    adb('shell', 'screencap', '-p', '/sdcard/_r.png')
    name = '%02d-%s.png' % (N[0], tag)
    adb('pull', '/sdcard/_r.png', os.path.join(OUT, name))
    print('    📸 %s' % name)


ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')
pp = lambda v: str(int(round(v * DPR)))  # noqa: E731


def tap(x, y, wait=1.5):
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


def tap_el(expr, wait=1.5, label=''):
    info = js("""
        var e = %s;
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var hit = document.elementFromPoint(cx, cy);
        return JSON.stringify({ cx: cx, cy: cy,
            rect: [Math.round(r.left), Math.round(r.top),
                   Math.round(r.width), Math.round(r.height)],
            hit: hit ? (hit.id || hit.tagName) + '.'
                 + (typeof hit.className === 'string' ? hit.className.split(' ')[0] : '')
                 : 'null' });
    """ % expr)
    if not info:
        print('    ✗ 找不到 %s' % label)
        return None
    d = json.loads(info)
    print('    👆 %s @(%.0f,%.0f) 命中=%s' % (label, d['cx'], d['cy'], d['hit']))
    tap(d['cx'], d['cy'], wait)
    return d


def swipe(x1, y1, x2, y2, ms=1000, wait=1.5, label=''):
    print('    👉 %s (%.0f,%.0f)→(%.0f,%.0f)' % (label, x1, y1, x2, y2))
    adb('shell', 'input', 'swipe', pp(x1), pp(y1), pp(x2), pp(y2), str(ms))
    time.sleep(wait)


def state(tag=''):
    return {
        'hl': js("return document.querySelectorAll('.pdf-text-line.is-selected').length"),
        'sheet': js("return document.querySelectorAll('.anno-typesheet').length"),
        'sel': js("var s=getSelection(); return s?String(s).length:0"),
        'reader': js("return document.getElementById('reader').className"),
    }


def show(tag):
    s = state()
    print('    [%s] 高亮词=%s 弹层=%s 选区字符=%s' % (tag, s['hl'], s['sheet'], s['sel']))


# ── 走到编辑 + 文本模式 ─────────────────────────────────────────
print('##### 冷启动 → 原始视图 → 编辑 → 「文本」 #####')
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(13)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
DPR = js('return window.devicePixelRatio')

for _ in range(60):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
if js("return !!document.querySelector('.login.is-open')") is True:
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(1.8)

tap_el("document.querySelector('.doc-card')", 4.5, '文献卡片')
if js("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.42, 1.8)
if js("return document.querySelectorAll('.pdf-scroll').length") == 0:
    tap_el("document.getElementById('reader-view-toggle')", 4.0, '视图切换')
for _ in range(50):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)

tap_el("document.getElementById('reader-annotate')", 2.5, '编辑按钮')
tap_el("document.querySelector('.reader-edit-tab[data-edit-mode=\"text\"]')", 2.0, '「文本」选项')
print('    reader=%s' % js("return document.getElementById('reader').className"))
shot('10-文本模式')

# ── 问题① 在不同行上划选 ───────────────────────────────────────
print()
print('##### 问题① 选中的难易 #####')
rows = json.loads(js("""
    var ls = document.querySelectorAll('.pdf-text-line');
    var vh = window.innerHeight;
    /* ⚠️ 编辑模式下顶栏(113) + 编辑栏(~88) 占掉上下，
          可用区比非编辑模式窄得多。按**实际遮挡**算，别写死边距。 */
    var topLimit = 120, botLimit = vh - 100;
    var out = [];
    for (var i = 0; i < ls.length && out.length < 6; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.top < topLimit || r.bottom > botLimit) continue;
        if (r.width < 8 || r.height < 3) continue;
        var dup = false;
        for (var j = 0; j < out.length; j++) {
            if (Math.abs(out[j].y - (r.top + r.height / 2)) < 22) dup = true;
        }
        if (dup) continue;
        out.push({ x: r.left, y: r.top, w: r.width, h: r.height,
                   t: (ls[i].textContent || '').slice(0, 24) });
    }
    return JSON.stringify(out);
"""))
print('    找到 %d 条不同高度的行' % len(rows))
if not rows:
    print('    ⚠️ 仍找不到 —— 打印可见行分布')
    print(js("""
        var ls = document.querySelectorAll('.pdf-text-line');
        var vh = window.innerHeight;
        var bands = {};
        for (var i = 0; i < ls.length; i++) {
            var r = ls[i].getBoundingClientRect();
            var k = Math.floor(r.top / 100) * 100;
            if (!bands[k]) bands[k] = {n: 0, ok: 0};
            bands[k].n++;
            if (r.width >= 8 && r.height >= 3) bands[k].ok++;
        }
        var ks = Object.keys(bands).sort(function (a, b) { return a - b; });
        var out = ['  视口 ' + vh + 'px，行分布（top档: 总数/可用）:'];
        for (var j = 0; j < Math.min(ks.length, 16); j++) {
            out.push('    top≈' + ks[j] + ': ' + bands[ks[j]].n + '/' + bands[ks[j]].ok);
        }
        return out.join('\\n');
    """))
    raise SystemExit('找不到可见行')
ok = 0
for k, row in enumerate(rows):
    sx = row['x'] + row['w'] * 0.2
    sy = row['y'] + row['h'] / 2
    hit = js("""
        var e = document.elementFromPoint(%.1f, %.1f);
        return e ? (e.tagName + '.' + (typeof e.className === 'string'
                    ? e.className.split(' ')[0] : '')) : 'null';
    """ % (sx, sy))
    js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")
    swipe(sx, sy, sx + 120, sy, 900, 1.3)
    s = state()
    okk = s['hl'] > 0
    if okk:
        ok += 1
    print('        行%d h=%.0f "%s" 起点=%s → 高亮=%s 选区=%s %s'
          % (k + 1, row['h'], row['t'][:14], hit.split('.')[0], s['hl'], s['sel'],
             '✅' if okk else '❌'))
    if k == 0:
        shot('11-划选后')
print('    成功 %d/%d' % (ok, len(rows)))

# ── 问题③ 落笔 + 点别处 ─────────────────────────────────────────
print()
print('##### 问题③ 落笔「作者」→ 点别处 #####')
row = rows[0]
sx = row['x'] + row['w'] * 0.2
sy = row['y'] + row['h'] / 2
js("var s=getSelection(); if(s) s.removeAllRanges(); return 1")
swipe(sx, sy, sx + 120, sy, 900, 2.0, '划选（准备落笔）')
show('划选后')
shot('12-划选待落笔')

# 记下落笔前的标注快照
before = js("""
    var r = window.ScholariusReader;
    return r && r.getTextMarks ? JSON.stringify(r.getTextMarks()) : 'no api';
""")
print('    落笔前 textMarks 条数: %s' % (len(json.loads(before)) if before != 'no api' else '?'))

# 点「作者」
tgt = js("""
    var o = document.querySelectorAll('.anno-typeopt');
    var out = [];
    for (var i = 0; i < o.length; i++) {
        out.push((o[i].textContent || '').trim());
    }
    return JSON.stringify(out);
""")
print('    类型选项: %s' % tgt)
ok2 = tap_el("""(function () {
    var o = document.querySelectorAll('.anno-typeopt');
    for (var i = 0; i < o.length; i++) {
        var t = (o[i].textContent || '');
        if (t.indexOf('作者') >= 0 || t.toLowerCase().indexOf('author') >= 0) return o[i];
    }
    return null;
})()""", 2.0, '「作者」选项')
show('落笔后')
shot('13-落笔作者')

after = js("""
    var r = window.ScholariusReader;
    return r && r.getTextMarks ? JSON.stringify(r.getTextMarks()) : 'no api';
""")
try:
    bm = json.loads(before)
    am = json.loads(after)
    added = [x for x in am if x not in bm]
    print('    ★ 新增的标注: %s' % json.dumps(added, ensure_ascii=False)[:200])
    if added:
        print('    ★ 落在行 %s..%s' % (added[0].get('from'), added[0].get('to')))
        print()
        print('    ══ 判据：这条标注覆盖的文字，是不是用户划的那些词？ ══')
        # 用户划的词
        picked = js("""
            var o = [];
            document.querySelectorAll('.pdf-text-line.is-selected')
                .forEach(function (s) { o.push(s.textContent); });
            return JSON.stringify(o);
        """)
        print('      用户划的词 : %s' % str(picked)[:120])
        # 标注覆盖的文字（用 getBlocks 反查 from..to 对应的块文本）
        covered = js("""
            var r = window.ScholariusReader;
            var b = r.getBlocks();
            var f = %d, t = %d;
            var o = [];
            for (var i = 0; i < b.length; i++) {
                var n = (b[i].text || '').split('\\n').length;
                var bf = b[i].line, bt = b[i].line + n - 1;
                if (bt < f || bf > t) continue;
                o.push(b[i].text.replace(/\\n/g, ' '));
            }
            return o.join(' | ').slice(0, 140);
        """ % (added[0].get('from', 0), added[0].get('to', 0)))
        print('      标注覆盖的文字: %s' % covered)
        # 判定：用户划的第一个词是否出现在覆盖文字里
        try:
            words = json.loads(picked)
            first = (words[0] if words else '').strip()
            good = bool(first) and first in covered
            print('      → 第一个词「%s」在标注里: %s'
                  % (first, '✅ 对上了' if good else '❌ 没对上（落错位置）'))
        except Exception:
            pass
except Exception as e:
    print('    解析失败: %s' % e)

# ★ 关键：点屏幕另一处，看标注/选中会不会没
print()
print('    ★★ 点页面别处（你的操作：「一点其他区域就没了」）')
vw = js('return [innerWidth, innerHeight]')
tap(vw[0] * 0.5, vw[1] * 0.75, 1.8)
show('点别处后')
shot('14-点别处后')

after2 = js("""
    var r = window.ScholariusReader;
    return r && r.getTextMarks ? JSON.stringify(r.getTextMarks()) : 'no api';
""")
print('    点别处后 textMarks 条数: %s'
      % (len(json.loads(after2)) if after2 != 'no api' else '?'))
print('    刚才那条标注还在吗: %s'
      % ('✅ 还在' if after2 == after else '❌ 没了/变了'))

cdp.close()
print()
print('截图: %s' % OUT)
