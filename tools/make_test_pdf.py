# -*- coding: utf-8 -*-
"""造一个最小可用的多页 PDF，用于本地测试阅读器/标注。

不引第三方库：手写 PDF 结构（xref 表 + 目录 + 页面树）。
正文用 Helvetica 写几行字，够 PdfText 抽出一点文本来验证。

用法：
    python tools/make_test_pdf.py                    # -> tools/_test.pdf
    python tools/make_test_pdf.py out.pdf 5          # 5 页
"""
import os
import sys


def build_pdf(path, pages=3, title='Scholarius Test Document'):
    objs = []          # 每个元素是一段 obj 体（不含 "N 0 obj" 包装）

    # 1 = 目录, 2 = 页面树
    # 页面从 3 开始：3=page,4=content,5=page,6=content ...
    page_ids = [3 + 2 * i for i in range(pages)]
    content_ids = [4 + 2 * i for i in range(pages)]
    font_id = 3 + 2 * pages

    kids = ' '.join('%d 0 R' % i for i in page_ids)
    objs.append('<< /Type /Catalog /Pages 2 0 R >>')
    objs.append('<< /Type /Pages /Kids [%s] /Count %d >>' % (kids, pages))

    for i in range(pages):
        body = '\n'.join([
            'BT',
            '/F1 24 Tf',
            '72 700 Td',
            '(Scholarius Test PDF) Tj',
            '0 -40 Td',
            '/F1 14 Tf',
            '(Page %d of %d) Tj' % (i + 1, pages),
            '0 -30 Td',
            '(Author: EliasZWC) Tj',
            '0 -30 Td',
            '(Year: 2024) Tj',
            '0 -30 Td',
            '(Venue: TestConf) Tj',
            '0 -60 Td',
            '(This line exists so PdfText has something to extract.) Tj',
            'ET',
        ])
        stream = body.encode('latin-1')
        objs.append(
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
            '/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>'
            % (font_id, content_ids[i])
        )
        objs.append('<< /Length %d >>\nstream\n%s\nendstream'
                    % (len(stream), stream.decode('latin-1')))

    objs.append('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
                '/Encoding /WinAnsiEncoding >>')

    # --- 组装 + 记录每个 obj 的字节偏移 ---
    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += ('%d 0 obj\n%s\nendobj\n' % (i, body)).encode('latin-1')

    xref_at = len(out)
    n = len(objs) + 1
    out += ('xref\n0 %d\n' % n).encode('latin-1')
    out += b'0000000000 65535 f \n'
    for i in range(1, n):
        out += ('%010d 00000 n \n' % offsets[i]).encode('latin-1')
    out += ('trailer\n<< /Size %d /Root 1 0 R /Info << /Title (%s) '
            '/Author (EliasZWC) /Producer (make_test_pdf.py) >> >>\n'
            'startxref\n%d\n%%%%EOF\n' % (n, title, xref_at)).encode('latin-1')

    with open(path, 'wb') as f:
        f.write(out)
    return len(out)


