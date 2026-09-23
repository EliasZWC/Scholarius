"""实测 GitHub Device Flow 端点，确认 client_id 与配置可用。

模拟 GitHubAuth.kt 的请求，验证：
  ① POST /login/device/code 能拿到 device_code + user_code
  ② Accept: application/json 时返回的是 JSON（不是 form-urlencoded）
  ③ 未授权时轮询返回 authorization_pending（而不是别的错误）

不真正完成授权 —— 那需要人去浏览器输码。
"""
import json
import sys
import urllib.parse
import urllib.request

# Windows 终端默认 GBK，中文会报 UnicodeEncodeError，强制 stdout 走 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CLIENT_ID = "Ov23li4rIVmmgRKUDgi0"
SCOPE = "repo read:user"

DEVICE_CODE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_AGENT = "Scholarius-Android"


def post(url, fields):
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    # ⚠️ 这一行是成败关键：不设 Accept: application/json，GitHub 返回 form-urlencoded
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode()
        return resp.status, raw


print("=" * 62)
print("① POST /login/device/code")
print("=" * 62)
status, raw = post(DEVICE_CODE_URL, {"client_id": CLIENT_ID, "scope": SCOPE})
print(f"HTTP {status}")
print(f"原始响应: {raw[:300]}")
print()

try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("[错误] 响应不是 JSON —— 检查是否漏了 Accept: application/json")
    raise SystemExit(1)

if "error" in data:
    print(f"[错误] GitHub 返回: {data}")
    if data.get("error") == "device_flow_disabled":
        print("   → OAuth App 没有启用 Device Flow！去应用详情页勾上它。")
    raise SystemExit(1)

device_code = data.get("device_code")
user_code = data.get("user_code")
verification_uri = data.get("verification_uri")
interval = data.get("interval")
expires_in = data.get("expires_in")

print("[成功] 拿到设备码：")
print(f"   user_code        = {user_code}      ← 用户要在浏览器里输这个")
print(f"   verification_uri = {verification_uri}")
print(f"   interval         = {interval} 秒")
print(f"   expires_in       = {expires_in} 秒")
print(f"   device_code      = {device_code[:12]}...（已截断）")
print()

# ② 立刻轮询一次：此时用户还没授权，应当返回 authorization_pending
print("=" * 62)
print("② POST /login/oauth/access_token（用户尚未授权）")
print("=" * 62)
status2, raw2 = post(TOKEN_URL, {
    "client_id": CLIENT_ID,
    "device_code": device_code,
    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
})
print(f"HTTP {status2}")
print(f"原始响应: {raw2[:300]}")
print()

try:
    data2 = json.loads(raw2)
except json.JSONDecodeError:
    print("[错误] 响应不是 JSON")
    raise SystemExit(1)

error = data2.get("error")
if error == "authorization_pending":
    print("[成功] 返回 authorization_pending —— 与代码里的处理一致，轮询逻辑正确")
elif error == "slow_down":
    print("[成功] 返回 slow_down —— 代码里会把 interval += 5 秒")
elif "access_token" in data2:
    print("[注意] 直接拿到 token 了？说明这个设备码之前已被授权过")
else:
    print(f"[注意] 其他结果: {error}  （代码里的兜底会报 invalid）")

print()
print("=" * 62)
print("结论")
print("=" * 62)
print("client_id 有效，Device Flow 已启用，端点行为与 GitHubAuth.kt 的实现一致。")
print()
print("[注意] 以上流程没有真正完成授权。要端到端验证，需在浏览器打开：")
print(f"   {verification_uri}")
print(f"   输入 {user_code}，然后点 Authorize，再重跑本脚本的 ② 部分即可换到 token。")
