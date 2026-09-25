# -*- coding: utf-8 -*-
"""在**模拟器里的 WebView** 上执行 JS —— 真机级验证。

背景（2026-09-25）：
  之前所有验证都在桌面 Chromium（Playwright）里做，
  而 `touch-action: none` 吞 pointer 事件这类问题**桌面复现不出来**,
  导致同一个画框 bug 连改三版。

  现在本机有 Android 模拟器 + WebView 远程调试，
  于是可以像 Playwright 那样在**真正的 Android WebView** 里跑 JS ——
  这才能测出手势/pointer/touch-action 的真实行为。

原理：
  WebView 若开了 `setWebContentsDebuggingEnabled(true)`，
  会在 /proc/net/unix 暴露一个 `@webview_devtools_remote_<pid>` 抽象 socket。
  用 `adb forward tcp:<port> localabstract:<name>` 把它转到本地，
  再走 Chrome DevTools Protocol（HTTP + WebSocket）就能执行 JS。

用法：
    python tools/emu_js.py "return document.title"
    python tools/emu_js.py --file tools/_probe.js
    python tools/emu_js.py --devices          # 列出可调试的 WebView

⚠️ 需要 `pip install websocket-client`
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

ADB = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk',
                   'platform-tools', 'adb.exe')
PORT = 9222


def adb(*args, timeout=60):
    p = subprocess.run([ADB] + list(args), stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, timeout=timeout)
    return (p.stdout or b'').decode('utf-8', 'replace')


def devtools_socket():
    """找 WebView 的 devtools socket 名。"""
    out = adb('shell', 'cat /proc/net/unix')
    names = re.findall(r'@(webview_devtools_remote_\d+)', out)
    if not names:
        return None
    # 去重；若有多个 WebView 取第一个
    return sorted(set(names))[0]


def forward(name):
    """把抽象 socket 转到本地 tcp 端口。"""
    adb('forward', '--remove', 'tcp:%d' % PORT)
    out = adb('forward', 'tcp:%d' % PORT, 'localabstract:%s' % name)
    if 'error' in out.lower():
        raise SystemExit('adb forward 失败: ' + out.strip())


def ensure_ready(auto=True):
    """拿到 socket 名 + 完成转发。auto=True 时自动重试（应用重启后 pid 会变）。"""
    for attempt in range(12 if auto else 1):
        sock = devtools_socket()
        if sock:
            forward(sock)
            return sock
        if not auto:
            break
        time.sleep(1)
    return None


def targets():
    url = 'http://127.0.0.1:%d/json' % PORT
    for _ in range(20):
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception:
            time.sleep(0.5)
    raise SystemExit('连不上 WebView 调试端口（应用是否在前台？）')


def pick_page(ts):
    """挑一个 type=page 且 url 像我们应用的 target。"""
    pages = [t for t in ts if t.get('type') == 'page']
    if not pages:
        raise SystemExit('没有 type=page 的 target：%s'
                         % json.dumps(ts, ensure_ascii=False)[:500])
    for t in pages:
        if 'appassets' in (t.get('url') or '') or 'index.html' in (t.get('url') or ''):
            return t
    return pages[0]


def evaluate(ws_url, expr, timeout=30):
    """在 target 上执行 JS，返回结果值。"""
    try:
        import websocket  # websocket-client
    except ImportError:
        raise SystemExit('缺依赖：pip install websocket-client')

    ws = websocket.create_connection(
        ws_url, timeout=timeout,
        # ⚠️ 新版 CDP 会校验 Origin，不匹配就回 403
        #    "Rejected an incoming WebSocket connection from ...".
        #    WebView 的 devtools 端口没给 --remote-allow-origins，
        #    所以干脆**不发** Origin 头（suppress_origin）。
        suppress_origin=True,
    )
    try:
        # Runtime.evaluate: awaitPromise 让我们能写 async 代码
        payload = {
            'id': 1,
            'method': 'Runtime.evaluate',
            'params': {
                'expression': '(function(){%s})()' % expr,
                'returnByValue': True,
                'awaitPromise': True,
            },
        }
        ws.send(json.dumps(payload))
        while True:
            msg = json.loads(ws.recv())
            if msg.get('id') == 1:
                r = msg.get('result', {})
                if 'exceptionDetails' in r:
                    det = r['exceptionDetails']
                    txt = det.get('exception', {}).get('description') or det.get('text')
                    raise SystemExit('JS 异常: ' + str(txt))
                return r.get('result', {}).get('value')
    finally:
        ws.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('expr', nargs='?', help='要执行的 JS（可含 return）')
    # ⚠️ 终端会把 `--file` 缩写成 `-f`（"abbreviation"），
    #    命令历史里再 paste 就变成未定义参数。显式注册短名避免踩坑。
    ap.add_argument('--file', '-f', dest='file', help='从文件读 JS')
    ap.add_argument('--devices', '-d', dest='devices', action='store_true',
                    help='只列出可调试的 WebView')
    args = ap.parse_args()

    sock = ensure_ready()
    if not sock:
        print('⚠️ 没找到 WebView 调试 socket。')
        print('   确认：1) 应用在前台；2) WebView 开了 setWebContentsDebuggingEnabled(true)')
        print('   包名是否为 debug 变体？com.eliaszwc.scholarius.debug')
        return 1
    ts = targets()

    if args.devices:
        for t in ts:
            print('%-12s %-40s %s' % (t.get('type'), (t.get('title') or '')[:40],
                                      (t.get('url') or '')[:80]))
        return 0

    expr = args.expr
    if args.file:
        expr = open(args.file, encoding='utf-8').read()
    if not expr:
        ap.error('要给表达式，或用 --file / --devices')

    page = pick_page(ts)
    val = evaluate(page['webSocketDebuggerUrl'], expr)
    if val is None:
        print('(undefined)')
    elif isinstance(val, (dict, list)):
        print(json.dumps(val, ensure_ascii=False, indent=2))
    else:
        print(val)
    return 0


if __name__ == '__main__':
    sys.exit(main())
