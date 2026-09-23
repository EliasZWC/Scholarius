# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## 关于 0.0.4 – 0.0.13 的无效迭代（记录在案，勿重犯）

启动页「一闪而过」**真正的唯一原因**是：

```
.splash { z-index: 40 }     ← 被压在下面
.login  { z-index: 50 }     ← 盖住了它
```

一行 `grep z-index` 就能查出，却在 **0.0.4 – 0.0.13 共 10 个版本**里被反复误诊，
其中 **0.0.9 – 0.0.12 的 4 个版本全部是同一错误假设下的无效改动**
（反复调整动画时长与 `animationend` 逻辑），并一度把问题**改得更糟**：

| 版本 | 当时以为的原因 | 真实情况 |
|---|---|---|
| 0.0.4 | `getAnimations()` 误判 | 无关 |
| 0.0.5 | 兜底超时太短 | 无关 |
| 0.0.9 | `updateFlowActive` 死锁 | 无关（那是更新检测的独立 bug） |
| 0.0.10 | splash 阻塞门控 | 无关 |
| 0.0.11 | 动画前 82% 静止 | 无关 |
| 0.0.12 | `animationend` 不可靠，改显式计时 | 无关 |
| **0.0.13** | 加诊断浮层 | **这才拿到决定性日志** |
| **0.0.14** | — | **真正修复（z-index）** |

**教训**：用户报告「看不见」时，先按「可能被别的东西挡住」查（`z-index` / 堆叠上下文 /
`elementFromPoint`），再查逻辑。详见长期记忆的调试铁律。

---

## [0.0.19] - 2026-09-23

### 结论：应用内更新**没有 bug**

v0.0.18 真机日志显示更新检测完全正常：

```
[update] 查询 https://api.github.com/repos/...（当前 0.0.18）
[update] API 返回 HTTP 200
[update] tag_name='v0.0.18'
[update] assets 共 1 个
[update]   asset: Scholarius-v0.0.18.apk
[update] 最新 0.0.18 不大于当前 0.0.18
[update] 结论：没有可用的新版本
```

得到的都是最新版，所以「无可用新版本」是**正确行为**。

之前看到的「无新版本（或查询失败）」把两种情况混在一起，是因为
`WebView.evaluateJavascript()` 必须在主线程调，而更新检查在后台线程、
其日志回调也在后台线程 —— 细节会被静默丢弃。v0.0.18 已修（`debugLog` 自行切线程）。

### GitHub App：有进展，但深链路径不对

v0.0.18 日志：

```
[VIEW+setPackage] 失败：ActivityNotFoundException
  （证实它不接受 https 链接）
[github:// 深链] 成功
已用 GitHub App 拉起 ✓
```

**能弹出「选择打开方式」了（之前完全做不到）**，但列表里没有 GitHub ——
说明 `github://github.com/login/device` 这个 path 不匹配它的规则。

本轮修正与加诊断：

1. 深链改为**裸 `github://`**（不带自己拼的 path），这是最保守、
   能匹配它任何一条 github:// 规则的写法。
2. 新增 `dumpIntentFilters()` —— **把 GitHub App 自己声明的深链规则打出来**，
   照着它的格式构造，而不是猜。

---

## [0.0.18] - 2026-09-23

### 修复

- **GitHub App 仍然只走浏览器（v0.0.17 真机日志已定位）。**

  日志：

  ```
  com.github.android 存在，名称='GitHub' enabled=true   ← <package> 点名生效
  com.github.android getLaunchIntent=ComponentInfo{...}
  能处理该链接的 App 共 1 个
    · com.android.chrome/...                            ← 仍然只有浏览器
  没找到 GitHub App
  ```

  **根因：GitHub App 没有注册 `https` 的 VIEW intent-filter。**
  所以 `queryIntentActivities` 里永远没有它 —— 这条路本身就走不通，
  不是可见性问题（它已经能被看见了）。

  改为**主动进它的包里去开**，逐个尝试三种方式：

  | 方式 | 做法 |
  |---|---|
  | 1 | `ACTION_VIEW` + `setPackage` |
  | 2 | `github://` 自定义深链 + `setPackage` |
  | 3 | `getLaunchIntentForPackage` 拉起主 Activity |

  任一成功即停；全失败才退回浏览器。
  `queryIntentActivities` 降级为仅用于掳第三方 GitHub 客户端。

### 诊断改进

