# -*- coding: utf-8 -*-
"""审计：所有全屏覆盖层是不是都被 app.js 的 handleBack() 认领了。

事故背景（2026-09-25）：
  发表物简称页做完没接系统返回键，用户按返回**直接退出 App**。

  根因：Scholarius 是单页应用，`WebView.canGoBack()` 永远是 false。
  所以只要 `handleBack()` 走到最后 `return false`，原生就退出应用 ——
  不管屏幕上正开着一个多明显的全屏覆盖层。

  这个检查防的就是"新做了一个覆盖层，忘了加进 handleBack"。

用法：python tools/check_back_layers.py
无需 JDK，0.1 秒跑完。
"""
import io
import re
import sys

HTML = 'app/src/main/assets/www/index.html'
APPJS = 'app/src/main/assets/www/app.js'


def find_overlays(html):
    """找 index.html 里所有"全屏覆盖层"。

    判据：`role="dialog"` + `aria-modal="true"` 的 <section>/<div>。
    这正是本项目里全屏覆盖层的统一写法（见各处注释）。
    """
    out = []
    # 抓 <section ...> 或 <div ...> 开标签，内含 role="dialog" 与 aria-modal="true"
    for m in re.finditer(r'<(\w+)\b([^>]*)>', html):
        tag, attrs = m.group(1), m.group(2)
        if 'role="dialog"' not in attrs or 'aria-modal="true"' not in attrs:
            continue
        idm = re.search(r'id="([^"]+)"', attrs)
        if not idm:
            continue
        # 只算 section（div 里的 dialog 多半是嵌套的小层，不是"页"）
        if tag != 'section':
            continue
        out.append(idm.group(1))
    return out


def back_handled_ids(appjs):
    """handleBack 里被认领的 id。

    两种写法都算：
      · document.getElementById('xxx')
      · window.ScholariusXxx.isOpen() / .isSelecting()
    这里只查第一种（按 id），第二种由下面的 KNOWN_API 名单兜。
    """
    return set(re.findall(r"getElementById\('([a-z-]+)'\)", appjs))


def main():
    html = io.open(HTML, encoding='utf-8').read()
    appjs = io.open(APPJS, encoding='utf-8').read()

    overlays = find_overlays(html)

    # 按模块 API 认领、而非按 getElementById 认领的覆盖层。
    #
    # ⚠️ 这些是**有意**不用 id 查的：
    #    它们各自有更准确的"我开着吗"判定（比如阅读页分"菜单开"和"页开"
    #    两种状态，按 hidden 判不出该先关哪个；四个 sheet 共用一个
    #    isSheetOpen()，不该在 handleBack 里把四个 id 都列一遍）。
    BY_API = {
        # detail.js —— handleBack 的第 ⓪ 条
        'detail-page',
        # reader.js —— handleBack 的第 ① 条（另有 .handleBack() 处理菜单层次）
        'reader',
        # components.js —— handleBack 的第 ③ 条 isSheetOpen() 统一管这几个
        'toc-sheet',
        'sheet-update',
        'sheet-signout',
        'sheet-confirm',
        'sheet-picker',
        # account.js —— handleBack 的第 ⑤ 条
        'account-detail',
    }

    handled = back_handled_ids(appjs)
    missing = [x for x in overlays if x not in handled and x not in BY_API]

    print('全屏覆盖层（role=dialog + aria-modal + <section>）: %d 个' % len(overlays))
    for x in overlays:
        mark = 'OK ' if (x in handled or x in BY_API) else '⚠️ '
        print('  %s%s' % (mark, x))
    print()

    if missing:
        for x in missing:
            print('⚠️ `%s` 没在 app.js 的 handleBack() 里认领 ——' % x)
            print('   按系统返回键会**直接退出应用**（isOpen 判定加一条即可）')
        print()
        print('共 %d 个未认领' % len(missing))
        return 1

    print('OK: 所有全屏覆盖层都已被 handleBack 认领')
    return 0


if __name__ == '__main__':
    sys.exit(main())
