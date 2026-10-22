# -*- coding: utf-8 -*-
"""验证 Markdown 导出规则（v0.1.91）。

⚠️ 本机没有 Node 测试框架，用 Python 复刻 `www/md.js` 的规则跑样例。
   规则改动时**两边必须一起改**，否则这个检查会变成"检查另一份实现"。

对齐关系：
    md.js  headingPrefix()   ←→  heading_prefix()
    md.js  toMarkdown()      ←→  to_markdown()
"""
import re
import sys

# 文献条目起始标记（行首）：`[12]` 或 `12.`
REF_START = re.compile(r'^\s*(\[\d+\]|\d+[\.\u3001])\s')


def heading_prefix(kind, level, is_first):
    if kind != 'heading':
        return ''
    lv = level or 0
    if is_first:
        return '#'
    if lv <= 1:
        return '##'
    if lv == 2:
        return '###'
    return '####'


def clean_lines(text):
    return [l.strip() for l in str(text or '').split('\n') if l.strip()]


def group_entries(rows, re_start):
    groups = []
    cur = None
    for row in rows:
        line = row.strip()
        if not line:
            continue
        if re_start.match(line):
            if cur:
                groups.append(cur)
            cur = [line]
        elif cur is not None:
            cur.append(line)
        else:
            cur = [line]
    if cur:
        groups.append(cur)
    return groups


def to_markdown(blocks):
    out = []
    seen = False
    ref = 0

    for b in blocks:
        text = str(b.get('text') or '')
        if not text.strip():
            continue
        kind = b.get('kind') or 'body'
        is_first = not seen
        seen = True

        pref = heading_prefix(kind, b.get('level'), is_first)
        if pref:
            out.append(pref + ' ' + re.sub(r'\s*\n\s*', ' ', text).strip())
            continue

        if kind in ('author', 'reference'):
            lines = b.get('lines') or []
            rows = lines if len(lines) > 1 else clean_lines(text)
            if kind == 'reference':
                for group in group_entries(rows, REF_START):
                    ref += 1
                    out.append('%d. %s' % (ref, ' '.join(group)))
            else:
                for r in rows:
                    out.append('- ' + r)
            continue

        # 正文一律输出合并后的 text（不硬换行）——
        # `lines` 是排版折行，不是语义换行，见 www/md.js 里的说明。
        out.append(text.strip())

    return ('\n\n'.join(out) + '\n') if out else ''


CASES = []


def case(name, blocks, expect):
    CASES.append((name, blocks, expect))


# ①② 标题层级
case('文章标题 → #',
     [{'kind': 'heading', 'level': 1, 'text': 'Attention Is All You Need'}],
     '# Attention Is All You Need\n')

case('一级标题 → ##',
     [{'kind': 'heading', 'level': 1, 'text': 'Title'},
      {'kind': 'heading', 'level': 1, 'text': '1 Introduction'}],
     '# Title\n\n## 1 Introduction\n')

case('二级标题 → ###',
     [{'kind': 'heading', 'level': 1, 'text': 'T'},
      {'kind': 'heading', 'level': 2, 'text': '1.1 Goals'}],
     '# T\n\n### 1.1 Goals\n')

case('三级标题 → ####',
     [{'kind': 'heading', 'level': 1, 'text': 'T'},
      {'kind': 'heading', 'level': 3, 'text': '1.1.1 Detail'}],
     '# T\n\n#### 1.1.1 Detail\n')

# ③ 作者 → 无序列表（每行一项）
case('作者信息 → 无序列表',
     [{'kind': 'author', 'text': 'Jacob Devlin, Ming-Wei Chang\nGoogle AI Language',
       'lines': ['Jacob Devlin, Ming-Wei Chang', 'Google AI Language']}],
     '- Jacob Devlin, Ming-Wei Chang\n\n- Google AI Language\n')

# ④ 文献 → 有序列表（跨块连续编号）
case('文献 → 有序列表（跨块连续）',
     [{'kind': 'reference', 'text': 'A. Author. Paper one. 2015.'},
      {'kind': 'reference', 'text': 'B. Author. Paper two. 2016.'}],
     '1. A. Author. Paper one. 2015.\n\n2. B. Author. Paper two. 2016.\n')

# 一条文献的**排版折行**不能被拆成多个编号项
case('文献折行合并为一条',
     [{'kind': 'reference',
       'text': '[3] T. Brants, A.C. Popat. Large language models in machine '
               'translation. In Proceedings, 2007.',
       'lines': ['[3] T. Brants, A.C. Popat. Large language models in machine',
                 'translation. In Proceedings, 2007.']},
      {'kind': 'reference', 'text': '[4] R. Collobert. A Unified Architecture. 2008.'}],
     '1. [3] T. Brants, A.C. Popat. Large language models in machine translation. In Proceedings, 2007.\n'
     '\n2. [4] R. Collobert. A Unified Architecture. 2008.\n')

# ⑤ 正文：不能用列表；段内换行 = 硬换行
case('正文不使用列表',
     [{'kind': 'heading', 'level': 1, 'text': 'T'},
      {'kind': 'paragraph', 'text': 'Body text without any list marker.'}],
     '# T\n\nBody text without any list marker.\n')

# 正文段内的 lines 是**排版折行**，不能导出成硬换行
case('正文忽略 lines（排版折行不成硬换行）',
     [{'kind': 'paragraph', 'text': 'line one line two',
       'lines': ['line one', 'line two']}],
     'line one line two\n')

# ⑥ 空块被跳过
case('空块跳过',
     [{'kind': 'heading', 'level': 1, 'text': 'T'},
      {'kind': 'paragraph', 'text': '   '},
      {'kind': 'paragraph', 'text': 'X'}],
     '# T\n\nX\n')

# ⑦ 只有一块时也必须是 #
case('首块非标题时第二块才是 ##',
     [{'kind': 'paragraph', 'text': 'preamble'},
      {'kind': 'heading', 'level': 1, 'text': 'Chapter'}],
     'preamble\n\n## Chapter\n')


def main():
    failed = 0
    for name, blocks, expect in CASES:
        got = to_markdown(blocks)
        if got == expect:
            print('OK   %s' % name)
        else:
            failed += 1
            print('FAIL %s' % name)
            print('  期望: %r' % expect)
            print('  实际: %r' % got)
    print()
    print('合计: %d 通过 / %d 失败' % (len(CASES) - failed, failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
