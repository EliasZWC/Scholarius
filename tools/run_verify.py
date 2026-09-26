# -*- coding: utf-8 -*-
"""跑 verify_select.py 并只打印结论行（绕开 PowerShell 的编码/管道干扰）。

用法：python tools/run_verify.py
"""
import io
import os
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
env = dict(os.environ)
env['PYTHONIOENCODING'] = 'utf-8'

target = sys.argv[1] if len(sys.argv) > 1 else 'verify_select.py'
r = subprocess.run([sys.executable, os.path.join(HERE, target)],
                   capture_output=True, env=env, cwd=os.path.dirname(HERE))
out = r.stdout.decode('utf-8', 'replace')
err = r.stderr.decode('utf-8', 'replace')

KEYS = ('#####', '✅', '❌', '→', '落笔行', '全部通过', '失败', '划的', '标注覆盖',
        '用户划', '══', '✅ 全部', '❌ 失败')
for line in out.splitlines():
    if any(k in line for k in KEYS):
        print(line)

if r.returncode != 0:
    print()
    print('=== 退出码 %d，stderr 末尾 ===' % r.returncode)
    print('\n'.join(err.splitlines()[-20:]))
