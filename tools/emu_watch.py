# -*- coding: utf-8 -*-
"""旁观模式：用户自己在模拟器上操作，脚本只**记录**，不主动点击。

⚠️ 用户明确要求：「你现在看我操作」

做法：
  ① 在设备 WebView 里装一组**捕获阶段**监听（touch/pointer/click），
     记录每一次手指操作的坐标、命中元素、时间。
  ② 同时记录 reader 的类、层数、块数、框数、当前编辑类型的变化。
  ③ 挂一个 30 秒的快照定时器，把状态变化也记下来。
  ④ 然后**等待**，让用户操作；最后由用户说「停」，脚本把记录打出来。

用法：
    python tools/emu_watch.py start   # 开始记录
    python tools/emu_watch.py dump    # 打印记录
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import ensure_ready, targets, pick_page  # noqa: E402
from emu_touch import Cdp  # noqa: E402

RECORDER = r"""
(function () {
  if (window.__watchOn) return 'already';
  window.__watchOn = true;
  window.__watchLog = [];

  var t0 = Date.now();
  var stamp = function () { return Math.round(Date.now() - t0) + 'ms'; };

  /* 当前界面状态的「指纹」—— 只在变化时记一条，避免刷屏 */
  var lastFp = null;
  function fingerprint() {
    var r = document.getElementById('reader');
    var eb = document.querySelector('.reader-editbar');
    var pressed = null;
    if (eb) {
      var a = eb.querySelector('[data-edit-mode][aria-pressed="true"]');
      pressed = a ? a.getAttribute('data-edit-mode') : null;
    }
    var sheet = document.querySelector('.anno-typesheet');
    var del = null;
    if (sheet) {
      var bs = sheet.querySelectorAll('.btn, .anno-typeopt');
      for (var i = 0; i < bs.length; i++) {
        if ((bs[i].textContent || '').trim() === 'Delete') del = 'yes';
      }
    }
    return [
      r ? r.className : '-',
      document.querySelectorAll('.anno-layer').length,
      document.querySelectorAll('.anno-block').length,
      document.querySelectorAll('.anno-box').length,
      pressed === null ? 'null' : pressed,
      sheet ? ('sheet' + (del ? '+del' : '')) : 'nosheet'
    ].join(' | ');
  }

  function note(tag, extra) {
    window.__watchLog.push(stamp() + ' [' + tag + '] ' + (extra || ''));
  }

  function describe(el) {
    if (!el) return 'null';
    var cls = (el.className || '').toString().split(' ').slice(0, 3).join('.');
    return el.tagName + (cls ? '.' + cls : '');
  }

  ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(function (n) {
    document.addEventListener(n, function (ev) {
      /* move 太多，只记第一次和最后一次 */
      if (n === 'touchmove') {
        window.__moveCount = (window.__moveCount || 0) + 1;
        if (window.__moveCount % 8 !== 0) return;
      }
      var t = ev.touches && ev.touches[0] ? ev.touches[0] : null;
      note(n, (t ? Math.round(t.clientX) + ',' + Math.round(t.clientY) : '-') +
           ' -> ' + describe(ev.target));
    }, true);
  });

  ['pointerdown', 'pointerup', 'pointercancel'].forEach(function (n) {
    document.addEventListener(n, function (ev) {
      note(n, Math.round(ev.clientX) + ',' + Math.round(ev.clientY) +
           ' -> ' + describe(ev.target));
    }, true);
  });

  document.addEventListener('click', function (ev) {
    note('click', Math.round(ev.clientX) + ',' + Math.round(ev.clientY) +
         ' -> ' + describe(ev.target));
  }, true);

  /* 状态变化轮询（200ms）—— 只在指纹变了时记 */
  setInterval(function () {
    var fp = fingerprint();
    if (fp !== lastFp) {
      var old = lastFp;
      lastFp = fp;
      note('STATE', (old === null ? '(初始) ' : '(从 ' + old + ') → ') + fp);
    }
  }, 200);

  return 'installed';
})()
"""

DUMP = r"""
(function () {
  var log = window.__watchLog || [];
  return JSON.stringify({
    on: !!window.__watchOn,
    n: log.length,
    reader: (document.getElementById('reader') || {}).className || '-',
    boxes: document.querySelectorAll('.anno-box').length,
    layers: document.querySelectorAll('.anno-layer').length,
    blocks: document.querySelectorAll('.anno-block').length,
    log: log.slice()
  });
})()
"""


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'start'
    if not ensure_ready():
        raise SystemExit('没找到 WebView socket')
    cdp = Cdp(pick_page(targets())['webSocketDebuggerUrl'])
    try:
        if action == 'start':
            print(cdp.evaluate(RECORDER))
            print('✅ 已开始记录。现在请在模拟器上操作（用鼠标当手指）。')
            print('   操作完回来说一声，我打印记录。')
        elif action == 'dump':
            raw = cdp.evaluate(DUMP)
            if not raw:
                print('⚠️ 拿不到记录 —— 监听可能没装上（页面被重载过？）')
                print('   当前 reader: %s'
                      % cdp.evaluate(
                          "return (document.getElementById('reader')||{}).className"))
                print('   当前 watchOn: %s'
                      % cdp.evaluate('return !!window.__watchOn'))
                return 1
            if isinstance(raw, str):
                d = json.loads(raw)
            else:
                d = raw
            print('记录条数: %d   （监听已装: %s）' % (d.get('n'), d.get('on')))
            print('当前状态: %s' % d.get('reader'))
            print('  框=%s 层=%s 块=%s'
                  % (d.get('boxes'), d.get('layers'), d.get('blocks')))
            print('-' * 66)
            for line in d.get('log') or []:
                print(line)
        else:
            raise SystemExit('用法: emu_watch.py start|dump')
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
