# 年份提取验证脚本。
#
# 目的：用真实论文检查 PdfMeta 的年份提取逻辑是否正确。
#
# ⚠️ 这个脚本**不编译 Kotlin**（本机没有 JDK/Android SDK）。
#    它用 Python 复刻 PdfMeta.extractYear 的**同一套规则**，
#    在同样的输入上跑，用来验证「规则本身对不对」。
#
#    若规则在 Python 里能正确工作，说明判据站得住；
#    Kotlin 侧只要逐字翻译过去就是对的。
#    这**不能**替代真机验证，但能在没有 JDK 的情况下排除规则性错误。

from __future__ import annotations

import re
import sys
from pathlib import Path

# ---- 与 PdfMeta.kt 一一对应的常量 ------------------------------------------

YEAR_MIN = 1850
CURRENT_YEAR = 2026

# ① 2015 IEEE / 2016 ACM / 2015 Springer
RE_PUBLISHER = re.compile(
    r"\b((?:19|20)\d{2})\s+(?:IEEE|ACM|Springer|Elsevier|Wiley|Cambridge|Oxford|MIT Press)\b",
    re.IGNORECASE,
)

# ② CVPR 2016 / ICML 2015 / NeurIPS 2017
RE_CONFERENCE = re.compile(
    r"\b(?:CVPR|ICCV|ECCV|ICML|ICLR|NIPS|NeurIPS|ACL|EMNLP|NAACL|AAAI|IJCAI|SIGIR|KDD|WWW|ICDM|CIKM)"
    r"[\s'’]*((?:19|20)\d{2})\b",
    re.IGNORECASE,
)

# ③ © 2015 / (c) 2015 / Copyright 2015
RE_COPYRIGHT = re.compile(
    r"(?:©|\(c\)|copyright)[^\n]{0,24}?\b((?:19|20)\d{2})\b",
    re.IGNORECASE,
)

# XMP 日期字段
RE_XMP_PUBDATE = re.compile(r"prism:publicationDate[^>]*?>\s*([^<]+)", re.IGNORECASE)
RE_XMP_DCDATE = re.compile(r"<dc:date[^>]*?>\s*(?:<rdf:li[^>]*>)?\s*([^<]+)", re.IGNORECASE)
RE_FOUR_DIGIT = re.compile(r"\b((?:19|20)\d{2})\b")


def is_plausible(year: str) -> bool:
    n = int(year) if year.isdigit() else -1
    return YEAR_MIN <= n <= CURRENT_YEAR + 1


def extract_four_digit(value: str) -> str:
    if not value:
        return ""
    m = RE_FOUR_DIGIT.search(value)
    if not m:
        return ""
    y = m.group(1)
    return y if is_plausible(y) else ""


def year_from_info(subject: str, keywords: str) -> str:
    hay = " ".join(x for x in (subject, keywords) if x)
    if not hay.strip():
        return ""
    for pattern in (RE_PUBLISHER, RE_CONFERENCE, RE_COPYRIGHT):
        m = pattern.search(hay)
        if m:
            y = m.group(1)
            if is_plausible(y):
                return y
    return ""


# ---- PDF 元数据读取（只用标准库，不依赖 PyMuPDF） ---------------------------


def read_info_dict(raw: bytes) -> dict[str, str]:
    """复刻 PdfMeta.readInfoDict：找 /Info 对象，解析四个字段。"""
    text = raw.decode("latin-1")
    info_obj = re.search(r"/Info\s+(\d+)\s+\d+\s+R", text)
    scope = text
    if info_obj:
        num = info_obj.group(1)
        m = re.search(r"(?m)^\s*" + num + r"\s+0\s+obj\b", text)
        if m:
            start = m.end()
            end = text.find("endobj", start)
            end = end if end > 0 else len(text)
            scope = text[start:min(end, start + 20000)]

    out = {}
    for field in ("Title", "Author", "Subject", "Keywords"):
        hexm = re.search(r"/" + field + r"\s*<([0-9A-Fa-f\s]+)>", scope)
        if hexm:
            try:
                b = bytes.fromhex(re.sub(r"\s", "", hexm.group(1)))
                s = b.decode("utf-16-be" if b[:2] == b"\xfe\xff" else "latin-1", "replace")
                if s.strip():
                    out[field] = s
            except Exception:
                pass
            continue
        lit = re.search(r"/" + field + r"\s*\(", scope)
        if lit:
            i = lit.end()
            buf = []
            depth = 1
            while i < len(scope) and depth > 0:
                ch = scope[i]
                if ch == "\\" and i + 1 < len(scope):
                    buf.append(scope[i + 1])
                    i += 2
                    continue
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        break
                buf.append(ch)
                i += 1
            out[field] = "".join(buf)
    return out


