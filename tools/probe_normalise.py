"""复刻 PdfText.normalise 的算法，在真实 PDF 上看整理前后的差别。

用途：改 Android 代码前先验证「软换行合并」是否真的让正文可读。
      算法必须与 PdfText.kt 的 normalise 一致，改了要同步。
"""
import re
import sys
from pathlib import Path

import pymupdf

SENTENCE_END = set('.!?:;。？！：；」』）)"')


def ends_sentence(s: str) -> bool:
    for c in reversed(s):
        if c == ' ':
            continue
        return c in SENTENCE_END
    return False


def is_short(s: str) -> bool:
    """短行：标题、作者、单位这类。正文行通常很长。"""
    return len(s) <= 60


def looks_like_head(s: str) -> bool:
    """像标题/作者/单位/编号的行 —— 这些不该被合并进正文。"""
    # 独立编号
    if re.fullmatch(r'§?\s*(\d+(\.\d+)*|[IVXLC]+)[.、]?', s):
        return True
    # 全大写（标题）
    if re.fullmatch(r"[A-Z][A-Z0-9 \-,:&'()/]{2,}", s):
        return True
    # 短行，且不含句末标点（不是完整句子）
    if is_short(s) and not any(c in SENTENCE_END for c in s):
        return True
    return False


def needs_space(a: str, b: str) -> bool:
    if not a or not b:
        return False
    last, first = a[-1], b[0]
    if last == '-':
        return False
    last_word = last.isalnum() and ord(last) < 0x2E80
    first_word = first.isalnum() and ord(first) < 0x2E80
    return last_word and first_word


def normalise(raw: str) -> str:
    """把排版换行合并回段落；标题/编号等短行各自独立成行。"""
    out = []
    para = ''
    for line in raw.split('\n'):
        t = line.strip()
        if not t:
            if para:
                out.append(para)
                para = ''
            continue

        head = looks_like_head(t)

        if not para:
            para = t
            continue

        # 当前行像标题 → 先把已积累的收掉，自己独立
        if head:
            out.append(para)
            para = t
            continue

        # 已积累的内容是标题 → 标题独立，正文另起
        if looks_like_head(para):
            out.append(para)
            para = t
            continue

        if ends_sentence(para):
            out.append(para)
            para = t
        else:
            if needs_space(para, t):
                para += ' '
            para += t

    if para:
        out.append(para)
    return '\n\n'.join(out)


def main() -> None:
    pdf = Path(sys.argv[1])
    doc = pymupdf.open(str(pdf))
    raw_pages = [doc[i].get_text() for i in range(min(4, doc.page_count))]
    raw = '\n\n'.join(raw_pages)

    print('=' * 78)
    print('BEFORE normalise (raw, first 700 chars)')
    print('=' * 78)
    print(raw[:700])

    print()
    print('=' * 78)
    print('AFTER normalise (first 1200 chars)')
    print('=' * 78)
    print(normalise(raw)[:1200])

    print()
    print('=' * 78)
    print('paragraph count:', len(normalise(raw).split('\n\n')))
    print('raw lines      :', len(raw.split('\n')))
    print('result lines   :', len(normalise(raw).split('\n')))


if __name__ == '__main__':
    main()
