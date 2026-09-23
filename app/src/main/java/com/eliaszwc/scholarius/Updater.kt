package com.eliaszwc.scholarius

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipFile

/**
 * 应用内更新。
 *
 * 流程：查 GitHub 最新 Release → 有新版本就把版本号推给网页弹窗 → 用户确认后
 * 下载 APK → 下载完成拉起系统安装器。全部在后台线程做，结果回主线程再回调。
 *
 * 仓库是公开的，不需要 token；未登录的 GitHub API 限额是每小时 60 次，
 * 所以调用方（MainActivity）要保证「每次进入前台只查一次」。
 *
 * ⚠️ 新包必须用**同一个签名密钥**构建，否则系统会拒绝覆盖安装
 *    （报 INSTALL_FAILED_UPDATE_INCOMPATIBLE）。
 */
object Updater {

    private const val TAG = "Scholarius"
    private const val USER_AGENT = "Scholarius-Android"
    private const val APK_DIR = "update"

    /**
     * 最多跟随几次重定向。
     * GitHub Release 资源通常是 1~2 跳（github.com → objects.githubusercontent.com），
     * 给 5 足够，同时能挡住重定向环。
     */
    private const val MAX_REDIRECTS = 5

    /** 安装失败的原因，会原样传给网页（对应 i18n 的 update.failed.*） */
    const val ERROR_PERMISSION = "permission"
    const val ERROR_NETWORK = "network"
    const val ERROR_INSTALL = "install"

    /** 下下来的东西不是个合法 APK（多半是错误页/半截文件） */
    const val ERROR_INVALID = "invalid"

    /** 包里的版本号跟发布标签对不上 —— 装下去会变成别的版本 */
    const val ERROR_MISMATCH = "mismatch"

    /** 包不比当前装的版本新，装下去等于没更新 */
    const val ERROR_DOWNGRADE = "downgrade"

    /** 字节数跟 Release 里声明的不一致，文件残缺 */
    const val ERROR_TRUNCATED = "truncated"

    /** 解析出来的一个可用版本 */
    data class Release(val version: String, val assetUrl: String, val size: Long)

    private class UpdateException(val code: String) : Exception(code)

    private val releaseApiUrl: String
        get() = "https://api.github.com/repos/${BuildConfig.GITHUB_REPO}/releases/latest"

    // -----------------------------------------------------------------------
    // 查版本
    // -----------------------------------------------------------------------

    /**
     * 有新版本时回调非 null；网络/解析出错或已是最新都回调 null。
     *
     * @param onLog 诊断用日志回调（临时，v0.0.16）。传 null 则只进 logcat。
     */
    fun check(
        context: Context,
        onLog: ((String) -> Unit)? = null,
        onResult: (Release?) -> Unit,
    ) {
        val localVersion = installedVersionName(context)
        log(onLog, "query $releaseApiUrl (current $localVersion)")

        Thread {
            val release = try {
                fetchLatest(onLog)
            } catch (t: Throwable) {
                Log.w(TAG, "[update] 检查更新抛异常", t)
                log(onLog, "check failed: ${t.javaClass.simpleName} ${t.message}")
                null
            }

            val newer = release?.takeIf { localVersion != null && isNewer(it.version, localVersion) }
            if (newer != null) {
                log(onLog, "newer release ${newer.version} (current $localVersion)")
            } else if (release != null) {
                log(onLog, "latest ${release.version} is not newer than $localVersion")
            } else {
                log(onLog, "release parse failed or empty")
            }
            MainThread.post { onResult(newer) }
        }.start()
    }

    /** 同时写 logcat 与（可选的）界面日志 */
    private fun log(onLog: ((String) -> Unit)?, message: String) {
        Log.i(TAG, "[update] $message")
        onLog?.invoke(message)
    }

