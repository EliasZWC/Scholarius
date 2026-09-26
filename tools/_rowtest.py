# -*- coding: utf-8 -*-
"""直接测 rowsToGlobalFrom 的返回值 —— 不再推理。

用户问题③：「选中的地方一点其他区域就没了」+「似乎跳到了最开头」。
实测落笔结果 from:0, to:0。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


print('=== 冷启动 → 编辑 → 文本 ===')
print(js("""
    (function () {
        var r = window.ScholariusReader;
        if (!r) return 'no reader';
        /* 直接跳到原始视图 + 编辑 + 文本（跳过登录页，纯为定位问题） */
        r.open({ id: 'devtest1', title: 'x', pages: 11 });
        return 'opened';
    })()
"""))
time.sleep(3)
print(js("var r=document.getElementById('root'); return r?r.className:'no root';"))

print(js("""
    (function () {
        var r = window.ScholariusReader;
        r.setView && r.setView('raw');
        return 'view=raw';
    })()
"""))
time.sleep(2)

print(js("""
    (function () {
        var btn = document.querySelector('.reader-edit-btn, [data-act=\"annotate\"]');
        if (btn) btn.click();
        return btn ? 'clicked' : 'no edit button';
    })()
"""))
time.sleep(1)
print('  root=' + js("var r=document.getElementById('root'); return r?r.className:'-';"))

print(js("""
    (function () {
        var o = document.querySelector('.anno-opt[data-mode=\"text\"], .anno-mode-text');
        if (o) o.click();
        return o ? 'text mode on' : 'no text option';
    })()
"""))
time.sleep(1)
print('  root=' + js("var r=document.getElementById('root'); return r?r.className:'-';"))

print()
print('=== ① 先看文字层与 data-row ===')
print(js("""
    var out = [];
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    out.push('  词总数: ' + ls.length);
    var byRow = {};
    for (var i = 0; i < ls.length; i++) {
        var k = ls[i].dataset.row;
        if (!byRow[k]) byRow[k] = [];
        byRow[k].push(ls[i]);
    }
    var ks = Object.keys(byRow).sort(function (a, b) { return a - b; });
    for (var j = 0; j < Math.min(ks.length, 12); j++) {
        var w = byRow[ks[j]];
        out.push('  data-row=' + ks[j] + ' 词数=' + w.length
                 + ' 「' + (w.map(function (e) { return e.textContent; }).join(' ')).slice(0, 40) + '」');
    }
    return out.join('\\n');
"""))

print()
print('=== ② 取一个中间的 row，手工调用 rowsToGlobalFrom ===')
# rowsToGlobalFrom 是闭包内私有函数，测不到 —— 改为直接看数据关系
print(js("""
    var out = [];
    var r = window.ScholariusReader;
    var b = (r && r.getBlocks) ? r.getBlocks() : null;
    if (!b) return '  no blocks';
    out.push('  blocks 总数: ' + b.length);
    /* 看前 10 个块的 line 与文本，以及 page */
    var shown = 0;
    for (var i = 0; i < b.length && shown < 12; i++) {
        if (b[i].line == null) continue;
        out.push('  #' + i + ' line=' + b[i].line + ' page=' + b[i].page
                 + ' kind=' + b[i].kind
                 + ' 「' + (b[i].text || '').replace(/\\n/g, '⏎').slice(0, 34) + '」');
        shown++;
    }
    return out.join('\\n');
"""))

print()
print('=== ④ 在 row=5 上真手指横拖，看落笔 map ===')
info = json.loads(js("""
    var ls = document.querySelectorAll('.pdf-text-layer .pdf-text-line');
    var target = null;
    for (var i = 0; i < ls.length; i++) {
        if (parseInt(ls[i].dataset.row, 10) === 5) { target = ls[i]; break; }
    }
    if (!target) return 'null';
    var r = target.getBoundingClientRect();
    return JSON.stringify({ row: target.dataset.row, text: target.textContent,
        l: r.left, t: r.top, r: r.right, b: r.bottom });
"""))
print('  row=5 的词: 「%s」 rect=[%d,%d,%d,%d]'
      % (info['text'], info['l'], info['t'], info['r'], info['b']))

y = (info['t'] + info['b']) / 2
x0 = info['l'] + 2
x1 = info['r'] - 2
print('  横拖 (%d,%d) → (%d,%d)' % (x0, y, x1, y))

cdp.touch('touchStart', [(x0, y)])
time.sleep(0.05)
for i in range(1, 9):
    cdp.touch('touchMove', [(x0 + (x1 - x0) * i / 8.0, y)])
    time.sleep(0.02)
cdp.touch('touchEnd', [])
time.sleep(1.0)

print()
print('  划选后状态:')
print(js("""
    var out = [];
    var sel = document.querySelectorAll('.pdf-text-line.is-selected');
    out.push('    高亮词数: ' + sel.length);
    out.push('    高亮内容: 「' + Array.prototype.map.call(sel, function (s) {
        return s.textContent;
    }).join(' ').slice(0, 60) + '」');
    out.push('    高亮词的 data-row: '
             + Array.prototype.map.call(sel, function (s) {
                   return s.dataset.row;
               }).join(','));
    var sh = document.querySelector('.anno-typesheet');
    out.push('    类型弹层: ' + (sh ? '在' : '不在'));
    if (sh) {
        out.push('    弹层选项: ' + Array.prototype.map.call(
            sh.querySelectorAll('.anno-typeopt'), function (o) {
                return o.textContent;
            }).join(' / '));
    }
    return out.join('\\n');
"""))

print()
print('  落笔「作者」...')
r = js("""
    var sh = document.querySelector('.anno-typesheet');
    if (!sh) return 'no sheet';
    var opts = sh.querySelectorAll('.anno-typeopt');
    for (var i = 0; i < opts.length; i++) {
        if (opts[i].textContent.trim() === 'Author') { opts[i].click(); return 'clicked'; }
    }
    return 'no author opt';
""")
print('    ' + str(r))
time.sleep(1.0)

print(js("""
    var out = [];
    var r = window.ScholariusReader;
    var m = r.getTextMarks();
    var nb = m.filter(function (x) { return x.type !== 'body'; });
    out.push('    非 body 标注 ' + nb.length + ' 条:');
    nb.forEach(function (x) {
        out.push('      ' + JSON.stringify(x));
    });
    /* 高亮这个词应该在哪个全局行？直接算：前 5 个块的文本行数累加 */
    var b = r.getBlocks();
    var row = 0, want = null;
    for (var i = 0; i < b.length; i++) {
        var n = (b[i].text || '').split('\\n').length;
        out.push('      #' + i + ' page=' + b[i].page + ' line=' + b[i].line
                 + '..' + (b[i].line + n - 1)
                 + ' 「' + (b[i].text || '').replace(/\\n/g, '⏎').slice(0, 26) + '」');
        if (i >= 9) break;
    }
    return out.join('\\n');
"""))
cdp.close()
