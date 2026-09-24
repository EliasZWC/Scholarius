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
    /** 打开 Device Flow 授权页：优先 GitHub App，其次浏览器 */
    private val onOpenVerification: (String) -> Unit,
    // --- 更新 ---
    private val onCheckUpdate: () -> Unit,
    private val onDownloadUpdate: () -> Unit,
    private val onInstallUpdate: () -> Unit,
    private val onCloseUpdate: () -> Unit,
    // --- 文献库 ---
    /** 取某篇文献的缩略图（base64 data URL）。**同步返回**，网页需要立即渲染 */
    private val onGetThumbnail: (String) -> String,
    /** 删除文献（支持批量） */
    private val onDeleteDocs: (List<String>) -> Unit,
    /** 刷新文献列表（网页主动拉一次） */
    private val onRequestLibrary: () -> Unit,
    /** 请求某篇文献的正文文本（阅读页用） */
    private val onRequestDocText: (String) -> Unit,
    /**
     * 把某篇文献的 PDF 装入 WebView（原始视图）。
     *
     * ⚠️ 为什么是「原生接管」而不是网页里 iframe：
     *    Android WebView 的内置 PDF 查看器只为**顶层文档**工作，
     *    塞进子框架（iframe）会是空白。所以网页只能把 id 交上来，
     *    由原生做一次顶层 loadUrl。
     */
    private val onOpenRawPdf: (String) -> Unit,
    /**
     * 改文献元数据。
     *
     * ⚠️ 第二个参数是 **JSON 对象字符串**（形如 `{"year":"2015"}`），
     *    不是若干个具名参数 —— 字段集合会随版本增长，
     *    固定参数签名意味着每加一个字段都要改桥。
     */
    private val onUpdateDoc: (String, String) -> Unit,
    // --- 临时诊断（v0.0.6，定位完删）---
    private val onTrace: (String) -> Unit,
) {

    /**
     * ⚠️ 临时诊断接口（v0.0.6）：把网页侧的启动时序送到 logcat。
     * 真机上「启动页一闪而过」在桌面浏览器复现不出来，只能靠现场数据定位。
     * 定位完连同 app.js 里的 `trace()` 一起删掉。
     */
    @JavascriptInterface
    fun trace(message: String) {
        onTrace(message)
    }

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

    /**
     * 打开 Device Flow 授权页。
     *
     * ⚠️ 与 [openExternal] 的区别：这个**优先拉起 GitHub App**，
     *    拉不起来才退回浏览器。
     *    网页层不能自己决定用哪个 —— 包可见性、setPackage、深链格式
     *    都只有原生才知道。
     */
    @JavascriptInterface
    fun openVerification(url: String) {
        onOpenVerification(url)
    }

    /** 网页的启动动画演完了，可以把窗口外观切回正常主题了 */
    @JavascriptInterface
    fun finishSplash() {
        onFinishSplash()
    }

    // -----------------------------------------------------------------------
    // 文献库
    // -----------------------------------------------------------------------

    /**
     * 取某篇文献的缩略图，返回 `data:image/png;base64,...`。
     *
     * ⚠️ 这是**同步返回**的：网页 `img.src = ... ` 需要立即拿到值，
     *    走异步回调（原生推过去）会导致图片先空后闪，也会让代码变复杂。
     *    缩略图只有几十 KB，同步读一次可接受。
     *    没有缩略图时返回空串，网页显示占位图。
     */
    @JavascriptInterface
    fun getThumbnail(id: String): String = onGetThumbnail(id)

    /** 删除若干文献（长按菜单 / 批量删除用） */
    @JavascriptInterface
    fun deleteDocs(idsJson: String) {
        onDeleteDocs(parseIdArray(idsJson))
    }

    /**
     * 改文献的元数据。
     *
     * ⚠️ 用 **JSON 对象字符串**而不是固定参数。
     *
     *    原签名是 `(id, title, author, venue)` —— 只够改三样。
     *    详情页要编辑二十多个字段（卷/期/页码/DOI/ISBN/学位类型…），
     *    每加一个就改一次桥签名，前后端很容易错位。
     *
     *    现在语义与 `LibraryStore.update` 的 Map 一致：
     *      · 出现的键 → 写成该值
     *      · 值为空串 → 清空
     *      · 没出现的键 → 保持原值
     *    所以**加字段不用动原生代码**。
     *
     * @param patchJson 如 `{"title":"…","year":"2015","doi":"…"}`
     */
    @JavascriptInterface
    fun updateDoc(id: String, patchJson: String) {
        onUpdateDoc(id, patchJson)
    }

    /** 网页主动拉一次文献列表（比如从别的页面回到文库时） */
    @JavascriptInterface
    fun requestLibrary() {
        onRequestLibrary()
    }

    /**
     * 请求某篇文献的正文文本。
     *
     * ⚠️ 异步入参 —— 提取要解压并扫描整个 PDF，可能几百毫秒到几秒。
     *    本方法立即返回，结果由原生调
     *    `ScholariusShell.readerText(id, text)` 推回。
     *    同步返回会让 WebView 的 JavaBridge 线程堵住，界面卡死。
     */
    @JavascriptInterface
    fun requestDocText(id: String) {
        onRequestDocText(id)
    }

    /**
     * 把某篇文献的 PDF 装入 WebView（阅读页的「原始视图」）。
     *
     * ⚠️ 只传 id，**不传 URL** —— URL 的拼法（主机名、`/pdf/` 前缀）
     *    是原生侧知识，让网页自己拼等于把它复制两份。
     *
     * ⚠️ 这是**顶层导航**，调用后网页就不再是当前文档了。
     *    回到网页由原生处理（见 MainActivity 的返回键逻辑）：
     *    PDF 查看器里按返回 → 原生 goBack() 回网页 → 再按才关阅读页。
     */
    @JavascriptInterface
    fun openRawPdf(id: String) {
        onOpenRawPdf(id)
    }

    /** 把 JSON 数组字符串解成 id 列表；解析失败返回空列表 */
    private fun parseIdArray(json: String): List<String> = try {
        val array = org.json.JSONArray(json)
        (0 until array.length()).mapNotNull { array.optString(it).takeIf { s -> s.isNotEmpty() } }
    } catch (t: Throwable) {
        emptyList()
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
