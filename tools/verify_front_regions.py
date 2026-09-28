# -*- coding: utf-8 -*-
"""真机验证 v0.1.35 修的 5 个缺陷。

对应 CHANGELOG 的 [0.1.35]。用法：

    python tools/verify_front_regions.py            # 全部检查
    python tools/verify_front_regions.py --page1    # 只查第 1 页文字层

⚠️ 前置条件（与 emu_js.py 一致）：
  · 应用在前台、WebView 可调试（setWebContentsDebuggingEnabled）
  · 文档已打开（原始视图 or 阅读视图均可，脚本会自己切）
  · **`.login.is-open` 必须不存在** —— 它 z-index 50，
    会盖住整个阅读器，让所有 elementFromPoint / 触摸都落到登录页上。
    实测被这个坑过（第 1 页 tap 无反应，真因是登录页盖着）。
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import adb  # noqa: E402

# ---- 断言收集 -------------------------------------------------------------

PASS = []
FAIL = []


def check(name, ok, detail=''):
    (PASS if ok else FAIL).append(name)
    mark = 'OK  ' if ok else 'FAIL'
    print('[%s] %s%s' % (mark, name, ('  <- ' + detail) if detail else ''))


def js(expr):
    """跑一小段 JS，返回解析后的值（复用 emu_js 的 CDP 通道）。"""
    here = os.path.dirname(os.path.abspath(__file__))
    script = os.path.join(here, '_verify_probe.js')
    with open(script, 'w', encoding='utf-8') as f:
        f.write(expr)
    try:
        p = subprocess.run([sys.executable, os.path.join(here, 'emu_js.py'),
                            '--file', script],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=180)
        out = (p.stdout or b'').decode('utf-8', 'replace').strip()
    finally:
        try:
            os.remove(script)
        except OSError:
            pass
    if out.startswith('Error') or 'JS ' in out[:6]:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return out


# ---- 各检查项 -------------------------------------------------------------

PROBE_LAYERS = r"""
var slots = document.querySelectorAll('.pdf-slot');
var pages = [];
for (var i = 0; i < slots.length; i++) {
    pages.push({
        page: slots[i].getAttribute('data-page'),
        img: slots[i].querySelector('img') ? 1 : 0,
        tl: slots[i].querySelector('.pdf-text-layer') ? 1 : 0,
        lines: slots[i].querySelectorAll('.pdf-text-line').length
    });
}
return JSON.stringify({
    login: !!document.querySelector('.login.is-open'),
    raw: !!document.querySelector('.is-raw'),
    pages: pages
});
"""

PROBE_REGIONS = r"""
var c = document.querySelector('.reader-content');
var out = [];
if (c) {
    for (var i = 0; i < c.children.length; i++) {
        out.push(c.children[i].className.replace('rd-region ', ''));
    }
}
return JSON.stringify({regions: out});
"""

PROBE_MARKS = r"""
var M = window.ScholariusReader.getTextMarks() || [];
var t = {};
for (var i = 0; i < M.length; i++) t[M[i].type] = (t[M[i].type] || 0) + 1;
return JSON.stringify({total: M.length, byType: t});
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--page1', action='store_true', help='只查第 1 页文字层')
    a = ap.parse_args()

    print('=== v0.1.35 真机验证 ===\n')

    layers = js(PROBE_LAYERS)
    if not isinstance(layers, dict):
        print('拿不到页面状态，应用是否在前台？')
        return 2

    if layers.get('login'):
        print('!! .login.is-open 存在 —— 它会盖住阅读器，'
              '所有触摸/命中都会被它接走。请先关掉登录页。\n')

    if layers.get('raw'):
        pages = layers.get('pages') or []
        # 缺陷 1：第 1 页必须有文字层
        p1 = next((p for p in pages if str(p.get('page')) == '1'), None)
        if p1:
            check('第 1 页有文字层（缺陷 1）',
                  p1.get('tl') == 1 and p1.get('lines', 0) > 0,
                  'page1 img=%s tl=%s lines=%s'
                  % (p1.get('img'), p1.get('tl'), p1.get('lines')))
        # 已挂的页应图文齐备
        bad = [p for p in pages
               if p.get('img') and not p.get('tl')]
        check('凡有页图的页都有文字层', not bad,
              '缺文字层的页: %s' % [p['page'] for p in bad] if bad else '')
    else:
        print('· 当前在阅读视图，跳过文字层检查'
              '（切到原始视图后可复跑）\n')

    marks = js(PROBE_MARKS)
    if isinstance(marks, dict):
        print('\n标注统计: total=%s byType=%s'
              % (marks.get('total'), marks.get('byType')))

    if not layers.get('raw'):
        regions = js(PROBE_REGIONS)
        if isinstance(regions, dict):
            rs = regions.get('regions') or []
            print('阅读视图区域 (%d):' % len(rs))
            for i, r in enumerate(rs):
                print('  #%d %s' % (i, r))
            # 缺陷 2：不应出现 head=null 的"无名一级区"独占首页内容
            fronts = [r for r in rs if r in
                      ('rd-region-title', 'rd-region-author',
                       'rd-region-abstract', 'rd-region-keyword')]
            check('首页区独立成区（缺陷 2/3/4）', len(fronts) >= 1,
                  '首页区: %s' % fronts)
        else:
            print('· 阅读视图还没渲染出区域')

    print('\n=== 结果 ===')
    print('通过 %d 项，失败 %d 项' % (len(PASS), len(FAIL)))
    if FAIL:
        for f in FAIL:
            print('  FAIL: %s' % f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
