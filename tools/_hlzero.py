# -*- coding: utf-8 -*-
"""为什么高亮=0？逐步观察划选时发生的一切。"""
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


DPR = js('return window.devicePixelRatio')
print('DPR=%s' % DPR)


def adb(*a):
    return subprocess.run([ADB] + list(a), capture_output=True, text=True)


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
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    """ % expr)
    if not info or info == 'null':
        raise SystemExit('✗ 找不到 %s' % label)
    p = json.loads(info)
    hit = js("""
        var e = document.elementFromPoint(%.1f, %.1f);
        return e ? (e.tagName + '.' + (typeof e.className === 'string'
                    ? e.className.split(' ')[0] : '')) : 'null';
    """ % (p['x'], p['y']))
    print('    👆 %s @(%.0f,%.0f) 命中=%s' % (label, p['x'], p['y'], hit))
    tap(p['x'], p['y'], wait)
    return p


def swipe(x0, y0, x1, y1, ms=900, steps=12):
    """用 adb 的物理像素拖拽 —— 与用户手指同一条路径。"""
    adb('shell', 'input', 'swipe', pp(x0), pp(y0), pp(x1), pp(y1), str(ms))


print()
print('=== 导航到 编辑 + 「文本」模式 ===')
root = js("var r=document.getElementById('root'); return r?r.className:'';")
if 'reader' not in (root or ''):
    print('  先打开文献')
    try:
        tap_el("""(function () {
            var c = document.querySelector('.doc-card') ||
                    document.querySelector('[data-doc-id]') ||
                    document.querySelector('.doc-item');
            return c;
        })()""", 3.5, '文献卡片')
    except SystemExit as e:
        # 兜底：直接调 API（只为定位问题，不是验收）
        print('  ' + str(e) + ' → 用 API 兜底')
        js("window.ScholariusReader.open({id:'devtest1',title:'x',pages:11}); return 1")
        time.sleep(3)

root = js("var r=document.getElementById('root'); return r?r.className:'';")
print('  root=%s' % root)

if 'is-raw' not in (root or ''):
    print('  切原始视图')
    try:
        tap_el("""document.querySelector('.reader-view-toggle') ||
                  document.querySelector('[data-act="view"]')""", 2.5, '视图切换')
    except SystemExit:
        js("window.ScholariusReader.setView('raw'); return 1")
        time.sleep(2.5)

root = js("var r=document.getElementById('root'); return r?r.className:'';")
if 'is-annotating' not in (root or ''):
    print('  进编辑模式')
    try:
        tap_el("""document.querySelector('.reader-edit-btn') ||
                  document.querySelector('[data-act="annotate"]')""", 1.8, '编辑按钮')
    except SystemExit:
        print('    找不到编辑按钮，用 API')
        js("window.ScholariusReader.setAnnotating(true); return 1")
        time.sleep(1.5)

root = js("var r=document.getElementById('root'); return r?r.className:'';")
if 'is-text-mode' not in (root or ''):
    print('  点「文本」选项')
    tap_el("""(function () {
        var o = document.querySelectorAll('.anno-mode-opt, .anno-opt');
        for (var i = 0; i < o.length; i++) {
            var t = (o[i].textContent || '');
            if (t.indexOf('文本') >= 0 || t.toLowerCase().indexOf('text') >= 0) return o[i];
        }
        return null;
    })()""", 1.8, '「文本」选项')

root = js("var r=document.getElementById('root'); return r?r.className:'';")
print('  root=%s' % root)
print('  词数=%s' % js("return document.querySelectorAll('.pdf-text-layer .pdf-text-line').length;"))

print()
print('=== 挂错误拦截：让 JS 异常暴露出来 ===')
print(js("""
    if (!window.__errs) {
        window.__errs = [];
        window.addEventListener('error', function (e) {
            window.__errs.push(String(e.message) + ' @' + e.lineno);
        });
    }
    return 'ok';
"""))

print()
print('=== 找一条可用行 ===')
rows = json.loads(js("""
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    var vh = window.innerHeight;
    var out = [];
    for (var i = 0; i < ls.length && out.length < 3; i++) {
        var r = ls[i].getBoundingClientRect();
        if (r.top < 120 || r.bottom > vh - 100) continue;
        if (r.width < 30 || r.height < 3) continue;
        out.push({ x: r.left, y: r.top, w: r.width, h: r.height,
                   t: ls[i].textContent, row: ls[i].dataset.row,
                   top: ls[i].style.top });
    }
    return JSON.stringify(out);
"""))
for r in rows:
    print('  row=%s top=%s 「%s」 rect=[%d,%d,%d,%d]'
          % (r['row'], r['top'], r['t'][:20], r['x'], r['y'], r['w'], r['h']))

if not rows:
    raise SystemExit('没有可用行')

row = rows[0]
sx = row['x'] + 10
sy = row['y'] + row['h'] / 2

print()
print('=== 划选前：目标点上是谁 ===')
print(js("""
    var e = document.elementFromPoint(%.1f, %.1f);
    return e ? (e.tagName + '.' + (typeof e.className === 'string' ? e.className : '')) : 'null';
""" % (sx, sy)))

print()
print('=== 真手指横拖 %.0f,%.0f → %.0f,%.0f ===' % (sx, sy, sx + 120, sy))
swipe(sx, sy, sx + 120, sy, 900)
time.sleep(1.5)

print()
print('=== 拖完后的状态 ===')
print(js("""
    var out = [];
    var sel = document.querySelectorAll('.pdf-text-line.is-selected');
    out.push('  高亮词数: ' + sel.length);
    out.push('  高亮内容: 「' + Array.prototype.map.call(sel, function (s) {
        return s.textContent; }).join(' ').slice(0, 70) + '」');
    var sh = document.querySelector('.anno-typesheet');
    out.push('  类型弹层: ' + (sh ? '在' : '不在'));
    var s = getSelection();
    out.push('  浏览器选区: len=' + (s ? String(s).length : '-'));
    out.push('  捕获的 JS 异常: ' + JSON.stringify(window.__errs || []));
    return out.join('\\n');
"""))
cdp.close()
