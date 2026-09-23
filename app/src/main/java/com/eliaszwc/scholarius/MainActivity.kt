package com.eliaszwc.scholarius

import android.annotation.SuppressLint
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.addCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import kotlin.math.roundToInt

/**
 * Scholarius 的网页套壳容器。
 *
 * 网页资源位于 `assets/www/`，通过 [WebViewAssetLoader] 以 https 源
 * `https://appassets.androidplatform.net/assets/www/` 提供，这样 localStorage
 * 等 Web API 可以正常工作（直接用 `file://` 会有诸多限制）。
 *
 * 与 Livolog 的差异（v0.0.1）：暂不含 CSV 落盘、应用内更新、崩溃诊断 —— 这些在后续版本按需补。
 */class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    /**
     * 布局根视图。必须存成字段，并且**不能叫 rootView**：
     * - 在 `with(webView) { ... }` 作用域里写 `findViewById(...)` 会被解析成
     *   `webView.findViewById(...)`，从 WebView 往下找是找不到父级的根视图的；
     * - `View` 有 `getRootView()`，Kotlin 会暴露成合成属性 `rootView`，同名字段会被遮蔽。
     */
    private lateinit var layoutRoot: View

    /** 应用内主题设置：`light` / `dark` / `system`。与网页端 localStorage 保持同步。 */
    private var themeMode: String = THEME_SYSTEM

    /** 页面加载完成前不往网页里注入脚本 */
    private var pageReady = false

    /**
     * 网页的启动动画还在演（或还没结束）时为 true。
     * 这段时间窗口底色与系统栏图标一律按「品牌黑」处理，等网页通知再切回主题色，
     * 否则白天主题下会在黑色启动页上面看到一排深色状态栏图标。
     */
    private var splashActive = true

    /** 登录凭据（加密存储）。token 只在原生层流转，不进网页 */
    private val auth by lazy { AuthStore(this) }

    /** 本次进入前台是否已经查过更新（GitHub 未登录 API 限额 60 次/小时） */
    private var updateChecked = false

    /** 更新弹窗流程进行中：这时候不要再重复检查 */
    private var updateFlowActive = false

    /** 弹窗里当前讨论的那个版本，下载时要用 */
    private var pendingRelease: Updater.Release? = null

    private val assetLoader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // 接管系统启动页：主题里指定的纯黑底 + 全透明图标会在第一帧后自动退场，
        // 紧接着交给网页里的启动动画。必须在 super.onCreate 之前调用。
        installSplashScreen()
        super.onCreate(savedInstanceState)

        // 网页一直没就绪的话不能无限黑屏，兜一个上限
        window.decorView.postDelayed({
            if (splashActive) finishSplash()
        }, SPLASH_TIMEOUT_MS)

        startApp()
    }

    private fun startApp() {
        themeMode = readThemeMode()

        // 全屏内容；系统栏要让开多少交给网页自己决定（targetSdk 35 起系统强制 edge-to-edge）
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        applyTheme()

        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web_view)
        configureWebView()

        // 后台久置被系统回收后重建 Activity 时，WebView 想把「旧状态」恢复回来，
        // 但渲染进程已经没了，恢复出来就是一片空白（用户看到的白屏）。
        // 我们的数据在 localStorage / 本地文件里，网页载入后自己会同步，
        // 所以这里一律重新加载入口页，不依赖 WebView 的状态恢复。
        loadEntry()

        // WebView 铺满整屏（包括状态栏与系统导航条区域），使遮罩、弹窗能盖住整屏
        layoutRoot = findViewById(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(layoutRoot) { _, insets ->
            pushInsetsToWeb(insets)
            insets
        }

        // 返回键优先让网页回退历史
        onBackPressedDispatcher.addCallback(this) {
            if (::webView.isInitialized && webView.canGoBack()) {
                webView.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }
    }

    /** 加载入口页 */
    private fun loadEntry() {
        if (!::webView.isInitialized) return
        pageReady = false
        try {
            webView.loadUrl(WEB_ENTRY_URL)
        } catch (t: Throwable) {
            Log.w(TAG, "加载入口页失败", t)
        }
    }

    /**
     * 渲染进程被系统回收后，旧 WebView 已经彻底不可用，只能整只换掉。
     * 后台久置回来白屏就是这件事 —— 不重建的话页面永远不会再出来。
     */
    private fun rebuildWebView() {
        if (!::webView.isInitialized) return

        val parent = webView.parent as? ViewGroup
        val params = webView.layoutParams
        if (parent != null) {
            parent.removeView(webView)
        }
        webView.destroy()

        webView = WebView(this)
        if (params != null) {
            webView.layoutParams = params
        } else {
            webView.layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        parent?.addView(webView)

        configureWebView()
        loadEntry()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() = with(webView) {
        setBackgroundColor(Color.TRANSPARENT)
        isLongClickable = false
        setOnLongClickListener { true }
        addJavascriptInterface(
            WebAppBridge(
                onThemeMode = { mode -> runOnUiThread { setThemeMode(mode) } },
                onOpenExternal = { url -> runOnUiThread { openExternally(url) } },
                onFinishSplash = { runOnUiThread { finishSplash() } },
                onStartLogin = { runOnUiThread { startLogin() } },
                onCancelLogin = { GitHubAuth.cancel() },
                onSignOut = { runOnUiThread { signOut() } },
                onCheckUpdate = { runOnUiThread { checkUpdateManually() } },
                onDownloadUpdate = { runOnUiThread { startUpdateDownload() } },
                onInstallUpdate = { runOnUiThread { installDownloaded() } },
                onCloseUpdate = { runOnUiThread { closeUpdateFlow() } },
            ),
            JS_BRIDGE_NAME,
        )

        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // 只加载应用内置资源，关闭本地文件与内容提供器访问
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = true
            textZoom = 100
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }

        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                // 站内（appassets 域名）导航留在 WebView 内
                if (url.host == APP_ASSETS_HOST) return false
                return openExternally(url.toString())
            }

            override fun onPageFinished(view: WebView, url: String?) {
                pageReady = true
                pushVersionToWeb()
                pushAccountToWeb()
                if (::layoutRoot.isInitialized) {
                    ViewCompat.requestApplyInsets(layoutRoot)
                }
                // 首次进入时 onResume 可能比页面更早就跑完了，这里补一次
                maybeCheckUpdate()
            }

            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail?,
            ): Boolean {
                // 后台久置很常见：系统把 WebView 的渲染进程回收了。
                // 旧 WebView 已经不可用（继续用就是一片空白），必须整只换掉；
                // 返回 true 表示「我自己处理」，否则系统会连 app 进程一起杀掉。
                Log.w(TAG, "WebView 渲染进程退出（didCrash=${detail?.didCrash()}），重建 WebView")
                rebuildWebView()
                return true
            }
        }
    }

    /**
     * 把系统栏与输入法尺寸按 dp 推给网页（CSS 像素即 dp）。
     * 网页用它给内容让位；键盘高度单独给，好让表单整体上移。
     */
    private fun pushInsetsToWeb(insets: WindowInsetsCompat) {
        val bars = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom

        evaluateInWeb(
            "window.ScholariusShell && window.ScholariusShell.setInsets(" +
                "${toDp(bars.top)}, ${toDp(bars.right)}, ${toDp(bars.bottom)}, " +
                "${toDp(bars.left)}, ${toDp(keyboard)});"
        )
    }

    /** 版本号只在 build.gradle.kts 里维护，这里读系统的值传给网页显示 */
    private fun pushVersionToWeb() {
        val info = try {
            packageManager.getPackageInfo(packageName, 0)
        } catch (_: Exception) {
            return
        }

        val name = info.versionName ?: return
        val code = PackageInfoCompat.getLongVersionCode(info)
        evaluateInWeb("window.ScholariusShell && window.ScholariusShell.setVersion(\"$name\", $code);")
    }

    // -----------------------------------------------------------------------
    // 登录（GitHub Device Flow）
    // -----------------------------------------------------------------------

    /**
     * 把登录状态推给网页。只推**展示信息**，token 不跨层。
     *
     * 网页拿到后决定进哪个界面：
     *   signedIn=true  → 直接进应用
     *   signedIn=false → 去登录页（强制登录，无跳过）
     */
    private fun pushAccountToWeb() {
        val signedIn = auth.isSignedIn
        evaluateInWeb(
            "window.ScholariusShell && window.ScholariusShell.setAccount(" +
                "$signedIn, " +
                "${quote(auth.login)}, " +
                "${quote(auth.name)}, " +
                "${quote(auth.avatarUrl)});"
        )
    }

    /** 开始 Device Flow：申请设备码，拿到后交给网页显示 */
    private fun startLogin() {
        if (BuildConfig.GITHUB_CLIENT_ID.isBlank()) {
            Log.e(TAG, "GITHUB_CLIENT_ID 为空，检查 gradle.properties")
            evaluateInWeb(
                "window.ScholariusShell && window.ScholariusShell.onLoginFailed(\"invalid\");"
            )
            return
        }

        GitHubAuth.requestDeviceCode { device, error ->
            if (device == null) {
                evaluateInWeb(
                    "window.ScholariusShell && window.ScholariusShell.onLoginFailed(" +
                        "${quote(error ?: GitHubAuth.ERROR_UNKNOWN)});"
                )
                return@requestDeviceCode
            }

            // 把 user_code 显示给用户，并自动打开浏览器让他去输
            evaluateInWeb(
                "window.ScholariusShell && window.ScholariusShell.onLoginCode(" +
                    "${quote(device.userCode)}, " +
                    "${quote(device.verificationUri)}, " +
                    "${device.expiresInSeconds});"
            )
            openExternally(device.verificationUri)

            GitHubAuth.pollForToken(
                deviceCode = device,
                onUpdated = { waited ->
                    evaluateInWeb(
                        "window.ScholariusShell && window.ScholariusShell.onLoginWaiting($waited);"
                    )
                },
                onResult = { account, pollError ->
                    if (account == null) {
                        evaluateInWeb(
                            "window.ScholariusShell && window.ScholariusShell.onLoginFailed(" +
                                "${quote(pollError ?: GitHubAuth.ERROR_UNKNOWN)});"
                        )
                        return@pollForToken
                    }

                    auth.save(account)
                    Log.i(TAG, "已登录：${account.login}")
                    pushAccountToWeb()
                },
            )
        }
    }

    /**
     * 退出登录。只清凭据，**不动**阅读数据。
     *
     * 先让 GitHub 那边撤销 token 更好，但那需要 Basic Auth（client_id + secret），
     * Device Flow 拿不到 secret —— 所以这里只能删本地凭据。
     * 用户想彻底撤销授权得去 GitHub 网站删（设置页里会提示他）。
     */
    private fun signOut() {
        GitHubAuth.cancel()
        auth.clear()
        Log.i(TAG, "已退出登录")
        pushAccountToWeb()
    }

    // -----------------------------------------------------------------------
    // 应用内更新
    // -----------------------------------------------------------------------

    /** 用户主动点「检查更新」：忽略「本次已查过」的限制 */
    private fun checkUpdateManually() {
        updateChecked = true
        runUpdateCheck(notifyWhenUpToDate = true)
    }

    /** 进入前台时自动查一次（每次进入只查一次，省 API 限额） */
    private fun maybeCheckUpdate() {
        if (updateChecked || updateFlowActive || !pageReady) return
        updateChecked = true
        runUpdateCheck(notifyWhenUpToDate = false)
    }

    private fun runUpdateCheck(notifyWhenUpToDate: Boolean) {
        val installedNow = Updater.installedVersionName(this)

        Updater.check(this) { release ->
            if (release == null) {
                if (notifyWhenUpToDate) {
                    evaluateInWeb(
                        "window.ScholariusShell && window.ScholariusShell.onUpdateNone();"
                    )
                }
                return@check
            }
            if (updateFlowActive) return@check

            updateFlowActive = true
            pendingRelease = release

            /*
              上次拉起安装器后如果没装成（用户没点「安装」），下次进来会再次看到
              同一个新版。把当时的情况一起推过去，弹窗上多一句提示 —— 用户多半是
              没给「安装未知应用」权限。
             */
            val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            val attemptedVersion = prefs.getString(KEY_PENDING_UPDATE, null)
            val attemptedFrom = prefs.getString(KEY_PENDING_UPDATE_FROM, null)
            val stalled = attemptedVersion != null &&
                attemptedVersion == release.version &&
                attemptedFrom == installedNow
            prefs.edit().remove(KEY_PENDING_UPDATE).remove(KEY_PENDING_UPDATE_FROM).apply()

            evaluateInWeb(
                "window.ScholariusShell && window.ScholariusShell.onUpdateAvailable(" +
                    "${quote(release.version)}, " +
                    "${quote(installedNow ?: "")}, " +
                    "${quote(Updater.formatSize(release.size))}, " +
                    "$stalled);"
            )
        }
    }

    private fun startUpdateDownload() {
        val release = pendingRelease ?: return

        Updater.download(
            context = this,
            release = release,
            onProgress = { percent ->
                evaluateInWeb(
                    "window.ScholariusShell && window.ScholariusShell.onUpdateProgress($percent);"
                )
            },
            onDone = { file, error ->
                updateFlowActive = false
                if (file == null) {
                    notifyUpdateFailed(error ?: Updater.ERROR_NETWORK, downloaded = false)
                    return@download
                }
                installApk(file)
            },
        )
    }

    /** 包已经下好了，重试安装（上次可能是权限没给） */
    private fun installDownloaded() {
        val release = pendingRelease ?: return
        val apk = File(File(cacheDir, UPDATE_DIR), safeDirName(release.version))
            .resolve("scholarius.apk")
        installApk(apk)
    }

    private fun installApk(apk: File) {
        val error = Updater.install(this, apk)
        val release = pendingRelease

        if (error != null) {
            notifyUpdateFailed(error, downloaded = true)
            return
        }

        // 记下「这次尝试装的是哪个版本、从哪个版本升上来」，
        // 下次进来如果版本没变，就知道上次安装没成
        if (release != null) {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                .putString(KEY_PENDING_UPDATE, release.version)
                .putString(
                    KEY_PENDING_UPDATE_FROM,
                    Updater.installedVersionName(this),
                )
                .apply()
        }

        updateFlowActive = false
        evaluateInWeb("window.ScholariusShell && window.ScholariusShell.onUpdateReady();")
    }

    private fun notifyUpdateFailed(reason: String, downloaded: Boolean) {
        evaluateInWeb(
            "window.ScholariusShell && window.ScholariusShell.onUpdateFailed(" +
                "${quote(reason)}, $downloaded);"
        )
    }

    private fun closeUpdateFlow() {
        updateFlowActive = false
        pendingRelease = null
    }

    private fun safeDirName(version: String): String =
        version.replace(Regex("[^0-9A-Za-z._-]"), "_")

    // -----------------------------------------------------------------------

    /** Kotlin 字符串 → JS 字符串字面量（转义引号与反斜杠，防注入） */
    private fun quote(value: String?): String {
        if (value == null) return "null"
        val escaped = value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        return "\"$escaped\""
    }

    /** 在网页执行一小段脚本；页面没就绪时直接忽略 */
    private fun evaluateInWeb(script: String) {
        if (!::webView.isInitialized || !pageReady) return
        try {
            webView.evaluateJavascript(script, null)
        } catch (t: Throwable) {
            Log.w(TAG, "注入脚本失败", t)
        }
    }

    /** 用系统浏览器打开外部链接（站内导航不走这里） */
    private fun openExternally(url: String): Boolean = try {
        startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url)))
        true
    } catch (t: Throwable) {
        Log.w(TAG, "打开外部链接失败：$url", t)
        false
    }

    private fun toDp(px: Int): Int = (px / resources.displayMetrics.density).roundToInt()

    // -----------------------------------------------------------------------
    // 主题
    // -----------------------------------------------------------------------

    private fun readThemeMode(): String =
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getString(KEY_THEME_MODE, THEME_SYSTEM)
            ?.takeIf { it in THEME_MODES }
            ?: THEME_SYSTEM

    private fun isDarkAppearance(): Boolean = when (themeMode) {
        THEME_LIGHT -> false
        THEME_DARK -> true
        else -> (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
    }

    /** 把当前主题落到窗口背景与状态栏／导航栏图标颜色上 */
    private fun applyTheme() {
        // 启动动画还在演：先维持品牌黑，免得黑色启动页上出现浅色底 + 深色图标
        if (splashActive) {
            applySplashAppearance()
            return
        }

        val dark = isDarkAppearance()
        try {
            window.setBackgroundDrawableResource(
                if (dark) R.color.app_background_dark else R.color.app_background_light
            )
            WindowInsetsControllerCompat(window, window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        } catch (t: Throwable) {
            // 纯外观问题，绝不能因此崩溃
            Log.w(TAG, "应用主题失败", t)
        }
    }

    /** 启动动画期间的外观：与桌面图标一样的品牌黑 + 浅色系统栏图标 */
    private fun applySplashAppearance() {
        try {
            window.setBackgroundDrawableResource(R.color.ic_launcher_background)
            WindowInsetsControllerCompat(window, window.decorView).apply {
                isAppearanceLightStatusBars = false
                isAppearanceLightNavigationBars = false
            }
        } catch (t: Throwable) {
            Log.w(TAG, "应用启动页外观失败", t)
        }
    }

    /** 网页的启动动画演完了，把外观切回正常主题 */
    private fun finishSplash() {
        if (!splashActive) return
        splashActive = false
        applyTheme()
    }

    private fun setThemeMode(mode: String) {
        val normalized = if (mode in THEME_MODES) mode else THEME_SYSTEM
        if (normalized == themeMode) return

        themeMode = normalized
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putString(KEY_THEME_MODE, themeMode)
            .apply()
        applyTheme()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 「跟随系统」时系统深浅色切换需要重新解析
        applyTheme()
    }

    override fun onResume() {
        super.onResume()

        /*
          每次回到前台重置「已查过」的标记，然后重查一次。
          为什么必须重置：用户可能刚从安装器回来（装完新版 → 版本变了要重查），
          也可能刚在系统设置里给了「安装未知应用」权限（要能重试安装）。
          为什么重置了还不会刷爆 API：一次前台只查一次 —— maybeCheckUpdate()
          自己会立刻把标记置回 true。
        */
        if (!updateFlowActive) {
            updateChecked = false
        }
        maybeCheckUpdate()
    }

    override fun onDestroy() {
        // 页面销毁时停掉轮询，否则后台线程还在打 GitHub API
        GitHubAuth.cancel()
        if (::webView.isInitialized) {
            webView.destroy()
        }
        super.onDestroy()
    }

    private companion object {
        const val TAG = "Scholarius"

        const val APP_ASSETS_HOST = "appassets.androidplatform.net"
        const val WEB_ENTRY_URL = "https://appassets.androidplatform.net/assets/www/index.html"

        const val JS_BRIDGE_NAME = "ScholariusNative"

        /** 网页一直没通知启动动画结束时的兜底时长（网页那边约 2.2s） */
        const val SPLASH_TIMEOUT_MS = 4000L

        const val PREFS_NAME = "scholarius"
        const val KEY_THEME_MODE = "theme_mode"

        const val THEME_LIGHT = "light"
        const val THEME_DARK = "dark"
        const val THEME_SYSTEM = "system"
        val THEME_MODES = setOf(THEME_LIGHT, THEME_DARK, THEME_SYSTEM)

        /** 下载好的更新包放在 cacheDir/update/<version>/ */
        const val UPDATE_DIR = "update"

        /** 上次尝试安装的版本号，用来判断「装完没生效」 */
        const val KEY_PENDING_UPDATE = "pending_update_version"
        const val KEY_PENDING_UPDATE_FROM = "pending_update_from"
    }
}