    private fun fetchLatest(onLog: ((String) -> Unit)?): Release? {
        val connection = (URL(releaseApiUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 15_000
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", USER_AGENT)
        }

        try {
            val code = connection.responseCode
            log(onLog, "API returned HTTP $code")
            if (code != HttpURLConnection.HTTP_OK) {
                Log.w(TAG, "查询 Release 失败：HTTP $code")
                return null
            }

            val body = connection.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            val tag = json.optString("tag_name").trim()
            log(onLog, "tag_name='$tag'")
            if (tag.isEmpty()) return null

            val assets = json.optJSONArray("assets") ?: return null
            log(onLog, "assets: ${assets.length()}")
            for (index in 0 until assets.length()) {
                val asset = assets.optJSONObject(index) ?: continue
                val name = asset.optString("name")
                val url = asset.optString("browser_download_url")
                log(onLog, "  asset: $name")
                if (!name.endsWith(".apk", ignoreCase = true) || url.isEmpty()) continue
                return Release(
                    version = tag.removePrefix("v"),
                    assetUrl = url,
                    size = asset.optLong("size"),
                )
            }
            return null
        } finally {
            connection.disconnect()
        }
    }

    /** 形如 "0.0.10" 的版本号，按段比较大小 */
    private fun isNewer(remote: String, local: String): Boolean {
        val a = parseVersion(remote) ?: return false
        val b = parseVersion(local) ?: return false

        for (index in 0 until maxOf(a.size, b.size)) {
            val left = a.getOrElse(index) { 0 }
            val right = b.getOrElse(index) { 0 }
            if (left != right) return left > right
        }
        return false
    }

    private fun parseVersion(text: String): List<Int>? {
        // 去掉 v 前缀与 -debug 之类的后缀
        val cleaned = text.trim().removePrefix("v").substringBefore('-')
        if (cleaned.isEmpty()) return null
        return cleaned.split('.').map { it.toIntOrNull() ?: return null }
    }

    fun installedVersionName(context: Context): String? = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    } catch (t: Throwable) {
        Log.w(TAG, "读取当前版本失败", t)
        null
    }

    /** 把字节数写成人类可读的文本，给弹窗显示用 */
    fun formatSize(bytes: Long): String {
        if (bytes <= 0) return ""
        val mb = bytes / 1024.0 / 1024.0
        return if (mb >= 1) String.format("%.1f MB", mb)
        else String.format("%.0f KB", bytes / 1024.0)
    }

    // -----------------------------------------------------------------------
    // 下载
    // -----------------------------------------------------------------------

    /**
     * 下载 APK 到 cacheDir/update 并校验。
     * @param onProgress 0~100，进度不可知时不会调用
     * @param onDone 成功给 (文件, null)；失败给 (null, 错误码)
     */
    fun download(
        context: Context,
        release: Release,
        onProgress: (Int) -> Unit,
        onDone: (File?, String?) -> Unit,
    ) {
        val appContext = context.applicationContext

        Thread {
            var file: File? = null
            var error: String? = null
            try {
                file = fetchApk(appContext, release, onProgress)
            } catch (e: UpdateException) {
                Log.w(TAG, "下载校验未通过：${e.code}")
                error = e.code
            } catch (t: Throwable) {
                Log.w(TAG, "下载更新失败", t)
                error = ERROR_NETWORK
            }

            val resultFile = file
            val resultError = error
            MainThread.post { onDone(resultFile, resultError) }
        }.start()
    }

