# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
