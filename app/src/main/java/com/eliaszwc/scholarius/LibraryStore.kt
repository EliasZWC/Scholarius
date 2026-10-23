package com.eliaszwc.scholarius

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * 文献库：管理用户导入的 PDF。
 *
 * ## 存储布局
 *
 * ```
 * filesDir/library/
 * ├── index.json              文献元数据索引（唯一数据源）
 * └── <docId>/
 *     ├── doc.pdf            导入时复制过来的副本
 *     └── thumb.png          首页缩略图（PdfRenderer 渲染）
 * ```
 *
 * ## 为什么用「一个文献一个目录」
 *
 * 删除文献时只要 `deleteRecursively()` 一个目录就干净了 ——
 * 若把 PDF 与缩略图平铺在同一个目录里，删的时候要按 id 拼多个文件名，
 * 漏一个就留下垃圾。
 *
 * ## 为什么 PDF 要复制一份而不是记原路径
 *
 * 原路径是 `content://` URI（来自 SAF 文件选择器），授权是**临时的**：
 * 应用重启后就读不到了。复制进私有目录是唯一可靠的持有方式。
 * 代价是占双份存储空间 —— 但这换来「重启后还能读」。
 *
 * ## 为什么不需要任何存储权限
 *
 * 导入走 `ACTION_OPEN_DOCUMENT`（SAF），由系统文件选择器交给应用一个
 * 临时可读的 URI；写入的是应用自己的私有目录。
 * 全程不触碰外部存储的路径，因此 **minSdk 26 到 targetSdk 35 都不需要
 * READ_EXTERNAL_STORAGE / READ_MEDIA_* 之类的权限**。
 */
object LibraryStore {

    private const val TAG = "Scholarius"

    /** 文献库根目录，位于应用私有空间 */
    private const val LIBRARY_DIR = "library"

    private const val INDEX_FILE = "index.json"
    private const val PDF_FILE = "doc.pdf"
    private const val THUMB_FILE = "thumb.png"
    private const val MD_FILE = "doc.md"

    /**
     * 每篇文献自己的完整元数据（v0.2.5）。
     *
     * ══ 为什么要从 index.json 里拆出来 ══
     *
     * 用户要求（原话）：
     *   「具体文章目录下也存一份 json，是本文章的详细信息，比如作者、
     *     标题、时间啥的，就是在详情表单中填的那些，然后 index.json
     *     不储存文章自己的信息，只管理库数据索引」
     *
     * 旧设计把所有详情（含 `fields` 里的 20+ 个键）都塞进 index.json：
     *   · 100 篇文献 = 一个几百 KB 的文件，**每次打开列表全量读+解析**；
     *   · 任何一次详情编辑都要重写整个索引 —— 一次写坏全库元数据都没了；
     *   · 文献目录被拷走时，它的元数据**不跟着走**（在索引里）。
     *
     * 拆开之后：详情只有打开时才读那一个文件；索引只留列表渲染要用的
     * 轻量字段（见 [Doc.toIndexJson]）。
     */
    private const val META_FILE = "meta.json"

    /** 缩略图宽度（像素）。列表卡片里显示尺寸很小，够用且省空间 */
    private const val THUMB_WIDTH = 240

    /** 缩略图最大高度，防止极端长宽比的页面撑爆内存 */
    private const val THUMB_MAX_HEIGHT = 320

