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
        /** 发表物（期刊/会议）。提取不到时为空串 */
        val venue: String,
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
        addedAt = json.optLong("addedAt"),
        pages = json.optInt("pages"),
        size = json.optLong("size"),
        sourceName = json.optString("sourceName"),
    )

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

        val doc = Doc(
            id = id,
            title = meta.title.ifBlank { fallbackTitle(displayName) },
            author = meta.author,
            venue = meta.venue,
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

    /** 改标题 / 作者 / 发表物。空串表示清空该字段（标题除外，它会落回文件名） */
    fun update(context: Context, id: String, title: String?, author: String?, venue: String?): Boolean {
        val docs = list(context)
        val target = docs.firstOrNull { it.id == id } ?: return false

        val updated = target.copy(
            title = (title ?: target.title).ifBlank { fallbackTitle(target.sourceName) },
            author = author ?: target.author,
            venue = venue ?: target.venue,
        )

        writeIndex(context, docs.map { if (it.id == id) updated else it })
        return true
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
