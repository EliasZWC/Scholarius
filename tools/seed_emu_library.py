# -*- coding: utf-8 -*-
"""往模拟器里的 Scholarius **私有目录**直接塞一篇文献 —— 绕过 SAF 选择器。

为什么需要这个：
  真机导入 PDF 走 `<input type="file">` → `onShowFileChooser` → 系统 SAF
  选择器。那是**系统 UI**，脚本点不了（Playwright 控不到、adb input 也只能
  盲点坐标）。而"画框"功能必须**先有文献**才能测。

  好在 LibraryStore 的存储布局是纯文件：
      filesDir/library/index.json
      filesDir/library/<docId>/doc.pdf
  所以直接 adb push 进去 + 重启应用，效果等同真导入
  （等价于 LibraryStore.import() 的产物）。

⚠️ debug 变体的 filesDir 是：
      /data/data/com.eliaszwc.scholarius.debug/files
   必须用 `run-as` 才能写（普通 adb shell 没权限）。
   `run-as` 只在 debuggable 应用上可用 —— 所以这招**只对 debug 包有效**，
   这正好是我们测试用的包。

用法：
    python tools/seed_emu_library.py                  # 塞 1 篇（3 页测试 PDF）
    python tools/seed_emu_library.py --pages 5        # 5 页
    python tools/seed_emu_library.py --clear           # 清空文库
"""
import argparse
import json
import os
import subprocess
import sys
import time

PKG = 'com.eliaszwc.scholarius.debug'
ADB = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk',
                   'platform-tools', 'adb.exe')
HERE = os.path.dirname(os.path.abspath(__file__))


def adb(*args, timeout=90, check=False):
    p = subprocess.run([ADB] + list(args), stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, timeout=timeout)
    out = (p.stdout or b'').decode('utf-8', 'replace')
    if check and p.returncode != 0:
        raise SystemExit('adb %s 失败: %s' % (' '.join(args), out.strip()))
    return out


def run_as(*args, timeout=90, check=True):
    """在应用私有目录里执行命令（debug 包可用）。"""
    return adb('shell', 'run-as', PKG, *args, timeout=timeout, check=check)


def clear():
    run_as('rm', '-rf', 'files/library', check=False)
    # 清掉 web 端的标注缓存，避免残留
    adb('shell', 'run-as', PKG, 'rm', '-rf', 'files/library', check=False)
    print('已清空 files/library')


def seed(pages=3, doc_id='devtest1', pdf_path=None, paper=False):
    # 1) 造 PDF（或直接用指定的）
    sys.path.insert(0, HERE)
    if pdf_path:
        pdf = pdf_path
        if not os.path.isfile(pdf):
            raise SystemExit('找不到 PDF：%s' % pdf)
        size = os.path.getsize(pdf)
    else:
        pdf = os.path.join(HERE, '_seed.pdf')
        from make_test_pdf import build_pdf, build_paper
        if paper:
            build_paper(pdf, pages)
        else:
            build_pdf(pdf, pages)
        size = os.path.getsize(pdf)

    # 2) 建目录 + 推 PDF
    run_as('mkdir', '-p', 'files/library/%s' % doc_id)
    # run-as 没有 stdin 重定向，得先推到 /data/local/tmp 再 cp
    adb('push', pdf, '/data/local/tmp/_seed.pdf', check=True)
    # run-as 读得到 /data/local/tmp
    run_as('cp', '/data/local/tmp/_seed.pdf',
           'files/library/%s/doc.pdf' % doc_id)

    # 3) 写 index.json —— 键名必须与 LibraryStore.writeIndex 一致
    doc = {
        'id': doc_id,
        'title': ('A Study of Something Important' if (paper or pdf_path)
                  else 'Scholarius Test PDF'),
        'author': 'EliasZWC',
        'venue': 'TestConf',
        'venueType': 'conference',
        'year': '2024',
        'shortTitle': 'TestConf',
        'fields': {'doi': '10.0000/test'},
        'addedAt': int(time.time() * 1000),
        'pages': pages,
        'size': size,
        'sourceName': os.path.basename(pdf),
    }
    index = json.dumps([doc], ensure_ascii=False)
    tmp = os.path.join(HERE, '_seed_index.json')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(index)
    adb('push', tmp, '/data/local/tmp/_seed_index.json', check=True)
    run_as('cp', '/data/local/tmp/_seed_index.json', 'files/library/index.json')

    # 4) 复核
    out = run_as('sh', '-c', 'ls -lR files/library')
    print(out)
    print('已塞入 docId=%s (%d 页, %d 字节)' % (doc_id, pages, size))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pages', type=int, default=3)
    ap.add_argument('--id', default='devtest1')
    ap.add_argument('--clear', action='store_true')
    ap.add_argument('--pdf', help='直接用这个 PDF（不再生成最小 PDF）')
    ap.add_argument('--paper', action='store_true',
                    help='生成「论文版」测试 PDF（多字号多块，能触发原生各种判定）')
    ap.add_argument('--restart', action='store_true', default=True,
                    help='塞完后重启应用（默认开）')
    args = ap.parse_args()

    if args.clear:
        clear()

    seed(args.pages, args.id, args.pdf, args.paper)

    if args.restart:
        adb('shell', 'am', 'force-stop', PKG)
        adb('shell', 'am', 'start', '-n',
            '%s/com.eliaszwc.scholarius.MainActivity' % PKG)
        print('已重启应用')


if __name__ == '__main__':
    main()
