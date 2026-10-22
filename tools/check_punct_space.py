# -*- coding: utf-8 -*-
"""验证：英文标点后的空格补回规则（v0.1.91）。

复刻 PdfText.normaliseText 与 needsSpaceBetween 的规则，
在真实样本上跑一遍，确认：
  ① 该补的补上了（标点 + 字母）
  ② 不该动的不动（中文、数字、左括号、连字符）

⚠️ 本机无 JDK，用 Python 等价实现来验证规则本身。
"""
import re

TRAILING = ".,;:?!)]}\"'%\u2019\u201D\u3002\uFF0C\uFF1B\uFF1A\uFF1F\uFF01\uFF09\uFF05"

INLINE_RE = re.compile(
    r"([.,;:?!)\]}'\"%\u2019\u201D])([A-Za-z0-9])"
)


def _apply_inline(m):
    """带上下文判断是否该插空格。

    ⚠️ 不能只用正则的 lookbehind —— Python 的 lookbehind 只能看
       定点长度，而这里要判断「标点前一个字符是数字？」和
       「标点前两个字符是 单字母 + 点？」两个不同长度的条件。
    """
    s, punct, nxt = m.string, m.group(1), m.group(2)
    i = m.start(1)
    prev1 = s[i - 1] if i >= 1 else ""
    prev2 = s[i - 2:i] if i >= 2 else ""

    # ① 小数点：`1.5` —— 点**前后都是数字**
    if punct == "." and prev1.isdigit() and nxt.isdigit():
        return m.group(0)
    # ② 缩写：`e.g.` / `i.e.` —— 点是"单字母 + 点"循环中的点
    #    ⚠️ 数字 + 点 + 字母 **不是**缩写（`Figure 1.Note`、`comparison2.However`），
    #       那种要补空格。所以这里只判断字母，不判断数字。
    if punct == ".":
        prev_is_single_letter = bool(re.fullmatch(r"[A-Za-z]", prev1))
        # `e.g.this`：这里处理的是**第一个** `.`（后面跟 g）
        tail = s[i + 1:]
        if prev_is_single_letter and re.match(r"[A-Za-z]\.", tail):
            return m.group(0)
        # `e.g.` 的**第二个** `.`（前面是 `g`，前面两个是 `e.`）
        if re.fullmatch(r"[A-Za-z]\.", prev2):
            return m.group(0)
    return f"{punct} {nxt}"


def normalise_text(s: str) -> str:
    s = INLINE_RE.sub(_apply_inline, s)
    return re.sub(r"[ \t]+", " ", s).strip()


def needs_space(a: str, b: str) -> bool:
    if not a or not b:
        return False
    last, first = a[-1], b[0]
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


CASES_INLINE = [
    # (输入, 期望, 说明)
    ("called BERT,which stands for", "called BERT, which stands for", "逗号+字母"),
    ("such as ELMo(Peters et al.,2018a)", "such as ELMo(Peters et al., 2018a)", "逗号+数字"),
    ("downWe introduce", "downWe introduce", "本来就正常，不动"),
    ("研究。我们", "研究。我们", "中文句号不动"),
    ("version 1.5 is out", "version 1.5 is out", "小数点后是数字，不动"),
    ("word(word)", "word(word)", "左括号不动"),
    ("state-of-the-art", "state-of-the-art", "连字符不动"),
    ("e.g.this", "e.g. this", "缩写整体保留，只在其后补空格"),
    ("Hello!World", "Hello! World", "叹号"),
    ("done?)next", "done?) next", "组合"),
    ("v1.2beta", "v1.2beta", "小数后接字母，不动"),
    ("shown at Figure 1.Note that", "shown at Figure 1. Note that", "数字后的句号"),
    ("comparison2.However, as", "comparison2. However, as", "上标数字后的句号"),
    ("1.1 Goals of the Paper", "1.1 Goals of the Paper", "章节编号不动"),
    ("performance of 55.4%accuracy", "performance of 55.4% accuracy", "百分号后补空格"),
]

CASES_JOIN = [
    # (前一段, 后一段, 期望)
    ("representation model called BERT,", "which stands for",
     "representation model called BERT, which stands for"),
    ("such as ELMo", "Peters", "such as ELMo Peters"),
    ("multi-", "modal", "multi-modal"),
    ("研究", "方法", "研究方法"),
    ("BERT", "which", "BERT which"),
    ("(Fig. 1)", "and", "(Fig. 1) and"),
]


def main():
    ok = fail = 0
    print("=== 行内标点后补空格 ===")
    for src, want, desc in CASES_INLINE:
        got = normalise_text(src)
        mark = "OK  " if got == want else "FAIL"
        if got == want:
            ok += 1
        else:
            fail += 1
        print(f"{mark} [{desc}]")
        print(f"      in : {src!r}")
        print(f"      out: {got!r}")
        if got != want:
            print(f"      want:{want!r}")

    print("\n=== 行间合并补空格 ===")
    for a, b, want in CASES_JOIN:
        got = join(a, b)
        mark = "OK  " if got == want else "FAIL"
        if got == want:
            ok += 1
        else:
            fail += 1
        print(f"{mark} {a!r} + {b!r} -> {got!r}")
        if got != want:
            print(f"      want: {want!r}")

    print(f"\n合计: {ok} 通过 / {fail} 失败")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