def read_xmp(raw: bytes) -> tuple[str, str]:
    """返回 (标题, 年份)。年份按 prism:publicationDate → dc:date 顺序。"""
    text = raw.decode("latin-1")
    start = text.find("<x:xmpmeta")
    if start < 0:
        return "", ""
    end = text.find("</x:xmpmeta>", start)
    xmp = text[start:end + 12] if end > 0 else text[start:]

    year = ""
    for pattern in (RE_XMP_PUBDATE, RE_XMP_DCDATE):
        m = pattern.search(xmp)
        if m:
            y = extract_four_digit(m.group(1))
            if y:
                year = y
                break
    return xmp, year


def extract_year(pdf: Path) -> tuple[str, str]:
    """返回 (年份, 来源说明)。"""
    raw = pdf.read_bytes()

    _, xmp_year = read_xmp(raw)
    if xmp_year:
        return xmp_year, "XMP"

    info = read_info_dict(raw)
    y = year_from_info(info.get("Subject", ""), info.get("Keywords", ""))
    if y:
        return y, "Info"

    return "", "没抓到"


# ---- 主流程 ----------------------------------------------------------------

# 文件名里大多带年份，可以当预期值比对（带年份的才纳入准确率统计）
FILES = [
    "2012_CNN提出_NIPS_Krizhevsky.pdf",
    "2013_Word2Vec提出.pdf",
    "2016_YOLO提出_CVPR_Redmon.pdf",
    "2016_残差连接提出_CVPR_He.pdf",
    "2022_LLM思维链提出_NIPS_Wei.pdf",
    "BERT提出.pdf",
    "LLM的幂律缩放.pdf",
    "UNet提出.pdf",
    "自回归大模型提出.pdf",
    "1986_反向传播算法提出_Nature_Rumelhart.pdf",
    "2015_深度学习里程碑综述_Nature_LeCun.pdf",
    "2017_Transformer提出纯注意力模型_NIPS_Vaswani.pdf",
]


def expected_year(name: str) -> str:
    """从文件名开头抠出预期年份，抠不到返回空串。"""
    m = re.match(r"^((?:19|20)\d{2})_", name)
    return m.group(1) if m else ""


def find_pdf(root: Path, name: str) -> Path | None:
    """在 root 下递归找同名 PDF（子目录结构会变，不做硬编码）。"""
    direct = root / name
    if direct.exists():
        return direct
    hits = list(root.rglob(name))
    return hits[0] if hits else None


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if root is None or not root.exists():
        print("用法: python tools/check-year.py <PDF 所在目录>")
        return 2

    print(f"{'文件':<44} {'预期':>5} {'实得':>5}  {'来源':<8} Subject（截断）")
    print("-" * 118)

    hit = 0
    wrong = 0
    checked = 0
    for name in FILES:
        pdf = find_pdf(root, name)
        if pdf is None:
            print(f"{name[:42]:<44} {'(缺失)':>5}")
            continue
        year, source = extract_year(pdf)
        want = expected_year(name)
        info = read_info_dict(pdf.read_bytes())
        subject = (info.get("Subject") or "").replace("\n", " ")[:44]

        mark = ""
        if want:
            checked += 1
            if year == want:
                hit += 1
            elif year:
                wrong += 1
                mark = "  ← 错"
            else:
                mark = "  ← 未抓到"
        elif year:
            mark = "  (文件名无年份，无法判对错)"

        print(f"{name[:42]:<44} {want or '—':>5} {year or '—':>5}  {source:<8} {subject}{mark}")

    print("-" * 118)
    print(f"有预期值 {checked} 篇：正确 {hit}，错误 {wrong}，未抓到 {checked - hit - wrong}")
    print("未抓到 = 留空（可接受）；**错误 = 必须修**，这是最坏的结果。")
    return 1 if wrong else 0


if __name__ == "__main__":
    raise SystemExit(main())
