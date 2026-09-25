# -*- coding: utf-8 -*-
"""验证：「再清除 → 回到原生乱框」的真因。

推理（待验证）：
  clearTextMarksByType(null) 的第 1 步会丢掉**全部** textMarks，
  其中包括上一轮"把原生非 body 块显式标成 body"的那些覆盖标注。
  覆盖标注一丢，effectiveTypeAt 退回原生判定 → 乱框全部复活。

验证方式：
  1. 记录初始状态（原生判定的 block 类型分布）
  2. 清除一次 → 记录
  3. 再清除一次 → 记录
  4. 对比 2 与 3：如果 3 的类型分布 == 1 的分布，则推理成立
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

STATE_JS = """
var l = document.querySelector('.anno-layer');
if (!l) return { err: 'no layer' };
var bs = l.querySelectorAll('.anno-block');
var counts = {}, visCounts = {};
var rows = [];
for (var i = 0; i < bs.length; i++) {
    var b = bs[i];
    var t = b.getAttribute('data-text-type') || '?';
    var lv = b.getAttribute('data-text-level') || '0';
    var tg = b.querySelector('.anno-block-tag');
    var vis = tg && getComputedStyle(tg).display !== 'none';
    var key = t + (lv !== '0' ? '/L' + lv : '');
    counts[key] = (counts[key] || 0) + 1;
    if (vis) visCounts[key] = (visCounts[key] || 0) + 1;
    rows.push({ line: b.getAttribute('data-block-line'), type: key, visible: !!vis });
}
return { total: bs.length, counts: counts, visibleCounts: visCounts, rows: rows };
"""


def snap(cdp, label):
    d = cdp.evaluate(STATE_JS)
    if d.get('err'):
        print('\n--- %s --- %s' % (label, d['err']))
        return d
    print('\n--- %s --- 共 %d 块' % (label, d['total']))
    print('    全部类型分布     : %s' % json.dumps(d['counts'], ensure_ascii=False))
    print('    **可见**框类型分布: %s' % json.dumps(d['visibleCounts'], ensure_ascii=False))
    return d


def tap(cdp, x, y, wait=0.7):
    cdp.touch('touchStart', [(x, y)])
    time.sleep(0.05)
    cdp.touch('touchEnd', [])
    time.sleep(wait)


def tap_sel(cdp, sel, wait=0.7):
    b = cdp.evaluate("""
        var e = document.querySelector(%s);
        if (!e) return null;
        var r = e.getBoundingClientRect();
        return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
    """ % json.dumps(sel))
    if not b:
        return None
    tap(cdp, b[0], b[1], wait)
    return b


def clear_all(cdp):
    """点清空 FAB → 确认。"""
    b = tap_sel(cdp, '.anno-fab', 0.7)
    if not b:
        return 'no-fab'
    # 确认表单
    conf = cdp.evaluate("""
        var out = [];
        var bs = document.querySelectorAll('.sheet button, .form-actions button');
        for (var i = 0; i < bs.length; i++) {
            var r = bs[i].getBoundingClientRect();
            if (!r.width) continue;
            out.push({ text: (bs[i].textContent || '').trim(),
                       cls: bs[i].className,
                       cx: Math.round(r.left + r.width/2),
                       cy: Math.round(r.top + r.height/2) });
        }
        return out;
    """)
    print('    确认弹层按钮：%s' % json.dumps(conf, ensure_ascii=False))
    target = None
    for x in (conf or []):
        if 'primary' in x['cls'] or 'danger' in x['cls']:
            target = x
            break
    if not target:
        return {'tip': cdp.evaluate("""
            var t = document.querySelector('.anno-tip');
            return t ? t.textContent : null;
        """)}
    tap(cdp, target['cx'], target['cy'], 0.9)
    return 'confirmed'


def main():
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        for _ in range(40):
            if cdp.evaluate("return !!document.getElementById('reader')") is True:
                break
            time.sleep(0.4)
        for _ in range(40):
            v = cdp.evaluate("""
                var s = document.querySelector('.splash');
                if (!s) return true;
                var cs = getComputedStyle(s);
                return cs.display === 'none' || cs.opacity === '0' || s.hidden === true;
            """)
            if v:
                break
            time.sleep(0.4)
        cdp.evaluate("""
            if (window.ScholariusShell && window.ScholariusShell.setAccount &&
                !window.__fakeSignedIn) {
                window.ScholariusShell.setAccount(true, 'eliaszwc', 'EliasZWC',
                    '', 'test-account-id');
                window.__fakeSignedIn = true;
            }
            return 1;
        """)
        time.sleep(0.4)
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-open')") is not True:
            tap_sel(cdp, '.doc-card', 1.0)
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-menu-open')") is not True:
            vp = cdp.evaluate('return [window.innerWidth, window.innerHeight]')
            tap(cdp, vp[0] // 2, vp[1] // 2, 0.6)
        if cdp.evaluate("return !!document.querySelector('.pdf-slot .pdf-page-img')") is not True:
            tap_sel(cdp, '#reader-view-toggle', 0.9)
        if cdp.evaluate("return document.getElementById('reader')"
                        ".classList.contains('is-annotating')") is not True:
            tap_sel(cdp, '#reader-annotate', 1.0)
        tap_sel(cdp, '.reader-editbar [data-edit-mode="text"]', 0.8)

        s0 = snap(cdp, '① 初始（原生识别）')

        print('\n=== 第 1 次清除 ===')
        r1 = clear_all(cdp)
        print('    结果：%s' % json.dumps(r1, ensure_ascii=False))
        s1 = snap(cdp, '② 清除一次后')

        print('\n=== 第 2 次清除 ===')
        r2 = clear_all(cdp)
        print('    结果：%s' % json.dumps(r2, ensure_ascii=False))
        s2 = snap(cdp, '③ 再清除后')

        print('\n' + '=' * 50)
        print('=== 结论 ===')
        c0 = s0.get('visibleCounts', {})
        c1 = s1.get('visibleCounts', {})
        c2 = s2.get('visibleCounts', {})
        print('可见框 ①初始 : %s' % json.dumps(c0, ensure_ascii=False))
        print('可见框 ②清一次: %s' % json.dumps(c1, ensure_ascii=False))
        print('可见框 ③再清  : %s' % json.dumps(c2, ensure_ascii=False))
        if c2 == c0 and c1 != c0:
            print('\n❌ **确认**：再清除后类型分布回到初始 → 覆盖标注被丢弃，原生乱框复活')
        elif c2 == c1:
            print('\n✅ 再清除后状态稳定（没有复活）')
        else:
            print('\n⚠️ 状态变化不符合任一预期，需细看')

        print('\n=== anno 日志 ===')
        for l in cdp.evaluate("""
            return (window.__bootLog || []).filter(function (l) {
                return /clear|annotate/.test(l);
            }).slice(-14);
        """):
            print('  ' + str(l))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
