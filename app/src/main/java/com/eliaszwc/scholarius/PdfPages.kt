package com.eliaszwc.scholarius

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.File
import java.io.FileOutputStream

/**
 * 把 PDF 的**任意一页**渲染成图片文件，供网页显示（阅读页的「原始视图」）。
 *
 * ══ 为什么是「原生渲染成图」而不是别的办法 ══
 *
 * 这个功能前后试了三种做法，前两种都失败了，记在这里别再走回头路：
 *
 *  ① 网页里放 `<iframe src=".../pdf/<id>">`
 *     → **一片空白**。Android WebView 的内置 PDF 查看器只在顶层文档工作。
 *
 *  ② 让 WebView 自己去 loadUrl(PDF)（顶层文档）
 *     → 确实能渲染，但**整个界面被替换掉**：
 *       · 顶栏消失，用户切不回来；
 *       · 我们自己的菜单/面板也全没了。
 *       更糟的是在覆盖层方案下**直接黑屏** ——
 *       查看器要发 Range 请求才能渲染，而 shouldInterceptRequest
 *       只能给一条整段流，给不出 206 分片。
 *
 *  ③ 本方案：**原生用系统 PdfRenderer 把页画成位图**，网页只显示图片。
 *     好处是彻底摆脱内置查看器的所有怪癖，而且：
 *       · PDF 只是网页里的**一块内容** → 顶栏、底栏、面板天然在它**上面**；
 *       · 翻页/缩放由我们自己控制，不受查看器版本差异影响；
 *       · 不引入第三方依赖（`android.graphics.pdf.PdfRenderer` 是系统自带，
 *         `LibraryStore` 的缩略图已经在用它）。
 *
 * ══ 为什么缓存到文件而不是每次现渲染 ══
 *
 * 一页 A4 按屏幕宽度渲染约 1000×1400，一张 ARGB_8888 位图就是 5.6MB。
 * 若每次翻页都现渲染：
 *   · 翻回上一页要重新渲染（约 100-300ms，能感觉到卡）；
 *   · 连续翻页时几张大位图同时在内存里，很容易 OOM。
 * 所以渲染完就压成 JPEG 落到**缓存目录**（不是私有数据目录 ——
 * 缓存可以被系统回收，丢了重渲染即可，不该占用用户的数据配额）。
 *
 * ⚠️ `PdfRenderer` 只支持**未加密**的 PDF，且**同一时刻只能开一页**。
 *    加密/损坏文件会抛异常，这里一律返回 null，由网页显示占位提示。
 */
object PdfPages {

    private const val TAG = "PdfPages"

    /**
     * 渲染目标宽度（像素）。
     *
     * ⚠️ 不能按屏幕物理宽度渲染。1080p 手机上屏幕是 1080px，
     *    按它渲染 A4 会得到 1080×1528 的位图（6.6MB/张），
     *    翻十页就 66MB —— 必被系统杀掉。
     *
     *     取 1600：足够在 1080p 甚至 1440p 上放大看清正文小字，
     *     又不至于让单张位图失控（1600×2263，JPEG 约 200-400KB）。
     *     网页侧用 CSS `width: 100%` 缩放显示，不由这里决定显示尺寸。
     */
    private const val RENDER_WIDTH = 1600

    /**
     * 单页渲染的高度上限。
     *
     * ⚠️ 有些 PDF 的页面尺寸极其畸形（比如超长的海报/卷轴），
     *    只按宽度等比缩放会得到一张高得离谱的位图 → 分配失败。
     */
    private const val MAX_HEIGHT = 4000

    /** JPEG 质量。85 是「正文小字仍清晰」与「体积可接受」的平衡点。 */
    private const val JPEG_QUALITY = 85

    /**
     * 取某一页的图片文件，没有就渲染出来。
     *
     * @param context 用来定位缓存目录
     * @param docId   文献 id（UUID，由调用方先校验格式）
     * @param page    页码，**从 1 开始**（对用户友好；PdfRenderer 内部从 0 开始）
     * @return 图片文件；渲染失败返回 null
     */
    fun pageImage(context: android.content.Context, docId: String, page: Int): File? {
        if (page < 1) return null

        val pdf = LibraryStore.pdfFile(context, docId)
        if (!pdf.isFile) {
            Log.w(TAG, "PDF 不存在：${pdf.absolutePath}")
            return null
        }

        val out = cacheFile(context, docId, page)

        /*
          ⚠️ 缓存命中还要比对 mtime。
             用户重新导入同一篇文献时 id 会变（新 UUID），所以理论上
             不会撞；但若将来加了「替换 PDF」功能，不比对就会显示旧图。
             比对成本是一次 stat，可以忽略。
        */
        if (out.isFile && out.lastModified() >= pdf.lastModified()) {
            return out
        }

        return render(pdf, out, page)
    }

    /**
     * 取某一页的图片，直接返回 **base64 data URL**（给网页 `img.src`）。
     *
     * ⚠️ 与 `thumbnailFor` 同样的取舍：用 base64 而不是让网页发 HTTP 请求。
     *    图片已经在本地，走 shouldInterceptRequest 再回一次原生没有任何好处，
     *    反而多一层协议要维护。base64 会膨胀 33%，但一张 300KB 的图
     *    变成 400KB 字符串，跨桥传递没有问题。
     */
    fun pageImageDataUrl(context: android.content.Context, docId: String, page: Int): String {
        val file = pageImage(context, docId, page) ?: return ""
        return try {
            "data:image/jpeg;base64," + android.util.Base64.encodeToString(
                file.readBytes(), android.util.Base64.NO_WRAP
            )
        } catch (t: Throwable) {
            Log.w(TAG, "读取页图失败：$docId p$page", t)
            ""
        }
    }

