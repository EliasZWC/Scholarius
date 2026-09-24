"""生成带字体元数据的夹具（模拟 PDFBox LineCollector 的输出）。

PDFBox 侧的输出 = {fonts:[名], lines:[[fontIdx, sizeX10, page]]}
正文行 = 已合并段落的行文本（PDFBox mergeParagraphs 的产物）。

═══ ⚠️ 2026-09-24 重写：旧版用**有 bug 的规则**生成夹具 ═══

旧版这里写的是 `SHORT = 60` + `len(s) <= SHORT and 末字符不是句末标点`，
与 PdfText.looksLikeHead 的 bug **一模一样**。

后果：夹具里的 `text` 是被同一个 bug 切碎的结果，
拿它验证新规则时看到的是"污染过的输入" ——
实测 ResNet 夹具里 71% 的行被判成独立块，
但那正是"用 bug 去衡量 bug"（循环论证）。

现在改用**与新版 PdfText 一致**的规则：
  ① 字号 > 正文字号 + 容差  → 独立块（主判据）
  ② 粗体 + 短               → 独立块
  ③ 编号标题 / 全大写        → 独立块
  ④ 纯编号（章节号单独成行）  → 与下一行标题合并
  ⑤ 其余按句末标点归并
  ⑥ 连字（ﬁ ﬂ）还原、断词（`re- search`）还原

用法：
    python tools/make_font_fixture.py "<论文.pdf>"
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pymupdf

# --- 与 PdfText.kt 对齐的常量 -------------------------------------------
BODY_SIZE_TOL = 0.35
TITLE_MAX_CHARS = 90

"""
正文的最小字号比例。

⚠️ 低于 `body * MIN_BODY_RATIO` 的行**不是正文**，是图表刻度、脚注、页码：
   实测 ResNet 论文里有一整批 `3.3pt` 的 `0 1 2 3 4 5 6`（训练曲线的坐标轴刻度），
   还有 `6.6pt` 的 `training error (%)`（坐标轴标题）。
   正文字号 10.0pt → 3.3pt 只有 33%。

⚠️ 这些内容**必须丢掉**，不能进正文：
   · 它们不是句子，读起来是乱码（`0 1 2 3 4 5 6`）；
   · 数量极大（一张图几十行），会把段落统计彻底污染 ——
     实测 2016 的"短段落占比"高达 51.8%，其中绝大多数是这些刻度。

⚠️ 取 0.75 而不是更激进的值：论文正文里**上标/下标**可能到 0.8 倍
   （`x²`、`H₂O`），脚注常是 0.85-0.9 倍。0.75 能把图表刻度筛掉，
   又不至于误伤脚注（脚注是完整句子，留着无害）。
