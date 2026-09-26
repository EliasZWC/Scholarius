# -*- coding: utf-8 -*-
"""进「文本」模式后，DOM 里到底有什么 —— 不猜。"""
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

ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


DPR = js('return window.devicePixelRatio')
pp = lambda v: str(int(round(v * DPR)))  # noqa: E731


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


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
        print('    ✗ 找不到 %s' % label)
        return None
    d = json.loads(info)
    print('    👆 %s @(%.0f,%.0f)' % (label, d['x'], d['y']))
    tap(d['x'], d['y'], wait)
    return d


def dump(tag):
    print()
    print('  ── %s ──' % tag)
    print(js("""
        var out = [];
        var rd = document.getElementById('reader');
        out.push('    reader: ' + (rd ? rd.className : '-'));
        var names = ['.pdf-scroll', '.pdf-slot', '.pdf-page-img',
                     '.pdf-text-layer', '.pdf-text-line',
                     '.anno-block', '.anno-layer', '.reader-content'];
        for (var i = 0; i < names.length; i++) {
            out.push('    ' + names[i] + ' = '
                     + document.querySelectorAll(names[i]).length);
        }
        var c = document.querySelector('.reader-content, #reader-content');
        if (c) {
            out.push('    reader-content 前 70 字: 「'
                     + (c.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 70) + '」');
        }
        /* 视口里可见的"块"类元素 */
        var all = document.querySelectorAll('*');
        var vis = {};
        for (var j = 0; j < all.length; j++) {
            var r = all[j].getBoundingClientRect();
            if (r.width < 30 || r.height < 6) continue;
            if (r.bottom < 100 || r.top > window.innerHeight - 90) continue;
            var k = all[j].tagName + '.' + (typeof all[j].className === 'string'
                ? all[j].className.split(' ').slice(0, 2).join('.') : '');
            vis[k] = (vis[k] || 0) + 1;
        }
        var ks = Object.keys(vis).sort(function (a, b) { return vis[b] - vis[a]; });
        out.push('    视口内可见元素（前 12 类）:');
        for (var m = 0; m < Math.min(12, ks.length); m++) {
            out.push('      ' + ks[m] + ' × ' + vis[ks[m]]);
        }
        return out.join('\\n');
    """))


print('##### 冷启动 → 文献 → 视图切换 #####')
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
if js("return !!document.querySelector('.login.is-open');") is True:
    js("if(window.ScholariusShell&&window.ScholariusShell.setAccount){"
       "window.ScholariusShell.setAccount(true,'eliaszwc','E','','t');} return 1")
    time.sleep(2.5)

tap_el("document.querySelector('.doc-card')", 5.0, '文献卡片')
if js("return document.getElementById('reader').classList.contains('is-menu-open')") is not True:
    vw = js('return [innerWidth, innerHeight]')
    tap(vw[0] / 2, vw[1] * 0.42, 2.0)
dump('打开文献后')

print()
print('##### 点「视图切换」（眼睛）#####')
tap_el("document.getElementById('reader-view-toggle')", 5.0, '视图切换')
for _ in range(60):
    if js("return document.querySelectorAll('.pdf-text-line').length") > 0:
        break
    time.sleep(0.5)
dump('切到原始视图后')

print()
print('##### 点「编辑」（铅笔）#####')
tap_el("document.getElementById('reader-annotate')", 3.0, '编辑按钮')
dump('进编辑模式后')

print()
print('##### 点底栏「文本」#####')
tap_el("""(function () {
    var o = document.querySelectorAll('.reader-edit-tab, .reader-panel-tab');
    for (var i = 0; i < o.length; i++) {
        var t = (o[i].textContent || '');
        if (t.indexOf('文本') >= 0 || t.toLowerCase().indexOf('text') >= 0) return o[i];
    }
    return null;
})()""", 3.0, '「文本」选项')
dump('点「文本」后')
cdp.close()
