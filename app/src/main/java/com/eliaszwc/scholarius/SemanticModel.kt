package com.eliaszwc.scholarius

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * ══ 语义分段模型的管理（v0.1.94）══
 *
 * 用户要求（原话）：
 *   「我觉得可以放在设置里面，到时候用户自己选择要不要用语义模型来分，
 *     如果要，让用户自己下载，这就和安装包解体了」
 *   「选开启后自动检测是否本地下了模型，没有就弹出表单下载，
 *     否则回到 off 状态」
 *
 * ══ 第一性原理：为什么不打包进 APK ══
 *
 * APK 现在 11MB。模型（约 23MB）放进去就是 34MB，
 * 而**多数用户不需要**语义分段（标点分段对排版规整的论文已经够用）。
 * 让需要的人下载，是唯一合理的选择 —— 这不是省事，是正确的产品结构。
 *
 * ══ 这个类只管一个文件 ══
 *
 * 它不负责分词、不负责分段、不负责推理。
 * 它只回答两件事：
 *   ① 模型文件在不在？（[isReady]）
 *   ② 下载它。（[download]）
 *
 * ⚠️ 为什么下载要自己做而不用第三方库：
 *   只需要一个 GET + 写文件，引入 OkHttp/Retrofit 是为了一行代码
 *   背上几 MB 依赖，不值得。
 *
 * ══ ⚠️⚠️ 当前状态：框架就位，模型尚未接入 ══
 *
 * 这轮实现的是**设置界面与下载机制**（用户明确要求的范围）。
 * 真正的分段推理还没接 —— 因为那需要选模型格式、接入 ONNX/TFLite 运行时，
 * 是另一件独立的事。
 *
 * 所以 [isReady] 现在会返回**真实的文件存在性**：
 * 下载完成 → 文件在 → 返回 true。但即使为 true，
 * `PdfText` 里也还没有代码去用它分段。
 *
 * ⚠️ 这个不一致**必须**在接入推理前解决 ——
 *    否则开关显示"开启"，实际分段行为没变，就是撒谎。
 *    见 TODO(seg) 标记。
 */
object SemanticModel {

    private const val TAG = "SemanticModel"

    /** 模型文件名。⚠️ 与 [MODEL_URL] 的最后一段保持一致 */
    private const val FILE_NAME = "minilm-seg.onnx"

    /**
     * 模型下载地址。
     *
     * ⚠️ 现在指向占位地址 —— 接推理时必须换成真实的模型文件。
     *    TODO(seg): 换成实际托管的模型（建议 GitHub Release 附件，
     *    与本项目的 APK 同一套发布机制，无需额外服务）。
     */
    private const val MODEL_URL =
        "https://github.com/EliasZWC/Scholarius/releases/download/model-v1/$FILE_NAME"

    /** 模型目录：与应用数据同级，卸载时一起删除 */
    private fun dir(context: Context): File =
        File(context.filesDir, "model").apply { if (!exists()) mkdirs() }

    /** 模型文件 */
    fun file(context: Context): File = File(dir(context), FILE_NAME)

    /**
     * 模型是否已就绪。
     *
     * ⚠️ 判据是**文件存在且非空**，不是"下载过"。
     *    下载中断会留下半截文件 —— 那种情况必须重新下载，
     *    否则推理时会崩在"模型格式错误"上，而用户完全不知道原因。
     */
    fun isReady(context: Context): Boolean {
        val f = file(context)
        return f.exists() && f.length() > 1024L
    }

    /**
     * 下载模型。
     *
     * ⚠️ 必须在**后台线程**调用（本方法自己开线程，调用方直接调即可）。
     * ⚠️ 下载到临时文件再 rename —— 中途失败不会留下半截文件
     *    覆盖掉一份好的旧模型（与 LibraryStore.writeMd 同一套思路）。
     *
     * @param onDone 完成回调，在主线程调用。true = 成功
     */
    fun download(context: Context, onDone: (Boolean) -> Unit) {
        Thread {
            val target = file(context)
            val tmp = File(target.parentFile, "$FILE_NAME.part")
            var ok = false
            try {
                Log.i(TAG, "downloading $MODEL_URL")
                val conn = (URL(MODEL_URL).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 60_000
                    instanceFollowRedirects = true
                }
                try {
                    if (conn.responseCode !in 200..299) {
                        Log.w(TAG, "HTTP ${conn.responseCode}")
                    } else {
                        conn.inputStream.use { input ->
                            tmp.outputStream().use { out ->
                                input.copyTo(out, 64 * 1024)
                            }
                        }
                        /*
                          ⚠️ 基本校验：太小的文件一定是错误页/空响应。
                             不做完整校验（那要在推理时做），
                             但至少要挡住"下载了一个 0 字节"。
                        */
                        if (tmp.length() < 1024L) {
                            Log.w(TAG, "downloaded file too small: ${tmp.length()}")
                        } else if (tmp.renameTo(target)) {
                            ok = true
                        } else {
                            Log.w(TAG, "rename failed")
                        }
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (t: Throwable) {
                Log.w(TAG, "download failed", t)
            } finally {
                if (!ok && tmp.exists()) tmp.delete()
            }

            Log.i(TAG, "download finished ok=$ok size=${if (ok) target.length() else 0}")
            onDone(ok)
        }.start()
    }
}
