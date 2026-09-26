# -*- coding: utf-8 -*-
"""验证问题 2 的修复：轻点已标过的块 → 弹出「Edit」类型选择。

同时回归验证：
  · 长按 + 拖拽 = 仍然划选（不能被"轻点改类型"抢走）
  · 轻点空白文字（不在任何块里）= 不开弹层、不打乱状态
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
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(12)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def q(e):
    return cdp.evaluate(e)


def tap(x, y, wait=1.3):
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.06)
    cdp.touch('touchEnd', [])
    time.sleep(wait)


def close_all():
    """
    ⚠️ 直接摘掉弹层 DOM，**不点 backdrop** ——
       点 backdrop 会顺带切换 `is-menu-open`，
       把刚开好的菜单又关掉（顶栏跟着收起，后续按钮全点不到）。
    """
    q("""
      var s = document.querySelectorAll('.anno-typesheet');
      for (var j = 0; j < s.length; j++) s[j].remove();
      var b = document.querySelectorAll('.anno-typebackdrop, .sheet-backdrop');
      for (var i = 0; i < b.length; i++) b[i].remove();
      return 1;
    """)
    time.sleep(0.4)


def enter_text_mode():
    """进编辑模式 → 点「文本」。返回是否成功。

    ⚠️⚠️ 顶栏只在 `is-menu-open` 时露出（styles.css:1171）——
        `.reader-top` 默认 `transform: translateY(-100%)`，
        按钮的 `top` 是 **-52**（完全在视口上方）。
        所以必须先**点内容区开菜单**，否则所有顶栏按钮都点不到
        —— 表现为"点了没反应"，实际是坐标在屏外（踩过）。
    """
    close_all()

    # ① 开文献（若还在列表页）
    if q("return document.querySelectorAll('.pdf-text-line').length;") == 0:
        r = q("""
          var c = document.querySelector('.doc-card');
          if (!c) return 'null';
          var rc = c.getBoundingClientRect();
          return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2});
        """)
        if r and r != 'null':
            d = json.loads(r)
            tap(d['x'], d['y'], 5.0)

    # ② 开菜单（露出顶栏）
    def menu_open():
        return q("var r=document.getElementById('reader');"
                 "return r ? r.classList.contains('is-menu-open') : false;") is True

    for _ in range(3):
        if menu_open():
            break
        vw = q('return [innerWidth, innerHeight]')
        tap(vw[0] / 2, vw[1] * 0.5, 1.5)
    if not menu_open():
        print('  ✗ 打不开菜单（顶栏露不出来）')
        return False

    # ③ 切到「原始」视图（文本层只在原始视图里有）
    if q("return document.querySelectorAll('.pdf-scroll').length;") == 0:
        r = q("""
          var b = document.getElementById('reader-view-toggle');
          if (!b) return 'null';
          var rc = b.getBoundingClientRect();
          return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2});
        """)
        if r and r != 'null':
            d = json.loads(r)
            tap(d['x'], d['y'], 6.0)

    for _ in range(60):
        if q("return document.querySelectorAll('.pdf-text-line').length;") > 0:
            break
        time.sleep(0.5)
    if q("return document.querySelectorAll('.pdf-text-line').length;") == 0:
        print('  ✗ 文本层没出来')
        return False

    # ④ 进编辑模式（菜单可能因切视图而收起，重新开）
    if not menu_open():
        vw = q('return [innerWidth, innerHeight]')
        tap(vw[0] / 2, vw[1] * 0.5, 1.5)
    r = q("""
      var b = document.getElementById('reader-annotate');
      if (!b) return 'null';
      var rc = b.getBoundingClientRect();
      return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2});
    """)
    if r and r != 'null':
        d = json.loads(r)
        tap(d['x'], d['y'], 2.5)

    # ⑤ 点「文本」
    r = q("""
      var b = document.querySelector('.reader-edit-tab[data-edit-mode="text"]');
      if (!b) return 'null';
      var rc = b.getBoundingClientRect();
      return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2});
    """)
    if r and r != 'null':
        d = json.loads(r)
        tap(d['x'], d['y'], 2.5)

    mode = q("var r=document.getElementById('reader');"
             "return r ? r.className : '';")
    print('  reader 类: %s' % mode)
    return 'is-text-mode' in (mode or '')


print('##### 进入「文本」模式 #####')
# 冷启动会回到登录页 —— 用测试钩子上账号（唯一非手指步骤）
for _ in range(70):
    if q("var s=document.querySelector('.splash'); if(!s) return true;"
        "var c=getComputedStyle(s);"
        "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
if q("return !!document.querySelector('.login.is-open');") is True:
    print('  (登录页 → 用测试钩子上账号)')
    q("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
      "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(2.5)

ok = enter_text_mode()
print('  is-text-mode = %s' % ok)
if not ok:
    raise SystemExit('进不了文本模式')

FAIL = []


def check(label, cond, detail=''):
    print('    %s %s%s' % ('OK  ' if cond else 'FAIL', label,
                           ('  ' + str(detail)) if detail else ''))
    if not cond:
        FAIL.append(label)


def find_block():
    """
    ⚠️ 必须挑**有文字层的那一页**上的块 ——
       文字层只在原生返回了文字行时才挂（mountTextLayer 里
       `if (!lines || !lines.length) return;`）。
       第 1 页（标题页）实测没有文字层 → 它的块点不到，
       而那不是本次要验的 bug（是另一件事：无文字层的页只能看不能标）。
       判据用 `slot.querySelector('.pdf-text-layer')`。
    """
    return json.loads(q("""
      var slots = document.querySelectorAll('.pdf-slot');
      var vh = innerHeight;
      for (var s = 0; s < slots.length; s++) {
        var L = slots[s].querySelector('.pdf-text-layer');
        if (!L) continue;
        var lr = L.getBoundingClientRect();
        var els = slots[s].querySelectorAll('.anno-block');
        for (var i = 0; i < els.length; i++) {
          var r = els[i].getBoundingClientRect();
          if (r.width < 40 || r.height < 5) continue;
          /*
            ⚠️ 只避开**顶部工具栏**（is-menu-open 时占 ~113px）与
               **底部编辑栏**（存在时占 ~90px）。余量给足一点，
               但不要像之前那样用 `vh-160`（视口 915 时只剩 755，
               把页 2 从 y=799 开始的块全排除了）。
          */
          var topGuard = 130;
          var bottomGuard = document.getElementById('reader-editbar') ? 120 : 20;
          if (r.top < topGuard || r.bottom > vh - bottomGuard) continue;
          var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          if (cy < lr.top || cy > lr.bottom) continue;
          if (cx < lr.left || cx > lr.right) continue;
          return JSON.stringify({x: cx, y: cy, w: r.width, h: r.height,
                                 page: slots[s].dataset.page,
                                 cls: els[i].className,
                                 line: els[i].getAttribute('data-block-line'),
                                 txt: (els[i].textContent || '').slice(0, 30)});
        }
      }
      return JSON.stringify({err: 1, vh: vh,
                             note: '没有屏内可见的块'});
    """))


print()
print('##### ① 轻点一个已存在的块 → 应弹「Edit」 #####')
close_all()
b = find_block()
if b.get('err'):
    print('  ✗ 找不到屏内可见的块: %s' % json.dumps(b, ensure_ascii=False))
    raise SystemExit('测试前置条件不满足')
print('  块 page=%s line=%s cls=%s  「%s」'
      % (b.get('page'), b.get('line'), b.get('cls'), b.get('txt')))
print('  块中心 @(%.0f,%.0f)  %.0f×%.0f' % (b['x'], b['y'], b['w'], b['h']))

before = q("return document.querySelectorAll('.anno-typesheet').length;")
tap(b['x'], b['y'], 1.6)
after = q("return document.querySelectorAll('.anno-typesheet').length;")
title = q("""
  var t = document.querySelector('.anno-typesheet .anno-typesheet-title');
  return t ? t.textContent : '';