- 诊断浮层改为**可折叠 + 可复制**（用户要求）：
  - 默认折叠成一条 37px 横条，不挡视野；
  - 点「展开」显示日志，**可长按选中复制**；
  - 「复制」按钮一键全选复制、「清空」重置；
  - 折叠状态跳启动记忆。

- `debugLog()` 内部**自行切主线程**。
  `WebView.evaluateJavascript()` 必须在主线程调用，
  而更新检查在后台线程、其日志回调也在后台线程 ——
  不切线程时这些日志被静默丢弃（上一版就是这样：浮层上只看得到主线程打的
  「开始检查」与「无新版本」，中间的 HTTP 状态码、`tag_name`、`assets` 全不见）。

---

## [0.0.17] - 2026-09-23

### 诊断（临时）

v0.0.15 真机日志已定位到 GitHub App 问题的位置：

```
com.github.android 已安装=false        ← getApplicationInfo 查不到
能处理该链接的 App 共 1 个：
  · com.android.chrome/...             ← 只剩浏览器
没找到 GitHub App → 退回浏览器
```

新增 `probePackage()` 区分两种「查不到」：
- `NameNotFoundException` → 真的没装
- `SecurityException` 等 → 包存在但被可见性挡住

并额外输出 `getApplicationLabel`、`enabled`、`getLaunchIntentForPackage`
（后者走另一条不受 `getApplicationInfo` 可见性限制的路径）。

### 同时修复（待验证）

`<queries>` 改为三层声明：

| 层 | 内容 | 作用 |
|---|---|---|
| ① `<package>` | `com.github.android` / `.beta` | 直接点名，不依赖对方注册了什么 filter |
| ② `<intent>` | VIEW + `scheme=https` | 按能力查（浏览器、第三方客户端） |
| ③ `<intent>` | VIEW + `scheme=github` | GitHub App 的自定义深链 |

之前只有第 ② 层，而 `getApplicationInfo()` 查不到说明
**光声明 intent 能力不够**，需要 `<package>` 直接点名。

---

## [0.0.16] - 2026-09-23

### 诊断（临时）

把**更新检测**的日志也接到屏幕浮层上（之前只有 `Log.i`，手机看不到）：

- `Updater.check()` 新增 `onLog` 参数，逐步输出：
  - 请求的 Release API 地址与当前版本
  - HTTP 状态码
  - `tag_name`
  - `assets` 数量与每个 asset 名
  - 版本比较结果（有新版本 / 不大于当前 / 解析失败）
- `maybeCheckUpdate()` 跳过时会打印三个条件的具体值：
  `updateChecked` / `updateFlowActive` / `pageReady`。

装上后打开应用，对屏幕底部截图即可看出为何收不到更新。

---

## [0.0.15] - 2026-09-23

### 诊断（临时）

为排查「GitHub App 没被拉起」，把**原生日志也接到屏幕浮层上**：

- 新增 `MainActivity.debugLog()` —— 同时写 logcat 与网页浮层
  （通过 `ScholariusShell.diag()`）。原生日志本来只进 logcat，
  手机上根本看不到。
- `openDeviceVerification()` 全链路日志：
  - 要打开的 URL、`scheme` / `host` / `path`
  - `com.github.android 已安装=true/false`（区分「没装」与「装了但挑不到」）
  - **枚举出所有能处理该链接的 App**（包名/activity 名）
  - 挑中的 ComponentName
  - 拉起成功 / 失败（含异常类型与消息）
  - 退回浏览器及其结果

装上后点一次「Sign in with GitHub」，对屏幕底部截图即可看出
到底是哪一步断的。

---

## [0.0.14] - 2026-09-23

### 修复

- **启动页「一闪而过」的真正原因：被登录页盖住了。**

  层级写反了：

  | 元素 | 修正前 | 修正后 |
  |---|---|---|
  | `.splash` | `z-index: 40` | **`z-index: 100`** |
  | `.login` | `z-index: 50` | 50 |

  实机日志（v0.0.13）：

  ```
   272ms  splash:timer   | 将在 2600ms 后退场
   427ms  account        | signedIn=false splashDone=false
   431ms  dismiss:blocked| splashDone=false
  2896ms  splash:done    | timer @2624ms
  2897ms  splash:hidden  | @2897ms
  ```

  原生在 **427ms** 就把 `signedIn=false` 推过来，`setAccount()` 立刻
  `show()` 登录页，而那之后 splash 才被收起 ——
  **splash 明明完整显示了 2.6 秒，但 427ms 后就被登录页盖住，用户完全看不见。**

  所以「日志正常」与「用户看到一闪而过」两边都是对的，只是一个在下面、一个在上面。

  现在 `z-index: 100` 凌驾于所有业务层（`.login` 50 / `.row-menu` 71 /
  `.toast` 80）之上。实测：登录页在 597ms 已显示，但 splash 一直盖在上面到 2642ms。

