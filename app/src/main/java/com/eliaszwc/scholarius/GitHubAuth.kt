package com.eliaszwc.scholarius

import android.content.Context
import android.net.Uri
import android.util.Log
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlin.concurrent.thread

/**
 * GitHub OAuth **Device Flow** 登录。
 *
 * 为什么用 Device Flow 而不是常规 OAuth：
 *   纯客户端 app 无法安全地保存 `client_secret`。Device Flow 的设计目的就是
 *   让这类 app 不需要 secret —— 用户在别的设备（浏览器 / GitHub App）上授权，
 *   本机只拿着一个公开的 `client_id` 去换 token。
 *
 * 为什么整个流程必须在原生层做，不能放网页里：
 *   WebView 里 fetch `github.com` 会被 CORS 拦住 —— GitHub 的这两个端点
 *   都不返回 `Access-Control-Allow-Origin`。所以 HTTP 请求全部走 Kotlin。
 *
 * 流程：
 *   ① POST /login/device/code            拿 device_code + user_code
 *   ② 用户去 verification_uri 输入 user_code 并授权
 *   ③ 按 interval 轮询 /login/oauth/access_token
 *      未授权时返回 error=authorization_pending，继续等；
 *      轮得太快会返回 error=slow_down，此时 interval 要 +5s
 *   ④ 拿到 access_token
 *
 * ⚠️ GitHub 要求这两个请求都带 `Accept: application/json`，
 *    否则返回值是 form-urlencoded，解析会失败。
 */
object GitHubAuth {

    private const val TAG = "Scholarius"

    private const val DEVICE_CODE_URL = "https://github.com/login/device/code"
    private const val TOKEN_URL = "https://github.com/login/oauth/access_token"
    private const val USER_URL = "https://api.github.com/user"
    private const val USER_AGENT = "Scholarius-Android"

    /**
     * 申请的权限：
     *   repo       —— 读写仓库（用户的标注/笔记要存进他自己的仓库）
     *   read:user  —— 读头像、用户名
     */
    private const val SCOPE = "repo read:user"

    /** 设备码有效期（秒）。GitHub 目前给 900s，超时后得重新走一遍。 */
    private const val EXPIRES_IN_SECONDS = 900

    /** 起始轮询间隔（秒）。服务器返回的 `interval` 优先。 */
    private const val DEFAULT_INTERVAL_SECONDS = 5

    /** 遇到 slow_down 时，间隔加这么多秒 */
    private const val SLOW_DOWN_STEP_SECONDS = 5

    /** 单次 HTTP 超时 */
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 20_000

    /** 一次设备授权的全部信息 */
    data class DeviceCode(
        val deviceCode: String,
        val userCode: String,
        val verificationUri: String,
        val intervalSeconds: Int,
        val expiresInSeconds: Int,
    )

    /** 登录成功后拿到的账号信息 */
    data class Account(
        val login: String,
        val name: String,
        val avatarUrl: String,
        /** GitHub 数字账号 ID。未登录/读取失败时为 0 */
        val id: Long,
        val token: String,
    )

    /** 失败原因，会原样传给网页（对应 i18n 的 login.error.*） */
    const val ERROR_NETWORK = "network"
    const val ERROR_DENIED = "denied"
    const val ERROR_EXPIRED = "expired"
    const val ERROR_INVALID = "invalid"
    const val ERROR_UNKNOWN = "unknown"

    private class AuthException(val code: String) : Exception(code)

    /** 轮询循环的运行标记，用来支持「用户点了取消」 */
    @Volatile
    private var polling = false

    // -----------------------------------------------------------------------
    // ① 申请设备码
    // -----------------------------------------------------------------------

    /**
     * 拿到 user_code 后回调；出错给 (null, 错误码)。
     * 回调都在主线程。
     */
    fun requestDeviceCode(onResult: (DeviceCode?, String?) -> Unit) {
        thread {
            var code: DeviceCode? = null
            var error: String? = null
            try {
                code = postForm(
                    DEVICE_CODE_URL,
                    mapOf(
                        "client_id" to BuildConfig.GITHUB_CLIENT_ID,
                        "scope" to SCOPE,
                    ),
                ).let { json ->
                    val deviceCode = json.optString("device_code")
                    val userCode = json.optString("user_code")
                    val uri = json.optString("verification_uri")
                    if (deviceCode.isEmpty() || userCode.isEmpty() || uri.isEmpty()) {
                        // 常见原因：OAuth App 没勾 Enable Device Flow（GitHub 会给 403）
                        Log.w(TAG, "设备码响应缺少字段：$json")
                        throw AuthException(ERROR_INVALID)
                    }
                    DeviceCode(
                        deviceCode = deviceCode,
                        userCode = userCode,
                        verificationUri = uri,
                        intervalSeconds = json.optInt("interval", DEFAULT_INTERVAL_SECONDS)
                            .coerceAtLeast(1),
                        expiresInSeconds = json.optInt("expires_in", EXPIRES_IN_SECONDS),
                    )
                }
            } catch (e: AuthException) {
                error = e.code
            } catch (t: Throwable) {
                Log.w(TAG, "申请设备码失败", t)
                error = ERROR_NETWORK
            }

            val result = code
            val reason = error
            MainThread.post { onResult(result, reason) }
        }
    }

    // -----------------------------------------------------------------------
    // ② 轮询换 token
    // -----------------------------------------------------------------------

