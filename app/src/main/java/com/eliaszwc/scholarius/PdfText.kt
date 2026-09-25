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
        val paragraphStart: Boolean,
        /**
         * 该行在页面上的包围盒，**归一化到 0..1**：
         * `x0, y0` 是左上角，`x1, y1` 是右下角；y 轴向下（与屏幕一致）。
         *
         * ══ 为什么需要坐标（v0.1.17）══
         *
         * 用户提议：「我们不自己分了，留给用户分」——
         * 在 PDF 页图上画框，让用户标注每块是正文/标题/公式/表格/图片。
         *
         * 要能做到这件事，网页必须知道**这段文字在页面的哪个位置**，
         * 才能把框画在正确的地方。而 `text` 本身没有任何位置信息。
         *
         * ══ 为什么是归一化的 0..1，不是 PDF 的原始磅值 ══
         *
         * ① 前端用 CSS 百分比定位（`left: 12%; top: 30%`），
         *    归一化的值可以直接用，不需要前端知道页面尺寸；
         * ② 页图是**缩放后**显示的（宽 1600px 的原生渲染图缩到屏宽），
         *    用绝对磅值就要在前端重算缩放比，多一处容易错的地方；
         * ③ 0..1 对"页面尺寸不同"的文档天然免疫 ——
         *    A4 与 Letter、单栏与双栏混排都不用特判。
         *
         * ⚠️ y 轴方向：PDF 原生是**左下角原点、y 向上**，
         *    而屏幕是**左上角原点、y 向下**。这里统一成屏幕方向
         *    （用 PDFBox 的 `getYDirAdj()`，它已经做过这个翻转）。
         *    不统一的话前端画出来的框会上下颠倒 ——
         *    而且**在只有单页的测试里看不出来**，很隐蔽。
         *
         * ⚠️ 取不到坐标时四个值都是 0。前端要判 `x1 > x0` 才画框，
         *    否则会画出一堆退化的零尺寸框。
         */
        val x0: Float = 0f,
        val y0: Float = 0f,
        val x1: Float = 0f,
        val y1: Float = 0f
    )

    /**
     * 结构化正文的**一个块**。
     *
     * ══ 为什么需要它（用户 2026-09-24 提出）══
     *
     * 用户原话：「我们以 latex 形式保存，然后根据这个形式渲染我们自己的
     * 阅读器，不然提取文字永远无法正确显示内容，也没法在手机上看，
     * 不然直接 pdf 阅读就好了」。
     *
     * 判断是对的：纯文本流**结构信息为零**，前端拿到的只是一大段字，
     * 于是所有内容看起来一样重、连成一片 —— 段落、标题、公式
     * 在视觉上无从区分。而「直接看 PDF」又等于放弃重排
     * （窄屏、字号、主题都做不了）。
     *
     * 所以提取阶段就要产出**元素序列**，而不是一整块字符串。
     *
     * ══ kind 的取值与判据 ══
     *
     *   heading    标题。判据见 looksLikeHead()（编号 / 全大写 / 短行无句末标点）
     *              外加**字体比正文粗或大**这条强信号（见 HeadingStyle）
     *   paragraph  正文段落。连续的排版行按句末标点合并（见 mergeParagraphs）
     *   formula    疑似公式块。判据：该行**几乎不含普通词**，
     *              且大量出现数学符号 / 上下标退化的痕迹
     *   figure    图片占位。⚠️ 目前**不产出** ——
     *              抽取 PDF 图片 XObject 并定位是独立一项工作，
     *              本版先把 kind 定义好，前端遇到它就能正确渲染
     *
     * ⚠️ 存成**字符串**而不是 enum：它要序列化进 JS，字符串最省事，
     *    且与前端 `block.kind === 'heading'` 直接对上。
     */
    data class Block(
        /** heading / paragraph / formula / figure */
        val kind: String,
        /** 文本内容（figure 为空串） */
        val text: String,
        /**
         * 标题层级，1 起。非 heading 恒为 0。
         *
         * ⚠️ 目前只有 1 与 2 两档：
         *    1 = 章（`3` / `ABSTRACT`），2 = 节（`3.1`）
         *    不硬猜更多层级 —— PDF 里没有可靠的层级信息，
         *    猜错会让目录结构错乱，两档足够表达层次。
         */
        val level: Int,
        /** 该块起始页（从 1 开始），用于「跳转到原文位置」 */
        val page: Int,
        /**
         * 该块在页面上的包围盒（归一化 0..1，屏幕方向：左上原点）。
         *
         * ══ 用途（v0.1.17）══
         *
         * 用户在 PDF 页图上改正我们的自动分块时，需要在**页面的对应位置**
         * 画出可点击的框。没有这个包围盒，网页只能盲猜位置 ——
         * 那就等于让用户从零画框，手机上极难操作。
         *
         * ⚠️ 取不到坐标时 x1 == x0（零尺寸）。前端必须判 `x1 > x0`
         *    再画框，否则会得到一堆点状/反向的退化框。
         */
        val x0: Float = 0f,
        val y0: Float = 0f,
        val x1: Float = 0f,
        val y1: Float = 0f
    )

    /** 提取结果：正文 + 行元数据 + PDF 自带大纲 */
    data class Result(
        /** 正文纯文本（阅读页显示用）。行之间用 \n 分隔 */
        val text: String,
        /** 与 [text] 按 \n 切分后**一一对应**的行元数据 */
        val lines: List<Line>,
        /** PDF 自带大纲；为空表示这份 PDF 没有书签 */
        val outline: List<OutlineEntry>,
        /**
         * **结构化元素序列**（v0.1.6）。
         *
         * ⚠️ 与 [text] **并存**而不是取代它：
         *    · [text] 给「复制全文」「全文搜索」这类需要平坦文本的场景；
         *    · [blocks] 给渲染 —— 前端按块分别设置标题/段落/公式的样式。
         *    两者由**同一次遍历**产出（见 mergeParagraphs），
         *    所以内容必然一致，不会出现"渲染的与复制的不同"。
         */
        val blocks: List<Block> = emptyList(),
        /**
         * **每页的宽高比**（`高 / 宽`），下标 0 对应第 1 页。
         *
         * ══ 用途（v0.1.17）══
         *
         * 网页要在 PDF 页图上叠分块框。框的位置用 [Block] 的归一化
         * 坐标就够，**但容器本身需要知道页面的高宽比**才能正确排布 ——
         * 否则框会画在一个高度不正确的容器里，纵向位置全偏。
         *
         * ⚠️ 原始视图的页图是原生渲染的 JPEG（宽 1600、高按比例），
         *    它自带正确比例；但**文本视图**里没有页图 ——
         *    那时如果也要显示标注框，就只能靠这个比例来铺一个
         *    与页面等比的容器。
         *
         * ⚠️ 空列表表示"没读到"（加密/损坏）。前端退回 A4（1.414）。
         */
        val pageRatios: List<Float> = emptyList()
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

            /*
              ⚠️ 行包围盒：把该行所有 span 的矩形合并成一个。

                 判据用 `getXDirAdj/getYDirAdj/getWidthDirAdj/getHeightDir`
                 —— 它们都**已按文字方向做过旋转校正**，
                 且 y 轴是「左上角原点、向下为正」，与屏幕一致。
                 直接用 getX/getY 会拿到未校正的值（PDF 原生左下角原点），
                 前端画出来的框会上下颠倒，且单页测试里看不出来。

                 ⚠️ 然后归一化到 0..1（除以页宽/页高）。
                    页面尺寸从第一个 span 取 —— 同一页里所有 span 的
                    页宽页高必然相同，不必逐个比。
            */
            var bx0 = Float.MAX_VALUE
            var by0 = Float.MAX_VALUE
            var bx1 = -Float.MAX_VALUE
            var by1 = -Float.MAX_VALUE
            var pw = 0f
            var ph = 0f
            for (p in positions) {
                if (p.unicode.isNullOrEmpty()) continue
                val px = p.xDirAdj
                val py = p.yDirAdj
                val pr = px + p.widthDirAdj
                val pb = py + p.heightDir
                if (px < bx0) bx0 = px
                if (py < by0) by0 = py
                if (pr > bx1) bx1 = pr
                if (pb > by1) by1 = pb
                if (pw <= 0f) pw = p.pageWidth
                if (ph <= 0f) ph = p.pageHeight
            }

            var nx0 = 0f
            var ny0 = 0f
            var nx1 = 0f
            var ny1 = 0f
            if (pw > 0f && ph > 0f && bx1 > bx0 && by1 > by0) {
                /*
                  ⚠️ 必须 clamp 到 0..1。
                      少数 PDF 的文字会略微超出 CropBox（字体溢出、
                      或用了更大的 MediaBox），不夹会得到 1.02 这种值，
                      前端按百分比定位就会溢出容器、画出可见的错位框。
                */
                nx0 = (bx0 / pw).coerceIn(0f, 1f)
                ny0 = (by0 / ph).coerceIn(0f, 1f)
                nx1 = (bx1 / pw).coerceIn(0f, 1f)
                ny1 = (by1 / ph).coerceIn(0f, 1f)
            }

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
                    paragraphStart = false,
                    x0 = nx0,
                    y0 = ny0,
                    x1 = nx1,
                    y1 = ny1
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
     * 取**某一页**的文字行布局（含每行的归一化包围盒与字号）。
     *
     * ══ ⚠️⚠️ 为什么需要它：让 PDF 上的文字**可以被选中**（2026-09-25）══
     *
     * 用户从 v0.1.22 起反复反馈，最终说清：
     *   「字体根本无法选中啊」「都是只能识别点击」
     *   「面对任何形式的拖拽都没有办法识别啊」
     *   「我说的是原始视图」
     *
     * 真因：原始视图的页面是 `PdfRenderer` 渲染出的 **JPEG 位图**，
     * 网页那边就是一个 `<img>` —— **位图里没有文字对象**，
     * 手指划过它，浏览器不知道该"选中"什么。
     *
     * 内置 PDF 查看器（PDFium）能选，但它**必须在顶层文档**渲染，
     * 会盖掉我们的顶栏/底栏（见 MainActivity 里三次失败尝试的记录）。
     *
     * ✅ 唯一可行的路（也是 Chrome/Adobe 阅读器的做法）：
     *    在页图**上面**叠一层**透明的真实文字**，按坐标逐行定位。
     *      · 视觉上还是原始版面（文字 `color: transparent`）
     *      · 但文字真实存在 → 手指划过能选中、能高亮、能复制
     *
     * 这个方法提供那一层所需的全部数据。
     *
     * ══ 为什么按**行**而不是按字 ══
     *
     * 按字定位最准，但：
     *   · 一篇论文几万字，每字一个元素 → DOM 爆炸，滚动卡顿；
     *   · PDF 里同一行内字号可能混杂（正文里插一个数学符号），
     *     逐字要各自算字号；
     *   · 而"选中"这个操作**本来就以行为单位**才自然
     *     （手指划过的是一行或几行）。
     * 所以给整行一个盒子 + 行文字，让浏览器自己排版那一行 ——
     * 选中的粒度就是行，足够用且性能可接受。
     *
     * ⚠️ 只读**一页**：一篇 11 页的论文有上千行，
     *    全量序列化进 JS 会卡。网页按需（滚动到哪页取哪页）调用。
     *
     * ⚠️ 坐标系与 [Line] 完全一致（归一化 0..1、屏幕方向左上原点）
     *    —— 网页直接用百分比定位即可，不需要知道页面尺寸。
     *
     * @param page 页码，**从 1 开始**
     * @return 该页的文字行；PDF 不存在/加密/页码越界/扫描件都返回空列表
     */
    fun pageLines(pdf: File, page: Int): List<Line> {
        if (!pdf.exists() || !pdf.isFile || page < 1) return emptyList()

        return try {
            PDDocument.load(pdf).use { document ->
                if (page > document.numberOfPages) return emptyList()

                val collector = LineCollector()
                collector.startPage = page
                collector.endPage = page
                collector.lineSeparator = "\n"
                /*
                  ⚠️ 必须 sortByPosition —— 不设的话按内容流顺序输出，
                     双栏论文会左右栏交错，叠出来的文字层与位图**对不上**，
                     点选会选到隔壁栏的字。
                */
                collector.sortByPosition = true

                val buffer = java.io.StringWriter()
                collector.writeText(document, buffer)

                /*
                  ⚠️ 过滤掉退化行（无文字 / 零尺寸盒子）。
                     零尺寸的盒子叠到页面上是个点，会挡住相邻文字的选择，
                     而且它自己选不中任何东西 —— 纯噪音。
                */
                collector.raw.filter { l ->
                    l.text.isNotBlank() && l.x1 > l.x0 && l.y1 > l.y0
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "pageLines failed: ${pdf.name} page=$page", t)
            emptyList()
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

                /*
                  ⚠️ 截断时 **blocks 必须跟着截断**，否则会出现
                     「渲染出来的内容比 text 多」——前端按 blocks 渲染，
                     text 只用于复制/搜索，两者不一致会让用户困惑
                     （复制到的比看到的多）。

                     ⚠️ 截断规则：累加块长度直到超过 MAX_CHARS 就停。
                        不切块内部（半句话更糟），整块丢弃。
                */
                val blocks = if (body.length >= text.length) {
                    merged.blocks
                } else {
                    val kept = ArrayList<Block>(merged.blocks.size)
                    var used = 0
                    for (b in merged.blocks) {
                        val cost = b.text.length + 1
                        if (used + cost > MAX_CHARS) break
                        kept.add(b)
                        used += cost
                    }
                    Log.i(TAG, "truncated blocks: ${merged.blocks.size} -> ${kept.size}")
                    kept
                }

                /*
                  ⚠️ 每页的宽高比。

                     用途：网页要在页面上叠「标注框」（v0.1.17）。
                     框的位置用归一化坐标就够，但**容器**需要知道
                     页面的高宽比才能正确排布 —— 否则框会落在一个
                     高度不对的容器里，纵向位置全部偏掉。

                     ⚠️ 从文档对象直接读页面尺寸，不从 TextPosition 推 ——
                         有些页可能一行文字都没有（整页是图），
                         那时 TextPosition 里拿不到页宽页高，
                         而这一页恰恰最需要用户标注（是图片页）。
                */
                val ratios = ArrayList<Float>(document.numberOfPages)
                for (i in 0 until document.numberOfPages) {
                    try {
                        val box = document.getPage(i).cropBox ?: document.getPage(i).mediaBox
                        val w = box.width
                        val h = box.height
                        /*
                          ⚠️ 有些 PDF 的 CropBox 是**旋转过**的（横向页写成
                             竖的 + 一个 /Rotate 90）。这时宽高要对调，
                             否则网页画出来是躺着的。

                             ⚠️ 对调判据用 `/Rotate` 是 90 或 270 度。
                        */
                        val rot = document.getPage(i).rotation
                        val swapped = (rot == 90 || rot == 270)
                        val rw = if (swapped) h else w
                        val rh = if (swapped) w else h
                        ratios.add(if (rw > 0f) rh / rw else 0f)
                    } catch (t: Throwable) {
                        // 单页读失败不影响整篇；前端拿到 0 会退回 A4
                        ratios.add(0f)
                    }
                }

                Result(body, merged.lines, readOutline(document), blocks, ratios)
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
        val outBlocks = ArrayList<Block>(rawLines.size / 4 + 8)

        val para = StringBuilder()
        var paraMeta: Line? = null

        /*
          ⚠️ 正文基准字号：用**全部行的中位数**估计，不是平均值。

             为什么不用平均：标题、脚注、表格行会把平均值拉偏；
             中位数（行数最多的那个档）代表"正文长什么样"，
             这正是判断"这一行比正文大/粗"所需要的基准。

             ⚠️ 先按字号分桶（保留 0.5pt 精度）再取众数 ——
                比真中位数更稳：论文里正文占绝对多数，
                众数就是正文字号。
        */
        val bodySize = estimateBodySize(rawLines)

        fun flush() {
            if (para.isNotEmpty()) {
                val meta = paraMeta
                /*
                  ⚠️ 断词还原必须在这里做，因为合并时是用空格连接的
                     （`scientific re-` + `search` → `scientific re- search`），
                     所以正则要按**合并后的形态**（`- ` 连字符加空格）匹配。
                     实测四篇论文共 64 处（`learn- ing` `ex- tremely`）。
                */
                var blockText = para.toString()
                blockText = blockText.replace(Regex("(\\w)- (\\w)"), "$1$2")
                blockText = normaliseText(blockText)

                if (outText.isNotEmpty()) outText.append('\n')
                outText.append(blockText)
                if (meta != null) {
                    outLines.add(meta.copy(text = blockText, paragraphStart = true))
                    /*
                      ⚠️ 分类在 flush 时做，而不是逐行做 ——
                         因为「标题 / 公式 / 段落」的判据都依赖
                         **合并后的完整文本**（例如公式要看整段
                         有没有普通词，而不是某一行）。
                    */
                    outBlocks.add(classifyBlock(meta, blockText, bodySize))
                }
                para.setLength(0)
                paraMeta = null
            }
        }

        /**
         * 把新行的包围盒并入当前段落。
         *
         * ⚠️ 一个段落跨多行，用户看到的框应该是**整段的外接矩形**，
         *    而不是首行那一行的。只留首行的话，标注时会发现框只盖住了
         *    段落的第一行 —— 完全没法用来划定范围（实测这就是
         *    "框画出来对不上"的原因）。
         *
         * ⚠️ 只在**同一页**内合并。跨页的段落（极少见）取第一页的范围 ——
         *    因为页图是按页显示的，跨页的框在单页图上没有意义。
         */
        fun mergeBox(base: Line?, add: Line): Line {
            if (base == null) return add
            if (base.page != add.page) return base
            // 任一侧没有有效坐标（0 尺寸）就不参与合并
            if (add.x1 <= add.x0 || add.y1 <= add.y0) return base
            if (base.x1 <= base.x0 || base.y1 <= base.y0) {
                return base.copy(x0 = add.x0, y0 = add.y0, x1 = add.x1, y1 = add.y1)
            }
            return base.copy(
                x0 = minOf(base.x0, add.x0),
                y0 = minOf(base.y0, add.y0),
                x1 = maxOf(base.x1, add.x1),
                y1 = maxOf(base.y1, add.y1)
            )
        }

        /*
          ⚠️ 判断"这一行本身看起来是不是标题"，用来**在它之前**断开段落。

             踩过的坑：原来只在「已积累的内容是标题」时 flush
             （见下面 `looksLikeHead(para)`），于是**新标题会被
             并进上一段正文**。实测证据：

                 …The objective function, averaged over all the
                 training examples, can Deep le…   ← 下一节的标题黏上来了

             原因：`looksLikeHead(para)` 检查的是**已经在 buffer 里的
             文本**。而新标题到达时，buffer 里是上一段正文（不像标题），
             于是走"上一行在句中 → 合并"的分支，把标题拼了进去。

             ⚠️ 正确做法是**双向检查**：
                 · 到达的这行像标题 → 先 flush（本函数）
                 · 已积累的内容像标题 → 也 flush（原有逻辑）
               两个方向都会让标题独立成段。

             ⚠️ 这里用**形态判据**（looksLikeHead）而不是完整分类：
                完整分类需要 bodySize 与"合并后文本"，
                在逐行阶段拿不到。形态判据对"标题"这个决定足够 ——
                它宁可多断几次（多断只是多一个短段落，
                视觉上无害），也不要让标题黏进正文。
        */
        /**
         * 到达的这行是否开启新的块。
         *
         * ⚠️ 与旧版的**根本区别**：现在把**字号/粗体**作为主判据
         *    （[isHeadingByStyle]），形态判据只作补充。
         *    旧版只用 [looksLikeHead] 的纯文本形态 ——
         *    而实测 `1. Introduction`（12pt Bold）在窄行排版下
         *    反而没被判成标题，一堆正文行却判成了标题，正好反了。
         */
        fun startsNewBlock(t: String, size: Float, font: String): Boolean {
            if (t.isEmpty()) return true
            if (looksLikePageArtifact(t)) return true
            if (isHeadingByStyle(size, font, bodySize)) return true
            return looksLikeHead(t)
        }

        for (line in rawLines) {
            val t = normaliseText(line.text)

            // 空行 = 段落边界
            if (t.isEmpty()) {
                flush()
                continue
            }

            val flat = Line(t, line.font, line.size, line.page, false,
                line.x0, line.y0, line.x1, line.y1)

            /*
              ⚠️ **最优先：整行只有一个章节号**（`3` / `3.1`）。

                 这类行在 PDF 里是"编号单独一行、标题在下一行"的排法
                 （实测 Word2Vec 2013 / Transformer 2017）。
                 必须**攒进 para**，让下一行的标题文字接上来合成
                 `3.1 Problem Formulation`。

                 ⚠️ 若按"短行 → 独立块"处理，会得到一堆 `2.1` `2.2` 的
                    3 字符碎片，把段落长度中位数从 400+ 拉到 13（实测）。

                 ⚠️ 必须放在粗体判据**之前** —— 因为章节号行本身也是粗体，
                    否则会被 isHeadingByStyle 拦下来当独立标题。
            */
            if (BARE_NUMBER.matches(t)) {
                flush()
                para.append(t)
                paraMeta = flat
                continue
            }

            /*
              ⚠️ 上一行刚攒下章节号 → 这一行就是它的标题，无条件接上。
            */
            if (para.isNotEmpty() && BARE_NUMBER.matches(para.toString())) {
                if (needsSpaceBetween(para, t)) para.append(' ')
                para.append(t)
                paraMeta = mergeBox(paraMeta, flat)
                continue
            }

            /*
              ⚠️ 字号远小于正文 → 图表刻度 / 脚注 / 页码，**直接丢弃**。
                 见 [MIN_BODY_RATIO] 的注释（ResNet 那批 3.3pt 的 `0 1 2 3`）。
            */
            if (bodySize > 0f && line.size > 0f && line.size < bodySize * MIN_BODY_RATIO) {
                continue
            }

            /*
              ⚠️ 顺序要紧：**先**排掉页码/页眉（独立成块），
                 **再**判断公式碎片（黏合）。

                 反例（实测回归）：先判公式碎片 → 页码 `13.5`
                 被当成变量黏到页眉 `14` 上，产出 `13.5 14` 伪标题。
            */
            if (looksLikePageArtifact(t)) {
                flush()
                para.append(t)
                paraMeta = flat
                continue
            }
            if (isMathFragment(t) || isMathRun(t)) {
                /*
                  ⚠️ 公式碎片（`=` / `Δ` / `x` / `zk`）→ 无条件黏到当前段落。

                     · 不 flush：避免把「A = B」拆成三段
                     · 前面为空 → 自己起头（后续符号会跟上）

                 空格规则（实测两难）：
                   · 都不加 → `y_l` `y_j` 拼成 `ylyj`（可读性差）
                   · 都加   → `x` 与 `=` 拼成 `x =`（运算符被推开）
                   取中间：复用 needsSpaceBetween —— 只在**两侧都是
                   字母/数字**时补空格。于是 `x` + `=` 得 `x=`，
                   `yl` + `yj` 得 `yl yj`。
                */
                if (needsSpaceBetween(para, t)) para.append(' ')
                para.append(t)
                if (paraMeta == null) paraMeta = flat else paraMeta = mergeBox(paraMeta, flat)
                continue
            }

            /*
              ⚠️ 到达的这行像标题 / 像页码 → 先把上一段收掉。
                 见 startsNewBlock 的注释（这是"标题黏进正文"的修复）。
            */
            if (startsNewBlock(t, line.size, line.font)) {
                flush()
                para.append(t)
                paraMeta = flat
                continue
            }

            // 已积累的内容是标题 → 标题独立，正文另起
            if (para.isNotEmpty() &&
                startsNewBlock(para.toString(), paraMeta?.size ?: 0f, paraMeta?.font ?: "")
            ) {
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
                /*
                  ⚠️ 上一行在句中 → 合并。

                     两种情况：
                       ① 上一行以连字符结尾 → **断词续行**，去掉连字符直接接上
                          `scientific re-` + `search` → `scientific research`
                       ② 其他 → 英文之间补一个空格（中文之间不补）

                     ⚠️ 去掉连字符的理由（实测）：
                        帖子/论文里的 `re-` `pri-` `des-` 是**排版断词**，
                        不是单词里真有连字符。原样保留会得到
                        `re-search` `pri-vate` `des-tinée` —— 虽然能读，
                        但**拼接词**在检索和复制时会出问题
                        （搜 "research" 搜不到）。

                     ⚠️ 但不该去掉**真连字符**（`state-of-the-art`、
                        `multi-modal`）：那种情况下连字符后面通常**不是
                        断行处**。这里的判据是"上一行末字符是连字符"
                        —— 真连字符出现在行末的概率远低于断词，
                        且误去的代价只是少一个连字符（可读性影响小），
                        比对每个断词都留个尾巴小得多。
                */
                if (endsWithHyphen(para) && startsWithLetter(t)) {
                    para.setLength(para.length - 1)
                    para.append(t)
                } else {
                    if (needsSpaceBetween(para, t)) para.append(' ')
                    para.append(t)
                }
                // 元数据保留**第一行**的字体字号（段落首行决定排版属性），
                // 但包围盒要**并上这一行**（整段的外接矩形）
                if (paraMeta == null) paraMeta = flat else paraMeta = mergeBox(paraMeta, flat)
            }
        }
        flush()

        return Result(
            outText.toString(), outLines, emptyList(), outBlocks
        )
    }

    /**
     * 估计正文字号（**页级众数再投票**）。
     *
     * ══ ⚠️ 为什么不能直接取全局众数（2026-09-24 实测）══
     *
     * HAL 版 LeCun《Deep learning》的**封面页**整页用 10.9pt，
     * 而论文正文用 9.3pt。封面页的"长行"数量不小，
     * 直接把全局众数带偏 —— 实测得到 6.8pt，**全错**。
     *
     * 后果是灾难性的：正文 9.3pt 被判成"比基准(6.8)大 → 标题"，
     * 于是整篇正文都成了标题。
     *
     * ══ 正解：分层投票 ══
     *
     * ① 先算**每一页自己**的众数字号（页内噪声先被吸收）；
     * ② 再对"每页的众数"取众数 —— **一页一票**。
     *
     * 这样封面页只占一票，而正文有几十页，影响被压到最小。
     * 跨排版（封面/正文/附录用不同字号）时这个做法才稳。
     *
     * ⚠️ 只统计**较长的行**（长度 > 24）：标题、作者、页码都很短，
     *    把它们算进来会让众数偏到标题字号上，
     *    于是正文被判成"比基准小"，标题全部丢失。
     *
     * ⚠️ 按 0.5pt 分桶：PDF 里同一字号的浮点值有微小抖动
     *    （9.2999999 vs 9.3），不分桶会散成一堆只出现一次的值，
     *    众数就失去意义。
     */
    private fun estimateBodySize(lines: List<Line>): Float {
        // ① 每页的字号直方图
        val perPage = HashMap<Int, HashMap<Int, Int>>()
        for (l in lines) {
            if (l.size <= 0f) continue
            if (l.text.trim().length <= BODY_SAMPLE_MIN_CHARS) continue
            val key = Math.round(l.size * 2f)
            val bucket = perPage.getOrPut(l.page) { HashMap() }
            bucket[key] = (bucket[key] ?: 0) + 1
        }
        if (perPage.isEmpty()) return 0f

        // ② 每页投出它自己的众数（一页一票），再对票数取众数
        val votes = HashMap<Int, Int>()
        for ((_, bucket) in perPage) {
            var bk = 0
            var bn = -1
            for ((k, n) in bucket) {
                if (n > bn) {
                    bn = n
                    bk = k
                }
            }
            votes[bk] = (votes[bk] ?: 0) + 1
        }

        var bestKey = 0
        var bestN = -1
        for ((k, n) in votes) {
            if (n > bestN) {
                bestN = n
                bestKey = k
            }
        }
        return bestKey / 2f
    }

    /**
     * 判定一个已合并的块属于哪一类。
     *
     * ⚠️ 判据是启发式的。取舍原则（与 mergeParagraphs 一致）：
     *    宁可漏判（把标题当正文），也不要误判
     *    （把正文当标题 → 字号忽大忽小，比不区分更难看）。
     *    所以每条规则都**偏保守**。
     */
    private fun classifyBlock(meta: Line, text: String, bodySize: Float): Block {
        val t = text.trim()

        // ① 公式：整块几乎没有普通词，且数学符号密度高
        if (looksLikeFormula(t)) {
            return Block("formula", t, 0, meta.page, meta.x0, meta.y0, meta.x1, meta.y1)
        }

        /*
          ⚠️ 先排除**页码 / 页眉 / 纯编号行**（实测误判的重灾区）。

             收紧判据后统计命中的 60 个标题里，29 个是这类：

               NUMBER_ONLY 命中 23 个 → `9` `10` `10.5` `11.5` …  **页码**
               NUM_PREFIX  命中  6 个 → `1 | 9` `2 | 9` …           **页眉「页/总页」**

             ⚠️ 根因：`NUMBER_ONLY`（整行只有编号）本意是匹配
                "单独一行的章节号"，但**页码恰好也是单独一行的数字** ——
                两者在字符形态上完全无法区分。

            ⚠️ 取舍：**放弃**「整行只有编号」这条判据。
                理由：真实论文里章节号几乎总是与标题同处一行
                （`3 Methodology`），单独占一行的编号极少见；
                而页码**每页都有**。为了极少见的形态换来每页一个假标题，
                得不偿失。

                ⚠️ 这不是"漏判"——`3 Methodology` 这种仍由
                   HEADING_NUM_PREFIX 覆盖，那才是主导形态。
        */
        if (looksLikePageArtifact(t)) {
            return Block("paragraph", t, 0, meta.page, meta.x0, meta.y0, meta.x1, meta.y1)
        }

        /*
          ⚠️ 表格数据行 → 当段落，**绝不**当标题。
             见 [looksLikeTableRow] 的注释（实测 82 个"标题"里 31 个是表格行）。
             放在标题判据**之前**。
        */
        if (looksLikeTableRow(t)) {
            return Block("paragraph", t, 0, meta.page, meta.x0, meta.y0, meta.x1, meta.y1)
        }

        /*
          ⚠️ 封顶长度。

             `2022 saw the release of…` 这类**以年份开头的正文段落**
             会被 HEADING_NUM_PREFIX 收进来（"2022 " 完全符合
             `\d+\s+\S`）。真标题不会长到 90 字符以上。
        */
        if (t.length > TITLE_MAX_CHARS) {
            return Block("paragraph", t, 0, meta.page, meta.x0, meta.y0, meta.x1, meta.y1)
        }

        /*
          ══ 标题判据（第三版，2026-09-24 用字体/字号重做）══

          第一版「短行 + 无句末标点」→ 封面页整段地址被判成 12 个标题，
            且在窄行排版下把 54-72% 的正文行切碎。
          第二版加了"至少一个正向信号"的限制。
          本版把**字号/粗体提升为主判据**（相对判据，跨排版成立）。

          信号（满足任一即可）：
            · 编号 + 标题文字（`3 Methodology` / `3.1 Problem`）
            · 全大写（`ABSTRACT` / `RELATED WORK`）
            · 字号明显大于正文      ← 最可靠
            · 粗体
        */
        val hasNumberedTitle = HEADING_NUM_PREFIX.containsMatchIn(t) && t.length <= TITLE_MAX_CHARS
        val allCaps = UPPER_HEAD.matches(t) && t.length >= 3

        if (hasNumberedTitle || allCaps) {
            return Block("heading", t, headingLevel(t), meta.page, meta.x0, meta.y0, meta.x1, meta.y1)
        }

        /*
          ⚠️ 字号/粗体判据**必须**加长度与"像不像正文句子"的限制。

             ══ 为什么（实测，HAL 版 LeCun《Deep learning》）══

             封面页的字体与论文正文完全不同：
                 封面页   LibertinusSerif-Regular  10.9pt
                 正文     MinionPro-Regular         9.3pt
                 真标题   GlosaMath-Bold          10.0pt

             只看「比正文大/粗」会把整张封面判成标题（实测 31 块）——
             因为封面确实用了更大的字。这是**数据本身的特征**。

             所以还要**排除长句与正文句子**：
               · 长度 <= TITLE_MAX_CHARS（早已在上面检查过）
               · 不能"像正文"（[looksLikeProse]：较长且含句末标点）

             ⚠️ 诚实的局限：作者名、单位、邮箱这些短行依然可能被判成标题
                （它们短、且与正文不同字体）。这在视觉上只是"字号略大"，
                不影响可读性；而为了消掉它们把字号判据整条删掉，
                会让真正无编号的节标题全部丢失 —— 取舍下保留。
        */
        val styleEvidence = isHeadingByStyle(meta.size, meta.font, bodySize)
        if (styleEvidence && !looksLikeProse(t)) {
            return Block("heading", t, headingLevelByStyle(t, meta.size, bodySize), meta.page,
                meta.x0, meta.y0, meta.x1, meta.y1)
        }

        return Block("paragraph", t, 0, meta.page, meta.x0, meta.y0, meta.x1, meta.y1)
    }

    /**
     * 这一块是不是**页码 / 页眉 / 纯编号**这类非内容行。
     *
     * ⚠️ 判据都基于"内容形状"，不依赖位置（PDF 里拿页眉页码的
     *    坐标再判断一轮成本高，而形状判据已足够）。
     *
     * 三类：
     *   ① 纯数字（含小数、罗马数字）—— 页码、公式编号
     *      如 `9` / `10.5` / `IV`
     *   ② 「数字 | 数字」—— 页眉的「当前页/总页」
     *      如 `1 | 9` / `12 | 24`
     *   ③ 单字符或纯符号 —— 分隔线残留、项目符号
     */
    private fun looksLikePageArtifact(t: String): Boolean {
        if (t.isEmpty()) return true

        // ① 纯数字 / 小数 / 罗马数字
        if (PAGE_NUMBER.matches(t)) return true

        // ② 「页 | 总页」（分隔符可能是 | 或 / 或 of）
        if (PAGE_HEADER.matches(t)) return true

        // ③ 太短，不可能是标题
        // ⚠️ 但**单个数学符号 / 项目符号**（= Δ ∑ • …）不算页面残留：
        //    PDF 里公式常被拆成「一行一个符号」，
        //    把它们当残留丢掉 → 公式内容残缺；
        //    当成新块 → 正文里散落一堆单字符段落（实测 31 个）。
        //    正确做法是让它**黏到相邻块**，所以这里返回 false，
        //    由 isMathFragment / isMathRun 分支去合并。
        if (t.length <= 1) {
            return !MATH_SYMBOL.contains(t[0]) && t[0] !in BULLET_CHARS
        }

        return false
    }

    /** 单个数学符号（公式被拆行时的碎片）。这些不该触发新块 */
    private val MATH_SYMBOL = "=+−-×÷±∑∏∫√∞≤≥≠≈∈∉⊂⊆∪∩→←↔∂∇^_*<>|()[]{}".toSet()

    /**
     * 这一行是不是**公式被拆行后的单个符号碎片**（`=` `Δ` `∑` …）。
     *
     * ⚠️ 只认**单字符**，不认 `Δx` 这种带变量的（那更像正常内容）。
     *    判据故意极窄 —— 宽了会把正文里的孤字也黏走。
     */
    private fun isMathFragment(t: String): Boolean {
        if (t.length != 1) return false
        return MATH_SYMBOL.contains(t[0]) || t[0] in BULLET_CHARS
    }

    /**
     * 这一行是不是**公式变量的孤字**（`x` `y` `z` `W` `yl` `zk` `wjk` …）。
     *
     * ⚠️ 实测来源：论文里的公式被排版成**一行一个变量**（LaTeX 数学符号
     *    字体逐个成行），于是正文里散落 `x` `y` `W` `V` `yl` `zk`
     *    这样的超短片段（本次统计 128 个 ≤3 字符的段落）。
     *
     * 判据（**全部**满足才算）：
     *   ① 极短：长度 ≤ [MATH_RUN_MAX]
     *   ② 无空格：公式变量不会含空格（`x y` 更像正文断行）
     *   ③ 无句末标点：变量片段不会是句子
     *   ④ 全为「字母/数字/数学符号」
     *   ⑤ **不是页码/页眉**：`13.5` `1 | 9` 这类必须走页面残留分支
     *      （实测回归：少了这条，`13.5` 会和页眉 `14` 黏成 `13.5 14`）
     *
     * ⚠️ 只作**黏合**用（不 flush、不补空格），
     *    所以误判代价只是"两个短片段贴在一起"，比留下孤字好看得多。
     */
    private fun isMathRun(t: String): Boolean {
        if (t.isEmpty() || t.length > MATH_RUN_MAX) return false
        // ⑤ 页码 / 页眉优先（否则 `13.5` 会黏住 `14`）
        if (PAGE_NUMBER.matches(t) || PAGE_HEADER.matches(t)) return false
        if (t.contains(' ')) return false
        if (t.any { PROSE_END.contains(it) }) return false
        if (t.any { it == ',' || it == '、' }) return false
        // 至少要有一个字母或数字（纯符号已由 isMathFragment 处理）
        if (t.none { it.isLetterOrDigit() }) return false
        return t.all { it.isLetterOrDigit() || MATH_SYMBOL.contains(it) }
    }

    /** 公式变量孤字的长度上限（`wjk` = 3；放宽到 6 覆盖 `x_{ij}` 类） */
    private const val MATH_RUN_MAX = 6

    /** 项目符号（Symbol 字体的 • 落在私用区 U+F0B6） */
    private val BULLET_CHARS = "\uF0B6\uF0B7\u2022\u25CF\u25AA\u00B7".toSet()

    /** 页码 / 公式编号：纯数字、小数、罗马数字 */
    private val PAGE_NUMBER = Regex("^\\d+(?:\\.\\d+)?$|^[IVXLC]{1,6}\\.?$")

    /** 页眉「当前页 | 总页」或「当前页 of 总页」 */
    private val PAGE_HEADER = Regex("^\\d+\\s*(?:\\||/|of)\\s*\\d+$")

    /**
     * 这一块看起来像**散文句子**（而不是标题）。
     *
     * ⚠️ 用于给"仅靠字体"的判据加一道闸：真标题极少以句末标点结尾，
     *    也极少是完整的短句。
     *
     * 判据（三条任一即可）：
     *   ① 以句末标点结尾（`. ? ! ; :`）—— 标题几乎不这样
     *   ② 含逗号且长度超过 30 —— 标题里的逗号少见
     *   ③ 以小写字母开头且含空格 —— 标题通常首字母大写
     *
     * ⚠️ ③ 是为挡 "for the deposit and dissemination of scientific re-"
     *    这类**被折断的正文行**：它们首字母小写。
     *    真标题（英文）几乎总以大写字母或数字开头。
     */
    private fun looksLikeProse(t: String): Boolean {
        if (t.isEmpty()) return false

        val last = t[t.length - 1]
        if (PROSE_END.contains(last)) return true

        if (t.contains(',') && t.length > 30) return true

        val first = t[0]
        if (first.isLowerCase() && t.contains(' ')) return true

        return false
    }

    /** 句末/从句标点。标题极少以这些结尾 */
    private val PROSE_END = charArrayOf('.', '?', '!', ';', '。', '？', '！', '；')


    /**
     * 标题层级：1 = 章，2 = 节。
     *
     * ⚠️ 只分两档，且判据极简：
     *      · `3.1` / `3.1.2` 这种**带点的编号** → 2
     *      · `3` / `IV` / `ABSTRACT` / `RELATED WORK` → 1
     *
     * ⚠️ 不去按字体大小分档（"更大的是一级"）：
     *    实测同一份 PDF 里章标题与节标题的字号可能相同
     *    （出版社模板常这样），按字号分会得到一堆层级错的目录。
     *    编号形式反而是可靠的。
     */
    private fun headingLevel(text: String): Int {
        val t = text.trim()
        val m = Regex("^§?\\s*(\\d+(?:\\.\\d+)*)").find(t)
        if (m != null) {
            // 编号里的点有几个 → 层级几（3 = 1, 3.1 = 2, 3.1.1 = 3 封顶）
            val dots = m.groupValues[1].count { it == '.' }
            return (dots + 1).coerceAtMost(3)
        }
        return 1
    }

    /**
     * 按**字号相对正文的超出幅度**推断标题层级。
     *
     * ⚠️ 只在没有编号可用时才走这里（有编号时 [headingLevel] 更可靠 ——
     *    编号的点分直接表达层级，`3` 是一级、`3.1` 是二级）。
     *
     * ══ 为什么用**字号差**而不是绝对字号（实测）══
     *
     * ResNet 论文正文 10.0pt：
     *     `1. Introduction`          12.0pt  → 差 +2.0  → 一级
     *     `3.1. Residual Learning`   11.0pt  → 差 +1.0  → 二级
     *
     * ⚠️ 阈值取 1.8：要把 +2.0 与 +1.0 分开。
     *    取 1.0 → 两者都判一级（层级丢失）；
     *    取 2.5 → 两者都判二级。
     *    这个数是从真实排版里**量出来的**，不是拍的。
     *
     * ⚠️ 不同期刊的实际差值不同（有的章 +3pt、节 +1.5pt），
     *    但「章比节大得多」这个**顺序关系**是普遍的，
     *    所以用两档 + 一个中间阈值，比猜具体数值稳。
     */
    private fun headingLevelByStyle(text: String, size: Float, bodySize: Float): Int {
        // 有编号优先用编号
        val byNum = headingLevel(text)
        if (byNum > 1) return byNum

        if (bodySize <= 0f) return 1
        return if (size - bodySize >= 1.8f) 1 else 2
    }


    /**
     * 判据：这一行是不是**表格数据行**。
     *
     * ══ ⚠️ 为什么必须单独判（2026-09-24 实测）══
     *
     * ResNet 论文里 82 个"标题"中有 **31 个其实是表格行**：
     *
     *     `27.94 27.88 34 layers`
     *     `28.54 25.03 Table 2. Top-1 error (%, 10-crop testing)…`
     *     `24.27 7.38 plain-34`
     *     `28.54 10.02 ResNet-34 A`
     *
     * 这些行**在 PDF 里是表格单元格**，提取出来后变成"短行"，
     * 而表格里常用稍粗/稍大的字（表头），于是被字号判据收成标题。
     *
     * 渲染成标题的后果很糟：字号忽大忽小、目录里混进一堆数字。
     *
     * ══ 判据 ══
     *
     * 表格数据行的特征是**多个数值/短 token 并排**（列结构被拉平）：
     *   · 以数字开头，且
     *   · 含有 2 个以上的"数值 token"（`\d+(\.\d+)?` 或带 % 的）
     *
     * ⚠️ 为什么要求**至少 2 个**数值：
     *    `3.1. Residual Learning` 也以数字开头，但只有一个编号数值，
     *    它是**真标题**。只按"以数字开头"判会把所有编号标题误伤。
     *
     * ⚠️ 为什么还要限制长度：长段落里出现两个数值很正常
     *    （"we achieve 3.57% and 4.49% error"）。表格行是**短的**。
     */
    private fun looksLikeTableRow(t: String): Boolean {
        if (t.length > TABLE_ROW_MAX_CHARS) return false
        if (!TABLE_ROW_START.containsMatchIn(t)) return false
        // 数值 token 至少 2 个（含 % 也算）
        return TABLE_NUMBER.findAll(t).take(2).count() >= 2
    }

    /**
     * 判据：这一块是不是公式。
     *
     * ⚠️ 判据选的是「**几乎没有普通词**」而不是「含有数学符号」——
     *    因为正文里也会出现单个数学符号（"x 轴"、"O(n) 复杂度"），
     *    反过来，公式里也可能全是字母（`E = mc2`）。
     *    真正区分公式的是：**它不成句**（没有多个常见英文词）。
     *
     * ⚠️ 具体做法：
     *     ① 统计长度 ≥ 4 的纯字母词个数（这类词是正常英文单词的特征）
     *     ② 统计非字母数字字符的占比（运算符、括号、等号…）
     *     ③ 词少 + 符号多 → 公式
     *
     * ⚠️ 阈值取得**宽松**（2 个词 / 25% 符号）：
     *    略宽的后果只是把少数短正文行标成公式（它们加了底纹，
     *    仍能读）；反过来把公式当正文，读起来就是乱码 ——
     *    两害相权，宁可多标。
     */
    private fun looksLikeFormula(text: String): Boolean {
        val t = text.trim()
        if (t.length < 2) return false
        // 太长的块基本不是公式（公式块通常一两行）
        if (t.length > FORMULA_MAX_CHARS) return false

        val words = Regex("[A-Za-z]{4,}").findAll(t).count()
        if (words > 2) return false

        /*
          ⚠️ 先排除三类**明显的非公式**（实测误判来源）：

             第一版把下面这些都判成了公式：
               `https://hal.science/hal-04206682v1`   ← URL
               `Nature, 2015, 521 (7553), pp.436-444.` ← 引用信息
             根因是它们都"词少 + 符号多"，而符号里有 `/` `(` `)`
             这些**普通标点也会用**的字符。

             ① URL / 邮箱 —— 含 "://" 或 "www." 或 "@"
             ② 引用/出版信息 —— 含 "pp." / "vol." / "no." / 年份区间
             ③ 章节编号行 —— 形如 "1 | 9" / "(2)" 这类**页码、公式编号**
                （它们确实该单独成行，但不是公式内容本身，
                 归到 formula 会让正文里到处是灰底块）

             ⚠️ 判据用"含这些标记"而不是正则精确匹配：
                目的是**降低误判**，不追求完备。
        */
        val low = t.lowercase()
        if (low.contains("://") || low.startsWith("www.")) return false
        if (low.contains("pp.") || low.contains("vol.") ||
            low.contains("no.") || low.contains("issn")
        ) {
            return false
        }
        // 纯编号/页码行：只有数字与分隔符，没有运算符
        if (Regex("^[\\s\\d|()\\[\\].\\-–—]+$").matches(t)) return false

        /*
          ⚠️ 符号集**去掉**了普通标点 `()` `[]` `/` `<` `>` ——
             它们在中英文正文里太常见（"(see Fig. 3)"、"and/or"），
             算进来会把正常句子推过阈值。

             只保留**真正的数学运算符**。这样阈值可以取得很低
             （0.08），因为分母里混入的噪声符号已经没有了。
        */
        var symbols = 0
        for (c in t) {
            if (c in "=+−×÷±∑∏∫√∞≤≥≠≈∈∉⊂⊆∪∩→←↔∂∇^_") {
                symbols++
                continue
            }
            /*
              ⚠️ `-` 与 `*` 单独处理：它们既是运算符也是普通标点
                 （连字符 "state-of-the-art"、星号脚注）。
                 只在**两侧都是数字或字母**时才当运算符
                 （"a-b" 是减法，"state-of" 不是）。
            */
            if (c == '-' || c == '*') symbols++
        }
        val ratio = symbols.toFloat() / t.length.toFloat()
        return ratio >= FORMULA_MIN_SYMBOL_RATIO
    }

    /** 公式块长度上限 */
    private const val FORMULA_MAX_CHARS = 300

    /** 公式判据：符号占比下限（符号集已去噪，可取低值） */
    private const val FORMULA_MIN_SYMBOL_RATIO = 0.08f

    /** 段末标点。中英文都列，因为论文里两种都可能出现 */
    private val SENTENCE_END = charArrayOf(
        '.', '?', '!', ':', ';', '。', '？', '！', '：', '；', '」', '』', '）', ')', '"'
    )

    /** 独立成行的编号，如 `3` / `3.1` / `IV.` */
    private val NUMBER_ONLY = Regex("^§?\\s*(\\d+(\\.\\d+)*|[IVXLC]+)[.、]?$")

    /** 全大写标题，如 `ABSTRACT` / `RELATED WORK` */
    private val UPPER_HEAD = Regex("^[A-Z][A-Z0-9 \\-,:&'()/]{2,}$")

    /**
     * 以编号开头的标题，如 `3 Methodology` / `3.1 Problem Formulation`。
     *
     * ⚠️ 与 [NUMBER_ONLY] 的区别：后者要求**整行只有编号**
     *    （`3` 单独一行），这里允许编号后面跟标题文字。
     *    两种形态在真实论文里都常见，必须都覆盖。
     */
    private val HEADING_NUM_PREFIX = Regex("^§?\\s*\\d+(?:\\.\\d+)*\\s+\\S")

    /**
     * 标题长度上限。
     *
     * ⚠️ 用来兜住「以编号开头的正文段落」——
     *    如 "2015 saw the release of the Transformer architecture…"
     *    会被 [HEADING_NUM_PREFIX] 收进来。标题不会这么长。
     */
    private const val TITLE_MAX_CHARS = 90

    /**
     * 字号容差：超过正文字号这么多才算「比正文大」。
     *
     * ⚠️ 取 0.35pt 而不是更大：不少出版社模板里节标题只比正文大 0.5pt
     *    （实测 ResNet 论文 12.0 vs 10.0、子节 11.0 vs 10.0）。
     *    容差过大会漏掉这些「只大一点」的标题。
     */
    private const val BODY_SIZE_TOL = 0.35f

    /**
     * 正文字号的最小比例。低于 `bodySize * 该值` 的行**不是正文**。
     *
     * ══ ⚠️ 为什么必须有这条（2026-09-24 实测）══
     *
     * ResNet 论文里有一整批 **3.3pt** 的行：`0` `1` `2` `3` `4` `5` `6`
     * —— 那是训练曲线的**坐标轴刻度**；还有 6.6pt 的
     * `training error (%)`（坐标轴标题）。正文字号是 10.0pt。
     *
     * 这些行有两个致命特征：
     *   ① 它们不是句子，读起来是乱码（`0 1 2 3 4 5 6`）；
     *   ② 数量极大（一张图几十行），会把段落长度统计彻底污染 ——
     *      实测未过滤时"短段落占比"高达 51.8%，几乎全是这些刻度。
     *
     * ⚠️ 取 0.75 而不是更激进：论文正文里的上标/下标可能到 0.8 倍
     *    （`x²`、`H₂O`），脚注常是 0.85-0.9 倍。
     *    0.75 能把图表刻度筛掉，又不至于误伤脚注（脚注是完整句子，留着无害）。
     */
    private const val MIN_BODY_RATIO = 0.75f

    /**
     * 纯编号单独成行的形态：`3` / `3.1` / `3.1.2`。
     *
     * ══ ⚠️ 为什么需要它（2026-09-24 实测）══
     *
     * PDF 的章节号有两种排法：
     *   a) `3.1 Problem Formulation`    —— 编号与标题同一行
     *   b) `3.1` / `Problem Formulation` —— 编号**单独一行**
     *
     * 形态 b 很常见（实测 Word2Vec 2013、Transformer 2017 都是）。
     * 它在纯文本流里表现为一个 3 字符的孤立行，
     * 若按"短行 → 独立块"处理，会得到一堆 `2.1` `2.2` `2.3` 的碎片，
     * 把段落长度中位数从 400+ 拉到 13（实测）。
     *
     * 所以必须**先识别它、攒着**，让紧接着的标题行接上来合成一行。
     */
    private val BARE_NUMBER = Regex("^\\d{1,2}(?:\\.\\d{1,2}){0,2}\\.?$")

    /**
     * 表格数据行的长度上限（表格行都很短）。
     *
     * ⚠️ 取 110 而不是 70：表格行常带表题
     *    （`28.54 25.03 Table 2. Top-1 error (%, 10-crop testing)…`），
     *    这类行会到 90-110 字符。70 会让它们漏网（实测 82→60 之后
     *    仍有 8 条这种）。
     */
    private const val TABLE_ROW_MAX_CHARS = 110

    /** 表格行以数值开头 */
    private val TABLE_ROW_START = Regex("^\\d")

    /** 表格里的数值 token（含百分号、小数点、负号） */
    private val TABLE_NUMBER = Regex("-?\\d+(?:\\.\\d+)%?")

    /*
      ⚠️⚠️ 这里曾经有一个 `SHORT_LINE = 60` 常量，作为「是不是独立块」的
         **主判据**（`len <= 60 && 末字符不是句末标点 → 独立块`）。
         它已经**被删除**，因为那是 2026-09-24 那次「抽取结果一团乱麻」的根因：

           · 60 是按**双栏宽行**（每行 60-90 字符）拍的；
           · 而用户论文库里大量**单栏窄行**排版，中位行宽只有 10-36 字符；
           · 于是 54%~72% 的正文行都满足 `<= 60`，
             只要该行恰好不以句末标点结尾就被切成独立块。

         **判据：绝对字符数阈值不能跨排版使用。**
         双栏宽行与单栏窄行的行宽差 3-5 倍，任何固定值都只能对一半文档有效。

         现在分段由**字号与粗体**（相对判据，见 [isHeadingByStyle]）主导。
         不要再把它加回来。
    */

    /**
     * 估计正文字号时，参与统计的最小行长度。
     *
     * ⚠️ 用 24：太小会把标题/作者/页码算进来（众数偏到标题字号上），
     *    太大则会丢掉大量**真实正文行** —— 窄行排版下正文行常常只有
     *    20-40 字符（实测中位 10-36），门槛高一点样本就不够了。
     */
    private const val BODY_SAMPLE_MIN_CHARS = 24

    /**
     * 连字（ligature）还原表。
     *
     * ⚠️ 为什么需要：PDF 里 `fi` `fl` 常被排成**单个字形**
     *    （U+FB01 等），提取出来就是 `ﬁ` `ﬂ`。
     *    实测四篇论文里共 64 处 —— `difﬁcult` `classiﬁcation` `ﬂow`。
     *
     * 后果不只是"看起来怪"：
     *   · 复制出去贴到别处（Word/浏览器）会变成方框或乱码；
     *   · 全文检索 `difficult` **搜不到** `difﬁcult`。
     *
     * ⚠️ 必须在**入库前**还原（而不是渲染时）：
     *    否则 text 与 blocks 两处会不一致，
     *    且用户复制的、搜索的、后续做全文索引的都是未还原的那份。
     */
    private val LIGATURES = mapOf(
        "\uFB00" to "ff",
        "\uFB01" to "fi",
        "\uFB02" to "fl",
        "\uFB03" to "ffi",
        "\uFB04" to "ffl",
        "\uFB05" to "st",
        "\uFB06" to "st"
    )

    /** 连字还原 + 连续空白压缩。所有文本入库前都要过这一道 */
    private fun normaliseText(s: String): String {
        if (s.isEmpty()) return s
        var out = s
        for ((k, v) in LIGATURES) {
            if (out.contains(k)) out = out.replace(k, v)
        }
        // 压缩连续空格/制表符（PDF 提取常见多个空格对齐）
        return out.replace(Regex("[ \\t]+"), " ").trim()
    }

    /**
     * 判断某个字体名是否**看起来是粗体/中等粗细**。
     *
     * ⚠️ 只看字体名，不看字形 —— 后者要解析字体程序，成本高得不成比例。
     *
     * ⚠️ 关键词要覆盖各家的命名习惯（实测都是真实遇到过的）：
     *    `-Bold`      Adobe/LaTeX 系（NimbusRomNo9L-Medi 是 Times 的粗体）
     *    `Medi`       URW 的 "Medium"（**注意不能写成 "Medium"** ——
     *                 实际字体名是 `NimbusRomNo9L-Medi`，被截断过）
     *    `CBX` / `CBB` Computer Modern 的 bold extended / bold
     *    `Black` `Heavy` `SemiB`  其他常见别名
     */
    private fun isBoldFont(name: String): Boolean {
        if (name.isEmpty()) return false
        val n = name.lowercase()
        return n.contains("bold") || n.contains("black") || n.contains("heavy") ||
            n.contains("medi") || n.contains("semib") ||
            n.contains("cbx") || n.contains("cbb") || n.contains("-md")
    }

    /**
     * 判断一行是否「自成一段」（标题、作者、单位、编号等）。
     *
     * ⚠️⚠️ **2026-09-24 重写：这里过去是最大的 bug 来源。**
     *
     * 旧版是 `len(s) <= SHORT_LINE(60) && 末字符不是句末标点 → true`。
     * 那 60 是按双栏宽行拍的，而用户论文多为单栏窄行（中位 10-36 字符）
     * → 54%~72% 的正文行被误判成独立块。
     *
     * 现在的**主判据是字号与粗体**（相对判据，跨排版成立），
     * 形态判据只保留两条与排版无关的：
     *   ① 全大写（`ABSTRACT` / `RELATED WORK`）
     *   ② 以编号开头（`3 Methodology` / `3.1 Problem`）
     *
     * ⚠️ **不再**用"短行且无句末标点"当判据 —— 那条在窄行排版下必然误伤。
     *    字号信息在 [classifyBlock] 与 [isHeadingByStyle] 里用，
     *    那里能拿到 bodySize。
     */
    private fun looksLikeHead(s: String): Boolean {
        if (s.isEmpty()) return false
        if (NUMBER_ONLY.matches(s)) return true
        if (UPPER_HEAD.matches(s) && s.length >= 3) return true
        if (HEADING_NUM_PREFIX.containsMatchIn(s) && s.length <= TITLE_MAX_CHARS) return true
        return false
    }

    /**
     * **按排版属性**判断这一行是否开启新的块（标题）。
     *
     * ══ 这是修好「段落被拆碎 / 标题认不出来」的关键函数 ══
     *
     * 旧代码把字号与粗体信号**算出来了却没用于分段决策** ——
     * 实测 ResNet 的 `1. Introduction`（12.0pt Bold）被判为普通行，
     * 而一堆正文行（10.0pt Regular）反被判为独立块。正好反了。
     *
     * @param size      该行的主字号
     * @param font      该行的主字体名
     * @param bodySize  正文字号（由 [estimateBodySize] 得出；0 表示未知）
     */
    private fun isHeadingByStyle(size: Float, font: String, bodySize: Float): Boolean {
        if (bodySize <= 0f) return false
        // 字号明显大于正文 —— 最可靠的信号
        if (size > bodySize + BODY_SIZE_TOL) return true
        // 粗体（但字号不小于正文时才靠它；否则是标题里的强调）
        if (isBoldFont(font) && size >= bodySize - BODY_SIZE_TOL) return true
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

    /** 已积累的文本是否以连字符结尾（断词续行的标志） */
    private fun endsWithHyphen(a: StringBuilder): Boolean {
        if (a.isEmpty()) return false
        val c = a[a.length - 1]
        return c == '-' || c == '\u2010' || c == '\u2011'
    }

    /** 新行是否以字母开头（断词续行只会接字母，不会接数字/符号） */
    private fun startsWithLetter(t: String): Boolean {
        if (t.isEmpty()) return false
        val c = t[0]
        return c.isLetter() && c.code < 0x2E80
    }
}
