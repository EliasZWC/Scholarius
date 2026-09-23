# Scholarius · 应用规格

> 2026-09-23 起陆续定稿。姊妹项目：`Livolog`（`e:\product\Livolog`），两者的设计语言与工程约定保持一致。

## 〇、项目基本信息

| 项 | 值 |
|---|---|
| 显示名 | Scholarius |
| 包名 | `com.eliaszwc.scholarius` |
| 仓库 | https://github.com/EliasZWC/Scholarius |
| 形态 | 网页套壳（原生 WebView 容器 + 内置网页前端） |
| 平台 | Android only |
| 最低支持 | Android 8.0（API 26） |
| 目标版本 | Android 15（API 35） |
| 默认语言 | 英文（`en`），可切中文（`zh`） |
| 数据目录 | `Documents/Scholarius/` |

## 一、应用图标

详见 `design/icon-spec.md`。要点：

| 项 | 值 |
|---|---|
| 视口 | 108 × 108 |
| 外接框 | 38（到 72dp 遮罩留白 17） |
| 线宽 | 4.67 |
| 造型 | 希腊字母 Σ，头尾圆头，**仅尾部截断 9.34** |
| 端点短线 | 头 `(70.665,37.335)→(70.665,46.000)` `#FFFFFF`；尾 `(70.665,70.665)→(70.665,62.000)` `#6E6E6E` |

## 二、导航栏

**3 项，全部单数。**

| 位置 | 中文 | 英文 | Material 图标 | 图标名 |
|---|---|---|---|---|
| 1 | 文库 | `Library` | 摊开的书（带三行文字） | `menu_book` |
| 2 | 榜单 | `Ranking` | 三个高低柱 | `leaderboard` |
| 3 | 个人 | `Profile` | 人剪影 | `person` |

### 规格（照抄 Livolog，保证家族一致）

| 项 | 值 |
|---|---|
| 项数 | 3 |
| 栏高 | `8 + 48 + 8` px（另加系统导航条安全区 `--safe-bottom`） |
| 图标 | 24 × 24，`fill: currentColor` |
| 标签 | 12px / `font-weight: 500`；选中时 `600` |
| 图标与标签间距 | `gap: 3px` |
| 选中色 | 亮色 `#1B1B1B` / 暗色 `#F2F2F0` |
| 未选中色 | 亮色 `#8C8C8A` / 暗色 `#7E7E7C` |
| 栏底色 | 亮色 `#FCFCFB` / 暗色 `#131313` |
| 图标集 | **Google Material Icons**（与 Livolog 同源，不引入第三方图标集） |

### 语言约定

- 导航词全部用**单个普通名词、无装饰**，与 Livolog 的 `Time / Behavior / Track / Setting` 同款
- Livolog 连 `Settings` 都写作 `Setting`，**Scholarius 一律单数**

## 三、各页职能

| 页 | 英文 | 职能 |
|---|---|---|
| 文库 | `Library` | 导入与管理文献、阅读正文、标注、笔记。**纯本地，离线可用** |
| 榜单 | `Ranking` | 文献发现：榜单、推荐、投票（投月票选出好文献）。**不提供下载资源** |
| 个人 | `Profile` | 我的收藏、笔记汇总、投稿、账号状态 |

## 四、云端方案

**已定：用 GitHub 作为云端，不建自有用户库、不租服务器。**

| 项 | 决定 |
|---|---|
| 云端 | GitHub（仓库 + API） |
| 登录 | **GitHub OAuth Device Flow** |
| 用户身份 | 他的 GitHub 账号；token 存手机本地 |
| 本地数据 | 沿用 Livolog 方式（CSV），存 `Documents/Scholarius/` |

### 为何选 Device Flow

| 约束 | Device Flow 的答案 |
|---|---|
| 不能把 `client_secret` 放进 APK | **Device Flow 不需要 `client_secret`** |
| 不想建用户库 | 不需要；身份就是 GitHub 账号 |
| 不想租服务器 | 不需要服务器；App ↔ GitHub 直连 |
| 不想承担账号安全责任 | 密码在 GitHub 手里，泄露不是你的责任 |

### 已核实的技术事实（官方文档，非推测）

1. Device Flow **不需要 `client_secret`**。官方原文：`The client_secret is not needed for the device flow`
2. 必须在 OAuth App 设置里**手动启用 Device Flow**（默认关闭）
3. GitHub **不返回 `verification_uri_complete`**（文档未列该字段）→ 用户需手动输入 8 位码
4. `github.com/login/device` 页面**支持 Google / Apple 登录** → 没有 GitHub 账号也能进
5. Device Flow 限流：用户提交验证码 **50 次/小时/应用**；轮询间隔必须遵守 `interval`，否则收 `slow_down`

### 登录流程

```
① App → POST https://github.com/login/device/code
   ← user_code（如 WDJB-MJHT）、verification_uri、interval
② App 显示 user_code + [复制] + [打开 GitHub 授权]
③ App 按 interval 轮询 POST https://github.com/login/oauth/access_token
   ← access_token → 存本地 → 完成
```

### 降级要求（必须实现）

- **不登录可用的功能**：阅读、文献库、本地笔记 —— **全部核心功能可用**
- **登录才解锁**：投票、发榜、跨设备同步
- **Token 失效**：用户可在 GitHub 随时撤销 → App 必须优雅退回未登录状态，不崩

### 待定（不影响第一版）

- 文献条目由谁录入（作者预置 / 用户提交）
- 投票计数存哪（issue reaction / Discussions / 自建）
- 榜单的计算与分发方式（Actions 定时生成 `rankings.json`）

## 五、主题

照抄 Livolog，**不用纯黑 `#000` / 纯白 `#fff`**。

| | 亮色 | 暗色 |
|---|---|---|
| 页面背景 | `#EFEFED` | `#1E1E1E` |
| 导航栏 / 面板 | `#FCFCFB` | `#131313` |
| 文字 | `#1B1B1B` | `#ECECEA` |

- 导航栏比页面背景**更极端**：亮色导航栏更白、暗色导航栏更黑
- 主题设置：日间 / 夜间 / 跟随系统
- 网页端用 `<html data-theme>` 覆盖系统配色；原生端同步窗口背景与状态栏

## 六、字体

照抄 Livolog：**更纱等宽黑体**（Sarasa Mono SC）子集，WOFF2，Regular + Bold 两档（各约 1.5 MB），放 `assets/www/fonts/`。

- 界面里 400/500 走 Regular，600/700 走 Bold
- 未打包的生僻字自动回退系统字体
- 授权 SIL OFL 1.1，授权文件与字体同目录

## 七、工程约定

照抄 Livolog，以复用工具链与发布流程。

- 版本号：`appVersionCode` / `appVersionName` 单一来源在 `app/build.gradle.kts`
- 发布签名走环境变量；缺 keystore 时 release 任务必须失败
- tag `vX.Y.Z` 必须与 `appVersionName` 一致
- GitHub Actions：`build.yml` + `release.yml`
- 原生 ↔ 网页桥：`ScholariusNative`（网页→原生）/ `ScholariusShell`（原生→网页）
- 资源加载：`WebViewAssetLoader`，域 `https://appassets.androidplatform.net`
- 本地数据：CSV 当数据库

## 八、相关文件

| 用途 | 路径 |
|---|---|
| 图标规格 | `design/icon-spec.md` |
| 图标资源生成器 | `design/tools/gen_assets4.py` |
| 图标定稿样张 | `design/assets/v8_s_b38_arc_far_seg_seg.png` |
| 导航栏预览页 | `design/nav-preview.html` |
| 参考：Livolog | `e:\product\Livolog` |
