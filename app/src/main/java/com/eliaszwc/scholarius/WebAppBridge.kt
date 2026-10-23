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
     * 改文献元数据。
     *
     * ⚠️ 第二个参数是 **JSON 对象字符串**（形如 `{"year":"2015"}`），
     *    不是若干个具名参数 —— 字段集合会随版本增长，
     *    固定参数签名意味着每加一个字段都要改桥。
     */
    private val onUpdateDoc: (String, String) -> Unit,
    /** 保存正文 md（v0.1.92）。md 是**本地存储的唯一形态**，见 saveDocMd 说明 */
    private val onSaveDocMd: (String, String) -> Unit,
    /** 导出若干文献的 md 到用户选择的位置（v0.1.92） */
    private val onExportDocs: (String) -> Unit,
    /** 语义模型是否在本地（v0.1.94）。见 semanticModelReady */
    private val onSemanticModelReady: () -> Boolean,
    /** 开始下载语义模型（v0.1.94）。见 semanticDownloadModel */
    private val onSemanticDownloadModel: () -> Unit,
    /** 取消模型下载（v0.1.95） */
    private val onSemanticCancelDownload: () -> Unit,
    /** 取消正在进行的 PDF 导入（v0.1.95） */
    private val onCancelImport: () -> Unit,
    // --- 排版模板（v0.2.5）---
    /**
     * 列出所有可用模板（返回 JSON 数组字符串）。
     *
     * ⚠️ **同步返回**：模板清单很小（几 KB），网页需要在渲染
     *    模板选择器时立即拿到，异步会让面板先空一下。
     */
    private val onListTemplates: () -> String,
    /** 取单个模板的完整 JSON；不存在返回空串 */
    private val onGetTemplate: (String) -> String,
    /** 保存一个模板（JSON 字符串）；返回是否成功 */
    private val onSaveTemplate: (String) -> Boolean,
    /** 删除一个模板 */
    private val onDeleteTemplate: (String) -> Unit,
    /** 导出模板到用户选的位置（走 SAF） */
    private val onExportTemplate: (String) -> Unit,
    /**
     * 导出**网页侧现算的**模板 JSON（v0.2.37）。
     *
     * ⚠️ 与 `onExportTemplate` 的区别：
     *    · 那个按 id 从 TemplateStore 取一份**已保存**的模板；
     *    · 这个导出**当前屏幕上的结构**，可能从未保存过。
     *    见 `exportTemplateJson` 的说明。
     */
    private val onExportTemplateJson: (String, String) -> Unit,
    /** 套用模板到某篇文献（templateId 为空串 = 取消套用，回通用规则） */
    private val onApplyTemplate: (String, String) -> Unit,
    /**
     * 让用户选一个模板文件导入（v0.2.7）。
     *
     * ⚠️ 异步：要走 SAF 文件选择器。结果由原生调网页的
     *    `ScholariusReader.onTemplateImported(status, payload)` 推回。
     */
    private val onPickTemplateFile: () -> Unit,
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
     * 取消正在进行的 PDF 导入（v0.1.95）。
     *
     * ⚠️ 只是**置一个标志**，立即返回。真正的停止发生在导入线程
     *    下一个检查点（每 64KB 一次）。所以 UI 不能假设"点了就停了" ——
     *    要等 `importProgress("cancelled")` 回调才能收起表单。
     */
    @JavascriptInterface
    fun cancelImport() {
        onCancelImport()
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

    // -----------------------------------------------------------------------
    // 排版模板（v0.2.5）
    // -----------------------------------------------------------------------

    /**
     * 列出所有可用模板。返回 JSON 数组：
     * `[{"id":…,"name":…,"sha256":…,"blockCount":…}, …]`
     *
     * ⚠️ **不返回 `blocks` / `ops` 两个大数组** ——
     *    网页列模板只需要元信息，几百个块的数组塞进去会让
     *    每次打开模板面板都多传几百 KB。要用时走 `getTemplate`。
     */
    @JavascriptInterface
    fun listTemplates(): String = onListTemplates()

    /** 取一个模板的完整内容（JSON 字符串）；不存在返回空串 */
    @JavascriptInterface
    fun getTemplate(id: String): String = onGetTemplate(id)

    /** 保存模板（网页侧生成好 JSON 后交过来）；返回是否成功 */
    @JavascriptInterface
    fun saveTemplate(json: String): Boolean = onSaveTemplate(json)

    /** 删除模板 */
    @JavascriptInterface
    fun deleteTemplate(id: String) {
        onDeleteTemplate(id)
    }

    /** 把模板导出成文件（用户选位置） */
    @JavascriptInterface
    fun exportTemplate(id: String) {
        onExportTemplate(id)
    }

    /**
     * 套用模板。
     *
     * @param templateId 空串表示取消套用（回退通用规则）
     */
    @JavascriptInterface
    fun applyTemplate(docId: String, templateId: String) {
        onApplyTemplate(docId, templateId)
    }

    /**
     * 弹文件选择器导入模板（v0.2.7）。
     *
     * ⚠️ 立即返回，结果异步推回 `ScholariusReader.onTemplateImported`。
     */
    @JavascriptInterface
    fun pickTemplateFile() {
        onPickTemplateFile()
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
     * 保存正文 md（v0.1.92）—— **唯一的数据写入通道**。
     *
     * ══ ⚠️⚠️ 为什么由前端生成 md，而不是原生 ══
     *
     * md 里要带**用户的标注**（引用区间、作者子标签），
     * 而这些是前端在编辑/标注后才知道的（字符区间、子标签名）。
     * 原生只知道“PDF 提取出来的原始正文”。
     *
     * ✅ 所以分工：
     *    · 导入 / 懒迁移 → 原生从 PDF 生成初版 md（见 mdFromExtract）；
     *    · 用户编辑/标注 → 前端把当前完整 md 回写（本接口）。
     *
     * ⚠️ 传的是**完整 md 全文**，不是增量 ——
     *    增量合并需要两边维护同一套版本号，容易错位；
     *    一篇文献的 md 通常几十 KB，整存代价可以接受。
     *
     * @param md 完整的 Markdown 全文（含 `<!--@…-->` 标注注释）
     */
    @JavascriptInterface
    fun saveDocMd(id: String, md: String) {
        onSaveDocMd(id, md)
    }

    /**
     * 导出若干文献的 md 到用户选的位置（v0.1.92）。
     *
     * ⚠️ 用系统文件选择器（`ACTION_CREATE_DOCUMENT`）而不是写固定目录 ——
     *    用户要知道文件去哪了，而且 Android 10+ 不允许随意写外部存储。
     * ⚠️ 导出**不改动**任何本地数据，只是拷贝。
     *
     * @param idsJson 文献 id 的 JSON 数组字符串
     */
    @JavascriptInterface
    fun exportDocs(idsJson: String) {
        onExportDocs(idsJson)
    }

    /**
     * 把**网页侧生成的**模板 JSON 导出成文件（v0.2.37）。
     *
     * ══ ⚠️⚠️ 为什么由网页生成，而不是原生从 TemplateStore 读 ══
     *
     * 用户要求：
     *
     *   「悬浮菜单顶部栏最右边增加一个导出模板的图标按钮」
     *
     * 已有的 `exportTemplate(id)` 是**详情页**用的：它按 id 去
     * `TemplateStore` 里找一份**已保存**的模板再导出。
     *
     * 但阅读页顶栏要导出的是「**当前这一篇此刻的排版结构**」——
     * 它可能：
     *   · 从来没保存成模板（没有 id）；
     *   · 刚刚被用户改过（块序、角色、标注都变了），
     *     与 TemplateStore 里那份已经不是一回事。
     *
     * 用户点「导出」，期望拿到的是**屏幕上现在这样**。
     * 所以模板内容必须由网页侧按当前 `docModel.blocks` 现算，
     * 原生只负责把字符串写成文件。
     *
     * @param json     完整模板 JSON（schema/id/name/source/blocks/ops/style）
     * @param filename 建议文件名（不含路径；原生仍会做安全清洗）
     */
    @JavascriptInterface
    fun exportTemplateJson(json: String, filename: String) {
        onExportTemplateJson(json, filename)
    }

    // -----------------------------------------------------------------------
    // 语义分段（v0.1.94）
    // -----------------------------------------------------------------------

    /**
     * 语义模型是否已下载到本地。
     *
     * ⚠️ 这个方法是**设置开关的唯一事实来源**：
     *    网页先问它，得到 false 就弹下载表单，得到 true 才允许打开。
     *    见 semantic.js 文件头那段"开关不能假装打开"的说明。
     */
    @JavascriptInterface
    fun semanticModelReady(): Boolean = onSemanticModelReady()

    /**
     * 开始下载语义模型。
     *
     * ⚠️ 异步：立即返回，进度与完成由原生回调：
     *    `ScholariusSemantic.downloadProgress(bytes)`
     *    `ScholariusSemantic.downloadFinished(ok)`
     */
    @JavascriptInterface
    fun semanticDownloadModel() {
        onSemanticDownloadModel()
    }

    /** 取消模型下载（用户点了取消） */
    @JavascriptInterface
    fun semanticCancelDownload() {
        onSemanticCancelDownload()
    }

    /** 预计下载总量（字节），前端用它算百分比 */
    @JavascriptInterface
    fun semanticTotalBytes(): Long = SemanticModel.TOTAL_BYTES


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