---

## [0.0.13] - 2026-09-23

### 诊断（临时）

启动页「一闪而过」经多轮修复仍未解决，本轮不再靠推断：
把启动时序做成**屏幕上的浮层**，不需要 adb、不需要远程调试。

入口页默认带 `?diag=1`，浮层显示在屏幕底部（`z-index:9999`，
盖过启动页），内容包含：

| 字段 | 含义 |
|---|---|
| `cssDur` / `animName` | 样式表是否生效、动画是否挂上 |
| `sheetApplied` | `<link>` 是否解析完 |
| `atDomReady.position` | 首帧时 `.splash` 是否已是 `fixed` |
| `splash:timer` | 计时器设定的退场时刻 |
| `splash:done` / `splash:hidden` | 实际退场时刻与原因 |

安装后打开应用，直接对屏幕底部截图即可。
定位完会连同 `trace()` 一起移除。

---

## [0.0.12] - 2026-09-23

### 修复

- **启动页退场改为显式计时，彻底不再依赖 `animationend`。**

  之前几版都用 `animationend` 决定退场时机，而这个事件在 WebView 里
  有三个不可靠之处：
  1. 样式表未生效时 `animation-duration` 为 `0s`，事件**立即**触发；
  2. 子元素（`.splash-logo` / `.splash-name`）的动画事件会冒泡上来，
     必须靠 `event.target` 过滤，这个过滤在部分机型上不可靠；
  3. CSS 动画的起点是**元素渲染时刻**，而脚本执行时刻晚于它，
     两者不同步让「已播时长」算不准。

  现在改为：`t=0` 开始计时 → `SPLASH_DURATION_MS`（默认 2600ms，
  并与 `getComputedStyle` 读到的实际动画时长对齐）后退场；
  再加一截兜底余量，**但绝不允许早于动画时长收起**。

  实测：splash 稳定显示 2.48s 后才收起。

- **首帧兜底样式内联进 `<head>`**：`styles.css` 到位之前，
  `<div class="splash">` 只是无样式普通 div（没有 `position:fixed`、
  不覆盖屏幕、不可见），用户会看到「空白 → 登录页」而不是启动页。
  现在把决定性的定位/尺寸/背景内联，首帧一定是满屏黑底居中内容，
  与系统启动页的纯黑底无缝衔接。

---

## [0.0.11] - 2026-09-23

### 修复

- **启动页「一闪而过」的真正手感问题**：前 82% 的时长是**静止的**。

  逐帧实测旧动画：

  | 时刻 | 状态 |
  |---|---|
  | 0–520ms | logo 放大落定 |
  | 160–780ms | 名称淡入 |
  | **780–1835ms** | **完全不动** |
  | 1835–2183ms | 淡出 |

  也就是说 2.2s 里有 **1 秒多屏幕上一动不动**，用户自然觉得
  「启动页早就没了」→ 感知为「一闪而过」。

  重做时间轴（总长 2600ms，全程都有变化）：
  - 0–720ms　logo 从 1.7 倍放大落定到 2 倍
  - 700–1420ms　名称淡入上移
  - 1420–1870ms　停留，让品牌被看清
  - 1990–2570ms　整体淡出

- 启动页退场不再用 `visibility` 关键帧（与 `hidden` 属性职责重叠，
  且会让「动画结束」与「元素消失」两个时机变得含糊）。

- `onPageFinished` 里的三步（推版本号 / 推账号 / 检查更新）改为**互相隔离**。
  原来顺序直调，只要前面任一步抛异常（典型是覆盖安装后
  `EncryptedSharedPreferences` 密钥失效，`auth.isSignedIn` 会抛），
  后面的**检查更新就不会执行**，且没有任何错误提示 ——
  表现就是「永远收不到更新通知」。

- `webPainted` 改为多重触发（`onPageStarted` / `onPageCommitVisible` /
  `onPageFinished` / 4s 定时器）。上一版只靠 `onPageCommitVisible`，
  而这个回调并非在所有情况下都会触发 —— 一旦不触发，
  系统启动页会**永远挡在最上层**，用户完全进不去应用。

