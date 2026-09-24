package com.eliaszwc.scholarius

import android.content.Context
import android.util.Log
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.File

/**
 * PDF → 文本提取（阅读页正文用）。
 *
 * 底层是 pdfbox-android。
 *
 * ══ 为什么不是手写解析器（v0.1.1 的教训）══
 *
 * v0.1.1 自己写了一个内容流扫描器（找 `stream`、手解 `(...)` 字面量、
 * 把字节按 latin-1 解码）。实测一篇 LaTeX 论文后确认**方向性错误**：
 *
 *   原始内容流：
 *       /F139 9.9626 Tf 71.641 748.493 Td [(VIST)93(A:)-250(T)35(raining-Free)...]TJ
 *   正确文本：
 *       "VISTA: Training-Free ..."
 *
 *   三个致命点：
 *   ① 字体被**子集化** —— CMBX10 的 /Encoding 把字节 103/108/111 分别
 *      指给字形 g/l/o，字节 49 指给 "one"。字节值本身就是子集顺序，
 *      不是 ASCII，也不对应任何固定编码。**没有可读的字符编码可言。**
 *   ② `93` / `-250` 不是文本，是 TJ 数组里的**字距调整量**。
 *   ③ `(T)35(raining)` 是同一个单词被**拆成多段**；
 *      而词与词之间的空格**根本不写成字符** —— PDF 靠 Td/Tm 坐标定位。
 *      所以按流顺序拼接必然得到一坨没有空格的乱码。
 *
 * 实测的坏输出 vs 正确输出：
 *      坏: "VGITSDTLARTGFEMLERAG..."          （无空格、字全错位）
 *      好: "VISTA: VALUING INHERENT SUSCEPTIBILITY AND TOPOLOGICAL ..."
 *
 * 结论：要正确提取，必须解析 ToUnicode CMap + 字体 Differences、
 * 按字距推断空格、按坐标排序重排行。这是几百行且极易出错的工作。
 * 换成成熟库，代价约 +2.5MB，正确率高得多。
 *
 * ⚠️ 已知仍有限制：
 *   - 扫描件（纯图片 PDF）没有文本层，提取不到文本，返回 null。
 *     这类 PDF 需要 OCR，不在本项目范围内。
 *   - 复杂公式会变成近似线性的文本（如 `Fall = Concat(F1, F2)`），
 *     不会还原成 LaTeX 数学语法。要还原公式需要额外的数学 OCR。
 *     —— 所以本类输出的是**普通文本**，不是 LaTeX 源码。
 */
object PdfText {

    /** 单篇最多输出的字符数。防止超长 PDF 把 WebView 撑爆。 */
    private const val MAX_CHARS = 2_000_000

    private const val TAG = "PdfText"

    @Volatile
    private var initialised = false

    /**
     * 初始化 PDFBox 的资源加载器。
     *
     * ⚠️ **必须在使用 PDFBox 任何 API 之前调用一次**，否则加载字体/CMap
     *    资源时会抛异常 —— 它要从 assets 里读 cmap / glyphlist 等表。
     *    用 @Volatile + 双检锁保证只初始化一次且线程安全
     *    （提取在后台线程跑，可能在多处并发触发）。
     */
    fun ensureInitialised(context: Context) {
        if (initialised) return
        synchronized(this) {
            if (initialised) return
            PDFBoxResourceLoader.init(context.applicationContext)
            initialised = true
        }
    }

