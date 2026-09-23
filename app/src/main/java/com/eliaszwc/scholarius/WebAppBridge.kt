package com.eliaszwc.scholarius

import android.webkit.JavascriptInterface

/**
 * 暴露给网页的原生接口，名字必须是 `ScholariusNative`
 * （见 [MainActivity.JS_BRIDGE_NAME]，网页里用 `window.ScholariusNative` 调用）。
 *
 * ⚠️ 所有回调都在 WebView 的 JS 线程上被触发，Android UI 操作必须自己切回主线程。
 *
 * 说明：**access token 不在这里暴露给网页**。网页只能拿到
 * 「是否已登录 / 用户名 / 头像」这类展示信息；token 全程留在原生层，
 * 需要调 GitHub API 时由原生代劳。明文 token 绝不能进 localStorage。
 */
class WebAppBridge(
    private val onThemeMode: (String) -> Unit,
    private val onOpenExternal: (String) -> Unit,
    private val onFinishSplash: () -> Unit,
    // --- 登录 ---
    private val onStartLogin: () -> Unit,
    private val onCancelLogin: () -> Unit,
    private val onSignOut: () -> Unit,
    // --- 更新 ---
    private val onCheckUpdate: () -> Unit,
    private val onDownloadUpdate: () -> Unit,
    private val onInstallUpdate: () -> Unit,
    private val onCloseUpdate: () -> Unit,
) {

    /** 网页切换主题后通知原生（`light` / `dark` / `system`） */
    @JavascriptInterface
    fun setThemeMode(mode: String) {
        onThemeMode(mode)
    }

    /** 用系统浏览器打开外部链接 */
    @JavascriptInterface
    fun openExternal(url: String) {
        onOpenExternal(url)
    }

    /** 网页的启动动画演完了，可以把窗口外观切回正常主题了 */
    @JavascriptInterface
    fun finishSplash() {
        onFinishSplash()
    }

    // -----------------------------------------------------------------------
    // 登录
    // -----------------------------------------------------------------------

    /** 开始 Device Flow：原生去申请设备码，拿到后回调 onLoginCode() */
    @JavascriptInterface
    fun startLogin() {
        onStartLogin()
    }

    /** 用户在登录页点了取消，停止轮询 */
    @JavascriptInterface
    fun cancelLogin() {
        onCancelLogin()
    }

    /**
     * 退出登录。只清凭据，**不动**阅读数据
     * （用户 2026-09-23 裁决：只清 token，保留本地数据）。
     */
    @JavascriptInterface
    fun signOut() {
        onSignOut()
    }

    // -----------------------------------------------------------------------
    // 更新
    // -----------------------------------------------------------------------

    /** 用户在设置里手动点了「检查更新」 */
    @JavascriptInterface
    fun checkUpdate() {
        onCheckUpdate()
    }

    @JavascriptInterface
    fun downloadUpdate() {
        onDownloadUpdate()
    }

    /** 包已下好，重试安装 */
    @JavascriptInterface
    fun installUpdate() {
        onInstallUpdate()
    }

    /** 弹窗被关掉，原生可以重置「本次进入已检查过」的状态 */
    @JavascriptInterface
    fun closeUpdate() {
        onCloseUpdate()
    }
}
