# Scholarius 社区（云端）设计方案

> 状态：**待审**。本文只定接口与规则，不含实现。
> 裁决记录见文末「已裁决」表。

---

## 1. 定位与边界

### 1.1 做什么

- **评论**：用户对一篇文献发表短评（≤ 500 字）
- **发现**：按讨论热度排序的文献列表，供用户发现值得读的东西

### 1.2 不做什么（硬约束）

| 不做 | 原因 |
|---|---|
| **不存 PDF / 文献全文** | 个人使用与公开传播性质不同。服务端存 PDF 并下发会使本应用成为发行方，存在侵权索赔风险 |
| 不存用户笔记全文 | 笔记属于用户私有内容，只存评论 |
| 不做实时推送 | 零成本约束下无法维持长连接（Worker 的 WebSocket 需付费的 Durable Objects） |

### 1.3 成本约束

**必须为零。** 全部依赖 GitHub 免费资源，不引入需要付费的外部服务。

---

## 2. 存储

### 2.1 仓库

`EliasZWC/Scholarius-Community`（公开，Issues 已启用）

**为什么用独立仓库而不是代码仓库：**

用户在授权时会被要求 `public_repo` scope，该权限可写公开仓库。若讨论数据与代码同仓库，持有该 token 者可修改代码。独立仓库中只有讨论数据，被篡改不产生实质损失。

### 2.2 目录结构

```
Scholarius-Community/
├── .github/workflows/
│   ├── aggregate.yml      每 5 分钟：聚合计数
│   └── moderate.yml       每 5 分钟：频控扫描
├── data/
│   ├── counts.json        热度计数（发现页排序用）
│   └── blocked.json       关键词表（先留空，逐步补充）
└── issues/                （虚拟，实际由 GitHub 托管）
    └── 每个 doc_key 对应一个 issue，title = doc_key
```

### 2.3 文献标识（doc_key）

```
doi:10.1145/3290605.3300233
arxiv:2301.12345
isbn:9780262033848
title:<sha1 of normalized title>
```

- **DOI 优先**，抓不到退到 arXiv / ISBN，再退到归一化标题的哈希
- 标题归一化：小写 → 去标点 → 压缩空白 → 去除公式符号
- 标识符只是几十字符的字符串，**不构成作品复制**

### 2.4 issue 约定

| 字段 | 内容 |
|---|---|
| title | `doc_key`（如 `doi:10.1145/xxx`） |
| body | 文献元数据（标题、作者、年份），方便人查阅 |
| labels | `ref`（文献） |
| state | 保持 open |

**issue 由客户端按需创建**：用户首次评论某文献时，若该 issue 不存在则创建。

**竞态问题**：两个用户同时评论同一篇新文献，可能各建一个 issue。→ 处理方式见 §6.2。

---

## 3. 接口

### 3.1 读评论

```
GET /repos/EliasZWC/Scholarius-Community/issues/{number}/comments?per_page=100
```

- 额度：**用户自己的** 5000/小时
- 正文直接显示，**无延迟**

### 3.2 写评论

```
POST /repos/EliasZWC/Scholarius-Community/issues/{number}/comments
Body: { "body": "..." }
```

- 额度：用户自己的
- 客户端**必须**先做本地校验（见 §4）

### 3.3 找文献对应的 issue

```
GET /search/issues?q=repo:EliasZWC/Scholarius-Community+in:title+"{doc_key}"
```

- 额度：**搜索 API 独立限额，30 次/分钟**（用户自己的）
- ⚠️ 该限额远低于普通 API，**客户端必须缓存** doc_key → issue number 的映射

### 3.4 创建文献 issue（不存在时）

```
POST /repos/EliasZWC/Scholarius-Community/issues
Body: { "title": "<doc_key>", "body": "<元数据>", "labels": ["ref"] }
```

### 3.5 读热度计数（发现页用）

```
GET https://raw.githubusercontent.com/EliasZWC/Scholarius-Community/main/data/counts.json
```

- **CDN 通道，不计入 API 额度**
- 数据格式见 §5

---

## 4. 频控

### 4.1 限额

| 维度 | 值 | 理由 |
|---|---|---|
| 单条长度 | **500 字** | 评论区是短评；长文属于用户自己的地方 |
| 每分钟 | 3 条 | 正常输入速度达不到 |
| 每小时 | 20 条 | |
| 每天 | 60 条 | 重度用户也够 |

**四层都要**，因为防御面不同：
- 只有日限额 → 可在一秒内发完 60 条
- 只有分钟限额 → 每小时仍可发 180 条

### 4.2 实施方式

| 层 | 手段 | 生效时机 |
|---|---|---|
| 单条长度 | 客户端校验 + Actions 复核 | 提交前 |
| 频次 | **Actions 每 5 分钟扫描** | 事后 ≤ 5 分钟 |
| 实时兜底 | **GitHub Interaction limits**（仓库设置，需手动开启） | 实时，GitHub 执行 |

### 4.3 超限处理

1. 该用户**全部评论**隐藏（不只是超出的部分）+ 打 `spam` label
2. 累计两次 → 加入拉黑名单，拒绝后续 issue

**为什么隐藏全部而不只是超出的**：让违规成本明确，符合「让用户珍惜自己的评论」的目的。

### 4.4 已知缺陷（必须记录）

**Actions 事后处理有 ≤ 5 分钟窗口期。** 恶意用户可在窗口内刷屏，即使事后被清理，内容已被他人看到。