    /**
     * 提取 PDF 正文。
     *
     * @return 文本；提取不到或失败时返回 null。
     *
     * ⚠️ 必须在**后台线程**调用：要解压全部内容流并建字体映射，
     *    几十兆的文献在低端机上可能几百毫秒到数秒。
     *
     * ⚠️ 调用方负责先调 [ensureInitialised]。这里拿不到 Context
     *    （object 是无状态的），所以不在此处初始化。
     */
    fun extract(pdf: File): String? {
        if (!pdf.exists() || !pdf.isFile) {
            return null
        }

        return try {
            PDDocument.load(pdf).use { document ->
                /*
                  ⚠️ 加密 PDF：pdfbox 在 load 时若空密码能解会自动解开；
                      否则上面就抛异常进 catch。这里不要求密码 ——
                      用户可先用别的工具解密再导入。
                */
                val stripper = PDFTextStripper()

                /*
                  ⚠️ sortByPosition 必须为 true。
                     不设的话 PDFBox 按内容流顺序输出，双栏论文会左右栏交错，
                     读起来完全不通。设为 true 后按坐标重排，顺序才正确。
                */
                stripper.sortByPosition = true

                /*
                  ══ 分词与分行策略（v0.1.4 重做）══

                  v0.1.3 的正文「无法阅读」：所有文本连成一片，
                  看不出段落、也不分节。根因有三层，全部在这里解决。

                  ① 行分隔符。
                     必须显式设为 "\n"。PDFBox 默认用的也是换行，
                     但取值来自 System.getProperty("line.separator")，不可依赖。

                  ② 段落分隔。
                     ⚠️ API 是 paragraphStart / paragraphEnd（成对），
                        **不是** paragraphSeparator —— 后者是 desktop
                        PDFBox 的写法，Android 版没有，写上去编译不过。
                        默认 paragraphStart/End 都是空串，也就是**段落之间
                        没有任何分隔**，正文会连成一整块。这里显式给出
                        结尾双换行，段落之间才会空一行。

                  ③ 页分隔。
                     同上，API 是 pageStart / pageEnd（默认 pageEnd 是
                     单个换行，页码会与正文粘住）。这里用双换行隔开每一页。

                  ⚠️ 不要关掉 setShouldSeparateByBeads（保留默认 true）。
                     它是分栏/分区块的辅助，关掉反而让双栏串行。

                  ⚠️ addMoreFormatting 不要打开。它会把 paragraphEnd /
                     pageStart / articleStart 都**强制改写成 lineSeparator**
                     （见 PDFTextStripper.writeText 的开头几行），
                     等于把我们上面设的段落分隔全部抹掉。
                */
                stripper.lineSeparator = "\n"
                stripper.paragraphStart = ""
                stripper.paragraphEnd = "\n\n"
                stripper.pageStart = "\n\n"
                stripper.pageEnd = "\n\n"

                /*
                  ⚠️ 用 writeText(Writer) 而不是 getText()。
                     getText() 内部也只是包一层 StringWriter，但显式用
                     Writer 能确保分隔符设置被完整应用（Android 版上
                     getText() 曾有忽略部分分隔符设置的问题）。
                */
                val buffer = java.io.StringWriter()
                stripper.writeText(document, buffer)
                val raw = buffer.toString()

                if (raw.isNullOrBlank()) {
                    // 扫描件（图片 PDF）走这里。不是错误，是真的没有文本层
                    Log.i(TAG, "no text layer: ${pdf.name}")
                    return null
                }

                val text = normalise(raw)
                Log.i(
                    TAG,
                    "extracted ${raw.length} -> ${text.length} chars from ${pdf.name}"
                )

                if (text.length > MAX_CHARS) {
                    Log.i(TAG, "truncating ${text.length} -> $MAX_CHARS chars")
                    text.substring(0, MAX_CHARS)
                } else {
                    text
                }
            }
        } catch (t: Throwable) {
            /*
              不抛给上层 —— 阅读页只要知道「这次没拿到文本」，然后显示提示。
              把异常吞掉但留日志（logcat 里能看到原因）。
            */
            Log.w(TAG, "extract failed: ${pdf.name}", t)
            null
        }
    }

