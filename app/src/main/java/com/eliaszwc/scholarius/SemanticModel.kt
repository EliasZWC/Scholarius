package com.eliaszwc.scholarius

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * ══ 语义分段模型的下载与检测（v0.1.94 / v0.1.95）══
 *
 * 用户要求（原话）：
 *   「可以放在设置里面，到时候用户自己选择要不要用语义模型来分，
 *     如果要，让用户自己下载，这就和安装包解体了」
 *   「选开启后自动检测是否本地下了模型，没有就弹出表单下载，
 *     否则回到 off 状态」
 *   「模型大小多少？我要确定不会给移动设备造成负担」
 *
 * ══ 为什么要下载多个文件，而不是一个"模型" ══
 *
 * 语义分段要三样东西，缺一不可：
 *
 *   ① 推理引擎 onnxruntime 的 WASM —— 11.2MB
 *   ② 模型本体 INT8 量化的 MiniLM-L3 —— 17.5MB
 *   ③ tokenizer / config —— 0.7MB
 *
 * 我曾把这个算成"模型 17.5MB"，漏掉了 WASM —— 那是错的。
 * 实际下载量约 29.4MB，必须如实告诉用户。
 *
 * ══ 为什么用 L3 而不是 L6 ══
 *
 * 用户：「先换更小的模型，我看看效果如何，如果效果 ok 就直接这样」
 * L3（3 层）17.5MB / L6（6 层）23MB，前者快约 2 倍。
 * 分段是粗粒度任务，不需要 L6 的精度。
 *
 * ══ 这个类只管文件，不管推理 ══
 *
 * 推理在前端（transformers.js，见 semantic-seg.js）——
 * 用户已明确选择这条路。这里只负责：文件在不在（[isReady]）、下载（[download]）。
 */
object SemanticModel {

    private const val TAG = "SemanticModel"

    /** 模型 ID。⚠️ 与 semantic-seg.js 的 MODEL_ID 必须一致 */
    private const val MODEL_ID = "paraphrase-MiniLM-L3-v2"

    /** 一个待下载的远程文件 → 本地相对路径 */
    private data class Remote(val url: String, val path: String)

    /**
     * 下载清单。
     *
     * ⚠️ 路径相对 `files/model/`，与 transformers.js 的
     *    `env.localModelPath` 对应（见 semantic-seg.js）。
     *
     * ⚠️ WASM 用 `simd-threaded` 而**不是** `jsep`：
     *    jsep 那份带 WebGPU 支持，21.6MB，几乎翻倍，
     *    而 WebView 里不用 WebGPU —— 白白多下 10MB。
     */
    /**
     * ══ ⚠️⚠️ WASM 的版本**必须与 transformers.js 内置的 ort 完全一致** ══
     *
     * 实测日志（这是根因，找了三轮才看清）：
     *
     *     env.backends.onnx.versions = {
     *       common: "1.20.0-dev.20241016-2b8fc5529b",
     *       web:    "1.21.0-dev.20241024-d9ca84ef96"
     *     }
     *
     * 而我一直下的是 `onnxruntime-web@1.20.0` 的正式版 →
     * 版本不匹配，加载时抛 `ie[e] is not a function`。
     *
     * ⚠️ 这个错误信息完全看不出是"版本不对"：
     *    它只是某个内部注册表查不到键，连"WASM"两个字都不出现。
     *
     * ✅ 用 transformers.js 内置的那个确切版本号。
     * ⚠️ 升级 transformers.js 时**必须同步改这里**，
     *    并重新核对 env.backends.onnx.versions.web。
     */
    private const val ORT_VERSION = "1.21.0-dev.20241024-d9ca84ef96"

    private val FILES = listOf(
        /*
          ⚠️ 必须是 `jsep` 版本 —— transformers.js 3.0.2 硬编码要这个名字。
             我曾判断「WebView 用不上 WebGPU，下小的非 jsep 就行」，
             实测 FileNotFoundException 直接打脸。
        */
        Remote(
            "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT_VERSION/dist/" +
                "ort-wasm-simd-threaded.jsep.wasm",
            "ort/ort-wasm-simd-threaded.jsep.wasm"
        ),
        Remote(
            "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ORT_VERSION/dist/" +
                "ort-wasm-simd-threaded.jsep.mjs",
            "ort/ort-wasm-simd-threaded.jsep.mjs"
        ),
        Remote(
            "https://huggingface.co/Xenova/$MODEL_ID/resolve/main/" +
                "onnx/model_quantized.onnx",
            "$MODEL_ID/onnx/model_quantized.onnx"
        ),
        Remote(
            "https://huggingface.co/Xenova/$MODEL_ID/resolve/main/tokenizer.json",
            "$MODEL_ID/tokenizer.json"
        ),
        /*
          ══ ⚠️⚠️ tokenizer_config.json 不能漏（v0.1.95 实测）══

          第一次跑真模型时报：

              `local_files_only=true` and file was not found locally at
              ".../paraphrase-MiniLM-L3-v2/tokenizer_config.json"

          它和 tokenizer.json 是**两个不同文件**：
            · tokenizer.json        —— 词表与合并规则（0.7MB）
            · tokenizer_config.json —— 如何调用它（do_lower_case、
                                        max_length、特殊 token…，约 1KB）

          ⚠️ 少了它，transformers.js 会**加载失败**，
             而报错信息只提"找不到文件"，完全看不出
             "你少下了一个配置文件"。
        */
        Remote(
            "https://huggingface.co/Xenova/$MODEL_ID/resolve/main/tokenizer_config.json",
            "$MODEL_ID/tokenizer_config.json"
        ),
        Remote(
            "https://huggingface.co/Xenova/$MODEL_ID/resolve/main/config.json",
            "$MODEL_ID/config.json"
        )
    )