""")
opts = q("""
  var o = document.querySelectorAll('.anno-typesheet .anno-typeopt');
  var a = [];
  for (var i = 0; i < o.length; i++) a.push((o[i].textContent||'').trim());
  return JSON.stringify(a);
""")
print('    sheet: %s → %s  标题「%s」' % (before, after, title))
print('    选项: %s' % opts)
check('轻点块弹出类型选择', after > 0, 'sheet=%d' % after)
check('标题是 Edit', title == 'Edit', title)
check('八类选项齐全', len(json.loads(opts) if opts else []) == 8,
      len(json.loads(opts) if opts else []))

print()
print('##### ② 在弹层里改类型为 Heading（Heading 会再问一级）#####')
if after > 0:
    cls_before = q("""
      var el = document.querySelector('.anno-block[data-block-line="%s"]');
      return el ? el.className : '';""" % b.get('line'))
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
        d = json.loads(r)
        tap(d['x'], d['y'], 1.8)
        '''
        ⚠️⚠️ 「章节标题」是**两步**：点 Heading 只是打开**层级**选择器
            （见 makeTextTypeOption 里 `if (type === 'heading')` 的分支，
             它 `return` 了，不会直接落笔）。
            所以这里必须**再点一次层级**，否则什么都改不了 ——
            我第一版测试就漏了这步，误判成"改类型没生效"。
        '''
        lv = q("""
          var cand = document.querySelectorAll('.anno-levelopt');
          var out = [];
          for (var i = 0; i < cand.length; i++) {
            out.push({lv: cand[i].getAttribute('data-level'),
                      txt: (cand[i].textContent || '').trim()});
          }
          return JSON.stringify({n: cand.length, labels: out,
            sheets: document.querySelectorAll('.anno-typesheet').length});
        """)
        print('    层级选择器: %s' % lv)
        lvd = json.loads(lv)
        if lvd['n'] > 0:
            r2 = q("""
              var cand = document.querySelectorAll('.anno-levelopt');
              var rc = cand[0].getBoundingClientRect();
              return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2,
                                     lv: cand[0].getAttribute('data-level')});
            """)
            d2 = json.loads(r2)
            print('    点 L%s @(%.0f,%.0f)' % (d2.get('lv'), d2['x'], d2['y']))
            tap(d2['x'], d2['y'], 2.0)

        cls_after = q("""
          var el = document.querySelector('.anno-block[data-block-line="%s"]');
          return el ? el.className : '';""" % b.get('line'))
        print('    class: %s' % cls_before)
        print('       →   %s' % cls_after)
        check('改类型后 class 变化', cls_before != cls_after,
              '%s -> %s' % (cls_before, cls_after))
        check('改成了 heading', 'heading' in (cls_after or ''), cls_after)
        check('弹层已关闭',
              q("return document.querySelectorAll('.anno-typesheet').length;") == 0)

print()
print('##### ③ 回归：长按 + 拖拽仍然是划选（不能被轻点逻辑抢走）#####')
close_all()
ln = json.loads(q("""
  var ls = document.querySelectorAll('.pdf-text-line');
  for (var i = 0; i < ls.length; i++) {
    var r = ls[i].getBoundingClientRect();
    if (r.width > 80 && r.top > 140 && r.bottom < innerHeight - 140) {
      return JSON.stringify({x: r.left + 10, y: r.top + r.height/2, r: r.right - 10});
    }
  }
  return JSON.stringify({err: 1});
