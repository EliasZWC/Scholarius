package com.eliaszwc.scholarius

import android.content.Context
import android.util.Log
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.interactive.action.PDActionGoTo
import com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.destination.PDPageDestination
import com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem
import com.tom_roush.pdfbox.text.PDFTextStripper
import com.tom_roush.pdfbox.text.TextPosition
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

    /** 大纲条目。level 从 1 开始（1 = 顶层） */
    data class OutlineEntry(
        val level: Int,
        val title: String,
        /** 该条目指向的页码（从 1 开始） */
        val page: Int
    )

    /**
     * 结构化的一行：文本 + 排版元数据。
     *
     * ══ 为什么需要元数据（v0.1.5）══
     *
     * 用户实测（LeCun et al., Nature 2015）：「没有提取到任何目录」。
     *
     * 根因：Nature/ACM/NIPS 这类排版里，章节标题**不靠编号**也不靠
     * 全大写来区分，而是靠**字体**（正文 MinionPro-Regular 9.3pt，
     * 标题 GlosaMath-Bold 10.0pt）。纯文本流把字体信息丢掉了，
     * 前端再怎么写启发式都认不出来 —— 实测该文启发式命中 0 条，
     * 而按字体识别命中 7 条，全部正确。
     *
     * 所以必须把「这一行是什么字体、多大、在第几页」带出来。
     *
     * ⚠️ 只带**每行主字体**（字符数最多的那个），不带全部 span。
     *    一行里字体可能混杂（正文里插一个数学符号），
     *    但标题行的主字体必然占绝对多数。取主字体足够判别，
     *    且能让每个行对象保持小（一篇文章可能上万行，内存敏感）。
     */
    data class Line(
        val text: String,
        /** 主字体名，如 "GlosaMath-Bold"。取不到时为空串 */
        val font: String,
        /** 主字号（磅）。取不到时为 0 */
        val size: Float,
        /** 该行所在页码，从 1 开始 */
        val page: Int,
        /** 是否在**段落起始位置**（前一个非空行是段落边界） */
        val paragraphStart: Boolean
    )

    /** 提取结果：正文 + 行元数据 + PDF 自带大纲 */
    data class Result(
        /** 正文纯文本（阅读页显示用）。行之间用 \n 分隔 */
        val text: String,
        /** 与 [text] 按 \n 切分后**一一对应**的行元数据 */
        val lines: List<Line>,
        /** PDF 自带大纲；为空表示这份 PDF 没有书签 */
        val outline: List<OutlineEntry>
    )

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

    /** 从首页正文里猜出的标题与作者 */
    data class Head(val title: String, val author: String)

    /**
     * 收集文本的 [PDFTextStripper] 子类：**在提取文本的同时产出结构化行**。
     *
     * ══ 为什么必须自己写一个（不能直接用 PDFTextStripper）══
     *
     * PDFTextStripper 只吐纯文本，**字体/字号/页码全部丢掉**。
     * 而 v0.1.5 的章节识别**依赖字体** —— 实测 Nature 那篇
     * （LeCun et al. 2015）的章节标题不靠编号也不靠全大写，
     * 只靠字体区分（正文 MinionPro-Regular 9.3pt，
     * 标题 GlosaMath-Bold 10.0pt）。纯文本流里这些信息不存在，
     * 前端再怎么启发式都认不出来（实测命中 0 条）。
     *
     * PDFBox 提供的钩子是 [writeString] —— 每**行**回调一次，
     * 参数里带该行全部 [TextPosition]（含字体、字号、坐标）。
     * 在这里顺手攒出 [Line] 即可，不用二次遍历。
     *
     * ⚠️ 之前这个类**被引用但没定义**，导致 v0.1.5 整个编译不过
     *    （CI 报 `Unresolved reference 'LineCollector'`）。
     *    本地没有 JDK/SDK，只能靠 CI 发现 —— 所以 push 后必须先等
     *    CI 绿了再打标签，否则会发出一个根本编译不出来的版本。
     *
     * ══ 关于 raw 与 writeText 的关系 ══
     *
     * ⚠️ 两者是**同一次遍历的两种产出**，必须一致：
     *    · [writeText] 写出纯文本（给阅读页）
     *    · [raw] 是行列表（给章节识别与行号跳转）
     *    前端靠行号定位，两者错位会导致跳转全偏。
     *    所以绝不能让它们分别跑两次 —— PDFBox 的遍历顺序
     *    （尤其 sortByPosition 生效时）不保证两次完全一致。
     */
    private class LineCollector : PDFTextStripper() {

        /** 逐行累积的结构化数据。与 writeText 的输出行一一对应 */
        val raw = ArrayList<Line>()

        /** 当前页码（PDFBox 在换页时会改它） */
        private var pageNo = 1

        /** 上一行是否为空行（用来判断本行是否段落起始） */
        private var prevBlank = true

        /*
          ⚠️ 签名必须与父类**逐字一致**，包括 `throws IOException`。

             父类是：
               protected void writeString(String text,
                                          List<TextPosition> textPositions)
                                          throws IOException

             ⚠️ 在 Kotlin 里 `throws` 要靠 @Throws(IOException::class) 补上 ——
                不写虽然也能编译（Kotlin 不强制 checked exception），
                但为了与父类契约一致、且让后续重写不会踩坑，这里显式加上。
         */
        @Throws(java.io.IOException::class)
        override fun writeString(
            text: String?,
            textPositions: List<TextPosition>?
        ) {
            super.writeString(text, textPositions)

            val line = text ?: ""
            val trimmed = line.trim()

            /*
              ⚠️ 空行**也**要收进 raw。

                 因为 mergeParagraphs() 用空行当段落边界 ——
                 如果这里把空行丢掉，段落就永远合并不了，
                 整篇会连成一块（正是 v0.1.3 的"无法阅读"）。
            */
            if (trimmed.isEmpty()) {
                raw.add(Line("", "", 0f, pageNo, false))
                prevBlank = true
                return
            }

            val positions = textPositions ?: emptyList()

            /*
              ⚠️ 主字体 = **字符数最多**的那个字体，不是第一个。

                 一行里字体可能混杂（正文中插一个数学符号、
                 上标引用编号），但标题行的主字体占绝对多数。
                 取第一个会经常取到那个符号字体，判别就错了。

                 ⚠️ 用 String.length 而非 TextPosition 个数加权：
                    TextPosition 可能一个对象对应多个字符
                    （PDFBox 会把连续同属性字符合并）。
                    这里要的是"哪种字体覆盖的字符多"。
            */
            var fontName = ""
            var fontSize = 0f
            if (positions.isNotEmpty()) {
                val weight = HashMap<String, Int>()
                val sizeOf = HashMap<String, Float>()
                for (p in positions) {
                    val f = p.font?.name ?: ""
                    weight[f] = (weight[f] ?: 0) + p.unicode.length
                    if (!sizeOf.containsKey(f)) sizeOf[f] = p.fontSizeInPt
                }
                var best = ""
                var bestN = -1
                for ((f, n) in weight) {
                    if (n > bestN) {
                        bestN = n
                        best = f
                    }
                }
                fontName = best
                fontSize = sizeOf[best] ?: 0f
            }

            /*
              ⚠️ 页码取 PDFBox 的当前页，不用自己数。
                 自己数在多页时容易差一（尤其有 pageStart 分隔时）。

                 ⚠️ **必须写成 `getCurrentPageNo()`** —— 它在父类里是
                    `protected int getCurrentPageNo()`，而 Kotlin 侧
                    对 Java protected getter 的**属性语法访问不成立**
                    （`currentPageNo` 解析不到，因为背后的字段
                    `private int currentPageNo` 不可见）。
                    写成 `currentPageNo` 会得到
                    `Unresolved reference: currentPageNo`，
                    而本地没 JDK 发现不了 —— 只能靠 CI。
            */
            pageNo = getCurrentPageNo()

            raw.add(
                Line(
                    text = line,
                    font = fontName,
                    size = fontSize,
                    page = pageNo,
                    /*
                      ⚠️ paragraphStart 这里恒为 false —— 真正的段落判定
                         在 mergeParagraphs() 里做（它要看上下文：
                         上一行是否句末、本行是否标题）。
                         这里没有上下文，硬猜只会给出错的标记。
                    */
                    paragraphStart = false
                )
            )
            prevBlank = false
        }
    }

    /**
     * 读 PDF 自带的书签大纲。
     *
     * ⚠️ 返回空列表是**正常情况**，不是错误：
     *    很多 PDF（尤其 arXiv 的自动排版件、以及被工具重写过的）
     *    根本没有书签。前端此时退回「按字体识别章节」。
     *    实测那篇 Nature 就没有可靠书签，全靠字体识别。
     *
     * ⚠️ level 从 1 开始（1 = 顶层）。
     *    PDFBox 的 `getNextSibling` / `getFirstChild` 构成树，
     *    递归时 level 逐层 +1。
     *
     * ⚠️ 只收**能定位到页码**的条目。
     *    拿不到页码的条目点不动（跳转需要页码），收进来只会
     *    让用户在目录里点了没反应 —— 那比不显示更糟。
     *    所以 resolvePage() 失败的直接跳过。
     */
    private fun readOutline(document: PDDocument): List<OutlineEntry> {
        val out = ArrayList<OutlineEntry>()
        val root = try {
            document.documentCatalog?.documentOutline
        } catch (t: Throwable) {
            Log.w(TAG, "readOutline: catalog unavailable", t)
            return out
        } ?: return out

        val first = try {
            root.firstChild
        } catch (t: Throwable) {
            Log.w(TAG, "readOutline: no first child", t)
            return out
        }

        /*
          ⚠️ 整段包在 try/catch 里：书签树是外部数据，可能有环、
             可能指向不存在的对象。一个坏书签不该让整次提取失败
             （提取失败的代价是整篇打不开）。
        */
        try {
            var item: PDOutlineItem? = first
            while (item != null) {
                addOutlineItem(item, 1, document, out)
                item = item.nextSibling
            }
        } catch (t: Throwable) {
            Log.w(TAG, "readOutline failed, returning ${out.size} entries", t)
        }
        return out
    }

    /** 递归收一个书签及其子节点，[level] 从 1 开始 */
    private fun addOutlineItem(
        item: PDOutlineItem,
        level: Int,
        document: PDDocument,
        out: MutableList<OutlineEntry>
    ) {
        val title = item.title?.trim().orEmpty()
        val page = resolvePage(item, document)

        /*
          ⚠️ 标题空 或 页码未知 → **跳过这一条，但继续递归子节点**。
             父节点没页码不代表子节点没有，直接 return 会丢掉
             整棵子树。
        */
        if (title.isNotEmpty() && page > 0) {
            out.add(OutlineEntry(level, title, page))
        }

        var child = try {
            item.firstChild
        } catch (t: Throwable) {
            null
        }
        while (child != null) {
            addOutlineItem(child, level + 1, document, out)
            child = try {
                child.nextSibling
            } catch (t: Throwable) {
                null
            }
        }
    }

    /**
     * 把一个书签解析成页码（从 1 开始）；解析不出返回 0。
     *
     * ⚠️ 书签的 destination 有两种形态：
     *      · 直接指向页面（PDPageDestination）
     *      · 是「动作」而不是目的地（PDActionGoTo）—— 要取它的 destination
     *    只处理前者会漏掉相当一部分 PDF（很多是用动作写的）。
     */
    private fun resolvePage(item: PDOutlineItem, document: PDDocument): Int {
        return try {
            val dest = try {
                item.destination ?: (item.action as? PDActionGoTo)?.destination
            } catch (t: Throwable) {
                null
            }

            val pd = dest as? PDPageDestination ?: return 0

            /*
              ⚠️ 用 pageNumber 而不是自己 walk 页面树。
                 PDFBox 的 PDPageDestination.pageNumber 已经处理好
                 页面树索引到物理页码的映射（含继承的节点）。
            */
            val idx = try {
                pd.pageNumber
            } catch (t: Throwable) {
                -1
            }
            if (idx >= 0) idx + 1 else 0
        } catch (t: Throwable) {
            0
        }
    }

    /**
     * 只读**第 1 页**，从正文里猜标题与作者。
     *
     * ══ 为什么需要（v0.1.5）══
     *
     * 有些 PDF 的元数据被生成工具（iLovePDF 等）整个抹掉。
     * 实测（Wei et al., CoT Prompting, NIPS 2022）：title/author/subject
     * 全空，导入后列表只剩「14 pages · 385 KB」，标题退回文件名。
     * 但首页正文里有完整的标题与作者 —— 读一次就能补上。
     *
     * ══ 判据 ══
     *
     * 论文首页的排布极其统一：
     *   ① 最大的那行字 = 标题（通常 16~28pt，正文约 10pt）
     *   ② 标题下面的若干行 = 作者（字号介于标题与正文之间，或与正文同）
     *   ③ 再往下是单位/邮箱/摘要
     *
     * 所以：取首页**字号最大**的行当标题，取它**后面紧邻的、含逗号或
     * 人名的短行**当作者。
     *
     * ⚠️ 只读一页。首页几百行，比整篇便宜得多（这正是分开实现的原因）。
     * ⚠️ 失败/猜不出就返回空串，由调用方决定怎么兜底。
     */
    fun extractHead(pdf: File): Head? {
        if (!pdf.exists() || !pdf.isFile) return null

        return try {
            PDDocument.load(pdf).use { document ->
                if (document.numberOfPages <= 0) return null

                val collector = LineCollector()
                collector.startPage = 1
                collector.endPage = 1
                collector.lineSeparator = "\n"
                collector.sortByPosition = true

                val buffer = java.io.StringWriter()
                collector.writeText(document, buffer)

                val lines = collector.raw
                if (lines.isEmpty()) return null

                guessHead(lines)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "extractHead failed: ${pdf.name}", t)
            null
        }
    }

    /**
     * 从首页行里猜标题与作者。
     *
     * 拆出来是为了可测：不依赖 PDFBox，纯函数，
     * 可以直接拿一组 Line 喂进来验证判据。
     */
    fun guessHead(lines: List<Line>): Head? {
        if (lines.isEmpty()) return null

        // ① 找字号最大的行 —— 那行就是标题
        var titleIdx = -1
        var maxSize = 0f
        for ((i, l) in lines.withIndex()) {
            val t = l.text.trim()
            if (t.isEmpty()) continue
            /*
              ⚠️ 排除「字号极大但只 1~2 个字符」的行。
                 那是首字下沉（Nature 的 "M" 实测 41.6pt）或装饰字母。
            */
            if (t.length < 8) continue
            if (l.size > maxSize) {
                maxSize = l.size
                titleIdx = i
            }
        }
        if (titleIdx < 0) return null

        /*
          ② 标题可能跨多行（长标题会被排版拆开）。
             把紧随其后、**字号相同**的短行接上，直到遇到明显更小的字号。
        */
        val titleParts = ArrayList<String>()
        titleParts.add(lines[titleIdx].text.trim())
        var k = titleIdx + 1
        while (k < lines.size && titleParts.size < 4) {
            val l = lines[k]
            val t = l.text.trim()
            if (t.isEmpty()) { k++; continue }
            // 字号相同（容差 0.3）且不太长 → 视为标题的续行
            if (Math.abs(l.size - maxSize) <= 0.3f && t.length in 1..120) {
                titleParts.add(t)
                k++
                continue
            }
            break
        }
        val title = titleParts.joinToString(" ").replace(Regex("\\s+"), " ").trim()

        /*
          ③ 作者：标题之后、字号明显小于标题的若干行里，
             取**含逗号**或**含 "and"** 的那一行（多作者几乎总有分隔符）。
             再宽松一点：如果连续几行都是短的、都像人名，就拼起来。
        */
        val author = guessAuthors(lines, k, maxSize)

        return Head(title, author)
    }

    /** 标题之后找作者行 */
    private fun guessAuthors(lines: List<Line>, from: Int, titleSize: Float): String {
        var i = from
        // 允许先跳过 1~2 个空行
        var skipped = 0
        while (i < lines.size && skipped < 3) {
            if (lines[i].text.trim().isEmpty()) { i++; skipped++; continue }
            break
        }

        val parts = ArrayList<String>()
        var scanned = 0

        /*
          ⚠️ 扫描窗口要**足够大**，不能只扫 8 行。

          实测（Transformer, NIPS）首页的排布是**每人三行循环**：
              Ashish Vaswani / Google Brain / avaswani@google.com
              Noam Shazeer  / Google Brain / noam@google.com
              ...
          8 个作者 = 24 行，加上单位和邮箱共 ~30 行。
          窗口小于 30 就只能收到第 1 个作者 —— 实测就是这个症状。
        */
        while (i < lines.size && scanned < 60 && parts.size < 30) {
            val l = lines[i]
            val t = l.text.trim()
            i++
            scanned++
            if (t.isEmpty()) continue

            /*
              ⚠️ 遇到摘要/正文开头 → **停止**（作者区到此结束）。
            */
            if (ABSTRACT_START.containsMatchIn(t)) break
            // 太长 → 多半是摘要第一句
            if (t.length > 160) break
            // 字号比标题还大 → 跑到别的大字去了
            if (l.size > titleSize + 0.3f) continue

            /*
              ⚠️ 单位行与邮箱 → **跳过继续找**，不是停止。

                 这是与上一版的关键差别。原来一遇到
                 "Google Brain" 就 break，于是只能收到第一个作者。
                 而实际排布里单位夹在作者之间，跳过后
                 下一个作者就在后面。
            */
            if (t.contains('@')) continue
            if (UNIT_START.containsMatchIn(t)) continue
            // 纯符号/编号（上标的 † ‡ § 之类会单独成行）
            if (t.replace(Regex("[^A-Za-z\\u4e00-\\u9fff]"), "").length < 2) continue

            /*
              ⚠️ 作者的判据：含逗号分隔，或含 " and "，或
                 2~5 个单词的短行（单人一行）。
                 实测 NIPS 是「一人一行、无逗号」，CVPR 是
                 「一行逗号分隔多位」，两种都要能收。
            */
            val words = t.split(Regex("\\s+")).filter { it.isNotEmpty() }
            val isList = t.contains(',') ||
                Regex("\\band\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)
            val isSingle = words.size in 2..5 &&
                t.none { it.isDigit() } && t.length <= 60

            if (isList || isSingle) {
                parts.add(t)
                continue
            }

            /*
              ⚠️ 走到这里说明这一行既不是作者、也不是已知的单位/邮箱。
                 可能是「摘要」以外的正文开头（如 "1 Introduction"）——
                 再往下扫就是正文了，及时收手。
            */
            break
        }

        return parts.joinToString(", ")
            .replace(Regex("\\s*,\\s*"), ", ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .trimEnd(',')
    }

    /** 摘要开头的常见写法。见到就停止找作者 */
    private val ABSTRACT_START = Regex(
        "^\\s*(abstract|摘要|introduction|1\\s+introduction)\\b",
        RegexOption.IGNORE_CASE
    )

    /**
     * 单位/机构行的常见开头。见到就停止找作者
     *
     * ⚠️ 还要拦住「引用信息 / 版本信息」这类**出版社封面**才有的行。
     *    实测（Nature 的 HAL 版首页）：
     *        "To cite this version:" 后面跟着重复的作者名和标题，
     *        它们都短、都不含数字，会被作者的宽松判据（2~5 个单词）
     *        全部当成作者收进来 —— 实测多吸了 3 行。
     */
    private val UNIT_START = Regex(
        "^\\s*(department|university|institute|school|college|google|facebook|microsoft|" +
            "openai|deepmind|research|center|centre|laborator|faculty|abstract|" +
            "to cite|cite this|this version|submitted|published|preprint|" +
            "hal\\b|doi\\b|arxiv\\b|proceedings|conference on|journal of)",
        RegexOption.IGNORE_CASE
    )

    /**
     * 提取 PDF 正文。
     *
     * @return 正文与自带大纲；提取不到文本时返回 null。
     *
     * ⚠️ 必须在**后台线程**调用：要解压全部内容流并建字体映射，
     *    几十兆的文献在低端机上可能几百毫秒到数秒。
     *
     * ⚠️ 调用方负责先调 [ensureInitialised]。这里拿不到 Context
     *    （object 是无状态的），所以不在此处初始化。
     */
    fun extract(pdf: File): Result? {
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
                val stripper = LineCollector()

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

                /*
                  ⚠️ 正文与元数据必须**一起**整理。
                     normalise 会把排版行合并成段落行；
                     如果只合并文本、元数据保持原样，两边行号就错位了，
                     前端跳转会全部偏掉。所以让它同时产出两者。
                */
                val merged = mergeParagraphs(stripper.raw)
                val text = merged.text
                Log.i(
                    TAG,
                    "extracted ${raw.length} -> ${text.length} chars, " +
                        "${merged.lines.size} lines, ${stripper.raw.size} raw lines, " +
                        "from ${pdf.name}"
                )

                val body = if (text.length > MAX_CHARS) {
                    Log.i(TAG, "truncating ${text.length} -> $MAX_CHARS chars")
                    text.substring(0, MAX_CHARS)
                } else {
                    text
                }

                Result(body, merged.lines, readOutline(document))
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
     * 把**原始排版行**合并成**段落行**，同时合并元数据。
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
     * ══ v0.1.5：为什么改成接收 Line 列表 ══
     *
     * 目录需要「行 → 字体/字号/页码」。而合并会改变行数，
     * 所以元数据必须**跟着一起合并**，否则前端拿到的行号会全部错位。
     * 做法：取**段落第一行**的字体与字号 ——
     * 段落的首行决定这一段的排版属性，这也是排版上的事实。
     *
     * ⚠️ 判据是启发式的，不可能 100% 准确。取舍原则：
     *    宁可偶尔把两段并成一段（读起来仍通顺），
     *    也不要每行都断成碎片（完全没法读）。
     */
    private fun mergeParagraphs(rawLines: List<Line>): Result {
        val outText = StringBuilder()
        val outLines = ArrayList<Line>(rawLines.size)

        val para = StringBuilder()
        var paraMeta: Line? = null

        fun flush() {
            if (para.isNotEmpty()) {
                if (outText.isNotEmpty()) outText.append('\n')
                outText.append(para)
                val meta = paraMeta
                if (meta != null) {
                    outLines.add(meta.copy(text = para.toString(), paragraphStart = true))
                }
                para.setLength(0)
                paraMeta = null
            }
        }

        for (line in rawLines) {
            val t = line.text.trim()

            // 空行 = 段落边界
            if (t.isEmpty()) {
                flush()
                continue
            }

            val flat = Line(t, line.font, line.size, line.page, false)

            // 已积累的内容是标题 → 标题独立，正文另起
            if (looksLikeHead(para.toString())) {
                flush()
                para.append(t)
                paraMeta = flat
                continue
            }

            if (endsSentence(para)) {
                // 上一行已是句末 → 这一行另起
                flush()
                para.append(t)
                paraMeta = flat
            } else {
                // 上一行在句中 → 合并，英文之间补空格
                if (needsSpaceBetween(para, t)) para.append(' ')
                para.append(t)
                // 元数据保留**第一行**的（段落首行决定排版属性）
                if (paraMeta == null) paraMeta = flat
            }
        }
        flush()

        return Result(outText.toString(), outLines, emptyList())
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