    /**
     * 预计下载总量（字节），仅用于进度百分比。
     *
     * ══ ⚠️⚠️ 实测值（v0.1.95）══
     *
     * 完整下载是 **29,430,672 字节**（约 28.1 MiB）。
     *
     * ⚠️ 第一版凭感觉填 30,800,000，结果进度条走到 **95%** 就"完成"了，
     *    永远到不了 100% —— 看起来像卡死。
     *
     * ✅ 现在填实测值。**并且**下载完成时前端会强制置 100%
     *    （见 semantic.js 的 downloadFinished）——
     *    双保险：总量估算再怎么不准，完成那一刻一定是 100%。
     *
     * ⚠️ 换模型要重算这个数（把 FILES 各项真实大小相加）。
     */
    const val TOTAL_BYTES: Long = 29_430_672L

    /** 模型根目录：与应用数据同级，卸载时一起删除 */
    fun dir(context: Context): File =
        File(context.filesDir, "model").apply { if (!exists()) mkdirs() }

    /**
     * 模型是否已就绪。
     *
     * ══ ⚠️⚠️ 判据：每个文件都存在且**非空**（v0.1.95 实测修）══
     *
     * 第一版写 `length() > 512L`，想挡住"下载了 0 字节或错误页"。
     * 结果 `tokenizer_config.json` 只有 **366 字节**（正常内容就是那么小）——
     * 文件齐全却永远报"未就绪"，开关打不开。
     *
     * ✅ 改成 `> 0`：只排除空文件。
     *    文件损坏由**推理时**报错发现（那时有明确的错误信息），
     *    不该在这一层用大小去猜 —— 猜错就是把好功能锁死。
     */
    fun isReady(context: Context): Boolean {
        val root = dir(context)
        return FILES.all { r ->
            val f = File(root, r.path)
            f.exists() && f.length() > 0L
        }
    }

    /** 请求取消（下载线程会检查） */
    @Volatile
    var cancelRequested: Boolean = false
        private set

    fun cancel() {
        cancelRequested = true
    }

    /**
     * 下载全部文件。
     *
     * ⚠️ 后台线程（本方法自己开线程）。
     * ⚠️ 每个文件下到 `.part` 再 rename —— 中途失败不留半截文件。
     * ⚠️ 支持**取消**：检查 [cancelRequested]，随时可中断。
     *
     * @param onProgress 进度回调。参数是已下载字节
     * @param onDone     完成回调。true = 全部成功
     */
    fun download(
        context: Context,
        onProgress: (Long) -> Unit,
        onDone: (Boolean) -> Unit
    ) {
        cancelRequested = false
        Thread {
            val root = dir(context)
            var written = 0L
            var ok = true

            for (r in FILES) {
                if (cancelRequested) { ok = false; break }

                val target = File(root, r.path)
                target.parentFile?.mkdirs()
                val tmp = File(target.parentFile, target.name + ".part")

                val got = fetch(r.url, tmp) { delta ->
                    written += delta
                    onProgress(written)
                }

                if (got <= 0L) {
                    ok = false
                    tmp.delete()
                    break
                }
                if (!tmp.renameTo(target)) {
                    Log.w(TAG, "rename failed: ${r.path}")
                    ok = false
                    tmp.delete()
                    break
                }
            }

            /*
              ⚠️ 被取消/失败时要**清理已下载的部分** ——
                 留着半套文件只会让 isReady 误判，也会白占 30MB 磁盘。
            */
            if (!ok) {
                root.deleteRecursively()
                root.mkdirs()
            }

            Log.i(TAG, "download finished ok=$ok bytes=$written")
            onDone(ok)
        }.start()
    }

    /**
     * 下载单个文件。
     *
     * @return 写入的字节数；失败或取消返回 0
     */
    private fun fetch(url: String, dest: File, onDelta: (Long) -> Unit): Long {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 60_000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "Scholarius")
            }
            if (conn.responseCode !in 200..299) {
                Log.w(TAG, "HTTP ${conn.responseCode} for $url")
                return 0
            }
            var total = 0L
            conn.inputStream.use { input ->
                dest.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (cancelRequested) return 0
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        total += n
                        onDelta(n.toLong())
                    }
                }
            }
            total
        } catch (t: Throwable) {
            Log.w(TAG, "fetch failed: $url", t)
            0L
        } finally {
            conn?.disconnect()
        }
    }
}