"""))
cdp.touch('touchStart', [(ln['x'], ln['y'])])
time.sleep(0.55)
for i in range(1, 6):
    cdp.touch('touchMove', [(ln['x'] + (ln['r'] - ln['x']) * i / 5.0, ln['y'])])
    time.sleep(0.07)
cdp.touch('touchEnd', [])
time.sleep(1.5)
hl = q("return document.querySelectorAll('.pdf-text-line.is-selected').length;")
sh = q("return document.querySelectorAll('.anno-typesheet').length;")
title3 = q("""
  var t = document.querySelector('.anno-typesheet .anno-typesheet-title');
  return t ? t.textContent : '';
""")
print('    高亮=%s sheet=%s 标题「%s」' % (hl, sh, title3))
check('拖拽仍然划选', hl > 0, 'hl=%d' % hl)
check('拖拽弹出的是划选表单', sh > 0, 'sheet=%d' % sh)

print()
print('##### ④ 回归：快速轻点空白（不在任何块上）→ 不开弹层 #####')
close_all()
empty = json.loads(q("""
  var slots = document.querySelectorAll('.pdf-slot');
  for (var s = 0; s < slots.length; s++) {
    if (!slots[s].querySelector('.pdf-text-line')) continue;
    var sr = slots[s].getBoundingClientRect();
    for (var fy = 0.15; fy < 0.85; fy += 0.02) {
      var y = sr.top + sr.height * fy;
      var x = sr.left + sr.width * 0.06;
      if (y < 150 || y > innerHeight - 150) continue;
      var el = document.elementFromPoint(x, y);
      if (!el || el.className.indexOf('anno-block') >= 0) continue;
      var hitBlock = false;
      var blocks = slots[s].querySelectorAll('.anno-block');
      for (var i = 0; i < blocks.length; i++) {
        var br = blocks[i].getBoundingClientRect();
        if (x >= br.left && x <= br.right && y >= br.top && y <= br.bottom) {
          hitBlock = true; break;
        }
      }
      if (!hitBlock) return JSON.stringify({x: x, y: y});
    }
  }
  return JSON.stringify({err: 1});
"""))
if empty.get('err'):
    print('    (找不到块外空白，跳过)')
else:
    tap(empty['x'], empty['y'], 1.4)
    sh4 = q("return document.querySelectorAll('.anno-typesheet').length;")
    print('    空白处 @(%.0f,%.0f) → sheet=%s' % (empty['x'], empty['y'], sh4))
    check('空白轻点不开弹层', sh4 == 0, 'sheet=%d' % sh4)

print()
print('=' * 54)
if FAIL:
    print('FAIL %d 项:' % len(FAIL))
    for f in FAIL:
        print('   · ' + f)
else:
    print('OK 全部通过')
cdp.close()
