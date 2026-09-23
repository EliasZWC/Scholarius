# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.0.7] - 2026-09-23

### 诊断

- 为定位两个真机问题加了全链路日志（**定位完会移除**）：

  | 日志前缀 | 内容 |
  |---|---|
  | `[web] splash:setup` | `readyState`、`cssDur`、`animCount`、`prefers-reduced-motion` |
  | `[web] splash:done` | 退场原因（`animationend` / `delayed` / `fallback`）与耗时 |
  | `[web] dismiss:blocked` | 退场被阻塞时 `splashDone` / `signedIn` 的值 |
  | `[update] ...` | 请求 URL、HTTP 状态码、版本比较结果、跳过检查的原因 |
  | `[native] ...` | splash 兜底超时、`finishSplash` 是否生效 |

  查看方式：`adb logcat -s Scholarius`

### 说明

- **应用内检测不到更新是预期行为**：v0.0.5 及更早版本的更新弹窗关闭链路有缺陷
  （依赖一个不存在的 `scrim` 元素，`closeUpdateFlow()` 从不被调用），
  一旦弹过一次窗就再也不会检查。已在 0.0.6 修复。
  从 0.0.5 升级到 0.0.6 需要**手动安装一次**，之后自动更新才可用。

---

## [0.0.6] - 2026-09-23

### 修复

- **登录只打开浏览器、从不拉起 GitHub App（找到根因）**：
  Manifest 里**没有 `<queries>` 声明**。

  登录时要「优先用 GitHub App 打开授权页」，靠的是 `queryIntentActivities()`
  列出所有能处理该 https 链接的 App。
  **Android 11（API 30）起，除非显式声明可见性，`queryIntentActivities()`
  只能看到系统浏览器这类默认可见的包** —— GitHub App 会被直接过滤掉，
  于是永远挑不到它，每次都退回浏览器。

  这与「包名写错」无关，是包可见性限制。现在声明了
  `<intent><action VIEW /><data scheme="https" /></intent>`，
  不使用 `QUERY_ALL_PACKAGES`（敏感权限，上架需额外说明，没必要）。

- 登录页布局（用户 2026-09-23 要求）：
  - 整块内容上移（改为从 `14vh` 往下排，不再垂直居中）；
  - 提示文字改为 `Sign in with GitHub to Continue`；
  - **错误提示从按钮上方移到按钮下方** —— 放上面会把按钮往下推，
    重试时按钮位置跳动，反而不好点。

### 诊断（临时）

- 启动页「一闪而过」到 v0.0.5 仍未解决，本轮**不再靠猜**：
  在网页侧埋了时序日志（`app.js` 的 `trace()` + `WebAppBridge.trace()`），
  输出到 logcat 的 `Scholarius` tag。
  装上后跑一次 `adb logcat -s Scholarius` 即可看到
  CSS 动画时长、`animationend` 实际到达时刻、退场被阻塞在哪个条件。
  定位完成后会移除。

---

## [0.0.5] - 2026-09-23

### 修复

- **下载完不变安装（根的因）**：`Updater.install()` 完全没检查「安装未知应用」权限。
  Android 8+ 上只在 Manifest 声明 `REQUEST_INSTALL_PACKAGES` 是不够的，
  没授权时 `startActivity` 不会有任何反应 —— 安装器根本不出现，
  用户看到的就是「点了更新、下载完了、然后什么都没发生」。
  现在先查 `canRequestPackageInstalls()`，没权限就送到授权页并回 `permission`。
- `Updater.install()` 的参数从 `Context` 改回 `Activity`，
  并去掉 `FLAG_ACTIVITY_NEW_TASK`。用 ApplicationContext 启动安装器
  在部分 ROM 上会被直接拒绝。
- 已下载的 APK 改为缓存 `File` 对象本身。原来靠版本号重新拼路径，
  等于把 `Updater` 的内部目录规则拄一遍，两边一旦不同步就会
  拿着不存在的文件去拉起安装器。
- `updateFlowActive` 不再在下载完成时就被置 `false`；
  此时安装器还没起来，提前置 false 会让 `onStop` 误判，
  从安装器回来自动重弹一次。
- 补 `downloading` 重入守卫，防止连点「更新」重复下载。
- 补 `onStop()`：退到后台时重置「本次已查过」标记
  （安装中 / 已下好包的情况除外）。
