# -*- coding: utf-8 -*-
"""本地 Android 环境自检 —— 确认构建/模拟器链路可用。

背景（2026-09-25）：
  项目长期没有本地 Android 环境，所有 Kotlin/XML 改动只能推 CI 编译，
  而 **WebView 行为差异**（比如 touch-action: none 吞 pointer 事件）
  在桌面 Chromium 上复现不出来 —— 导致同一个画框 bug 连改三版。

  本机现已装好：
    · JDK 17        C:\\Program Files\\Microsoft\\jdk-17.0.20.101-hotspot
    · Android SDK   %LOCALAPPDATA%\\Android\\Sdk  (platform 35 / build-tools 35.0.0)
    · Gradle 8.11.1 C:\\gradle\\gradle-8.11.1
    · 模拟器         android-35 google_apis x86_64

用法：python tools/check_android_env.py
"""
import io
import os
import subprocess
import sys

JAVA_HOME = r'C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot'
SDK = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk')
GRADLE = r'C:\gradle\gradle-8.11.1\bin\gradle.bat'


def run(cmd, **kw):
    """
    ⚠️ 必须显式传 JAVA_HOME / ANDROID_HOME 给子进程。

       2026-09-25 踩过：gradle.bat 探测版本一直返回 '?'，
       单独调试才发现是 `ERROR: JAVA_HOME is not set` ——
       Gradle 需要 JAVA_HOME 才能启动。
       而终端里 JAVA_HOME 是我临时 `$env:` 设的，
       **Python 子进程看不到**（它继承的是启动 Python 时的环境）。

       所以脚本自己拼一份 env 传下去，不依赖调用方。
    """
    env = dict(os.environ)
    env['JAVA_HOME'] = JAVA_HOME
    env['ANDROID_HOME'] = SDK
    env['ANDROID_SDK_ROOT'] = SDK
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           shell=True, timeout=180, env=env, **kw)
        return p.returncode, (p.stdout or b'').decode('utf-8', 'replace').strip()
    except Exception as e:
        return -1, str(e)


def main():
    problems = []

    print('=== 1. JDK 17 ===')
    javac = os.path.join(JAVA_HOME, 'bin', 'javac.exe')
    if os.path.isfile(javac):
        rc, out = run('"%s" -version' % javac)
        print('  %s' % (out.splitlines()[0] if out else '?'))
        if '17' not in out:
            problems.append('javac 不是 17：%s' % out)
    else:
        problems.append('找不到 javac：%s' % javac)
        print('  缺')

    print()
    print('=== 2. Android SDK ===')
    for sub, want in [('platforms', 'android-35'),
                      ('build-tools', '35.0.0'),
                      ('platform-tools', 'adb.exe'),
                      ('cmdline-tools', 'latest'),
                      ('emulator', 'emulator.exe')]:
        p = os.path.join(SDK, sub)
        if sub == 'platform-tools':
            ok = os.path.isfile(os.path.join(p, 'adb.exe'))
        elif sub == 'emulator':
            ok = os.path.isfile(os.path.join(p, 'emulator.exe'))
        else:
            ok = os.path.isdir(os.path.join(p, want))
        print('  %-16s %s' % (sub, 'OK' if ok else '缺 (%s)' % want))
        if not ok:
            problems.append('SDK 缺 %s/%s' % (sub, want))

    print()
    print('=== 3. 系统镜像 ===')
    img = os.path.join(SDK, 'system-images', 'android-35', 'google_apis', 'x86_64')
    ok = os.path.isdir(img) and os.path.isfile(os.path.join(img, 'system.img'))
    print('  android-35 google_apis x86_64 : %s' % ('OK' if ok else '缺'))
    if not ok:
        problems.append('系统镜像未装好：%s' % img)

    print()
    print('=== 4. Gradle ===')
    if os.path.isfile(GRADLE):
        rc, out = run('"%s" --version' % GRADLE)
        # ⚠️ 输出里是 "Welcome to Gradle 8.11.1!" 与 "Gradle 8.11.1"，
        #    直接按行找 'Gradle ' 会命中前者的 Welcome 行也可能落空。
        #    用正则抓「Gradle + 数字」最稳。
        import re as _re
        m = _re.search(r'Gradle\s+(\d+\.\d+(?:\.\d+)?)', out)
        print('  Gradle %s' % (m.group(1) if m else '?'))
    else:
        problems.append('找不到 gradle：%s' % GRADLE)
        print('  缺')

    print()
    print('=== 5. AVD 列表 ===')
    avdman = os.path.join(SDK, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat')
    rc, out = run('"%s" list avd' % avdman)
    if 'Scholarius' in out:
        print('  找到 Scholarius AVD')
    else:
        print('  还没建 Scholarius AVD（用 tools/android_run.py 会自动建）')

    print()
    if problems:
        for x in problems:
            print('⚠️ ' + x)
        print()
        print('共 %d 个问题' % len(problems))
        return 1

    print('OK: 本地 Android 环境可用')
    return 0


if __name__ == '__main__':
    sys.exit(main())
