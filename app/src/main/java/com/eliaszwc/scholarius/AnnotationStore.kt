package com.eliaszwc.scholarius

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 用户对 PDF 的**标注**（v0.1.17）。
 *
 * ══ 为什么要有这个功能 ══
 *
 * 从 PDF 自动判断「这段是公式、这块是表格、这行是标题」的准确率
 * **永远上不去** —— 排版千变万化，靠字号/字形/位置猜，总有一批判错。
 * 与其继续加规则，不如**把判断权交给用户**：用户看得到原始页面，
 * 一眼就知道哪块是什么。我们只负责「让用户指得方便」。
 *
 * ══ ⚠️⚠️ 两套机制，绝不能混为一谈 ══
 *
 * 用户的原话：
 *   「标题、摘要、作者肯定都是文本啊，可以选中；我说的不是框，
 *     而是类似选中的区域，框只能是方的，但区域可以根据文本来」
 *
 * | | **文本标注** [TextMark] | **矩形标注** [RegionMark] |
 * |---|---|---|
 * | 内容 | 标题/作者/摘要/正文/章节标题/脚注/参考文献/关键词 | 公式/表格/图片 |
 * | 边界 | 由**文字自身**决定（段落从哪行到哪行） | 手画**矩形** |
 * | 操作 | **选中文字** → 指定类型 | 拖矩形 → 指定类型 |
 * | 为什么 | 段落文本**不是矩形**，框不住 | 里面没有可选的文字 |
 *
 * ⚠️ **不要给文本加矩形框**。这是个很容易犯的错（第一版就打算把
 *    `text` 加进矩形标注的类型里），但段落是不规则形状：
 *    标题一行居中、摘要两端对齐、正文有缩进 —— 方框会框进
 *    旁边的栏、页眉、公式编号，用户看到的框是错的。
 *
 * ## 存储布局
 *
 * ```
 * filesDir/library/<docId>/annotations.json
 * ```
 *
 * ⚠️ 与 `doc.pdf` **同一个目录** —— 删文献时 `deleteRecursively()`
 *    会把标注一并删掉，不会留下孤儿文件。
 *
 * ## 为什么存独立 JSON 而不是塞进 LibraryStore 的 index.json
 *
 * index.json 每次改动都要**整份重写**，而标注是**频繁**编辑的
 * （用户会连续画十几个框）。混在一起则每画一个框都要重写全部文献元数据
 * —— 既慢，又容易在中断时损坏索引。分开放，各自独立。
 *
 * ## 线程
 *
 * ⚠️ 所有方法都是**阻塞式文件 IO**，调用方必须在工作线程上调用。
 */
object AnnotationStore {

    private const val TAG = "AnnotationStore"
    private const val FILE_NAME = "annotations.json"

    // ────────────────────────────────────────────────────────────
    // 矩形标注：公式 / 表格 / 图片（非文本）
    // ────────────────────────────────────────────────────────────

    /**
     * 合法的**矩形**标注类型。
     *
     * ⚠️ 这是唯一合法值清单，前后端都以它为准：
     *    · 网页端 `reader.js` 的 `REGION_TYPES` 与此一一对应；
     *    · 读文件时用 [isValidRegionType] 过滤 —— 手改过的 JSON、
     *      或旧版本写下的未知类型，一律丢弃而不是让前端去猜。
     *
     * ⚠️ 故意**不含任何文本类型** —— 见文件头「两套机制」。
     */
    const val REGION_FORMULA = "formula"
    const val REGION_TABLE = "table"
    const val REGION_FIGURE = "figure"

    private val VALID_REGION_TYPES =
        setOf(REGION_FORMULA, REGION_TABLE, REGION_FIGURE)

    /**
     * 一块矩形标注。坐标是**归一化**的 0..1，屏幕方向（左上原点）。
     *
     * @property page 1 起的页码，与 `PdfText.Block.page` 同一套编号
     */
    data class RegionMark(
        val x0: Float,
        val y0: Float,
        val x1: Float,
        val y1: Float,
        val page: Int,
        val type: String
    )

