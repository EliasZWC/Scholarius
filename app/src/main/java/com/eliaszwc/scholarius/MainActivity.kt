package com.eliaszwc.scholarius

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.provider.OpenableColumns
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import kotlin.concurrent.thread
import kotlin.math.roundToInt

/**
 * Scholarius 的网页套壳容器。
 *
 * 网页资源位于 `assets/www/`，通过 [WebViewAssetLoader] 以 https 源
 * `https://appassets.androidplatform.net/assets/www/` 提供，这样 localStorage
 * 等 Web API 可以正常工作（直接用 `file://` 会有诸多限制）。
 *
 * 与 Livolog 的差异（v0.0.1）：暂不含 CSV 落盘、应用内更新、崩溃诊断 —— 这些在后续版本按需补。
 */
class MainActivity : AppCompatActivity() {

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
     * 返回键回调。保存引用是为了能临时启用/禁用 ——
     * 见 [passThroughBack] 对「一次置 false 就永久失效」的说明。
     */
    private var backCallback: OnBackPressedCallback? = null

    /**
     * 网页里 file input 的回调。必须持有到用户选完文件再交还，
     * 否则系统会因为回调被回收而不返回结果（表现为选完文件没反应）。
     */
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    /**
     * 文件选择器。用 Activity Result API 而不是 `onActivityResult` ——
     * 后者需要自己管理 requestCode，且在新版本已被废弃。
     */
    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = pendingFileCallback
        pendingFileCallback = null

        if (callback == null) {
            // 没有待处理的回调（理论上不该发生），忽略即可
            return@registerForActivityResult
        }

        val uri = result.data?.data
        if (result.resultCode != RESULT_OK || uri == null) {
            /*
              ⚠️ 用户取消时必须回调一个**空数组**，不能什么都不传也不回调 null。
                 `onReceiveValue(null)` 才能让网页的 change 事件正常收尾；
                 不回调会让网页永远等在那里（下次再选文件就失效了）。
            */
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }

        importPdf(uri, callback)
    }

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

    /**
     * 已经下好、等着安装的包。
     *
     * ⚠️ 必须缓存这个 `File` 对象本身，不能用版本号再拼一次路径。
     *    Updater 里的目录名是它自己 `safeFileName()` 换算出来的内部细节，
     *    在 MainActivity 里重新拼一遍等于把实现细节抄一遍 —— 两边一旦不同步，
     *    就会拿着一个不存在的 File 去拉起安装器，表现为「下载完却没反应」。
     */
    private var downloadedApk: File? = null

    /** 正在下载，防止连点「更新」重复下载 */
    private var downloading = false

    /**
     * 退到后台的时刻（`SystemClock.elapsedRealtime()`）。
     * 用于 `onResume` 判断离开多久，见那里对「updateFlowActive 死锁」的说明。
     */
    private var leftForegroundAt = 0L

    /**
     * 网页是否已经画出第一帧。
     *
     * ⚠️ 这是「启动页一闪而过」的关键开关，见 onCreate 里的
     *    `setKeepOnScreenCondition`。
     */
    private var webPainted = false

    private val assetLoader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        /*
          接管系统启动页。必须在 super.onCreate 之前调用。

          ⚠️⚠️ 这里必须接住返回值并调 setKeepOnScreenCondition ——
               这是「启动页一闪而过」的真正原因，之前一直漏了。

               系统 splash 的默认行为是**绘制完第一帧就立刻退场**。
               但第一帧画的是还没加载完的 WebView（空白），
               网页里的启动动画此时根本还没开始渲染 ——
               于是用户看到的是：黑屏一闪 → 直接就是登录页，
               中间那段网页启动动画被完全跳过。

               setKeepOnScreenCondition { !webPainted } 让系统 splash
               **一直留在屏幕上**，直到网页真正画出第一帧才交棒。
               这样「系统 splash → 网页 splash」是无缝的，
               网页动画 2.2s 完整可见。

          兜底：webPainted 由两条路置 true ——
            ① 网页画出第一帧（onPageCommitVisible，最准确）
            ② SPLASH_TIMEOUT_MS 超时（网页一直画不出来时不能无限黑屏）
        */
        val splashScreen = installSplashScreen()
        splashScreen.setKeepOnScreenCondition { !webPainted }
        super.onCreate(savedInstanceState)

        /*
          终极兜底：不管网页发生什么（加载失败、渲染进程崩、资源损坏），
          都必须在 SPLASH_TIMEOUT_MS 后放行系统启动页 ——
          否则用户会看到一个永远不走的黑屏，完全无法使用应用。
        */
        window.decorView.postDelayed({
            if (!webPainted) {
                Log.w(TAG, "[native] 网页首帧超时 ${SPLASH_TIMEOUT_MS}ms，强制放行系统启动页")
                webPainted = true
            }
            if (splashActive) {
                Log.i(TAG, "[native] splash 兜底超时 ${SPLASH_TIMEOUT_MS}ms，强制结束")
                finishSplash()
            }
        }, SPLASH_TIMEOUT_MS)

        startApp()
    }

    /** 标记网页已经出画面，系统启动页可以交棒了（幂等） */
    private fun markWebPainted(why: String) {
        if (webPainted) return
        webPainted = true
        Log.i(TAG, "[native] 交棒给网页启动动画（$why）")
    }

    /**
     * 执行一段「不该因为它自己出错而拖垮别人」的逻辑。
     *
     * 用在 onPageFinished 这类「一串互相独立的事」的地方：某一步失败
     * （典型是 EncryptedSharedPreferences 在覆盖安装后密钥失效）
     * 不能让后面的步骤被静默跳过。
     */
    private inline fun safely(what: String, block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            Log.w(TAG, "[native] $what 失败（已忽略，不影响其它步骤）", t)
        }
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

        /*
          ⚠️ 返回键：**先问网页有没有东西要关**，网页说没有才退出应用。
          （v0.0.30 改，之前是「WebView 有历史就回退，否则退出」）

          为什么原来的写法不成立：
            Scholarius 是**单页应用** —— 只有一个 index.html，
            所有界面（文库/榜单/个人页/账户详情/弹窗）都靠 JS 切换。
            因此 WebView 的历史栈里只有那一个条目，
            `canGoBack()` 永远是 false → 按返回键**直接退出应用**，
            即使屏幕上正开着一个全屏覆盖层。

          实现要点：判定结果要等网页异步回传，所以分两步走。
            ① 按键先拦下来，绝不立刻退出；
            ② 网页回话后，若它说「没东西可关」，再手动触发一次返回。

          ⚠️ 这里**不能**用 `isEnabled = false` 的写法。
             OnBackPressedCallback 一旦置 false 就永久失效，
             之后再也不会触发 —— 用户第一次在首页按返回时被放行，
             第二次按就完全没反应了。
             正确做法是把回调保存起来，用 isEnabled 做**一次性闸门**，
             放行后立刻恢复为 true，让下一次按键还能进来。
         */
        backCallback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!::webView.isInitialized || !pageReady) {
                    // 网页还没就绪：没有覆盖层可言，直接放行
                    passThroughBack()
                    return
                }

                webView.evaluateJavascript(
                    "(function(){try{" +
                        "return (window.Scholarius && window.Scholarius.handleBack)" +
                        " ? String(window.Scholarius.handleBack()) : 'false';" +
                        "}catch(e){return 'false';}})();"
                ) { result ->
                    val handled = result?.trim()?.trim('"') == "true"
                    if (!handled) {
                        debugLog("[back] web has nothing to close, exiting")
                        passThroughBack()
                    } else {
                        debugLog("[back] handled by web")
                    }
                }
            }
        }.also { onBackPressedDispatcher.addCallback(this, it) }
    }

    /**
     * 放行一次返回键：临时禁用自己，触发系统默认行为（退出），
     * 再把自己启用回来 —— 否则这个回调就永久失效了。
     */
    private fun passThroughBack() {
        val callback = backCallback ?: return
        callback.isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        callback.isEnabled = true
    }

    /** 加载入口页 */
    private fun loadEntry() {
        if (!::webView.isInitialized) return
        pageReady = false
        /*
          ⚠️ 不能在这里把 webPainted 置回 false。
          这个条件控制的是「**系统启动页**是否还在屏幕上」，
          而系统启动页只在冷启动那一刻存在一次。
          重建 WebView 时（后台被回收）系统启动页早就没了，
          置回 false 没有任何效果，只会让日志误导。
          所以 webPainted 只在冷启动路径上从 false 变 true，之后不再回退。
        */
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
                onOpenVerification = { url ->
                    debugLog("[login] web requested verification page: $url")
                    runOnUiThread { openDeviceVerification(url) }
                },
                onFinishSplash = { runOnUiThread { finishSplash() } },
                onStartLogin = { runOnUiThread { startLogin() } },
                onCancelLogin = { GitHubAuth.cancel() },
                onSignOut = { runOnUiThread { signOut() } },
                onCheckUpdate = { runOnUiThread { checkUpdateManually() } },
                onDownloadUpdate = { runOnUiThread { startUpdateDownload() } },
                onInstallUpdate = { runOnUiThread { installDownloaded() } },
                onCloseUpdate = { runOnUiThread { closeUpdateFlow() } },
                // --- 文献库 ---
                /*
                  ⚠️ getThumbnail 必须**同步**返回（网页 img.src 要立即拿到值），
                     所以不能包 runOnUiThread —— 它只是读一个文件，
                     而且 JavascriptInterface 的调用本身就在 WebView 的
                     JavaBridge 线程上，不阻塞主线程。
                */
                onGetThumbnail = { id -> thumbnailFor(id) },
                onDeleteDocs = { ids -> runOnUiThread { deleteDocs(ids) } },
                /*
                  ⚠️ patchJson 是一个 JSON 对象字符串，不是固定参数。
                     字段会随详情页增加，见 updateDoc 的注释。
                */
                onUpdateDoc = { id, patchJson ->
                    runOnUiThread { updateDoc(id, patchJson) }
                },
                onRequestLibrary = { runOnUiThread { pushLibraryToWeb() } },
                onRequestDocText = { id -> requestDocText(id) },
                onTrace = { message -> Log.i(TAG, "[web] $message") },
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

        /*
          文件选择器：`<input type="file">` 的点击会走这里。

          ⚠️ 不设置 WebChromeClient 时，网页里点 file input **毫无反应**
             （不报错、不弹窗），这是 WebView 的默认行为。
             导入 PDF 依赖它，所以必须补上。

          ⚠️ 用 `ACTION_OPEN_DOCUMENT`（SAF）而不是 `ACTION_GET_CONTENT`：
             SAF 是文档选择器、支持任意来源目录、给的是可持久化的 URI，
             且**不需要任何存储权限**。
        */
        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                // 上一次的请求还没结束就先取消，避免回调悬挂
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback

                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    // 只接受 PDF：
                    // 用 application/pdf 而不是通配类型，前者让系统只列出 PDF，
                    // 用户不会选错；后者要靠应用自己判断，体验差。
                    type = "application/pdf"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/pdf"))
                }

                return try {
                    filePickerLauncher.launch(intent)
                    true
                } catch (t: ActivityNotFoundException) {
                    Log.w(TAG, "系统没有文件选择器", t)
                    pendingFileCallback = null
                    false
                } catch (t: Throwable) {
                    Log.w(TAG, "打开文件选择器失败", t)
                    pendingFileCallback = null
                    false
                }
            }
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

            /**
             * 网页画出第一帧。
             *
             * ⚠️ 不能只依赖这一个回调。`onPageCommitVisible` 并非在所有情况
             *    下都会触发（WebView 版本、首次加载、渲染进程重建等），
             *    一旦不触发，`webPainted` 永不置 true，
             *    系统启动页就会**永远挡在最上层** —— 用户完全进不去应用。
             *
             *    所以这里只是「最早的交棒点」之一，还有：
             *      · onPageStarted（兜底，页面开始加载就放行）
             *      · onCreate 里的 4s 定时器（终极兜底）
             */
            override fun onPageCommitVisible(view: WebView, url: String?) {
                super.onPageCommitVisible(view, url)
                markWebPainted("onPageCommitVisible")
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                /*
                  兜底一：页面**开始**加载即标记。
                  比 onPageCommitVisible 早、且几乎一定触发 ——
                  宁可早一点露出（此时网页 splace 已在 DOM 里，
                  遮挡仍然连贯），也不能让系统启动页卡死。
                */
                markWebPainted("onPageStarted")
            }

            override fun onPageFinished(view: WebView, url: String?) {
                markWebPainted("onPageFinished")
                pageReady = true
                /*
                  ⚠️ 这三步必须**互相隔离**。

                  原来它们是顺序直调：pushVersionToWeb() → pushAccountToWeb()
                  → maybeCheckUpdate()。只要前面任一步抛异常
                  （比如覆盖安装后 EncryptedSharedPreferences 的密钥失效，
                  auth.isSignedIn 会抛），后台的 maybeCheckUpdate() 就永远不会执行 ——
                  表现就是「永远收不到更新通知」，而且没有任何错误提示。

                  各自 try 住，谁坏了都不影响另外两个。
                */
                safely("推送版本号") { pushVersionToWeb() }
                safely("推送账号") { pushAccountToWeb() }
                // 文献列表：本地数据，不依赖网络，但读文件可能失败，同样要隔离
                safely("推送文献库") { pushLibraryToWeb() }
                if (::layoutRoot.isInitialized) {
                    ViewCompat.requestApplyInsets(layoutRoot)
                }
                // 首次进入时 onResume 可能比页面更早就跑完了，这里补一次
                safely("检查更新") { maybeCheckUpdate() }
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
        /*
          ⚠️ token **不在这里** —— 网页只拿到展示用的四个字段。
          accountId 是数字，不能走 quote()（那会包成字符串），直接拼。
        */
        evaluateInWeb(
            "window.ScholariusShell && window.ScholariusShell.setAccount(" +
                "$signedIn, " +
                "${quote(auth.login)}, " +
                "${quote(auth.name)}, " +
                "${quote(auth.avatarUrl)}, " +
                "${auth.accountId});"
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

            // 把 user_code 显示给用户；跳转由用户在网页上点按钮触发
            debugLog("[login] user_code=${device.userCode} expires=${device.expiresInSeconds}s")

            evaluateInWeb(
                "window.ScholariusShell && window.ScholariusShell.onLoginCode(" +
                    "${quote(device.userCode)}, " +
                    "${quote(device.verificationUri)}, " +
                    "${device.expiresInSeconds});"
            )

            debugLog(
                "[login] polling started (interval=${device.intervalSeconds}s, " +
                    "expires=${device.expiresInSeconds}s)"
            )
            GitHubAuth.pollForToken(
                deviceCode = device,
                onUpdated = { waited ->
                    debugLog("[login] waited ${waited}s, still pending")
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
        /*
          ⚠️ 手动检查必须能突破 updateFlowActive 的死锁。

          为什么会有死锁：Updater.install() 返回 ERROR_PERMISSION（没给
          「安装未知应用」权限）时，我们把用户送去系统设置页，同时
          updateFlowActive 保持 true（弹窗还开着，等用户回来重试）。
          但如果用户从设置页回来后**没再点弹窗**、或者直接杀了 app 重进，
          这个 true 就再也没人清 —— 之后所有检查都被
          `if (updateFlowActive) return@check` 吞掉，表现为「永远检测不到更新」。

          手动点击是用户的明确意图，此时重置流程状态重新检查。
        */
        resetUpdateFlowForManualCheck()
        runUpdateCheck(notifyWhenUpToDate = true)
    }

    /**
     * 手动检查前清掉可能残留的流程状态。
     *
     * 只清「流程」标记，**不清 downloadedApk** —— 若上次真下载好了包，
     * 留着它用户还能通过弹窗重试安装，重新下载是浪费流量。
     */
    private fun resetUpdateFlowForManualCheck() {
        if (updateFlowActive) {
            Log.i(TAG, "[update] 手动检查：清除残留的 updateFlowActive")
            updateFlowActive = false
        }
        if (downloading) {
            Log.i(TAG, "[update] 手动检查：清除残留的 downloading")
            downloading = false
        }
    }

    /** 进入前台时自动查一次（每次进入只查一次，省 API 限额） */
    private fun maybeCheckUpdate() {
        if (updateChecked || updateFlowActive || !pageReady) {
            debugLog("[update] skipped: updateChecked=$updateChecked " +
                "updateFlowActive=$updateFlowActive pageReady=$pageReady")
            return
        }
        updateChecked = true
        debugLog("[update] checking (current ${Updater.installedVersionName(this)})")
        runUpdateCheck(notifyWhenUpToDate = false)
    }

    private fun runUpdateCheck(notifyWhenUpToDate: Boolean) {
        val installedNow = Updater.installedVersionName(this)

        Updater.check(this, onLog = { debugLog("[update] $it") }) { release ->
            if (release == null) {
                // 细节已由 Updater 的 onLog 逐行输出（HTTP 码 / tag_name / assets）
                debugLog("[update] result: no newer release")
                if (notifyWhenUpToDate) {
                    evaluateInWeb(
                        "window.ScholariusShell && window.ScholariusShell.onUpdateNone();"
                    )
                }
                return@check
            }
            if (updateFlowActive) {
                debugLog("[update] found ${release.version} but flow already active, ignored")
                return@check
            }
            debugLog("[update] found ${release.version}, showing sheet")

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

            evaluateInWebChecked(
                "update.available",
                "window.ScholariusShell && window.ScholariusShell.onUpdateAvailable(" +
                    "${quote(release.version)}, " +
                    "${quote(installedNow ?: "")}, " +
                    "${quote(Updater.formatSize(release.size))}, " +
                    "$stalled)"
            )
        }
    }

    private fun startUpdateDownload() {
        val release = pendingRelease ?: return
        if (downloading) return
        downloading = true

        Updater.download(
            context = this,
            release = release,
            onProgress = { percent ->
                evaluateInWeb(
                    "window.ScholariusShell && window.ScholariusShell.onUpdateProgress($percent);"
                )
            },
            onDone = { file, error ->
                downloading = false

                if (file == null) {
                    /*
                      下载失败：流程结束，让弹窗回到可用状态给用户重试。
                     */
                    updateFlowActive = false
                    notifyUpdateFailed(error ?: Updater.ERROR_NETWORK, downloaded = false)
                    return@download
                }

                /*
                  下载成功：把 File 留在 downloadedApk 上。
                  此时**不能**把 updateFlowActive 置 false —— 安装器还没起来，
                  流程仍在进行中。提前置 false 会让 onStop 误以为“可以重置已查标记”，
                  用户从安装器回来时会又弹一次「发现新版本」。
                 */
                downloadedApk = file
                installDownloaded()
            },
        )
    }

    /** 安装已下好的包（也可能是上次被权限拦下后的重试） */
    private fun installDownloaded() {
        val apk = downloadedApk
        if (apk == null) {
            // 没有可安装的包：说明是弹窗重开后的误触，直接提示重下
            notifyUpdateFailed(Updater.ERROR_INSTALL, downloaded = false)
            return
        }
        installApk(apk)
    }

    private fun installApk(apk: File) {
        val error = Updater.install(this, apk)
        val release = pendingRelease

        if (error != null) {
            /*
              权限没给（或安装器起不来）：把包留着，弹窗进入「重试安装」状态。
              包路径是 content:// URI，下次拉起安装器时只要文件还在就能装，
              所以这里**不**清 downloadedApk。
             */
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

    /** 弹窗被关掉：清干净状态，下次进入 app 可以重新检查 */
    private fun closeUpdateFlow() {
        updateFlowActive = false
        pendingRelease = null
        downloadedApk = null
        downloading = false
    }

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
        if (!::webView.isInitialized) {
            Log.w(TAG, "inject dropped: webView not initialized")
            return
        }
        if (!pageReady) {
            Log.w(TAG, "inject dropped: pageReady=false")
            return
        }
        try {
            webView.evaluateJavascript(script, null)
        } catch (t: Throwable) {
            Log.w(TAG, "inject failed", t)
        }
    }

    /**
     * 注入一段脚本，并把**执行结果回传到 logcat**。
     *
     * ⚠️ 为什么需要：`evaluateInWeb` 是「发射后不管」——
     *    脚本报错、元素没找到、桥没挂上，原生侧一概不知道，
     *    日志上却已经写了「弹窗」。
     *    这里用 `evaluateJavascript` 的回调把结果取回来，
     *    让「到底执行没执行、抛没抛错」有据可查。
     */
    private fun evaluateInWebChecked(tag: String, script: String) {
        if (!::webView.isInitialized) {
            Log.w(TAG, "[$tag] inject dropped: webView not initialized")
            return
        }
        if (!pageReady) {
            Log.w(TAG, "[$tag] inject dropped: pageReady=false")
            return
        }
        val guarded = "(function(){try{return String($script)}catch(e){" +
            "return 'ERR: '+(e&&e.message?e.message:e)}})();"
        try {
            webView.evaluateJavascript(guarded) { result ->
                Log.i(TAG, "[$tag] inject result: $result")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "[$tag] inject failed", t)
        }
    }

    /**
     * 原生日志 → logcat + 网页诊断浮层。
     *
     * ⚠️ 临时诊断（v0.0.18）。
     *
     * ⚠️⚠️ 内部会**自行切到主线程**再注入网页。
     *    `WebView.evaluateJavascript()` 必须在主线程调用，
     *    而更新检查在后台线程跑、它的日志回调也在后台线程 ——
     *    不切线程的话这些日志会被静默丢掉（上一版就是这样，
     *    浮层上只看得到主线程打的「开始检查」和「无新版本」，
     *    中间的 HTTP 状态码、tag_name 全都不见了）。
     */
    private fun debugLog(message: String) {
        Log.i(TAG, message)
        val script =
            "window.ScholariusShell && window.ScholariusShell.diag(" +
                "${quote("native | " + message)});"

        if (Looper.myLooper() == Looper.getMainLooper()) {
            evaluateInWeb(script)
        } else {
            runOnUiThread { evaluateInWeb(script) }
        }
    }

    // -----------------------------------------------------------------------
    // 文献库
    // -----------------------------------------------------------------------

    /**
     * 导入一个选中的 PDF。
     *
     * 流程：取文件名 → 后台复制+渲染缩略图+提取元数据 → 把结果推给网页。
     *
     * ⚠️ 复制与渲染**必须在后台线程**：一个 20MB 的 PDF 复制加渲染首页
     *    在主线程会冻住界面好几秒，用户会以为卡死了。
     *
     * ⚠️ 无论成功失败都要 `callback.onReceiveValue(...)`，
     *    否则网页的 file input 会永远处于等待状态。
     */
    private fun importPdf(uri: Uri, callback: ValueCallback<Array<Uri>>) {
        val displayName = queryDisplayName(uri)
        debugLog("[library] importing: $displayName")

        thread {
            val doc = LibraryStore.import(
                context = this,
                displayName = displayName,
                openStream = {
                    try {
                        contentResolver.openInputStream(uri)
                    } catch (t: Throwable) {
                        Log.w(TAG, "打开选中文件失败", t)
                        null
                    }
                },
            )

            runOnUiThread {
                /*
                  把 URI 交还给网页。
                  ⚠️ 同时推一份文献列表给网页 —— 网页拿不到 content:// URI 的
                     实际内容（那是原生侧的私有授权），由原生负责读、只把
                     展示所需的数据推过去。
                */
                callback.onReceiveValue(arrayOf(uri))

                if (doc == null) {
                    debugLog("[library] import failed: $displayName")
                    evaluateInWeb(
                        "window.ScholariusShell && window.ScholariusShell.onImportFailed();"
                    )
                } else {
                    debugLog(
                        "[library] imported '${doc.title}' pages=${doc.pages} " +
                            "size=${doc.size}"
                    )
                    pushLibraryToWeb()
                }
            }
        }
    }

    /** 取选中文件的显示名（SAF 的 URI 没有文件名，要从 ContentResolver 查） */
    private fun queryDisplayName(uri: Uri): String {
        try {
            contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) {
                    return cursor.getString(index) ?: "document.pdf"
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "查询文件名失败", t)
        }
        return uri.lastPathSegment ?: "document.pdf"
    }

    /**
     * 把文献列表推给网页。
     *
     * ⚠️ **缩略图不在这里推**。缩略图是 base64 的 PNG（每张几十 KB），
     *    几十篇就是几百 KB，一次性塞进 evaluateJavascript 的字符串里
     *    在部分机型会有问题，也拖慢首屏。
     *    改为：列表只推元数据（很小），缩略图由网页按需调用
     *    [thumbnailFor] 单独取。
     *
     * ⚠️ **PDF 文件路径也不推**。网页拿不到应用私有目录（WebView 的
     *    `allowFileAccess = false`），阅读页需要的是一条受控通道 ——
     *    那部分下个版本设计时再定。
     */
    private fun pushLibraryToWeb() {
        if (!::webView.isInitialized || !pageReady) return

        val docs = LibraryStore.list(this)
        val array = org.json.JSONArray()
        docs.forEach { doc ->
            array.put(org.json.JSONObject().apply {
                put("id", doc.id)
                put("title", doc.title)
                put("author", doc.author)
                put("venue", doc.venue)
                // 发表年份，可能是空串（没抓到 / 老索引没这个键）。
                // 网页据此显示：空串就留白，不要显示占位符。
                put("year", doc.year)
                /*
                  发表物类别。网页靠它决定：
                    · 卡片上画哪个图标（见 vault.js 的 VENUE_TYPE_ICON）
                    · 详情页显示哪一组字段（见 meta.js 的 TYPE_FIELDS）
                  ⚠️ 必须推 —— 前端 meta.js 的字段表是按类别分支的，
                     不推这个值，详情页就只能显示通用字段。
                */
                put("venueType", doc.venueType)
                /*
                  **短标题**。填了之后网页会用它**顶替卡片的标题**
                  （见 vault.js 的 renderCard）。

                  ⚠️ 必须推 —— 不推的话卡片就看不到它，
                     表现与「短标题没保存」完全一样，
                     但根因在推送这层，排查时会往错的方向找。

                  ⚠️ 空串也推：网页用 `(doc.shortTitle || '').trim()`
                     判空后回退显示标题，空串是合法输入。
                */
                put("shortTitle", doc.shortTitle)
                /*
                  类别专属字段（卷/期/页码/DOI/ISBN…）。
                  ⚠️ 用 JSONObject 嵌套而不是拍平成 top-level 键：
                     字段名可能和顶层键重名（比如 fields 里将来的 `venue`），
                     嵌套就没有这个风险，且与索引里的存储结构一一对应。
                  空表就不放这个键，省得每个 doc 都带一个 {}。
                */
                if (doc.fields.isNotEmpty()) {
                    put("fields", org.json.JSONObject(doc.fields as Map<*, *>))
                }
                put("addedAt", doc.addedAt)
                put("pages", doc.pages)
                put("size", doc.size)
                put("sourceName", doc.sourceName)
                // 有缩略图才标 true，网页据此决定要不要来取
                put(
                    "hasThumb",
                    LibraryStore.thumbFile(this@MainActivity, doc.id).exists()
                )
            })
        }

        evaluateInWeb(
            "window.ScholariusShell && window.ScholariusShell.setLibrary(${array});"
        )
    }

    /**
     * 取某篇文献的缩略图（base64）。
     * 网页按需请求 —— 列表里可见的那几张才取，避免一次推几百 KB。
     */
    private fun thumbnailFor(id: String): String {
        val file = LibraryStore.thumbFile(this, id)
        if (!file.exists()) return ""
        return try {
            "data:image/png;base64," + android.util.Base64.encodeToString(
                file.readBytes(), android.util.Base64.NO_WRAP
            )
        } catch (t: Throwable) {
            Log.w(TAG, "读取缩略图失败：$id", t)
            ""
        }
    }

    /** 删除文献（支持批量）。删完重新推列表。 */
    private fun deleteDocs(ids: List<String>) {
        if (ids.isEmpty()) return
        thread {
            val removed = LibraryStore.delete(this, ids)
            runOnUiThread {
                debugLog("[library] deleted $removed doc(s)")
                pushLibraryToWeb()
            }
        }
    }

    /**
     * 改文献元数据。改完重新推列表。
     *
     * ⚠️ 入参是**一个 JSON 对象字符串**，不是固定几个参数。
     *
     *    原来签名是 `(id, title, author, venue)` —— 只能改三样东西，
     *    而详情页要编辑的字段有二十多个（卷/期/页码/DOI/ISBN/学位类型…）。
     *    每加一个字段就改一次桥签名，既繁琐又容易前后端错位。
     *
     *    改成 JSON 后**加字段不用动原生**：网页按 meta.js 的字段表
     *    把改过的键塞进对象传过来即可。
     *    `LibraryStore.update` 本来就是 Map 形态（见它的注释），
     *    这里是把它接到桥上，语义完全一致：
     *      · 出现的键   → 改成该值
     *      · 值为空串   → 清空该字段
     *      · 没出现的键 → 保持原值
     *
     * ⚠️ 解析失败就整批不动（返回 false 由桥层记日志），
     *    不做「尽力解析一半」—— 半截的元数据比不改更糟。
     */
    private fun updateDoc(id: String, patchJson: String) {
        val patch: Map<String, String> = try {
            val obj = org.json.JSONObject(patchJson)
            val map = LinkedHashMap<String, String>()
            val keys = obj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                // optString 对 null 返回 ""，与「清空」语义一致
                map[k] = obj.optString(k, "")
            }
            map
        } catch (t: Throwable) {
            debugLog("[library] updateDoc 解析失败：$patchJson")
            return
        }

        if (patch.isEmpty()) return

        thread {
            val ok = LibraryStore.update(this, id, patch)
            runOnUiThread {
                if (ok) pushLibraryToWeb()
                // 推回给网页：详情页据此决定「已保存」提示要不要显示
                evaluateInWeb(
                    "window.ScholariusShell && window.ScholariusShell.docUpdated(" +
                        "${org.json.JSONObject.quote(id)}, $ok);"
                )
            }
        }
    }

    /**
     * 提取某篇文献的正文并推给阅读页。
     *
     * ⚠️ 必须在后台线程：要读整个 PDF、解压内容流、扫描字符串，
     *    几十兆的文献在低端机上可能几百毫秒到几秒。
     *
     * ⚠️ 不缓存提取结果。理由：正文可能很大（几十万字符），
     *    常驻内存不划算；而重复打开的代价只是再解析一次。
     *    若将来发现打开太慢，再引入一个「只缓存最近一篇」的 LRU。
     */
    private fun requestDocText(id: String) {
        debugLog("[reader] extracting text for $id")

        thread {
            /*
              ⚠️ PDFBox 要求先用 assets 里的 cmap/glyphlist 初始化资源加载器，
                 否则解析字体时抛异常。放在后台线程调用 ——
                 它要读 assets，在主线程不做 IO 是原则，
                 而且 PdfText.ensureInitialised 自带双检锁，重复调用无开销。
            */
            PdfText.ensureInitialised(this)

            val file = LibraryStore.pdfFile(this, id)
            val result = if (file.exists()) PdfText.extract(file) else null

            runOnUiThread {
                /*
                  ⚠️ 用 JSON 字符串字面量包装文本，而不是自己拼引号。
                    PDF 提取出的正文可能含换行、引号、反斜杠、控制字符 ——
                    手写转义几乎必错（早期 debugLog 的 quote() 就踩过）。
                    用 JSONObject.quote() 是唯一可靠的方式。
                */
                if (result == null) {
                    debugLog("[reader] no text for $id")
                    evaluateInWeb(
                        "window.ScholariusShell && window.ScholariusShell.readerText(" +
                            "${org.json.JSONObject.quote(id)}, null, null, null);"
                    )
                } else {
                    val outlineJson = outlineToJson(result.outline)
                    val linesJson = linesToJson(result.lines)
                    debugLog(
                        "[reader] pushing ${result.text.length} chars, " +
                            "${result.lines.size} lines, " +
                            "${result.outline.size} outline entries for $id"
                    )
                    evaluateInWeb(
                        "window.ScholariusShell && window.ScholariusShell.readerText(" +
                            "${org.json.JSONObject.quote(id)}, " +
                            "${org.json.JSONObject.quote(result.text)}, " +
                            "$outlineJson, $linesJson);"
                    )
                }
            }
        }
    }

    /**
     * 把自带大纲序列化成 JS 数组字面量。
     *
     * ⚠️ 标题里可能有引号/反斜杠/换行，所以**每个字段都过 quote()**。
     *    拼字符串做 JSON 是 bug 温床，但这里结构极简（3 个字段），
     *    比引一个 JSON 库划算。
     */
    private fun outlineToJson(entries: List<PdfText.OutlineEntry>): String {
        if (entries.isEmpty()) return "[]"
        val sb = StringBuilder(entries.size * 48)
        sb.append('[')
        for ((i, e) in entries.withIndex()) {
            if (i > 0) sb.append(',')
            sb.append("{\"level\":").append(e.level)
            sb.append(",\"title\":").append(org.json.JSONObject.quote(e.title))
            sb.append(",\"page\":").append(e.page)
            sb.append('}')
        }
        sb.append(']')
        return sb.toString()
    }

    /**
     * 把行元数据序列化成 JS 数组字面量。
     *
     * ⚠️ 这是 v0.1.5 为「目录靠字体识别」新增的载荷。
     *
     * ⚠️ **行数可能上万，这里的体积必须控制**：
     *    - JSON key 用**单字母**（f/s/p），不用 font/size/page。
     *      实测一篇文章 4000 行时，长 key 会让字符串多出 ~100KB，
     *      而 WebView 的 evaluateJavascript 参数是要跨进程传的。
     *    - 字号保留 1 位小数（float 序列化会产出 9.300000190734863 这种）。
     *    - 字体名做**去重**：一篇文章通常只有十几个字体，
     *      但每行都重复一遍会浪费大量空间。这里输出
     *      `{"fonts":[...],"lines":[[fIdx,size,page],...]}`，
     *      行里只存字体**下标**。
     *    - 文本本身**不在这里重复传**（正文已单独传过），
     *      前端按 `text.split('\n')` 的下标就能对上。
     */
    private fun linesToJson(lines: List<PdfText.Line>): String {
        if (lines.isEmpty()) return "null"

        // 字体名去重，建立 名称 -> 下标
        val fontIndex = LinkedHashMap<String, Int>()
        for (l in lines) {
            if (l.font.isNotEmpty() && !fontIndex.containsKey(l.font)) {
                fontIndex[l.font] = fontIndex.size
            }
        }

        val sb = StringBuilder(lines.size * 24 + fontIndex.size * 32)
        sb.append("{\"fonts\":[")
        for ((i, name) in fontIndex.keys.withIndex()) {
            if (i > 0) sb.append(',')
            sb.append(org.json.JSONObject.quote(name))
        }
        sb.append("],\"lines\":[")
        for ((i, l) in lines.withIndex()) {
            if (i > 0) sb.append(',')
            sb.append('[')
            sb.append(fontIndex[l.font] ?: -1)
            sb.append(',')
            /*
              ⚠️ 字号用 (size*10).roundToInt() 传**整数**，
                 前端再除 10。直接传 float 会得到
                 9.300000190734863 这种长尾，体积翻好几倍。
            */
            sb.append(Math.round(l.size * 10f))
            sb.append(',')
            sb.append(l.page)
            sb.append(']')
        }
        sb.append("]}")
        return sb.toString()
    }

    /** 用系统浏览器打开外部链接（站内导航不走这里） */
    private fun openExternally(url: String): Boolean = try {
        startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url)))
        true
    } catch (t: Throwable) {
        Log.w(TAG, "打开外部链接失败：$url", t)
        false
    }

    /**
     * 打开 GitHub 设备授权页。
     *
     * ⚠️ 就一件事：**用浏览器打开**。不再尝试拉起 GitHub App（v0.0.22 删）。
     *
     * 为什么删掉那套「GitHub App 优先」的逻辑 —— 它的前提是错的：
     *
     *   ① **Device Flow 没有 `github://` 深链。**
     *      `github://` 是 GitHub App 给「打开仓库 / PR / 用户」用的，
     *      跟设备授权毫无关系。把 `https://github.com/login/device`
     *      搬到 `github://` 前缀上，只是构造了一个它不认识的地址 ——
     *      实测表现就是「startActivity 成功但什么都没发生」。
     *
     *   ② **即使它能被拉起，也帮不上忙。**
     *      Device Flow 的码只能**在授权页上手动输入**，
     *      GitHub 没有提供任何「把设备码交给 App」的官方入口。
     *      所以「用 App 完成授权」这条路本身就不存在。
     *
     *   ③ GitHub 官方对无后端应用的预期就是「抄码 + 浏览器」——
     *      `gh auth login`（官方 CLI）也是这么做的。
     *
     * 真正能改善体验的是 [GitHubAuth.DeviceCode.bestVerificationUri]：
     * 用 GitHub 返回的 `verification_uri_complete`（带了 `?user_code=...`），
     * 浏览器打开后自动填码，用户只需点一次 Authorize。
     */
    private fun openDeviceVerification(verificationUri: String): Boolean {
        debugLog("[login] opening verification page in browser: $verificationUri")
        val ok = openExternally(verificationUri)
        debugLog("[login] browser open result=$ok")
        return ok
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
        if (!splashActive) {
            Log.i(TAG, "[native] finishSplash 忽略（已失效）")
            return
        }
        splashActive = false
        Log.i(TAG, "[native] finishSplash 生效 @${android.os.SystemClock.elapsedRealtime()}")
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

        if (!::webView.isInitialized) {
            return
        }

        debugLog("[life] resumed")

        /*
          每次回到前台重置「已查过」的标记，然后重查一次。
          为什么必须重置：用户可能刚从安装器回来（装完新版 → 版本变了要重查），
          也可能刚在系统设置里给了「安装未知应用」权限（要能重试安装）。
          为什么重置了还不会刷爆 API：一次前台只查一次 —— maybeCheckUpdate()
          自己会立刻把标记置回 true。
        */
        if (!updateFlowActive) {
            updateChecked = false
        } else {
            /*
              ⚠️ 这里防的是「updateFlowActive 死锁」——它曾导致永远检测不到更新。

              场景：Updater.install() 返回 ERROR_PERMISSION，我们把用户送去
              「安装未知应用」设置页，updateFlowActive 保持 true（弹窗还开着）。
              但如果用户回来后没点弹窗、或直接退出重进 app，这个 true 就没人清 ——
              之后每次 maybeCheckUpdate() 都在第一行被它挡住。

              判据：从后台回来时若已离开足够久，说明用户那边的事已经办完，
              把流程状态交还给检查逻辑。
              残留的 downloadedApk 不动 —— 若包真下好了，弹窗重试安装仍能用。
            */
            val away = SystemClock.elapsedRealtime() - leftForegroundAt
            if (away > UPDATE_FLOW_RESUME_GRACE_MS) {
                Log.i(TAG, "[update] away ${away}ms, clearing stale flow state")
                updateFlowActive = false
                downloading = false
                updateChecked = false
            }
        }
        maybeCheckUpdate()
    }

    override fun onStop() {
        super.onStop()
        leftForegroundAt = SystemClock.elapsedRealtime()
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
        /**
         * 入口页。
         *
         * ⚠️ 不再带 `?diag=1`（v0.0.25 改）。调试日志改由设置页的
         *    「Debug log」开关控制 —— 用户不需要改代码就能开关，
         *    也不用重装。开关状态存在网页 localStorage 里。
         */
        const val WEB_ENTRY_URL =
            "https://appassets.androidplatform.net/assets/www/index.html"

        const val JS_BRIDGE_NAME = "ScholariusNative"

        /** 网页一直没通知启动动画结束时的兜底时长（网页那边约 2.2s） */
        const val SPLASH_TIMEOUT_MS = 4000L

        /**
         * 从后台回来时，离开超过这个时长就认为「更新流程已中断」，清掉残留状态。
         *
         * 取值考虑：拉起系统安装器 / 跳「安装未知应用」设置页，用户操作通常
         * 几十秒到几分钟。2 秒的宽容度足以区分「只是切出去看一眼又马上回来」
         * （不该清，清了会重复弹窗）与「用户去别处办事了」（该清）。
         */
        const val UPDATE_FLOW_RESUME_GRACE_MS = 2_000L

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
