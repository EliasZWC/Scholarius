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


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '_test.pdf')
    pages = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    size = build_pdf(out, pages)
    print('%s  (%d pages, %d bytes)' % (out, pages, size))


if __name__ == '__main__':
    main()