    // ────────────────────────────────────────────────────────────
    // 文本标注：标题/作者/摘要/正文/章节标题/脚注/参考文献/关键词
    // ────────────────────────────────────────────────────────────

    /**
     * 合法的**文本**标注类型。
     *
     * ⚠️ 与矩形那套**分开维护**，不共用一个清单 ——
     *    两套语义完全不同，合并会让后续判断"该不该有坐标"
     *    变成一堆 if。
     *
     * ⚠️ `heading` 是**统称**：具体层级由 [TextMark.level] 表达，
     *    不在这里拆成 heading1/heading2。理由：层级是**数值**，
     *    拆成字符串会强制层级上限，且比较层级时要写 switch。
     */
    const val TEXT_TITLE = "title"
    const val TEXT_AUTHOR = "author"
    const val TEXT_ABSTRACT = "abstract"
    const val TEXT_BODY = "body"
    const val TEXT_HEADING = "heading"
    const val TEXT_FOOTNOTE = "footnote"
    const val TEXT_REFERENCE = "reference"
    const val TEXT_KEYWORD = "keyword"

    private val VALID_TEXT_TYPES = setOf(
        TEXT_TITLE, TEXT_AUTHOR, TEXT_ABSTRACT, TEXT_BODY,
        TEXT_HEADING, TEXT_FOOTNOTE, TEXT_REFERENCE, TEXT_KEYWORD
    )

    /**
     * 一段被用户指定了类型的文本。
     *
     * ══ 为什么用「行区间」而不是字符偏移 ══
     *
     * 用户看到的阅读视图是按**行**（`PdfText.Line`）渲染的，
     * 选中的也是整行或连续若干行。用行号区间：
     *   · 与渲染单位一致，不会出现"选中到半个字"；
     *   · 前端重排文本时直接按区间切片，不需要再算偏移；
     *   · 行号是**全局**的，分页/分栏变了也不影响。
     *
     * ⚠️ `fromLine` / `toLine` 都是**0 起**的全局行号
     *    （对应 `Result.lines` 的下标），不是页内行号。
     *
     * @property level `heading` 时的层级（1 起）；其余类型恒为 0
     */
    data class TextMark(
        val fromLine: Int,
        val toLine: Int,
        val type: String,
        val level: Int = 0
    )

    // ────────────────────────────────────────────────────────────
    // 容器
    // ────────────────────────────────────────────────────────────

    /** 某个文献的全部标注 */
    data class Doc(
        val regions: List<RegionMark> = emptyList(),
        val texts: List<TextMark> = emptyList()
    ) {
        val isEmpty: Boolean get() = regions.isEmpty() && texts.isEmpty()
    }

    /**
     * 抽取引擎版本。引擎改进后行号会变，旧标注可能错位。
     *
     * ⚠️ 改动 [PdfText] 里**分段规则**时**必须**把这个数字 +1。
     *    否则用户升级后旧标注会套在新行号上，错位且用户不知道
     *    （他们只会觉得"我的标注坏了"）。
     *
     * ⚠️ 当前策略是**宽容**的：版本不符也照常读，只记一条日志。
     *    因为把用户的标注直接丢掉更糟。理想做法是提示用户
     *    "这一篇的标注可能已错位"，但那是下一步。
     */
    private const val ENGINE_VERSION = 1

    private fun fileFor(context: Context, docId: String): File =
        File(File(context.filesDir, "library/$docId"), FILE_NAME)

    // ────────────────────────────────────────────────────────────
    // 读
    // ────────────────────────────────────────────────────────────

