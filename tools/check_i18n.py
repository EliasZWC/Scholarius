"""校验 index.html 里用到的每个 data-i18n 键都在 i18n.js 词条表里。

背景：v0.0.2 手写时把 HTML 的 `account.signOutNote` 写成了词条里的
`setting.signOutNote`，界面上就直接显示出键名了。这类错误肉眼很难发现，
用脚本机械校验。

用法：  python check_i18n.py
退出码：0 = 全部命中；1 = 存在缺失键
"""
import re
import sys
from pathlib import Path

# Windows 终端默认 GBK，中文/符号会 UnicodeEncodeError，强制 stdout 走 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

WWW = Path(__file__).resolve().parent.parent / "app/src/main/assets/www"

HTML = WWW / "index.html"
I18N = WWW / "i18n.js"


def html_keys(text: str) -> set:
    """HTML 里所有 data-i18n / data-i18n-aria-label 的值"""
    keys = set(re.findall(r'data-i18n="([^"]+)"', text))
    keys |= set(re.findall(r'data-i18n-aria-label="([^"]+)"', text))
    return keys


def i18n_keys(text: str) -> dict:
    """i18n.js 里每种语言定义的所有键 -> 语言集合"""
    table = {}
    # 语言块形如  en: { ... },   zh: { ... }
    for lang in ("en", "zh"):
        m = re.search(r"\n\s{8}" + lang + r":\s*\{(.*?)\n\s{8}\}", text, re.S)
        if not m:
            print(f"[警告] 找不到语言块：{lang}")
            continue
        body = m.group(1)
        for key in re.findall(r"'([A-Za-z0-9_.]+)':", body):
            table.setdefault(key, set()).add(lang)
    return table


def js_keys() -> set:
    """JS 里用 t('...') 或 data-i18n 动态设置的键"""
    keys = set()
    for js in WWW.glob("*.js"):
        if js.name == "i18n.js":
            continue
        keys |= set(re.findall(r"""(?:t|_t)\(\s*['"]([A-Za-z0-9_.]+)['"]""", js.read_text(encoding="utf-8")))
        # 形如  'nav.' + name  、  'update.failed.' + reason  —— 只报前缀，交给下面的白名单
    return keys


def main() -> int:
    html = HTML.read_text(encoding="utf-8")
    table = i18n_keys(I18N.read_text(encoding="utf-8"))

    used = html_keys(html)
    missing = sorted(k for k in used if k not in table)

    # JS 里动态拼接的前缀，无法静态穷举，只做提示
    prefixes = sorted({
        m for m in re.findall(r"""['"]((?:nav|update\.failed|login\.error|setting\.language|setting\.theme)\.['"]*\s*\+)""",
                             "\n".join(p.read_text(encoding="utf-8") for p in WWW.glob("*.js")))
    })

    print(f"HTML 引用键   : {len(used)}")
    print(f"词条表定义键  : {len(table)}")
    print(f"动态拼接前缀  : {len(prefixes)}  {prefixes}")
    print()

    if missing:
        print(f"[失败] 缺失 {len(missing)} 个键（HTML 用了但词条表里没有）：")
        for key in missing:
            print(f"   - {key}")
        return 1

    # 反向：定义了但没人用（只提示，不算错 —— 动态拼接会用到）
    unused = sorted(k for k in table if k not in used)
    if unused:
        print(f"[提示] {len(unused)} 个键在 HTML 里没直接用（可能由 JS 动态设置）：")
        for key in unused:
            print(f"   - {key}")

    print()
    print("[通过] 所有 data-i18n 键都有对应词条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