这是零成本方案的固有缺陷，无法通过技术手段消除。缓解手段：
- GitHub Interaction limits（实时，但粒度粗）
- 事后全量隐藏 + 拉黑（形成真实成本）

**若未来需要真正的即时拦截，必须引入服务端前置检查**，届时需重新评估成本与 token 策略。

---

## 5. 数据格式

### 5.1 `data/counts.json`

```json
{
  "updated_at": 1790000000,
  "docs": [
    {
      "doc_key": "doi:10.1145/3290605.3300233",
      "issue": 12,
      "comments": 8,
      "commenters": 5,
      "last_activity": 1789999000
    }
  ]
}
```

| 字段 | 用途 |
|---|---|
| `issue` | 客户端跳转用，**避免搜索 API**（限额低） |
| `comments` | 评论总数 |
| `commenters` | **去重**评论人数 —— 比评论数更能反映真实热度（防一人刷） |
| `last_activity` | 排序备选（时间序） |

**发现页排序用 `commenters` 优先、`comments` 次之**，避免单人刷评论拉高排名。

**只放前 500 条**：`counts.json` 会随使用增长，全量放进去会导致首屏加载变慢。

### 5.2 `data/blocked.json`（关键词表）

```json
{
  "version": 1,
  "terms": []
}
```

- **当前为空**，逐步补充
- 命中处理：该评论隐藏 + 打 `review` label，等人工裁决

---

## 6. 边界情况

### 6.1 用户未登录

社区功能**需要登录**（写操作需要 token）。未登录时：
- 发现页：**可读**（counts.json 是公开的，不需要 token）
- 评论：不可用

### 6.2 并发创建同一文献的 issue

两个用户同时首次评论同一篇文献 → 可能各建一个 issue。

**处理**：Actions 聚合时检测到 doc_key 重复，将**较晚**创建的 issue 关闭并打 `duplicate` label，其下的评论**保留**（不迁移，避免丢失）。

客户端侧：搜索时优先取**最早创建**的那个 issue。

### 6.3 用户删除自己的评论

GitHub 允许用户删自己的评论。`counts.json` 下次聚合时自然反映。

### 6.4 用户改名

评论的作者显示会变（GitHub 行为）。**存储 identity 用数字 `user_id` 而非 login**，避免改名后归属混乱。

---

## 7. 安全

### 7.1 scope 收紧

| | 当前 | 目标 |
|---|---|---|
| scope | `repo read:user` | **`public_repo read:user`** |

**`repo` 包含私有仓库读写，对当前功能完全没必要**，且会在授权页显示"访问你的私有仓库"，引起用户警觉。必须收紧。

### 7.2 token 边界

| 原则 | 说明 |
|---|---|
| token 不进入网页层 | 现有约束，继续遵守 |
| 所有 GitHub 请求由原生发起 | WebView 里 fetch github.com 会被 CORS 拦 |
| token 不发给任何第三方 | 内容直接写到 GitHub，**不经过我们的服务端** |

**最后一条是这个方案的重要优点**：没有中间人，token 只与 GitHub 交互。

---

## 8. 待办

| # | 事项 | 谁做 |
|---|---|---|
| 1 | 收紧 scope 为 `public_repo read:user` | 代码侧 |
| 2 | 开启 GitHub Interaction limits | **用户手动**（仓库设置） |
| 3 | 补充关键词表 | 用户，逐步添加 |
| 4 | 写 `aggregate.yml` / `moderate.yml` | 待批准后 |
| 5 | 客户端：社区接口封装 | 待批准后 |
| 6 | 客户端：发现页 / 评论区 UI | 待批准后 |

---

## 已裁决

| ID | 决策点 | 裁决内容 |
|---|---|---|
| C.R1 | 是否引入外部服务 | 不引入。只用 GitHub 免费资源，成本必须为零 |
| C.R2 | 数据存哪 | `EliasZWC/Scholarius-Community` 独立公开仓库，与代码仓库分离 |
| C.R3 | 存储形态 | 每篇文献一个 issue，评论为 issue comment |
| C.R4 | 读取通道 | 计数走 raw 直链（不计 API 额度），评论正文走 REST |
| C.R5 | 用户权限 | `public_repo read:user`（现为 `repo read:user`，须收紧） |
| C.R6 | 文献标识 | DOI 优先，退 arXiv/ISBN，再退归一化标题哈希 |
| C.R7 | 是否存 PDF | 不存。服务端只存讨论，不存文献全文 |
| C.R8 | 频控限额 | 单条 500 字；每分钟 3 条；每小时 20 条；每天 60 条 |
| C.R9 | 频控实施 | Actions 事后扫描 + GitHub Interaction limits 实时兜底 |
| C.R10 | 超限处理 | 该用户全部评论隐藏 + 打 spam；累计两次拉黑 |
| C.R11 | 关键词表 | 先留空，逐步补充；命中则隐藏 + 转人工 |
| C.R12 | 聚合频率 | 每 5 分钟 |
| C.R13 | 顺序依赖 | 云端实现推迟到文献导入功能完成后（否则无 doc_key 可测） |

## 待裁决

| ID | 决策点 | 选项 | 我的建议 |
|---|---|---|---|
| C.Q1 | 发现页排序依据 | ① 评论人数 ② 评论数 ③ 最近活跃 | ① 为主，② 次之（防单人刷） |
| C.Q2 | 未登录能否评论 | ① 不能（需 token）② 匿名评论 | ① |
| C.Q3 | 每篇文献的评论是否分页加载 | ① 一次拉 100 条 ② 按需加载更多 | ②（评论多了首屏会慢） |