    /**
     * 读某个文献的标注。
     *
     * ⚠️ 任何异常（文件不存在、JSON 损坏、字段缺失）都返回**空标注**，
     *    不抛给上层。标注是「锦上添花」的数据，读不到就是「还没标过」，
     *    不该让阅读页整个打不开。
     *
     * ⚠️ 逐条校验：非法类型、退化框、越界行号直接丢弃。
     *    这样前端拿到的列表一定是「能直接渲染」的。
     */
    fun load(context: Context, docId: String): Doc {
        val f = fileFor(context, docId)
        if (!f.isFile) return Doc()

        return try {
            val root = JSONObject(f.readText(Charsets.UTF_8))

            val engine = root.optInt("engine", 0)
            if (engine != ENGINE_VERSION) {
                Log.w(
                    TAG,
                    "标注抽取引擎版本不符（文件 $engine / 当前 $ENGINE_VERSION），"
                        + "行号可能已错位：$docId"
                )
            }

            Doc(
                regions = readRegions(root.optJSONArray("regions")),
                texts = readTexts(root.optJSONArray("texts"))
            )
        } catch (t: Throwable) {
            Log.w(TAG, "标注读取失败（当作未标注）：${f.absolutePath}", t)
            Doc()
        }
    }

    private fun readRegions(arr: JSONArray?): List<RegionMark> {
        if (arr == null) return emptyList()
        val out = ArrayList<RegionMark>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue

            val type = o.optString("type", "")
            if (!isValidRegionType(type)) {
                Log.w(TAG, "丢弃未知矩形类型：$type")
                continue
            }

            val m = RegionMark(
                x0 = o.optDouble("x0", -1.0).toFloat(),
                y0 = o.optDouble("y0", -1.0).toFloat(),
                x1 = o.optDouble("x1", -1.0).toFloat(),
                y1 = o.optDouble("y1", -1.0).toFloat(),
                page = o.optInt("page", 0),
                type = type
            )

            if (m.page < 1 || m.x1 <= m.x0 || m.y1 <= m.y0) {
                Log.w(
                    TAG,
                    "丢弃退化矩形：page=${m.page} x=[${m.x0},${m.x1}] y=[${m.y0},${m.y1}]"
                )
                continue
            }

            // 归一化越界（手改过的 JSON 可能有）—— 夹回 0..1
            out.add(
                m.copy(
                    x0 = m.x0.coerceIn(0f, 1f),
                    y0 = m.y0.coerceIn(0f, 1f),
                    x1 = m.x1.coerceIn(0f, 1f),
                    y1 = m.y1.coerceIn(0f, 1f)
                )
            )
        }
        return out
    }

    private fun readTexts(arr: JSONArray?): List<TextMark> {
        if (arr == null) return emptyList()
        val out = ArrayList<TextMark>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue

            val type = o.optString("type", "")
            if (!isValidTextType(type)) {
                Log.w(TAG, "丢弃未知文本类型：$type")
                continue
            }

            val from = o.optInt("from", -1)
            val to = o.optInt("to", -1)
            if (from < 0 || to < from) {
                Log.w(TAG, "丢弃非法文本区间：[$from,$to]")
                continue
            }

            val level = o.optInt("level", 0)
            out.add(
                TextMark(
                    fromLine = from,
                    toLine = to,
                    type = type,
                    /*
                      ⚠️ level 只在 heading 上有意义。其他类型一律归零 ——
                         否则前端会遇到「一个 abstract 的 level=2」这种
                         自相矛盾的数据（手改 JSON 就能造出来）。
                    */
                    level = if (type == TEXT_HEADING) level.coerceIn(1, 6) else 0
                )
            )
        }
        return out
    }

    // ────────────────────────────────────────────────────────────
    // 写
    // ────────────────────────────────────────────────────────────

    /**
     * 覆盖写入某个文献的全部标注。
     *
     * ⚠️ 先写临时文件再 `renameTo` —— 直接覆写原文件时，
     *    若写到一半被杀进程（或磁盘满），会留下**截断的 JSON**，
     *    下次读取整份标注全丢。rename 是原子的。
     *
     * ⚠️ 传**整份**而不是「增/删一条」：用户在编辑模式里会连续
     *    改十几处再退出，整份覆盖只有一次 IO，也不会有增量操作乱序的问题。
     *
     * @return 是否写入成功（上层应据此提示用户，不要静默失败）
     */
    fun save(context: Context, docId: String, doc: Doc): Boolean {
        if (!isSafeDocId(docId)) {
            Log.w(TAG, "拒写非法 docId：$docId")
            return false
        }

        return try {
            val regions = JSONArray()
            for (m in doc.regions) {
                if (!isValidRegionType(m.type) || m.page < 1 ||
                    m.x1 <= m.x0 || m.y1 <= m.y0
                ) {
                    continue
                }
                regions.put(
                    JSONObject()
                        .put("x0", round4(m.x0))
                        .put("y0", round4(m.y0))
                        .put("x1", round4(m.x1))
                        .put("y1", round4(m.y1))
                        .put("page", m.page)
                        .put("type", m.type)
                )
            }

            val texts = JSONArray()
            for (m in doc.texts) {
                if (!isValidTextType(m.type) || m.fromLine < 0 || m.toLine < m.fromLine) {
                    continue
                }
                val o = JSONObject()
                    .put("from", m.fromLine)
                    .put("to", m.toLine)
                    .put("type", m.type)
                if (m.type == TEXT_HEADING && m.level > 0) {
                    o.put("level", m.level)
                }
                texts.put(o)
            }

            val root = JSONObject()
                .put("v", 1)
                .put("engine", ENGINE_VERSION)
                .put("regions", regions)
                .put("texts", texts)

            val f = fileFor(context, docId)
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, "$FILE_NAME.tmp")
            tmp.writeText(root.toString(), Charsets.UTF_8)

            // renameTo 在目标已存在时也能成功（Linux 上是 rename(2)）
            if (!tmp.renameTo(f)) {
                tmp.delete()
                Log.w(TAG, "标注 rename 失败：${f.absolutePath}")
                false
            } else {
                true
            }
        } catch (t: Throwable) {
            Log.w(TAG, "标注写入失败：$docId", t)
            false
        }
    }

    /** 清空某个文献的标注（用户点「清除全部」时用） */
    fun clear(context: Context, docId: String): Boolean {
        val f = fileFor(context, docId)
        return if (f.exists()) f.delete() else true
    }

    /** 该文献是否已有标注（网页用它决定是否提示「已标注」） */
    fun has(context: Context, docId: String): Boolean = !load(context, docId).isEmpty

    // ────────────────────────────────────────────────────────────
    // 工具
    // ────────────────────────────────────────────────────────────

    fun isValidRegionType(t: String): Boolean = t in VALID_REGION_TYPES

    fun isValidTextType(t: String): Boolean = t in VALID_TEXT_TYPES

    /**
     * 归一化坐标保留 4 位小数。
     *
     * ⚠️ 浮点直接序列化是 `0.12345678912345`，一篇文档几百个框时
     *    体积能差三分之一。1e-4 在 1600px 宽页面上约 0.16px，
     *    肉眼不可分辨。
     *
     * ⚠️ 手动算而不是 `String.format` —— 后者要显式传
     *    `Locale.US`，否则某些语言下小数点会变成逗号，
     *    产出的 JSON 直接非法（而且是很难查的那种）。
     */
    private fun round4(v: Float): Double =
        Math.round(v * 10000f).toDouble() / 10000.0

    /**
     * docId 来自网页（`localStorage` 里的字符串）。
     *
     * ⚠️ 必须校验再用它拼路径 —— 否则 `../../` 一类字符串能写到
     *    filesDir 之外。虽然当前调用方都是我们自己产的 UUID，
     *    但这是「跨信任边界传参数」的入口，**入口就要挡**。
     */
    private fun isSafeDocId(id: String): Boolean =
        id.isNotEmpty() && id.length <= 64 &&
            id.all { it.isLetterOrDigit() || it == '-' || it == '_' }
}