    /**
     * 一篇文献。
     *
     * ⚠️ `id` 是应用自己生成的 UUID，**不是** PDF 里的任何标识。
     *    用它做目录名，避免中文/特殊字符文件名带来的转义问题。
     */
    data class Doc(
        val id: String,
        /** 标题。提取不到时用文件名（去扩展名），用户可改 */
        val title: String,
        /** 作者。提取不到时为空串 */
        val author: String,
        /**
         * 发表载体名（展示用）。提取不到时为空串。
         *
         * ⚠️ v0.1.6 起，它不再是**唯一**的载体信息来源 ——
         *    按类别细分的字段（journalName / conferenceName / publisher …）
         *    在 [fields] 里；这个字段退化为**兼容层**：
         *
         *      · 老索引（v0.1.5 及以前）只写它，读出来还能显示；
         *      · 新导入的文献仍会填它（从 PDF 的 Subject 抓），
         *        让「类别还没判定」时卡片也有东西可显示。
         *
         *    卡片取值顺序见前端 meta.js 的 venueNameOf()：
         *        类别专属字段 → 本字段 → 空
         */
        val venue: String,
        /**
         * 发表年份，如 `2015`。**提取不到就是空串**，不是 0。
         *
         * ⚠️ 用 String 而非 Int：
         *    · 要能区分「没抓到」与「真的是第 0 年」—— Int 做不到；
         *    · 它只用于展示，不参与运算；
         *    · 用户后续手动修改时，空值直接当作「未填」处理。
         */
        val year: String,
        /**
         * 发表物类别：`journal` / `conference` / `preprint` /
         * `book` / `thesis` / `report` / `unknown`。
         *
         * ⚠️ 空串与 `unknown` 等价（都表示「未判定」）。
         *    为什么用 String 而不是 enum：索引是 JSON，
         *    枚举要写序列化器；而取值集合由前端 meta.js 定义，
         *    两边共用字符串最省事。非法值在读的时候归一到 `unknown`。
         */
        val venueType: String,
        /**
         * **短标题**（Short Title）。空串 = 未填。
         *
         * ⚠️ 它填了之后会**顶替卡片①行的标题**（见前端 vault.js
         *    的 renderCard）——因为用户既然专门起了短名，
         *    就是为了在列表里一眼认出来，再显示那一长串正式标题
         *    （常被截断成 "Attention is All you N…"）反而更难认。
         *
         * ⚠️ 它**不是**「发表物简称」——后者是会议/期刊名字的缩写
         *    （NIPS / CVPR），是一张全局映射表，存在前端的
         *    localStorage 里（见 shortcut.js），**不进本结构**。
         *
         * ══ 为什么是顶层字段而不是 fields 里的普通键 ══
         *
         * ⚠️ 因为它**参与卡片渲染**（顶替标题）。放进 [fields] 也能存，
         *    但 fields 的语义是「按类别细分的元数据」——
         *    切类别时前端会跳过不显示的字段，而短标题与类别无关，
         *    不应被那条规则牵连。
         *
         * ⚠️ 它必须**同时**出现在四处，否则保存后消失（v0.1.5 真踩过）：
         *      · 本属性（存）；
         *      · parseDoc（读）；
         *      · writeIndex（写）；
         *      · TOP_LEVEL_KEYS（否则被当 fields 里的键）。
         *    当时叫 `venueShort` 且只在前端加了，Kotlin 四处都没有 ——
         *    于是它被写进 fields，读回来时只读顶层，读不到。
         *    表现为「填了短标题、保存、重开就没了」，
         *    而且**只在真机复现**（浏览器预览的 dev-library.js
         *    把旧名当顶层了），所以本地怎么测都绿。
         */
        val shortTitle: String = "",
        /**
         * 按类别细分的元数据。**键是前端 meta.js 定义的字段名**，
         *    值是字符串（空值一律**不存**，不是存空串）。
         *
         * ══ 为什么用 Map 而不是 20 个独立属性 ══
         *
         * 这套字段有 20+ 个（期刊的卷/期/页码、会议的缩写/地点、
         * 专著的出版社/ISBN、学位论文的学校/学位类型……），
         * 而且**类别专属**——一篇期刊论文根本不会有 `isbn`。
         *
         * 若做成独立属性，代价是：
         *   · `Doc` 构造点、`parseDoc`、`writeIndex`、
         *     `pushLibraryToWeb` 四处都要跟着改，加一个字段改四遍；
         *   · `update()` 的签名会有 20 个参数（现在是 6 个）；
         *   · 索引 JSON 里每篇文献都要写 20 个键，其中 15 个是空串。
         *
         * 用 Map 之后：加字段只改前端 meta.js，Kotlin 侧**一行不用动**。
         * 索引里只存用户真有值的那些键。
         *
         * ⚠️ 代价：失去了编译期字段检查（写错键名不会报错）。
         *    用一条纪律补偿：**键名以 meta.js 为唯一准绳**，
         *    并且 `tools/check-meta.js` 会校验两边一致。
         */
        val fields: Map<String, String>,
        /** 导入时间（毫秒） */
        val addedAt: Long,
        /** 页数。读取失败为 0 */
        val pages: Int,
        /** PDF 字节数 */
        val size: Long,
        /** 原文件名，仅用于展示与兜底标题 */
        val sourceName: String,
        /**
         * PDF 文件的 SHA-256（小写十六进制，64 位）。空串 = 尚未计算。
         *
         * ══ 为什么需要它（v0.2.5）══
         *
         * 排版模板要**精确绑定某一份 PDF** —— 同一篇论文的预印版与
         * 期刊版排版完全不同，用同一个模板会套错。
         * 靠标题/文件名匹配都不可靠（用户会改名、PDF 元数据常为空），
         * 而内容哈希是唯一确定同一份文件的判据。
         *
         * ⚠️ 哈希只对**本机文件**有意义，不联网、不外传。
         * ⚠️ 老数据没有这个键 → 读出来是空串，下次打开时懒计算。
         */
        val sha256: String = "",
        /**
         * 当前套用的排版模板 id。空串 = 未套用（走通用规则）。
         */
        val templateId: String = "",
    )

    // -----------------------------------------------------------------------
    // 路径
    // -----------------------------------------------------------------------

    private fun libraryDir(context: Context): File =
        File(context.filesDir, LIBRARY_DIR).apply { mkdirs() }

    private fun docDir(context: Context, id: String): File =
        File(libraryDir(context), id)

    fun pdfFile(context: Context, id: String): File = File(docDir(context, id), PDF_FILE)

    /**
     * 正文的本地存储文件（v0.1.92）。
     *
     * ══ ⚠️⚠️ 为什么是 .md，而不是“.txt”或 JSON ══
     *
     * 用户裁决（原话）：
     *   「pdf 转我们的文本时，原本保存的格式我不知道是什么？也许是 json？
     *     现在直接改为 md 就可以了，就相当于这就是我们本地保存的形式，
      *     而不是转换为 md」
     *   「相当于 md 是我们的数据保存结构，但阅读器靠这个原文件来渲染」
     *
     * ✅ 所以 `doc.md` 是**唯一的数据源**：
     *    · 导入时生成；
     *    · 用户在阅读页编辑/标注后**重写**；
     *    · 阅读页从它读回来渲染。
     *    “导出”只是把这个已有文件拷到用户选的位置（见 exportDocs）。
     *
     * ⚠️ 但**不能只用 md 纯文本**：
     *    阅读视图要的是“块 + 标注区间”，而 md 里没有字符区间信息。
     *    所以文件里用 **HTML 注释**携带标注元数据（详见 MdDoc.kt）：
     *    渲染器忽略注释，人读也是干净 md。
     */
    fun mdFile(context: Context, id: String): File = File(docDir(context, id), MD_FILE)

    /** 读正文 md；文件不存在返回 null（调用方据此触发懒迁移） */
    fun readMd(context: Context, id: String): String? {
        val f = mdFile(context, id)
        return if (!f.exists()) null else try {
            f.readText()
        } catch (t: Throwable) {
            null
        }
    }

