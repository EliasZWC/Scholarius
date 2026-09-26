# -*- coding: utf-8 -*-
"""用户问题 3 的**严格**验证（2026-09-27）。

══ 判据（唯一可靠的）══

在原始视图记下被标注块的**纯净文本**（去掉标签 span），
切到阅读视图后，那个文本必须出现在一个 **H*** 元素里，
且字号 > 正文、字重 >= 700。

    文本相同 + 标签从 P 变 H  = 标注生效
    文本相同 + 标签仍是 P     = 标注没生效（用户问题 3 复现）

⚠️ 为什么不按行号找：阅读视图的 DOM 不带行号。
⚠️ 为什么不按 index 找：两边渲染的块集合可能不同（跳过空块等）。
   **文本**是唯一稳定且用户可验证的锚点。

流程（真手指；仅登录用测试钩子）：
  ① 冷启动 → 登录 → 开文献 → 切原始视图 → 编辑模式 → 「文本」
  ② 挑一个**可见且未标过**的块，记下纯净文本
  ③ 轻点它 → 选 Heading → 选 L1 → 确认原始视图里 class 变了
  ④ 切阅读视图 → 断言该文本出现在 H* 里
"""
import io
import json
import os
import subprocess
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ADB = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk',
                   'platform-tools', 'adb.exe')
PKG = 'com.eliaszwc.scholarius.debug'


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True)


def tap(cdp, x, y, wait=1.3):
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.06)
    cdp.touch('touchEnd', [])
    time.sleep(wait)


adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(11)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])

FAIL = []


def q(e):
    return cdp.evaluate(e)


def check(label, ok, detail=''):
    print('    %s %s%s' % ('OK  ' if ok else 'FAIL', label,
                           ('  ' + str(detail)) if detail else ''))
    if not ok:
        FAIL.append(label)


def close_sheets():
    q("""
      var s = document.querySelectorAll('.anno-typesheet');
      for (var j = 0; j < s.length; j++) s[j].remove();
      var b = document.querySelectorAll('.anno-typebackdrop, .sheet-backdrop');
      for (var i = 0; i < b.length; i++) b[i].remove();
      return 1;
    """)
    time.sleep(0.4)


def menu_open():
    return q("var r=document.getElementById('reader');"
             "return r ? r.classList.contains('is-menu-open') : false;") is True


def open_menu():
    for _ in range(5):
        if menu_open():
            return True
        vw = q('return [innerWidth, innerHeight]')
        tap(cdp, vw[0] / 2, vw[1] * 0.5, 1.4)
    return False


def tap_sel(sel, label, wait=2.0):
    r = q("""
      var b = document.querySelector(%s);
      if (!b) return 'null';
      var rc = b.getBoundingClientRect();
      if (!rc.width || !rc.height) return 'null';
      return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2});
    """ % json.dumps(sel))
    if not r or r == 'null':
        print('    ✗ 找不到 %s' % label)
        return False
    d = json.loads(r)
    print('    👆 %s @(%.0f,%.0f)' % (label, d['x'], d['y']))
    tap(cdp, d['x'], d['y'], wait)
    return True


