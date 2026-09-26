# -*- coding: utf-8 -*-
"""校验 APK 里的 assets 与源文件一致，且包含本轮修复。"""
import zipfile

src = open('app/src/main/assets/www/reader.js', encoding='utf-8').read()
apk = ('app/build/outputs/apk/debug/app-debug.apk')
with zipfile.ZipFile(apk) as z:
    got = z.read('assets/www/reader.js').decode('utf-8')

print('源 行数      :', src.count('\n') + 1)
print('APK 行数     :', got.count('\n') + 1)
print('完全一致     :', src == got)
print()
print('本轮修复是否在 APK 里:')
checks = [
    ("rowsToGlobalFrom 改成 y 反查（参数名 rowY）", 'function rowsToGlobalFrom(rowY, page)'),
    ('currentSelection 记 yFrom/yTo', 'yFrom: yFirst'),
    ('openSelectionTypePicker 传 y', 'rowsToGlobalFrom(sel.yFrom, page)'),
    ('annotateNoLine 改用 toast（非破坏）',
     "showAnnoTip('annotateNoLine')"),
    ('saveFailed 改用 toast', "showAnnoTip('saveFailed')"),
    ('旧的 base + rowFrom 已删', 'base + rowFrom'),
]
for label, needle in checks:
    n = got.count(needle)
    if needle == 'base + rowFrom':
        print('  %-44s %s' % (label, '✅ 已删除' if n == 0 else '❌ 还在 (%d 处)' % n))
    else:
        print('  %-44s %s' % (label, '✅ 在 (%d 处)' % n if n else '❌ 缺失'))
