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
                // 按坐标重排，保证阅读顺序正确（双栏论文尤其重要）
                stripper.sortByPosition = true
                /*
                  ⚠️ 行分隔符必须是显式的 "\n"。
                      默认值也是换行，但显式写出来防止将来 PDFBox 改默认值；
                      也绝不能设成空串 —— 那样所有行会粘成一大坨。
                */
                stripper.lineSeparator = "\n"

                val text = stripper.getText(document)

                if (text.isNullOrBlank()) {
                    // 扫描件（图片 PDF）走这里。不是错误，是真的没有文本层
                    Log.i(TAG, "no text layer: ${pdf.name}")
                    return null
                }

                if (text.length > MAX_CHARS) {
                    Log.i(TAG, "truncating ${text.length} -> $MAX_CHARS chars")
                    text.substring(0, MAX_CHARS)
                } else {
                    Log.i(TAG, "extracted ${text.length} chars from ${pdf.name}")
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
}