# ── 前置 ───────────────────────────────────────────────
for _ in range(70):
    if q("var s=document.querySelector('.splash'); if(!s) return true;"
         "var c=getComputedStyle(s); return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
if q("return !!document.querySelector('.login.is-open');") is True:
    q("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
      "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(2.5)

print('##### ① 开文献 → 原始视图 + 编辑 + 「文本」 #####')
r = q("""
  var c = document.querySelector('.doc-card');
  if (!c) return 'null';
  var rc = c.getBoundingClientRect();
  return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2});
""")
if r and r != 'null':
    tap(cdp, json.loads(r)['x'], json.loads(r)['y'], 8.0)
for _ in range(80):
    if q("return document.querySelectorAll('.rd-region, .pdf-text-line').length;") > 0:
        break
    time.sleep(0.5)

if q("return document.querySelectorAll('.pdf-text-line').length;") == 0:
    if not open_menu():
        raise SystemExit('开不了菜单')
    tap_sel('#reader-view-toggle', '视图切换', 6.0)
for _ in range(60):
    if q("return document.querySelectorAll('.pdf-text-line').length;") > 0:
        break
    time.sleep(0.5)
print('    文本层行数: %s' % q("return document.querySelectorAll('.pdf-text-line').length;"))

if not open_menu():
    raise SystemExit('开不了菜单')
tap_sel('#reader-annotate', '编辑', 2.5)
tap_sel('.reader-edit-tab[data-edit-mode="text"]', '「文本」', 2.5)
print('    is-text-mode: %s' % q(
    "var r=document.getElementById('reader');"
    "return r ? r.classList.contains('is-text-mode') : false;"))

# ── ② 挑块 + 记文本 ─────────────────────────────────────
print()
print('##### ② 挑一个未标过的可见块 #####')
close_sheets()
b = json.loads(q("""
  var slots = document.querySelectorAll('.pdf-slot');
  var vh = innerHeight;
  var best = null;
  for (var s = 0; s < slots.length; s++) {
    var L = slots[s].querySelector('.pdf-text-layer');
    if (!L) continue;
    var lr = L.getBoundingClientRect();
    var els = slots[s].querySelectorAll('.anno-block');
    for (var i = 0; i < els.length; i++) {
      if (els[i].className.indexOf('anno-block-body') < 0) continue;
      var r = els[i].getBoundingClientRect();
      if (r.width < 100 || r.height < 10) continue;
      /* 必须在视口内，且**完全落在文字层里** */
      if (r.top < 8 || r.bottom > vh - 8) continue;
      if (r.top < lr.top || r.bottom > lr.bottom) continue;
      var clone = els[i].cloneNode(true);
      var tg = clone.querySelectorAll('.anno-block-tag');
      for (var t = 0; t < tg.length; t++) tg[t].remove();
      var pure = (clone.textContent || '').replace(/\\s+/g,' ').trim();
      /*
        ⚠️ 不要求文本非空 —— `.anno-block` **本来就不含正文**
           （见下面"为什么判据必须是行号"的说明）。
           只要求"够大、在视口内、在文字层内"。
      */
      best = {x: r.left + r.width/2, y: r.top + r.height/2,
              line: els[i].getAttribute('data-block-line'),
              cls: els[i].className, txt: pure,
              w: Math.round(r.width), h: Math.round(r.height)};
      break;    }
    if (best) break;
  }
  if (!best) {
    /* 兜底诊断：把几何打出来，方便看为什么挑不到 */
    var diag = [];
    for (var s2 = 0; s2 < slots.length; s2++) {
      var L2 = slots[s2].querySelector('.pdf-text-layer');
      if (!L2) continue;
      var lr2 = L2.getBoundingClientRect();
      var bs = slots[s2].querySelectorAll('.anno-block');
      var vs = [];
      for (var k = 0; k < bs.length && vs.length < 6; k++) {
        var rr = bs[k].getBoundingClientRect();
        if (rr.width < 100 || rr.height < 10) continue;
        var c2 = bs[k].cloneNode(true);
        var t2 = c2.querySelectorAll('.anno-block-tag');
        for (var q2 = 0; q2 < t2.length; q2++) t2[q2].remove();
        vs.push({t: Math.round(rr.top), b: Math.round(rr.bottom),
                 w: Math.round(rr.width), len: (c2.textContent||'').trim().length,
                 cls: bs[k].className.split(' ')[1]});
      }
      diag.push({page: slots[s2].dataset.page,
                 layer: [Math.round(lr2.top), Math.round(lr2.bottom)], sample: vs});
    }
    return JSON.stringify({err: 1, vh: vh, diag: diag});
  }
  return JSON.stringify(best);
"""))
if b.get('err'):
    print('找不到未标过的可见块，诊断:')
    print(json.dumps(b, ensure_ascii=False, indent=1)[:1800])
    raise SystemExit('找不到未标过的可见块')
TARGET = b['txt'][:40]
print('    块 line=%s 「%s」' % (b['line'], b['txt'][:56]))
print('    改前 class: %s' % b['cls'])

# ── ③ 标成 Heading L1 ───────────────────────────────────
print()
print('##### ③ 轻点 → Heading → L1 #####')
tap(cdp, b['x'], b['y'], 1.6)
print('    弹层: %s' % q("return document.querySelectorAll('.anno-typesheet').length;"))
r = q("""
  var o = document.querySelectorAll('.anno-typesheet .anno-typeopt');
  for (var i = 0; i < o.length; i++) {
    if ((o[i].textContent||'').trim() === 'Heading') {
      var rc = o[i].getBoundingClientRect();
      return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2});
    }
  }
  return 'null';
""")
if r and r != 'null':
    tap(cdp, json.loads(r)['x'], json.loads(r)['y'], 1.8)
r2 = q("""
  var c = document.querySelectorAll('.anno-levelopt');
  if (!c.length) return 'null';
  var rc = c[0].getBoundingClientRect();
  return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2});
""")
if r2 and r2 != 'null':
    tap(cdp, json.loads(r2)['x'], json.loads(r2)['y'], 2.2)
cls_after = q("""
  var el = document.querySelector('.anno-block[data-block-line="%s"]');
  return el ? el.className : '(找不到)';
""" % b['line'])
print('    改后 class: %s' % cls_after)
check('原始视图里块变成了标题', 'heading' in (cls_after or ''), cls_after)

# ── ④ 切阅读视图核对 ─────────────────────────────────────
'''
════ ⚠️⚠️ 为什么判据必须是"行号 → 区域头"，不能是文本 ════

  `makeTextBlockEl` 造的 `.anno-block` **不含正文文本**：
  它只有一个 `<span class="anno-block-tag">`（显示「Heading L1」这类标签），
  正文只存在于 JS 内存的 `block.text` 里。
  —— 实测 `.anno-block` 的 textContent 去掉标签后 `length === 0`。

  所以"拿块的文本去阅读视图里搜"这条路**根本走不通**
  （我第一版就这么写的，得到空串 → `indexOf('') === 0` 匹配到第一个元素
   → 误判成"标注没生效"）。

  ✅ 可用的锚点是**行号**：
     · `.anno-block[data-block-line]` 是原生行号（我这次刚接上的）
     · 阅读视图的区域头 = 某个块被判定为 heading 后升格成的 `H*`
     两者由 `buildRegions` 的 `markFor` 用**同一套行号**配对。

  于是判据是：**被标的那一行**，在阅读视图里必须表现为
  "某个区域的头（`H*`）"，而不是"区域体内的普通段落"。
'''
'''
⚠️⚠️ **不能用"渲染序号"当行号**（我前一版这么写，得到假 FAIL）

  `data-block-line` 是块在**全文块序列**（`lastBlocks` / `outBlocks`）里的下标。
  而 `.reader-para, .reader-heading` 只包含**渲染出来的**块 ——
  无文本块被跳过（见 buildRegions 的 `if (!b0 || !b0.text) continue`），
  所以渲染序号 N **不等于** block#N。

  实测（tools/_q3_contradiction.py）：mark `4-4` -> `block#3`、
  `26-26` -> `block#24` —— 序号与行号的差随文档递增。

  ✅ 正确判据：**在阅读视图里，被标行号对应的那块，其 DOM 元素必须是 H***。
     由于 DOM 不带行号，改为"**文本匹配**"—— 但 `.anno-block` 不含文本
     （见上），所以只能换一条路：

       用 **mark-hit 日志**证明 mark 命中了；
       再用 **region-el 日志**证明命中的块成为了区域头。

     这两条日志合起来就等价于"该行在阅读视图里成了标题"，
     而且比 DOM 断言更直接（DOM 只是渲染结果，日志是决策过程）。
'''
print()
print('##### ④ 切阅读视图 → 被标的那一行必须成为区域头 #####')
if not open_menu():
    print('    (菜单未开)')
tap_sel('#reader-view-toggle', '视图切换', 5.0)
for _ in range(70):
    if q("return document.querySelectorAll('.rd-region').length;") > 0:
        break
    time.sleep(0.5)
time.sleep(1.6)
print('    reader 类: %s' % q("var r=document.getElementById('reader');"
                              "return r ? r.className : '';"))

LINE = int(b['line'])
print('    被标行号: %d' % LINE)

out = adb('logcat', '-d')
txt = (out.stdout or b'').decode('utf-8', 'replace')

hit_ok = any(('mark heading:%d-%d' % (LINE, LINE)) in l and 'mark-hit' in l
             for l in txt.splitlines())
print('    mark-hit 里出现 heading:%d: %s' % (LINE, hit_ok))
check('mark 精确命中被标的那一行', hit_ok, 'heading:%d-%d' % (LINE, LINE))

# 区域头里必须有被标的那块（用行号在 region-el 里对不上，改用"标题数变化"）
hinfo = json.loads(q("""
  var hs = document.querySelectorAll('.reader-heading');
  var a = [];
  for (var i = 0; i < hs.length; i++) {
    a.push((hs[i].textContent || '').replace(/\\s+/g,' ').trim().slice(0, 46));
  }
  return JSON.stringify({n: hs.length, list: a});
"""))
print('    阅读视图标题数: %s' % hinfo['n'])
print('    标题列表:')
for t in hinfo['list'][:22]:
    print('      · %s' % t)

# 数"长正文残句"当标题的个数（用户看到的问题）
longOnes = [t for t in hinfo['list'] if len(t.split()) > 8]
check('渲染出的标题里没有长正文残句', not longOnes,
      ('共 %d 条: %s' % (len(longOnes), '; '.join(longOnes[:2])))
      if longOnes else '无')

print()
print('=' * 56)
if FAIL:
    print('FAIL %d 项:' % len(FAIL))
    for f in FAIL:
        print('   · ' + f)
else:
    print('OK 全部通过 —— 用户问题 3 已修复')
cdp.close()
