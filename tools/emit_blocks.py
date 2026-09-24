"""从真实夹具生成**结构化 blocks**，供前端渲染验证。

这是 PdfText.classifyBlock 的忠实复刻（Python 侧），
用来在**没有 JDK**的情况下验证：
  1. 分块规则产出的结构是否合理；
  2. 前端渲染 blocks 的三档标题是否正常。

输出 JSON 到 stdout，可直接喂给浏览器里的
`ScholariusReader.setText(id, text, outline, meta, blocks)`。

用法: python tools/emit_blocks.py tools/smoke/_font_2016.json
"""
import io
import json
import re
import sys
from collections import Counter

# --- 与 Kotlin 对齐 -----------------------------------------------------
BODY_SIZE_TOL = 0.35
TITLE_MAX_CHARS = 90
MIN_BODY_RATIO = 0.75
BODY_SAMPLE_MIN_CHARS = 24

LIGATURES = {
    "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
    "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st",
}
BARE_NUMBER = re.compile(r"^\d{1,2}(?:\.\d{1,2}){0,2}\.?$")
HEADING_NUM = re.compile(r"^§?\s*\d+(?:\.\d+)*\s+\S")
UPPER_HEAD = re.compile(r"^[A-Z][A-Z0-9 \-,:&'()/]{2,}$")
NUMBER_ONLY = re.compile(r"^§?\s*(\d+(\.\d+)*|[IVXLC]+)[.、]?$")
PAGE_NUMBER = re.compile(r"^\d+(?:\.\d+)?$|^[IVXLC]{1,6}\.?$")
PAGE_HEADER = re.compile(r"^\d+\s*(?:\||/|of)\s*\d+$")
SENT_END = set('.?!:;。？！：；」』）)')
PROSE_END = set('.?!:;。？！：；')

# 表格数据行（见 PdfText.looksLikeTableRow）
TABLE_ROW_MAX_CHARS = 110
TABLE_ROW_START = re.compile(r"^\d")
TABLE_NUMBER = re.compile(r"-?\d+(?:\.\d+)%?")


def looks_like_table_row(t):
    """多个数值并排 → 表格行被拉平，不是标题。"""
    if len(t) > TABLE_ROW_MAX_CHARS:
        return False
    if not TABLE_ROW_START.match(t):
        return False
    return len(TABLE_NUMBER.findall(t)[:2]) >= 2


def normalise(s):
    for k, v in LIGATURES.items():
        s = s.replace(k, v)
    return re.sub(r"[ \t]+", " ", s).strip()


def bold(name):
    n = name.lower()
    return any(k in n for k in ("bold", "black", "heavy", "medi", "semib", "cbx", "cbb", "-md"))


def estimate_body(lines, meta):
    per_page = {}
    for i, l in enumerate(lines):
        if i >= len(meta):
            break
        _, sz10, pg = meta[i]
        if sz10 <= 0 or len(l.strip()) <= BODY_SAMPLE_MIN_CHARS:
            continue
        per_page.setdefault(pg, Counter())[round(sz10 / 10.0, 1)] += 1
    votes = Counter()
    for pg, c in per_page.items():
        votes[c.most_common(1)[0][0]] += 1
    return votes.most_common(1)[0][0] if votes else 0.0


def looks_like_prose(t):
    return len(t) > 80 and t and t[-1] in PROSE_END


def heading_level(t):
    m = re.match(r"^§?\s*(\d+(?:\.\d+)*)", t.strip())
    if m:
        return min(m.group(1).count(".") + 1, 3)
    return 1


def heading_level_by_style(t, size, body):
    by = heading_level(t)
    if by > 1:
        return by
    if body <= 0:
        return 1
    return 1 if (size - body) >= 1.8 else 2