- 弹层关闭改为通过 `openSheet(sheet, onDismiss)` 回调收尾。
  原来依赖一个**根本不存在**的 `scrim` 元素，监听从未注册，
  `closeUpdateFlow()` 永远不会被调用 —— `updateFlowActive` 会
  一直停在 `true`，之后再也不弹更新提示。

### 样式

弹层与表单按钮全面对齐 Livolog：

| 项 | 修正前 | 修正后 |
|---|---|---|
| 弹层定位 | 四边 8px 的浮起卡片 | 贴底整宽、仅上圆角 20px |
| 最大高度 | 无限制 | `calc(100dvh - ...)` + 滚动 |
| 入场动画 | `translateY(12px) scale(.98)` + 透明度 | `translateY(100%)` 滑入 |
| 标题 | 左对齐普通标题 | 居中 + 全大写 + 字距 0.5px |
| 按钮 | 填充胶囊（有底色、圆角 12px） | 纯文字按钮（无底无边框） |
| 按钮排列 | 靠右聚集 | Cancel 靠左 / Confirm 靠右 |
| 进度条 | `hidden` 无效，永远显示 | 补 `[hidden]` 规则 |
| 进度条尺寸 | 6px 高、160ms | 4px 高、200ms |

- 补上缺失的 `--success` 变量（亮 `#15803D` / 暗 `#7EE2A8`），
  这是 `.btn-primary` 的确认色，「确定」类按钮之前一直是错的颜色。
- `.btn-login` / `.btn-ghost` 显式复位 `text-transform` 与 `letter-spacing`，
  避免被表单按钮的「全大写」形态污染。

---

## [0.0.4] - 2026-09-23

### 修复

- **启动页一闪而过（真正原因）**：`v0.0.3` 里为了「处理动画已结束的情况」
  引入了 `splash.getAnimations().length === 0` 的判断，却在 `DOMContentLoaded`
  时机执行 —— 那时 CSS 可能还没应用，`getAnimations()` 返回空数组，
  于是被误判成「动画已结束」，启动页被立刻跳过。
  现在只用 `animationend` 事件判断，并把兜底超时从 3000ms 提到 3400ms
  （必须大于 CSS 里的 2200ms，否则会抢在事件前把启动页收掉）。

  > 这是 v0.0.3 引入的回归。教训：用「探测当前状态」代替「等事件」很危险，
  > 探测时机的状态未必代表最终状态。

- GitHub App 优先打开授权页：不再写死包名去 `setPackage`，
  改用 `queryIntentActivities` 列出所有处理者、排除浏览器后挑出 GitHub App。

---

## [0.0.3] - 2026-09-23

### 修复

- **启动页一闪而过**：splash 的退场条件原来只看「动画播完」，
  导致登录状态到达的时机一有偏差，界面就闪一下或者黑一段。
  现在改为**「动画播完」且「登录状态已知」两个条件都满足**才退场 ——
  无论原生推状态比动画早还是晚，启动页都完整演完 2.2 秒。
- **无障碍设置会砍掉启动页**：`prefers-reduced-motion: reduce` 下
  原来把动画缩到 600ms（一闪而过）。现在保留完整时长，只去掉位移与缩放，
  改成纯透明度变化 —— 这类设置的本意是避免位移/缩放引起不适，不含淡入淡出。

### 新增

- 登录按钮加 **GitHub 官方 Octocat 标识**
  （`github-mark.svg` 的路径，MIT 许可；Material Icons 不含第三方品牌 logo）

### 变更

- 打开 GitHub 授权页时**优先用 GitHub 手机 App**，装不上才退回浏览器

> ⚠️ 已知限制：GitHub App 的包名（`com.github.android`）没在真机上核实过，
> 若唤起失败会自动退回浏览器，不影响登录可用性。

---

## [0.0.2] - 2026-09-23

这一版可以发布了。三件事：个人页、强制登录、应用内更新。

### 新增 · 个人页

- 账户信息区：头像、显示名、`@handle`
- 设置项（沿用 Livolog 的排版，但**排除**它的三个数据项
  —— 存储位置 / 导入数据 / 导出数据）：
  - 语言（English / 中文）
  - 主题（日间 / 夜间 / 跟随系统）
  - 版本（点击手动检查更新）
  - 联系（发邮件）
- 退出登录：破坏性操作，单独一组 + 红色文字 + 二次确认弹窗

### 新增 · GitHub 登录（Device Flow）

