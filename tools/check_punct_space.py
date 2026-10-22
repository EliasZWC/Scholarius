# -*- coding: utf-8 -*-
"""验证：跨行合并时的空格规则（needsSpaceBetween）。

══ 这个脚本为什么只剩这么点内容 ══

它原来验证 `fixPunctSpacing` 那一堆「标点后该不该补空格」的规则。
那些规则已经被**整段删除**（v0.1.93），原因：

  用户两轮反馈方向相反 ——
    「标点符号后面的空格依然被吞了」
    「原本标点符号后面没有空格的被强制加了空格」

  两派规则互相打架，把 URL 打散成 `www. fit. vutbr. cz`。
  教训：**PDF 里不存在"该不该有空格"，只有排版事实（字形间距）。**

  所以行内空格现在由 Kotlin 侧按坐标判定（在 `writeString` 里，
  规则只有一条：**有间隙就放一个空格**）。那是坐标判断，
  无法在纯字符串上复刻 —— 必须在**真实 PDF 产物**上验，
  见 tools/check_real_spacing.py。

⚠️ 这个脚本保留的是**跨行合并**那一半：
   跨行的坐标不连续（行末到下一行行首之间没有"排版间隙"可言），
   所以那里仍然必须按字符类型判断，也就仍然值得单元测试。
"""
import sys


# ══════════════════════════════════════════════════════════════════
# 跨行合并：PdfText.needsSpaceBetween 的等价实现
# ══════════════════════════════════════════════════════════════════

TRAILING = ".,;:?!)]}\"'%\u2019\u201D\u3002\uFF0C\uFF1B\uFF1A\uFF1F\uFF01\uFF09\uFF05"


def needs_space(a: str, b: str) -> bool:
    if not a or not b:
        return False
    last, first = a[-1], b[0]
    # 连字符 = 断词，直接接上
    if last in "-" or last in "\u2010\u2011":
        return False
    first_is_word = first.isalnum() and ord(first) < 0x2E80
    if not first_is_word:
        return False
    if last.isalnum() and ord(last) < 0x2E80:
        return True
    return last in TRAILING


def join(a: str, b: str) -> str:
    return a + (" " if needs_space(a, b) else "") + b


CASES_JOIN = [
    ("representation model called BERT,", "which stands for",
     "representation model called BERT, which stands for", "逗号结尾接下一行"),
    ("such as ELMo", "Peters", "such as ELMo Peters", "纯字母"),
    ("multi-", "modal", "multi-modal", "连字符断词，必须接上"),
    ("研究", "方法", "研究方法", "中文不补"),
    ("BERT", "which", "BERT which", "字母+字母"),
    ("(Fig. 1)", "and", "(Fig. 1) and", "右括号结尾"),
    ("states.", "We", "states. We", "句号结尾接下一句"),
]


def main():
    fails = 0
    print("=== 跨行合并（needsSpaceBetween）===")
    for a, b, want, desc in CASES_JOIN:
        got = join(a, b)
        ok = got == want
        if not ok:
            fails += 1
        print("%s [%s]" % ("OK  " if ok else "FAIL", desc))
        if not ok:
            print("      in : %r + %r" % (a, b))
            print("      want: %r" % want)
            print("      got : %r" % got)

    print()
    print("=== 行内空格：不在此验证 ===")
    print("  规则只有一条：字形有间隙 → 一个空格（Kotlin 按坐标判断）。")
    print("  必须在真实 PDF 产物上验：python tools/check_real_spacing.py <doc.md>")

    print()
    print("合计: %d 失败" % fails)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
