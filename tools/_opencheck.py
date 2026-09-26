# -*- coding: utf-8 -*-
"""打开文献，看 PDF 提取是否成功 + 划选是否高亮。只做诊断。"""
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
ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


DPR = js('return window.devicePixelRatio')
pp = lambda v: str(int(round(v * DPR)))  # noqa: E731


def tap(x, y, wait=1.5):
    adb('shell', 'input', 'tap', pp(x), pp(y))
    time.sleep(wait)


print('=== 确保启动页已结束 ===')
for _ in range(60):
    if js("var s=document.querySelector('.splash'); if(!s) return true;"
          "var c=getComputedStyle(s);"
          "return c.display==='none'||s.hidden===true;") is True:
        break
    time.sleep(0.4)
print('  splash done')

print('=== 登录页状态（真实冷启动是有的）===')
print('  登录页在: %s' % js("return !!document.querySelector('.login.is-open');"))
if js("return !!document.querySelector('.login.is-open');") is True:
    print('  用真实手指点「Sign in with GitHub」')
    # 先试直接点它（走真实 hit-test）
    b = js("""
        var l = document.querySelector('.login');
        var bs = l.querySelectorAll('button,a,.btn');
        for (var i = 0; i < bs.length; i++) {
            if ((bs[i].textContent || '').indexOf('GitHub') >= 0) {
                var r = bs[i].getBoundingClientRect();
                return JSON.stringify({ x: r.left + r.width / 2,
                                        y: r.top + r.height / 2,
                                        hit: (function () {
                    var h = document.elementFromPoint(
                        r.left + r.width / 2, r.top + r.height / 2);
                    return h ? (h.tagName + '.' + (typeof h.className === 'string'
                          ? h.className.split(' ')[0] : '')) : 'null';
                })() });
            }
        }
        return null;
    """)
    print('    ' + str(b))
    bp = json.loads(b)
    tap(bp['x'], bp['y'], 2.0)
    print('    点后登录页在: %s'
          % js("return !!document.querySelector('.login.is-open');"))
    # 若弹了授权页，点「继续/授权」。这里真实环境走 OAuth；
    # 测试环境下如果仍是登录页，就直接用 setAccount 兜底并**明确标注**
    print('    点后 root: %s'
          % js("var r=document.getElementById('root'); return r?r.className:'-';"))

print('=== 打开文献卡片 ===')
info = js("""
    var c = document.querySelector('.doc-card');
    if (!c) return null;
    var r = c.getBoundingClientRect();
    var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2,
        hit: hit ? (hit.tagName + '.' + (typeof hit.className === 'string'
              ? hit.className.split(' ')[0] : '')) : 'null' });
""")
print('  ' + str(info))
p = json.loads(info)
tap(p['x'], p['y'], 5)

print()
print('=== 阅读页状态 ===')
for _ in range(30):
    n = js("return (window.ScholariusReader && window.ScholariusReader.getBlocks)"
           " ? (window.ScholariusReader.getBlocks()||[]).length : -1")
    if n and n > 0:
        break
    time.sleep(1)
print('  blocks 数 = %s' % js("""
    var r = window.ScholariusReader;
    return (r && r.getBlocks) ? (r.getBlocks() || []).length : 'no api';
"""))
print('  文字层词数 = %s'
      % js("return document.querySelectorAll('.pdf-text-line').length;"))
print('  root = %s' % js("var r=document.getElementById('root'); return r?r.className:'-';"))
cdp.close()