"""
MIN_BODY_RATIO = 0.75

LIGATURES = {
    "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
    "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st",
}

SENT_END = set('.?!:;。？！：；」』）)"')

HEADING_NUM = re.compile(r"^§?\s*\d+(?:\.\d+)*\.?\s+\S")
UPPER_HEAD = re.compile(r"^[A-Z][A-Z0-9 \-,:&'()/]{2,}$")
PAGE_NUMBER = re.compile(r"^[-–—\s]*(\d{1,4}|[IVXLC]{1,7})[-–—\s]*$")
BARE_NUMBER = re.compile(r"^\d{1,2}(?:\.\d{1,2}){0,2}\.?$")


def normalize(s: str) -> str:
    """连字还原 + 空白规范化。"""
    for k, v in LIGATURES.items():
        s = s.replace(k, v)
    return re.sub(r"[ \t]+", " ", s).strip()


def is_bold_font(name: str) -> bool:
    n = name.lower()
    return any(k in n for k in (
        "bold", "black", "heavy", "medi", "-md", "semib", "cbx", "cbb"
    ))


def main():
    pdf = Path(sys.argv[1])
    doc = pymupdf.open(str(pdf))

    # ---- 逐行取 (文本, 主字体, 主字号, 页码) ---------------------------
    raw = []
    for pno, page in enumerate(doc, 1):
        d = page.get_text("dict")
        for b in d.get("blocks", []):
            if b.get("type") != 0:
                continue
            for ln in b.get("lines", []):
                spans = ln.get("spans", [])
                if not spans:
                    continue
                text = "".join(sp.get("text", "") for sp in spans)
                if not text.strip():
                    continue
                w, sw = Counter(), Counter()
                for sp in spans:
                    n = len(sp.get("text", ""))
                    w[sp["font"]] += n
                    sw[round(sp["size"] * 10)] += n
                font = w.most_common(1)[0][0]
                size = sw.most_common(1)[0][0] / 10
                raw.append((normalize(text), font, size, pno))

    # ---- 估正文字号（页级众数再投票）---------------------------------
    per_page = {}
    for text, font, size, pno in raw:
        if len(text) <= 24:
            continue
        per_page.setdefault(pno, Counter())[round(size, 1)] += 1
    votes = Counter()
    for pno, c in per_page.items():
        votes[c.most_common(1)[0][0]] += 1
    body = votes.most_common(1)[0][0] if votes else 0.0
    print(f"  body size    : {body}")

    # ---- 分块 ---------------------------------------------------------
    out_lines = []      # [(text, (font, size, page))]
    para = []
    meta = None

    def flush():
        nonlocal para, meta
        if not para:
            return
        t = " ".join(para).strip()
        # 断词还原：合并时用 " " 连接，所以形态是 `re- search`
        t = re.sub(r"(\w)- (\w)", r"\1\2", t)
        if t:
            out_lines.append((t, meta))
        para, meta = [], None

    for text, font, size, pno in raw:
        t = text.strip()
        if not t:
            flush()
            continue

        bigger = body > 0 and size > body + BODY_SIZE_TOL

        # ⓪ 图表刻度 / 脚注 / 页码：字号远小于正文 → 直接丢弃
        #    ⚠️ 必须放在最前面 —— 否则这些 1 字符行会被当成"独立块"，
        #       把段落统计与阅读体验全毁掉（见 MIN_BODY_RATIO 的注释）。
        if body > 0 and size < body * MIN_BODY_RATIO:
            continue

        # ① 页眉/页码（先排除"章节号单独成行"）
        if PAGE_NUMBER.match(t) and not BARE_NUMBER.match(t) and not bigger:
            flush()
            continue

        """
        ⚠️ ①′ **纯编号（章节号单独成行）必须最先判**。

           PDF 的章节号有两种排法：
             a) `3.1 Problem Formulation`   —— 编号与标题同一行
             b) `3.1` / `Problem Formulation` —— 编号单独一行（本模板）

           本模板里编号行**也是粗体**，若按"粗体→独立块"处理，
           它会自己成为一个 3 字符的孤立块（实测 Word2Vec 中位数掉到 13）。

           所以**先**识别纯编号，攒进 para；紧跟的标题行由
           下面的 ⑥ 无条件接上，合成 `3.1 Problem Formulation`。
        """
        if BARE_NUMBER.match(t):
            flush()
            para.append(t)
            meta = (font, size, pno)
            continue

        # ①″ 上一行刚攒下章节号 → 这一行就是它的标题，无条件接上
        if para and len(para) == 1 and BARE_NUMBER.match(para[0]):
            para.append(t)
            flush()
            continue

        # ② 字号大于正文 → 独立块
        if bigger:
            flush()
            out_lines.append((t, (font, size, pno)))
            continue

        # ③ 粗体 + 短 → 独立块
        if is_bold_font(font) and len(t) <= TITLE_MAX_CHARS:
            flush()
            out_lines.append((t, (font, size, pno)))
            continue

        # ④ 编号标题 / 全大写 → 独立块
        if HEADING_NUM.match(t) or UPPER_HEAD.match(t):
            flush()
            out_lines.append((t, (font, size, pno)))
            continue

        # ⑤ 普通行：按句末标点归并
        if para and para[-1] and para[-1][-1] in SENT_END:
            flush()
            para.append(t)
            meta = (font, size, pno)
        else:
            para.append(t)
            if meta is None:
                meta = (font, size, pno)

    flush()

    # ---- 序列化 -------------------------------------------------------
    fonts, font_index, rows = [], {}, []
    for text, m in out_lines:
        font, size, page = m
        if font not in font_index:
            font_index[font] = len(fonts)
            fonts.append(font)
        rows.append([font_index[font], round(size * 10), page])

    data = {
        "source": pdf.name,
        "text": "\n".join(t for t, _ in out_lines),
        "meta": {"fonts": fonts, "lines": rows},
        "outline": [{"level": l, "title": ti, "page": pg} for l, ti, pg in doc.get_toc()],
    }

    dest = Path("tools/smoke/_font_" + pdf.stem.split("_")[0] + ".json")
    # ⚠️ 允许显式指定输出路径（第二个参数）。
    #    泛化验证会连跑几十篇，靠"找最新改动的文件"来定位输出很脆
    #    （会被别的进程干扰），显式传路径最可靠。
    if len(sys.argv) > 2:
        dest = Path(sys.argv[2])
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"  merged lines : {len(out_lines)}")
    print(f"  fonts        : {len(fonts)}")
    print(f"  outline      : {len(data['outline'])}")
    print(f"  -> {dest}")


if __name__ == "__main__":
    main()