    private fun fetchApk(context: Context, release: Release, onProgress: (Int) -> Unit): File {
        val root = File(context.cacheDir, APK_DIR)
        // 整个目录先清空：绝不留下上一次的安装包
        root.deleteRecursively()

        /*
          目录名 + 文件名都带上版本号 —— 每次更新的 content:// URI 都不一样。
          用固定路径的话，安装器（部分定制 ROM 尤其明显）会按 URI 复用上一次
          扫描/暂存过的那份包，于是「提示的是新版，装下去的却是旧版」，
          而且因为版本没变，下次进 app 又提示同一个新版，无限循环。
         */
        val dir = File(root, safeFileName(release.version))
        dir.mkdirs()

        val target = File(dir, "scholarius.apk")

        /*
          ⚠️ 必须**自己跟随重定向**，不能只靠 instanceFollowRedirects。

          GitHub 的 browser_download_url 会 302 到 objects.githubusercontent.com
          —— 那是**跨主机、跨 CDN** 的跳转。而 HttpURLConnection 的
          instanceFollowRedirects 只会自动跟随**同协议且同主机**的重定向，
          跨主机时它**不跟随，直接把 302 返回来**。

          后果：拿到的是 302 响应，其响应体只是一小段 HTML/空内容；
          若代码没检查状态码就写文件，落盘的就是一个 300 字节的「APK」，
          后面 readApkVersionName() 解不开 zip → 报「不是合法 APK」。

          原来只写了 `if (responseCode != HTTP_OK) throw`，
          但在部分 ROM / CDN 组合下 302 会被就地当成 200 处理，
          于是校验形同虚设。这里显式把 3xx 走完。
         */
        var connection = openConnection(release.assetUrl)
        try {
            var redirects = 0
            while (connection.responseCode in 300..399) {
                val location = connection.getHeaderField("Location")
                if (location.isNullOrEmpty()) {
                    throw UpdateException(ERROR_NETWORK)
                }
                if (++redirects > MAX_REDIRECTS) {
                    // 防重定向环
                    throw UpdateException(ERROR_NETWORK)
                }
                connection.disconnect()
                connection = openConnection(location)
            }

            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) {
                Log.w(TAG, "下载 APK 失败：HTTP $code")
                throw UpdateException(ERROR_NETWORK)
            }

            // 有些 CDN 会返回 text/html（授权失效页），绝不能当真包写盘
            val contentType = connection.contentType ?: ""
            if (contentType.contains("text/html", ignoreCase = true)) {
                Log.w(TAG, "下载到的不是 APK：Content-Type=$contentType")
                throw UpdateException(ERROR_NETWORK)
            }

            val total = connection.contentLength.toLong()
            var copied = 0L
            var lastPercent = -1

            connection.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        output.write(buffer, 0, read)
                        copied += read
                        if (total > 0) {
                            val percent = (copied * 100 / total).toInt()
                            if (percent != lastPercent) {
                                lastPercent = percent
                                MainThread.post { onProgress(percent) }
                            }
                        }
                    }
                    output.flush()
                }
            }
        } finally {
            connection.disconnect()
        }

        verify(context, target, release)
        return target
    }

    /** 一次下载请求；不自动跟随重定向（由调用方显式处理跨主机跳转） */
    private fun openConnection(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            /*
              ⚠️ 关掉它。跨主机跳转它本来就不跟随，开着只会让人误以为已经处理了。
                  统一由 fetchApk 里的循环处理，行为可预期。
            */
            instanceFollowRedirects = false
            useCaches = false
            setRequestProperty("User-Agent", USER_AGENT)
            setRequestProperty("Cache-Control", "no-cache")
            // 明确要二进制，别让中间层做内容协商
            setRequestProperty("Accept", "application/octet-stream")
        }

    // -----------------------------------------------------------------------
    // 校验（三道，缺一不可）
    // -----------------------------------------------------------------------

    private fun verify(context: Context, file: File, release: Release) {
        if (!file.exists() || file.length() == 0L) {
            Log.w(TAG, "校验失败：文件不存在或为空 (exists=${file.exists()}, len=${file.length()})")
            throw UpdateException(ERROR_INVALID)
        }

        Log.i(
            TAG,
            "[update] verifying: ${file.length()} bytes, " +
                "expected ${release.size}, path=${file.absolutePath}"
        )

        // ① 体积：Release 里声明了多少字节就该是多少
        if (release.size > 0 && file.length() != release.size) {
            Log.w(TAG, "体积不符：期望 ${release.size}，实际 ${file.length()}")
            throw UpdateException(ERROR_TRUNCATED)
        }

        // ② 前两个字节必须是 zip 的 PK 魔数 —— 这能一眼区分「真 APK」
        //    和「HTML 错误页 / 半截文件」，比解析版本号更早、更明确
        if (!hasZipMagic(file)) {
            Log.w(TAG, "校验失败：不是 zip（前 4 字节不是 PK\\x03\\x04）")
            throw UpdateException(ERROR_INVALID)
        }

        // ③ 包结构 + 版本号
        val version = readApkVersionName(file)
        if (version == null) {
            Log.w(TAG, "校验失败：读不到包内 versionName（zip 里没有 AndroidManifest.xml？）")
            throw UpdateException(ERROR_INVALID)
        }
        if (!sameVersion(version, release.version)) {
            Log.w(TAG, "包内版本 $version 与发布标签 ${release.version} 不一致")
            throw UpdateException(ERROR_MISMATCH)
        }

        // ④ 不比当前装的版本新就没意义（还可能是降级攻击）
        val installed = installedVersionName(context)
        if (installed != null && !isNewer(release.version, installed)) {
            Log.w(TAG, "包不比已装的 $installed 新，阻止安装")
            throw UpdateException(ERROR_DOWNGRADE)
        }

        Log.i(TAG, "[update] verified OK: version=$version, ${file.length()} bytes")
    }

    /**
     * 前 4 字节是不是 zip 的本地文件头魔数 `PK\x03\x04`。
     *
     * APK 本质是 zip；拿到 HTML 错误页/空响应/半截文件时这一步就能立刻判定，
     * 不必等 readApkVersionName 里 zip 解析抛异常（那种失败很难看出原因）。
     */
    private fun hasZipMagic(file: File): Boolean = try {
        file.inputStream().use { input ->
            val head = ByteArray(4)
            if (input.read(head) < 4) {
                false
            } else {
                head[0] == 0x50.toByte() && head[1] == 0x4B.toByte() &&
                    head[2] == 0x03.toByte() && head[3] == 0x04.toByte()
            }
        }
    } catch (t: Throwable) {
        false
    }

    private fun sameVersion(a: String, b: String): Boolean {
        val pa = parseVersion(a) ?: return false
        val pb = parseVersion(b) ?: return false
        if (pa.size != pb.size) return false
        return pa.indices.all { pa[it] == pb[it] }
    }

    /**
     * 直接从 APK（zip）里读 AndroidManifest 拿版本号。
     * 不依赖 PackageManager —— 包还没安装，查不到。
     */
    private fun readApkVersionName(apk: File): String? = try {
        ZipFile(apk).use { zip ->
            val entry = zip.getEntry("AndroidManifest.xml") ?: return null
            val bytes = zip.getInputStream(entry).use { it.readBytes() }
            readVersionFromBinaryManifest(bytes)
        }
    } catch (t: Throwable) {
        Log.w(TAG, "读取 APK 版本失败", t)
        null
    }

    /**
     * 从编译过的（二进制）AndroidManifest 里捞 versionName。
     *
     * 这里不做完整的 AXML 解析，而是找字符串池里的版本号字面量 —— 够用且不引依赖。
     * 版本号在字符串池里一定是独立的一项，形如 "0.0.2"。
     */
    private fun readVersionFromBinaryManifest(bytes: ByteArray): String? {
        val text = buildString {
            var index = 0
            while (index < bytes.size) {
                val ch = bytes[index].toInt() and 0xFF
                // 只接受可打印 ASCII，其余当分隔符
                if (ch in 0x20..0x7E) append(ch.toChar()) else append('\u0000')
                index++
            }
        }

        return Regex("\\b\\d+\\.\\d+\\.\\d+\\b")
            .findAll(text)
            .map { it.value }
            .firstOrNull()
    }

    private fun safeFileName(version: String): String =
        version.replace(Regex("[^0-9A-Za-z._-]"), "_")

    // -----------------------------------------------------------------------
    // 安装
    // -----------------------------------------------------------------------

    /**
     * 拉起系统安装器。
     *
     * ⚠️ 一定要传 Activity，不要传 Context。用 Activity 启动安装器，
     *    系统才知道是「当前前台界面发起的安装」，部分 ROM 用
     *    ApplicationContext 启动会直接拒绝（表现为点更新毫无反应）。
     *
     * @return 成功给 null；失败给错误码
     */
    fun install(activity: Activity, apk: File): String? {
        if (!apk.exists()) return ERROR_INVALID

        /*
          Android 8（O）起，安装「未知来源」的应用需要用户**在系统设置里手动授权**。
          只在 Manifest 里声明 REQUEST_INSTALL_PACKAGES 是不够的 ——
          没授权时 startActivity 不会有任何反应（安装器根本不出现），
          用户看到的就是「点了更新、下载完了、然后什么都没发生」。

          所以这里必须先查 canRequestPackageInstalls()，没给权限就把用户
          送到授权页，并回一个 ERROR_PERMISSION 让弹窗显示「去授权」的提示。
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            openInstallPermissionSettings(activity)
            return ERROR_PERMISSION
        }

        return try {
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                apk,
            )

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, APK_MIME)
                // 必须给安装器读这个 content:// 的权限，否则它拿不到包
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(intent)
            null
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "没有可用的安装器", e)
            ERROR_INSTALL
        } catch (e: IllegalArgumentException) {
            // FileProvider 配置里没覆盖这个路径
            Log.w(TAG, "FileProvider 无法共享该文件", e)
            ERROR_INSTALL
        } catch (t: Throwable) {
            Log.w(TAG, "拉起安装器失败", t)
            ERROR_INSTALL
        }
    }

    /** 把用户送到「安装未知应用」授权页；不回来自动重试，由用户点弹窗重试 */
    private fun openInstallPermissionSettings(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:" + activity.packageName)),
            )
        } catch (t: Throwable) {
            Log.w(TAG, "打开「安装未知应用」设置失败", t)
        }
    }

    /** 安装包 MIME，与 FileProvider 暴露的路径配套 */
    const val APK_MIME = "application/vnd.android.package-archive"
}