    /**
     * 阻塞式轮询，直到拿到 token、超时、被拒或用户取消。
     * **必须在后台线程调用**；结果回主线程。
     *
     * @param onUpdated 每次「还在等」时回调，参数是已等待秒数（用于显示进度）
     */
    fun pollForToken(
        deviceCode: DeviceCode,
        onUpdated: (Int) -> Unit,
        onResult: (Account?, String?) -> Unit,
    ) {
        polling = true
        thread {
            var account: Account? = null
            var error: String? = null

            try {
                account = pollUntilDone(deviceCode, onUpdated)
            } catch (e: AuthException) {
                error = e.code
            } catch (t: Throwable) {
                Log.w(TAG, "轮询 token 失败", t)
                error = ERROR_NETWORK
            } finally {
                polling = false
            }

            val result = account
            val reason = error
            MainThread.post { onResult(result, reason) }
        }
    }

    private fun pollUntilDone(deviceCode: DeviceCode, onUpdated: (Int) -> Unit): Account {
        var interval = deviceCode.intervalSeconds
        var waited = 0
        val deadline = deviceCode.expiresInSeconds

        while (polling && waited < deadline) {
            Thread.sleep(interval * 1000L)
            waited += interval
            if (!polling) {
                throw AuthException(ERROR_UNKNOWN)
            }
            onUpdated(waited)

            val json = postForm(
                TOKEN_URL,
                mapOf(
                    "client_id" to BuildConfig.GITHUB_CLIENT_ID,
                    "device_code" to deviceCode.deviceCode,
                    "grant_type" to "urn:ietf:params:oauth:grant-type:device_code",
                ),
            )

            // 成功：拿到 access_token
            val token = json.optString("access_token")
            if (token.isNotEmpty()) {
                Log.i(TAG, "登录成功")
                return fetchAccount(token)
            }

            when (json.optString("error")) {
                // 用户还没输码/还没点授权，继续等
                "authorization_pending" -> Unit
                // 轮得太快，放慢
                "slow_down" -> interval += SLOW_DOWN_STEP_SECONDS
                // 用户点了拒绝
                "access_denied" -> throw AuthException(ERROR_DENIED)
                // 设备码过期
                "expired_token" -> throw AuthException(ERROR_EXPIRED)
                // client_id 不对、没开 Device Flow 等
                else -> {
                    Log.w(TAG, "轮询返回未知结果：$json")
                    throw AuthException(ERROR_INVALID)
                }
            }
        }

        throw AuthException(ERROR_EXPIRED)
    }

    /** 用户点了取消：让轮询循环尽快退出 */
    fun cancel() {
        polling = false
    }

    // -----------------------------------------------------------------------
    // ③ 读账号信息
    // -----------------------------------------------------------------------

    /**
     * `GET /user`。失败不抛异常 —— 登录本身已经成功，
     * 拿不到资料只是个人页显示不全，不该让用户重登。
     */
    private fun fetchAccount(token: String): Account {
        val fallback = Account(login = "", name = "", avatarUrl = "", id = 0L, token = token)

        return try {
            val connection = (URL(USER_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("User-Agent", USER_AGENT)
            }

            try {
                if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                    Log.w(TAG, "读取账号信息失败：HTTP ${connection.responseCode}")
                    return fallback
                }
                val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                val login = json.optString("login")
                Account(
                    login = login,
                    // name 可能为 null，退回 login
                    name = json.optString("name").ifBlank { login },
                    avatarUrl = json.optString("avatar_url"),
                    /*
                      `id` 是 GitHub 给的数字账号 ID，一经分配永不变
                      （改名、改邮箱都不影响）—— 账户页显示它，
                      用户能据此确认「确实是这个账号」。
                    */
                    id = json.optLong("id", 0L),
                    token = token,
                )
            } finally {
                connection.disconnect()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "读取账号信息出错", t)
            fallback
        }
    }

    // -----------------------------------------------------------------------
    // HTTP
    // -----------------------------------------------------------------------

    /**
     * 向 GitHub 发一个 `application/x-www-form-urlencoded` POST，返回解析后的 JSON。
     *
     * ⚠️ 必须显式设 `Accept: application/json`。不设的话 GitHub 返回 form-urlencoded，
     *    `JSONObject` 会直接抛异常 —— 这是本流程最容易踩的坑。
     *
     * 失败时（HTTP 非 200）抛 [AuthException]；GitHub 的错误响应体里通常带 `error` 字段，
     * 这里也一并读出来当错误码用。
     */
    private fun postForm(url: String, fields: Map<String, String>): JSONObject {
        val body = fields.entries.joinToString("&") { (key, value) ->
            URLEncoder.encode(key, "UTF-8") + "=" + URLEncoder.encode(value, "UTF-8")
        }.toByteArray(Charsets.UTF_8)

        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            setRequestProperty("Content-Length", body.size.toString())
            setRequestProperty("User-Agent", USER_AGENT)
        }

        try {
            connection.outputStream.use { it.write(body) }

            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()

            if (text.isBlank()) {
                if (code in 200..299) {
                    throw AuthException(ERROR_INVALID)
                }
                Log.w(TAG, "GitHub 返回 $code 且无内容")
                throw AuthException(if (code == 403) ERROR_INVALID else ERROR_NETWORK)
            }

            val json = try {
                JSONObject(text)
            } catch (t: Throwable) {
                Log.w(TAG, "响应不是 JSON：$text")
                throw AuthException(ERROR_INVALID)
            }

            // 403 通常意味着 OAuth App 没勾 Enable Device Flow
            if (code == HttpURLConnection.HTTP_FORBIDDEN) {
                Log.w(TAG, "403 —— 检查 OAuth App 是否已启用 Device Flow")
                throw AuthException(ERROR_INVALID)
            }
            return json
        } catch (e: AuthException) {
            throw e
        } catch (e: IOException) {
            throw AuthException(ERROR_NETWORK)
        } finally {
            connection.disconnect()
        }
    }

    /** 把用户码复制到剪贴板（用户要去浏览器里输入它） */
    fun verificationUriFor(device: DeviceCode): Uri = Uri.parse(device.verificationUri)
}
