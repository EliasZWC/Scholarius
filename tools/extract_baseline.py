# -*- coding: utf-8 -*-
"""提取层基线快照 —— 改 mergeParagraphs 前后各跑一次，比对有无回归。

指标（都从真机 WebView 直接取，不看源码）：
  · 块数、文本长度中位/分布、碎片率
  · kind 分布（heading / paragraph / formula）
  · 目录条数
  · 「视觉段落」数（按 y 聚类后相邻块的合并数）
  · 每页块数

用法：
    python tools/extract_baseline.py before
    python tools/extract_baseline.py after
两份都存在 tools/_baseline/<name>.json，便于 diff。
"""
import io
import json
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_baseline')
os.makedirs(OUT, exist_ok=True)

name = (sys.argv[1] if len(sys.argv) > 1 else 'before').strip()

ensure_ready()
cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])


def js(c):
    return cdp.evaluate(c)


data = json.loads(js("""
    var r = window.ScholariusReader;
    if (!r) return 'null';
    var b = r.getBlocks() || [];
    if (!b.length) return JSON.stringify({ empty: true });

    /* 长度 */
    var lens = b.map(function (x) { return (x.text || '').length; })
                .sort(function (a, c) { return a - c; });
    function pct(p) { return lens[Math.floor((lens.length - 1) * p)]; }

    /* kind 分布 */
    var kind = {};
    for (var i = 0; i < b.length; i++) {
        kind[b[i].kind] = (kind[b[i].kind] || 0) + 1;
    }

    /* 每页块数 */
    var perPage = {};
    for (var j = 0; j < b.length; j++) {
        perPage[b[j].page] = (perPage[b[j].page] || 0) + 1;
    }

    /* 「视觉段落」数：同一页里 y0 相同（或极近）的连续块算一段 */
    var visPara = 0;
    var prev = null;
    for (var k = 0; k < b.length; k++) {
        var cur = b[k];
        if (!prev) { visPara = 1; prev = cur; continue; }
        if (cur.page !== prev.page) { visPara++; prev = cur; continue; }
        if (Math.abs(cur.y0 - prev.y0) > 0.004) visPara++;
        prev = cur;
    }

    /* 碎片率：文本 <= 20 字 */
    var frag = lens.filter(function (L) { return L <= 20; }).length;

    /* 目录 */
    var toc = r.getToc ? (r.getToc() || []) : [];

    return JSON.stringify({
        blocks: b.length,
        kind: kind,
        perPage: perPage,
        len: { min: lens[0], p25: pct(0.25), median: pct(0.5),
               p75: pct(0.75), max: lens[lens.length - 1] },
        frag20: frag,
        fragRate: Math.round(frag * 1000 / b.length) / 10,
        visPara: visPara,
        toc: toc.length,
        textLen: (r.getTextLines ? (r.getTextLines() || []).length : -1)
    });
"""))

if data.get('empty'):
    print('⚠️ 没有块 —— 应用是否已打开文献？')
    raise SystemExit(1)

path = os.path.join(OUT, name + '.json')
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print('=== %s ===' % name)
print('  块数            : %d' % data['blocks'])
print('  文本行数        : %s' % data['textLen'])
print('  长度 中位/75%%    : %d / %d' % (data['len']['median'], data['len']['p75']))
print('  长度 最大       : %d' % data['len']['max'])
print('  碎片率(<=20字)  : %s%%  (%d 个)' % (data['fragRate'], data['frag20']))
print('  视觉段落数      : %d' % data['visPara'])
print('  kind 分布       : %s' % json.dumps(data['kind'], ensure_ascii=False))
print('  目录条数        : %d' % data['toc'])
print('  每页块数        : %s'
      % json.dumps(data['perPage'], ensure_ascii=False))
print()
print('保存: %s' % path)
cdp.close()
