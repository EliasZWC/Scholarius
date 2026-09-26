# -*- coding: utf-8 -*-
"""用户问题 3 的正式验证：**全新状态**下走一遍，判断标题是否正确。

判据（从"用户能看到什么"出发）：
  ✅ 真标题被渲染成标题：`1 Introduction` / `3.2 Attention` /
     `3.2.2 Multi-Head Attention` / `5.4 Regularization` / `9 References`
  ✅ 正文段落**不该**被渲染成标题：
     `Recurrent models typically factor...`
     `The dominant sequence transduction models...`
     `1019 1.4·1020`（表格行）

流程（真手指；只有登录用测试钩子；先清场再开文献）：
  ① force-stop 冷启动 → 登录钩子
  ② 开文献 → 默认进阅读视图
  ③ 直接读渲染结果（阅读视图是默认视图，不用切）
"""
import io
import json
import os
import re
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


print('##### 冷启动 #####')
adb('logcat', '-c')
time.sleep(0.4)
adb('shell', 'am', 'force-stop', PKG)
time.sleep(1.2)
adb('shell', 'am', 'start', '-n', '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
time.sleep(11)
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def q(e):
    return cdp.evaluate(e)


for _ in range(70):
    if q("var s=document.querySelector('.splash'); if(!s) return true;"
         "var c=getComputedStyle(s); return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)

if q("return !!document.querySelector('.login.is-open');") is True:
    print('  (登录页 → 测试钩子上账号)')
    q("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
      "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(2.5)

print('##### 开文献（默认进阅读视图）#####')
r = q("""
  var c = document.querySelector('.doc-card');
  if (!c) return 'null';
  var rc = c.getBoundingClientRect();
  return JSON.stringify({x: rc.left + rc.width/2, y: rc.top + rc.height/2});
""")
if r and r != 'null':
    d = json.loads(r)
    tap(cdp, d['x'], d['y'], 8.0)

for _ in range(90):
    if q("return document.querySelectorAll('.rd-region, .reader-heading').length;") > 0:
        break
    time.sleep(0.5)
time.sleep(2.5)

print('  reader 类: %s' % q("var r=document.getElementById('reader');"
                            "return r ? r.className : '';"))
print('  区域数  : %s' % q("return document.querySelectorAll('.rd-region').length;"))
print('  标题数  : %s' % q("return document.querySelectorAll('.reader-heading').length;"))

print()
print('##### 所有标题（这是用户看到的）#####')
heads = json.loads(q("""
  var hs = document.querySelectorAll('.reader-heading');
  var a = [];
  for (var i = 0; i < hs.length; i++) {
    a.push({tag: hs[i].tagName,
            txt: (hs[i].textContent||'').replace(/\\s+/g,' ').trim().slice(0, 52)});
  }
  return JSON.stringify(a);
"""))
for h in heads:
    print('  %-3s 「%s」' % (h['tag'], h['txt']))

print()
print('##### 判据核对 #####')
SHOULD_BE_HEADING = [
    '1 Introduction', '3.2 Attention', '3.2.2 Multi-Head Attention',
    '5.4 Regularization', '9 References',
]
'''
⚠️⚠️ `Abstract` **不在**这个列表里 —— 我第一版放错了。

原因（`guessKind` 的 JS 侧判据，见 reader.js）：
    if (/^(abstract|摘要)(\\s|$|[:：—–-])/i.test(txt)) return 'abstract';
`Abstract` 被专门识别成**「摘要区」**，不是「标题」——
这是用户明确要的版面分区（首页区：标题 / 作者 / 摘要 / 关键词，
各成一块）。它渲染成 `rd-region-abstract`，与 heading 是**并列**的类型，
不是"漏判的标题"。

我把它放进 SHOULD_BE_HEADING 是**测试写错了**，
不是代码错 —— 于是得到一个假的 MISS。
现在改成单独断言"摘要区存在"。
'''
SHOULD_BE_ABSTRACT = ['Abstract']

SHOULD_NOT_BE = [
    'Recurrent models typically factor',
    'The dominant sequence transduction',
    'states ht',
    'The Transformer follows this overall',
    'connected layers for both',
    '1019 1.4',
    'The third is the path length',
    'dependencies is a key challenge',
    'ability to learn such dependencies',
]
texts = [h['txt'] for h in heads]
FAIL = []

print('  ── 应被识别为标题 ──')
for want in SHOULD_BE_HEADING:
    ok = any(want in t for t in texts)
    print('    %s %s' % ('OK  ' if ok else 'MISS', want))
    if not ok:
        FAIL.append('漏判标题: ' + want)

print('  ── 摘要区（与标题并列，不是标题）──')
abs_txt = q("""
  var r = document.querySelector('.rd-region-abstract, .reader-abstract');
  return r ? (r.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 60) : '';
""")
for want in SHOULD_BE_ABSTRACT:
    ok = want in (abs_txt or '')
    print('    %s 摘要区含「%s」%s' % ('OK  ' if ok else 'MISS', want,
                                      '' if ok else '  （实际: %s）' % (abs_txt or '(无摘要区)')))
    if not ok:
        FAIL.append('摘要区未渲染: ' + want)

print('  ── 不该被当成标题（误判 = 正文被放大成标题）──')
for bad in SHOULD_NOT_BE:
    hits = [t for t in texts if bad in t]
    ok = not hits
    print('    %s %s%s' % ('OK  ' if ok else 'BAD ', bad,
                           '' if ok else '  → 实际渲染为标题'))
    if not ok:
        FAIL.append('误判正文为标题: ' + bad)

print()
print('  ── 判据日志（Kotlin 侧）──')
out = adb('logcat', '-d')
txt = (out.stdout or b'').decode('utf-8', 'replace')
acc = [l for l in txt.splitlines() if 'heading-by-style' in l]
rej = [l for l in txt.splitlines() if 'heading-rejected-by-prose' in l]
print('    heading-by-style      : %d 条（期望 0 —— 全被 prose 拦下）' % len(acc))
print('    rejected-by-prose     : %d 条' % len(rej))

print()
print('=' * 56)
if FAIL:
    print('FAIL %d 项:' % len(FAIL))
    for f in FAIL:
        print('   · ' + f)
else:
    print('OK 全部通过')
cdp.close()