---

## [0.0.10] - 2026-09-23

### 修复

- **登录成功也进不去（卡在登录页）**：启动动画阻塞了界面切换。

  `applyGate()` 原本要求「splash 演完 **且** 登录状态已知」两个条件。
  只要动画事件因任何原因没到达，`splashDone` 永远是 `false` →
  `applyGate()` 永不执行 → **登录成功了应用外壳也不显示**。

  正确分工：
  - 界面切换（功能层）→ 只看 `signedIn`
  - splash 退场（视觉层）→ 只看动画

  两者各自独立，互不阻塞。视觉遮罩不该拥有卡住功能的权力。

- **登录时按钮消失导致无法操作**：`onCode()` 里把按钮
  `hidden = true` 只留「取消」。一旦自动跳转失败（GitHub App 拉不起来、
  浏览器也没起、或用户跳过去又退回），**再无任何入口可重开授权页**。

  改为按钮文字变成「打开授权页」，点击重新跳转；并加 15s 启动超时保护 ——
  原生沒回调时恢复按钮而不是永久禁用。

---

## [0.0.9] - 2026-09-23

### 修复

- **永远检测不到更新（死锁）**：`updateFlowActive` 一旦卡在 `true` 就再没人清。

  复现路径：点更新 → 下载成功 → `Updater.install()` 返回 `ERROR_PERMISSION`
  （没给「安装未知应用」权限）→ 把用户送去系统设置页，同时
  `updateFlowActive` **保持 `true`**（弹窗还开着）。
  但用户回来后如果没点弹窗、或直接退出重进 app，这个 `true` 就没人清 ——
  之后每次 `maybeCheckUpdate()` 都在第一行被它挡住：

  ```kotlin
  if (updateChecked || updateFlowActive || !pageReady) return
  ```

  修法两道：
  1. `onResume` 里若发现离开超过 `UPDATE_FLOW_RESUME_GRACE_MS`（2s），
     判定为「流程已中断」并清掉残留状态。
  2. 手动点「版本」行时显式清掉残留状态，保证用户永远有一个
     **一定能突破死锁**的入口。

  > 这就是为什么装了 v0.0.7 也收不到 v0.0.8 的更新提示。

---

## [0.0.8] - 2026-09-23

### 修复

- **启动页一闪而过（找到根因）**：`installSplashScreen()` 的返回值被丢弃了，
  没调 `setKeepOnScreenCondition`。

  系统 splash 的默认行为是**画完第一帧就立刻退场**。但那一帧画的是
  「还没加载完的 WebView」（空白），网页里的启动动画此时根本还没渲染 ——
  于是用户看到的是：黑屏一闪 → 直接就是登录页，网页动画被整个跳过。

  现在用 `setKeepOnScreenCondition { !webPainted }` 把系统 splash
  **留在屏幕上**，直到网页真正画出第一帧（`onPageCommitVisible`）才交棒，
  两者无缝衔接，网页的 2.2s 动画完整可见。

  （之前几版都在调网页侧的 `animationend` / 兜底时长，方向错了 ——
  问题不在网页动画，而在它前面那段没人管的空白期。）

- **GitHub App 仍然只走浏览器**：`setPackage()` 与 App Links 冲突。

  GitHub App 对 github.com 用的是 App Links（`android:autoVerify="true"`），
  系统只有在**不指定包名**、走完整验证流程时才会把链接交给它。
  一旦 `setPackage("com.github.android")` 锁定包名，系统就改成
  「在该包内找能处理这个 intent 的 activity」—— 而它的 activity 只声明了
  autoVerify 的 App Links，没有普通 BROWSABLE filter → 找不到 → 退回浏览器。

  改为用 `queryIntentActivities` 返回的 **ComponentName** 直接启动，
  绕开包名锁定。同时补上「包已装但不在候选里」的诊断日志。

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
[0.0.8]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.8
[0.0.9]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.9
[0.0.10]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.10
[0.0.11]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.11
[0.0.12]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.12
[0.0.13]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.13
[0.0.14]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.14
[0.0.15]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.15
[0.0.16]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.16
[0.0.17]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.17
[0.0.18]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.18
[0.0.19]: https://github.com/EliasZWC/Scholarius/releases/tag/v0.0.19