    /** 这一页渲染出来的实际像素宽高（网页据此留出正确比例的空位，避免加载时跳动） */
    fun pageSize(context: android.content.Context, docId: String, page: Int): Pair<Int, Int>? {
        val pdf = LibraryStore.pdfFile(context, docId)
        if (!pdf.isFile) return null
        return try {
            openRenderer(pdf) { renderer ->
                if (page < 1 || page > renderer.pageCount) return@openRenderer null
                renderer.openPage(page - 1).use { p ->
                    val (w, h) = targetSize(p.width, p.height)
                    w to h
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "读取页尺寸失败：$docId p$page", t)
            null
        }
    }

    /** 文献总页数；读不到返回 0 */
    fun pageCount(context: android.content.Context, docId: String): Int {
        val pdf = LibraryStore.pdfFile(context, docId)
        if (!pdf.isFile) return 0
        return try {
            openRenderer(pdf) { it.pageCount } ?: 0
        } catch (t: Throwable) {
            Log.w(TAG, "读取页数失败：$docId", t)
            0
        }
    }

    // -----------------------------------------------------------------------
    // 内部
    // -----------------------------------------------------------------------

    /**
     * 渲染指定页并写成 JPEG。
     *
     * ⚠️ 先写**临时文件**再改名。直接写目标文件的话，
     *    渲染中途失败会留下一个**半截的 JPEG** ——
     *    下次进来 `isFile` 为 true 就当成缓存命中了，
     *    网页显示一张撕裂的图，且永远不会自愈。
     *    改名在同一文件系统内是原子的，不会出现这种中间态。
     */
    private fun render(pdf: File, out: File, page: Int): File? {
        val tmp = File(out.parentFile, out.name + ".tmp")
        return try {
            val ok = openRenderer(pdf) { renderer ->
                if (page > renderer.pageCount) {
                    Log.w(TAG, "页码超范围：$page > ${renderer.pageCount}")
                    return@openRenderer false
                }

                renderer.openPage(page - 1).use { p ->
                    val (w, h) = targetSize(p.width, p.height)
                    if (w <= 0 || h <= 0) return@openRenderer false

                    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                    try {
                        /*
                          ⚠️ 必须先铺白底。PdfRenderer 只画有内容的部分，
                             其余区域是**透明**的 —— 存成 JPEG 时透明会被
                             当成黑色，深色主题下看还行，浅色主题下
                             就是一张黑底白字的怪图。
                             填白才接近纸张观感（与 LibraryStore 的缩略图同理）。
                        */
                        bitmap.eraseColor(Color.WHITE)
                        p.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)

                        out.parentFile?.mkdirs()
                        FileOutputStream(tmp).use { fos ->
                            bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, fos)
                        }
                    } finally {
                        bitmap.recycle()
                    }
                }
                true
            } ?: false

            if (!ok) {
                tmp.delete()
                return null
            }

            // 原子改名；失败就退回复制
            if (tmp.renameTo(out)) {
                out
            } else {
                tmp.copyTo(out, overwrite = true)
                tmp.delete()
                out
            }
        } catch (t: Throwable) {
            Log.w(TAG, "渲染页失败：${pdf.name} p$page (${t.javaClass.simpleName})", t)
            tmp.delete()
            null
        }
    }

    /**
     * 等比缩放到 [RENDER_WIDTH]，并给高度封顶。
     *
     * ⚠️ 宽高都不能为 0 —— `PdfRenderer` 对 0 尺寸抛 IllegalArgumentException。
     */
    private fun targetSize(srcW: Int, srcH: Int): Pair<Int, Int> {
        val w0 = srcW.coerceAtLeast(1)
        val h0 = srcH.coerceAtLeast(1)

        val scale = RENDER_WIDTH.toFloat() / w0
        var w = RENDER_WIDTH
        var h = (h0 * scale).toInt().coerceAtLeast(1)

        if (h > MAX_HEIGHT) {
            val s2 = MAX_HEIGHT.toFloat() / h
            h = MAX_HEIGHT
            w = (w * s2).toInt().coerceAtLeast(1)
        }
        return w to h
    }

    /** 打开 renderer 并保证一定关闭。PdfRenderer 与 fd 必须成对释放。 */
    private fun <T> openRenderer(pdf: File, block: (PdfRenderer) -> T): T? {
        var descriptor: ParcelFileDescriptor? = null
        var renderer: PdfRenderer? = null
        return try {
            descriptor = ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY)
            renderer = PdfRenderer(descriptor)
            block(renderer)
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

    /**
     * 缓存文件位置。
     *
     * ⚠️ 用 `cacheDir` 而不是 `filesDir/library/<id>/`：
     *    页图是**纯派生数据**，随时可以重新渲染出来。
     *    放缓存目录，系统存储紧张时能自己清掉，不会占着用户的数据配额；
     *    万一被清了，下次请求会重新渲染，功能不受影响。
     *
     * ⚠️ 文件名带 `p<page>`，且页码从 1 开始 —— 与用户看到的页码一致，
     *    排查时说「第 3 页」能直接在目录里找到 `p3.jpg`。
     */
    private fun cacheFile(context: android.content.Context, docId: String, page: Int): File {
        val dir = File(context.cacheDir, "pdfpages/$docId")
        return File(dir, "p$page.jpg")
    }
}