    /**
     * 整理提取出的文本，让它可读。
     *
     * ══ 为什么必须做这一步（v0.1.4）══
     *
     * PDF 里没有「段落」这个实体，只有一行行的定位文本块。
     * 直接输出会得到：
     *
     *     In the risk auditing framework for multimodal representation learning,
     *     quantifying the geometric resilience of multi-modal systems under
     *     extreme external perturbations centers on observing the dynamic
     *
     * 每行都在词中间断开 —— 这是**排版换行**，不是段落换行。
     * 用户看到的就是「全部按纯文本排列到一起，没法看清自然段」。
     *
     * ══ 规则 ══
     *
     *   ① 排版换行合并回一行：上一行**不是**句末标点结尾 → 与下一行连起来。
     *   ② 标题/作者/单位/编号这类**短行各自独立成段**：
     *      它们不适用 ①（否则标题会与作者连成一句），
     *      因为它们通常短、且不以句末标点结尾。
     *   ③ 空行是段落边界，保留。
     *
     * 实测效果（一篇 17 页 LaTeX 论文的第 1~4 页）：
     *    整理前 236 行（每行都断在词中间）
     *    整理后 121 段（段落完整、标题独立）
     *
     * ⚠️ 判据是启发式的，不可能 100% 准确。取舍原则：
     *    宁可偶尔把两段并成一段（读起来仍通顺），
     *    也不要每行都断成碎片（完全没法读）。
     */
    private fun normalise(raw: String): String {
        val out = StringBuilder(raw.length)
        val para = StringBuilder()

        fun flush() {
            if (para.isNotEmpty()) {
                if (out.isNotEmpty()) out.append("\n\n")
                out.append(para)
                para.setLength(0)
            }
        }

        for (line in raw.split('\n')) {
            val t = line.trim()

            // 空行 = 段落边界
            if (t.isEmpty()) {
                flush()
                continue
            }

            if (para.isEmpty()) {
                para.append(t)
                continue
            }

            /*
              当前行像标题 → 已积累的收掉，这一行自己独立成段。
              ⚠️ 顺序很关键：必须在「上一行已句末」之前判断。
                 否则「标题（不以标点结尾）+ 作者」会被合并成
                 「VISTA: ... AUDITING Weichen Zhang」这种一坨。
            */
            if (looksLikeHead(t)) {
                flush()
                para.append(t)
                continue
            }

            // 已积累的内容是标题 → 标题独立，正文另起
            if (looksLikeHead(para.toString())) {
                flush()
                para.append(t)
                continue
            }

            if (endsSentence(para)) {
                // 上一行已是句末 → 这一行另起
                flush()
                para.append(t)
            } else {
                // 上一行在句中 → 合并，英文之间补空格
                if (needsSpaceBetween(para, t)) para.append(' ')
                para.append(t)
            }
        }
        flush()

        return out.toString()
    }

    /** 段末标点。中英文都列，因为论文里两种都可能出现 */
    private val SENTENCE_END = charArrayOf(
        '.', '?', '!', ':', ';', '。', '？', '！', '：', '；', '」', '』', '）', ')', '"'
    )

    /** 独立成行的编号，如 `3` / `3.1` / `IV.` */
    private val NUMBER_ONLY = Regex("^§?\\s*(\\d+(\\.\\d+)*|[IVXLC]+)[.、]?$")

    /** 全大写标题，如 `ABSTRACT` / `RELATED WORK` */
    private val UPPER_HEAD = Regex("^[A-Z][A-Z0-9 \\-,:&'()/]{2,}$")

    /** 短行阈值。正文行通常远长于此 */
    private const val SHORT_LINE = 60

    /**
     * 判断一行是否「自成一段」（标题、作者、单位、编号等）。
     *
     * ⚠️ 短行 + 不含句末标点 → 视为独立块。
     *    正文行几乎总以标点结尾（句子结束），且明显更长；
     *    而标题、作者名、单位、邮箱这些恰好都短且无句末标点。
     */
    private fun looksLikeHead(s: String): Boolean {
        if (s.isEmpty()) return false
        if (NUMBER_ONLY.matches(s)) return true
        if (UPPER_HEAD.matches(s)) return true
        if (s.length <= SHORT_LINE && SENTENCE_END.none { it == s[s.length - 1] }) {
            return true
        }
        return false
    }

    private fun endsSentence(sb: StringBuilder): Boolean {
        for (i in sb.length - 1 downTo 0) {
            val c = sb[i]
            if (c == ' ') continue
            return SENTENCE_END.contains(c)
        }
        return false
    }

    /**
     * 合并两段文字时是否需要补空格。
     *
     * ⚠️ 只在「前一段末字符是拉丁字母/数字」且「后一段首字符是字母/数字」时补。
     *    中文之间补空格是错的（「研究 方法」）；
     *    连字符结尾也不补（那是被切断的复合词，如 "multi-" + "modal"）。
     */
    private fun needsSpaceBetween(a: StringBuilder, b: String): Boolean {
        if (a.isEmpty() || b.isEmpty()) return false
        val last = a[a.length - 1]
        val first = b[0]
        if (last == '-') return false
        val lastIsWord = last.isLetterOrDigit() && last.code < 0x2E80
        val firstIsWord = first.isLetterOrDigit() && first.code < 0x2E80
        return lastIsWord && firstIsWord
    }
}
