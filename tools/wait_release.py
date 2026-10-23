"""
等待 GitHub Release 的 APK 资产真正可用。

判定标准（用户定义的「发布完成」）：
  GET /releases/tags/vX -> 200，且资产里有 .apk，state == "uploaded"

⚠️ 只看 release 存在不够 —— 资产是**后传**的，
   刚创建时 assets 可能为空或 state 是 "starter"，那时下载会 404。
"""
import json
import sys
import time
import urllib.error
import urllib.request

TAG = sys.argv[1] if len(sys.argv) > 1 else 'v0.1.95'
TIMEOUT = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
URL = 'https://api.github.com/repos/EliasZWC/Scholarius/releases/tags/' + TAG


def check():
    try:
        with urllib.request.urlopen(URL, timeout=20) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, 'no-release'
        return None, 'http-%d' % e.code
    except Exception as e:
        return None, 'err:%s' % e

    assets = d.get('assets') or []
    apks = [a for a in assets if a.get('name', '').endswith('.apk')]
    if not apks:
        return None, 'no-apk(%d assets)' % len(assets)
    bad = [a for a in apks if a.get('state') != 'uploaded']
    if bad:
        return None, 'apk-%s' % bad[0].get('state')
    a = apks[0]
    return a, 'ok size=%d dl=%d' % (a.get('size', 0), a.get('download_count', 0))


start = time.time()
last = None
while time.time() - start < TIMEOUT:
    asset, status = check()
    if status != last:
        print('[%4ds] %s' % (time.time() - start, status), flush=True)
        last = status
    if asset:
        print('PUBLISHED', asset['name'], asset['size'], asset['browser_download_url'])
        sys.exit(0)
    time.sleep(15)

print('TIMEOUT after %ds (last: %s)' % (TIMEOUT, last))
sys.exit(1)
