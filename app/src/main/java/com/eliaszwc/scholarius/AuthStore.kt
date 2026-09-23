package com.eliaszwc.scholarius

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 登录凭据的本地存储。
 *
 * 用 [EncryptedSharedPreferences]（AES256-GCM，主密钥放在 Android Keystore 里）
 * 而不是普通 SharedPreferences —— access token 等价于账号密码，
 * 拿到它就能读写用户的所有仓库。
 *
 * ⚠️ 明文 token 绝不能进 localStorage。网页层只能通过原生接口拿到
 *    「已登录 / 用户名 / 头像」这类展示信息，token 本身不跨层。
 *
 * 退出登录只清这里，**不动**阅读数据（用户 2026-09-23 裁决）。
 */
class AuthStore(context: Context) {

    private val prefs: SharedPreferences = createPrefs(context.applicationContext)

    private fun createPrefs(appContext: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(appContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()

            EncryptedSharedPreferences.create(
                appContext,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (t: Throwable) {
            /*
               Keystore 在极少数设备上会坏掉（刷机、恢复出厂后残留）。
              这时不能直接崩 —— 退回普通存储会让 token 明文落盘，
              所以改为「本次会话不落盘」：功能可用，但重启后要重新登录。
               这是刻意的取舍：宁可让用户重登，也不明文存 token。
             */
            Log.w(TAG, "无法启用加密存储，本次会话不持久化登录状态", t)
            appContext.getSharedPreferences(PREFS_NAME + "_volatile", Context.MODE_PRIVATE)
                .also { volatilePrefs = it }
        }
    }

    /** 加密存储不可用时的兜底容器（同样是 SharedPreferences，但由 volatile 标记决定不写入） */
    private var volatilePrefs: SharedPreferences? = null

    val isEncryptionAvailable: Boolean
        get() = volatilePrefs == null

    val isSignedIn: Boolean
        get() = !token.isNullOrEmpty()

    var token: String?
        get() = read(KEY_TOKEN)
        set(value) {
            if (volatilePrefs != null) {
                // 加密不可用：只在内存里留（进程被杀就没了），绝不落盘
                Log.w(TAG, "加密存储不可用，token 不落盘")
                return
            }
            write(KEY_TOKEN, value)
        }

    var login: String?
        get() = read(KEY_LOGIN)
        set(value) = write(KEY_LOGIN, value)

    var name: String?
        get() = read(KEY_NAME)
        set(value) = write(KEY_NAME, value)

    var avatarUrl: String?
        get() = read(KEY_AVATAR)
        set(value) = write(KEY_AVATAR, value)

    /**
     * GitHub 数字账号 ID。以字符串存 —— 老的 SharedPreferences 只有字符串读写，
     * 为一个字段另开一套 int 存取不划算；读的时候转回 Long。
     */
    var accountId: Long
        get() = read(KEY_ACCOUNT_ID)?.toLongOrNull() ?: 0L
        set(value) = write(KEY_ACCOUNT_ID, if (value > 0) value.toString() else null)

    /** 一次写入全部账号信息 */
    fun save(account: GitHubAuth.Account) {
        token = account.token
        login = account.login
        name = account.name
        avatarUrl = account.avatarUrl
        accountId = account.id
    }

    /**
     * 退出登录：只清凭据。
     * ⚠️ 阅读数据（PDF / 标注）**不在这里清** —— 用户明确要求保留。
     */
    fun clear() {
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_LOGIN)
            .remove(KEY_NAME)
            .remove(KEY_AVATAR)
            .remove(KEY_ACCOUNT_ID)
            .apply()
    }

    private fun read(key: String): String? = prefs.getString(key, null)?.takeIf { it.isNotEmpty() }

    private fun write(key: String, value: String?) {
        prefs.edit().apply {
            if (value.isNullOrEmpty()) remove(key) else putString(key, value)
        }.apply()
    }

    companion object {
        private const val TAG = "Scholarius"
        private const val PREFS_NAME = "scholarius_auth"
        private const val KEY_TOKEN = "token"
        private const val KEY_LOGIN = "login"
        private const val KEY_NAME = "name"
        private const val KEY_AVATAR = "avatar_url"
        private const val KEY_ACCOUNT_ID = "account_id"
    }
}