    /** 写正文 md（原子替换：先写临时文件再改名，避免中途 killed 留下半截文件） */
    fun writeMd(context: Context, id: String, content: String): Boolean {
        return try {
            val dir = docDir(context, id)
            if (!dir.exists() && !dir.mkdirs()) {
                false
            } else {
                val target = File(dir, MD_FILE)
                val tmp = File(dir, "$MD_FILE.tmp")
                tmp.writeText(content)
                /*
                  ⚠️ renameTo 在同目录下是原子的；失败则退回直接覆盖。
                     目标已存在时某些设备上 renameTo 会返回 false，必须先删。
                */
                if (target.exists()) target.delete()
                if (tmp.renameTo(target)) {
                    true
                } else {
                    target.writeText(content)
                    tmp.delete()
                    true
                }
            }
        } catch (t: Throwable) {
            false
        }
    }

    fun thumbFile(context: Context, id: String): File = File(docDir(context, id), THUMB_FILE)

    // -----------------------------------------------------------------------
    // 每篇文献的 meta.json（v0.2.5）
    // -----------------------------------------------------------------------

    fun metaFile(context: Context, id: String): File =
        File(docDir(context, id), META_FILE)

    /**
     * 写某篇文献的完整元数据。
     *
     * ⚠️ 同样是**原子替换**：先写 `.tmp` 再改名。
     *    详情表单是「填完点保存」，中途被杀进程时旧文件必须完好。
     */
    fun writeMeta(context: Context, doc: Doc): Boolean {
        return try {
            val dir = docDir(context, doc.id)
            if (!dir.exists() && !dir.mkdirs()) {
                false
            } else {
                val target = File(dir, META_FILE)
                val tmp = File(dir, "$META_FILE.tmp")
                tmp.writeText(doc.toMetaJson().toString(2))
                if (target.exists()) target.delete()
                if (tmp.renameTo(target)) {
                    true
                } else {
                    target.writeText(doc.toMetaJson().toString(2))
                    tmp.delete()
                    true
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "写 meta.json 失败：${doc.id}", t)
            false
        }
    }

    /** 读某篇文献的 meta.json；不存在或损坏返回 null（调用方回退到索引里的值） */
    fun readMeta(context: Context, id: String): Doc? {
        val f = metaFile(context, id)
        if (!f.exists()) return null
        return try {
            parseMeta(JSONObject(f.readText()), id)
        } catch (t: Throwable) {
            Log.w(TAG, "读 meta.json 失败：$id", t)
            null
        }
    }

    /**
     * 从 meta.json 的 JSON 解析出 [Doc]。
     *
     * ⚠️ 与 [parseDoc] 分开写，因为两者的**必填程度不同**：
     *    index.json 里的条目缺 `id` 就无效；
     *    meta.json 里缺 `pages`/`size` 这类展示字段是可以接受的
     *    （由索引补齐），不该整条丢掉。
     */
    private fun parseMeta(json: JSONObject, id: String): Doc = Doc(
        id = json.optString("id").ifBlank { id },
        title = json.optString("title"),
        author = json.optString("author"),
        venue = json.optString("venue"),
        year = json.optString("year"),
        venueType = normaliseVenueType(json.optString("venueType")),
        shortTitle = json.optString("shortTitle"),
        fields = parseFields(json.optJSONObject("fields")),
        addedAt = json.optLong("addedAt"),
        pages = json.optInt("pages"),
        size = json.optLong("size"),
        sourceName = json.optString("sourceName"),
        sha256 = json.optString("sha256"),
        templateId = json.optString("templateId"),
    )

    /**
     * 索引条目：**只为列表渲染服务**的轻量投影。
     *
     * 刻意**不含** `fields` / `shortTitle` / `venue` / `year` / … ——
     * 那些是「详情里的东西」，属于 meta.json。
     * 列表卡片要显示标题、作者、页数、大小、缩略图，加上排序要的 addedAt，
     * 以及模板匹配要的 sha256，就这些。
     */
    private fun Doc.toIndexJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("addedAt", addedAt)
        put("title", title)
        put("author", author)
        put("pages", pages)
        put("size", size)
        if (sha256.isNotBlank()) put("sha256", sha256)
    }

