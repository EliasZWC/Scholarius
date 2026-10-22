# -*- coding: utf-8 -*-
"""检查真实 md 产物里的空格是否正确（v0.1.93 坐标判据）。

用户两轮反馈方向相反：
  「标点符号后面的空格依然被吞了」
  「原本标点符号后面没有空格的被强制加了空格」

所以这里不再检查"规则有没有生效"，而是直接看产物：
  · URL / 邮箱 / 分类码 **必须完整**（不能有 `www. fit. vutbr. cz`）
  · 真正的标点后空格不能被吞（`BERT,which` 应为 `BERT, which`）
"""
import io
import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else 'tools/_real.md'
s = io.open(path, encoding='utf-8').read()

fail = 0

# ── ① URL / 邮箱 / 分类码不能被拆开 ────────────────────────────────
# ⚠️ 判据必须是「**真的被插了空格**」，不能只匹配 `www.` 本身 ——
#    第一版写成 `www\s*\.\s*`，那是恒真的（`www.` 本来就长这样），
#    于是永远报 FAIL，看起来像功能坏了，其实是检查脚本写错。
BROKEN = [
    (r'www\s+\.', 'www . 被拆'),          # `www .` → 有空格才是坏
    (r'[A-Za-z0-9]\s+\.(com|org|edu|cz|net|gov)\b', '域名后缀被拆'),
    (r'@\s*[A-Za-z0-9]+\s+\.', '邮箱域名被拆'),
    (r'cs\s+\.\s*C\s*L', 'cs.CL 被拆'),
    (r'https?\s+:', 'URL 协议被拆'),   # `http :` 才是坏
]

print('=== ① URL / 邮箱 / 分类码 ===')
for pat, desc in BROKEN:
    hits = list(re.finditer(pat, s))
    if hits:
        fail += 1
        print('  FAIL %-22s %d 处' % (desc, len(hits)))
        for h in hits[:3]:
            print('        %r' % s[max(0, h.start() - 30):h.start() + 30])
    else:
        print('  OK   %s' % desc)

# ── ② 完整 token 应该还在 ──────────────────────────────────────────
print('\n=== ② 完整 token 是否保留 ===')
KEEP = ['google.com', 'fit.vutbr.cz', 'collobert.com', 'cs.CL']
for k in KEEP:
    if k in s:
        print('  OK   %s' % k)
    else:
        fail += 1
        print('  FAIL %s 不见了' % k)

# ── ③ 真正的标点后空格不能吞 ──────────────────────────────────────
print('\n=== ③ 标点后空格 ===')
# 逗号紧跟字母且两边都是小写词：可疑粘连
stuck = list(re.finditer(r'[a-z]{3,},[a-z]{3,}', s))
if stuck:
    fail += 1
    print('  FAIL 逗号粘连 %d 处' % len(stuck))
    for h in stuck[:5]:
        print('        %r' % s[max(0, h.start() - 30):h.start() + 30])
else:
    print('  OK   没有逗号粘连')

# 句号紧跟大写字母（真句号丢了空格）
stuck2 = list(re.finditer(r'[a-z]{3,}\.[A-Z][a-z]{2,}', s))
if stuck2:
    fail += 1
    print('  FAIL 句号粘连 %d 处' % len(stuck2))
    for h in stuck2[:5]:
        print('        %r' % s[max(0, h.start() - 30):h.start() + 30])
else:
    print('  OK   没有句号粘连')

print('\n合计: %s' % ('全部通过' if fail == 0 else '%d 项失败' % fail))
sys.exit(1 if fail else 0)