- 冷启动流程变成：启动页 → 检查凭据 → 已登录进应用 / 未登录进登录页
- **强制登录**：登录页不提供「稍后再说」
- 登录状态长期保留，只有手动退出登录才失效
- 授权走 GitHub 官方 Device Flow：
  - 网页显示 8 位设备码（点一下即复制），自动打开浏览器去输
  - 不需要 `client_secret`（Device Flow 的设计目的）
  - 申请权限 `repo` + `read:user`
- **token 加密存储**（`EncryptedSharedPreferences` + Android Keystore），
  **不下发到网页层** —— 网页只拿到「是否已登录 / 用户名 / 头像」
- 退出登录**只清凭据，保留阅读数据**（可换账号登录，数据不串）

### 新增 · 应用内更新

- 进入前台自动检查一次 GitHub Release；版本页可手动检查
- 发现新版本 → 弹窗询问 → 下载（带进度）→ 拉起系统安装器
- 四道校验，任何一道不过就拒绝安装：
  - 体积与 Release 声明不一致 → `truncated`
  - 包内版本号与发布标签不一致 → `mismatch`
  - 不比当前装的版本新 → `downgrade`
  - 包结构非法 → `invalid`
- 「上次拉起安装器但没装成」会被识别，下次弹窗多一句权限提示

### 工程

- `gradle.properties` 新增 `GITHUB_CLIENT_ID`（公开值，Device Flow 允许明文）
- 打开 `buildConfig` 以便注入 `GITHUB_CLIENT_ID` / `GITHUB_REPO`
- 新增 `androidx.security:security-crypto:1.1.0`
- 新增 `tools/check_i18n.py`：机械校验所有 `data-i18n` 键都有词条
  （v0.0.2 开发中确实漏过一个，界面上直接显示出了键名）
- 新增 `tools/check_device_flow.py`：实测 GitHub 端点，确认
  `client_id` 有效且 Device Flow 已启用
- 新增 CI：`build.yml`（推送/PR 构建 Debug）、`release.yml`（推标签发布）
- AndroidManifest 增加 `REQUEST_INSTALL_PACKAGES` 权限与 FileProvider

### 已知限制

- **本机没有 Android SDK / JDK，编译未在本地验证过**。所有界面与逻辑
  都在浏览器里实测过，Kotlin 侧只做了静态检查。真正的编译验证依赖 CI。
- 登录的**端到端**流程（真去 GitHub 授权换 token）需要你在真机上走一遍；
  本机只验证到「拿设备码」与「轮询返回 `authorization_pending`」两步。
- 退出登录无法同时撤销 GitHub 侧的授权（Device Flow 拿不到 `client_secret`，
  调不了 revoke 接口）。想彻底撤销要去 GitHub 网站手动删。

---

## [0.0.1] - 2026-09-23

首个版本，不对外发布。搭出网页套壳的骨架。

### 新增

- 启动页动画：Σ 由大到小落定 + 名称淡入上移，全程 CSS 驱动（约 2.2s）
- 禁用安卓原生启动页：主题里把动画图标换成全透明矢量，底色用品牌黑 `#1B1B1B`
- 底部导航栏与三个页面：`Library` / `Ranking` / `Profile`
- 顶部标题栏，英文全大写（与 Livolog 同法）
- 页面内容留空

### 工程

- Kotlin + Gradle KTS，AGP 8.7.3 / Kotlin 2.0.21 / compileSdk 35 / minSdk 26
- WebView 容器：`WebViewAssetLoader` 把 `assets/www/` 挂到
  `https://appassets.androidplatform.net`
- 原生 ↔ 网页双向桥：`ScholariusNative`（网页→原生）、
  `ScholariusShell`（原生→网页）
- 主题：日间 / 夜间两套色板，不用纯黑纯白
- 字体：沿用 Livolog 的更纱等宽黑体子集（Regular + Bold）

### 图标

- Σ 字形，白 → 灰**按累计弧长**渐变（不是对角线线性渐变 ——
  那是对角线投影，Σ 折返时投影不单调，颜色会错位）
- 4 段独立线性渐变拼出弧长效果，相邻段共享折点、端点色相同
- 头尾各一条无渐变短线，尾部截断 2×线宽

---

[0.0.2]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.2
[0.0.1]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.1
[0.0.3]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.3
[0.0.4]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.4
[0.0.5]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.5
[0.0.6]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.6
[0.0.7]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.7
