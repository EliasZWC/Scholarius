# -*- coding: utf-8 -*-
"""本地跑起来：构建 APK → 启动模拟器 → 安装 → 截图。

背景（2026-09-25）：项目长期没有本地 Android 环境，
所有改动只能推 CI 编译，而 WebView 行为差异
（如 `touch-action: none` 吞 pointer 事件）在桌面 Chromium 上
复现不出来 —— 同一个画框 bug 连改三版。

本脚本把「本地验证」压成一条命令，改完代码先跑它，
别再把未验证的版本推给用户。

用法：
    python tools/android_run.py              # 全流程
    python tools/android_run.py --build      # 只构建
    python tools/android_run.py --no-build   # 跳过构建，直接装已有的 APK
    python tools/android_run.py --shot out.png   # 装完截一张图

⚠️ 模拟器首次启动要 1~3 分钟（冷启动 + 系统初始化），
   之后启动快很多。脚本会轮询等它起来。
"""
import argparse
import os
import re
import subprocess
import sys
import time

SDK = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk')
JAVA_HOME = r'C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot'
GRADLE = r'C:\gradle\gradle-8.11.1\bin\gradle.bat'
ADB = os.path.join(SDK, 'platform-tools', 'adb.exe')
EMULATOR = os.path.join(SDK, 'emulator', 'emulator.exe')
AVDMANAGER = os.path.join(SDK, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat')
SDKMANAGER = os.path.join(SDK, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')

AVD_NAME = 'Scholarius'
IMAGE = 'system-images;android-35;google_apis;x86_64'
APK = os.path.join('app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
PKG = 'com.eliaszwc.scholarius'


def env():
    e = dict(os.environ)
    e['JAVA_HOME'] = JAVA_HOME
    e['ANDROID_HOME'] = SDK
    e['ANDROID_SDK_ROOT'] = SDK
    return e


def sh(cmd, check=True, timeout=1800, quiet=False):
    """跑一条命令，返回 (rc, 输出)。"""
    if not quiet:
        print('$ ' + (cmd if isinstance(cmd, str) else ' '.join(cmd)))
    p = subprocess.run(cmd, shell=isinstance(cmd, str), env=env(),
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       timeout=timeout)
    out = (p.stdout or b'').decode('utf-8', 'replace')
    if check and p.returncode != 0:
        print(out[-4000:])
        raise SystemExit('命令失败 (rc=%d): %s' % (p.returncode, cmd))
    return p.returncode, out


# --- 步骤 -------------------------------------------------------------------

def build():
    print('\n=== 1/4 构建 Debug APK ===')
    t = time.time()
    rc, out = sh('"%s" --no-daemon assembleDebug' % GRADLE, check=False)
    tail = out.strip().splitlines()[-3:]
    for l in tail:
        print('  ' + l)
    if rc != 0:
        # 编译错误：把带 error 的行挑出来（比整段日志好读）
        errs = [l for l in out.splitlines() if re.search(r'^e:|error:', l)]
        for l in errs[:40]:
            print('  ' + l)
        raise SystemExit('构建失败')
    print('  用时 %.1fs' % (time.time() - t))
    if not os.path.isfile(APK):
        raise SystemExit('没找到 APK: %s' % APK)
    print('  %s  %.2f MB' % (APK, os.path.getsize(APK) / 1048576))


def ensure_avd():
    print('\n=== 2/4 准备模拟器 ===')
    rc, out = sh('"%s" list avd' % AVDMANAGER, check=False)
    if AVD_NAME in out:
        print('  已有 AVD: %s' % AVD_NAME)
        return
    print('  创建 AVD %s ...' % AVD_NAME)
    # ⚠️ avdmanager 会问 "Do you wish to create a custom hardware profile?"
    #    必须先喂一个 "no"，否则它会一直等输入。
    p = subprocess.run(
        '"%s" create avd -n %s -k "%s" --device "pixel_6" --force'
        % (AVDMANAGER, AVD_NAME, IMAGE),
        shell=True, env=env(), input=b'no\n',
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300)
    print('  ' + (p.stdout or b'').decode('utf-8', 'replace').strip()[-500:])


def adb(*args, **kw):
    return sh('"%s" %s' % (ADB, ' '.join(args)), **kw)


def emulator_serial():
    """返回在线的模拟器 serial（如 emulator-5554），没有则 None。"""
    rc, out = sh('"%s" devices' % ADB, check=False, quiet=True)
    for line in out.splitlines():
        if line.startswith('emulator-') and '\tdevice' in line:
            return line.split('\t')[0]
    return None


def boot_emulator(wait_min=6):
    print('\n=== 3/4 启动模拟器 ===')
    serial = emulator_serial()
    if serial:
        print('  已在运行: %s' % serial)
        return serial

    print('  冷启动中（首次 1~3 分钟）...')
    # ⚠️ 用 Popen 后台起，不要 wait —— 模拟器是长驻进程。
    #    -no-snapshot-load: 每次都从干净状态起，避免旧快照掩盖问题
    #    -gpu host:        本机是 AMD Radeon 780M，有真 GPU，
    #                      用硬件加速比 swiftshader_indirect（纯 CPU 软渲染）
    #                      快一个数量级。若 host 起不来再退软渲染。
    subprocess.Popen(
        '"%s" -avd %s -no-snapshot-load -no-boot-anim -gpu host '
        '-no-audio -netdelay none -netspeed full' % (EMULATOR, AVD_NAME),
        shell=True, env=env(),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    deadline = time.time() + wait_min * 60
    while time.time() < deadline:
        time.sleep(10)
        s = emulator_serial()
        if not s:
            print('  ...等设备出现')
            continue
        # 设备出现 ≠ 系统起好；sys.boot_completed=1 才是真的能用
        rc, out = sh('"%s" -s %s shell getprop sys.boot_completed' % (ADB, s),
                     check=False, quiet=True)
        if out.strip() == '1':
            print('  已就绪: %s' % s)
            return s
        print('  ...等系统启动完成')
    raise SystemExit('模拟器 %.0f 分钟内没起来' % wait_min)


def install(serial):
    print('\n=== 4/4 安装 APK ===')
    apk = os.path.abspath(APK)
    if not os.path.isfile(apk):
        raise SystemExit('没找到 APK: %s' % apk)
    sh('"%s" -s %s install -r -t "%s"' % (ADB, serial, apk), timeout=600)
    # 直接拉起，省得手动点
    sh('"%s" -s %s shell monkey -p %s -c android.intent.category.LAUNCHER 1'
       % (ADB, serial, PKG), check=False, quiet=True)
    print('  已安装并启动 %s' % PKG)


def screenshot(serial, path):
    print('\n=== 截图 %s ===' % path)
    # ⚠️ adb exec-out 直接吐二进制，别用 shell screenshot（会带 \r\n 损坏 PNG）
    p = subprocess.run('"%s" -s %s exec-out screencap -p' % (ADB, serial),
                       shell=True, env=env(), stdout=subprocess.PIPE, timeout=120)
    with open(path, 'wb') as f:
        f.write(p.stdout)
    print('  %.0f KB' % (len(p.stdout) / 1024))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--build', action='store_true', help='只构建')
    ap.add_argument('--no-build', action='store_true', help='跳过构建')
    ap.add_argument('--shot', metavar='PNG', help='装完截图到指定文件')
    ap.add_argument('--wait-min', type=int, default=6, help='等模拟器启动的分钟数')
    args = ap.parse_args()

    if not args.no_build:
        build()
    if args.build:
        return

    ensure_avd()
    serial = boot_emulator(args.wait_min)
    install(serial)
    if args.shot:
        time.sleep(5)          # 等应用画出来
        screenshot(serial, args.shot)
    print('\n完成。模拟器 serial = %s' % serial)


if __name__ == '__main__':
    main()
