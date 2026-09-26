# -*- coding: utf-8 -*-
"""真手指全流程：冷启动 → 登录 → 阅读 → 原始视图 → 编辑 → 「文本」→ 划选 → 落笔。

⚠️ 唯一一处非真手指：登录（真实环境要走 GitHub OAuth 网页授权，
   自动化下点不掉）。这一处**显式标记**，其余全部用 adb input 真触摸。
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


print('##### 冷启动 #####')
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(13)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
DPR = js_dpr = cdp.evaluate('return window.devicePixelRatio')
print('  DPR=%s' % DPR)


def js(c):
    return cdp.evaluate(c)


def pp(v):
    return str(int(round(v * DPR)))


def tap(x, y, wait=1.5):
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


def swipe(x1, y1, x2, y2, ms=1000, wait=1.5, label=''):
    print('    👉 %s (%.0f,%.0f)→(%.0f,%.0f)' % (label, x1, y1, x2, y2))
    adb('shell', 'input', 'swipe', pp(x1), pp(y1), pp(x2), pp(y2), str(ms))
    time.sleep(wait)


def tap_el(expr, wait=1.5, label='', required=True):
    info = js("""
        var e = %s;
        if (!e) return null;
        var r = e.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var h = document.elementFromPoint(cx, cy);
        return JSON.stringify({ cx: cx, cy: cy,
            hit: h ? (h.tagName + '.' + (typeof h.className === 'string'
                  ? h.className.split(' ')[0] : '')) : 'null' });
    """ % expr)
    if not info or info == 'null':
        print('    ✗ 找不到 %s' % label)
        if required:
            raise SystemExit('停：缺少必需的 UI —— ' + label)
        return None
    d = json.loads(info)
    blocked = d['hit'].startswith('DIV.login') or 'reader-hint' in d['hit']
    print('    👆 %s @(%.0f,%.0f) 命中=%s%s'
          % (label, d['cx'], d['cy'], d['hit'], '  ⚠️被盖住!' if blocked else ''))
    tap(d['cx'], d['cy'], wait)
    return d


# ── 启动页 ─────────────────────────────────────────────────────
for _ in range(60):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
print('  启动页已结束')

# ── 登录 ───────────────────────────────────────────────────────
if js("return !!document.querySelector('.login.is-open');") is True:
    print('  ⚠️ 登录页挡着 —— 只有这一步用测试入口（真实环境走 GitHub OAuth）')
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(2.5)
print('  登录页在: %s' % js("return !!document.querySelector('.login.is-open');"))

# ── 打开文献（真手指）────────────────────────────────────────────
tap_el("document.querySelector('.doc-card')", 5.0, '文献卡片')
if js("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.42, 2.0)

# ── 切原始视图（真手指）──────────────────────────────────────────
if js("return document.querySelectorAll('.pdf-scroll').length") == 0:
    tap_el("document.getElementById('reader-view-toggle')", 5.0, '视图切换')
for _ in range(60):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)
print('  文字层词数 = %s'
      % js("return document.querySelectorAll('.pdf-text-line').length;"))

print()
print('##### 进编辑 + 「文本」（真手指）#####')
tap_el("document.getElementById('reader-annotate')", 2.5, '编辑按钮')
tap_el("document.querySelector('.reader-edit-tab[data-edit-mode=\"text\"]')",
       2.0, '「文本」选项')
print('  reader=%s' % js("return document.getElementById('reader').className"))
shot('20-文本模式')

print()
print('##### 划选 + 落笔「作者」（真手指）#####')
rows = json.loads(js("""
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    var vp = window.innerHeight;
    var out = [];
    for (var i = 0; i < ls.length && out.length < 4; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.width < 20 || r.height < 2) continue;
        if (r.top < 0 || r.bottom > vp) continue;
        var cx = r.left + 6, cy = r.top + r.height / 2;
        var h = document.elementFromPoint(cx, cy);
        if (!h || !h.classList || !h.classList.contains('pdf-text-line')) continue;
        var dup = false;
        for (var j = 0; j < out.length; j++) {
            if (Math.abs(out[j].y - cy) < 24) dup = true;
        }
        if (dup) continue;
        out.push({ x: r.left, y: r.top, w: r.width, h: r.height,
                   t: ls[i].textContent, row: ls[i].dataset.row,
                   top: ls[i].style.top });
    }
    return JSON.stringify(out);