def build_paper(path, pages=2):
    """造一个**接近真实论文**的 PDF，用于复现"自动识别的框很乱"这类问题。

    为什么要这个模式（2026-09-25）：
        原来的 build_pdf 每页只有 6 行同字号文字，PdfText 抽出来的块
        太少（实测 2 个），复现不出用户报的"框是乱的 / 清不掉的框"。
        真实论文的特征是：
          · **多种字号**（标题 18pt / 章节 13pt / 正文 10pt）
          · **多个文本块**（标题、作者、摘要、各章节正文）
          · **块之间有交错的行号**（原生按字号切块，块序 ≠ 视觉序）
        这三个特征正是原生判定"乱"的来源。

    页码/坐标都写成 612x792（Letter），与真实论文一致。
    """
    objs = []
    page_ids = [3 + 2 * i for i in range(pages)]
    content_ids = [4 + 2 * i for i in range(pages)]
    font_id = 3 + 2 * pages

    kids = ' '.join('%d 0 R' % i for i in page_ids)
    objs.append('<< /Type /Catalog /Pages 2 0 R >>')
    objs.append('<< /Type /Pages /Kids [%s] /Count %d >>' % (kids, pages))

    # 每页的文本行：(字号, x, 文字)
    #
    # ⚠️⚠️ 关于"多行块"（2026-09-25 重要修正）
    #
    # 初版每行都写成独立的 `Tm`（text matrix），结果 PdfText 把**每一行**
    # 都切成一个独立的块（实测 28 个块、每个高 3~7px）。
    # 而真实论文里一个段落是**一个多行块**。
    #
    # 这个差别直接影响 textMarks 的区间计算：
    #     applyTextType: to = from + block.text.split('\n').length - 1
    #   单行块 → to == from；多行块 → to > from。
    # 而用户报的"框删不掉"很可能只在**多行块**下出现
    # （删除时算的区间与标注时不一致）。
    #
    # 所以这里改成：正文用 **T* 行距操作符**连续排（一个 BT..ET 里
    # 多次 T* 而不重置 Tm），让 PdfText 有机会把它们合并成一个块。
    def page_lines(pg):
        """返回 [(字号, x, 文字), ...]，同字号连续行用 T* 换行。"""
        out = []
        out.append((18, 72, 'A Study of Something Important'))
        out.append((11, 72, 'Alice Zhang, Bob Li, Carol Wang'))
        out.append((10, 72, 'Department of Computer Science, Some University'))
        out.append((12, 72, 'Abstract'))
        # 摘要：4 行**同字号且 x 相同** → 期望被合并成一个多行块
        for k in range(4):
            out.append((10, 72,
                        'Abstract line %d. This sentence exists so the '
                        'extractor has real text to work with.' % (k + 1)))
        out.append((12, 72, '1  Introduction'))
        for k in range(5):
            out.append((10, 72,
                        'Body paragraph line %d of page %d. More text here '
                        'to make the block reasonably tall.' % (k + 1, pg)))
        out.append((12, 72, '2  Method'))
        for k in range(4):
            out.append((10, 72,
                        'Method detail line %d. We describe the approach '
                        'in enough words to fill a line.' % (k + 1)))
        out.append((10, 72, 'Figure 1: A diagram of the system.'))
        out.append((12, 72, '3  Results'))
        for k in range(4):
            out.append((10, 72,
                        'Result line %d showing measured values of the '
                        'proposed method.' % (k + 1)))
        out.append((9, 72, 'References'))
        for k in range(3):
            out.append((9, 72,
                        '[%d] A. Author. Title of paper. In Proc. of '
                        'Something, 20%02d.' % (k + 1, 10 + k)))
        return out

    for i in range(pages):
        parts = ['BT']
        y = 720
        prev_size = None
        for size, x, text in page_lines(i + 1):
            esc = text.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')
            if size != prev_size:
                parts.append('/F1 %d Tf' % size)
                # 换字号 → 重设文本矩阵（新的块从这里开始）
                parts.append('1 0 0 1 %d %d Tm' % (x, y))
                prev_size = size
            else:
                # ⚠️ 同字号连续行**不重设 Tm**，只用 T* 下移一行 ——
                #    这样文本流是连续的，PdfText 有机会合并成一个多行块。
                #    重设 Tm 会被当成新块的起点，实测导致"每行一个块"。
                parts.append('0 -%d Td' % int(size * 1.8))
            parts.append('(%s) Tj' % esc)
        parts.append('ET')
        stream = '\n'.join(parts).encode('latin-1')
        objs.append(
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
            '/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>'
            % (font_id, content_ids[i])
        )
        objs.append('<< /Length %d >>\nstream\n%s\nendstream'
                    % (len(stream), stream.decode('latin-1')))

    objs.append('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
                '/Encoding /WinAnsiEncoding >>')

    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += ('%d 0 obj\n%s\nendobj\n' % (i, body)).encode('latin-1')

    xref_at = len(out)
    n = len(objs) + 1
    out += ('xref\n0 %d\n' % n).encode('latin-1')
    out += b'0000000000 65535 f \n'
    for i in range(1, n):
        out += ('%010d 00000 n \n' % offsets[i]).encode('latin-1')
    out += ('trailer\n<< /Size %d /Root 1 0 R /Info << /Title '
            '(A Study of Something Important) /Author (EliasZWC) '
            '/Producer (make_test_pdf.py) >> >>\nstartxref\n%d\n%%%%EOF\n'
            % (n, xref_at)).encode('latin-1')

    with open(path, 'wb') as f:
        f.write(out)
    return len(out)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    paper = '--paper' in sys.argv
    out = args[0] if args else os.path.join(here, '_test.pdf')
    pages = int(args[1]) if len(args) > 1 else 3
    if paper:
        size = build_paper(out, pages)
        print('%s  (%d pages, %d bytes, paper mode)' % (out, pages, size))
    else:
        size = build_pdf(out, pages)
        print('%s  (%d pages, %d bytes)' % (out, pages, size))


if __name__ == '__main__':
    main()