def main():
    path = sys.argv[1]
    with io.open(path, encoding="utf-8") as f:
        d = json.load(f)
    lines = d["text"].split("\n")
    meta = d["meta"]["lines"]
    fonts = d["meta"]["fonts"]
    body = estimate_body(lines, meta)

    # ---- 分块（复刻 Kotlin mergeParagraphs）----------------------------
    blocks = []
    para = []
    pmeta = None

    def ends_sentence(buf):
        s = "".join(buf).rstrip()
        return bool(s) and s[-1] in SENT_END

    def flush():
        nonlocal para, pmeta
        if not para:
            return
        t = " ".join(para)
        t = re.sub(r"(\w)- (\w)", r"\1\2", t)
        t = normalise(t)
        if t and pmeta:
            fi, sz10, pg = pmeta
            sz = sz10 / 10.0
            fn = fonts[fi] if 0 <= fi < len(fonts) else ""
            if len(t) > TITLE_MAX_CHARS:
                kind, lvl = "paragraph", 0
            elif looks_like_table_row(t):
                kind, lvl = "paragraph", 0
            elif HEADING_NUM.match(t) or (UPPER_HEAD.match(t) and len(t) >= 3):
                kind, lvl = "heading", heading_level(t)
            elif (sz > body + BODY_SIZE_TOL or (bold(fn) and sz >= body - BODY_SIZE_TOL)) \
                    and not looks_like_prose(t):
                kind, lvl = "heading", heading_level_by_style(t, sz, body)
            else:
                kind, lvl = "paragraph", 0
            blocks.append({"kind": kind, "level": lvl, "text": t, "page": pg})
        para, pmeta = [], None

    for i, raw in enumerate(lines):
        if i >= len(meta):
            break
        t = normalise(raw)
        if not t:
            flush()
            continue
        fi, sz10, pg = meta[i]
        sz = sz10 / 10.0
        if BARE_NUMBER.match(t):
            flush()
            para.append(t)
            pmeta = (fi, sz10, pg)
            continue
        if para and len(para) == 1 and BARE_NUMBER.match(para[0]):
            para.append(t)
            flush()
            continue
        if body > 0 and sz < body * MIN_BODY_RATIO:
            continue
        if (NUMBER_ONLY.match(t) or PAGE_NUMBER.match(t) or PAGE_HEADER.match(t)) and sz <= body + BODY_SIZE_TOL:
            flush()
            continue
        if looks_like_table_row(t):
            flush()
            para.append(t)
            pmeta = (fi, sz10, pg)
            continue
        fn = fonts[fi] if 0 <= fi < len(fonts) else ""
        is_head_style = sz > body + BODY_SIZE_TOL or (bold(fn) and sz >= body - BODY_SIZE_TOL)
        if is_head_style or HEADING_NUM.match(t) or UPPER_HEAD.match(t):
            flush()
            para.append(t)
            pmeta = (fi, sz10, pg)
            flush()
            continue
        if ends_sentence(para):
            flush()
            para.append(t)
            pmeta = (fi, sz10, pg)
        else:
            para.append(t)
            if pmeta is None:
                pmeta = (fi, sz10, pg)
    flush()

    kinds = Counter(b["kind"] for b in blocks)
    print(f"body={body}  blocks={len(blocks)}  "
          f"headings={kinds['heading']}  paras={kinds['paragraph']}", file=sys.stderr)

    """
    ⚠️ 用 Python 直接写文件，**不要**靠 shell 重定向。

       PowerShell 的 `>` 会把输出写成 **UTF-16 LE + BOM**，
       JSON 解析器读到第一字节 0xff 就报
       `UnicodeDecodeError: invalid start byte` ——
       实测踩过，排查时会误以为是内容编码问题。

       ⚠️ 所以这个脚本支持第二个参数指定输出路径，自己以 UTF-8 写。
    """
    if len(sys.argv) > 2:
        with io.open(sys.argv[2], "w", encoding="utf-8") as f:
            f.write(json.dumps(blocks, ensure_ascii=False))
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(blocks, ensure_ascii=False))


if __name__ == "__main__":
    main()