    /** 完整元数据：写进 meta.json 的全部内容 */
    private fun Doc.toMetaJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("title", title)
        put("author", author)
        put("venue", venue)
        put("year", year)
        put("venueType", venueType)
        put("shortTitle", shortTitle)
        if (fields.isNotEmpty()) {
            put("fields", JSONObject().apply {
                fields.forEach { (k, v) -> put(k, v) }
            })
        }
        put("addedAt", addedAt)
        put("pages", pages)
        put("size", size)
        put("sourceName", sourceName)
        put("sha256", sha256)
        if (templateId.isNotBlank()) put("templateId", templateId)
    }

    private fun indexFile(context: Context): File = File(libraryDir(context), INDEX_FILE)

    // -----------------------------------------------------------------------
    // 索引读写
    // -----------------------------------------------------------------------

    /**
     * 读全部文献，按导入时间**倒序**（最新的在最前）。
     *
     * 索引损坏时返回空列表而不是抛异常 —— 一处 JSON 解析失败不该让
     * 整个文库打不开。真正的文件都在各子目录里，不会因此丢失。
     *
     * ══ v0.2.5：索引只给「骨架」，详情从各目录的 meta.json 合并 ══
     *
     * 现在的顺序是：
     *   ① 读 index.json（很小，只有 id/title/author/pages/size/addedAt）；
     *   ② 对每个 id 读 `<docId>/meta.json` 并覆盖骨架字段。
     *
     * ⚠️ 为什么还是要**合并**而不是"只读 meta"：
     *    老数据（v0.2.4 及之前）没有 meta.json，只有索引。
     *    若只读 meta，升级后老用户会看到**空文库**。
     *
     * ⚠️ 为什么不是"只读索引"：
     *    详情表单改的是 meta.json，索引里的 title/author 只是
     *    方便列表显示的副本 —— 必须以后者为准。
     *
     * ⚠️ meta.json 的 I/O 是这里唯一的开销：每篇一次 open+read。
     *    几十篇的量级下完全可接受（几毫秒）。如果将来上百篇变慢，
     *    可以把「只列卡片」的路径拆出去（列表不读 meta），
     *    但那会让刚刚说的"以谁为准"变复杂，现在不做。
     */
    fun list(context: Context): List<Doc> {
        val file = indexFile(context)
        if (!file.exists()) return emptyList()

        return try {
            val array = JSONArray(file.readText())
            (0 until array.length()).mapNotNull { i ->
                val obj = array.optJSONObject(i) ?: return@mapNotNull null
                val skeleton = try {
                    parseDoc(obj)
                } catch (t: Throwable) {
                    null
                } ?: return@mapNotNull null

                mergeMeta(context, skeleton)
            }.sortedByDescending { it.addedAt }
        } catch (t: Throwable) {
            Log.w(TAG, "文献索引读取失败", t)
            emptyList()
        }
    }

    /**
     * 用 `<docId>/meta.json` 覆盖索引骨架。
     *
     * ⚠️ 合并规则是**逐字段**的，不是整体替换：
     *    meta.json 里有值的（非空）用它；
     *    没有的保留索引里的。因为索引里的 `pages`/`size`/`sourceName`
     *    是导入时写死的、可靠；而 meta 是用户可改的。
     *    但 `addedAt` 不该被用户改，所以固定用索引的。
     */
    private fun mergeMeta(context: Context, skeleton: Doc): Doc {
        val meta = readMeta(context, skeleton.id) ?: return skeleton
        return skeleton.copy(
            title = meta.title.ifBlank { skeleton.title },
            author = meta.author.ifBlank { skeleton.author },
            venue = meta.venue,
            year = meta.year,
            venueType = meta.venueType,
            shortTitle = meta.shortTitle,
            fields = meta.fields,
            // ⚠️ 这四个坚持用索引里的：它们是导入时的事实，
            //    meta 里可能因为手改文件而不准。
            addedAt = skeleton.addedAt,
            pages = if (skeleton.pages != 0) skeleton.pages else meta.pages,
            size = if (skeleton.size != 0L) skeleton.size else meta.size,
            sourceName = skeleton.sourceName.ifBlank { meta.sourceName },
            sha256 = meta.sha256.ifBlank { skeleton.sha256 },
            templateId = meta.templateId,
        )
    }

    private fun parseDoc(json: JSONObject) = Doc(
        id = json.optString("id"),
        title = json.optString("title"),
        author = json.optString("author"),
        venue = json.optString("venue"),
        // ⚠️ optString 对缺失/null 都返回 ""，正好是「未填」的语义。
        //    老索引（v0.1.5 之前写的）没有这些键，读出来就是空值，
        //    卡片相应位置留白 —— 不需要写迁移代码。
        year = json.optString("year"),
        // 非法/缺失的类别归一到 unknown —— 前端据此选表单字段，
        // 拿到不认识的字符串会渲染不出任何专属字段，不如显式归一。
        venueType = normaliseVenueType(json.optString("venueType")),
        // ⚠️ 顶层键，必须在这里读。miss 了它就是「短标题保存后消失」
        //    （曾经用 venueShort 这个名字，Kotlin 侧没接住）。
        shortTitle = json.optString("shortTitle"),
        fields = parseFields(json.optJSONObject("fields")),
        addedAt = json.optLong("addedAt"),
        pages = json.optInt("pages"),
        size = json.optLong("size"),
        sourceName = json.optString("sourceName"),
        sha256 = json.optString("sha256"),
        templateId = json.optString("templateId"),
    )

    /** 合法的发表物类别。与前端 meta.js 的 VENUE_TYPES 必须一致 */
    private val VENUE_TYPES = setOf(
        "journal", "conference", "preprint", "book", "thesis", "report", "unknown"
    )

    private fun normaliseVenueType(raw: String): String =
        if (raw in VENUE_TYPES) raw else "unknown"

    /**
     * 读 `fields` 子对象。
     *
     * ⚠️ **只保留非空值**。空串与空白串一律丢弃 ——
     *    否则索引里会堆满 `"isbn": ""` 这类无意义键，
     *    文件越写越大，而且判断「用户到底填过没有」还得再判空。
     *
     * ⚠️ 键名不做白名单校验。理由：前端加字段时不该要求后端同步发版。
     *    代价是索引里可能存下前端已废弃的键 —— 无害（只是读不到），
     *    而丢弃未知键会导致「降级安装旧版 → 升级回来数据没了」。
     *    宁可留着不认识的数据。
     */
    private fun parseFields(json: JSONObject?): Map<String, String> {
        if (json == null || json.length() == 0) return emptyMap()
        val out = LinkedHashMap<String, String>()
        val keys = json.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val v = json.optString(k)
            if (v.isNotBlank()) out[k] = v
        }
        return out
    }

    private fun writeIndex(context: Context, docs: List<Doc>) {
        val array = JSONArray()
        // 索引里按导入时间正序存，读的时候再倒序 —— 与磁盘顺序无关，
        // 只为了 JSON 文件本身可读（新加的追加在后面）
        docs.sortedBy { it.addedAt }.forEach { doc ->
            /*
              ══ v0.2.5：索引只写**列表要用的**字段 ══

              详情（venue / year / venueType / shortTitle / fields /
              sourceName）全部搬进了各目录的 meta.json。

              ⚠️ 这样索引就能一直很小：100 篇文献也就十几 KB，
                 打开列表时读取和解析都是常量级的小开销。
              ⚠️ 代价：**不能**再靠索引拿详情。任何需要完整信息的
                 地方都必须 `list()`（它会合并 meta）或 `readMeta()`。
                 直接读 index.json 的代码会拿到不完整的 Doc ——
                 目前只有本类里的 writeIndex 这么做，安全。
            */
            array.put(doc.toIndexJson())
        }
        indexFile(context).writeText(array.toString())
    }

    /**
     * 保存一篇文献的**完整元数据**（v0.2.5）。
     *
     * 这是详情表单保存的入口：写 meta.json + 同步索引里的展示字段。
     *
     * ⚠️ 索引里只同步 `title` / `author` 这类列表要显示的，不是全量。
     * ⚠️ 两处必须一起写：只写 meta 会让列表显示旧标题（用户会以为没保存）；
     *    只写索引会让详情下次打开退回旧值。
     */
    fun save(context: Context, doc: Doc): Boolean {
        val okMeta = writeMeta(context, doc)

        val docs = list(context)
        val exists = docs.any { it.id == doc.id }
        val next = if (exists) {
            docs.map { if (it.id == doc.id) it.copy(
                title = doc.title,
                author = doc.author,
                venue = doc.venue,
                year = doc.year,
                venueType = doc.venueType,
                shortTitle = doc.shortTitle,
                fields = doc.fields,
                sha256 = doc.sha256,
                templateId = doc.templateId,
            ) else it }
        } else {
            docs + doc
        }
        writeIndex(context, next)
        return okMeta
    }

    // -----------------------------------------------------------------------
    // 导入
    // -----------------------------------------------------------------------

    /**
     * 导入进度阶段。
     *
     * ⚠️ 用「阶段 + 0~1 的进度」而不是单一百分比：
     *    复制大文件可能占 80% 的时间，元数据只要几毫秒 ——
     *    只给一个数字会让进度条在 80% 处卡住不动，看起来像卡死。
     *    分阶段后每一段都要能平滑推进。
     */
    enum class ImportStage(val label: String) {
        COPY("copy"),
        VERIFY("verify"),
        THUMBNAIL("thumbnail"),
        META("meta"),
        INDEX("index")
    }

    /**
     * 导入被用户取消。
     *
     * ⚠️ 用异常而不是返回 null —— 取消与失败在语义上完全不同：
     *    取消应当**静默**丢弃（用户自己按的），失败要给错误提示。
     *    用 null 返回就分不清了。
     */
    class ImportCancelled : Exception("import cancelled")

    /**
     * 导入一个 PDF。**必须在后台线程调用**（要复制文件 + 渲染缩略图）。
     *
     * @param openStream 由调用方提供的「打开源文件输入流」函数。
     *                   用函数而不是直接传 InputStream，是为了让本函数
     *                   能在复制失败时重新打开一次（SAF 的流是一次性的）。
     * @param displayName 原文件名，用于兜底标题与展示
     * @param onProgress  进度回调（阶段, 0~1）。会在后台线程调用，
     *                    调用方自己负责切到 UI 线程。
     * @param isCancelled 取消查询。每个耗时步骤前后都会问一次，
     *                    true 时抛 [ImportCancelled]。
     * @return 导入成功给 Doc；失败给 null（原因已写日志）
     * @throws ImportCancelled 用户取消（现场已清理干净）
     */
    fun import(
        context: Context,
        displayName: String,
        openStream: () -> java.io.InputStream?,
        onProgress: (ImportStage, Float) -> Unit = { _, _ -> },
        isCancelled: () -> Boolean = { false },
    ): Doc? {
        val id = UUID.randomUUID().toString()
        val dir = docDir(context, id)
        if (!dir.mkdirs()) {
            Log.w(TAG, "无法创建文献目录：${dir.absolutePath}")
            return null
        }

        /*
          ⚠️ 取消/失败时的清理必须**统一**：
             半拉子的目录留在磁盘上会变成"幽灵文献" ——
             索引里没有它，但占着空间，用户也删不掉。
             所以用 try/catch 包住整个流程，任何异常路径都 deleteRecursively。
        */
        try {
            return importInto(context, id, dir, displayName, openStream,
                              onProgress, isCancelled)
        } catch (e: ImportCancelled) {
            Log.i(TAG, "[library] import cancelled: $displayName")
            dir.deleteRecursively()
            throw e
        } catch (t: Throwable) {
            Log.w(TAG, "导入失败", t)
            dir.deleteRecursively()
            return null
        }
    }

    private fun importInto(
        context: Context,
        id: String,
        dir: File,
        displayName: String,
        openStream: () -> java.io.InputStream?,
        onProgress: (ImportStage, Float) -> Unit,
        isCancelled: () -> Boolean,
    ): Doc? {
        val pdf = File(dir, PDF_FILE)

        // ① 复制源文件（带进度）
        onProgress(ImportStage.COPY, 0f)
        val copied = try {
            val input = openStream()
            if (input == null) {
                false
            } else {
                input.use { src ->
                    /*
                      ⚠️ 不能直接用 `copyTo` —— 那样拿不到中间进度。
                         手工分块复制，每 64KB 报一次进度。
                      ⚠️ 用 `available()` 估计总长不可靠（SAF 的流常常返回 0），
                         所以进度按"已复制字节数"推进，跳到一个**渐近**曲线上：
                         0~90% 给复制，剩下 10% 留给后面的固定步骤。
                    */
                    pdf.outputStream().use { dst ->
                        val buf = ByteArray(64 * 1024)
                        var total = 0L
                        var lastReport = 0L
                        while (true) {
                            if (isCancelled()) throw ImportCancelled()
                            val n = src.read(buf)
                            if (n <= 0) break
                            dst.write(buf, 0, n)
                            total += n
                            if (total - lastReport >= 512 * 1024) {
                                lastReport = total
                                /* 渐近曲线：越往后越慢，永远不会到 1.0 */
                                val frac = (1.0 - Math.exp(-total / 8_000_000.0)).toFloat()
                                onProgress(ImportStage.COPY, frac * 0.9f)
                            }
                        }
                    }
                }
                pdf.length() > 0
            }
        } catch (e: ImportCancelled) {
            throw e
        } catch (t: Throwable) {
            Log.w(TAG, "复制 PDF 失败", t)
            false
        }

        if (!copied) return null
        if (isCancelled()) throw ImportCancelled()

        // ② 必须是真 PDF（前 4 字节 %PDF）
        onProgress(ImportStage.VERIFY, 1f)
        if (!isPdf(pdf)) {
            Log.w(TAG, "导入的文件不是 PDF（前 4 字节不是 %PDF）")
            return null
        }

        // ③ 渲染缩略图 + 读页数
        if (isCancelled()) throw ImportCancelled()
        onProgress(ImportStage.THUMBNAIL, 0.3f)
        val pages = renderThumbnail(pdf, File(dir, THUMB_FILE))
        onProgress(ImportStage.THUMBNAIL, 1f)

        // ④ 提取元数据（失败就留空，不阻断导入）
        if (isCancelled()) throw ImportCancelled()
        onProgress(ImportStage.META, 0.3f)
        val meta = PdfMeta.extract(pdf, displayName)

        /*
          ⑤ 元数据缺失时从**正文首页**兜底。

          ══ 为什么需要（v0.1.5，用真实论文测出来的）══

          实测（Wei et al., Chain-of-Thought Prompting, NIPS 2022）：
          这份 PDF 由 iLovePDF 重新生成过，元数据被整个抹掉 ——
          title / author / subject **全空**，列表里只剩「14 pages · 385 KB」，
          标题还是退回文件名。

          但正文首页明明有标题和作者。所以缺字段时值得再读一次首页。

          ⚠️ 只在**确实缺**的时候才去做这件事。
             解析正文要解压内容流，有成本（几十毫秒到几百毫秒），
             元数据齐全时不该白花这个时间。
          ⚠️ 失败不影响导入 —— 兜底本来就没保证。
        */
        val needTitle = meta.title.isBlank()
        val needAuthor = meta.author.isBlank()
        var author = meta.author
        var title = meta.title

        if (needTitle || needAuthor) {
            val head = try {
                PdfText.extractHead(pdf)
            } catch (t: Throwable) {
                Log.w(TAG, "首页兜底提取失败", t)
                null
            }
            if (head != null) {
                if (needTitle && head.title.isNotBlank()) title = head.title
                if (needAuthor && head.author.isNotBlank()) author = head.author
            }
        }

        val doc = Doc(
            id = id,
            title = title.ifBlank { fallbackTitle(displayName) },
            author = author,
            venue = meta.venue,
            year = meta.year,
            // ⚠️ 导入时不猜类别。
            //
            //    为什么不做「按 venue 文本猜是会议还是期刊」的启发式：
            //      · 猜错会把用户引到错误的表单（以为在填期刊，其实是会议）；
            //      · 判定成本高（要靠会议名单/期刊名单，那是很大的数据表）；
            //      · 用户只需在详情弹窗里点一下，比猜错再改更省事。
            //    所以初始一律 unknown，表单只显示通用字段，
            //    等用户选定类别后专属字段才出现（Zotero 也是这个流程）。
            venueType = "unknown",
            fields = meta.fields,
            // ⚠️ 导入时短标题一律为空 —— PDF 里没有任何信息能推出
            //    「用户想给这篇起什么短名」，这是纯人工字段。
            //    显式写出来而不是靠默认值，是因为它必须与
            //    parseDoc / writeIndex 保持同一组键名，写出来能一眼核对。
            shortTitle = "",
            addedAt = System.currentTimeMillis(),
            pages = pages,
            size = pdf.length(),
            sourceName = displayName,
        )

        // ⑤ 写入索引
        /*
          ══ ⚠️⚠️ 这是最后一个取消检查点，也是**唯一安全**的检查点 ══

          写索引之前：可以取消，删目录 + 抛异常，磁盘干净。
          写索引之后：**不能**再检查取消 —— 索引已经指向这个目录了，
                     这时若再抛 ImportCancelled，外层的
                     `dir.deleteRecursively()` 会把目录删掉，
                     索引里就留下一条指向不存在文件的**幽灵文献**。
                     用户会看到一张打不开的卡片，而且删不掉。

          ✅ 所以：一旦决定写索引，就是"提交"，必须跑完。
             之后到达的取消请求由调用方忽略即可（网页侧已经
             用 `ret !== 'ignored'` 处理了迟到的 stage 事件）。
        */
        if (isCancelled()) throw ImportCancelled()
        onProgress(ImportStage.INDEX, 0.3f)

        /*
          ══ v0.2.5：导入时就写 meta.json + 算 sha256 ══

          ⚠️ 顺序很重要：**先算哈希 → 写 meta → 写索引**。
             索引是提交点，必须最后写（见上面那段说明）。
             meta.json 先写，即使后续索引写失败，外层也会
             把整个目录删掉，不会留下孤儿。

          ⚠️ sha256 放在导入时算，而不是懒计算：
             模板匹配要靠它，而"导入后立刻套模板"是最自然的时机。
             复制完文件才几百毫秒，多算一次哈希（几十毫秒）用户感知不到。
        */
        onProgress(ImportStage.INDEX, 0.5f)
        val withHash = try {
            doc.copy(sha256 = sha256Of(pdf))
        } catch (t: Throwable) {
            Log.w(TAG, "导入后计算哈希失败", t)
            doc
        }
        writeMeta(context, withHash)

        try {
            writeIndex(context, list(context) + withHash)
        } catch (t: Throwable) {
            Log.w(TAG, "写入文献索引失败", t)
            /* ⚠️ 不在这里删目录 —— 外层 try/catch 统一清理 */
            return null
        }
        onProgress(ImportStage.INDEX, 1f)

        Log.i(
            TAG,
            "[library] imported ${withHash.id} '${withHash.title}' " +
                "pages=${withHash.pages} size=${withHash.size} " +
                "sha=" + withHash.sha256.take(8)
        )
        return withHash
    }

    /**
     * PDF 魔数检查：前 4 字节应为 `%PDF`。
     *
     * 有些 PDF 前面有 BOM 或空白，所以在前 1KB 内找而不是只看开头。
     */
    private fun isPdf(file: File): Boolean = try {
        file.inputStream().use { input ->
            val head = ByteArray(1024)
            val n = input.read(head)
            if (n < 4) {
                false
            } else {
                // 在前 n 字节里找 "%PDF"
                var found = false
                for (i in 0..(n - 4)) {
                    if (head[i] == 0x25.toByte() && head[i + 1] == 0x50.toByte() &&
                        head[i + 2] == 0x44.toByte() && head[i + 3] == 0x46.toByte()
                    ) {
                        found = true
                        break
                    }
                }
                found
            }
        }
    } catch (t: Throwable) {
        false
    }

    /** 用文件名兜底当标题：去掉扩展名与常见噪声 */
    private fun fallbackTitle(displayName: String): String =
        displayName.substringBeforeLast('.').trim().ifBlank { "Untitled" }

    // -----------------------------------------------------------------------
    // 缩略图
    // -----------------------------------------------------------------------

    /**
     * 用系统 `PdfRenderer` 渲染第一页为 PNG。
     *
     * @return 页数；渲染失败给 0
     *
     * ⚠️ `PdfRenderer` 只支持**未加密**的 PDF。加密或损坏的文件会抛异常，
     *    此时返回 0，网页端显示占位图而不是崩溃。
     */
    private fun renderThumbnail(pdf: File, output: File): Int {
        var descriptor: ParcelFileDescriptor? = null
        var renderer: PdfRenderer? = null
        try {
            descriptor = ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY)
            renderer = PdfRenderer(descriptor)
            val count = renderer.pageCount
            if (count <= 0) return 0

            renderer.openPage(0).use { page ->
                /*
                  等比缩放到目标宽度。
                  ⚠️ 宽高都不能为 0 —— PdfRenderer 对 0 尺寸会抛 IllegalArgumentException。
                */
                val srcW = page.width.coerceAtLeast(1)
                val srcH = page.height.coerceAtLeast(1)
                val scale = THUMB_WIDTH.toFloat() / srcW
                var dstW = THUMB_WIDTH
                var dstH = (srcH * scale).toInt().coerceAtLeast(1)
                if (dstH > THUMB_MAX_HEIGHT) {
                    val s2 = THUMB_MAX_HEIGHT.toFloat() / dstH
                    dstH = THUMB_MAX_HEIGHT
                    dstW = (dstW * s2).toInt().coerceAtLeast(1)
                }

                val bitmap = Bitmap.createBitmap(dstW, dstH, Bitmap.Config.ARGB_8888)
                /*
                  先填白底。PdfRenderer 渲染时未绘制区域是透明的，
                  存成 PNG 后在深色主题下会变成"透明窟窿"，
                  填白更接近纸的真实观感。
                */
                bitmap.eraseColor(Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)

                output.outputStream().use { out ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                }
                bitmap.recycle()
            }
            return count
        } catch (t: Throwable) {
            // 加密 PDF / 损坏文件都在这里，不让它影响导入本身
            Log.w(TAG, "渲染缩略图失败：${t.javaClass.simpleName} ${t.message}")
            return 0
        } finally {
            try {
                renderer?.close()
            } catch (t: Throwable) {
                /* 忽略 */
            }
            try {
                descriptor?.close()
            } catch (t: Throwable) {
                /* 忽略 */
            }
        }
    }

    // -----------------------------------------------------------------------
    // 改 / 删
    // -----------------------------------------------------------------------

    /**
     * 改一篇文献的元数据。
     *
     * ══ 为什么签名是「一个 Map」而不是十几个具名参数 ══
     *
     * 可编辑字段有 20+ 个，且**按类别不同**。若写成
     * `update(ctx, id, title, author, year, venueType, journalName,
     *  volume, issue, pages, doi, conferenceName, …)`：
     *   · 20 个参数，调用点全是位置参数，极易传错顺序；
     *   · 加一个字段就要改签名 + 所有调用点 + WebAppBridge；
     *   · 前端只想改 DOI 时，也得把所有字段回传一遍。
     *
     * 改成 Map 后，**只传要改的键**：
     *   · `patch["doi"] = "10.xxx"` → 只动 doi；
     *   · `patch["doi"] = ""`        → 清空 doi（空串即删除）；
     *   · 没出现的键                  → 保持原值。
     *
     * ⚠️ `title` 有特殊兜底：清空后会落回文件名。
     *    这不是「必填」——是「空标题在列表里无法辨认」，必须给个能看的。
     *
     * @param patch 要修改的字段。允许的键见前端 meta.js 的字段表。
     *              另外接受三个非 fields 的顶层键：
     *                `title` / `author` / `year` / `venueType`
     */
    fun update(context: Context, id: String, patch: Map<String, String>): Boolean {
        val docs = list(context)
        val target = docs.firstOrNull { it.id == id } ?: return false

        // --- 顶层字段 ---
        val newTitle = patch["title"]?.let { raw ->
            raw.ifBlank { fallbackTitle(target.sourceName) }
        } ?: target.title
        val newAuthor = patch["author"] ?: target.author
        val newYear = patch["year"] ?: target.year
        val newType = patch["venueType"]?.let { normaliseVenueType(it) } ?: target.venueType
        /*
          ⚠️ 短标题也走顶层。空串是合法值（= 用户清空了短标题，
             卡片退回显示标题），所以**不能**像 fields 那样
             「空值就不写」—— 那样用户清不掉已有的短标题。

             所以用「patch 里没这个键 → 保持原值」的写法：
             `patch[...] ?: target.shortTitle`。
        */
        val newShortTitle = patch["shortTitle"] ?: target.shortTitle

        // --- 类别专属字段（fields）---
        //
        // ⚠️ 合并而不是替换：前端只回传它改过的键，
        //    没回传的（比如切换类别时被隐藏的字段）要保持原值。
        //    否则用户切一下类别，之前填的卷/期/页码就全丢了。
        val newFields = LinkedHashMap(target.fields)
        patch.forEach { (k, v) ->
            // 四个顶层键不进 fields
            if (k in TOP_LEVEL_KEYS) return@forEach
            if (v.isBlank()) {
                // 空值 = 清空该字段。删除而不是存空串 ——
                // 见 parseFields 的注释：索引里不堆无意义的空键。
                newFields.remove(k)
            } else {
                newFields[k] = v.trim()
            }
        }

        val updated = target.copy(
            title = newTitle,
            author = newAuthor,
            year = newYear,
            venueType = newType,
            shortTitle = newShortTitle,
            fields = newFields,
        )

        return save(context, updated)
    }

    /**
     * 不属于 [Doc.fields] 的顶层键，update() 里要跳过。
     *
     * ⚠️ 必须与前端 meta.js 的 TOP_LEVEL_KEYS **逐字一致**，
     *    而 meta.js 那份又必须与 dev-library.js 的 TOP 一致。
     *
     * ⚠️ `shortTitle` 漏在这里就是「短标题保存后消失」的根因 ——
     *    它会被当成普通类别字段写进 fields，而 parseDoc 只读顶层。
     *    当时名字叫 `venueShort`，两边都没接住。
     */
    private val TOP_LEVEL_KEYS = setOf(
        "title", "author", "year", "venueType", "venue", "shortTitle"
    )

    /**
     * 算 PDF 的 SHA-256（小写十六进制）。**必须在后台线程调用**。
     *
     * ⚠️ 全文件流式读取：一篇 50 MB 的 PDF 要一两百毫秒。
     */
    fun sha256Of(file: File): String {
        if (!file.exists()) return ""
        return try {
            val md = java.security.MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    md.update(buf, 0, n)
                }
            }
            md.digest().joinToString("") { b ->
                val v = b.toInt() and 0xFF
                if (v < 16) "0" + Integer.toHexString(v) else Integer.toHexString(v)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "计算 SHA-256 失败：${file.name}", t)
            ""
        }
    }

    /**
     * 补齐缺失的 sha256 / meta.json（v0.2.5 迁移）。**必须在后台线程调用**。
     *
     * ══ 为什么需要 ══
     *
     * 老数据的 meta.json 不存在、sha256 也没算过。
     * 直接调用 `list()` 那些文献的 `sha256` 是空串 —— 模板匹配会静默失败，
     * 用户看到的是"模板怎么都套不上"，很难联想到是升级遗留问题。
     *
     * ⚠️ **幂等**：已经有 sha256 的跳过，不重复算（否则每次启动都
     *    把全库 PDF 读一遍，几十篇就是几秒钟）。
     * ⚠️ 也要为「有 sha256 但没有 meta.json」的补写 meta，
     *    否则详情页会退回读索引 —— 能显示，但下次保存时字段不完整。
     */
    fun ensureMeta(context: Context): Int {
        val docs = list(context)
        var fixed = 0
        docs.forEach { doc ->
            var cur = doc
            var changed = false

            if (cur.sha256.isBlank()) {
                val h = sha256Of(pdfFile(context, doc.id))
                if (h.isNotBlank()) {
                    cur = cur.copy(sha256 = h)
                    changed = true
                }
            }
            if (!metaFile(context, doc.id).exists()) {
                changed = true
            }
            if (changed) {
                writeMeta(context, cur)
                fixed++
            }
        }
        if (fixed > 0) {
            // 索引里的 sha256 也要补 —— 否则下次 list() 又得重新算
            writeIndex(context, docs.map { d ->
                if (d.sha256.isNotBlank()) d
                else d.copy(sha256 = readMeta(context, d.id)?.sha256.orEmpty())
            })
            Log.i(TAG, "[library] meta 迁移补全 $fixed 篇")
        }
        return fixed
    }

    /**
     * 删除若干文献（含文件）。
     *
     * @return 实际删除的数量
     */
    fun delete(context: Context, ids: List<String>): Int {
        if (ids.isEmpty()) return 0
        val docs = list(context)
        val removing = docs.filter { it.id in ids }

        removing.forEach { doc ->
            docDir(context, doc.id).deleteRecursively()
        }

        writeIndex(context, docs.filter { it.id !in ids })
        Log.i(TAG, "[library] deleted ${removing.size} doc(s)")
        return removing.size
    }
}
