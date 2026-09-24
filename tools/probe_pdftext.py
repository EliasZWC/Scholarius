"""
复刻 app 里 PdfText.kt 的算法，在本地对真实 PDF 看提取效果。

目的：v0.1.2 报告说「完全无法显示正常文本」。在改代码之前，
      先确认提取算法本身到底输出了什么 —— 是空、是乱码，还是根本没找到流。

用法：
    python tools/probe_pdftext.py <pdf> [<pdf> ...]

⚠️ 这是诊断工具，不参与构建。算法必须与 PdfText.kt 保持一致：
   一旦 PdfText.kt 改了，这里也要同步，否则诊断结论会失真。
"""

import re
import sys
import zlib
from pathlib import Path


def for_each_stream(data: bytes):
    """按字节找 stream ... endstream，与 Kotlin 端同名逻辑对应。"""
    i = 0
    n = len(data)
    while True:
        s = data.find(b"stream", i)
        if s < 0:
            return
        # stream 后面必须紧跟 CRLF 或 LF
        p = s + 6
        if data[p:p + 2] == b"\r\n":
            p += 2
        elif data[p:p + 1] == b"\n":
            p += 1
        else:
            i = s + 6
            continue
        e = data.find(b"endstream", p)
        if e < 0:
            return
        body = data[p:e]
        # endstream 前通常有个换行，去掉
        if body.endswith(b"\r\n"):
            body = body[:-2]
        elif body.endswith(b"\n") or body.endswith(b"\r"):
            body = body[:-1]
        yield body
        i = e + 9


TEXT_OPS = (b"Tj", b"TJ", b"'", b'"')


def looks_like_content(s: bytes) -> bool:
    return b"Tj" in s or b"TJ" in s or b"BT" in s


def read_literal_string(content: bytes, start: int):
    """
    start 指向 '('。返回 (raw_bytes, next_index) 或 None。
    处理转义、嵌套括号、八进制。
    """
    assert content[start:start + 1] == b"("
    i = start + 1
    depth = 1
    out = bytearray()
    while i < len(content):
        c = content[i]
        if c == 0x5C:  # backslash
            if i + 1 >= len(content):
                break
            nxt = content[i + 1]
            mapping = {
                0x6E: b"\n", 0x72: b"\r", 0x74: b"\t",
                0x62: b"\b", 0x66: b"\f",
                0x28: b"(", 0x29: b")", 0x5C: b"\\",
            }
            if nxt in mapping:
                out += mapping[nxt]
                i += 2
                continue
            if 0x30 <= nxt <= 0x37:  # octal, 1-3 digits
                j = i + 1
                digits = b""
                while j < len(content) and len(digits) < 3 and 0x30 <= content[j] <= 0x37:
                    digits += content[j:j + 1]
                    j += 1
                out.append(int(digits, 8) & 0xFF)
                i = j
                continue
            # 其它转义：丢掉反斜杠，保留字符（PDF 规范说未知转义应忽略反斜杠）
            out.append(nxt)
            i += 2
            continue
        if c == 0x28:
            depth += 1
            out.append(c)
            i += 1
            continue
        if c == 0x29:
            depth -= 1
            if depth == 0:
                return bytes(out), i + 1
            out.append(c)
            i += 1
            continue
        out.append(c)
        i += 1
    return None


def read_hex_string(content: bytes, start: int):
    """start 指向 '<'。返回 (raw_bytes, next_index) 或 None。"""
    end = content.find(b">", start)
    if end < 0:
        return None
    digits = re.sub(rb"[^0-9A-Fa-f]", b"", content[start + 1:end])
    if len(digits) % 2:
        digits += b"0"
    return bytes.fromhex(digits.decode("ascii")), end + 1


def is_followed_by_text_op(content: bytes, from_: int) -> bool:
    i = from_
    n = len(content)
    while i < n:
        c = content[i:i + 1]
        if c in (b" ", b"\r", b"\n", b"\t", b"\x00"):
            i += 1
            continue
        if c in (b"]", b"["):
            i += 1
            continue
        rest = content[i:i + 2]
        if rest in (b"Tj", b"TJ"):
            return True
        if c in (b"'", b'"'):
            return True
        return False
    return False


def decode_bytes(raw: bytes) -> str:
    """与 Kotlin 端一致：UTF-16BE BOM / ASCII；高字节多则判为不可解。"""
    if raw.startswith(b"\xfe\xff"):
        try:
            return raw[2:].decode("utf-16-be")
        except Exception:
            return ""
    if raw.startswith(b"\xef\xbb\xbf"):
        try:
            return raw[3:].decode("utf-8")
        except Exception:
            return ""
    high = sum(1 for b in raw if b >= 0x80)
    if raw and high * 3 > len(raw):
        return ""  # 高字节占比 > 1/3 → 判为乱码
    try:
        return raw.decode("latin-1")
    except Exception:
        return ""


def extract_from_content(content: bytes, out: list) -> None:
    """扫描内容流里的字符串字面量与十六进制串。"""
    i = 0
    n = len(content)
    while i < n:
        c = content[i:i + 1]
        if c == b"(":
            r = read_literal_string(content, i)
            if r:
                raw, nxt = r
                if is_followed_by_text_op(content, nxt):
                    out.append(decode_bytes(raw))
                i = nxt
                continue
        elif c == b"<" and content[i:i + 2] != b"<<":
            r = read_hex_string(content, i)
            if r:
                raw, nxt = r
                if is_followed_by_text_op(content, nxt):
                    out.append(decode_bytes(raw))
                i = nxt
                continue
        i += 1


def extract(pdf: Path):
    data = pdf.read_bytes()
    report = {
        "file": str(pdf),
        "size": len(data),
        "streams": 0,
        "content_streams": 0,
        "inflated_ok": 0,
        "inflate_failed": 0,
        "strings_found": 0,
        "strings_decoded": 0,
        "text": "",
    }
    chunks: list[str] = []
    for body in for_each_stream(data):
        report["streams"] += 1
        candidates = []
        # ① 原文直接解析
        if looks_like_content(body):
            report["content_streams"] += 1
            candidates.append(body)
        else:
            # ② 尝试解压
            try:
                inf = zlib.decompress(body)
                report["inflated_ok"] += 1
                if looks_like_content(inf):
                    report["content_streams"] += 1
                    candidates.append(inf)
            except Exception:
                report["inflate_failed"] += 1
        for c in candidates:
            out: list[str] = []
            extract_from_content(c, out)
            report["strings_found"] += len(out)
            for s in out:
                report["strings_decoded"] += 1 if s else 0
                chunks.append(s)

    report["text"] = "".join(chunks)
    return report


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return
    for arg in sys.argv[1:]:
        p = Path(arg)
        if not p.exists():
            print(f"!! not found: {p}")
            continue
        r = extract(p)
        print("=" * 78)
        print(f"file        : {Path(r['file']).name}")
        print(f"size        : {r['size']:,} bytes")
        print(f"streams     : {r['streams']}  (content-like: {r['content_streams']})")
        print(f"inflate     : ok {r['inflated_ok']} / failed {r['inflate_failed']}")
        print(f"strings     : found {r['strings_found']}, non-empty {r['strings_decoded']}")
        print(f"text length : {len(r['text']):,} chars")
        print("-" * 78)
        sample = r["text"][:600]
        print(repr(sample) if sample else "(EMPTY)")
        print()


if __name__ == "__main__":
    main()
