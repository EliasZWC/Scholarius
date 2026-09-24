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
    )

    // -----------------------------------------------------------------------
    // 路径
    // -----------------------------------------------------------------------

    private fun libraryDir(context: Context): File =
        File(context.filesDir, LIBRARY_DIR).apply { mkdirs() }

    private fun docDir(context: Context, id: String): File =
        File(libraryDir(context), id)

    fun pdfFile(context: Context, id: String): File = File(docDir(context, id), PDF_FILE)

    fun thumbFile(context: Context, id: String): File = File(docDir(context, id), THUMB_FILE)

    private fun indexFile(context: Context): File = File(libraryDir(context), INDEX_FILE)

    // -----------------------------------------------------------------------
    // 索引读写
    // -----------------------------------------------------------------------

    /**
     * 读全部文献，按导入时间**倒序**（最新的在最前）。
     *
     * 索引损坏时返回空列表而不是抛异常 —— 一处 JSON 解析失败不该让
     * 整个文库打不开。真正的文件都在各子目录里，不会因此丢失。
     */
    fun list(context: Context): List<Doc> {
        val file = indexFile(context)
        if (!file.exists()) return emptyList()

        return try {
            val array = JSONArray(file.readText())
            (0 until array.length()).mapNotNull { i ->
                array.optJSONObject(i)?.let(::parseDoc)
            }.sortedByDescending { it.addedAt }
        } catch (t: Throwable) {
            Log.w(TAG, "文献索引读取失败", t)
            emptyList()
        }
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
        fields = parseFields(json.optJSONObject("fields")),
        addedAt = json.optLong("addedAt"),
        pages = json.optInt("pages"),
        size = json.optLong("size"),
        sourceName = json.optString("sourceName"),
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
            array.put(JSONObject().apply {
                put("id", doc.id)
                put("title", doc.title)
                put("author", doc.author)
                put("venue", doc.venue)
                put("year", doc.year)
                put("venueType", doc.venueType)
                // fields 为空时**不写这个键**（老版本读到会当成空 Map）
                if (doc.fields.isNotEmpty()) {
                    put("fields", JSONObject().apply {
                        doc.fields.forEach { (k, v) -> put(k, v) }
                    })
                }
                put("addedAt", doc.addedAt)
                put("pages", doc.pages)
                put("size", doc.size)
                put("sourceName", doc.sourceName)
            })
        }
        indexFile(context).writeText(array.toString())
    }

    // -----------------------------------------------------------------------
    // 导入
    // -----------------------------------------------------------------------

    /**
     * 导入一个 PDF。**必须在后台线程调用**（要复制文件 + 渲染缩略图）。
     *
     * @param openStream 由调用方提供的「打开源文件输入流」函数。
     *                   用函数而不是直接传 InputStream，是为了让本函数
     *                   能在复制失败时重新打开一次（SAF 的流是一次性的）。
     * @param displayName 原文件名，用于兜底标题与展示
     * @return 导入成功给 Doc；失败给 null（原因已写日志）
     */
    fun import(
        context: Context,
        displayName: String,
        openStream: () -> java.io.InputStream?,
    ): Doc? {
        val id = UUID.randomUUID().toString()
        val dir = docDir(context, id)
        if (!dir.mkdirs()) {
            Log.w(TAG, "无法创建文献目录：${dir.absolutePath}")
            return null
        }

        val pdf = File(dir, PDF_FILE)

        // ① 复制源文件
        val copied = try {
            openStream()?.use { input ->
                pdf.outputStream().use { output -> input.copyTo(output) }
            } ?: false
            pdf.length() > 0
        } catch (t: Throwable) {
            Log.w(TAG, "复制 PDF 失败", t)
            false
        }

        if (!copied) {
            dir.deleteRecursively()
            return null
        }

        // ② 必须是真 PDF（前 4 字节 %PDF）
        if (!isPdf(pdf)) {
            Log.w(TAG, "导入的文件不是 PDF（前 4 字节不是 %PDF）")
            dir.deleteRecursively()
            return null
        }

        // ③ 渲染缩略图 + 读页数
        val pages = renderThumbnail(pdf, File(dir, THUMB_FILE))

        // ④ 提取元数据（失败就留空，不阻断导入）
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
            addedAt = System.currentTimeMillis(),
            pages = pages,
            size = pdf.length(),
            sourceName = displayName,
        )

        // ⑤ 写入索引
        try {
            writeIndex(context, list(context) + doc)
        } catch (t: Throwable) {
            Log.w(TAG, "写入文献索引失败", t)
            dir.deleteRecursively()
            return null
        }

        Log.i(TAG, "[library] imported ${doc.id} '${doc.title}' pages=$pages size=${doc.size}")
        return doc
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
            fields = newFields,
        )

        writeIndex(context, docs.map { if (it.id == id) updated else it })
        return true
    }

    /** 不属于 [Doc.fields] 的顶层键，update() 里要跳过 */
    private val TOP_LEVEL_KEYS = setOf("title", "author", "year", "venueType", "venue")

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
