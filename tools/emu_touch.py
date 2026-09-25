# -*- coding: utf-8 -*-
"""在模拟器 WebView 里派发**真实触摸事件**（不是合成 DOM 事件）。

为什么不能用 `el.dispatchEvent(new PointerEvent(...))`：
  合成事件**不带**浏览器内部的 pointer 状态机 —— 它不会触发
  touch-action 的滚动抑制、不会走 hit-testing 的吞并逻辑、
  也没有真实的 pointerId/capture 语义。
  而我们要复现的 bug（`touch-action: none` 吞掉整条指针链）
  **恰恰发生在那套内部状态机里**，所以合成事件永远是绿的。

  唯一可靠的办法：走 CDP 的 `Input.dispatchTouchEvent`，
  它注入的是**和真实手指同一条路径**的输入（浏览器会当成真实触摸处理）。

用法：
    # 点 (540, 400)
    python tools/emu_touch.py tap 540 400

    # 从 (300,600) 拖到 (700,900)，20 步
    python tools/emu_touch.py drag 300 600 700 900 --steps=20

    # 拖完再做别的（一次连接里多条指令）
    python tools/emu_touch.py drag 300 600 700 900 tap 540 1200

    # 事件记录：注入前开录，注入后打印
    python tools/emu_touch.py --record tap 540 400
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_js import adb, ensure_ready, targets, pick_page, PORT  # noqa: E402


class Cdp(object):
    def __init__(self, ws_url, timeout=40):
        import websocket
        self.ws = websocket.create_connection(ws_url, timeout=timeout,
                                              suppress_origin=True)
        self._id = 0

    def send(self, method, params=None):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({'id': mid, 'method': method,
                                 'params': params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == mid:
                return msg.get('result')

    def evaluate(self, expr):
        r = self.send('Runtime.evaluate', {
            'expression': '(function(){%s})()' % expr,
            'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in r:
            raise SystemExit('JS 异常: ' + json.dumps(
                r['exceptionDetails'], ensure_ascii=False)[:400])
        return r.get('result', {}).get('value')

    def touch(self, ttype, points):
        """points: [(x, y), ...] —— 多指就传多个。"""
        self.send('Input.dispatchTouchEvent', {
            'type': ttype,          # touchStart | touchMove | touchEnd | touchCancel
            'touchPoints': [{'x': float(x), 'y': float(y),
                             'radiusX': 12, 'radiusY': 12,
                             'force': 1.0} for x, y in points],
        })

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def connect():
    sock = ensure_ready()
    if not sock:
        raise SystemExit('没找到 WebView socket；应用是否在前台？')
    page = pick_page(targets())
    return Cdp(page['webSocketDebuggerUrl'])


# ---- 事件记录器：注入前挂上，注入后取回 ------------------------------------

RECORDER_JS = """
if (!window.__touchRec) {
  window.__touchRec = [];
  var push = function (t) {
    return function (ev) {
      var tgt = ev.target;
      window.__touchRec.push({
        ev: t,
        x: Math.round(ev.clientX !== undefined ? ev.clientX : ev.touches[0].clientX),
        y: Math.round(ev.clientY !== undefined ? ev.clientY : ev.touches[0].clientY),
        target: tgt ? (tgt.tagName + '.' + (tgt.className || '').toString()
                       .split(' ').slice(0, 2).join('.')) : 'null',
        defaultPrevented: !!ev.defaultPrevented,
        cancelable: !!ev.cancelable
      });
      if (window.__touchRec.length > 400) window.__touchRec.shift();
    };
  };
  ['pointerdown','pointermove','pointerup','pointercancel',
   'touchstart','touchmove','touchend','touchcancel','click'
  ].forEach(function (n) {
    document.addEventListener(n, push(n), true);
  });
}
window.__touchRec = window.__touchRec || [];
return 'recording';
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', nargs='+',
                    help='tap <x> <y>  |  drag <x1> <y1> <x2> <y2>  |  dump  |  read')
    ap.add_argument('--steps', type=int, default=18, help='drag 的插值步数')
    ap.add_argument('--hold', type=float, default=0.0, help='按下后停留秒数')
    ap.add_argument('--record', action='store_true', help='记录事件并打印')
    ap.add_argument('--settle', type=float, default=0.45, help='操作后等待秒数')
    args = ap.parse_args()

    cdp = connect()
    try:
        if args.record:
            cdp.evaluate(RECORDER_JS)
            cdp.evaluate('window.__touchRec = []; return 1')

        i = 0
        while i < len(args.cmd):
            c = args.cmd[i]
            if c == 'tap':
                x, y = int(args.cmd[i + 1]), int(args.cmd[i + 2])
                cdp.touch('touchStart', [(x, y)])
                time.sleep(0.02 + args.hold)
                cdp.touch('touchEnd', [])
                print('tap (%d,%d)' % (x, y))
                i += 3
            elif c == 'drag':
                x1, y1, x2, y2 = [int(v) for v in args.cmd[i + 1:i + 5]]
                cdp.touch('touchStart', [(x1, y1)])
                time.sleep(0.03)
                for s in range(1, args.steps + 1):
                    t = float(s) / args.steps
                    cdp.touch('touchMove', [
                        (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)])
                    time.sleep(0.012)
                cdp.touch('touchEnd', [])
                print('drag (%d,%d) -> (%d,%d) steps=%d'
                      % (x1, y1, x2, y2, args.steps))
                i += 5
            elif c == 'read':
                print(json.dumps(
                    cdp.evaluate('return (window.__touchRec||[]).slice()'),
                    ensure_ascii=False, indent=2))
                i += 1
            elif c == 'dump':
                print(json.dumps(
                    cdp.evaluate('return {log:(window.__bootLog||[]).slice(-25)}'),
                    ensure_ascii=False, indent=2))
                i += 1
            else:
                raise SystemExit('未知指令: %s' % c)

        time.sleep(args.settle)
        if args.record:
            rec = cdp.evaluate('return (window.__touchRec||[]).slice()')
            print('--- 事件序列 (%d 条) ---' % len(rec))
            for e in rec:
                print('%-13s (%4d,%4d) -> %-38s prevented=%s'
                      % (e['ev'], e['x'], e['y'], e['target'],
                         e['defaultPrevented']))
    finally:
        cdp.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