"""))
print('  可用行 %d 条:' % len(rows))
for r in rows:
    print('    row=%s top=%s h=%.0f w=%.0f 「%s」'
          % (r['row'], r['top'], r['h'], r['w'], r['t'][:30]))

if not rows:
    print('  ⚠️ 没有可用行 —— 打印纵向上谁盖着谁')
    print(js("""
        var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
        var vp = window.innerHeight;
        var out = ['    视口高 ' + vp];
        var shown = 0;
        for (var i = 0; i < ls.length && shown < 14; i++) {
            var r = ls[i].getBoundingClientRect();
            if (r.width < 20 || r.height < 2) continue;
            if (r.top < 0 || r.bottom > vp) continue;
            var h = document.elementFromPoint(r.left + 6, r.top + r.height / 2);
            var who = h ? (h.tagName + '.' + (typeof h.className === 'string'
                ? h.className.split(' ')[0] : '')) : 'null';
            out.push('    y=' + Math.round(r.top) + '..' + Math.round(r.bottom)
                     + ' 「' + ls[i].textContent.slice(0, 16) + '」 → ' + who);
            shown++;
        }
        return out.join('\\n');
    """))
    raise SystemExit('没有可用行')

row = rows[0]
sy = row['y'] + row['h'] / 2

# ⚠️⚠️ 必须**跨多个词**拖（2026-09-26 修正测试）
#
# 踩过的坑：第一版从词内 12px 处拖 130px，但用
# `min(sx+130, row.x + row.w - 5)` 夹住了终点 —— 而 row 是**单个词**
# （「Recurrent」只有 27px 宽），于是终点被夹到 22px 处，
# **起点终点落在同一个词、甚至同一个字符上** → 选区长度 0 →
# `text` 为空 → `openSelectionTypePicker` 不触发 → 用户看到"没反应"。
#
# ✅ 正确做法：从**这一行的最左**拖到**这一行的最右**，
#    跨过途中的所有词，选区才成立（这也是用户真实会做的动作）。
line = json.loads(js("""
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    /* ⚠️ dataset.row 是**字符串**，这里的 row 是 JS 数字 ——
          必须两边都转字符串比较（踩过）。 */
    var row = String(%s);
    var vp = window.innerHeight;
    var hits = [];
    for (var i = 0; i < ls.length; i++) {
        if (String(ls[i].dataset.row) !== row) continue;
        var r = ls[i].getBoundingClientRect();
        if (r.top < 0 || r.bottom > vp) continue;
        hits.push({ l: r.left, r: r.right, t: ls[i].textContent });
    }
    if (!hits.length) return 'null';
    var lo = 1e9, hi = -1e9;
    for (var j = 0; j < hits.length; j++) {
        if (hits[j].l < lo) lo = hits[j].l;
        if (hits[j].r > hi) hi = hits[j].r;
    }
    return JSON.stringify({ lo: lo, hi: hi, n: hits.length,
        words: hits.map(function (h) { return h.t; }).join(' ') });
""" % row['row']))
print('  这一行（row=%s）有 %d 个词，x 跨 %.0f..%.0f，宽 %.0fpx'
      % (row['row'], line['n'], line['lo'], line['hi'], line['hi'] - line['lo']))
print('    「%s」' % line['words'][:70])

sx = line['lo'] + 4
ex = line['hi'] - 4
swipe(sx, sy, ex, sy, 1100, 2.0, '划选整行')

sel = js("""
    var o = [];
    document.querySelectorAll('.pdf-text-line.is-selected').forEach(function (s) {
        o.push(s.textContent);
    });
    return JSON.stringify({ n: o.length, words: o,
        sheet: document.querySelectorAll('.anno-typesheet').length });
""")
print('  [划选后] %s' % sel)
shot('21-划选后')

sd = json.loads(sel)
if sd['sheet'] == 0:
    print('  ❌ 类型弹层没出来 —— 划选没成立')
else:
    before = js("return JSON.stringify(window.ScholariusReader.getTextMarks())")
    bm = json.loads(before)
    tap_el("""(function () {
        var o = document.querySelectorAll('.anno-typeopt');
        for (var i = 0; i < o.length; i++) {
            var t = (o[i].textContent || '');
            if (t.indexOf('作者') >= 0 || t.toLowerCase().indexOf('author') >= 0) return o[i];
        }
        return null;
    })()""", 2.0, '「作者」选项')
    shot('22-落笔作者')

    am = json.loads(js("return JSON.stringify(window.ScholariusReader.getTextMarks())"))
    added = [x for x in am if x not in bm]
    print('  ★ 新增标注: %s' % json.dumps(added, ensure_ascii=False))

    print()
    print('  ══ 判据：标注覆盖的文字 vs 用户划的词 ══')
    print('    用户划的词   : %s' % ' '.join(sd['words'])[:110])
    if added:
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
            return o.join(' | ').slice(0, 130);
        """ % (added[0].get('from', 0), added[0].get('to', 0)))
        print('    标注覆盖的文字: %s' % covered)
        first = (sd['words'][0] if sd['words'] else '').strip()
        print('    → 第一个词「%s」在标注里: %s'
              % (first, '✅ 对上了' if first and first in covered
                 else '❌ 落错位置'))
cdp.close()
print()
print('截图: %s' % OUT)
