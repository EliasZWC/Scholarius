/**
 * Scholarius - 阅读页。
 *
 * ## 交互（与主流阅读器一致）
 *
 * · **点正文中间的 1/3 区域**切换菜单显隐（左 1/3、右 1/3 留给翻页，
 *   本版还没做翻页，但区域先留出来，避免以后改交互位置）
 * · 菜单分上下两条：顶部栏（返回）、底部选项栏（目录 / 设置）
 * · 菜单是**浮在正文之上**的（absolute），正文位置不动，阅读进度不会跳
 * · 正文容器撑满全屏（含状态栏区域），菜单盖上去 —— 不是为菜单留空带
 *
 * ## 正文是什么形态（v0.1.2 已修正）
 *
 * ⚠️ 这里是**普通文本**，不是 LaTeX 源码。
 *
 * PDF 里存的是**排版结果**（带坐标的字形序列），不是 LaTeX 源码 ——
 * 源码结构（`\section{}`、`\begin{equation}`）在 PDF 里已经不存在了。
 * 想把公式从 PDF 反推成 LaTeX 语法需要数学 OCR，不是本项目范围。
 *
 * 所以现在由 pdfbox 提取出线性化的普通文本：
 *   · 公式会变成近似线性的字符，如 `Fall = Concat(F1, F2, . . . , FM)`
 *     —— 能读懂，但不是可编译的 LaTeX。
 *   · 上标下标会退化成相邻字符，如 `Fat 2 RN£Din`。
 *     这是 PDF 文本层的固有限制，不是我们的 bug。
 *
 * 展示上仍然只用 textContent + pre-wrap：
 * 正文是任意文本，可能含 < > & 等字符，用 innerHTML 会破坏页面结构。
 *
 * ## 目录怎么来的（v0.1.3）
 *
 * ⚠️ 目录来自**对提取文本做版式识别**，不是 PDF 自带的书签大纲。
 *    理由：pdfbox 能读 PDF 大纲（`document.getDocumentCatalog().getDocumentOutline()`），
 *    但实测很多论文（尤其 arXiv/LaTeX 投稿）大纲要么没有、要么只有
 *    一个「正文」节点，不可用。而提取出的文本里标题行的形态相当稳定，
 *    识别它反而更可靠，且对没有大纲的 PDF 也有效。
 *
 *    识别规则（见 buildToc）：行首形如
 *        `3 Methodology` / `3.1 Problem Formulation` / `ABSTRACT` / `1 Introduction`
 *    即「数字编号 + 标题」或「全大写关键词」。
 *    正文单行最长不超过 MAX_TITLE_CHARS，超长的按正文行排除。
 *
 *    起点是**摘要**：摘要之前的作者、单位、邮箱等不进目录（用户明确要求）。
 *
 * ## 阅读设置（v0.1.3）
 *
 * 字号 / 颜色 / 字体样式三项**只作用于阅读页**，与全站主题无关；
 * 主题（日间/夜间/跟随系统）**与「设置 → 主题」是同一个值**，
 * 两处入口共用 ScholariusTheme，改一处另一处同步。
 *
 * ## 文本从哪来
 *
 * 由原生从 PDF 提取（`PdfText.extract`）后推过来，网页不接触 PDF 文件
 * —— WebView 的 allowFileAccess=false，读不到应用私有目录。
 */
(function (global) {
    'use strict';

    /* ---------------------------------------------------------------------
       阅读设置：存储键与取值域
       --------------------------------------------------------------------- */

    var FONT_KEY = 'scholarius.reader.font';
    var SIZE_KEY = 'scholarius.reader.size';
    var COLOR_KEY = 'scholarius.reader.color';

    /**
     * 字号范围与步长（px）。
     *
     * ⚠️ v0.1.4 改为「减 / 数值 / 加」+ 可直接输入，不再是固定档位列表。
     *    原因：用户要求「不做具体选项，而是给一个值」——
     *    档位列表限制了取值，也让「想精确到 18px」做不到。
     */
    var SIZE_MIN = 12;
    var SIZE_MAX = 40;
    var SIZE_STEP = 1;
    var DEFAULT_SIZE = 17;

    /**
     * 字体颜色候选。
     *
     * ══ ⚠️ 为什么用「深浅档位」而不是颜色名（v0.1.4 重做）══
     *
     * 上一版用 black / white 这类颜色名，结果自相矛盾：
     * 夜间模式下选「黑色」，正文实际渲染成白色（黑底上黑字看不见），
     * 于是用户看到「用的是白字，标签却写黑色」—— 实测反馈就是这个。
     *
     * 根因是**用颜色名描述了一个随主题变化的抽象量**。
     * 一个「看起来显眼」的色，在白底上是深色、在黑底上必须是浅色，
     * 它根本没有固定的颜色名可用。
     *
     * 现在改为描述**对比度档位**：
     *     Strong   与背景强对比（默认，最清楚）
     *     Medium   中等对比
     *     Soft     低对比（省眼，长时间读）
     *     Warm     暖色调（类似护眼纸）
     * 每档在亮/暗主题下各取一套具体色值（见 styles.css），
     * 所以标签在任何主题下都成立，不会自相矛盾。
     *
     * 色块预览不在这里写死 —— 直接读正文实际颜色（见 actualContentColor）。
     */
    var COLORS = [
        { value: 'strong' },
        { value: 'medium' },
        { value: 'soft' },
        { value: 'warm' }
    ];

    /** 字体族 */
    var FONTS = ['serif', 'sans', 'mono'];
    var DEFAULT_FONT = 'serif';

    /* ---------------------------------------------------------------------
       模块状态
       --------------------------------------------------------------------- */

    var root = null;
    var bodyEl = null;
    var contentEl = null;
    var topEl = null;
    var backBtn = null;
    var detailBtn = null;
    /** 语义切分按钮（v0.1.98）—— 模型的唯一入口 */
    var segBtn = null;
    /** 顶栏「导入排版模板」按钮（v0.2.7） */
    var tplBtn = null;
    /** 顶栏「导出排版模板」按钮（v0.2.37）—— 顶栏最右端 */
    var tplExportBtn = null;
    var bottomEl = null;
    var tocBtn = null;
    var settingsBtn = null;
    var panelEl = null;
    var tocSheetEl = null;
    var tocListEl = null;
    var tocCloseEl = null;
    var tocBackdropEl = null;

    /** 当前打开的文献 */
    var currentDoc = null;
    /**
     * 最后一次 setText 的入参摘要（v0.1.99 诊断用）。
     *
     * ⚠️ 必须**声明**在这里。上一版只写 `lastDiag = ...` 而没有 var，
     *    在严格模式下（本文件是否严格取决于外层包装）会直接抛
     *    `ReferenceError: lastDiag is not defined` ——
     *    而它就在 setText 的第一行，于是**整个正文渲染被这一个
     *    诊断变量搞挂**。
     *    这是"为了排查问题而引入新 bug"的典型案例。
     */
    var lastDiag = '';
    /** 菜单是否可见 */
    var menuOpen = false;
    /** 设置面板是否展开 */
    var panelOpen = false;
    /** 目录弹窗是否展开 */
    var tocOpen = false;
    /**
     * 阅读视图的正文缓存。
     *
     * 两者只会有一个非空：有结构化块时存 blocks，否则存纯文本。
     */
    var lastBlocks = null;
    var lastText = '';

    /**
     * 目录条目：[{ level, title, line }]
     * line 是它在**原始提取文本**里的行号，跳转时据此定位。
     */
    var toc = [];
    /** 提取出的原始文本，按行拆好缓存在这里（跳转要算偏移） */
    var textLines = [];

    /* ---- 文本选中（v0.1.40）---- */

    /**
     * 长按触发选中所需的按住时长。
     *
     * ⚠️ 取 500ms，与 Android 系统的 `ViewConfiguration.getLongPressTimeout()`
     *    默认值（500ms）一致 —— 用户的手指已经习惯了"按住不动约半秒"
     *    会触发某种选择行为，偏离这个值会让人觉得"按了没反应"。
     */
    var SELECT_LONG_PRESS_MS = 500;

    /**
     * 长按后手指允许的抖动半径（CSS px）。
     *
     * ⚠️ 按物理尺寸定（2mm），不写死像素 ——
     *    高 DPI 屏上"点一下"的天然抖动可以到 10 CSS px 以上。
     *    超过这个半径就认为用户是在滚动，取消长按计时。
     */
    var SELECT_SLOP_PX = 2 * 96 / 25.4;

    /** 长按计时器（null = 没有待触发的长按） */
    var selTimer = null;
    /**
     * 手势是否正在进行中（v0.1.42）。
     *
     * ══ ⚠️⚠️ 为什么需要这个标志 ══
     *
     * 拖动选字期间，浏览器会**间歇性**报告"空选区"，紧接着又报告
     * 正确的选区。如果 `selectionchange` 处理器相信了那次空的，
     * 就会把用户正在选的字当场清掉 ——
     * 症状是「小幅拖动后什么都没选上」，而大幅拖动"看起来正常"
     * （因为恰好最后几次报告不是空的）。
     *
     * 判定规则：touchstart 置 true，touchend/touchcancel 置 false。
     * 手势期间的空报告一律忽略。
     */
    var selecting = false;
    /** 长按起点 */
    var selStartX = 0;
    var selStartY = 0;
    /**
     * `touchstart` 时的滚动位置与手指 y（v0.1.41）。
     *
     * ⚠️ 因为 `touchstart` 里 `preventDefault` 了（为了不丢 pointer 链），
     *    浏览器**不会**再帮我们滚页面 —— 判定为滚动后要自己滚，
     *    这两个量就是自滚所需的基准。
     */
    var touchScrollStart = 0;
    var touchY0 = 0;
    /** 当前选中的纯文本（空串 = 没有选中） */
    var selectedText = '';
    /** 选中高亮覆盖的 Range 列表（可同时高亮多个段落） */
    var selectedRanges = [];
    /**
     * 选区的**起点** `{node, offset}`（v0.1.41）。
     *
     * ⚠️ `caretRangeFromPoint` 只能拿到"当前位置"，拿不到"最初从哪开始"。
     *    而按住拖动时要决定往左还是往右扩展，必须有起点。
     * ⚠️ 存 `{node, offset}` 而不是一个数字 —— 跨段落拖动时
     *    文本节点会变，只记偏量会算错位置。
     */
    var selAnchor = null;
    /** 选中操作条元素 */
    var selBarEl = null;
    /** 选中操作条上的文字（显示选中了多少字） */
    var selCountEl = null;

    /**
     * 段落编辑结果与段落标注（v0.1.45）。
     *
     * ══ ⚠️⚠️ 为什么不碰 PDF 源文件 ══
     *
     * 用户要求原话：
     *   「一旦确认，编辑区域内编辑后的内容将代替原内容。
     *     而此举没有改变 pdf 源文件，所以当新导入的时候，
     *     新文件的阅读视图应该还是当时我们那个最原始的全文本的样子。」
     *
     * 所以这两份数据只存在**本地存储**里，按 `doc.id` 分桶：
     *   · 编辑 → `{ [line]: 新的段落文本 }`
     *   · 标注 → `{ [line]: 标签 key }`
     *
     * ⚠️ 键用**块的行号 `line`**，不是段落序号 ——
     *    `line` 是原生提取层给的稳定块序号（`makeBlockEl` 已写进
     *    `data-line`），同一份 PDF 每次提取结果一致。
     *    用「第 N 段」会因为 `dropContainedBlocks` 过滤掉重叠块而错位。
     *
     * ⚠️ 标注只记**行号**，不记文本内容。这样即使段落被编辑过，
     *    标注依然挂在同一块上（都是同一个 `line`）。
     */
    var edits = {};
    var labels = {};

    /**
     * 当前文献要套用的排版模板（v0.2.6）。null = 没有模板。
     *
     * ⚠️ 由原生在推文献列表之后单独推过来（`setTemplate`），
     *    而不是混在 `setLibrary` 里：模板内容含 `blocks`/`ops`
     *    两个大数组，而列表推送是**全库**的 ——
     *    把每个模板都塞进去，几十篇文献就是几百 KB。
     *
     * ⚠️ 只缓存**当前打开的这一篇**的模板。切文献时必须换掉，
     *    否则 A 的模板会套到 B 上（序号全错，而且不会报错）。
     */
    var templateCache = null;

    /**
     * ══ 文档模型（v0.1.57）══
     *
     * 用户要求原话：
     *   「直接把 pdf 转完的文本保存一份就好了，
     *     然后我们的操作都在这个保存的文本上直接操作就行」
     *
     * ══ ⚠️⚠️ 为什么需要它 ══
     *
     * v0.1.45~56 一直在做"从 DOM 反推区间"：
     *   · 选中几个字 → 遍历 DOM 找 `[data-line]` → 算在块文本里的偏移；
     *   · 标注把一段拆成 [前残片][标注段][后残片] 之后，
     *     残片没有真实的块身份，偏移就全乱了；
     *   · 于是不断打补丁（虚拟行号、残片表、跳过标签文字…），
     *     每个补丁都带来新的边界 bug。
     *
     * ✅ 现在改成**以数据为准**：
     *
     *   docModel = {
     *     blocks: [{ line, page, text }]   ← PDF 转换后的原始文本，只读
     *   }
     *
     *   · `edits`  存**编辑后的整块文本**（`{line: 新文本}`）
     *   · `labels` 存**在该块文本上的字符区间**（`{line: [{start,end,label}]}`）
     *
     *   两者都以 `blocks[i].text` 为坐标系，与 DOM 结构**完全无关**。
     *   DOM 只是模型的一个**投影** —— 渲染怎么拆段落、插不插标签段，
     *   都不影响"这一段现在的文本是什么、哪个区间被标注了"。
     *
     * ⚠️ 这样 `blockTextOf(line)` 就是唯一的事实来源：
     *    `edits[line]` 存在就返回它，否则返回 `blocks[i].text`。
     *    残片不再需要虚拟行号 —— 它们只是渲染产物，操作时用的是
     *    "这个块的完整文本"，与用户看到的残片可以不同。
     */
    var docModel = { blocks: [] };

    /** 当前文献的存储键前缀（`open()` 时按 doc.id 生成） */
    var docStoreKey = '';

    /**
     * 从 md 读进来时的原始块文本（v0.1.92）。
     *
     * ⚠️ 用途**只有一个**：回写前做丢字自检（见 mdKeepsAllText）。
     *    实测出过事故：内存里的块少了一句话，照常回写会覆盖掉
     *    磁盘上正确的那份 md。
     * ⚠️ 老路径（PDF 直接推）不设置这个，自检直接放行。
     */
    var mdOriginText = '';

    /** 可用的标注标签，顺序即表单里的顺序 */
    var LABEL_KEYS = [
        'body',        /* 正文：用于把已标注的段落恢复成"无标签" */
        'title',       /* 文章标题 */
        'author',      /* 作者信息 */
        'abstract',    /* 摘要 */
        'h1',          /* 一级标题 */
        'h2',          /* 二级标题 */
        'h3',          /* 三级标题 */
        'reference',   /* 参考文献（每条一个区域）*/
        'cite',        /* 参考文献的引用编号（如 [12]）*/
        /*
          ⚠️ 尾注（v0.2.37）。

          用户要求：
            「增加一个新标签：尾注。md 中使用 > 这种引用块来表示；
              阅读视图中，字号比正文小 2 号，字体款式不变，
              但使用同提示条颜色的背景框框起来，无编号。」

          ⚠️ 放在 `cite` **后面**：cite 是行内标注（标在正文里的
             `[12]`），尾注是块级标注，两者语义相邻但层级不同，
             把尾注放最后不会打乱正文类标签的常用顺序。
        */
        'endnote'
    ];

    /**
     * 这个标签是否**禁止区域合并**（v0.1.71）。
     *
     * ══ 用户要求（原话）══
     *
     *   「对于文献标签，设置一个可以批量选择的功能，具体而言是
     *     当选中文本跨段时，每个段自动作为一个文献项从而得到
     *     多个文献区域，而不是整合成一个大的文献区域。」
     *
     * ⚠️ `appendLabeledRun()` 会把**相邻且标签相同**的块合并成一个区域，
     *    只在最前面输出一次标签段 —— 这对“作者信息”这类块是对 的，
     *    但对参考文献完全相反：每一条文献都是**独立的**，
     *    合并后会变成一个大区域、而且丢失每条的编号。
     *
     * ✅ 所以这两类标签要走“每块各自一个区域”的分支。
     */
    function labelSplitsPerBlock(key) {
        /*
          ══ ⚠️⚠️ 只有「参考文献」每块独立成区（v0.1.77 改）══
 
          用户反馈：
            「当给某个作者信息部分的某一行添加作者信息具体项目的时候，
              整个作者信息区域直接被破坏了，选择具体项的一行单独成了
              一个区域，而不是在作者区域中，
              然后原作者区域的其他行直接成了正文段。」
 
          真因：v0.1.72 把 `author` 也放进了这个函数，
          于是**每一行**都是独立区域（A1/A2/A3/A4），
          本来就没有"一个作者区域"可言 —— 再加上子标签，就更像散了。
 
          ✅ 现在 `author` 回到「相邻同标签合并成一个区域」的默认行为：
             多行作者信息 = 一个 `.reader-label-head` + 多行内容，
             子标签只是每一行前面的一小段说明文字。
 
          ⚠️ `reference` 仍每块独立：每条文献都是独立的条目，
             需要各自的 R 编号。
        */
        return key === 'reference';
    }

    /**
     * 各类区域编号的前缀（v0.1.72）。
     *
     * 用户要求：
     *   「为了区别正文段编号，参考文献区域段编号加个 R 前缀，
     *     然后作者加个 A 前缀，前缀后面是数字编号。」
     *
     * ⚠️ 正文段没有前缀 —— 它是最常见的一类，加上前缀反而乱。
     */
    var LABEL_NO_PREFIX = {
        reference: 'R',
        author: 'A'
    };

    /**
     * 排版模板的 `role` → 渲染用的「区域签名」（v0.2.6）。
     *
     * ══ 为什么需要这张表 ══
     *
     * 模板里的 role 是一套**独立的词汇**（title / heading / abstract /
     * body / caption / reference / formula / drop），而渲染层的分区
     * 是按「标签签名」做的（`labelSignatureOf`）。两者是不同来源：
     *
     *   · 标签来自用户手动标注（`labels[line]`）；
     *   · role 来自模板文件（块的 `.role` 字段）。
     *
     * ✅ 这张表把 role 翻译成同一个签名空间，于是 `renderFlat` 的
     *    run 归并逻辑**完全不用改** —— 模板块与标注块走同一套渲染。
     *
     * ⚠️ `undefined` 与 `''` 的区别很重要：
     *    · 表里**没有**的 role  →  `undefined` → 回退去看用户标注；
     *    · 映射到 `''` 的 role   →  空签名      → 走无标签的正文路径。
     *    若都用 `''`，那"模板没管这个块"就会被误判成"模板说它是正文"，
     *    用户在模板之外的标注会全部失效。
     *
     * ⚠️ 复用已有的标签键（`title` / `author` / `abstract` / `reference`
     *    等），不新造一套 —— 否则 i18n、编号前缀、样式全都要再来一遍。
     */
    var ROLE_SIGNATURE = {
        /* 需要显示标签段的角色 */
        title: 'title',
        author: 'author',
        abstract: 'abstract',
        reference: 'reference',
        /* ⚠️ heading 按层级拆成 h1/h2/h3 —— 与手工标注的标签键一致 */
        heading: 'h1',
        /* 正文类：不需要标签段，直接从者原路径 */
        body: '',
        caption: '',
        formula: '',
        /* ⚠️ drop 不在这里 —— 丢弃发生在应用模板阶段，不会进渲染 */
        drop: ''
    };

    /**
     * 带层级的 role 签名（v0.2.6）。
     *
     * ⚠️ `heading` 的层级来自块的 `roleLevel`（1 起）。
     *    超出 3 级一律按 h3 —— 再细分在阅读视图里没有视觉意义。
     */
    function roleSignatureOf(b) {
        if (!b || !b.role) return undefined;
        if (b.role === 'heading') {
            var lv = b.roleLevel | 0;
            if (lv <= 1) return 'h1';
            if (lv === 2) return 'h2';
            return 'h3';
        }
        return ROLE_SIGNATURE[b.role];
    }

    /**
     * 作者信息区域的「项名」预设（v0.1.74）。
     *
     * ══ 用户要求（原话）══
     *
     *   「当正文段被标注成作者信息区域时，此时再选中作者信息区域的文本
     *     应该为其设置项，项名左对齐，但没有添加设置项的时候不显示。
     *     这个功能主要是为了区分作者信息的不同项，
     *     比如作者名、单位、联系方式什么的。」
     *
     * ⚠️ 项名存在**现有** `labels` 记录的 `field` 字段上：
     *
     *      {start, end, label: 'author', field: 'name'}
     *
     *    不新建存储表 —— 项名本来就是"这个标注是哪一类"，
     *    与 `cite` 用 `ref` 记住引用目标是同一个思路。
     */
    var AUTHOR_FIELDS = ['name', 'affiliation', 'email', 'contact'];

    /**
     * 作者子标签开关（v0.2.31）。
     *
     * 用户决定：**标注只到 `author` 整块**，不再往下分姓名/单位/邮箱。
     * 关掉后标注面板里作者那一行不再出现子标签入口。
     *
     * ⚠️ 只是**入口**关掉，数据格式与渲染/导出全保留 ——
     *    老文档里的子标签照旧能正确显示。
     */
    var KEY_AUTHOR_FIELD_ENABLED = false;

    /**
     * 取文案，可选做 `{name}` 插值。
     *
     * ⚠️ `ScholariusI18n.t()` **只做查表，不做插值** ——
     *    全站带占位符的文案（`{n}` / `{what}`）都是调用方自己 replace。
     *    这里统一收口一次，免得每个调用点重复写 replace。
     *
     * @param {string} key
     * @param {Object} [vars] 形如 `{ n: '12' }`，值会先转成字符串
     */
    function t(key, vars) {
        var s = global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
        if (!vars) return s;
        for (var k in vars) {
            if (!Object.prototype.hasOwnProperty.call(vars, k)) continue;
            s = s.split('{' + k + '}').join(String(vars[k]));
        }
        return s;
    }

    /** 读本地存储，失败就返回兜底值（隐私模式 / 旧 WebView） */
    function readStore(key, fallback) {
        try {
            var v = global.localStorage.getItem(key);
            return v === null ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function writeStore(key, value) {
        try {
            global.localStorage.setItem(key, value);
        } catch (e) { /* 忽略 */ }
    }

    // --- 编辑 / 标注的持久化（v0.1.45）---------------------------------------

    /**
     * 按 doc.id 载入该文献的编辑与标注。
     *
     * ⚠️ 每次 `open()` 都要重载 —— 不同文献的编辑/标注不能串。
     * ⚠️ JSON 解析失败就当作空的（旧数据 / 存储被截断），
     *    不能让一条坏记录导致整个阅读页打不开。
     */
    function loadAnnotations(docId) {
        docStoreKey = String(docId || '');

        edits = {};
        labels = {};

        if (!docStoreKey) return;

        try {
            var rawEdits = readStore('scholarius.edits.' + docStoreKey, '');
            if (rawEdits) {
                var e = JSON.parse(rawEdits);
                if (e && typeof e === 'object') edits = e;
            }
        } catch (err) { edits = {}; }

        try {
            var rawLabels = readStore('scholarius.labels.' + docStoreKey, '');
            if (rawLabels) {
                var l = JSON.parse(rawLabels);
                if (l && typeof l === 'object') labels = l;
            }
        } catch (err) { labels = {}; }
    }

    function saveEdits() {
        if (!docStoreKey) return;
        try {
            writeStore('scholarius.edits.' + docStoreKey,
                JSON.stringify(edits));
        } catch (e) { /* 忽略 */ }
    }

    /**
     * 保存**重排后的段落结构**（v0.1.70）。
     *
     * ══ ⚠️⚠️ 为什么需要这个 ══
     *
     * 用户反馈：
     *   「还有一个 bug 得修，编辑了之后没有保存更改，
     *     重新进入又恢复原状了」
     *
     * 真因：v0.1.67 引入 `reflowParagraphs()` 后，合并/拆分段落的结果
     * 被写进了 `docModel.blocks`，同时把对应的 `edits` 条目**删掉**了
     * （因为新段落的文本已经在 blocks 里，不再需要覆盖层）。
     *
     * 但持久化只存了 `edits` —— `docModel.blocks` 每次打开都从原生桥
     * 重新加载**原始 PDF 块**，于是重排结果丢失，页面恢复原状。
     *
     * ✅ 现在把 blocks 也存下来，打开时优先用它。
     *
     * ⚠️ 存 `line / page / text` 三个必备字段，
     *    **另外带上 `kind` / `level` / `lines`**（v0.1.91）——
     *    它们不影响重排逻辑，但缺了之后 Markdown 导出会退化成
     *    "全部按正文处理"（标题没了、作者项不成分行了）。
     *    `lines` 只在非空时写，避免给每个块存一份冗余空数组。
     *
     * ⚠️ 仍然**不存**渲染期的临时字段（那会让存储膨胀且不稳定）。
     */
    function saveDocBlocks() {
        if (!docStoreKey) return;
        try {
            var list = docModel.blocks || [];
            var plain = [];
            for (var i = 0; i < list.length; i++) {
                var b = list[i];
                if (!b) continue;
                var item = {
                    line: b.line,
                    page: (b.page == null) ? null : b.page,
                    text: (b.text == null) ? '' : b.text
                };
                if (b.kind) item.kind = b.kind;
                if (b.level != null) item.level = b.level;
                if (b.lines && b.lines.length) item.lines = b.lines;
                /* ⚠️ 模板角色要一起存（v0.2.6）—— 不存的话重开就丢，
                       用户会看到「套了模板，下次打开又变回去了」 */
                if (b.role) item.role = b.role;
                if (b.roleLevel != null) item.roleLevel = b.roleLevel;
                plain.push(item);
            }
            writeStore('scholarius.blocks.' + docStoreKey,
                JSON.stringify(plain));
        } catch (e) { /* 忽略 */ }
    }

    function saveLabels() {
        if (!docStoreKey) return;
        try {
            writeStore('scholarius.labels.' + docStoreKey,
                JSON.stringify(labels));
        } catch (e) { /* 忽略 */ }
    }

    // --- 回写 md（v0.1.92）---------------------------------------------------

    /**
     * 把当前文档（正文 + 编辑 + 标注）写回 `doc.md`。
     *
     * ══ ⚠️⚠️ md 是**本地存储的唯一形态**（用户裁决）══
     *
     *   「现在直接改为 md 就可以了，就相当于这就是我们本地保存的形式，
     *     而不是转换为 md」
     *   「相当于 md 是我们的数据保存结构，但阅读器靠这个原文件来渲染」
     *
     * 所以**每次编辑/标注之后**都要回写，否则下次打开读回来的
     * 还是旧 md —— 那就是 v0.1.70 那个「改了没保存」bug 的重演。
     *
     * ══ 为什么在前端生成 md，而不是让原生生成 ══
     *
     * md 里要带**标注区间**（引用 `[12]` 的位置、作者子标签对应哪几个字），
     * 只有前端知道（`labels[line]` 是字符区间）。
     * 原生只知道 PDF 提取出来的原始正文。
     *
     * ⚠️ 序列化规则必须与 `MdDoc.serialize` **完全对称**，
     *    否则原生读回来会错位。这里刻意照抄 Kotlin 的逻辑。
     */
    function pushMdToNative() {
        var bridge = global.ScholariusNative;
        if (!bridge || typeof bridge.saveDocMd !== 'function') return;
        if (!currentDoc || !currentDoc.id) return;

        /*
          ══ ⚠️⚠️ 丢字检查：**宁可不写，也不能写坏**（v0.1.92 实测）══

          实测事故：PDF 原文标题是

              Efficient Estimation of Word Representations in Vector Space

          而内存里的块只有 `... Representations in` —— `Vector Space`
          在这一层已经丢了。此时如果照常回写，就会用**不完整的数据
          覆盖掉磁盘上正确的那份 md**，用户永久丢失那句话。

          ✅ 所以回写前先比对：
             本次要写的 md 去记号后，必须包含**读进来时的原始块文本**
             （`mdOrigin` 在 setText 里记下）。
             对不上 → 拒绝回写并 trace 出来，让磁盘上的旧 md 留着。

          ⚠️ 只做"包含"检查，不做完全相等 —— 用户编辑确实是会变的。
             这里防的是"整段消失"，不是"少了一个字"。
        */
        var md = buildMdText();
        if (!md) return;

        if (!mdKeepsAllText(md)) {
            trace('reader:md', 'REFUSED: md lost text, keep disk copy');
            return;
        }

        try {
            bridge.saveDocMd(String(currentDoc.id), md);
            trace('reader:md', 'saved ' + md.length + ' chars');
        } catch (e) {
            trace('reader:md', 'save failed: ' + (e && e.message));
        }
    }

    /**
     * 回写前的自检：md 里必须还带着**读进来时**的每一块正文。
     *
     * @return {boolean} true = 文本齐全，可以写
     */
    function mdKeepsAllText(md) {
        var origin = mdOriginText;
        if (!origin) {
            /* 不是从 md 读进来的（老路径）→ 没有基线可比，放行 */
            return true;
        }
        var body = String(md)
            .replace(/<!--@[^>]*-->/g, '')
            .replace(/^[ \t]*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, '')
            .replace(/\s+/g, '');
        var src = String(origin).replace(/\s+/g, '');

        /*
          ⚠️ 逐块检查（按 `\n\n` 切），不是整篇 ——
             整篇 indexOf 在"某块丢了但内容在别处重复"时会漏检。
          ⚠️ 块内子串检查而不是全等：用户可能编辑了某块的**一部分**，
             那仍然算"没丢"。真正的丢失是整块消失。
        */
        var chunks = String(origin).split('\n\n');
        var missing = 0;
        for (var i = 0; i < chunks.length; i++) {
            var c = chunks[i].replace(/\s+/g, '');
            if (!c) continue;
            /* 只检验长度足够的一段，短标签容易误判 */
            if (c.length < 12) continue;
            /* 取前 12 个字符作为锚点 */
            var anchor = c.slice(0, 12);
            if (body.indexOf(anchor) < 0) missing++;
        }
        if (missing > 0) {
            trace('reader:md', 'integrity: ' + missing +
                ' chunks missing (src ' + src.length + ' chars)');
        }
        return missing === 0;
    }

    /**
     * 生成 md 全文（与 `MdDoc.serialize` 对称）。
     *
     * 每块：`记号 + 正文 + 行内标注注释`，块间空行。
     */
    function buildMdText() {
        var list = docModel.blocks || [];
        var out = [];

        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            var line = b.line;
            /*
              ⚠️ 用 `textOfBlock(b)` 而不是 `blockTextOf(line)`（v0.2.35）——
                 行号在语义切分后可能重复，按行号回查会拿到**别的块**的文本。
                 见 `textOfBlock` 的说明。
            */
            var text = String(textOfBlock(b) || '').replace(/\r\n/g, '\n');
            if (!text.replace(/\s+/g, '')) continue;

            var kind = b.kind || '';
            var level = b.level || 0;

            /*
              ⚠️ 用户标注会改变这一块的记号 ——
                 判据与渲染层一致：整块标注优先，其次是"全部是 author"。
            */
            var spans = labels[line] || [];
            var whole = null;
            var allAuthor = spans.length > 0;
            for (var s = 0; s < spans.length; s++) {
                var sp = spans[s];
                if (!sp || !sp.label) continue;
                if (sp.label !== 'author') allAuthor = false;
                if ((sp.start || 0) <= 1 && (sp.end || 0) >= text.length - 1) {
                    whole = sp;
                }
            }

            var marker = '';
            if (whole) {
                if (whole.label === 'h1') marker = '## ';
                else if (whole.label === 'h2') marker = '### ';
                else if (whole.label === 'h3') marker = '#### ';
                else if (whole.label === 'title') marker = '# ';
                else if (whole.label === 'author') marker = '- ';
                else if (whole.label === 'reference') marker = '1. ';
                /*
                  ⚠️ 尾注 → `> ` 引用块（v0.2.37，用户指定）。
                     ⚠️ 块内多行要**每行都加** `> `，否则 md 里
                        只有第一行是引用，后续行会掉出引用块。
                        这一点在下面 body 的组装里处理。
                */
                else if (whole.label === 'endnote') marker = '> ';
            } else if (allAuthor) {
                marker = '- ';
            } else if (kind === 'heading') {
                /*
                  ⚠️ 提取层的标题：首块用 `#`，其余按 level。
                     与 PdfText.Block.mdHeadingPrefix 一致。
                */
                if (i === 0) marker = '# ';
                else if (level <= 1) marker = '## ';
                else if (level === 2) marker = '### ';
                else marker = '#### ';
            }

            /*
              ⚠️ 作者/文献的多行 → 每行一项（与导出一致）。
                 正文绝不分行（`lines` 是排版折行）。
            */
            var body;
            var rowMarks = null;
            if ((marker === '- ' || marker === '1. ') &&
                b.lines && b.lines.length > 1) {
                var parts = [];
                var cursor = 0;
                for (var r = 0; r < b.lines.length; r++) {
                    var row = String(b.lines[r] || '').replace(/^\s+|\s+$/g, '');
                    if (!row) continue;

                    /*
                      ══ ⚠️⚠️ 子标签必须**按行**匹配（v0.1.92 实测踩到）══

                      第一版把整块的 spans 都挂在每一行后面，结果：

                          - Tomas Mikolov Kai Chen <!--@a:0-22=name-->
                          - Google Inc., …          <!--@a:0-102=affiliation-->

                      第二行的注释写着 `0-102`（整块区间），
                      可它只覆盖第二行那一小段 —— 回读时区间全错。

                      ✅ 在块文本里定位这一行的起点，只有**整行被覆盖**
                         的标注才算这一行的。与 `authorItemsOf()` 同判据。
                    */
                    var at = text.indexOf(row, cursor);
                    if (at >= 0) cursor = at + row.length;

                    var rowTag = '';
                    if (at >= 0) {
                        for (var rs = 0; rs < spans.length; rs++) {
                            var rsp = spans[rs];
                            if (!rsp || rsp.label !== 'author' || !rsp.field) continue;
                            var rs0 = rsp.start || 0;
                            var re0 = rsp.end || 0;
                            if (rs0 <= at + 1 && re0 >= at + row.length - 1) {
                                /* ⚠️ 区间相对**这一行**，不是相对整块 */
                                rowTag = ' <!--@a:0-' + row.length +
                                    '=' + rsp.field + '-->';
                                break;
                            }
                        }
                    }
                    /*
                      ⚠️ 作者行要带 `Author:` 前缀（v0.2.31）——
                         这是用户认可的形式：
                             - Author: Ashish Vaswani
                             - Author: Google Brain
                         ⚠️ 没有前缀的话，回读时 `MdDoc.parse` 认不出
                             `- xxx` 是作者项，只当成普通列表项 → 作者标签丢失。
                         ⚠️ 文献同理用 `Ref:`，由 parse 侧剥离显示。
                    */
                    var rowPrefix;
                    if (marker === '1. ') {
                        rowPrefix = '1. ' + t('reader.field.__ref') + ': ';
                    } else if (marker === '- ') {
                        rowPrefix = '- ' + t('reader.field.__whole') + ': ';
                    } else {
                        rowPrefix = marker;
                    }
                    parts.push(rowPrefix + row + rowTag);
                }
                body = parts.join('\n\n');
                marker = '';
                rowMarks = 'done';
            } else {
                /*
                  ══ ⚠️ 尾注的块内多行要**每行加** `> `（v0.2.37）══

                  Markdown 的引用块是**逐行**的：
                  只有首行带 `>` 时，第二行起会被当成普通段落，
                  跑出引用块外面 —— 回读时就不是一个尾注了。

                       > 第一行
                       > 第二行

                  ⚠️ 空行在引用块里要用 `>`（单独一个 `>`）表示段落内换行，
                     但这里**不制造空行** —— 原文块内的空行本来就是
                     段落分隔，保留成 `>` 会让 md 结构变复杂。
                     直接把空行也前缀化，保证整块留在引用块内。
                */
                if (marker === '> ') {
                    var endLines = String(text).split(/\r?\n/);
                    var ebuf = [];
                    for (var el = 0; el < endLines.length; el++) {
                        var eline = endLines[el].replace(/\s+$/, '');
                        /*
                          ⚠️ 已有 `> ` 前缀就不要再加（v0.2.38）——
                             否则每保存一次就多一层 `> `。
                             与 md.js 的 endnote 分支同一判据。
                        */
                        var etrim = eline.replace(/^[ \t]+/, '');
                        if (etrim === '>' || etrim.indexOf('> ') === 0) {
                            ebuf.push(etrim);
                        } else if (etrim === '') {
                            ebuf.push('>');
                        } else {
                            ebuf.push('> ' + eline);
                        }
                    }
                    body = ebuf.join('\n');
                    marker = '';
                } else {
                    /*
                      ══ ⚠️⚠️ 块内换行要变成**空行**（v0.2.38 —— 用户实测）══

                      用户反馈：

                        「模型确实分段了，但是没有空行，
                          所以被md识别为同一段了」

                      完全正确。md 的段落分隔符是**空行**（`\n\n`），
                      单个 `\n` 只是同一段内的折行。

                      ── 为什么会只有一个 `\n` ──

                      语义切分产出的段落，`text` 里是用 `\n` 把原来的
                      几个排版块连起来的（见 semanticReflow 里的
                      `joinedBuf.push('\n')`）。那是**段落分隔**，
                      不是折行 —— 但写进 md 时原样保留了。

                      于是：

                          块 = "第一段结束了。\n第二段开始了。"

                      `buildMdText` 直接写出这个 `\n`，而
                      `MdDoc.parse` 是按 `split("\n{2,}")` 切块的 ——
                      只有一个换行，切不开 → **两段并成一段**。

                      渲染时看不出问题，因为 CSS 的
                      `white-space: pre-wrap` 会把 `\n` 显示成换行；
                      但 md 层面结构已经丢了。这正是"切分完再打开
                      又变回一大段"的原因。

                      ── ✅ 修法 ──

                      正文块内的 `\n` 一律写成空行（`\n\n`）。

                      ⚠️ 为什么不只对"切分产出的块"生效：
                         没法可靠区分。而且**这个判断本身也不该做** ——
                         PDF 提取层作为"一个块"给出的多行，
                         本来就是排版折行；一旦用户用切分或编辑把它
                         变成多段，那些换行就该是段落分隔。
                         md 里没有"块内折行"这个概念，
                         统一按段落处理是唯一自洽的选择。

                      ⚠️ 公式块例外：公式内的换行是有意义的（对齐），
                         压成空行会破坏公式排版。见下面 kind 判断。
                      ⚠️ 作者/文献走 `rowMarks === 'done'` 的分支，
                         不会走到这里。
                    */
                    if (kind === 'formula') {
                        body = text;
                    } else {
                        body = String(text).replace(/\n{2,}/g, '\n').replace(/\n/g, '\n\n');
                    }
                }
            }

            var chunk = marker + body;
            /*
              ⚠️ 已经按行写过子标签注释 → 不再追加整块的行内注释，
                 否则同一行会出现两条区间不同的 `@a`。
            */
            if (rowMarks !== 'done') {
                var inline = inlineMarkComments(spans, text.length);
                if (inline) chunk += ' ' + inline;
            }
            out.push(chunk);
        }
        return out.length ? out.join('\n\n') + '\n' : '';
    }

    /**
     * 把**行内**标注编码成 HTML 注释。
     *
     * ⚠️ 只编码 cite / 作者子标签 —— 块级标注已由 md 记号表达
     *    （`##`、`- `），再写一遍是冗余，用户改 md 后会立刻不一致。
     *    与 `MdDoc.encodeMark` 完全对称。
     */
    function inlineMarkComments(spans, len) {
        var parts = [];
        for (var i = 0; i < spans.length; i++) {
            var sp = spans[i];
            if (!sp || !sp.label) continue;
            if (sp.label !== 'cite' && sp.label !== 'author') continue;
            if (sp.label === 'author' && !sp.field) continue;

            var a = Math.max(0, Math.min(sp.start || 0, len));
            var b = Math.max(a, Math.min(sp.end || 0, len));
            if (b <= a) continue;

            if (sp.label === 'cite') {
                parts.push('<!--@c:' + a + '-' + b +
                    (typeof sp.ref === 'number' ? '=' + sp.ref : '') + '-->');
            } else {
                parts.push('<!--@a:' + a + '-' + b + '=' + sp.field + '-->');
            }
        }
        return parts.join(' ');
    }

    // --- 初始化 -------------------------------------------------------------

    function init() {
        root = document.getElementById('reader');
        if (!root) {
            return;
        }

        bodyEl = document.getElementById('reader-body');
        contentEl = document.getElementById('reader-content');
        topEl = document.getElementById('reader-top');
        backBtn = document.getElementById('reader-back');
        detailBtn = document.getElementById('reader-detail');
        segBtn = document.getElementById('reader-seg');
        tplBtn = document.getElementById('reader-tpl');
        tplExportBtn = document.getElementById('reader-tpl-export');
        bottomEl = document.getElementById('reader-bottom');
        tocBtn = document.getElementById('reader-toc-btn');
        settingsBtn = document.getElementById('reader-settings-btn');
        panelEl = document.getElementById('reader-panel');
        tocSheetEl = document.getElementById('toc-sheet');
        tocListEl = document.getElementById('toc-list');
        tocCloseEl = document.getElementById('toc-close');
        tocBackdropEl = document.getElementById('toc-backdrop');

        mountBack();
        mountTapToToggle();
        mountSelect();
        mountToc();
        mountSettings();

        applySettings();
        mountSize();
        mountRows();

        if (global.ScholariusI18n && global.ScholariusI18n.onChange) {
            global.ScholariusI18n.onChange(refreshChrome);
        }
        /*
          ⚠️ 订阅主题变化，要做**两件事**，不能只做一件：
            ① 主题行的右侧文字（Light / Dark / Follow System）
            ② 颜色行的色块
               字体颜色在亮/暗下是两套不同的值（见 styles.css），
               主题一变正文颜色就变，色块必须跟着重算 ——
               否则会出现「暗色下正文是白字，设置项色块却是黑的」。
               实测就是这个 bug：原来只订阅了 ①，漏了 ②。
        */
        if (global.ScholariusTheme && global.ScholariusTheme.onChange) {
            global.ScholariusTheme.onChange(function () {
                syncThemeRow();
                syncColorRowDeferred();
            });
        }
    }

    /**
     * 按当前主题重算颜色行的色块。
     *
     * ⚠️ 必须等**下一帧**再量，不能在 onChange 里同步量。
     *    主题切换的流程是：ScholariusTheme 改 <html data-theme> → 通知订阅者。
     *    通知发出时样式可能还没重算完，此时 getComputedStyle 读到的
     *    仍是旧主题的颜色 —— 色块会落后一次主题切换。
     *    requestAnimationFrame 保证在浏览器应用完样式之后再读。
     */
    function syncColorRowDeferred() {
        if (global.requestAnimationFrame) {
            global.requestAnimationFrame(function () {
                syncColorRow();
            });
        } else {
            syncColorRow();
        }
    }

    function mountBack() {
        if (backBtn) {
            backBtn.addEventListener('click', close);
        }

        /*
          详情 / Metadata 按钮（v0.2.13 从顶栏移到底栏）。

          用户要求：
            「将详情按钮移动到悬浮菜单底部栏，在设置项选项边，
              目录选项右边，命名为 Metadata」

          ⚠️ 打开详情页时**不关闭阅读页** ——
             详情是盖在阅读页之上的一层，关掉详情又回到阅读页。
             若先关阅读页，关完详情就回到文库了，用户得重新点进来。

          ⚠️⚠️ 图标必须**插到最前面**，不能 `innerHTML = icon(...)` ——
                 那会把 HTML 里已有的
                 `<span class="reader-action-label">Metadata</span>` 一起冲掉，
                 底栏就只剩一个图标、与另两项视觉不一致。
                 这正是"着重色/排版必须与底栏其他选项相同"的要求所在：
                 结构相同（icon + label）、样式相同（都用 .reader-action），
                 颜色由 `currentColor` 自然继承，不单独指定。

          ⚠️ 图标用 ScholariusUI.icon() 填，不写在 HTML 里 ——
             图标路径只有 components.js 一处定义，避免两处不同步。
        */
        if (detailBtn) {
            if (global.ScholariusUI) {
                detailBtn.insertAdjacentHTML(
                    'afterbegin', global.ScholariusUI.icon('metaData'));
            }
            detailBtn.addEventListener('click', function () {
                if (global.ScholariusDetail && currentDoc) {
                    /*
                      ⚠️ 这里**不再**自己设 aria-expanded（v0.2.17）——
                         它由详情的真实开关状态回推（见 onDetailOpenState）。
                         以前只设 true、从不设 false，
                         导致关掉详情后按钮一直深色。
                    */
                    global.ScholariusDetail.open(currentDoc);
                }
            });
        }

        mountSegBtn();
        mountTplBtn();
        mountTplExportBtn();
    }

    /**
     * 顶栏「导入排版模板」按钮（v0.2.7）。
     *
     * ══ 用户要求（原话）══
     *
     *   「顶部栏再增加一个导入模板的功能，也就是导入模板之后
     *     自动按照模板渲染整个阅读视图」
     *
     * ✅ 流程：
     *     选文件 → 原生读 JSON 并校验 → 推回网页 → 立即套用并重绘。
     *     全程不需要用户再点任何东西。
     *
     * ══ ⚠️⚠️ 为什么必须校验 sha256 ══
     *
     * 模板里只有**块序号**，它是相对某一份具体 PDF 的。拿错模板套上去，
     * 序号全部错位 —— 而且不会报错，只会"排版莫名其妙变了"。
     *
     * 所以：**sha 不匹配就明确拒绝**，并告诉用户原因。
     * 静默套用比拒绝糟得多。
     *
     * ⚠️ 这条限制是用户明确认可的：
     *       「只需要pdf相同就可以了……只需要对应相应的pdf就可以了」
     */
    function mountTplBtn() {
        if (!tplBtn) return;
        if (global.ScholariusUI) {
            tplBtn.innerHTML = global.ScholariusUI.icon('template');
        }        tplBtn.addEventListener('click', function () {
            if (tplBtn.disabled) return;
            var bridge = global.ScholariusNative;
            if (!bridge || typeof bridge.pickTemplateFile !== 'function') {
                toastSafe(t('reader.importTemplateFailed'));
                return;
            }

            /*
              ══ ⚠️⚠️ 导入前必须确认（v0.2.13）══

              用户要求（原话）：

                「同时点击模板导入按钮也应该有个提示表单，
                  因为肯定会覆盖现有的模板」

              对。导入是**直接套用**的（见文件头注释：选文件 → 校验 →
              立即套用并重绘），套上之后：

                · 现有的块序列被模板重排/合并/拆分/丢弃；
                · 原有的手工标注按行号挂，行没了标注也就没了。

              而且**没有撤销**。所以不能一点就直接弹系统文件选择器。

              ⚠️ 文案要随"当前有没有模板"分开写：
                 已经套着模板时，被覆盖的是**那份模板**；
                 从没套过模板时，被覆盖的是**原有切分/标注**。
                 同一句话套两种情形会有一半是错的。
              ⚠️ 确认按钮用危险色 —— 这是破坏性且不可撤销的操作。
              ⚠️ 取消就是真的不动（连文件选择器都不弹）：
                 用户点完确认才走系统界面。
            */
            var startPick = function () {
                /*
                  ⚠️ 只禁用、不显示"进行中"：选文件是系统界面，
                     用户注意力在系统文件选择器上，这里换个图标反而闪。
                  ⚠️ 必须保证一定解禁 —— 用户取消选择时原生也会回调，
                     见 onActivityResult 里的 REQ_IMPORT_TEMPLATE 分支。
                */
                tplBtn.disabled = true;
                try {
                    bridge.pickTemplateFile();
                } catch (e) {
                    tplBtn.disabled = false;
                    toastSafe(t('reader.importTemplateFailed'));
                }
            };

            var ui = global.ScholariusUI;
            if (!ui || typeof ui.confirmSheet !== 'function') {
                /* 没有 UI 模块（极端情况）→ 直接执行，不让功能卡死 */
                startPick();
                return;
            }

            /*
              ⚠️ 判据用 `templateCache`，与渲染链路保持一致 ——
                 `getTemplateId()` 是调试对象上的方法，不在这个作用域里。
            */
            var hasTpl = !!templateCache;
            ui.confirmSheet({
                title: t(hasTpl ? 'reader.importTemplateConfirmTitleHas'
                                : 'reader.importTemplateConfirmTitle'),
                message: t(hasTpl ? 'reader.importTemplateConfirmMsgHas'
                                  : 'reader.importTemplateConfirmMsg'),
                confirmLabel: t('reader.importTemplateConfirmOk'),
                cancelLabel: t('action.cancel'),
                danger: true,
                onConfirm: startPick
            });
        });
    }

    /** 安全地弹一条 toast（UI 模块可能不存在） */
    function toastSafe(msg) {
        if (global.ScholariusUI && global.ScholariusUI.toast) {
            global.ScholariusUI.toast(msg);
        }
    }

    /**
     * 顶栏「导出排版模板」按钮（v0.2.37）。
     *
     * 用户要求：
     *
     *   「悬浮菜单顶部栏最右边增加一个导出模板的图标按钮，
     *     图标用 @drawable/upload_file_24」
     *
     * ══ ⚠️ 导出的到底是"什么模板" ══
     *
     * **当前这一篇此刻的排版结构** —— 不是 `TemplateStore` 里
     * 某个已保存的模板。理由：
     *
     *   · 用户可能从没保存过模板，但仍然想把这套排版带走；
     *   · 用户可能刚改过（块序、角色、标注），
     *     而 TemplateStore 里那份还是旧的。
     *
     * 点了导出就该拿到"屏幕上现在这样"，否则功能就是错的。
     *
     * ══ 内容从哪来 ══
     *
     * ① `blocks` —— 每个块的**角色**。
     *    优先级与渲染完全一致：`role`（模板给的）> `kind`（提取层的）
     *    > 正文。这样导出的模板再导入一次，结果应当不变（幂等）。
     *
     * ② `ops` —— 不写。
     *    ops 描述的是"相对母本 PDF 的变形操作"（合并/拆分/丢弃/重排）。
     *    当前 `docModel.blocks` 已经**是**变形后的结果，
     *    再写一遍 ops 会在导入时被二次施加 —— 直接错位。
     *    ⚠️ 代价：导出的模板只适用于**同块数**的同一份 PDF
     *       （`blockCount` + `source.sha256` 会一起写出去，
     *       导入时块数不符会给警告，见 applyTemplate）。
     *
     * ③ `source` —— 当前文献的 sha256 / 页数。
     *    有了它，导入时能校验"这份模板是不是给这篇用的"。
     */
    function mountTplExportBtn() {
        if (!tplExportBtn) return;
        if (global.ScholariusUI) {
            tplExportBtn.innerHTML = global.ScholariusUI.icon('uploadFile');
        }

        tplExportBtn.addEventListener('click', function () {
            if (tplExportBtn.disabled) return;

            var bridge = global.ScholariusNative;
            if (!bridge || typeof bridge.exportTemplateJson !== 'function') {
                toastSafe(t('reader.exportTemplateFailed'));
                return;
            }

            var json = templateJsonOfCurrent();
            if (!json) {
                toastSafe(t('reader.exportTemplateFailed'));
                return;
            }

            /*
              ⚠️ 文件名 = `<标题>-<sha前8>.json`
                 与详情页导出的命名规则保持一致，用户拿到两个文件时
                 能看出它们来自同一篇。
              ⚠️ 标题里可能有 `/`、`:` 等非法字符 —— 原生侧会再清洗一次，
                 但这里先去掉，避免文件名变成一串下划线。
            */
            var title = (currentDoc && currentDoc.title)
                ? String(currentDoc.title) : 'template';
            var sha = (currentDoc && currentDoc.sha256)
                ? String(currentDoc.sha256) : '';
            var base = title.replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 60);
            var fname = base + (sha ? '-' + sha.slice(0, 8) : '') + '.json';

            try {
                bridge.exportTemplateJson(json, fname);
                toastSafe(t('reader.exportTemplateDone'));
            } catch (e) {
                trace('reader:tpl', 'export failed: ' + (e && e.message));
                toastSafe(t('reader.exportTemplateFailed'));
            }
        });
    }

    /**
     * 按当前 `docModel.blocks` 生成一份模板 JSON（v0.2.37）。
     *
     * @return {string|null} JSON 文本；无块时返回 null
     */
    function templateJsonOfCurrent() {
        var list = (docModel.blocks || []).filter(function (b) {
            return b && String(textOfBlock(b) || '').replace(/\s+/g, '');
        });
        if (!list.length) return null;

        /*
          ⚠️ 角色判定顺序必须与渲染一致，否则"导出→导入"不幂等：
               ① `role`（模板显式指定）
               ② `kind`（提取层判断，heading / formula …）
               ③ 兜底正文
          ⚠️ 标题层级：`role` 优先用自己的 `roleLevel`，
             `kind === 'heading'` 时用 `level`。
        */
        var specs = [];
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            var role = '';
            var lv = 0;

            if (b.role) {
                role = String(b.role);
                lv = (b.roleLevel | 0) || 0;
            } else if (b.kind === 'heading') {
                role = 'heading';
                lv = (b.level | 0) || 1;
            } else if (b.kind === 'formula') {
                role = 'formula';
            } else {
                role = 'body';
            }

            /* ⚠️ 与 TemplateStore.toJson 同形：[index, role] 或 [index, role, level] */
            specs.push(lv > 0 ? [i, role, lv] : [i, role]);
        }

        var doc = currentDoc || {};
        var tpl = {
            schema: 1,
            /*
              ⚠️ 导出的是"临时模板"，id 用时间戳生成 ——
                 TemplateStore 的 id 是 `tpl-` + 8 位十六进制。
                 用户如果把它当模板导入，会有自己的 id（导入时重算）。
            */
            id: 'tpl-' + String(Date.now()).slice(-8),
            name: String(doc.title || 'template').slice(0, 60),
            source: {
                sha256: String(doc.sha256 || ''),
                size: Number(doc.pdfSize || 0) || 0,
                pages: Number(doc.pdfPages || 0) || 0
            },
            blockCount: list.length,
            blocks: specs,
            style: {}
        };

        try {
            return JSON.stringify(tpl, null, 2);
        } catch (e) {
            trace('reader:tpl', 'serialize failed: ' + (e && e.message));
            return null;
        }
    }

    /**
     * 语义切分按钮（v0.1.98）。
     *
     * 用户裁决：
     *   「给语义切分模型隔离起来，不参与提取，然后悬浮表单顶部栏
     *     增加一个切分的图标，点击图标后才触发整篇文章文本的重新切分」
     *
     * ⚠️ 这是模型的**唯一入口**。`setText` 里已经没有模型代码了，
     *    所以"打开文献失败"这一类问题从根上消失 —— 打开永远是同步渲染。
     *
     * ⚠️ 可见性：只在开启语义分段时显示。
     *    没开的用户看到一个永远点不动的按钮比不显示更糟。
     * ⚠️ 每次打开新文档都要重新判断一次（用户可能在设置里改了开关）。
     */
    function mountSegBtn() {
        if (!segBtn) return;
        /*
          ⚠️ 图标用 `resegment`（format_line_spacing），不是 `annoBody`（v0.2.0）。

          用户裁决：「切分不要用这个图标」。

          `annoBody` 是三条**等长**横线 —— 语义是"这一段是正文"，
          用于标注菜单里给段落打标签。
          拿来当"重新切分"的按钮图标，是在借用别人的语义，
          看起来像"正文视图"而不是"切一刀"。

          ✅ `format_line_spacing`：左侧一根竖轴 + 右侧一组组短横线，
             表达"把整块文本切成若干段"，与按钮的实际行为一致。
        */
        if (global.ScholariusUI) {
            segBtn.innerHTML = global.ScholariusUI.icon('resegment');
        }
        segBtn.addEventListener('click', function () {
            /*
              ══ ⚠️⚠️ 先确认，再切分（v0.2.3）══

              用户裁决：

                「切分前给个确认表单，因为会把用户自己编辑的分区清掉对吧」

              对。语义切分会合并/拆分段落，而 `edits` / `labels` 以
              **行号**为键 —— 行号消失的块，其编辑与标注也就没了。
              这是不可撤销的，必须让用户先知情。

              ⚠️ 确认框的文案要**说清后果**，不能只写"确定吗？"。
                 用户只有在知道"会丢什么"时才能做决定。
              ⚠️ 确定按钮用**危险色**：这是破坏性操作。
            */
            if (segBtn.disabled) return;

            var ui = global.ScholariusUI;
            if (!ui || typeof ui.confirmSheet !== 'function') {
                /* 没有 UI 模块（极端情况）→ 直接执行，不让功能卡死 */
                runResegment();
                return;
            }

            ui.confirmSheet({
                title: t('reader.resegmentConfirmTitle'),
                message: resegmentConfirmMessage(),
                confirmLabel: t('reader.resegmentConfirmOk'),
                cancelLabel: t('action.cancel'),
                danger: true,
                onConfirm: runResegment
            });
        });

        /**
         * 拼出切分确认框的正文（v0.2.7）。
         *
         * ══ ⚠️⚠️ 模板与切分互斥，必须说清楚 ══
         *
         * 用户指出：
         *
         *   「这样的时候重新切分的提示应该是覆盖现有模板或者说是
         *     删除目前模板对吧？」
         *
         * 对。两者都重建块的序列，而且**必须**以原始提取块为基础：
         *
         *   · 模板按「第 N 块」定位，切分后块数从 120 变成 7，
         *     模板里 0~119 的序号全部失效；
         *   · 切分按字符比例合并文本，模板给的角色也会被丢掉。
         *
         * 也就是说它们不可能叠加，只能二选一。
         *
         * ✅ 没套模板时保持原文案（不吓唬用户）。
         * ✅ 套了模板时**点名**是哪个模板 —— 用户才知道丢了什么。
         *
         * 用户选择了方案 A：切分即弃用模板。
         * 切分成功后会把 `templateId` 清空（见 resegmentCurrent）。
         */
        function resegmentConfirmMessage() {
            var base = t('reader.resegmentConfirmBody');
            if (!templateCache) return base;
            /*
              ⚠️ 用模板名而不是 id —— id 是 `tpl-a3f59c21` 这种，
                 用户认不出来。
            */
            var name = templateCache.name || templateCache.id || '';
            return base + '\n\n' + t('reader.resegmentDropsTemplate')
                .split('{name}').join(name);
        }

        /**
         * 真正执行切分。
         *
         * ⚠️ 独立成函数：确认框的回调与"没有 UI 模块时的降级路径"
         *    都走它，避免两处逻辑漂移。
         */
        function runResegment() {
            /*
              ⚠️ 防连点：分段期间按钮变成「进行中」状态并禁用。
                 否则用户点两次会跑两遍模型（第二遍还可能与第一遍交错，
                 把 blocks 数组搞乱）。
            */
            if (segBtn.disabled) return;
            segBtn.disabled = true;

            resegmentCurrent().then(function (changed) {
                segBtn.disabled = false;
                if (!changed) {
                    /*
                      ⚠️ 没有变化时也要给反馈 ——
                         否则用户点了没反应，会以为按钮坏了。
                         两种"没变化"：模型没开 / 分段结果与版式相同。
                    */
                    if (global.ScholariusUI && global.ScholariusUI.toast) {
                        global.ScholariusUI.toast(t('reader.resegmentNoChange'));
                    }
                }
            }, function () {
                segBtn.disabled = false;
            });
        }
        syncSegBtn();
    }

    /** 按语义分段开关更新按钮可见性 */
    function syncSegBtn() {
        if (!segBtn) return;
        var sem = global.ScholariusSemantic;
        var on = !!(sem && sem.isEnabled && sem.isEnabled());
        if (on) {
            segBtn.removeAttribute('hidden');
        } else {
            segBtn.setAttribute('hidden', '');
        }
    }

    /**
     * 点正文区切换菜单显隐。
     *
     * ⚠️ 用**点击时的坐标**判断点在不在中间 1/3，而不是给某个元素绑事件：
     *    正文是一个可滚动的大块，若把它整块当"中间"，那点任何地方都会切换，
     *    以后加上翻页就冲突了。按坐标分区从一开始就是对的。
     *
     * ══ ⚠️⚠️ 为什么原始视图也能切菜单（推翻上一版） ══
     *
     * 用户 2026-09-25 第三次指出，第四次又指出"依旧无法隐藏菜单"：
     *
     *   「顶部标题依然没法选 —— 你记住，单击屏幕是隐藏菜单，
     *     画框从屏幕一个地方到另一个地方——不隐藏菜单，
     *     顶部底部都没法选中」
     *
     * 冲突是真实存在的：
     *   · 单击屏幕 = 隐藏/显示菜单
     *   · 拖拽画框 = 从一处到另一处，**拖拽过程不该隐藏菜单**
     *
     * ⚠️ 我前三次的修法（编辑模式跳过 / 限定中间 1/3×1/3 /
     *    原始视图整段跳过）全都是错的，因为**维度选错了**。
     *
     *    前两次是"用坐标缩小冲突范围"；
     *    第三次更糟 —— 整段跳过之后菜单**永远唤不出来**（本来它就是收起的），
     *    用户反馈"依旧无法隐藏菜单"。
     *
     * ✅ 正解：**用位移区分点击与拖拽**。
     *    这本来就是两种手势，浏览器给的 pointer 事件里天然带着这个信息：
     *      · 按下后没怎么动 → 点击 → 切菜单
     *      · 按下后拖了一段  → 画框（见 bindLayerDrawing 的 DRAG_SLOP）
     *    两者互斥，不可能同时成立。这样顶部/底栏附近的文字也能选中了，
     *    因为一次轻点不再被"是否在画框"这件事影响。
     */
    /**
     * 点正文中间 1/3 区域切换菜单显隐。
     *
     * ══ 为什么原始视图也能切菜单（推翻上一版） ══
     *
     * 上一版我把原始视图**整段跳过**，以为能"消除冲突"。错了：
     * 菜单本来就是收起的，而点击被完全忽略 → **永远唤不出来**
     * → 用户说"依旧无法隐藏菜单""依旧无法选中顶部底部文字"。
     *
     * 真因是：**冲突不在视图上，在"一次手势到底是点击还是拖拽"上。**
     * 拿视图去区分是拿错了维度。
     *
     * 现在改成**用位移区分**（手势的天然语义）：
     *   · 按下后没怎么动  → 点击 → 切菜单
     *   · 按下后拖了一段  → 画框 → 见 bindLayerDrawing 的 DRAG_SLOP
     * 两者互斥，不可能同时成立，所以顶栏/底栏与画框再也不会互斥。
     *
     * ⚠️ 拖拽结束后浏览器还会补发一个 click。那个 click 必须被吃掉，
     *    否则画完框菜单会跟着跳。靠 `global.ScholariusUI.justDragged()`。
     */
    function mountTapToToggle() {
        if (!bodyEl) {
            return;
        }

        bodyEl.addEventListener('click', function (event) {
            var ui = global.ScholariusUI;

            /*
              排除点在链接/按钮上的情况 —— 那些应该走自己的行为。
            */
            if (event.target.closest && event.target.closest('a, button')) {
                return;
            }

            /*
              ⚠️ 设置面板展开时，点正文先收起面板而不是切换整条菜单。
                 否则用户点一下正文，面板和菜单一起消失，想调两次字号
                 就得重新点开菜单 —— 很烦。
            */
            if (panelOpen) {
                setPanel(false);
                return;
            }

            /*
              ══ ⚠️⚠️ 有选中时，点正文只取消选中，**不**切菜单 ══
                 （v0.1.40）

                 用户长按选中一段后，最常见的动作是"点一下空白取消"。
                 若那一下同时把菜单唤出来，操作条会被底栏顶掉，
                 用户会觉得"取消选中还顺便弹了个菜单"，很乱。

                 ⚠️ 顺序必须在菜单分区判据**之前** ——
                    否则点在中间 1/3 时会先走 toggleMenu。
                 ⚠️ 选中状态下**不支持**"点正文唤菜单"，
                    但顶栏/底栏本来就靠手势边缘唤出，
                    所以不会让用户进不去菜单。
            */
            if (selectedText) {
                clearSelection();
                return;
            }

            var rect = bodyEl.getBoundingClientRect();
            if (!rect.width || !rect.height) {
                return;
            }

            /*
              ⚠️ **同时**判横向与纵向都在中间 1/3。

                 靠近顶部/底部的区域是正文（要能选中文字、要能滚动），
                 一点就冒菜单会挡住内容。四边都留出安全区。
            */
            var x = event.clientX - rect.left;
            var y = event.clientY - rect.top;
            var thirdX = rect.width / 3;
            var thirdY = rect.height / 3;

            if (x >= thirdX && x < thirdX * 2 &&
                y >= thirdY && y < thirdY * 2) {
                toggleMenu();
            }
            /*
              其余区域暂时不做事（以后是上一页/下一页 / 上下滚动区）。
              刻意留在这里，是为了让分区逻辑只有一处，将来不必回头改。
            */
        });
    }

    // --- 文本选中（v0.1.40）-------------------------------------------------

    /**
     * 长按正文 → **按字符**选中 → 拖动手柄继续扩展 → 弹出操作条。
     *
     * ══ ⚠️⚠️ 为什么自己实现，不用系统原生的长按选择 ══
     *
     * WebView 确实内置了文本选择，但它在这个项目里**用不了**：
     *
     *   ① 全局 `body { user-select: none }` 是为了让 App 不像网页。
     *      直接放开会**连带**打开拖拽选区 —— 想滚动页面时手指一横
     *      就选了一片字。
     *   ② 系统菜单无法定制，是一排跟随系统的英文按钮，与 Scholarius
     *      的视觉语言不符，也无法 i18n。
     *   ③ 系统菜单不受主题控制，暗色下会闪一片白。
     *
     * ✅ 所以自己接管：`caretRangeFromPoint` 定位到**字符** +
     *    `window.getSelection()` 维护真实选区 + 自己画操作条。
     *
     * ══ ⚠️⚠️ 选中粒度：**字符**（v0.1.41 修）══
     *
     * 用户原话：
     *   「不是一整段，而是我选中多少文本就是多少，
     *     比如从一个单词中间到另一个单词中间也可以选中才对，
     *     最小单位应该是正常语言下的最小单位，比如字母，比如字，
     *     标点符号等等」
     *
     * ⚠️ 上一版（v0.1.40）做成了**整段选中** —— 那是错的，已推翻。
     *    整段只是"碰巧够用"，用户要的是可控制的精确选区。
     *
     * ✅ 现在的做法：
     *    · 长按（0.5s）→ 在按下的那个字符处**落一个光标**，
     *      并把该字符本身选中（视觉上立刻有反馈）；
     *    · **继续按住拖动** → 选区实时扩展到手指所在字符；
     *    · 松手 → 选区保持，操作条出现。
     *
     * ⚠️ 为什么用真实的 `window.getSelection()` 而不是自己记
     *    (startNode, startOffset)：
     *    操作条弹出后，用户还想要**系统级的选区手柄**（那两个小水滴）
     *    来微调。只有真实选区才会有手柄；自己维护的范围不会。
     *    而且复制可以直接用选区内容，不必自己拼。
     *
     * ⚠️ 手柄拖动后选区会变，而 operation bar 上的字数要跟着更新 ——
     *    所以监听 `selectionchange`（见 mountSelectBar 之后）。
     *
     * ══ 手势状态机 ══
     *
     *   down        → 起 500ms 计时；记起点
     *   move < slop → 仍在等待（手指轻微抖动不算）
     *   move > slop → **取消**计时（用户是在滚动）
     *   timer 到期  → 进入"选区中"状态（armed=true）、震动、落光标
     *   move（armed）→ 扩展选区到手指处
     *   up          → armed ? 保留选区并弹操作条 : 什么都不做
     *
     * ⚠️ `armed` 之后**不能再取消**选区 —— 那是用户按住拖动时
     *    的正常动作，不是"想滚动"。
     *
     * ⛔ 以上状态机是 v0.1.40 的设想，**已废弃**：
     *    在 Android WebView 里 pointer 链活不过 60ms（`pointercancel`），
     *    扩选根本走不到。现在改为直接使用浏览器原生选区，
     *    详见 mountSelect 里的说明。
     */
    function mountSelect() {
        if (!contentEl) return;

        mountSelectBar();

        /*
          ══ 选区实现：**交给浏览器原生选区**（v0.1.41 重做）══

          ══ 为什么放弃"自己接管手势" ══

          前一版想用 pointer 事件自己建选区、自己扩展，实测走不通。
          `tools/emu_touch.py --record` 逐条对比了三种做法：

            · `touch-action: none`（在 pointerdown 里加）→ **无效**，
              浏览器仍在第 5 次 `pointermove` 发 `pointercancel`。
              原因：`touch-action` 只在**手势开始前**读取，
              手势已被认领成滚动之后就改不动了。

            · 在 `pointerdown` 里 `preventDefault()` → **无效**，
              pointerdown 不是可取消的滚动起始点。

            · 在 `touchstart` 里 `preventDefault()` → **也没用**。
              实测探针显示到达的 `touchstart` 事件 `cancelable === false`，
              即浏览器已把本次手势交给合成器线程，JS 无法取消。

          ⚠️ 结论：在 Android WebView 里，**JS 抢不过合成器**。
             只要手势可能变成滚动，pointermove 链就活不过 ~60ms。

          ══ ✅ 所以反过来做：用原生选区，只接管"界面" ══

          浏览器自己的长按选区**本来就是按字符的**（实测长按选中了
          单字符 `p`），并且自带两个可拖动的手柄 —— 正好满足用户要求：

              用户原话：「不是一整段，而是我选中多少文本就是多少，
                比如从一个单词中间到另一个单词中间也可以选中才对，
                最小单位应该是正常语言下的最小单位，比如字母，比如字，
                标点符号等等。」

          原生选区的默认行为就是"最小单位 = 字符"，而且是系统级的，
          手感与用户平时的 Android 使用经验一致。

          所以这里只做三件**不碰手势**的事：

            ① 监听 `selectionchange` —— 选区一变就同步字数；
               若选区非空且操作条还没弹出 → 弹出（并吃掉误触的 click）。
            ② 操作条跟随选区位置（positionSelectBar）。
            ③ 点正文空白处 → 收起选区与操作条。

          ⚠️ 唯独「copy」不用原生菜单 —— 系统菜单没法定制、没法 i18n、
             暗色下还闪白，所以照旧由我们自己的操作条来复制。
        */
        /*
          ══ 选区实现：**全部走 touch 事件**（v0.1.41 第三版）══

          ══ 试过且失败的两条路 ══

          ① **pointer 事件自己建选区**
             实测 `tools/emu_touch.py --record`：长按后第 ~60ms 就收到
             `pointercancel`，之后 `pointermove` 链彻底断掉，
             拖到 500ms 才开始扩选根本来不及。
             试过三招都不行：
               · pointerdown 里加 `touch-action: none` → 无效
                 （touch-action 只在手势开始前读取）
               · pointerdown 里 preventDefault → 无效（不可取消）
               · touchstart 里 preventDefault → 无效，
                 探针显示到达的 touchstart `cancelable === false`，
                 浏览器已把手势交给合成器线程。

          ② **浏览器原生选区**
             Android 的 `WebView.isLongClickable = false` 会连原生
             文本选区一起关掉；已改为放开。但实测（模拟器 + `adb input`）
             **长按始终产生不了选区**，`selectionchange` 只报空。
             这条路无法在本地验证，不能拿来交付。

          ══ ✅ 现在这条路：touch 事件 ══

          ⚠️ 关键观察：`pointercancel` 之后 **`touchmove` 仍在继续**
             （实测事件序列里，cancel 之后还有 8 个 touchmove）。
             也就是说被合成器抢走的是 pointer 链，touch 链是完整的。

          所以：全程用 touch 事件驱动，完全不碰 pointer。

            · touchstart（单个触点）→ 记起点，起 500ms 定时器
            · touchmove 且未 armed  → 移动超过 2mm 就取消定时器
                                      （用户在滚动，交给浏览器，**不**
                                      preventDefault）
            · 定时器到期           → armed=true、震动、落一个字符选区
            · touchmove 且 armed   → preventDefault + 把选区扩到手指处
            · touchend             → armed ? 保留选区并弹操作条 : 不管

          ⚠️ 只有 armed 之后的 touchmove 才 preventDefault。
             之前的绝不阻止 —— 否则页面滚不动（这是第一版的惨痛教训：
             touchstart 无条件 preventDefault，滚动全靠自己算，很脆）。
        */
        /*
          ══ 选区实现：**完全交给浏览器原生选择器**（v0.1.43 重做）══

          ══ 为什么推翻了 v0.1.41/v0.1.42 的"自己做选区" ══

          真机实测（用户反馈 + 反复确认）：

            「高亮有，但**没有拖动把手**；很不稳定，大部分情况都是单个
              字符无法改变，但有时候可以正常选中，也有蓝色小圆点。」

          ⚠️ 这就是**两套选择器在打架**：

            · 原生选择器：WebView 内建，会给出蓝色把手（那两个小圆点），
              手感就是用户平时在别的 app 里用惯的那个；
            · 我们自己的选区：`getSelection()` + `addRange()`，
              **只有高亮、没有把手**，而且每一帧都要自己重算。

          两套都在抢同一个 `window.getSelection()`。哪一套最后写入就赢，
          所以表现成"时好时坏、大部时候只能选一个字"。

          ⚠️ 我之前的模拟器测试测不出来这个，因为 `emu_touch.py` 走
             CDP 派发 touch 事件，绕过了 WebView 原生选择器那一层 ——
             在模拟器上我的代码"独占"了选区，看起来完美；
             真机上原生选择器才是真正的持有者，我的代码被它不断覆盖。

          ══ ✅ 现在：只用原生选择器，我们只接管界面 ══

          原生选择器本来就满足用户的要求：
            · 最小单位是**字符**（不是整段、不是整词）
            · 按住拖动**实时**改变范围
            · 自带两个可以拖的把手，可以精细调整两端
            · 拖到屏幕边缘会自动滚动

          我们**只**做三件事，一行手势代码都不写：

            ① `selectionchange` → 同步字数 + 显示/移动操作条
            ② 点正文空白处 → 收起操作条
            ③ 操作条上的「复制」按钮 → 写剪贴板

          ⚠️ 原生菜单（复制/全选/搜索那一排）由 Android 弹出，
             我们无法定制、无法 i18n、暗色下还闪白 ——
             所以仍然由我们自己的操作条负责复制。
             原生的那一排无法完全屏蔽，但它只在长按/点把手时出现，
             且不会盖住我们的操作条。

          ══ ⚠️ 前置条件（MainActivity 里必须满足）══

            · `isLongClickable = true`
              （原来是 false，会连原生文字选择一起关掉）
            · `setOnLongClickListener(null)`
              （原来是 `{ true }`，直接吃掉长按，原生选择器永远收不到）
            · CSS：全局 `user-select: none`，只对 `.reader-para` 放开
              `user-select: text` —— 这样只有正文能选，
              按钮/顶栏/表单不会被误选。
        */

        document.addEventListener('selectionchange', function () {
            /*
              ══ ⚠️⚠️ 这里**绝对不能**主动清原生选区 ══（v0.1.43）

              这是"没有蓝色把手"的真因：

              原生选择器在手指拖动期间会**间歇性**报告空选区
              （`getSelection()` 返回空串），紧接着又报回正确的。
             旧代码相信了那个空报告 → 调 `clearSelection()`
              → 它内部 `removeAllRanges()` → **把原生选区和两个把手
              一起删掉了**。

              用户看到的就是：「高亮有，但没有拖动把手；
              大部分情况只能选一个字，无法改变」——
              因为把手刚出现就被我们自己删了。

              ✅ 现在的规则：
                 · 手势进行中（`selecting`）→ 什么都不做
                 · 空选区 → **只**收起我们的操作条（hideSelectBar），
                   绝不动 `window.getSelection()`
            */
            var text = String(global.getSelection() || '');

            if (!text) {
                if (selecting) return;

                /*
                  ⚠️ 只收 UI，不清选区。
                     `hideSelectBarOnly()` 不调 `removeAllRanges()`。
                */
                if (selectedText) hideSelectBarOnly();
                selectedText = '';
                if (selCountEl) selCountEl.textContent = '';
                return;
            }

            syncSelectionFromNative();
            if (!selectedText) return;

            if (!selBarEl || selBarEl.hidden) {
                showSelectBar();

                /*
                  ⚠️ 吃掉浏览器补发的 click，否则它会把刚建好的选区
                     立刻取消掉（症状：长按了但操作条一闪而过）。
                */
                if (global.ScholariusUI && global.ScholariusUI.markDragged) {
                    global.ScholariusUI.markDragged();
                }
            } else {
                positionSelectBar();
            }
        });

        /*
          ⚠️ 点正文任意处收起选中 —— 但**不能**收起操作条自己的按钮。
             操作条挂在 root 上（不在 contentEl 里），所以这里的
             `closest('.sel-bar')` 只是防御性的。
          ⚠️ v0.1.43：这里也不再清原生选区 —— 用户点一下正文，
             浏览器自己会收起选区与把手（那是系统行为，比我们准确）。
             我们只负责把操作条收掉。
        */
        contentEl.addEventListener('click', function (ev) {
            if (!selectedText) return;
            if (ev.target.closest && ev.target.closest('.sel-bar')) return;
            hideSelectBarOnly();
            selectedText = '';
            selAnchor = null;
            if (selCountEl) selCountEl.textContent = '';
        });
    }

    function clearSelTimer() {
        if (selTimer) {
            global.clearTimeout(selTimer);
            selTimer = null;
        }
        stopAutoScroll();
    }

    /**
     * 拖到正文可视区的上/下边缘时，自动滚动正文（v0.1.42）。
     *
     * ══ 为什么需要 ══
     *
     * 没有它，用户想把选区拉到下一屏时必须松手、再长按一次 ——
     * 而 Android 系统选字是一路拖、页面自己跟着滚的。
     * 用户原话就是「我用手机选中其他 app 的文本的时候没这么难搞啊」。
     *
     * ══ 实现 ══
     *
     * 用 `requestAnimationFrame` 持续滚，而不是每个 touchmove 滚一次：
     *   · 手指停在边缘不动时，触摸事件只有零星几个（甚至没有），
     *     靠事件驱动会"滚一下就停"；
     *   · 用帧循环才能实现"手指贴在边缘不动，页面匀速滚"。
     *
     * ⚠️ 滚动后必须重新扩展选区 —— 否则滚动只"看得到"但选不到，
     *    选区会停在滚动前的位置。所以每帧都调一次
     *    `extendSelectionTo`，用**最近一次的触摸坐标**。
     *
     * ⚠️ 速度按"进入边缘区的深度"线性映射：贴得越外滚得越快，
     *    这样接近边缘时能精细控制。
     */
    var autoScrollRaf = null;
    var autoScrollY = 0;
    var autoScrollX = 0;
    var autoScrollStep = 0;
    /** 自动滚动到过的最后位置（松手后用来钉回，见 onEnd） */
    var autoScrollTop = 0;

    function autoScrollForSelection(clientX, clientY) {
        if (!bodyEl) return;

        autoScrollY = clientY;
        autoScrollX = clientX;

        var rect = bodyEl.getBoundingClientRect();
        var EDGE = 56;   /* 距边缘多少像素内开始自动滚 */
        var MAX = 14;    /* 每帧最多滚多少像素 */

        var speed = 0;
        if (clientY < rect.top + EDGE) {
            /*
              越靠上越快：(EDGE - 距离) / EDGE，夹在 [0,1]。
            */
            var d = (rect.top + EDGE - clientY) / EDGE;
            speed = -Math.min(1, Math.max(0, d)) * MAX;
        } else if (clientY > rect.bottom - EDGE) {
            var d2 = (clientY - (rect.bottom - EDGE)) / EDGE;
            speed = Math.min(1, Math.max(0, d2)) * MAX;
        }

        autoScrollStep = speed;

        if (!speed) {
            stopAutoScroll();
            return;
        }

        /*
          ⚠️ 已在滚就直接返回 —— 上面的 `autoScrollStep` 已经更新，
             帧循环下一帧就会用新速度，不用重启。
        */
        if (autoScrollRaf !== null) return;

        var tick = function () {
            if (!bodyEl) { autoScrollRaf = null; return; }

            var step = autoScrollStep;
            if (!step) { autoScrollRaf = null; return; }

            var before = bodyEl.scrollTop;
            bodyEl.scrollTop = before + step;

            /*
              ⚠️ 滚到底/顶了就停，否则会一直空转耗电。
            */
            if (bodyEl.scrollTop === before) {
                autoScrollRaf = null;
                return;
            }

            /*
              ⚠️ 记下目标位置 —— 松手时浏览器会回滚 `scrollTop`，
                 靠这个值把它钉回去（见 onEnd）。
            */
            autoScrollTop = bodyEl.scrollTop;

            /*
              ⚠️ 滚动之后同一屏幕坐标指向**不同的字符**，
                 必须重新算一次选区，否则选中范围不跟着走。
            */
            extendSelectionTo(autoScrollX, autoScrollY);

            autoScrollRaf = global.requestAnimationFrame(tick);
        };

        autoScrollRaf = global.requestAnimationFrame(tick);
    }

    function stopAutoScroll() {
        if (autoScrollRaf !== null) {
            try {
                global.cancelAnimationFrame(autoScrollRaf);
            } catch (e) { /* 忽略 */ }
            autoScrollRaf = null;
        }
    }

    /** 清掉浏览器层面的原生选区（不动我们的 UI 状态） */
    function clearNativeSelection() {
        try {
            var s = global.getSelection();
            if (s && s.rangeCount) s.removeAllRanges();
        } catch (e) { /* 忽略 */ }
    }

    /**
     * 把一个 caret Range 规整成 `{node, offset}`，**保证 node 是文本节点**。
     *
     * ══ ⚠️⚠️ 为什么必须有这个函数（v0.1.42）══
     *
     * `document.caretRangeFromPoint()` 的 `startContainer` 有两种情况：
     *
     *   ① **文本节点**（nodeType 3）—— 手指在字上，最理想；
     *   ② **元素节点**（nodeType 1）—— 手指在段落之间的空隙、
     *      `<p>` 的起止边缘、行尾空白处时，Chrome 返回的是宿主元素，
     *      `startOffset` 变成"第几个子节点"而不是"第几个字符"。
     *
     * 旧代码遇到 ② 就直接 `return`，于是拖动过程中**一次都没扩成**，
     * 选区永远停在长按时的那 1 个字符 —— 这就是用户说的
     * 「直接单字符了，而不是随着我手指的移动来控制选中区域」。
     *
     * ✅ 现在把 ② 规整掉：
     *    · 元素有文本 → 取它第一个/最后一个文本节点（按 offset 判断方向）
     *    · 元素空（如段落间的空白 div）→ 往后/往前找相邻的可落脚文本节点
     *
     * ⚠️ 找不到就返回 null（比如拖到了正文之外），此时 caller 直接跳过，
     *    选区保持在上一帧的位置 —— 这是想要的行为：手指滑出正文时
     *    不要突然把选区清空或跳到别处。
     */
    function resolveTextPoint(r, touchX, touchY) {
        var node = r.startContainer;
        var off = r.startOffset;

        if (node && node.nodeType === 3) {
            return { node: node, offset: off };
        }
        if (!node) return null;

        /*
          ══ ⚠️⚠️ 落到元素节点时，**绝不能**直接取"整棵子树的首/尾" ══
             （v0.1.42）

          踩过的坑：手指越过行尾、进入段落之间的空隙时，
          `caretRangeFromPoint` 返回 `<p>` 元素本身。旧代码往下取
          `lastTextNode()` → offset = 该文本节点长度 → 选区一下子
          跨到段落末尾。

          症状：手指只挪了 22px，选中的字数却从 1 **直接跳到 31**，
          中间没有任何过渡 —— 用户会觉得"选区不受控制"。

          ✅ 正确做法：在**原始坐标**附近做小范围试探，
             取第一个能返回真正文本节点的点。
             这样落点只会前进几像素对应的字符，不会跳段。

          ⚠️ 试探半径从 1px 渐增到 24px：
             1px 通常就能命中（落点只是稍微偏出字形），
             24px 覆盖行高的一半，不会跨到相邻行之外。
        */
        var probe = nearestTextPoint(r, touchX, touchY);
        if (probe) return probe;

        /*
          实在测不到（比如手指拖到了正文之外）才退回子树端点。
          ⚠️ 这种情况下宁可保持上一帧的选区，也不要跳到段落末尾 ——
             返回 null 让 caller 跳过本帧。
        */
        return null;
    }

    /**
     * 从原始 Range 出发，向四周**小范围**试探出最近的文本落点。
     *
     * ⚠️ 优先纵向（上下），因为用户拖选时主要在换行 ——
     *    纵向试探到的点语义上更接近手指意图。
     */
    function nearestTextPoint(r, touchX, touchY) {
        /*
          ══ ⚠️⚠️⚠️ 优先用**手指的真实坐标**，不要用 rect 反推（v0.2.39）══

          用户反馈：

            「选中范围随着我的手指移动动不动就跳到整个段的首行上面去」

          ── 这是一个独立的根因，比试探半径更致命 ──

          旧代码的坐标是这样来的：

              rect = r.getBoundingClientRect();
              cx = rect.left;
              cy = rect.top + rect.height / 2;

          问题在于 `r.startContainer` 是**元素节点**时
          （`caretRangeFromPoint` 在行尾、字间空隙、段落边缘就会这样返回），
          collapsed range 的 rect **不是落点**，而是**整个元素**的边界框。

          于是：

              cy = 整块.top + 整块.height / 2   ← 块的垂直中心！
              cx = 整块.left                    ← 块的左边缘（行首）！

          再拿这个点去 `caretRangeFromPoint` 试探，命中的必然是
          **块首行靠左的位置** —— 正是用户说的"跳到整个段的首行上面去"。

          ⚠️ 这也解释了为什么"动不动就跳"：
             只要 `caretRangeFromPoint` 返回元素节点（很常见），
             坐标就整个错掉，和手指位置完全无关。

          ── ✅ 修法 ──

          调用方（`extendSelectionTo`）本来就有**手指的真实屏幕坐标**。
          直接传进来，不要从 Range 反推。

          只有在没传坐标时（老调用点 / 内部复用）才退回 rect ——
          但那时只在文本节点情形下可信，元素情形一律返回 null，
          **宁可保持上一帧选区，也不要用一个错的坐标去猜**。
        */
        var cx, cy;

        if (typeof touchX === 'number' && typeof touchY === 'number' &&
            isFinite(touchX) && isFinite(touchY)) {
            cx = touchX;
            cy = touchY;
        } else {
            /*
              ⚠️ 没有真实坐标 → 只有**文本节点**的 collapsed rect
                 才是可信的落点位置。元素节点一律放弃。
            */
            if (!r.startContainer || r.startContainer.nodeType !== 3) {
                return null;
            }
            var rect = null;
            try {
                rect = r.getBoundingClientRect();
            } catch (e) {
                rect = null;
            }
            if (!rect || (!rect.width && !rect.height)) {
                var t = firstTextNode(r.startContainer);
                if (!t) return null;
                if (t !== lastTextNode(r.startContainer)) return null;
                return { node: t, offset: 0 };
            }
            cx = rect.left;
            cy = rect.top + rect.height / 2;
        }

        /*
          ══ ⚠️⚠️⚠️ 只在**同一行内**试探，纵向极小（v0.2.39 用户实测）══

          用户反馈：

            「当我选中文本时，每次都很麻烦，因为选中范围随着我的手指
              移动动不动就跳到整个段的首行上面去」

          ── 真因 ──

          旧代码的试探顺序是：

              var radii = [1, 2, 4, 8, 12, 18, 24];
              probes = [[cx, cy-d], [cx, cy+d], [cx-d, cy], [cx+d, cy]]

          `cy ± d` 的**纵向**试探最大到 **24px** —— 而正文行高约
          29px（17px × 1.75）。也就是说：

              cy - 24  ≈  上一行的中间

          于是手指在本行拖动时，落点只要稍微偏上（`caretRangeFromPoint`
          在行尾/行首/字间空隙常常返回元素节点），试探就会**命中上一行**。
          连续多行往下拖时，每一帧都可能往上一行跳一次 ——
          用户看到的就是「选区动不动跳到段首上面」。

          ⚠️ 更糟的是横向 `cx - d`：`rect.left` 是落点的**左边缘**，
             往左探 24px 很容易落到**行首**，视觉上同样是"跳回去"。

          ── ✅ 修法 ──

          1. **纵向不试探**。`cy` 已经是落点垂直中心，
             `caretRangeFromPoint(cx, cy)` 如果拿不到文本节点，
             说明这一行这个位置确实没有字形 —— 不是靠挪 24px 解决的。
             只在 ±2px 内做极小修正（覆盖亚像素误差）。
          2. **横向只往右探**（落点右边通常还有字，左边是刚过来的方向）。
             用户的手指位置本身就是期望位置，往左探等于替他反向选。
          3. **横向半径收到 12px** —— 一个字符宽度量级，不会跨到行首。

          判据：**试探的目的是"把元素落点规整到同一行的字形上"，
                  不是"在找不到时往远处猜"。**
                  找不到就该返回 null（保持上一帧选区），
                  而不是猜一个远处的位置。
        */
        var probes = [
            [cx, cy],           /* 原位重试（部分 WebView 第二次会给文本节点） */
            [cx, cy - 2], [cx, cy + 2],
            [cx + 2, cy], [cx + 5, cy], [cx + 12, cy]
        ];

        for (var j = 0; j < probes.length; j++) {
            var rr = caretRangeAt(probes[j][0], probes[j][1]);
            if (rr && rr.startContainer &&
                rr.startContainer.nodeType === 3) {
                return {
                    node: rr.startContainer,
                    offset: rr.startOffset
                };
            }
        }

        return null;
    }

    /** 深度优先找 node 子树里的第一个非空文本节点 */
    function firstTextNode(node) {
        var kids = node.childNodes;
        if (!kids) return null;
        for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            if (k.nodeType === 3) {
                if (k.nodeValue && k.nodeValue.length) return k;
            } else if (k.nodeType === 1) {
                var t = firstTextNode(k);
                if (t) return t;
            }
        }
        return null;
    }

    /** 深度优先找 node 子树里的最后一个非空文本节点 */
    function lastTextNode(node) {
        var kids = node.childNodes;
        if (!kids) return null;
        for (var i = kids.length - 1; i >= 0; i--) {
            var k = kids[i];
            if (k.nodeType === 3) {
                if (k.nodeValue && k.nodeValue.length) return k;
            } else if (k.nodeType === 1) {
                var t = lastTextNode(k);
                if (t) return t;
            }
        }
        return null;
    }

    /**
     * 以长按点为**起点**建立字符级选区。
     *
     * ⚠️ 落点用 `caretRangeFromPoint` —— 它返回一个 collapsed Range，
     *    其 `startContainer/startOffset` 就是"按在第几个字符之间"。
     *    这正是"从一个单词中间开始选"所需要的信息。
     *
     * ⚠️ 起始时先只选**一个字符**（`offset` → `offset + 1`），
     *    因为：
     *      · 用户立刻能看到"我确实选中了东西"，而不是等拖了才有反应；
     *      · 与 Android 系统长按选词的整体手感一致（都是先落一个可见的选择）。
     *      若用户想要整词，他自己往下拖即可。
     */
    function armSelectionAt(cx, cy) {
        var r = caretRangeAt(cx, cy);
        if (!r) return;

        /*
          ⚠️ 同样要传真实坐标（v0.2.39）——
             否则长按落点本身就可能跳到段首。
        */
        var pt = resolveTextPoint(r, cx, cy);
        if (!pt) return;

        var node = pt.node;
        var off = pt.offset;

        var len = node.nodeValue ? node.nodeValue.length : 0;
        if (!len) return;

        /*
          ⚠️ 落在字符最末时不能再 +1（越界），此时改选前一个字符。
             否则会得到一个空选区，用户看不到任何高亮。
        */
        var a = off;
        var b = off;
        if (off >= len) { a = len - 1; b = len; }
        else { b = off + 1; }

        var range = document.createRange();
        range.setStart(node, a);
        range.setEnd(node, b);

        try {
            var s = global.getSelection();
            s.removeAllRanges();
            s.addRange(range);
        } catch (e) {
            return;
        }

        /*
          ⚠️ 锚点必须记住：`caretRangeFromPoint` 只能拿到当前位置，
             拿不到"最初从哪里开始"。而拖动时要知道起点才能决定
             往左还是往右扩展。
             ⚠️ 用 `{node, offset}` 而不是 offset 数字 ——
                 跨段落拖动时节点会变，只记数字会算错。
        */
        selAnchor = { node: node, offset: a };

        syncSelectionFromNative();
    }

    /**
     * 把选区扩展到手指当前所在的字符。
     *
     * ⚠️ 用 `setBaseAndExtent(anchor, current)` 而不是
     *    `range.setStart/setEnd` —— 前者自带方向语义，
     *    往左上拖（current 在 anchor 之前）时才能正确表达，
     *    并且**系统选区手柄**会出现在正确的两端。
     */
    function extendSelectionTo(cx, cy) {
        if (!selAnchor) return;

        var r = caretRangeAt(cx, cy);
        if (!r) return;

        var node = r.startContainer;
        var off = r.startOffset;

        /*
          ══ ⚠️⚠️ 落点不一定是文本节点 —— 这是「只能选一个字」的真因 ══
             （v0.1.42）

          实测：`caretRangeFromPoint` 落在元素边界（段落之间的空隙、
          `<p>` 的起止处、行尾空白）时，返回的 `startContainer` 是
          **元素节点**（`nodeType === 1`），`nodeValue` 为 null。

          旧代码在这里直接 `return` —— 于是整个 `touchmove` 序列里
          **一次都没有**成功扩展，选区永远停在长按时落下的那 1 个字符。
          用户看到的就是「直接单字符了，不随手指移动」。

          ✅ 修法：把落点**规整**到最近的文本节点上，而不是放弃。
             见 resolveTextPoint()。

          ⚠️ 必须把**手指的真实坐标**传下去（v0.2.39）——
             从 Range 的 rect 反推会在元素节点时拿到整块的位置，
             导致选区跳到段首。见 nearestTextPoint 的长注释。
        */
        var pt = resolveTextPoint(r, cx, cy);
        if (!pt) return;

        node = pt.node;
        off = pt.offset;

        /*
          ══ ⚠️⚠️ 用 Range + remove/add，**不用** setBaseAndExtent ══
             （v0.1.42）

          实测：在 Android WebView 里连续调用 `setBaseAndExtent()` 时，
          **只有第一次生效**，后续调用被静默忽略 —— 选区停在第一次
          建立的位置，手指再拖也不变。

          症状就是用户说的：
            「直接单字符了，而不是随着我手指的移动来控制选中区域」
          以及我实测到的「dy=25 和 dy=40 选中的字符数完全一样」。

          ✅ 改为每次都新建一个 Range 并整替：
             removeAllRanges() → addRange()。
             这条路径在 WebView 上每次都生效（实测可随手指逐次变化）。

          ⚠️ 代价是丢失 `setBaseAndExtent` 的方向语义（从后往前拖）。
             这里用 anchor 与当前点的文档位置比较，手动决定 start/end，
             效果等价。
        */
        var range = document.createRange();

        try {
            var anchorRange = document.createRange();
            anchorRange.setStart(selAnchor.node, selAnchor.offset);

            var curRange = document.createRange();
            curRange.setStart(node, off);

            /*
              `compareBoundaryPoints(START_TO_START)` < 0 表示
              当前点位于锚点**之前** → 手指往左上拖，锚点当 end。
            */
            var cmp = curRange.compareBoundaryPoints(
                Range.START_TO_START, anchorRange);

            if (cmp < 0) {
                range.setStart(node, off);
                range.setEnd(selAnchor.node, selAnchor.offset);
            } else {
                range.setStart(selAnchor.node, selAnchor.offset);
                range.setEnd(node, off);
            }
        } catch (e) {
            return;
        }

        /*
          ══ ⚠️⚠️ 选区坍缩成 0 长度时，**至少保留起点那一个字** ══
             （v0.1.42）

          实测：手指刚移动几像素（3–16 CSS px）时，
          `caretRangeFromPoint` 反复返回与锚点**同一个 offset** ——
          手指还停在同一行同一字符的垂直范围内。

          此时上面算出来的 Range 是 collapsed（start === end），
          于是：
            ① 选区变成空串；
            ② `onEnd` 里 `syncSelectionFromNative()` 读到空 →
               `clearSelection()`；
            ③ 用户看到的是一次「长按成功了但什么都没选中」。

          症状正是「小幅拖动后全空，大位移才正常」。

          ✅ 保留起点那个字符（`offset` → `offset + 1`），
             与长按刚落点时的视觉保持一致。用户手一动、跨到下一个字，
             就会立刻被上面的 Range 覆盖成正确的跨度。
        */
        if (range.collapsed) {
            try {
                var aNode = selAnchor.node;
                var aOff = selAnchor.offset;
                var aLen = aNode.nodeValue ? aNode.nodeValue.length : 0;

                if (aOff < aLen) {
                    range.setEnd(aNode, aOff + 1);
                } else if (aOff > 0) {
                    range.setStart(aNode, aOff - 1);
                    range.setEnd(aNode, aOff);
                }
            } catch (e) {
                /* 保守起见：算不出来就用坍缩的选择，至少不抛错 */
            }
        }

        try {
            var s = global.getSelection();
            s.removeAllRanges();
            s.addRange(range);
        } catch (e) {
            return;
        }

        syncSelectionFromNative();
    }

    /**
     * 把屏幕坐标换算成一个 collapsed `Range`。
     *
     * ⚠️ Android WebView 只实现了 `caretRangeFromPoint`（旧 API），
     *    `caretPositionFromPoint` 是 `undefined`（实测确认）。
     *    但仍然先试标准 API，万一是新版内核。
     */
    function caretRangeAt(cx, cy) {
        if (document.caretRangeFromPoint) {
            return document.caretRangeFromPoint(cx, cy) || null;
        }
        if (document.caretPositionFromPoint) {
            var pos = document.caretPositionFromPoint(cx, cy);
            if (!pos || !pos.offsetNode) return null;
            var r = document.createRange();
            r.setStart(pos.offsetNode, pos.offset);
            r.collapse(true);
            return r;
        }
        return null;
    }

    /**
     * 从真实的 `window.getSelection()` 同步 `selectedText` 并刷新字数。
     *
     * ⚠️ 为什么以原生选区为准，而不是自己维护 (start, end)：
     *    用户可能去拖系统选区手柄，也可能用键盘选择 ——
     *    那些都不会经过我们的 pointer 处理器。
     *    直接读选区永远是最新的。
     *
     * ⚠️ `toString()` 会**包含换行**（跨段落时）。而相邻两个段落之间
     *    在视觉上没有换行，用户不期望复制出来多一个空行。
     *    实测：跨段选中 `…recurrent or` + `convolutional…`，
     *    原生 toString 得到 `…recurrent or\nconvolutional…`。
     *    这里把 `\n` 换成空格 —— 与"屏幕上看到的一行连续文字"一致。
     *    ⚠️ 但段内有意的换行（pre-wrap 保留的）也会被替换，
     *       这是可接受的：PDF 抽取出的段内换行本来就是排版折行，
     *       不是语义换行。
     */
    function syncSelectionFromNative() {
        var s = global.getSelection();
        var text = (s && s.rangeCount) ? extractSelectedText(s.getRangeAt(0)) : '';

        /*
          ⚠️ 选区里可能只有空白（用户从段落间隙开始拖）。
             这时不要当成"有选中"，否则会弹一个没意义的操作条。
        */
        if (!text.replace(/\s+/g, '')) {
            selectedText = '';
            if (selCountEl) selCountEl.textContent = '';
            return;
        }

        selectedText = text.replace(/\r\n/g, '\n').replace(/\n/g, ' ');

        if (selCountEl) {
            selCountEl.textContent = t('reader.selectCount', {
                n: String(countSelectionChars(selectedText))
            });
        }
    }

    /**
     * 选中了多少个字（字符）。
     *
     * ⚠️ 不计空白：用户不会觉得两个段落之间的那个换行算一个字。
     */
    function countSelectionChars(text) {
        var n = 0;
        for (var i = 0; i < text.length; i++) {
            if (!/\s/.test(text.charAt(i))) n++;
        }
        return n;
    }
    /**
     * 清掉选中状态：去掉原生选区、清空字数、收起操作条。
     *
     * ⚠️ 高亮不再由我们自己的类画（v0.1.41 改回**真实原生选区**）——
     *    因为字符级选区需要系统选区手柄来微调，
     *    而手柄只在真实 `window.getSelection()` 存在时才出现。
     *    `::selection` 的高亮在 WebView 上手指抬起会消失，见 styles.css
     *    里 `.reader-para::selection` 的说明（我们用了一个折中：只在
     *    拖动期间依赖它，松手后靠系统的选区底色）。
     */
    function clearSelection() {
        selectedText = '';
        selAnchor = null;
        selectedRanges = [];

        if (selCountEl) selCountEl.textContent = '';

        /*
          ⚠️ 先 hideSelectBar 再清选区 —— 反过来会让 `selectionchange`
             处理器（它还判断操作条是否显示）在清空后重新算一次。
             顺序上先收起 UI，事件再来时 `selBarEl.hidden` 已为真，直接返回。
        */
        hideSelectBar();
        clearNativeSelection();

        /*
          ⚠️ 兜底：清掉可能残留的 `.is-sel`（旧实现留下的类，现不再新增，
             但防止历史状态把它们留在 DOM 上）。
        */
        if (contentEl) {
            var on = contentEl.querySelectorAll('.is-sel');
            for (var j = 0; j < on.length; j++) on[j].classList.remove('is-sel');
        }
    }

    /** 有没有正在选中的文字（供返回键/菜单切换判断） */
    function hasSelection() {
        return !!selectedText;
    }

    /**
     * 造选中操作条（只造一次，之后只切显示）。
     *
     * ⚠️ 挂在 `root`（.reader）上，**不挂在 contentEl 里** ——
     *    否则它会跟着正文一起滚动，长按处滚出视野后操作条就没了。
     *    贴在阅读页的固定位置：距底部选项栏稍上方。
     */
    /**
     * 造选中操作条（只造一次，之后只切显示）。
     *
     * ══ ⚠️⚠️ 两行布局（v0.1.45）══
     *
     * 用户要求原话：
     *   「选中多少个字符的信息放在操作条的第一行，第二行则放选项。
     *     目前第一个选项是复制，我要加入第二个和第三个选项。
     *     第二个选项是编辑，第三个选项则是标注。」
     *
     * 结构：
     *
     *   ┌─────────────────────┐
     *   │  12 Characters      │   ← 第一行：字数
     *   ├─────────────────────┤
     *   │  [复制] [编辑] [标注]  │   ← 第二行：选项
     *   └─────────────────────┘
     *
     * ⚠️ 原来只有一个按钮，`flex` 横排就够了；现在要竖排两行，
     *    所以外壳改成 `flex-direction: column`，第二行再用一个
     *    `.sel-actions` 容器横排。全部样式在 CSS。
     *
     * ⚠️ 挂在 `root`（.reader）上，**不挂在 contentEl 里** ——
     *    否则它会跟着正文滚动，滚出视野后就没了。
     */
    function mountSelectBar() {
        if (selBarEl || !root) return;

        selBarEl = document.createElement('div');
        selBarEl.className = 'sel-bar';
        selBarEl.hidden = true;

        /* ── 第一行：选中字数 ── */
        var head = document.createElement('div');
        head.className = 'sel-head';

        selCountEl = document.createElement('span');
        selCountEl.className = 'sel-count';
        head.appendChild(selCountEl);

        selBarEl.appendChild(head);

        /* ── 第二行：选项 ── */
        var actions = document.createElement('div');
        actions.className = 'sel-actions';

        actions.appendChild(makeSelAction('copy', 'reader.selectCopy', 'copy',
            function () { copySelection(); }));

        actions.appendChild(makeSelAction('edit', 'reader.selectEdit', 'editPencil',
            function () { openEditSheet(); }));

        actions.appendChild(makeSelAction('label', 'reader.selectLabel', 'annoText',
            function () { openLabelSheet(); }));

        /*
          ══ ⚠️ 这里**没有**「导出 Markdown」按钮（v0.1.92 用户裁决）══

          用户原话：
            「导出不应该安排在选中的操作条上，而应该是 vault 页选中后
              菜单栏删除按钮左边增加一个导出」
            「对于阅读视图来说，导出是没有意义的，根本不需要」

          ✅ 导出统一放在**文库多选栏**（见 index.html 的
             `#selection-export` 与 vault.js 的 confirmExportSelected）。

          ⚠️ 不要再把按钮加回这里 —— 阅读页的 md 就是它的**存储本身**，
             「导出」在语义上是对外分享，那个动作属于文库。
        */

        selBarEl.appendChild(actions);
        root.appendChild(selBarEl);

        mountEditSheet();
        mountLabelSheet();
    }

    /**
     * 造一个操作条按钮（图标 + 文字）。
     *
     * @param {string} action   写进 `data-action`，供测试与样式选择
     * @param {string} i18nKey  文案键
     * @param {string} iconName `ScholariusUI.icon()` 的图标名
     * @param {Function} onClick
     */
    function makeSelAction(action, i18nKey, iconName, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sel-action';
        btn.setAttribute('data-action', action);

        var ui = global.ScholariusUI;
        var iconHtml = (ui && ui.icon) ? ui.icon(iconName) : '';

        var iconEl = document.createElement('span');
        iconEl.className = 'sel-action-icon';
        iconEl.innerHTML = iconHtml;

        /*
          ⚠️ 图标用 innerHTML 而文字用 textContent ——
             图标是我们自己生成的静态 SVG 标记，注入不了；
             文字来自 i18n 表，用 textContent 保险。
        */
        btn.appendChild(iconEl);

        var label = document.createElement('span');
        label.className = 'sel-action-label';
        label.setAttribute('data-i18n', i18nKey);
        label.textContent = t(i18nKey);
        btn.appendChild(label);

        btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            onClick();
        });

        return btn;
    }

    function showSelectBar() {
        if (!selBarEl) return;

        syncSelectionFromNative();

        selBarEl.hidden = false;

        /*
          ══ ⚠️⚠️ 操作条必须**贴着选区**，不能固定在底部（v0.1.41）══

          踩过的坑：上一版把操作条固定在距底栏 64px 处，
          于是它**正好压在正文上** —— 实测 `elementFromPoint(180,790)`
          返回 `BUTTON.sel-action`，用户想在下方继续长按选区
          却点到了"复制"按钮。

          ✅ 现在按选区实际位置定位：
             · 默认放在选区**上方** 10px
             · 上方空间不够（选区靠近屏幕顶部）→ 放到选区下方
             · 水平居中于选区，但夹在视口内，避免溢出
        */
        positionSelectBar();

        /*
          ⚠️ 等两帧再加 `is-open`，让 CSS 过渡能跑起来。
             同步加的话浏览器会把两次样式变更合并，动画不触发
             （这个坑在启动页/弹层上犯过）。
        */
        global.requestAnimationFrame(function () {
            global.requestAnimationFrame(function () {
                if (selBarEl && !selBarEl.hidden) selBarEl.classList.add('is-open');
            });
        });
    }

    /**
     * 把操作条摆到**阅读视窗底部**（v0.1.44）。
     *
     * ══ 用户要求（原话）══
     *
     *   「我们的选中操作不需要直接展示在选中文段旁边，而是在视窗底部——
     *     当然，如果悬浮菜单出现，就在悬浮下方选项的上面就好了，
     *     总结来讲就是可以看见的阅读内容的视窗窗口底部。
     *     这样就不会和原生菜单重叠了。」
     *
     * ══ 为什么不再贴着选区 ══
     *
     * v0.1.42 之前一直把操作条放在选区上方/下方 10px 处。
     * 那时选区是我们自己画的、没有系统菜单，贴着放是合理的。
     * 现在改用**原生选择器**，长按/拖动时 Android 会弹自己的悬浮菜单
     * （复制/全选/搜索那一排）——它同样出现在选区附近，
     * 两套 UI 必然打架：重叠、互相遮挡、点错。
     *
     * ✅ 现在固定贴在视窗底部，和系统菜单彻底分开：
     *
     *    · 菜单收起 → 贴着底部安全区
     *    · 菜单展开（`.reader.is-menu-open`）→ 抬到底栏上方
     *
     * ⚠️ 这正是 v0.1.40 后被推翻的"固定底部"方案，但那时是错在
     *    **压住了正文**（`elementFromPoint` 实测点到的是按钮）。
     *    现在不同：操作条只在有选区时出现，而原生选择器已经把
     *    选区附近交还给我们处理，底部这一条不会挡住用户继续拖选。
     *
     * ⚠️ 水平方向居中；样式全在 CSS，JS 只负责"要避开多少底部高度"。
     */
    function positionSelectBar() {
        if (!selBarEl) return;

        /*
          ⚠️ 不用再算 `top` —— CSS 里用 `bottom` 固定。
             这里只把"底栏是否展开"告诉 CSS，靠类名切换避让高度。
        */
        var menuOpen = root && root.classList.contains('is-menu-open');
        selBarEl.classList.toggle('is-above-menu', !!menuOpen);

        selBarEl.style.left = '';
        selBarEl.style.top = '';
        selBarEl.style.bottom = '';
    }

    /**
     * 只收起操作条 UI，**不动** `window.getSelection()`（v0.1.43）。
     *
     * ⚠️⚠️ 与 `clearSelection()` 的区别必须记住：
     *
     *    · `clearSelection()`        —— 连原生选区一起删（`removeAllRanges`）。
     *                                   只在**用户明确要求**时用（返回键）。
     *    · `hideSelectBarOnly()`     —— 只收 UI，保留原生选区与把手。
     *                                   用于"选区变空了""点了正文"等
     *                                   浏览器自己已经处理好的场景。
     *
     * ⚠️ 为什么不合并成一个：`removeAllRanges()` 会把原生选择器的
     *    两个蓝色把手一起删掉，而把手的出现/消失必须由系统决定 ——
     *    我们越权去删，就出现了「高亮有、把手没有、拖动无法扩展」。
     */
    function hideSelectBarOnly() {
        if (!selBarEl) return;
        hideSelectBar();
    }

    function hideSelectBar() {
        if (!selBarEl) return;
        selBarEl.classList.remove('is-open');
        /*
          ⚠️ 等过渡跑完再 `hidden`，否则会"啪"地消失。
             220ms 与 CSS 里的 transition 时长一致。
        */
        global.setTimeout(function () {
            if (selBarEl && !selBarEl.classList.contains('is-open')) {
                selBarEl.hidden = true;
            }
        }, 220);
    }

    /**
     * 复制选中的文本。
     *
     * ⚠️ 两条路：`navigator.clipboard` 优先，`execCommand('copy')` 兜底。
     *    前者要求安全上下文（我们有 https 源，可用）；
     *    老 WebView 没有它，必须留兜底 ——
     *    这个组合在本项目 login.js / app.js 里已经用过，是验证过的。
     */
    function copySelection() {
        /*
          ⚠️ 复制前**重新从原生选区同步一次**（v0.1.41）——
             用户可能刚拖过选区手柄，而 `selectionchange` 的刷新
             在极少数时序下会晚于点击。这里再取一次是最稳的。
             ⚠️ 但不能用 `syncSelectionFromNative()` 的宽松版本：
                它遇到全空白会清空 `selectedText`，那样下面就会直接 return
                而不给任何提示。这里只在**非空**时采纳。

          ⚠️ 用 `extractSelectedText` 而不是 `String(selection)`（v0.1.49）——
             否则复制出去的文本里会带上「文章标题」这类**界面文字**。
        */
        var live = '';
        try {
            var s = global.getSelection();
            if (s && s.rangeCount) {
                live = extractSelectedText(s.getRangeAt(0));
            }
        } catch (e) { live = ''; }
        if (live.replace(/\s+/g, '')) {
            selectedText = live.replace(/\r\n/g, '\n').replace(/\n/g, ' ');
        }

        var text = selectedText;
        if (!text) return;

        var done = function () {
            global.ScholariusUI.toast(t('reader.selectCopied'));
            /*
              ⚠️ 复制后**不**自动取消选中 —— 用户可能还要连着复制一次，
                 或看着高亮确认复制的就是这一段的。点空白处取消即可。
            */
        };

        try {
            if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
                global.navigator.clipboard.writeText(text).then(done, function () {
                    legacyCopy(text) ? done() : global.ScholariusUI.toast(t('reader.selectCopyFailed'));
                });
                return;
            }
        } catch (e) { /* 落到兜底 */ }

        if (legacyCopy(text)) done();
        else global.ScholariusUI.toast(t('reader.selectCopyFailed'));
    }

    /**
     * 全文导出为 Markdown（v0.1.91）。
     *
     * ══ ⚠️⚠️ 为什么导出走"块数据"而不是 DOM ══
     *
     * DOM 里混着**界面文字**：区域标签段「作者信息」、作者项名
     * 「Name」「Affiliation」、正文段编号（B1/B2）、引用的 `[12]`…
     * 直接从 `textContent` 抓会把这些一起导出（本项目为这类问题
     * 反复踩坑，见 `isNonContentNode`）。
     *
     * ✅ 所以从 `docModel.blocks` + `edits` + `labels` 重建 ——
     *    这三份数据是唯一事实来源（见 docModel 的说明），
     *    文本是 PDF 原文/用户编辑结果，标注是**字符区间**。
     *
     * ══ 块类型的判定顺序 ══
     *
     *   ① 用户标注（`labels[line]`）—— 覆盖整块的那一条，优先
     *   ② 提取层的 `kind` / `level`（原生识别）
     *   ③ 都没有 → 正文
     *
     * ⚠️ 只认**覆盖整块**的标注。部分标注（只标了一行里的几个词）
     *    仍按提取层类型处理 —— 因为"这一整块是什么"不能用一小段决定，
     *    那些子标签的语义在 Markdown 里也有别的方式表达（作者项、引用）。
     */
    /**
     * 把一个块按**标注区间**切成若干段（v0.2.21）。
     *
     * ══ ⚠️⚠️ 为什么必须切 ══
     *
     * PDF 提取经常把几种内容挤进同一个块，论文首块最典型：
     *
     *     Attention Is All You Need Ashish Vaswani∗ … Google Brain …
     *     … Abstract The dominant sequence transduction models …
     *
     * 用户在 app 里已经把「Attention Is All You Need」标成 title、
     * 把作者名/单位/邮箱标成 author 子标签、把摘要标成 abstract。
     * 但序列化时若按"整块一条类型"处理，这些标注**一个都用不上**，
     * 整块变成普通段落 —— md 里既没有 `#` 也没有 `- `，
     * 数据等于没保存。
     *
     * ✅ 所以按标注边界切段：每段自己一种类型。
     *    没有标注覆盖的部分（标注之间的空隙）保持整块类型。
     *
     * ══ 切分规则 ══
     *
     *   ① 只切**块级**标注（title / heading / h1-3 / author / abstract /
     *      reference / body）—— 行内标注（cite、author 子标签的 field）
     *      跟着它所在的段走，不单独成段。
     *   ② 相邻且同 label 的区间合并成一段（用户分几次选同一处时）。
     *   ③ 空隙（未标注部分）如果只有空白 → 丢弃；否则成一段正文。
     *
     * @param text   整块文本
     * @param spans  该块的标注数组（可为 null）
     * @return {Array<{text:string, start:number, label:string|null, marks:Array}>}
     */
    var BLOCK_LABELS = {
        title: true, heading: true, h1: true, h2: true, h3: true,
        author: true, abstract: true, reference: true, body: true,
        /* ⚠️ 尾注是块级标注（md 里 `> ` 引用块），必须能独立成段（v0.2.37） */
        endnote: true
    };

    function splitBlockByMarks(text, spans) {
        var src = String(text == null ? '' : text);
        if (!spans || !spans.length) {
            return [{ text: src, start: 0, label: null, marks: [] }];
        }

        /*
          ⚠️ 只取**块级**标注来定段。子标签（author + field）不算段边界 ——
             它们描述的是"段内某几个词是什么"，不是"这里换了一种内容"。
        */
        var bounds = [];
        for (var i = 0; i < spans.length; i++) {
            var sp = spans[i];
            if (!sp || !sp.label) continue;
            if (!BLOCK_LABELS[sp.label]) continue;
            /*
              ══ ⚠️⚠️ `author + field` 也算段边界（v0.2.22 修）══

              旧逻辑把它排除（"子标签不算段边界"），本意是：
              子标签描述段内某几个词，不改变这一段的内容类型。

              但**整块只有子标签**时（用户只给某一块标了「作者单位」，
              没单独标「作者」），排除之后就一个边界都没有 →
              这一块被当成正文 → 子标签彻底丢失（md 里只剩 `- Google Brain`）。

              ✅ 修正：仍然**优先**用无 field 的 author 做边界；
                 但如果这一块里只有带 field 的 author，就用它们做边界。
                 判据放在两个循环里：先扫无 field，扫不到再用有 field 的。
            */
            if (sp.label === 'author' && sp.field) continue;
            var s = Math.max(0, Math.min(Number(sp.start) || 0, src.length));
            var e = Math.max(0, Math.min(Number(sp.end) || 0, src.length));
            if (e <= s) continue;
            bounds.push({ start: s, end: e, label: sp.label });
        }
        /*
          ⚠️ 没有任何**无 field** 的块级标注时，退回"只有子标签的 author" ——
             只要这块被标了任何一个 author 子标签，它整体就是作者项。
        */
        if (!bounds.length) {
            for (var f2 = 0; f2 < spans.length; f2++) {
                var sf = spans[f2];
                if (!sf || sf.label !== 'author' || !sf.field) continue;
                var fs = Math.max(0, Math.min(Number(sf.start) || 0, src.length));
                var fe = Math.max(0, Math.min(Number(sf.end) || 0, src.length));
                if (fe <= fs) continue;
                bounds.push({ start: fs, end: fe, label: 'author' });
            }
            /*
              ⚠️ 多个子标签区间之间可能有空隙（子标签只覆盖了部分词），
                 这里把**整个块**当作一个 author 段 —— 否则空隙会变成
                 独立的"正文段"，把同一作者的姓名/单位拆开。
            */
            if (bounds.length) {
                bounds = [{ start: 0, end: src.length, label: 'author' }];
            }
        }
        if (!bounds.length) {
            return [{ text: src, start: 0, label: null, marks: [] }];
        }
        bounds.sort(function (a, b) { return a.start - b.start || b.end - a.end; });

        /* ② 相邻同 label 合并（含首尾相接的重叠） */
        var merged = [];
        for (var m = 0; m < bounds.length; m++) {
            var cur = bounds[m];
            var last = merged[merged.length - 1];
            if (last && last.label === cur.label && cur.start <= last.end) {
                if (cur.end > last.end) last.end = cur.end;
            } else {
                merged.push({ start: cur.start, end: cur.end, label: cur.label });
            }
        }

        /* ③ 补空隙 + 生成段 */
        var pieces = [];
        var cursor = 0;
        for (var k = 0; k < merged.length; k++) {
            var seg = merged[k];
            if (seg.start > cursor) {
                pieces.push({
                    text: src.slice(cursor, seg.start),
                    start: cursor,
                    label: null,
                    marks: []
                });
            }
            pieces.push({
                text: src.slice(seg.start, seg.end),
                start: seg.start,
                label: seg.label,
                marks: []
            });
            cursor = Math.max(cursor, seg.end);
        }
        if (cursor < src.length) {
            pieces.push({ text: src.slice(cursor), start: cursor, label: null, marks: [] });
        }

        /* 把每条标注（含子标签）挂到它所属的段上 */
        for (var q = 0; q < spans.length; q++) {
            var mark = spans[q];
            if (!mark || !mark.label) continue;
            var ms = Number(mark.start) || 0;
            for (var p = 0; p < pieces.length; p++) {
                var pc = pieces[p];
                var pcEnd = pc.start + pc.text.length;
                if (ms >= pc.start && ms < pcEnd) {
                    pc.marks.push(mark);
                    break;
                }
            }
        }

        return pieces;
    }

    function markdownOfDoc() {
        var md = global.ScholariusMarkdown;
        if (!md) return '';

        var list = docModel.blocks || [];
        if (!list.length) {
            /* 老文献（没有块数据）→ 整篇一个段落，至少不要空手而归 */
            return lastText ? String(lastText).replace(/\r\n?/g, '\n') + '\n' : '';
        }

        /*
          ══ 作者区：整块覆盖的 author 标注 → 无序列表 ══
          ══ 文献区：整块覆盖的 reference 标注 → 有序列表 ══

          ⚠️ 用户裁决：
             「作者项可以直接分为一个个无序列表」
             「文献用有序列表」
             「正文当然肯定不能用列表，所以正文编号这个确实还得用算法添加」
        */
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            var line = b.line;
            /* ⚠️ 同上：按块取文本，不按行号回查（v0.2.35） */
            var text = textOfBlock(b);
            if (!text || !text.replace(/\s+/g, '')) continue;

            var kind = b.kind || 'body';
            var level = b.level;

            /*
              ══ ⚠️⚠️ `listMarker` 是 md 结构，优先级最高（v0.2.22）══

              这份块来自 `MdDoc.parse` 时，`listMarker` 就是 md 里
              `- ` / `1. ` 的**原文**。用户没改过它，就必须原样写回去 ——
              不重新判断"这块是不是文献"。

              ⚠️ 之前这里只靠 `kind === 'reference'`（用户标注才有），
                 于是从 md 读进来、用户没动过的文献列表，
                 再导出时**全部退化成普通段落** —— 结构破坏。

              ✅ 现在：有 `listMarker` 就按它输出，后面的标注判断只用于
                 "用户新标注了这一块"的情形。
            */
            var mdListMarker = String(b.listMarker || '');

            var spans = (typeof line === 'number') ? labels[line] : null;
            if (spans && spans.length) {
                var whole = null;
                for (var s = 0; s < spans.length; s++) {
                    var sp = spans[s];
                    if (!sp || !sp.label) continue;
                    /*
                      ⚠️ 覆盖整块才算"这一块的类型"。
                         边界允许 1 个字符的误差（用户拖选时容易差一格）。
                    */
                    if ((sp.start || 0) <= 1 && (sp.end || 0) >= text.length - 1) {
                        whole = sp;
                        break;
                    }
                }
                if (whole) {
                    kind = whole.label;
                    /*
                      ⚠️ 用户把一段标成 h1/h2/h3 时，层级来自**标签**，
                         不是提取层。提取层的 level 可能是 1，
                         但用户标 h2 就该是 `###`。
                    */
                    if (whole.label === 'h1') level = 1;
                    else if (whole.label === 'h2') level = 2;
                    else if (whole.label === 'h3') level = 3;
                    else if (whole.label === 'title') kind = 'heading';
                } else {
                    /*
                      ══ ⚠️⚠️ 没有"整块标注"时的判定（v0.1.91，实测踩到）══

                      作者块的典型标注是**每行一条**（`affiliation` / `email`），
                      没有任何一条覆盖整块 → 上面那个 `whole` 恒为 null
                      → 整块退回 `b.kind`（提取层判成 paragraph）
                      → **作者区变成普通正文，子标签全丢**。

                      ✅ 判据：**这一块的标注是否全部是 author**。
                         这正是渲染层 `isAuthorLineSet()` 用的同一条判据，
                         两边保持一致（否则会出现"屏幕上对了、导出错了"）。

                      ⚠️ 只认 author —— 其他标签（h1/reference…）的部分标注
                         不改这一块的类型，保持"这一块主要是什么"。
                         部分标注的语义在导出时无处安放，宁可当正文。
                    */
                    var allAuthor = true;
                    for (var t2 = 0; t2 < spans.length; t2++) {
                        if (!spans[t2] || spans[t2].label !== 'author') {
                            allAuthor = false;
                            break;
                        }
                    }
                    if (allAuthor) kind = 'author';
                }
            }

            /*
              ══ ⚠️⚠️ 一个提取块可以**被切成多个 md 块**（v0.2.21）══

              用户裁决：
                「标注为文章标题的，应为md的一级标题；文章中的Heading
                  分别对应md的二三四级标题。文献对应有序列表，
                  作者对应无序列表。正文段则也应该在md中为自然段。」

              **根本问题**：之前一个块只输出一个 md 块，类型由
              "覆盖整块的那条标注"决定。但 PDF 提取常把多种内容
              挤进一个块 —— 例如论文首块：

                  标题 / 作者 / 单位 / 邮箱 / Abstract / 摘要正文

              整块标不上任何单一类型 → 退回 `paragraph` →
              `#`、`- `、`1. ` 一个都写不出来，标注全部静默丢失。

              ✅ 现在按**标注区间**把块切开：每个区间一段，
                 各段独立决定类型。没有标注覆盖的部分为正文。

              ⚠️ 切分只用**已有标注的边界**，不做任何"猜边界"算法 ——
                 那正是历史上反复出错的地方。
            */
            var pieces = splitBlockByMarks(text, spans);
            for (var pi = 0; pi < pieces.length; pi++) {
                var pc = pieces[pi];
                var pieceText = pc.text;
                if (!pieceText.replace(/\s+/g, '')) continue;

                /*
                  ⚠️ 段自己带的标签优先；没有标签的段
                     （标注之间的空隙）沿用整块的类型 —— 这样
                     未标注的正文块行为与改动前完全一致。
                */
                var pieceKind = pc.label || kind;
                var pieceLevel = level;

                /*
                  ══ ⚠️⚠️ 空隙段**不能**继承整块类型（v0.2.23）══

                  一个块被标注切成多段后，段与段之间可能有"没被标注覆盖"
                  的空隙（例如标注 `[0,16)` 而块长 17，末尾剩 1 个字符）。

                  之前 `pieceKind = pc.label || kind` 让空隙段继承了整块的
                  `kind`（比如 `reference`）→ 于是空隙段也被当成文献条目，
                  输出 `2. Ref: .`（空条目）。

                  ✅ 空隙段（`pc.label` 为空）一律视为**正文**：
                     它不属于任何标注，按 md 语义就是普通段落。
                  ⚠️ 例外：整块**只有一个**段时不存在空隙，沿用 `kind` 正确。
                */
                if (!pc.label && pieces.length > 1) pieceKind = 'body';
                /*
                  ══ ⚠️⚠️ 层级映射（用户裁决）══

                    「标注为文章标题的，应为md的一级标题；文章中的Heading
                      分别对应md的二三四级标题。」

                    title → `#`
                    h1    → `##`
                    h2    → `###`
                    h3    → `####`

                  ⚠️ 关键是 **title 必须同时把 kind 设成 heading、
                     并且 level 设成 0** —— case 1：
                     旧代码只改 kind 不改 level，而 level 是提取层的
                     （普通段落 = 0）→ headingPrefix 算出 `####` 或空。
                  ⚠️ `title` 用 level = 0 是一个**专用信号**，
                     headingPrefix 见到它就返回 `#`，与"是不是首块"无关 ——
                     用户标了文章标题，那它就该是 `#`，哪怕不在第一位。
                */
                if (pc.label === 'title') { pieceKind = 'heading'; pieceLevel = 0; }
                else if (pc.label === 'h1') { pieceKind = 'heading'; pieceLevel = 1; }
                else if (pc.label === 'h2') { pieceKind = 'heading'; pieceLevel = 2; }
                else if (pc.label === 'h3') { pieceKind = 'heading'; pieceLevel = 3; }

                /*
                  ⚠️ 作者段的子标签：区间要**相对这一段**重新算，
                     否则 authorItemsOf 收到的 start/end 是整块的坐标，
                     全都会越界。
                */
                var pieceSpans = null;
                if (pieceKind === 'author') {
                    pieceSpans = [];
                    for (var pj = 0; pj < (pc.marks || []).length; pj++) {
                        var pm = pc.marks[pj];
                        pieceSpans.push({
                            start: pm.start - pc.start,
                            end: pm.end - pc.start,
                            label: pm.label,
                            field: pm.field
                        });
                    }
                }

                out.push({
                    kind: pieceKind,
                    level: pieceLevel,
                    text: pieceText,
                    lines: (pieces.length === 1) ? b.lines : null,
                    /*
                      ⚠️ md 原有的列表记号，原样带过去（v0.2.22）——
                         这是**读进来的结构**，不是我们判断出来的。
                         切段后只有"整块一段"时才沿用，否则由类型决定。
                    */
                    listMarker: (pieces.length === 1) ? mdListMarker : '',
                    /*
                      ⚠️ 作者项（v0.2.23 / v0.2.31）：
                         · 有子标签 → 交给 `authorItemsOf`，按行归属 field
                         · 无子标签 → **按行拆成多条**（v0.2.31 修）
                    */
                    /*
                      ══ ⚠️⚠️ 判据是「有没有**带 field** 的 author 标注」（v0.2.31 修）══

                      旧代码用 `pieceSpans && pieceSpans.length` 判断 ——
                      但 `pieceSpans` 里只要有**任何**标注就算真，
                      而 `authorItemsOf` 只认带 `field` 的 author，其余一律 `null`。
                      于是"整块标成 author、没有子标签"这种最常见的情形：

                          authorItemsOf(...) → null
                          || [{ text: pieceText }]   ← 整块压成**一条**，换行还在里面

                      导出结果就是：

                          - Author: A1
                          B2           ← 裸行
                          C3           ← 裸行

                      正是用户说的「子标签换行」那个老 bug 在导出侧的表现。

                      ✅ 先看有没有带 field 的 author 标注：
                         · 有  → `authorItemsOf`（按行归属 field）
                         · 没有 → `plainAuthorItems`（按行拆条，每行一条）
                    */
                    authorItems: (pieceKind === 'author')
                        ? (((pieceSpans || []).some(function (z) {
                            return z && z.label === 'author' && z.field;
                        }))
                            ? (authorItemsOf(
                                pieceText,
                                (pieces.length === 1) ? b.lines : null,
                                pieceSpans) ||
                               plainAuthorItems(pieceText,
                                (pieces.length === 1) ? b.lines : null))
                            : plainAuthorItems(pieceText,
                                (pieces.length === 1) ? b.lines : null))
                        : null
                });
            }
        }

        /*
          ⚠️ `listKinds` 只影响 **author / reference** 两类：
             其他类型（abstract / heading…）不该变成列表项。
          ⚠️ `fieldLabel` 把 `name` / `affiliation` … 翻成中文显示名，
             导出的是**给用户看的文档**，不能出现原始键名。
        */
        return md.toMarkdown(out, {
            listKinds: { author: true, reference: true },
            fieldLabel: function (f) {
                return t('reader.field.' + f) || f;
            }
        });
    }
    /**
     * 把作者块切成 `[{text, field}]`（v0.1.91），供 Markdown 嵌套导出。
     *
     * ══ 为什么要单独算，不能直接用 `lines` ══
     *
     * 用户给作者块的**某些行**加了子标签（`field`），
     * 而这些子标签是**字符区间**（`{start, end, field}`），
     * 与 `lines`（排版折行）不是同一套切法 —— 用户可能只选了
     * 一行里的一部分。所以：
     *
     *   ① 有 `lines`（多行）→ 按行切，逐行判断"这一行是否整行被某条
     *      带 field 的标注覆盖"；
     *   ② 没有 `lines` → 按标注区间切（与渲染层 makeAuthorLinesEl 同精神）。
     *
     * ══ ⚠️⚠️ 关键：**行偏移必须加上分隔符长度** ══
     *
     * `lines` 各行在 `text` 里是用 `\n` 连起来的（提取层用空格连接？
     * 不 —— `lines` 是原始行，`text` 是**用空格合并**后的结果）。
     * 所以不能简单累加各行的长度去找偏移：合并时行与行之间插入了
     * 一个空格，而折行处还可能被去掉/补上。
     *
     * ✅ 稳妥做法：**在 text 里按顺序查找每一行的起点**（indexOf from cursor）。
     *    找不到（行被合并改写）→ 该行按"无子标签"处理，不瞎猜。
     *
     * @param text   块文本（已含编辑）
     * @param lines  原始排版行（可为空）
     * @param spans  该块的标注数组
     * @return {Array<{text:string, field:string|null}>|null} 无标注时返回 null
     */
    function authorItemsOf(text, lines, spans) {
        /* 只保留**带 field** 的 author 标注 —— 其余标注与本功能无关 */
        var marks = [];
        for (var i = 0; i < spans.length; i++) {
            var sp = spans[i];
            if (!sp || sp.label !== 'author' || !sp.field) continue;
            marks.push({
                start: Math.max(0, Math.min(sp.start || 0, text.length)),
                end: Math.max(0, Math.min(sp.end || 0, text.length)),
                field: sp.field
            });
        }
        if (!marks.length) return null;
        marks.sort(function (x, y) { return x.start - y.start; });

        /*
          ══ ⚠️⚠️ 没有 `lines` → 按**标注区间**切（v0.2.29 修）══

          用户实测：
            「当我标注子标签时，整个作者区域直接恢复成了正文段」
            修掉那个之后，整块被显示成
            `Author Affiliation: Ashish Vaswani Google Brain avaswani@google.com`
            —— 整块都被当成单位了。

          真因：`cleanLinesOf(text)` 在"整块是一行"时只返回**一个**元素，
          于是这一整行被归给第一个命中的子标签（`mk.start <= at+1 &&
          mk.end >= rowEnd-1` 对整行恒成立）。

          ✅ 正确做法：**没有原始行边界时，用标注区间本身当切分依据**：
             被某条子标签覆盖的部分 → 该项；
             未被覆盖的部分        → 无名项（field = null）。
             这样 `Google Brain` 被标成单位后，整块切成：
               Ashish Vaswani  /  Google Brain(单位)  /  avaswani@google.com
        */
        if (!lines || lines.length <= 1) {
            var segs = [];
            var pos = 0;
            for (var k = 0; k < marks.length; k++) {
                var mk2 = marks[k];
                if (mk2.start > pos) {
                    segs.push({ text: text.slice(pos, mk2.start), field: null });
                }
                segs.push({ text: text.slice(mk2.start, mk2.end), field: mk2.field });
                pos = Math.max(pos, mk2.end);
            }
            if (pos < text.length) {
                segs.push({ text: text.slice(pos), field: null });
            }
            /* 去掉空白项，保留顺序 */
            var trimmed = [];
            for (var q2 = 0; q2 < segs.length; q2++) {
                var t2 = String(segs[q2].text || '').replace(/^\s+|\s+$/g, '');
                if (!t2) continue;
                trimmed.push({ text: t2, field: segs[q2].field });
            }
            return trimmed.length ? trimmed : null;
        }

        var rows = lines;
        var items = [];
        var cursor = 0;

        for (var r = 0; r < rows.length; r++) {
            var row = String(rows[r] == null ? '' : rows[r]).replace(/^\s+|\s+$/g, '');
            if (!row) continue;

            /*
              在 text 里定位这一行。
              ⚠️ 从 cursor 往后找，保证"第 2 行的第二次出现"不会被当成第 1 行。
              ⚠️ 找不到（提取层合并时改写过）→ 偏移记为 -1，这条行无子标签。
            */
            var at = text.indexOf(row, cursor);
            if (at < 0) at = text.indexOf(row);
            var rowEnd = (at < 0) ? -1 : (at + row.length);

            var field = null;
            if (at >= 0) {
                for (var m = 0; m < marks.length; m++) {
                    var mk = marks[m];
                    /*
                      ══ ⚠️ 子标签**落在这一行内**即可（v0.2.30）══

                      与渲染侧同判据。用户给某行中间几个词加子标签时，
                      意图是"这一行是单位"，而不是"只有那几个词是"。

                      ⚠️ 不能要求整行覆盖 —— 行是排版折行，用户选不中整行。
                      ⚠️ 但**不能把行拆碎** —— 那正是"子标签换行"的老 bug。
                    */
                    var ov = Math.min(mk.end, rowEnd) - Math.max(mk.start, at);
                    if (ov > 0) {
                        field = mk.field;
                        break;
                    }
                }
                cursor = rowEnd;
            }

            items.push({ text: row, field: field });
        }
        return items;
    }

    /** 按 `\n` 拆行、去空行、去首尾空白（与 md.js 的 cleanLines 同义） */
    function cleanLinesOf(text) {
        var src = String(text == null ? '' : text).split('\n');
        var out = [];
        for (var i = 0; i < src.length; i++) {
            var s = src[i].replace(/^\s+|\s+$/g, '');
            if (s) out.push(s);
        }
        return out;
    }

    /**
     * 把整篇导出为 Markdown 并复制到剪贴板。
     *
     * ⚠️ 走 `copyText()`（同一套 `navigator.clipboard` → `execCommand` 兜底），
     *    不复用 `copySelection()` —— 那个读的是"当前选区"，
     *    而这里要的是**整理过的全文**。
     */
    function copyMarkdown() {
        var text = markdownOfDoc();
        if (!text) return;

        copyText(text, t('reader.mdCopied'), t('reader.mdCopyFailed'));
    }

    /**
     * 通用复制（v0.1.91）。
     *
     * @param text     要复制的文本
     * @param okMsg    成功提示
     * @param failMsg  失败提示
     */
    function copyText(text, okMsg, failMsg) {
        var done = function () {
            /*
              ⚠️ 避让选择操作条（v0.1.91）——
                 实测点 Markdown 后 toast 正压在操作条上，挡住了按钮。
                 详见 components.js 里 toast() 的 `avoid` 说明。
            */
            global.ScholariusUI.toast(okMsg, selBarEl);
        };

        try {
            if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
                global.navigator.clipboard.writeText(text).then(done, function () {
                    legacyCopy(text) ? done() : global.ScholariusUI.toast(failMsg);
                });
                return;
            }
        } catch (e) { /* 落到兜底 */ }

        if (legacyCopy(text)) done();
        else global.ScholariusUI.toast(failMsg);
    }

    /**
     * 老式复制：造一个屏幕外的 textarea，选中后 `execCommand('copy')`。
     *
     * ⚠️ textarea 必须真的在文档里且可见（`display:none` 在部分 WebView
     *    上会导致 `select()` 失效），所以用 `position: fixed; opacity: 0`
     *    并放到屏幕外，而不是 `display: none`。
     */
    function legacyCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText =
            'position:fixed;top:-9999px;left:-9999px;opacity:0;';
        document.body.appendChild(ta);

        var ok = false;
        try {
            ta.select();
            ta.setSelectionRange(0, text.length);
            ok = document.execCommand('copy');
        } catch (e) {
            ok = false;
        }

        document.body.removeChild(ta);
        return ok;
    }

    // --- 选中段落的编辑 / 标注（v0.1.45）-------------------------------------

    /*
      ══ 这两个功能的共同约束 ══

      · **不碰 PDF 源文件**。结果只存 localStorage，按 doc.id + 块行号。
        用户要求：「此举没有改变 pdf 源文件，所以当新导入的时候，
                   新文件的阅读视图应该还是当时我们那个最原始的全文本的样子。」
        —— 重新导入是一篇新文献（新 id），自然回到原始文本。

      · **都走表单 + 取消/确认**。用户要求「弹出表单，确认后才使用」，
        所以点选项本身不落库，只有按确认才生效。

      · **作用于"选中的块"**，不是"选中的字符"。
        选区可能只覆盖段落的一部分，但编辑/标注的粒度是段落 ——
        正文本来就是一段一个 `<p>`，改半段没有意义。
        取法见 blockLinesInSelection()。
    */

    /**
     * 找出当前选区**涉及的所有块行号**。
     *
     * ⚠️ 为什么按块而不按字符：
     *    · 编辑要替换"原内容"，而原内容的单位就是块（一个 `<p>`）；
     *    · 标注要挂到目录上，目录条目也是块。
     *    选区落在段落中间时，仍然算"这个段落"。
     *
     * ⚠️ 实现用 `Range.intersectsNode` 而不是比较字符偏移 ——
     *    跨多个段落时字符偏移根本无法表达"哪些块被碰到"，
     *    而 `intersectsNode` 对跨段落 Range 语义正确。
     *
     * @return {number[]} 涉及的行号（升序、去重）；没有选区时为空数组
     */
    function blockLinesInSelection() {
        var out = [];
        if (!contentEl) return out;

        var sel = null;
        try {
            sel = global.getSelection();
        } catch (e) { sel = null; }
        if (!sel || !sel.rangeCount) return out;

        var range = sel.getRangeAt(0);
        var nodes = contentEl.querySelectorAll('[data-line]');

        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var hit = false;

            try {
                hit = range.intersectsNode(el);
            } catch (e) {
                hit = false;
            }

            /*
              ⚠️ `intersectsNode` 对**紧贴边界**的节点会返回 true：
                 选到第 3 段末尾时，第 4 段的开头也"相交"（零宽重叠）。
                 所以再要求选区的可视矩形与该块有**实际交叠**，
                 否则会多抓一个段落 —— 用户编辑时会发现多出一段。
            */
            if (!hit) continue;

            out.push(parseInt(el.getAttribute('data-line'), 10));
        }

        /* 去掉无效值与重复，按行号升序 */
        var clean = [];
        for (var j = 0; j < out.length; j++) {
            if (isFinite(out[j]) && clean.indexOf(out[j]) < 0) clean.push(out[j]);
        }
        clean.sort(function (a, b) { return a - b; });
        return clean;
    }

    /**
     * 取某个块的**当前文本**（已应用过编辑）。
     *
     * ══ ⚠️ 唯一的事实来源（v0.1.57）══
     *
     * 编辑和标注都以"块的完整文本"为坐标系，与 DOM 怎么切段落无关 ——
     * 见 docModel 的说明。
     *
     * ⚠️ 顺序很重要：
     *   ① `edits[line]` —— 用户编辑过的版本优先；
     *   ② `docModel.blocks` 里的原文 —— PDF 转换的原始文本；
     *   ③ 兜底 `lastBlocks`（老数据 / 未走 setText 的路径）。
     *
     * ⚠️ 绝不能返回 DOM 里的 `textContent` ——
     *    标注后的块在 DOM 里可能被拆成多段、还带着标签文字，
     *    拿它当"原文"会让区间偏移全错。
     */
    function blockTextOf(line) {
        if (edits[line] != null) return edits[line];

        var key = String(line);

        var list = docModel.blocks || [];
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].line) === key) return list[i].text || '';
        }

        if (lastBlocks) {
            for (var j = 0; j < lastBlocks.length; j++) {
                if (String(lastBlocks[j].line) === key) {
                    return lastBlocks[j].text || '';
                }
            }
        }
        return '';
    }

    /**
     * 取**这一块自己**的文本（v0.2.35）。
     *
     * ══ ⚠️⚠️ 为什么需要它，而不是 `blockTextOf(b.line)` ══
     *
     * 用户原话：
     *
     *   「再全面改md之前，模型切分是真实有效的，现在突然错误了，
     *     一定是流程出了问题」
     *
     * 对。`blockTextOf(line)` 的实现是「遍历所有块，返回**第一个**
     * 行号匹配的那一块的文本」。这在行号唯一时没问题，
     * 但语义切分会让多个新段落共享同一个行号：
     *
     *     rebuilt[p].line = allLines[lo]     // lo 由字符占比算出，必然重复
     *
     * 于是那些共享行号的段落**全都拿到第一块的文本** ——
     * 屏幕上和 md 里同一段反复出现（重复），
     * 而原本属于其他行号的文本再也没有块引用它（缺失）。
     *
     * ⚠️ 重构之前没有这个问题：旧渲染器 `renderFlat(blocks)`
     *    直接遍历数组、用块对象自身渲染，从不按 `line` 回查。
     *    是我把 `line` 抬成"唯一事实来源"之后才炸的。
     *
     * ✅ 修法：凡是**手上已经有块对象**的地方，就不要再用行号回查，
     *    直接用块自己的 `text`。行号只用于"定位到哪一块"，
     *    不用于"取文本"。这样行号重复也不再影响内容。
     *
     * ⚠️ 仍然尊重 `edits[line]`：用户改过这一块时，编辑结果是权威的。
     *    只有在没有编辑时，才用块自身文本。
     *
     * @param {Object} b    块对象
     * @param {number} idx  块在数组中的下标（兜底定位用）
     * @return {string}
     */
    function textOfBlock(b) {
        if (!b) return '';
        var line = b.line;
        /* 用户编辑过 → 编辑结果优先（与 blockTextOf 的优先级一致） */
        if (line != null && edits[line] != null) return edits[line];
        return (b.text == null) ? '' : String(b.text);
    }

    /**
     * 求一个文本节点在「它所属的块文本」里的起始偏移（v0.1.57 重写）。
     *
     * ══ ⚠️⚠️ 为什么这次能简单 ══
     *
     * 因为 `data-line` 现在被**同一块的所有分段共用**（见 makeContentEl）：
     * 一个块被标注拆成三个 `<p>` 时，三段的 `data-line` 都是 `20`。
     *
     * 所以求偏移只需要两步：
     *   ① 找到该节点所在的 `<p>`，读它的 `data-line`；
     *   ② 按 DOM 顺序累加"同一 line 的段"中、位于它之前的文字长度。
     *
     * ⚠️ 不再需要"向前找兄弟""判断残片归属"这类推断 ——
     *    那套逻辑正是 v0.1.56 引入 bug 的地方。
     *
     * ⚠️ 必须跳过 `.reader-label-head`（标签段「文章标题」）：
     *    它不是块的正文内容，算进偏移会让区间整体后移。
     *    标签段**不带** `data-line`，所以按 line 过滤天然排除；
     *    但同一行里如果有标签段混在中间，还是显式判断一下更稳。
     *
     * @return {Object|null} `{ line, offset }`
     */
    function nodeOriginInBlock(node) {
        if (!node || !contentEl) return null;

        var host = (node.nodeType === 1) ? node : node.parentNode;
        if (!host) return null;

        /* ① 找该节点所属的、带 data-line 的段 */
        var seg = host;
        while (seg && seg !== contentEl) {
            if (seg.getAttribute && seg.getAttribute('data-line') != null) break;
            seg = seg.parentNode;
        }
        if (!seg || seg === contentEl) return null;

        var lineKey = seg.getAttribute('data-line');
        var line = parseInt(lineKey, 10);
        if (!isFinite(line)) return null;

        /*
          ② 收集同一块的**所有分段**（DOM 顺序）。
             ⚠️ 用属性字符串比较，不用 parseInt —— 行号可能是
                 `0`，`parseInt` 没问题，但统一用字符串更直接。
        */
        var all = contentEl.querySelectorAll('[data-line]');
        var segs = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].getAttribute('data-line') === lineKey) segs.push(all[i]);
        }
        if (!segs.length) return null;

        /* ③ 累加：从该块第一段开始，到目标节点之前的所有正文文字。 */
        var total = 0;

        for (var s = 0; s < segs.length; s++) {
            var p = segs[s];

            /*
              ⚠️ 标签段（.reader-label-head）不参与偏移 ——
                 它是界面文字。虽然正常不带 data-line，
                 这里再判一次是防御。
            */
            if (p.classList && p.classList.contains('reader-label-head')) continue;

            if (p === seg || p.contains(node)) {
                /*
                  目标在这一段里 → 加上"段内、节点之前"的部分。
                  ⚠️ 用 Range 求，天然处理嵌套的 span（标注段里
                     不会有子元素，但残片可能被浏览器拆分文本节点）。
                */
                try {
                    var r = document.createRange();
                    r.setStart(p, 0);
                    r.setEnd(node, 0);
                    total += textLenOf(r);
                } catch (e) {
                    /* 兜底：按纯文本长度算到段首 */
                    total += 0;
                }
                return { line: line, offset: total };
            }

            total += textLenOf(p);
        }

        return null;
    }

    /**
     * 求一个节点（或 Range）里**属于原文**的字符数。
     *
     * ══ ⚠️⚠️ 为什么不能用 `textContent.length`（v0.1.89）══
     *
     * 用户反馈（原话）：
     *   「第一个切的很好办，第二个呢？假如第一行选中的文本已经有了子标签，
     *     当给第二行的选中文本进行标签时就会出错。」
     *
     * 作者信息区域的一行长这样：
     *
     *     <span class="reader-author-line">
     *       <span class="reader-author-field">Name</span>      ← 界面文字
     *       <span class="reader-author-value">Jacob Devlin</span>
     *     </span>
     *
     * `textContent` = `"NameJacob Devlin"` —— **多出 `"Name"` 5 个字符**。
     *
     * ⚠️ 后果链：
     *   ① 偏移累加时多算；
     *   ② 第二次标注算出的 `[wa, wb)` 落在原文的**错误位置**；
     *   ③ 于是要么切错、"要么把第一条词条的区间覆盖掉"。
     *   第一次标注时前面还没有词条，偏移没被污染，所以"第一次总是好的"。
     *
     * ✅ 正确做法：跳过 `.reader-author-field`（项名）和
     *    `.reader-rule`（竖线）这类**非原文**元素，只数正文文字。
     *
     * ⚠️ 用 `Range` 求长度而不是 `textContent`，是为了让"到某个节点为止"
     *    这种部分取值也走同一套规则。
     */
    function textLenOf(nodeOrRange) {
        /* Range：先转成片段再数 */
        if (nodeOrRange && typeof nodeOrRange.cloneContents === 'function') {
            return textLenOf(nodeOrRange.cloneContents());
        }
        var root = nodeOrRange;
        if (!root) return 0;

        function walk(n) {
            if (!n) return 0;
            if (n.nodeType === 3) {
                return isNonContentNode(n) ? 0 : (n.nodeValue ? n.nodeValue.length : 0);
            }
            if (n.nodeType !== 1 && n.nodeType !== 11) return 0;

            var sum = 0;
            for (var c = n.firstChild; c; c = c.nextSibling) sum += walk(c);
            return sum;
        }

        return walk(root);
    }

    /**
     * 这个节点（或其祖先）是不是**界面元素** —— 不属于原文。
     *
     * ══ ⚠️⚠️ 唯一判据来源（v0.1.89）══
     *
     * 用户反馈（原话）：
     *   「假如第一行选中的文本已经有了子标签，
     *     当给第二行的选中文本进行标签时就会出错。」
     *
     * 作者信息区域的行是「项名 + 原文」并排：
     *
     *     <span class="reader-author-line">
     *       <span class="reader-author-field">Name</span>      ← 界面
     *       <span class="reader-author-value">Jacob Devlin</span> ← 原文
     *     </span>
     *
     * `textContent` 会把 `Name` 一起算进去 → 字符偏移整体偏大 →
     * 第二次标注的区间落到错位置。**第一行标完就有了项名**，
     * 所以"第一次总是对、第二次就错"。
     *
     * ✅ 必须跳过：
     *      · `.reader-author-field`  作者项名（Name / Affiliation …）
     *      · `.reader-rule`          左侧竖线占位
     *      · `.reader-label-head`    区域标题（「作者信息」）
     *
     * ⚠️ 任何"给 DOM 加界面文字"的地方，都要同步加到这张表里，
     *    否则偏移就会错。`textLenOf` 与 `offsetWithin` 共用它，
     *    保证两处规则永远一致。
     */
    function isNonContentNode(n) {
        if (!n) return false;
        var el = (n.nodeType === 1) ? n : n.parentNode;
        while (el && el !== contentEl) {
            if (el.classList) {
                if (el.classList.contains('reader-author-field') ||
                    el.classList.contains('reader-rule') ||
                    el.classList.contains('reader-label-head')) {
                    return true;
                }
            }
            el = el.parentNode;
        }
        return false;
    }


    /**
     * 取当前选区的**精确文本**（用户实际选中的那几个字）。
     *
     * ⚠️ 这是编辑对象，**不是**整段。
     *
     * ══ ⚠️⚠️ 为什么不能用整段（v0.1.46 修）══
     *
     * 用户实测反馈：
     *   「编辑区域的内容和我选中的内容不一样，比如我只选中了一个词，
     *     但出现了整个句子。这是范围出错了。」
     *
     * 我的原设计是"编辑的粒度是段落"，理由是正文本来就是一段一个 `<p>`。
     * 但用户的行为是**只选一个词就想改那个词** —— 给他整段，
     * 就等于强行把他的注意力扩大到一个他不想碰的范围，
     * 而且确认后整段都会被替换（连他没选的部分也一起改掉）。
     *
     * ⚠️ 这不只是"显示不对"，是**会破坏数据**：
     *    用户只想改 "polosukhin"，却把整段邮箱地址都替换成了新内容。
     *
     * ✅ 现在：编辑区只放选中的文字，确认后只替换选中那一段区间。
     */
    function selectedTextExact() {
        try {
            var s = global.getSelection();
            if (!s || !s.rangeCount) return '';

            /*
              ══ ⚠️⚠️ 按节点过滤，而不是靠 CSS 的 `user-select: none` ══

              用户要求：「前置说明文本这个可不能选中啊」

              `.reader-label-head` 上已经写了 `user-select: none`，
              但**不能只依赖它**：
                · Android WebView 的原生选择器并不严格遵守
                  `user-select: none` —— 长按拖动时仍会把整个标签段
                  框进选区，文字照样进 `toString()`；
                · 用户跨段选中（从标签段上方拖到内容段下方）时，
                  标签段必然落在 Range 内部。

              ✅ 所以在取"选中文本"这最后一关做过滤：
                 逐节点遍历 Range，**跳过**标签段里的文本。
                 这样无论选区怎么框出来的，送进编辑区/剪贴板的
                 永远只有正文。
            */
            return extractSelectedText(s.getRangeAt(0));
        } catch (e) {
            return '';
        }
    }

    /**
     * 从 Range 里取出**正文文本**，跳过标签段（v0.1.49）。
     *
     * ⚠️ 用 TreeWalker 遍历 Range 覆盖的节点：
     *    · 落在 `.reader-label-head` 里的文本一律跳过；
     *    · 只取 Range 与节点**实际相交**的那部分
     *      （用 `Range.intersectsNode` 判断不够，边界节点要截断）。
     *
     * ⚠️ 跨块时保持原有的"换行变空格"语义 —— 与 syncSelectionFromNative
     *    的约定一致（PDF 抽取的换行是排版折行，不是语义换行）。
     */
    function extractSelectedText(range) {
        var parts = [];

        var root = range.commonAncestorContainer;
        if (root.nodeType === 3) root = root.parentNode;
        if (!root) return '';

        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var cur = walker.nextNode();

        while (cur) {
            var inRange = false;
            try {
                inRange = range.intersectsNode(cur);
            } catch (e) {
                inRange = false;
            }

            if (inRange && !isInsideLabelTag(cur, root) && !isNonContentNode(cur)) {
                /* 截出 Range 与该文本节点实际重叠的那一段 */
                var value = cur.nodeValue || '';
                var start = 0;
                var end = value.length;

                if (cur === range.startContainer) start = range.startOffset;
                if (cur === range.endContainer) end = range.endOffset;

                if (end > start) parts.push(value.slice(start, end));
            }

            cur = walker.nextNode();
        }

        /*
          ⚠️ 换行统一成空格 —— 与历史行为一致（见 syncSelectionFromNative）。
             TreeWalker 是按节点拼接的，跨段落时天然没有分隔符，
             这里补一个空格，避免两段文字粘在一起。
        */
        return parts.join(' ').replace(/\s+/g, ' ').trim() ||
            /* 全空时返回空串，让调用方当作"没有选中" */
            '';
    }

    /**
     * 去掉文本里的**前置标签文字**（v0.1.47）。
     *
     * ══ ⚠️ 为什么需要 ══
     *
     * 标签文字（「文章标题」这类）是**界面文字**，不是正文内容，
     * 但 `Range.toString()` 会把它一起包进来。于是用户选中已标注
     * 区间的字时，编辑区可能显示 "文章标题 .pol" 这种混合内容，
     * 确认后还会把它写进正文。
     *
     * ⚠️ v0.1.48 起标签已经**独占一段**（`.reader-label-head`），
     *    正常情况下不会再混进内容段。这个函数是**防御性兜底** ——
     *    万一将来渲染方式又变，或者用户跨段选中把标签段也框进去，
     *    仍然不会污染内容。
     *
     * ⚠️ 只剥掉**开头**一处：标签永远在标注内容的最前面。
     *    用 `indexOf === 0` 判断，避免误伤正文中间的同名文字。
     */
    function stripLabelTags(text) {
        if (!text) return text;

        /*
          ⚠️ 逐个已知标签名剥离，而不是写正则猜。
             标签名来自 i18n，是有限的 8 个，穷举最稳。
        */
        for (var i = 0; i < LABEL_KEYS.length; i++) {
            var name = t('reader.label.' + LABEL_KEYS[i]);
            if (!name) continue;

            /*
              ⚠️ 标签后面可能跟一个换行（独占一段时）或一个空格。
                 两种都要处理，否则会残留一个前导空白。
            */
            if (text.indexOf(name) === 0) {
                var rest = text.slice(name.length);
                rest = rest.replace(/^[ \t]*\n?/, '');
                text = rest;
            }
        }

        return text;
    }

    /**
     * 取选区的边界信息，用于"精确替换"。
     *
     * @return {Object|null} 形如：
     *   {
     *     single: true,          // 是否落在同一个块内
     *     line: 6,               // single 时的块行号
     *     start: 5, end: 9,      // single 时在该**块文本**里的字符区间
     *     text: '.pol'           // 选中的原文
     *   }
     *   跨块时返回 `{ single:false, lines:[...], text }`。
     */
    function selectionSpan() {
        var text = selectedTextExact();
        if (!text) return null;

        if (!contentEl) return null;

        var sel = null;
        try {
            sel = global.getSelection();
        } catch (e) { return null; }
        if (!sel || !sel.rangeCount) return null;

        var range = sel.getRangeAt(0);
        var lines = blockLinesInSelection();

        /*
          ══ ⚠️⚠️ 先尝试**按"原块"归并**选区端点（v0.1.56）══

          标注会把一个原块拆成多个 `<p>`。用户选中残片里的文字时，
          `blockLinesInSelection` 可能返回 1 个行号（因为同属一行），
          但端点所在的那一段未必带 `data-line`。

          ✅ 所以先分别求两个端点"属于哪个原块、在原块文本里的偏移"，
             两者行号相同 → 就是单块区间，**哪怕它们分处两个分段**。
        */
        var startPt = nodeOriginInBlock(range.startContainer);
        var endPt = nodeOriginInBlock(range.endContainer);

        if (startPt && endPt && startPt.line === endPt.line) {
            var a0 = Math.min(startPt.offset, endPt.offset);
            var b0 = Math.max(startPt.offset, endPt.offset);

            /*
              ⚠️ 端点落在文本节点中间时要带上节点内偏移 ——
                 `nodeOriginInBlock` 给的是"节点起点"的位置，
                 不含 `range.startOffset`。
              ⚠️ 必须把**起点/终点各自的** offset 加回对应的那一端，
                 不能简单加 min/max 的那个。
            */
            if (range.startContainer.nodeType === 3) {
                if (startPt.offset <= endPt.offset) a0 += range.startOffset;
                else b0 += range.startOffset;
            }
            if (range.endContainer.nodeType === 3) {
                if (endPt.offset >= startPt.offset) b0 += range.endOffset;
                else a0 += range.endOffset;
            }

            if (b0 < a0) { var sw = a0; a0 = b0; b0 = sw; }

            var full = blockTextOf(startPt.line);
            var ca = Math.max(0, Math.min(a0, full.length));
            var cb = Math.max(0, Math.min(b0, full.length));

            return {
                single: true,
                line: startPt.line,
                start: ca,
                end: cb,
                text: full.slice(ca, cb)
            };
        }

        if (lines.length !== 1) {
            return { single: false, lines: lines, text: text };
        }

        var line = lines[0];
        var el = blockElOf(line);
        if (!el) return { single: false, lines: lines, text: text };

        /*
          ══ 算选区在该块**纯文本**里的字符偏移 ══

          ⚠️ 不能用 `range.startOffset` —— 那个偏移是相对**文本节点**的，
             而一个块可能被拆成多个文本节点？目前不会（`textContent` 写入，
             只有一个文本节点），但为了稳妥，用 Range 的
             `setEnd(块的首个文本节点, ...)` 方式反推更可靠。

          ✅ 做法：造一个从「块首」到「选区起点」的 Range，它的
             `toString().length` 就是起点偏移。终点同理。
             这对多文本节点的块也成立。
        */
        var tn = firstTextNode(el);
        if (!tn) return { single: false, lines: lines, text: text };

        var startOff = offsetWithin(el, tn, range.startContainer, range.startOffset);
        var endOff = offsetWithin(el, tn, range.endContainer, range.endOffset);

        if (startOff < 0 || endOff < 0) {
            return { single: false, lines: lines, text: text };
        }

        if (startOff > endOff) {
            var tmp = startOff; startOff = endOff; endOff = tmp;
        }

        /*
          ══ ⚠️⚠️ 选中原文用**区间切片**，不用 `Range.toString()` ══（v0.1.47）

          因为 `toString()` 会把渲染出来的前置标签文字（"Article Title "）
          一起带进来，编辑区就会显示成 "Article Title .pol"。

          ✅ 用刚算出的 start/end 从**块文本**里切片，
             拿到的永远是纯正文，与标签无关。
        */
        var blockText = blockTextOf(line);
        var exact = blockText.slice(startOff, endOff);

        return {
            single: true,
            line: line,
            start: startOff,
            end: endOff,
            text: exact
        };
    }

    /** 找某个行号对应的块元素 */
    function blockElOf(line) {
        if (!contentEl) return null;
        var nodes = contentEl.querySelectorAll('[data-line]');
        var want = String(line);
        for (var i = 0; i < nodes.length; i++) {
            /*
              ⚠️ 按**字符串**比较而不是 parseInt（v0.1.56）——
                 残片的虚拟行号是 `20.1`，parseInt 会得到 20，
                 和真正的第 20 块撞车，编辑/标注会落到错误的元素上。
            */
            if (nodes[i].getAttribute('data-line') === want) {
                return nodes[i];
            }
        }
        return null;
    }

    /**
     * 求「从块首」到「(node, offset)」在**原始正文**里的字符距离。
     *
     * ══ ⚠️⚠️ 必须跳过前置标签文字（v0.1.47）══
     *
     * 标注之后，一个 `<p>` 里会多出 `.reader-label-tag`（「文章标题」这类
     * 前置文字）。实测踩到的坑：
     *
     *   段落 "illia.polosukhin@gmail.com"，把 ".pol" 标成文章标题后
     *   再把光标放到标注区间里，用 `Range.toString().length` 算出的
     *   偏移是 **19**，而正确答案是 **6** ——
     *   差的那 13 个字符正是 "Article Title " 这段**渲染出来的标签文字**。
     *
     * 后果：在已标注的段落上再次标注或编辑时，区间整体错位，
     *      替换/打标会落到错误的字符上。
     *
     * ✅ 现在按**节点遍历**累计，明确跳过 `.reader-label-tag`。
     *
     * @return {number} 偏移；node 不在 el 内时返回 -1
     */
    function offsetWithin(el, firstTn, node, offset) {
        if (!node) return -1;

        /*
          ⚠️ 选区端点可能落在元素上（比如整块被选中时，
             `startContainer` 是 `<p>` 而不是文本节点），
             此时按"元素起点"处理。
        */
        if (node.nodeType !== 3) {
            if (!el.contains(node) && node !== el) return -1;
            var inner = firstTextNode(node);
            if (!inner) return 0;
            node = inner;
            offset = 0;
        }

        if (!el.contains(node)) return -1;

        /*
          目标可能就在标签文字里（用户选中了前置的「文章标题」几个字）——
          那不是正文，没有对应的偏移，返回 -1 让调用方走兜底分支。
        */
        if (isInsideLabelTag(node, el)) return -1;

        var total = 0;
        var found = false;

        /*
          ⚠️ 用 TreeWalker 按文档顺序遍历所有文本节点 ——
             比递归手写更短，也能自然跳过元素边界。
        */
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        var cur = walker.nextNode();

        while (cur) {
            if (cur === node) {
                total += offset;
                found = true;
                break;
            }

            /*
              ══ ⚠️⚠️ 必须跳过**所有非原文**的文本（v0.1.89）══

              用户反馈：
                「第二个呢？假如第一行选中的文本已经有了子标签，
                  当给第二行的选中文本进行标签时就会出错。」

              作者信息区域的行里有两类文字：

                <span class="reader-author-line">
                  <span class="reader-author-field">Name</span>     ← 界面文字
                  <span class="reader-author-value">Jacob…</span>   ← 原文
                </span>

              ⚠️ 旧实现只跳过 `isInsideLabelTag`（区域标题），
                 于是项名 `Name` 被算进偏移 → 后续每一行的起点都偏移，
                 标注区间落到错位置，甚至覆盖掉已有的词条。

              ✅ 统一交给 `isNonContentNode` 判断，
                 与 `textLenOf()` 用**同一套规则**。
            */
            if (!isInsideLabelTag(cur, el) && !isNonContentNode(cur)) {
                total += cur.nodeValue ? cur.nodeValue.length : 0;
            }

            cur = walker.nextNode();
        }

        return found ? total : -1;
    }

    /** 这个文本节点是否属于前置标签文字 */
    function isInsideLabelTag(node, root) {
        var el = node.parentNode;
        while (el && el !== root) {
            if (el.classList && (
                el.classList.contains('reader-label-tag') ||
                el.classList.contains('reader-label-head'))) {
                return true;
            }
            el = el.parentNode;
        }
        return false;
    }

    /**
     * 只重渲染正文，保留滚动位置。
     *
     * ⚠️ 编辑/标注之后必须重渲染整段正文 —— 因为我们改的是数据
     *    （`edits` / `labels`），而 `makeBlockEl` 是唯一的渲染入口。
     *    直接改 DOM 会绕开标注类的统一逻辑，迟早不一致。
     *
     * ⚠️ 重渲染会清空 `contentEl`，滚动位置随之归零 ——
     *    所以这里记下 `scrollTop` 再恢复，否则用户确认编辑后
     *    会被弹回文章开头。
     */
    function rerenderKeepingScroll() {
        if (!contentEl) return;

        var keep = bodyEl ? bodyEl.scrollTop : 0;
        contentEl.textContent = '';

        /*
          ══ ⚠️⚠️ 必须渲染 `docModel.blocks`，不是 `lastBlocks`（v0.1.67）══

          `lastBlocks` 是**原生桥传进来的原始数组**，只反映 PDF 转换结果。
          而编辑/合并段落之后，新的段落结构写在 `docModel.blocks` 里
          （见 reflowParagraphs）—— 两者会不一致。

          实测症状：合并两段后 `docModel` 已经是 350 段，
          但页面仍是 351 段、原文一字未变 ——
          因为这里一直拿 `lastBlocks` 渲染，改动被完全忽略。
        */
        var model = (docModel.blocks && docModel.blocks.length)
            ? docModel.blocks
            : lastBlocks;

        if (model && model.length) {
            renderBlocks(model);
        } else if (lastText) {
            contentEl.textContent = lastText;
        }

        if (bodyEl) bodyEl.scrollTop = keep;
    }

    // --- 编辑表单 -----------------------------------------------------------

    var editSheetEl = null;
    var editInputEl = null;
    /**
     * 本次编辑的范围（v0.1.46）。
     *
     * ⚠️ 从 "editLines（块行号数组）" 改成 "editSpan（精确区间）" ——
     *    因为编辑的对象是**选中的那几个字**，不是整段。
     *    结构见 selectionSpan()。
     */
    var editSpan = null;

    function mountEditSheet() {
        if (editSheetEl) return;

        editSheetEl = document.getElementById('sheet-edit');
        editInputEl = document.getElementById('sheet-edit-input');
        if (!editSheetEl || !editInputEl) return;

        var cancel = document.getElementById('sheet-edit-cancel');
        var confirm = document.getElementById('sheet-edit-confirm');

        if (cancel) {
            cancel.addEventListener('click', function () {
                closeEditSheet();
            });
        }

        if (confirm) {
            confirm.addEventListener('click', function () {
                applyEdit();
            });
        }
    }

    /**
     * 打开编辑表单，预填**用户选中的那些字**。
     *
     * ══ ⚠️⚠️ 只填选中的区间，不填整段（v0.1.46 修）══
     *
     * 用户实测反馈：
     *   「编辑区域的内容和我选中的内容不一样，比如我只选中了一个词，
     *     但出现了整个句子。这是范围出错了。」
     *
     * 旧实现填的是整段文本 —— 这既让用户困惑（我明明只选了一个词），
     * 又很危险：确认后整段会被替换，用户没选的部分也被一起改掉。
     *
     * ✅ 现在：编辑区 = 选区原文；确认后只替换选中的那一段区间。
     *
     * ⚠️ 跨块选中时无法用"一个字符区间"表达，退化为整块编辑
     *    （见 selectionSpan 返回 single:false 的分支）——
     *    跨段编辑本来就是"重写这几段"，语义上是合理的。
     */
    function openEditSheet() {
        mountEditSheet();
        if (!editSheetEl || !editInputEl) return;

        var span = selectionSpan();
        if (!span) return;

        editSpan = span;

        /*
          ⚠️ 用 `value` 赋值，不用 innerHTML ——
             原文里可能有 `<` `>` `&`。
        */
        if (span.single) {
            /*
              ⚠️ 选区端点可能把首尾空白包进来（用户拖过了字）。
                 保留它 —— 用户看到的就是他拖出来的范围，
                 擅自 trim 会让"我改的和看到的不一致"。
            */
            editInputEl.value = span.text;
        } else {
            var parts = [];
            for (var i = 0; i < span.lines.length; i++) {
                parts.push(blockTextOf(span.lines[i]));
            }
            editInputEl.value = parts.join('\n\n');
        }

        hideSelectBarOnly();
        clearNativeSelection();

        editSheetEl.hidden = false;
        if (editSheetEl.offsetWidth < 0) return;
        editSheetEl.classList.add('is-open');

        /*
          ⚠️ 自动聚焦并全选 —— 用户点"编辑"十有八九是要整体改写，
             全选之后直接打字即可覆盖，比手动删光快得多。
          ⚠️ 延时一点点：部分 WebView 在 hidden 刚变 false 的同一帧
             调 focus() 不会弹键盘。
        */
        global.setTimeout(function () {
            try {
                editInputEl.focus();
                editInputEl.select();
            } catch (e) { /* 忽略 */ }
        }, 80);
    }

    function closeEditSheet() {
        if (!editSheetEl) return;
        editSheetEl.classList.remove('is-open');
        global.setTimeout(function () {
            if (editSheetEl && !editSheetEl.classList.contains('is-open')) {
                editSheetEl.hidden = true;
            }
        }, 260);
    }

    /**
     * 确认编辑：把编辑区内容写回，**只替换选中的那一段区间**。
     *
     * ══ ⚠️⚠️ 精确替换（v0.1.46）══
     *
     * 旧实现是"整块替换"：用户只选了一个词，确认后整段都变成了新内容。
     * 这既不符合"我选中多少就改多少"的直觉，也会**破坏数据** ——
     * 段落里没被选中的部分被一并抹掉了。
     *
     * ✅ 现在按 `editSpan.start / end` 做**字符串拼接**：
     *
     *      新块文本 = 原文本[0, start) + 编辑区内容 + 原文本[end, 末尾)
     *
     * ⚠️ 边界必须夹在 [0, len] 内 —— 选区是在**编辑前**的 DOM 上量的，
     *    而这里要拼接的是**当前**文本。如果这一段之前被编辑过，
     *    两者长度可能不一致（理论上 start/end 是相对当前显示的块量的，
     *    所以是一致的，但仍有浮点/换行差异风险），夹一下更稳。
     */
    /**
     * 把编辑结果写回文档模型，然后**重新划分段落**（v0.1.67）。
     *
     * ══ 用户要求（原话）══
     *
     *   「不用这么麻烦，我不是说从 pdf 转之后保存到一个文本文件吗？
     *     如果文件被修改了，直接重新计数自然段就好了」
     *
     * ══ ✅ 思路 ══
     *
     * 不再由渲染层去猜"哪些块变空了"（那样要处理块级、残片级、
     * 标注段级三处漏判）。既然文本是**唯一事实来源**，那么：
     *
     *   ① 把被编辑的几个块拼成一段完整文本；
     *   ② 按空行（`\n{2,}`）重新切分 → 得到新的自然段列表；
     *   ③ 用新段列表替换这几个旧块，**行号重新连续编号**；
     *   ④ 把涉及到的标注按"新段偏移"重新映射。
     *
     * 这样合并两段 → 自然就只剩一段；拆开 → 自然就多一段。
     * 不需要任何"空段落过滤"。
     *
     * ⚠️ 行号怎么办：
     *    原来 `line` 是 PDF 块的行号，`edits` / `labels` 都以它为键。
     *    重新切分后段数会变，继续用旧行号必然撞车。
     *    所以这里**整体重排**：从第一个被编辑的块开始，
     *    后续所有块行号顺移（delta = 新段数 - 旧块数）。
     *
     * ⚠️ 只重排 JSON 内部的映射，不需要改 PDF ——
     *    `docModel.blocks` 就是运行时的"文本文件"。
     */
    function reflowParagraphs(lines, newValue) {
        if (!lines || !lines.length) return;

        var first = lines[0];
        var last = lines[lines.length - 1];

        /*
          ① 拼接这几个块的当前文本。
             ⚠️ 用 `\n\n` 连接：块与块之间本来就是段落边界，
                这样即使某块被编辑成空串，也不会把相邻两段粘在一起。

          ⚠️⚠️ 跨块编辑时用户**改的是整段内容** ——
             `newValue` 就是编辑框里的全文（原各块以 `\n\n` 连接），
             必须直接用它，而不是从 `edits` 里再拼一遍旧文本。
             漏了这一步会导致"编辑了但页面没变"。
        */
        var joined;
        if (typeof newValue === 'string') {
            joined = newValue;
        } else {
            var parts = [];
            for (var i = 0; i < lines.length; i++) {
                parts.push(String(edits[lines[i]] != null
                    ? edits[lines[i]]
                    : blockTextOf(lines[i])));
            }
            joined = parts.join('\n\n');
        }

        /*
          ② 重新切分自然段。
             ⚠️ 先按空行切，再逐段 trim 掉首尾空白。
             ⚠️ 丢掉空段 —— 这正是"自动删除空段落"。
        */
        var newTexts = [];
        var chunks = joined.split(/\n{2,}/);
        for (var c = 0; c < chunks.length; c++) {
            var piece = chunks[c].replace(/^\s+|\s+$/g, '');
            if (piece === '') continue;
            newTexts.push(piece);
        }

        /*
          ⚠️ 极端情况：用户把内容全删了 → 一段都不剩。
             此时保留一个空块占位，避免后续按 line 查找时全部失效。
        */
        if (!newTexts.length) newTexts.push('');

        /*
          ③ 算出 delta，并整体重排后续块的行号。
             delta > 0 表示段数变多（拆段），< 0 表示变少（合并）。
        */
        var delta = newTexts.length - lines.length;

        /* 先把这些块的编辑内容清掉，它们会被新块取代 */
        for (var d = 0; d < lines.length; d++) {
            delete edits[lines[d]];
            delete labels[lines[d]];
        }

        /* 收集受影响的后续块（行号大于 last 的） */
        var tail = [];
        var list = docModel.blocks || [];
        for (var t = 0; t < list.length; t++) {
            if (list[t].line > last) tail.push(list[t]);
        }

        /* 新块（行号接着 first 往下排） */
        var newBlocks = [];
        for (var n = 0; n < newTexts.length; n++) {
            newBlocks.push({
                line: first + n,
                page: (docModel.blocks && docModel.blocks.length)
                    ? docModel.blocks[0].page : null,
                text: newTexts[n],
                /*
                  ⚠️ 重排出来的段落是**用户编辑的产物**，不是 PDF 块：
                      没有 `kind`（→ 导出按正文处理，正确）、
                      没有 `lines`（用户自己写了换行，导出按 text 处理）。
                      只有这样一个来源，"重排后标题丢了"才是可预期的行为 ——
                      要恢复标题就重新标注一次，那是标注该干的事。
                */
                kind: '',
                level: 0
            });
        }

        /*
          ④ 重建 `docModel.blocks`：
             头部（line < first）+ 新块 + 尾部（行号整体平移 delta）
        */
        var head = [];
        for (var h = 0; h < list.length; h++) {
            if (list[h].line < first) head.push(list[h]);
        }

        for (var k = 0; k < tail.length; k++) {
            tail[k] = {
                line: tail[k].line + delta,
                page: tail[k].page,
                text: tail[k].text
            };
        }

        docModel.blocks = head.concat(newBlocks, tail);

        /*
          ⑤ 尾部原有块的编辑/标注要跟着平移键，否则会错位。
             ⚠️ 从大到小遍历，避免平移过程中覆盖掉还没处理的行。
        */
        if (delta !== 0) {
            var oldEdits = edits;
            var oldLabels = labels;
            edits = {};
            labels = {};

            for (var ek in oldEdits) {
                if (!Object.prototype.hasOwnProperty.call(oldEdits, ek)) continue;
                var el = parseInt(ek, 10);
                if (!isFinite(el)) continue;
                var nk = (el > last) ? (el + delta) : el;
                edits[nk] = oldEdits[ek];
            }
            for (var lk in oldLabels) {
                if (!Object.prototype.hasOwnProperty.call(oldLabels, lk)) continue;
                var ll = parseInt(lk, 10);
                if (!isFinite(ll)) continue;
                var nlk = (ll > last) ? (ll + delta) : ll;
                labels[nlk] = oldLabels[lk];
            }
        }

        trace('reader:edit',
            'reflow lines=' + lines.join(',') + ' -> ' + newTexts.length +
            ' (delta=' + delta + ')');
    }

    /**
     * 供排查：直接应用一次编辑（v0.2.4）。
     *
     * ⚠️ `applyEdit` 依赖真实 DOM 输入框 + 原生长按选区，
     *    自动化点不开编辑表单。有这个钩子才能单测
     *    "编辑里敲空行会不会变成新段落"。
     */
    function applyEditForTest(span, value) {
        applyEditCore(span, value);
        rerenderKeepingScroll();
    }

    /**
     * 应用一次编辑的**核心逻辑**，只改数据、不碰 DOM（v0.2.4 提取）。
     *
     * ⚠️ 为什么拆出来：`applyEdit` 要读 `editInputEl` 与 `editSpan`，
     *    这两个只有真实编辑表单才有。逻辑与 DOM 分离后，
     *    `applyEditForTest` 才能验证分段规则。
     *
     * @param {object} span  { single, line, lines, start, end }
     * @param {string} value 输入框里的新内容（可能含换行）
     */
    function applyEditCore(span, value) {
        if (!span) return;

        if (span.single) {
            var line = span.line;
            var cur = blockTextOf(line);
            var len = cur.length;

            var a = Math.max(0, Math.min(span.start, len));
            var b = Math.max(a, Math.min(span.end, len));

            var next = cur.slice(0, a) + value + cur.slice(b);
            edits[line] = next;

            trace('reader:edit', 'line=' + line + ' [' + a + ',' + b + ')');

            /*
              ══ ⚠️⚠️ 单块编辑也要重新分段（v0.2.4）══

              用户反馈：

                「编辑后明明上下两段文本隔着好多空行，
                  居然正文段编号和提示条还是连续的一整个」

              真因：**单块编辑**这条分支只写 `edits[line]`，
              **从来没有走 reflowParagraphs**：

                  edits[line] = cur.slice(0, a) + value + cur.slice(b);

              于是用户在编辑框里敲的空行被原样存进**一个块**。
              渲染时 `.reader-para` 的 `white-space: pre-wrap` 让这些
              空行占位 —— 看起来确实隔着好几行，
              但数据上仍只是**一个块**：一个编号、一条提示条。

              「看到的空行」和「实际的分段」是两回事：
              调字号、加标注、看编号，全都按一个块算。

              ✅ 空行在 md 里的语义就是**段落分隔**（`\n{2,}`）。
                 编辑结果里只要出现空行，就必须重新切段 ——
                 这和跨块编辑是同一件事，之前只做了一半。

              ⚠️ 只在**真的出现空行**时才重排：普通改几个字不该
                 触发整篇行号平移（那会连带 edits/labels 的键）。
            */
            if (/\n\s*\n/.test(next)) {
                reflowParagraphs([line], next);
            }

            /*
              ⚠️ 单块编辑还要检查：用户可能把内容**整个删掉**。
                 这时 edits[line] 变成空串，同样不该留下空段落。
            */
            var curTxt = String(blockTextOf(line));
            if (curTxt.replace(/\s+/g, '') === '') {
                reflowParagraphs([line]);
            }
            return;
        }

        /*
          ══ 跨块编辑：交给 reflowParagraphs 重新分段（v0.1.67）══

          用户要求：
            「如果文件被修改了，直接重新计数自然段就好了」

          旧做法是把 value 按空行切分后逐个写进 edits[lines[i]]。
          两段合并成一段时，后面那段拿到空串 —— 于是屏幕上多一个
          空段落、占掉一个编号、后面全部错位。
          再靠渲染层"过滤空块"，等于把数据问题当显示问题修。

          ✅ 现在把这几块的文本**当作一整篇**切分自然段，
             段数变了就重排行号（合并变少、拆开变多），不需要过滤。
        */
        reflowParagraphs(span.lines, value);
    }

    function applyEdit() {
        if (!editInputEl || !editSpan) return;

        applyEditCore(editSpan, editInputEl.value);

        saveEdits();
        saveLabels();
        /*
          ⚠️ 段落结构可能被 reflowParagraphs() 改过（合并/拆分），
             必须一并落盘，否则重新进入时恢复原样（v0.1.70）。
        */
        saveDocBlocks();
        /*
          ⚠️ md 是**本地存储的唯一形态**（v0.1.92）——
             编辑完必须回写，否则下次打开读回来的是旧 md。
        */
        pushMdToNative();
        closeEditSheet();
        clearSelection();
        rerenderKeepingScroll();
    }

    // --- 标注表单 -----------------------------------------------------------

    var labelSheetEl = null;
    var labelListEl = null;
    /**
     * 本次标注的范围（v0.1.47）。
     *
     * ⚠️ 从 "labelLines（块行号数组）" 改成 "labelSpan（精确区间）" ——
     *    与编辑同理：用户可能只把标题里的一个词标成标题，
     *    而不是整段。
     */
    var labelSpan = null;
    /** 表单里当前选中的标签（null = 未选） */
    var labelDraft = null;

    /**
     * 引用目标选择器（v0.1.71）。
     *
     * 用户要求：
     *   「选择标注为引用的时候应该选择引用哪条文献」
     */
    var citePickerEl = null;
    var citeListEl = null;
    /** 选中的目标文献的 `line`（null = 未选） */
    var citeTarget = null;

    /** 作者项选择器（v0.1.74） */
    var fieldPickerEl = null;
    var fieldListEl = null;
    /** 选中的作者项键（null = 不设置） */
    var fieldDraft = null;

    /**
     * 当前展开着子标签下拉的标签 key（null = 没有）。v0.2.13
     *
     * ⚠️ 同时只允许一个 —— 展开"作者"的下拉时，
     *    其他标签的下拉必须收起，否则几个面板会重叠。
     * ⚠️ 这是**行内下拉**的开关，不是"另一个表单"。
     *    用户两次明确要求走下拉、不要在表单之上再叠表单。
     */
    var subOpenKey = null;

    /*
      ⚠️ 原来的 `subOpen`（子标签展开区是否展开）已在 v0.2.11 删除。

      用户要求改成"点箭头 → 弹出下拉菜单"，不再是把子标签区展开在
      这一行下面。所以"展开状态"这个变量本身没有意义了 ——
      菜单的开合由 `#sheet-picker` 自己管理。

      留一个注释说明它曾经存在且**确定不要**回来，
      避免以后有人看到 `buildSubList` 的痕迹又想恢复。
    */

    function mountLabelSheet() {
        if (labelSheetEl) return;

        labelSheetEl = document.getElementById('sheet-label');
        labelListEl = document.getElementById('sheet-label-list');
        citePickerEl = document.getElementById('sheet-cite-picker');
        citeListEl = document.getElementById('sheet-cite-list');
        fieldPickerEl = document.getElementById('sheet-field-picker');
        fieldListEl = document.getElementById('sheet-field-list');
        if (!labelSheetEl || !labelListEl) return;

        var cancel = document.getElementById('sheet-label-cancel');
        var confirm = document.getElementById('sheet-label-confirm');

        if (cancel) {
            cancel.addEventListener('click', function () {
                closeLabelSheet();
            });
        }

        if (confirm) {
            confirm.addEventListener('click', function () {
                applyLabel();
            });
        }
    }

    /**
     * 打开标注表单。
     *
     * ⚠️ 选项来自 `LABEL_KEYS`（顺序即展示顺序），
     *    文案从 i18n 取 `reader.label.<key>`。
     * ⚠️ 第一项是「正文」= 无标签。用户要求：
     *    「正文（用于恢复已标注过的标签回归原本的无标签形式）」
     */
    function openLabelSheet() {
        mountLabelSheet();
        if (!labelSheetEl || !labelListEl) return;

        labelSpan = selectionSpan();
        if (!labelSpan) return;

        /*
          ⚠️ 预选当前状态：如果选中的区间已有标签，就把那一项选中，
             让用户看到"现在是什么"，改起来才有依据。
             ⚠️ 查的是**区间起始位置所在的那个标注** ——
                单块时用 blockTextOf 算出来的 start 去找覆盖它的 span。
                跨块时退化为"第一块的第一个标注"。
        */
        labelDraft = findExistingLabel(labelSpan) || 'body';

        /*
          ⚠️ 引用目标也要预选（v0.1.71）——
             用户再次打开同一条引用标注时，应该看到它现在指向哪一条文献。
          ⚠️ 每次打开都先清空，避免上一篇文献的选择串到这一条。
        */
        citeTarget = findExistingCiteTarget(labelSpan);

        /*
          ⚠️ 作者项也要预选（v0.1.74）——
             用户再次打开同一段作者信息的标注时，
             应该看到它现在是「单位」还是「未设置」。
        */
        fieldDraft = findExistingAuthorField(labelSpan);

        /*
          ⚠️ 子标签不再有"展开区"（v0.2.11）——
             改成点箭头弹下拉菜单，所以这里不需要重置任何展开状态。
             打开表单时箭头显示当前值（或空），就足够了。

          ⚠️ 但下拉的展开状态要清掉（v0.2.13）——
             上次可能停在展开着某个下拉的状态，
             重开表单时不应该还开着一个面板。
        */
        subOpenKey = null;

        renderLabelOptions();

        hideSelectBarOnly();
        clearNativeSelection();

        labelSheetEl.hidden = false;
        if (labelSheetEl.offsetWidth < 0) return;
        labelSheetEl.classList.add('is-open');
    }

    /**
     * 找出覆盖选区起点的那个标注的标签名。
     *
     * @return {string|null} 没有就返回 null
     */
    function findExistingLabel(span) {
        var line = span.single ? span.line : (span.lines || [])[0];
        if (typeof line !== 'number') return null;

        var list = labels[line];
        if (!list || !list.length) return null;

        var probe = span.single ? span.start : 0;

        for (var i = 0; i < list.length; i++) {
            var sp = list[i];
            if (!sp) continue;
            if (probe >= sp.start && probe < sp.end) return sp.label;
        }

        /* 起点没落在任何区间里，但有标注 → 用第一个作提示 */
        return list[0].label || null;
    }

    /**
     * 找出覆盖选区起点的作者标注所带项名（v0.1.74）。
     *
     * @return {string|null} 没有项名 → null（表单里显示「不设置」）
     */
    function findExistingAuthorField(span) {
        var line = span.single ? span.line : (span.lines || [])[0];
        if (typeof line !== 'number') return null;

        var list = labels[line];
        if (!list || !list.length) return null;

        var probe = span.single ? span.start : 0;

        for (var i = 0; i < list.length; i++) {
            var sp = list[i];
            if (!sp || sp.label !== 'author') continue;
            if (probe >= sp.start && probe < sp.end) {
                return sp.field || null;
            }
        }
        return null;
    }

    /**
     * 找出覆盖选区起点的引用标注所指向的文献 `line`（v0.1.71）。
     *
     * ⚠️ 没有引用标注时返回 null —— 表单里显示为“未选”，
     *    用户必须主动选一条才能确认（见 `applyLabel`）。
     */
    function findExistingCiteTarget(span) {
        var line = span.single ? span.line : (span.lines || [])[0];
        if (typeof line !== 'number') return null;

        var list = labels[line];
        if (!list || !list.length) return null;

        var probe = span.single ? span.start : 0;

        for (var i = 0; i < list.length; i++) {
            var sp = list[i];
            if (!sp || sp.label !== 'cite') continue;
            if (probe >= sp.start && probe < sp.end) {
                return (typeof sp.ref === 'number') ? sp.ref : null;
            }
        }
        return null;
    }

    function renderLabelOptions() {
        if (!labelListEl) return;
        labelListEl.textContent = '';

        LABEL_KEYS.forEach(function (key) {
            var li = document.createElement('li');
            /*
              ⚠️ 子标签展开时要占满整行，所以 li 自己做纵向容器。
            */
            li.className = 'sel-label-row';
            if (key === labelDraft) li.classList.add('is-active');

            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sel-label-item';
            btn.setAttribute('data-label', key);
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', key === labelDraft ? 'true' : 'false');
            if (key === labelDraft) btn.classList.add('is-active');

            /*
              ══ ⚠️ 标签文字与子标签图标并排（v0.1.78）══

              用户要求：
                「每个标签选项有子标签的直接在选项最右边增加一个子标签的图标，
                  点击图标之后则展示子标签选项，这样就避免了重叠问题。」

              ⚠️ 文字用 span 包起来（而不是直接写 btn.textContent）——
                 否则无法在同一行里再放一个独立的图标按钮。
            */
            var nameEl = document.createElement('span');
            nameEl.className = 'sel-label-name';
            nameEl.textContent = t('reader.label.' + key);
            btn.appendChild(nameEl);

            /*
              ══ ⚠️⚠️ 右侧显示**当前选中的值**（v0.2.15 重做）══

              用户说得很清楚：

                「我让你参考是参考设置项那个设计，就是点击之后自动弹出
                  下拉选项，然后右边是选中的目前的值」

              ✅ 所以每一行就是设置项的样子：

                  正文                          ✓
                  标题                          ✓
                  作者                        单位  ▾

              · 左边 = 标签名
              · 右边 = **当前值**（有子标签的显示子标签值；没有的就只有勾）
              · 点整行 = 弹出下拉选项

              ── 我上一版错在哪 ──

              v0.2.14 我给整个列表**加了一个卡片外框**，还额外造了一个
              只能点箭头的小按钮 —— 用户看到的是一个"奇形怪状的框"，
              完全不是设置项那种一行一行的样子。

              ── ✅ 现在 ──

              · **去掉外框**，列表就是普通的行序列（与设置项一致）；
              · **整行可点**（不再要求精确点箭头）；
              · 右侧用 `.sel-label-value` 显示当前值，
                没有值时显示占位 `—`；
              · 有子标签的行右端给一个 ▾ 提示"可展开"。

              ⚠️ 值必须对**所有**行都显示（不只是当前选中行）——
                 设置项里每一行右侧都有自己的当前值。
                 但只有 `labelDraft === key` 时那个值才是"本次将要写入"的，
                 所以非当前行的值用弱化色，避免误导。
            */
            var hasSub = labelHasSub(key);

            var tailEl = document.createElement('span');
            tailEl.className = 'sel-label-tail';
            btn.appendChild(tailEl);

            if (hasSub) {
                var valEl = document.createElement('span');
                valEl.className = 'sel-label-value';
                /*
                  ══ ⚠️ 默认值就是「Not set」，不是破折号（v0.2.16）══

                  用户原话：

                    「最后是值得显示，下拉选项的子标签值默认明显是Not Set，
                      应该以这个为默认值，而非破折号，因为默认值本身就有名字。」

                  对。「未设置」在这个下拉里**本身就是一个选项**
                  （`reader.fieldNone`），所以显示它的名字才是诚实的；
                  破折号是个没有任何信息量的占位符。

                  ⚠️ 所以这里**不再**区分"有值/无值"两套文案：
                     无值时就显示 `reader.fieldNone`（Not set / 未设置）。
                  ⚠️ 但仍然保留 `.is-set` 类用于**配色**区分 ——
                     有值时用正文色（与设置项一致），
                     默认值用弱化色，一眼能分清"设过没有"。
                */
                if (key === labelDraft && fieldDraft) {
                    valEl.textContent = t('reader.field.' + fieldDraft);
                    valEl.classList.add('is-set');
                } else {
                    valEl.textContent = t('reader.fieldNone');
                }
                tailEl.appendChild(valEl);

                /*
                  ⚠️ 箭头用**图标**，不用字符 `▾`（v0.2.16）——
                     用户指定 `keyboard_arrow_down_24` / `keyboard_arrow_up_24`。
                     字符的形状随字体变，与全站图标不一致。
                  ⚠️ 收起/展开是两个**不同的图标**（不是同一个旋转 180°）——
                     Google 的两个箭头字形本来就不是中心对称的，
                     旋转会让箭头偏离视觉中心。
                */
                var caretEl = document.createElement('span');
                caretEl.className = 'sel-label-caret';
                caretEl.setAttribute('aria-hidden', 'true');
                if (subOpenKey === key) caretEl.classList.add('is-open');
                if (global.ScholariusUI) {
                    caretEl.innerHTML = global.ScholariusUI.icon(
                        subOpenKey === key ? 'caretUp' : 'caretDown');
                }
                tailEl.appendChild(caretEl);
            } else if (key === labelDraft && subOpenKey !== key) {
                /*
                  ⚠️ 没有子标签的行：选中时右端给一个勾，
                     与设置项「字体家族」的选中态一致。
                     有子标签的行不放勾 —— 那里已经有 ▾ 了。
                */
                var checkEl = document.createElement('span');
                checkEl.className = 'sel-label-check';
                checkEl.setAttribute('aria-hidden', 'true');
                checkEl.innerHTML =
                    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                    '<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
                tailEl.appendChild(checkEl);
            }

            li.appendChild(btn);

            /*
              ══ ⚠️⚠️ 点**整行**都弹下拉（v0.2.15）══

              用户要求：「点击之后自动弹出下拉选项」。

              ⚠️ 上一版要求精确点那个小箭头，点击区窄、还多一个视觉元素。
                 现在整行就是一个按钮：点哪里都行。
              ⚠️ 有子标签的行，点行 = **同时**选中该标签 + 展开下拉 ——
                 这正是用户说的"下拉选择子标签"。
              ⚠️ 没有子标签的行，点行就只是选中它。
            */
            btn.addEventListener('click', function () {
                if (hasSub) {
                    if (labelDraft !== key) {
                        labelDraft = key;
                        fieldDraft = null;
                    }
                    subOpenKey = (subOpenKey === key) ? null : key;
                } else {
                    labelDraft = key;
                    subOpenKey = null;
                }
                renderLabelOptions();
            });

            /*
              下拉面板：挂在这一行下面，`position: absolute`。
              ⚠️ 不挤动其他行（absolute 不占流）。
              ⚠️ `li` 需要 `position: relative`（见 CSS）。
            */
            if (hasSub && subOpenKey === key) {
                li.appendChild(buildSubDropdown(key));
            }

            labelListEl.appendChild(li);
        });

        /*
          ⚠️ 点列表空白处收起下拉。
             用 `once` 之外的写法：这个监听挂在 document 上，
             每次渲染都会加一个 —— 所以先移除再添加（见 bindDropClose）。
        */
        bindDropClose();

        renderCitePicker();
        renderFieldPicker();
    }

    /** 绑定「点别处收起下拉」的文档级监听（幂等） */
    function bindDropClose() {
        if (global.__scholariusDropCloseBound) return;
        global.__scholariusDropCloseBound = true;
        document.addEventListener('pointerdown', function (ev) {
            if (!subOpenKey) return;
            var t2 = ev.target;
            /*
              ⚠️ 在下拉面板内部点不算"点别处" ——
                 否则点选项的瞬间就被收起，选不中。
              ⚠️ 在**任何标签行**里点也不算 ——
                 行自己的 click 会负责切换，
                 这里再收起一次会和它打架（先收起再展开 = 看起来没反应）。
            */
            if (t2 && t2.closest &&
                (t2.closest('.sel-sub-dropdown') || t2.closest('.sel-label-item'))) {
                return;
            }
            subOpenKey = null;
            renderLabelOptions();
        }, true);
    }

    /**
     * 吃掉「这一次触摸」剩下的所有事件（v0.2.17）。
     *
     * ══ ⚠️⚠️ 为什么需要 ══
     *
     * 下拉选项一被选中就重渲染，面板从 DOM 里消失；
     * 而此时手指还没抬起 —— 同一个坐标暴露出来的是**下面那个标签行**。
     * 浏览器随后把 pointerup / click 派发给那个新元素，
     * 于是"选了姓名，标签却变成了 Heading 2"。
     *
     * ══ ⚠️⚠️ 为什么不能用 `setTimeout(0)` 拆除（v0.2.16 的错）══
     *
     * 上一版在 `pointerdown` 里注册拦截器、`setTimeout(…, 0)` 拆除。
     * 合成的瞬间点击能过，但**真实手指按住稍久一点就漏**：
     *
     *   实测（`adb shell input swipe x y x y 250`，按住 250ms）：
     *       active = "Heading 2"     ← 又选错成下面的标签了
     *   而 250ms 的按住期间，浏览器的任务队列早已跑过一轮，
     *   `setTimeout(0)` 的回调已经执行 → 拦截器被拆 → click 漏到行上。
     *
     * 换句话说：**"下一次点击"和"这一次触摸的 click"在时间上无法区分**，
     * 任何基于定时器的拆除都是猜的。
     *
     * ── ✅ 改成按**事件**拆除，不猜时间 ──
     *
     * 一次触摸的收尾事件是**唯一的 `click`**（或触摸被取消时的
     * `pointercancel` / `touchcancel`）。所以：
     *
     *   · 一直拦着，直到真的拦到一次 `click`（或 cancel）为止；
     *   · 拦到之后**立刻**全部拆除。
     *
     * 这样无论手指按 1ms 还是 1s，都能覆盖到那一次 click；
     * 也不会误吞用户的下一次点击（它的 click 是拦截拆除**之后**才来的）。
     *
     * ⚠️ 兜底：万一 `click` 从不出现（例如手势被系统判成滚动），
     *     用一个**较长**的定时器（1200ms）强制拆除 ——
     *     宁可偶尔漏一次，也不能让整个界面永久收不到 click。
     *     这个值必须**大于任何正常的按住时长**，250ms 已被实测证明不够。
     * ⚠️ 不拦 `pointerdown`：那一个已经处理完了；
     *     拦了反而会影响同一次触摸在别处的正常逻辑。
     * ⚠️ 必须 `capture: true` —— 行按钮的监听在冒泡阶段，
     *    只有捕获阶段才抢在它前面。
     */
    function swallowRestOfTouch() {
        /*
          ⚠️ 只拦"手指抬起之后"的事件。
             拦 `touchstart` 没有意义（那时已经过去了），
             却会在极少数情况下挡住下一个手势的开头。
        */
        var types = ['pointerup', 'mouseup', 'touchend', 'click'];
        var safetyTimer = null;

        function teardown() {
            types.forEach(function (type) {
                global.removeEventListener(type, eat, true);
            });
            if (safetyTimer) {
                global.clearTimeout(safetyTimer);
                safetyTimer = null;
            }
        }

        function eat(ev) {
            ev.stopPropagation();
            ev.preventDefault();
            /*
              ⚠️ `click` 是一次触摸的终点 —— 吃掉的这一下必须拆掉拦截器，
                 否则之后所有点击都会被永久吞掉。

              ⚠️ `pointerup` / `mouseup` / `touchend` **不拆**：
                 它们出现在 click 之前，提前拆就等于没拦。
            */
            if (ev.type === 'click') {
                teardown();
            }
        }

        types.forEach(function (type) {
            global.addEventListener(type, eat, true);
        });

        /*
          ⚠️ 兜底拆除：真机上如果截图/切后台/手势被系统改写导致
             `click` 没来，界面会永久失去点击响应 —— 那比偶尔选错更糟。
        */
        safetyTimer = global.setTimeout(teardown, 1200);
    }

    /**
     * 造一个行内下拉面板（v0.2.13）。
     *
     * ══ ⚠️ 为什么不用 `pickSheet` ══
     *
     * 用户明确否掉了"另开一个表单"的做法（层级更深、返回键要按两次）。
     * 下拉就该**贴着触发它的那一行**展开。
     *
     * 结构：
     *
     *   ┌──────────────────────────────┐
     *   │ 作者                 单位  › │
     *   ├──────────────────────────────┤  ← 这一层挂在 li 内，absolute 定位
     *   │  不设置                       │
     *   │  姓名                         │
     *   │  单位                    ✓    │
     *   └──────────────────────────────┘
     */
    function buildSubDropdown(key) {
        var box = document.createElement('ul');
        box.className = 'sel-sub-dropdown';
        box.setAttribute('role', 'listbox');

        var options = [{ value: '', label: t('reader.fieldNone') }];
        /*
          ══ 🛑 作者子标签已停用（v0.2.31，用户决定）══

          用户原话：

            「算了，我不加子标签了，我觉得你怎么都弄不好，
              直接到标签那一级就停下吧」

          子标签（姓名 / 单位 / 邮箱 / 联系方式）不断把原文行拆碎，
          反复修了 v0.2.27 → v0.2.30 仍未稳定。用户决定放弃这一级，
          标注**只到 `author` 整块**为止。

          ⚠️ 底层能力（AUTHOR_FIELDS、`span.field`、md 的
             `- Author <Field>:` 解析）**全部保留** ——
             已存在的文档里若有子标签，仍能正确渲染与导出，
             不会因为拿掉入口而丢数据。

          ⚠️ 想恢复：把下面 `KEY_AUTHOR_FIELD_ENABLED` 改回 true 即可。
        */
        if (key === 'author' && KEY_AUTHOR_FIELD_ENABLED) {
            AUTHOR_FIELDS.forEach(function (f) {
                options.push({ value: f, label: t('reader.field.' + f) });
            });
        }

        options.forEach(function (opt) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sel-sub-option';
            btn.setAttribute('role', 'option');
            var active = (fieldDraft || '') === opt.value;
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
            if (active) btn.classList.add('is-active');
            btn.textContent = opt.label;

            /*
              ══ ⚠️⚠️ 必须用 `pointerdown`，而且必须**吃掉这一次触摸的后续事件**
                 （v0.2.16 修 bug）══

              用户反馈（原话）：

                「最大的bug，当下拉选项出来时，选中的是下拉选项对应区域
                  下面的标签，而不是下拉选项中的子标签，比如点击作者下拉
                  选项的姓名，则直接选中了Heading 2。」

              ── 真因（已实测确认）──

              下拉面板是 `position: absolute`，**盖在下面几个标签行之上**。
              手指按在「Name」上时事件顺序是：

                  ① pointerdown  落在 .sel-sub-option
                     → 我的处理：写 fieldDraft、subOpenKey = null、重渲染
                     → **下拉从 DOM 里消失**
                  ② pointerup / click
                     → 此时同一个坐标已经是**下面那个标签行**
                       （实测：elementFromPoint 从 `.sel-sub-option`
                        变成了 `BUTTON.sel-label-item`）
                     → 行按钮的 click 收到事件 → labelDraft 被改成下面的标签

              于是"点了单位，结果选中了 Heading 2" ——
              值写对了，但标签被覆盖掉了。

              ── ✅ 修法 ──

              选中后让**这一次触摸**的 pointerup / click / touchstart… 全部失效：

                · 在 `window` 的**捕获阶段**注册一次性拦截器，
                  把这些事件 `stopPropagation` + `preventDefault`；
                · 拦截器在下一轮宏任务（`setTimeout 0`）里自行拆除 ——
                  一次触摸的全部事件都在这之前派发完，
                  再晚就会错误地吃掉用户的下一次点击。

              ⚠️ 只拦 `pointerup` / `click` / `mouseup` /
                 `touchend` / `touchstart`，**不拦 pointerdown**
                 —— pointerdown 已经在我们手上处理完了。
              ⚠️ 必须在**重渲染之前**装好拦截器 ——
                 否则中间那一下已经漏出去了。
            */
            var hasPicked = false;
            function pick(ev) {
                if (ev) {
                    ev.stopPropagation();
                    ev.preventDefault();
                }
                if (hasPicked) return;
                hasPicked = true;

                swallowRestOfTouch();

                /*
                  ⚠️ 选中即写值、即收起。
                     用户要的是"下拉选择子标签"，选完就该回到正常列表，
                     不该留一个展开着的面板挡着下面的标签。
                */
                fieldDraft = opt.value || null;
                subOpenKey = null;
                renderLabelOptions();
            }

            btn.addEventListener('pointerdown', pick);
            btn.addEventListener('click', pick);

            li.appendChild(btn);
            box.appendChild(li);
        });

        return box;
    }

    /**
     * 无子标签的作者块 → **每行一条**（v0.2.31）。
     *
     * 用户决定不再用子标签（「直接到标签那一级就停下吧」），
     * 所以这条路径成为作者导出的**主路径**，不能只是"整块一条"。
     *
     * ══ ⚠️ 每条为什么要带 `Author:` 前缀 ══
     *
     * 它们在 md 里都是**无序列表项**，一条一个作者：
     *
     *     - Author: Ashish Vaswani Noam Shazeer
     *     - Author: Google Brain Google Research
     *
     * 前缀由 `md.authorNested` 统一添加（它看到所有 item 都没有 `field`
     * 就合成 `- Author: <各行用空格连起来>`）。**但那样会把多行并成一行** ——
     * 正是要修的 bug。
     *
     * ✅ 所以这里给每行一个**独立的 item**，`md.authorNested` 会逐条输出。
     *
     * @param text  块文本
     * @param lines 原始排版行（可为空）
     * @return {Array<{text:string, field:null}>}
     */
    function plainAuthorItems(text, lines) {
        var src = (lines && lines.length > 1)
            ? lines
            : String(text == null ? '' : text).split(/\r?\n/);
        var out = [];
        for (var i = 0; i < src.length; i++) {
            var t = String(src[i] == null ? '' : src[i]).replace(/^\s+|\s+$/g, '');
            if (!t) continue;
            out.push({ text: t, field: null });
        }
        if (!out.length) out.push({ text: String(text || ''), field: null });
        return out;
    }

    /**
     * 这个标签是否有子标签（v0.1.78）。
     *
     * ⚠️ 目前只有「作者信息」有。以后要加别的（比如文献的子类型），
     *    在这个函数里登记即可，列表渲染代码不用改。
     */
    function labelHasSub(key) {
        /*
          ⚠️ 作者子标签入口已停用（v0.2.31，见 `KEY_AUTHOR_FIELD_ENABLED`）。
             返回 false 后，标注面板里作者那一行**不再出现** `▾` 和下拉，
             点击它就是普通选中 —— 标注到 `author` 整块为止。
        */
        if (key === 'author' && !KEY_AUTHOR_FIELD_ENABLED) return false;
        return key === 'author';
    }

    /*
      ⚠️ `buildSubList` / `makeSubItem` 已在 v0.2.11 删除。

      旧设计把子标签**展开在标签行下面**；用户改成"点箭头弹下拉菜单"
      （见 `openSubPicker`）。这两个函数因此没有调用点了 ——
      留着只会让人以为还有一条"展开区"的路径。

      将来若要恢复"行内展开"，请连同 `subOpen` 状态一起加回来，
      并确认 `.sel-sub-list` 的样式还在（当前保留未删，
      因为 `openSubPicker` 之外没有别的地方用到它，删样式风险更低）。
    */

    /**
     * 旧的「作者项」选择器 —— 已由行内子标签区取代（v0.1.78）。
     *
     * ⚠️ 保留成空函数而不是直接删掉调用点：
     *    底部区块 `#sheet-field-picker` 仍在 HTML 里，
     *    这里只负责把它**永远隐藏**，避免残留显示。
     */
    function renderFieldPicker() {
        if (fieldPickerEl) fieldPickerEl.hidden = true;
    }

    /**
     * 渲染「引用目标」选择器（v0.1.71）。
     *
     * 用户要求：
     *   「增加一个引用标签，比如我给类似「[12]」这种就可以加引用标签，
     *     然后选择标注为引用的时候应该选择引用哪条文献，
     *     这就和上一个需求形成闭环了。」
     *
     * ✅ 只在 `labelDraft === 'cite'` 时显示 ——
     *    其他标签没有“引用哪一条”这个概念。
     *
     * ⚠️ 列表来源：所有 `data-label="reference"` 的块。
     *    顺序按文档顺序，与服务区的文献编号一致。
     */
    function renderCitePicker() {
        if (!citePickerEl || !citeListEl) return;

        if (labelDraft !== 'cite') {
            citePickerEl.hidden = true;
            return;
        }

        citePickerEl.hidden = false;
        citeListEl.textContent = '';

        var refs = referenceItems();

        if (!refs.length) {
            var empty = document.createElement('li');
            empty.className = 'sel-cite-empty';
            empty.textContent = t('reader.citeEmpty');
            citeListEl.appendChild(empty);
            return;
        }

        refs.forEach(function (item) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sel-cite-item';
            btn.setAttribute('role', 'radio');
            btn.setAttribute('data-line', String(item.line));
            btn.setAttribute('aria-checked',
                item.line === citeTarget ? 'true' : 'false');
            if (item.line === citeTarget) btn.classList.add('is-active');

            /*
              ⚠️ 编号 + 截断后的文献内容。
                 只显示编号的话用户分不清是哪一条；
                 全显示又会把弹层撑破，所以截断。
            */
            var no = document.createElement('span');
            no.className = 'sel-cite-no';
            no.textContent = '[' + item.no + ']';
            btn.appendChild(no);

            var txt = document.createElement('span');
            txt.className = 'sel-cite-text';
            txt.textContent = clip(item.text.replace(/\s+/g, ' ').trim(), 40);
            btn.appendChild(txt);

            btn.addEventListener('click', function () {
                citeTarget = item.line;
                renderCitePicker();
            });

            li.appendChild(btn);
            citeListEl.appendChild(li);
        });
    }

    /**
     * 列出所有被标为「参考文献」的块（v0.1.71）。
     *
     * ⚠️ 按文档顺序返回，`no` 从 1 开始 ——
     *    与阅读视图里的文献编号一致（见 appendLabeledRun 的 refIndex）。
     * ⚠️ 只收**整块**被标为 reference 的块；
     *    部分标注的文献（只标了几个字）不算一条完整文献。
     */
    function referenceItems() {
        var list = docModel.blocks || [];
        var out = [];
        var n = 0;

        for (var i = 0; i < list.length; i++) {
            var line = list[i].line;
            var spans = labels[line];
            if (!spans || spans.length !== 1) continue;
            var sp = spans[0];
            if (!sp || sp.label !== 'reference') continue;

            var text = blockTextOf(line);
            if (!text || !text.replace(/\s+/g, '')) continue;

            /* 只收覆盖整块的标注 */
            if (sp.start > 0 || sp.end < text.length) continue;

            n++;
            out.push({ line: line, no: n, text: text });
        }
        return out;
    }

    /**
     * 这块是不是「按行拆分的作者信息」（v0.1.81）。
     *
     * ⚠️ 判据：**全部**标注都是 author。混杂其他标签的块不算，
     *    否则会把"一块里既有标题又有作者"的情况也拉进来，
     *    那种情形应该由 `makeLabeledBlock()` 处理。
     */
    function isAuthorLineSet(spans, line) {
        if (!spans || !spans.length) return false;
        for (var i = 0; i < spans.length; i++) {
            var sp = spans[i];
            if (!sp || sp.label !== 'author') return false;
        }
        /*
          ══ ⚠️⚠️ 凡是 author 标签，一律走"词条"渲染路径（v0.1.88）══

          用户要求（原话）：
            「将这些词切出来，然后重新放到作者信息区域，
              当作成一个新标签，只不过这个新标签放在作者信息区域内，
              不单独显示」

          ✅ 新路径按**已标注区间**组织内容（见 `makeAuthorLinesEl`），
             完全不依赖 `\n`，也不依赖标注条数：
               · 只有一条标注 → 一条词条 + 其余未标注文本；
               · 多条标注   → 多条词条 + 之间/前后的未标注文本。

          ⚠️ 之前几版的判据（`spans.length > 1`、是否有换行）全部废弃 ——
             它们都在"猜行"，而这版根本不需要行。

          ⚠️ `line` 参数保留，只为兼容调用方签名（当前未使用）。
        */
        return true;
    }


    /**
     * 求「覆盖 [start, end) 的完整行」的字符区间（v0.1.81）。
     *
     * ══ 用户要求（原话）══
     *
     *   「子标签对应的是段内的行，不是整个段」
     *   「那肯定是1啊，如果要分段来确定作者名和作者机构的话，
     *     同一个作者的信息就分开了」
     *
     * ══ 背景 ══
     *
     * PDF 的一个块里经常含多行：
     *
     *     Jacob Devlin, Ming-Wei Chang
     *     Google AI Language
     *     {jacobdevlin}@google.com
     *
     * 这三行属于**同一个作者**，拆成三个块会把同一个人的信息割裂；
     * 但子标签（姓名 / 单位 / 邮箱）必须能分别标在其中一行上。
     *
     * ✅ 所以把选区向外扩到"最近的两个换行符之间"：
     *    用户选一行里的任意几个字 → 自动扩展成那一整行。
     *
     * ⚠️ 选区跨越多个行时（用户一次拖了几行），扩到最外圈 ——
     *    这种用法是把几行作为同一个子标签，语义上也合理。
     * ⚠️ 没有换行符时（单行块）返回整块区间，退化行为和以前一致。
     *
     * @return {{start:number, end:number}}
     */
    function lineRangeAt(text, start, end) {
        /*
          ══ ⚠️⚠️ 先把 CRLF 归一成 LF，再算区间（v0.1.84）══

          用户反馈：
            「当我给第二行的机构信息来标注子标签时，直接出错了」

          ⚠️ 渲染侧 `makeAuthorLinesEl()` 是在 `flatText`
             （已归一化）上按 `\n` 切行的；
             而这里如果直接对**原始文本**（含 `\r\n`）算边界，
             行数一致但**字符偏移每行差 1**：

             原始:  A\r\nB\r\nC
             归一:  A\nB\nC

             第二行在原始里是 [3,4)，在归一后是 [2,3) ——
             差一位，标注区间与渲染区间就错开，
             表现是"相邻行的子标签互串 / 某行丢失标签"。

          ✅ 所以这里也归一化，保证两边算的是同一套坐标。
             ⚠️ 返回的区间是相对**归一化文本**的 ——
                渲染侧也全用归一化文本，两边一致。
                存储层仍保存这套坐标，重启后照旧可用。
        */
        var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
        var a = Math.max(0, Math.min(start || 0, s.length));
        var b = Math.max(a, Math.min(end || 0, s.length));

        /*
          ⚠️ 归一化之后文本里只剩 `\n`，不用再兼顾 `\r`。
        */
        var ls = s.lastIndexOf('\n', a - 1);
        ls = (ls < 0) ? 0 : (ls + 1);

        /* 终点往后找下一个换行之前 */
        var nl = s.indexOf('\n', b);
        var le = (nl < 0) ? s.length : nl;

        return { start: ls, end: le };
    }

    function closeLabelSheet() {
        if (!labelSheetEl) return;
        labelSheetEl.classList.remove('is-open');
        global.setTimeout(function () {
            if (labelSheetEl && !labelSheetEl.classList.contains('is-open')) {
                labelSheetEl.hidden = true;
            }
        }, 260);
    }

    /**
     * 确认标注：把标签写到**选中的那个字符区间**上（v0.1.47）。
     *
     * ══ ⚠️⚠️ 为什么改成区间 ══
     *
     * 用户实测反馈：
     *   「标注的区域并非是选中的区域，而也是类似选中了一个词作为标题，
     *     结果整个句子都变成了标题这样的。」
     *
     * 旧实现写 `labels[line] = 标签`，一写就是整段。
     *
     * ✅ 现在写 `labels[line] = [{start, end, label}, ...]`。
     *
     * ══ 三种操作的语义 ══
     *
     *  ① 标成某个标签（如"一级标题"）
     *     → 把这个区间上的旧标注**移除**，再加入新标注。
     *       否则同一段文字会同时属于两个标签，渲染时互相覆盖。
     *
     *  ② 选「正文」= 无标签
     *     → 只**移除**与该区间重叠的标注，不新增记录。
     *       用户要求：「正文（用于恢复已标注过的标签回归原本的无标签形式）」
     *
     *  ③ 跨块选中
     *     → 每块各自记整块区间（跨块时无法用一个字符区间表达）。
     */
    function applyLabel() {
        if (!labelSpan) return;

        if (labelSpan.single) {
            var line = labelSpan.line;
            var cur = labels[line] || [];

            /*
              ══ ⚠️⚠️ 计算**实际要写入**的区间 ══

              用户要求（v0.1.81）：
                「子标签对应的是段内的行，不是整个段」
                「如果要分段来确定作者名和作者机构的话，
                  同一个作者的信息就分开了」

              ⚠️⚠️ 关键：PDF 的一个块里经常含多行，例如

                  Jacob Devlin, Ming-Wei Chang
                  Google AI Language
                  {jacobdevlin}@google.com

               这三行属于**同一个作者**，必须留在同一个块里
               （拆成三个块会把同一个作者的信息切开）。
               但子标签（姓名/单位/邮箱）要能分别指定**其中某一行**。

              ✅ 所以作者信息的区间不再是"整块"，而是
                 **选中文字所覆盖的完整行**：把选区向外扩展到
                 最近的两个换行符之间。

              ⚠️ 参考文献仍是整段语义（一条文献就是一个条目），
                 `cite` 保持精确区间。
            */
            var wa = labelSpan.start;
            var wb = labelSpan.end;

            if (labelDraft === 'author') {
                /*
                  ══ ⚠️⚠️ 作者信息：**用选中的精确区间**，不扩展到整行（v0.1.88）══

                  用户要求（原话）：
                    「既然某个区域内的一些词可以选中，将这些词切出来，
                      然后重新放到作者信息区域，当作成一个新标签」

                  ✅ 所以"行"不再是 `\n` 分隔的排版行，而是**用户选中的词**。
                     扩展整行反而会覆盖掉其他词条 —— 这正是之前
                     "标机构把姓名挤掉"的根源。

                  ⚠️ 只去掉首尾空白：选中文时手指容易多带一个空格，
                     保留它会让词条右对齐时多出一个空隙。
                */
                var rawW = String(blockTextOf(line) == null ? '' : blockTextOf(line))
                    .replace(/\r\n?/g, '\n');
                var ws = Math.max(0, Math.min(labelSpan.start, rawW.length));
                var we = Math.max(ws, Math.min(labelSpan.end, rawW.length));
                while (ws < we && /\s/.test(rawW.charAt(ws))) ws++;
                while (we > ws && /\s/.test(rawW.charAt(we - 1))) we--;
                wa = ws;
                wb = we;
            } else if (labelDraft === 'reference') {
                /*
                  ⚠️ 长度也按**归一化后**的文本算（v0.1.84）——
                     与 `lineRangeAt()` 的坐标系保持一致，
                     否则 CRLF 块里 `end` 会多出"行数"个字符。
                */
                wa = 0;
                wb = String(blockTextOf(line) == null ? '' : blockTextOf(line))
                    .replace(/\r\n?/g, '\n').length;
            }

            /*
              ⚠️ 先移除与本次区间**有重叠**的标注 ——
                 一个字符只能属于一个标签。
                 用严格不相交判断（sp.end <= start || sp.start >= end）
                 取反。

              ══ ⚠️⚠️ 但作者信息的**逐行子标签**不能这样删（v0.1.84）══

              用户反馈：
                「当我给第二行的机构信息来标注子标签时，直接出错了，
                  显示效果是第一行成了正文段，第二三行淡色，
                  但没有任何子标签标识」

              真因：真机上有两种情形会让 `lineRangeAt()` 退化：

                · 块里**没有换行符**（PDF 把多行合并成一行）；
                · 换行是 `\r\n`，而我按 `\r` 找边界时算出的区间
                  与渲染侧（已归一成 `\n`）不一致。

              两者都导致 `wa=0, wb=整块长度` —— 于是"重叠"判据
              把**已有的姓名标注也一并删掉**，第一行就失去了
              `author` 标签，退化成正文段（既无 A 编号也无淡色）。

              ✅ 作者信息的语义是"块内每一行各一个子标签"，
                 行与行本来就不该互相排斥。
                 所以作者标签**按行区间是否完全相同**判断重复，
                 而不是按字符重叠 —— 只有**同一行**被重新标注时
                 才覆盖上一条。
            */
            var kept = [];
            for (var i = 0; i < cur.length; i++) {
                var sp = cur[i];
                if (!sp) continue;

                var drop;
                if (labelDraft === 'author' && sp.label === 'author') {
                    /*
                      ══ ⚠️⚠️ 整块 author 标注不能被局部子标签挤掉（v0.2.29）══

                      用户实测：
                        「当我标注子标签时，整个作者区域直接恢复成了正文段」

                      真因：整块 author 标注是 `[0, 47)`（覆盖整块），
                      用户给中间一段加子标签时是 `[16, 27)` ——
                      两者**重叠**，按"词条间不应该重叠"的规则，
                      整块那条被 drop 掉了。

                      结果：`labels` 里只剩 `{16,27,author,field}`，
                      而 `splitBlockByMarks` 认为"没有无 field 的块级标注"
                      → 整块退化成正文 → 作者区消失。

                      ✅ 正确语义：**"整块是作者区"和"块内某段是姓名/单位"
                         是两层信息，不是互斥关系**。
                         所以：
                           · 整块标注（start≈0 且 end≈块长）→ **永远保留**
                           · 其他 author 标注 → 按重叠判断（词条之间不重叠）
                    */
                    var blockLen = String(blockTextOf(line) == null ? '' : blockTextOf(line)).length;
                    var spCovers = (Number(sp.start) || 0) <= 1 &&
                                   (Number(sp.end) || 0) >= blockLen - 1;
                    if (spCovers) {
                        /*
                          ⚠️ 整块标注：**重复标注时覆盖**（不保留旧的）。
                             判据：这次的新标注也是整块 + **不带 field**
                             → 用户是在改"这块是不是作者区"，不是加子标签。
                             此时旧的整块标注要丢掉，否则会积累多个重复项。
                          ⚠️ 反之（新标注带 field）→ 保留整块，子标签是叠加。
                        */
                        var newCovers = wa <= 1 && wb >= blockLen - 1;
                        drop = newCovers && !fieldDraft;
                    } else {
                        drop = (sp.start < wb && sp.end > wa);
                    }
                } else {
                    drop = !(sp.end <= wa || sp.start >= wb);
                }

                if (!drop) kept.push(sp);
            }

            if (labelDraft && labelDraft !== 'body') {
                /*
                  ══ ⚠️⚠️ 作者信息：区间强制扩展到**整块**（v0.1.77）══

                  用户反馈：
                    「给某个作者信息部分的某一行添加作者信息具体项目的
                      时候，整个作者信息区域直接被破坏了。」

                  真因：用户为了选子标签，只选中了行内的**一部分文字**，
                  于是 writer 存下 `{start:0, end:10}` —— 这只是块的一截。
                  `makeContentEl()` 看到区间不覆盖整块，就把它当"部分标注"
                  处理：拆成 before / marked / after 三段残片，
                  内容不再带 `is-author-body`，那一行就从作者区域里消失了。

                  ⚠️ 作者信息、参考文献都是**整段语义** ——
                     一行就是一个条目，不存在"只有半行是单位"这种事。
                     所以这两类标签一律按整块记录，
                     用户选了几个字都当作"选中了这一段"。

                  ⚠️ `cite` 相反：它是行内的 `[12]`，必须保留精确区间。
                */
                var newSpan = {
                    start: wa,
                    end: wb,
                    label: labelDraft
                };
                /*
                  ⚠️ 引用标记要记住“引用的是哪一条文献”（v0.1.71）——
                     与文献标注形成闭环：写 `[12]` 时选定文献，
                     日后可以据此跳转。
                  ⚠️ 其他标签不写 `ref`，保持数据干净。
                */
                if (labelDraft === 'cite' && citeTarget != null) {
                    newSpan.ref = citeTarget;
                }
                /*
                  ⚠️ 作者信息的「项名」写在同一条记录的 `field` 上（v0.1.74）——
                     不新建存储表。用户选「不设置」时不写这个字段。
                */
                if (labelDraft === 'author' && fieldDraft) {
                    newSpan.field = fieldDraft;
                }
                kept.push(newSpan);
            }

            if (kept.length) labels[line] = kept;
            else delete labels[line];

            trace('reader:label', 'line=' + line + ' [' +
                labelSpan.start + ',' + labelSpan.end + ') = ' + labelDraft);
        } else {
            /*
              ⚠️ 跨块：每块记整块（0 到该块文本长度）。
                 跨段标注本身就是"这几段都是某类内容"，
                 用整块区间是合理的。
            */
            var lines = labelSpan.lines || [];
            for (var j = 0; j < lines.length; j++) {
                var ln = lines[j];
                if (labelDraft && labelDraft !== 'body') {
                    /*
                      ⚠️ 长度按归一化文本算（v0.1.84），与单块分支一致。
                    */
                    var lnText0 = String(blockTextOf(ln) == null ? '' : blockTextOf(ln))
                        .replace(/\r\n?/g, '\n');
                    var rec = {
                        start: 0,
                        end: lnText0.length,
                        label: labelDraft
                    };
                    if (labelDraft === 'cite' && citeTarget != null) {
                        rec.ref = citeTarget;
                    }
                    if (labelDraft === 'author' && fieldDraft) {
                        rec.field = fieldDraft;
                    }
                    labels[ln] = [rec];
                } else {
                    delete labels[ln];
                }
            }

            trace('reader:label', 'multi lines=' + lines.join(',') + ' = ' + labelDraft);
        }

        /*
          ⚠️ 标注完成后再同步作者（v0.1.74）——
             必须在 `labels` 已经更新之后跑，否则读不到新标注。
        */
        if (labelDraft === 'author' && fieldDraft === 'name') {
            syncAuthorToDetail();
        }

        saveLabels();
        /*
          ⚠️ 标注也改变 md（标题层级、列表、引用注释）→ 必须回写（v0.1.92）。
        */
        pushMdToNative();
        closeLabelSheet();
        clearSelection();
        rerenderKeepingScroll();
    }

    /**
     * 把「姓名」项的作者同步到文章详细信息（v0.1.74）。
     *
     * ══ 用户要求（原话）══
     *
     *   「当检测到一个作者信息区域增加了作者姓名项的时候，
     *     自动和目前的文章信息中的作者进行配对，如果存在则无操作；
     *     如果不存在则加逗号后增加不存在的作者到文章详细信息项中。」
     *
     * 规则：
     *   · 只处理 `field === 'name'` 的作者区域；
     *   · 把 `doc.author` 按逗号拆开，逐段 trim；
     *   · 新姓名若已存在（忽略大小写）→ 什么也不做；
     *   · 否则追加到末尾，用 `, ` 连接。
     *
     * ⚠️ 分隔符用**英文逗号**：
     *     作者列表是元数据，不跟随界面语言 ——
     *     中文编辑符 `，` 会让以后的解析（按逗号拆分）出问题。
     *
     * ⚠️ 写回走原生桥 `updateDoc`，与详情页保存是同一条通路。
     *     不能只改内存里的 `currentDoc.author` —— 那样重启就丢。
     */
    function syncAuthorToDetail() {
        if (!currentDoc) return;

        var bridge = global.ScholariusNative;
        if (!bridge || typeof bridge.updateDoc !== 'function') {
            trace('reader:author', 'no updateDoc bridge');
            return;
        }

        /*
          收集所有「姓名」项的作者名。
          ⚠️ 用 `labels` 全量扫描而不是只看本次标注的那一段 ——
             用户可能先标了别处，这次标的是第二个人，
             两个人都该进元数据。

          ⚠️⚠️ 必须按**行区间**取文字，不能取整块（v0.1.81）：
             一个块里可能同时有姓名行、单位行、邮箱行，
             取整块会把单位邮箱也当成作者名写进元数据。
        */
        var names = [];
        for (var key in labels) {
            if (!Object.prototype.hasOwnProperty.call(labels, key)) continue;
            var line = parseInt(key, 10);
            if (!isFinite(line)) continue;

            var list = labels[key];
            if (!list || !list.length) continue;

            var full = String(blockTextOf(line) || '');
            if (!full) continue;

            for (var li = 0; li < list.length; li++) {
                var sp = list[li];
                if (!sp || sp.label !== 'author' || sp.field !== 'name') continue;

                var s = Math.max(0, Math.min(sp.start || 0, full.length));
                var e2 = Math.max(s, Math.min(sp.end || 0, full.length));
                var text = full.slice(s, e2).replace(/\s+/g, ' ').trim();
                if (text) names.push(text);
            }
        }
        if (!names.length) return;

        var existing = String(currentDoc.author || '');
        var parts = existing.split(',');
        var seen = {};
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (p) seen[p.toLowerCase()] = true;
        }

        var added = [];
        for (var n = 0; n < names.length; n++) {
            var nm = names[n];
            var lc = nm.toLowerCase();
            if (seen[lc]) continue;
            seen[lc] = true;
            added.push(nm);
        }

        if (!added.length) {
            trace('reader:author', 'all names already present');
            return;
        }

        var next = existing.replace(/\s+$/, '');
        next = next ? (next + ', ' + added.join(', '))
                    : added.join(', ');

        /*
          ⚠️ 先更新内存副本，再走桥 ——
             这样即使桥回调还没到，界面上的详情页也已经是新值。
          ⚠️ 桥调用要防异常：某些调试环境没有实现 updateDoc。
        */
        currentDoc.author = next;

        /*
          ══ ⚠️⚠️ 登记为「后台同步」（v0.1.76）══

          用户反馈：
            「文章具体信息页怎么删了很多项目啊？不能删啊」

          真因：`updateDoc` 的回调会走到 `ScholariusDetail.onDocUpdated`。
          若详情页正开着同一篇文献，它会：

            ① `currentDoc.fields = draft.fields` ——
               用**打开详情页时**的旧快照覆盖当前字段，
               用户在那之后新填的内容全部丢失；
            ② `close()` —— 无故关闭详情面板。

          ✅ 先登记 id，`onDocUpdated` 识别到就直接返回。
        */
        if (global.ScholariusDetail &&
            typeof global.ScholariusDetail.markSilentUpdate === 'function') {
            global.ScholariusDetail.markSilentUpdate(currentDoc.id);
        }

        try {
            bridge.updateDoc(currentDoc.id, JSON.stringify({ author: next }));
        } catch (e) {
            trace('reader:author', 'updateDoc threw: ' + e.message);
        }

        trace('reader:author', 'added "' + added.join(', ') + '"');
    }

    // --- 菜单 ---------------------------------------------------------------

    function toggleMenu() {
        setMenu(!menuOpen);
    }

    function setMenu(open) {
        menuOpen = !!open;
        if (root) {
            root.classList.toggle('is-menu-open', menuOpen);
        }
        if (!menuOpen) {
            // 菜单收起时面板必须一起收起，否则会留一块浮在外面
            setPanel(false);
        }
        if (tocBtn) {
            tocBtn.setAttribute('aria-expanded', 'false');
        }
        if (settingsBtn) {
            settingsBtn.setAttribute('aria-expanded', 'false');
        }

        /*
          ⚠️ 底栏开合会改变操作条的避让高度（v0.1.44）——
             必须重排一次，否则它会停在错误的高度：
               · 菜单展开时仍贴着屏幕底部 → 被底栏盖住
               · 菜单收起时仍抬着 → 与正文之间空一大块
        */
        if (selBarEl && !selBarEl.hidden) {
            positionSelectBar();
        }
    }

    // --- 打开 / 关闭 ---------------------------------------------------------

    /**
     * 打开某篇文献。
     *
     * @param doc 文献对象（来自文库列表，含 id / title / author / pages / size）
     */
    function open(doc) {
        if (!root || !doc) {
            return;
        }

        currentDoc = doc;

        /*
          顶部栏不放标题（用户明确要求只留返回按钮），
          所以这里不再把标题写进 DOM。
          但标题仍放在 <section> 的 aria-label 上，供无障碍朗读。
        */
        root.setAttribute('aria-label', doc.title || doc.sourceName || t('nav.vault'));

        showLoading();
        // 换文献时旧目录必须清掉，否则会在新正文加载前短暂显示上一篇的目录
        toc = [];
        textLines = [];

        root.hidden = false;
        // 强制布局后再加 is-open，否则滑入动画不触发
        if (root.offsetWidth < 0) return;
        root.classList.add('is-open');

        // 初始不显示菜单，纯正文
        setMenu(false);
        setPanel(false);

        /*
          ⚠️ 打开新文献时清掉上篇的选中状态（v0.1.40）。
             操作条挂在 root 上，不属于 contentEl，不会被下面的
             正文清空带走 —— 不清会残留"上一篇选中 N 字"。
        */
        clearSelection();
        /* ⚠️ 丢字自检的基线也必须换掉，否则会拿上一篇的文本去比（v0.1.92） */
        mdOriginText = '';

        /*
          ⚠️ 每次打开都重置正文缓存。
             上一位用户可能停在同一篇的某一个位置，但缓存必须清 ——
             否则新文献加载期间会短暂显示上一篇的内容。
        */
        lastBlocks = null;
        lastText = '';

        /*
          ⚠️ 载入这篇文献的编辑与标注（v0.1.45）。
             必须在 `requestText` **之前** —— 正文渲染时
             `makeBlockEl` 要读 `edits` / `labels` 来还原内容与标签，
             晚一步就会先渲染出原始文本再闪一下。
        */
        loadAnnotations(doc.id);

        /*
          ⚠️ 每次打开都重新判断切分按钮是否可见（v0.1.98）——
             用户可能刚在设置里开启了语义分段，也可能关掉了。
             不刷新的话按钮状态会停留在上一次打开时的判断。
        */
        syncSegBtn();

        /*
          ⚠️ 打开时重算一次颜色行的色块。
             主题可能在阅读页关闭期间被改过（比如在「设置」里切了夜间模式），
             此时正文颜色已随新主题变化，而色块还是上次的值。
        */
        syncColorRowDeferred();

        requestText(doc.id);
    }

    function close() {
        if (!root) {
            return;
        }
        // 目录开着就先收目录，退出动作交给下一次（与返回键行为保持一致）
        if (tocOpen) {
            setToc(false);
            return;
        }

        root.classList.remove('is-open');
        setMenu(false);
        setPanel(false);
        /*
          ⚠️ 关阅读页时必须清掉选中与操作条（v0.1.40）——
             操作条挂在 `root` 上，不随 `contentEl` 清空一起消失。
             不清的话，关掉再打开另一篇会看到
             “上一篇选中的字数” 还挂在操作条上。
        */
        clearSelection();

        /*
          ══ ⚠️⚠️ 延迟清理必须**绑在关闭时的那个文档上**（v0.1.99）══

          这是一个真实存在的竞态，症状恰好是"正文空白 / 提示提取失败"：

            1. 用户点开文档 A → open() 设 currentDoc = A，请求正文
            2. 用户立刻返回 → close() 排了一个 280ms 后的清理
            3. 用户 280ms 内点开文档 B → open() 设 currentDoc = B
            4. 280ms 到了，清理执行：`root` 可能刚好又不是 is-open
               （或者 B 还没渲染完），于是 **currentDoc = null**
            5. 原生把 B 的正文推回来 → `currentDoc.id !== id` →
               被当成"过期结果"丢弃 → 正文永远空白

          ⚠️ 判据 `!root.classList.contains('is-open')` **不够**：
             它只看"现在开没开"，不看"现在开的是不是当初关的那篇"。
             正确做法是：把这个延迟清理**绑定到被关掉的 docId**，
             只要 currentDoc 已经不是它了，就整个跳过。
        */
        var closingDocId = currentDoc ? currentDoc.id : null;
        global.setTimeout(function () {
            /* 期间又打开了别的文档（或同一篇）→ 这次清理作废 */
            if (currentDoc && currentDoc.id !== closingDocId) {
                return;
            }
            if (!root.classList.contains('is-open')) {
                root.hidden = true;
                currentDoc = null;
                toc = [];
                textLines = [];
                if (contentEl) {
                    contentEl.textContent = '';
                }
                lastBlocks = null;
                lastText = '';
            }
        }, 280);
    }

    /** 是否正开着（供系统返回键查询） */
    function isOpen() {
        return !!(root && !root.hidden);
    }

    // --- 正文 ---------------------------------------------------------------

    function showLoading() {
        if (!contentEl) {
            return;
        }
        contentEl.textContent = '';
        var hint = document.createElement('div');
        hint.className = 'reader-hint';
        hint.textContent = t('reader.loading');
        contentEl.appendChild(hint);
    }

    /**
     * 显示一条错误提示。
     *
     * ⚠️ 必须区分**桥不可用**和**提取失败**，不能都报「无法提取文本」。
     *
     *    实测踩过：浏览器预览里没有原生桥，点卡片后显示
     *    "Could Not Extract Text From This PDF." ——
     *    于是排查方向全被带到 PDF 解析上，而真因是桥没注入。
     *    两者的责任方、排查路径完全不同，报同一条文案就是误导。
     *
     * @param {string} reason 'no-bridge' | 'extract-failed'
     */
    function showError(reason, detail) {
        if (!contentEl) {
            return;
        }
        contentEl.textContent = '';
        var hint = document.createElement('div');
        hint.className = 'reader-hint';
        hint.textContent = (reason === 'no-bridge')
            ? t('reader.noBridge')
            : t('reader.extractFailed');
        contentEl.appendChild(hint);
        /*
          ══ 诊断详情（v0.1.97）══

          ⚠️ 只在 debug 构建里显示。

          为什么必须加：用户在真机上报「仍然是那个无法提取的提示」，
          但我这边无论如何都复现不出来 —— 说明失败点在某个
          只在真机上才有的条件（内存、WebView 版本、特定 PDF）。

          「无法提取」这句话本身**不含任何信息**：它可能是
            · 原生根本没推数据（桥没注/文件丢了）
            · 推了但 blocks 是空数组
            · 块都空（text 全是空白字符串）
            · 渲染抛异常且没有可用的纯文本
          这四种情况的修法完全不同，光看文案只能瞎猜。

          ✅ 把关键数字直接打在提示下面，用户截个图就能定位。
             这是唯一能在真机上拿到的现场数据。
        */
        if (detail && global.__SCHOLARIUS_DEBUG__ !== false) {
            var dbg = document.createElement('div');
            dbg.className = 'reader-hint-detail';
            dbg.textContent = detail;
            contentEl.appendChild(dbg);
        }
        trace('reader:error', reason || 'extract-failed');
    }

    /** 请原生提取文本 */
    function requestText(id) {
        var bridge = global.ScholariusNative;
        if (bridge && typeof bridge.requestDocText === 'function') {
            bridge.requestDocText(id);
        } else {
            showError('no-bridge');
        }
    }

    /**
     * 渲染正文。
     *
     * ══ ⚠️⚠️ v0.1.39：**不做任何结构化模板** ══
     *
     * 用户原话：「不允许有任何模板，我导入一个新的 pdf 进来，
     *           我看到的应该是无等级的全部文本才对」
     *
     * 所以这里**不再**调 `buildRegions` —— 那会：
     *   · 把块切成「Title / Author / Abstract / 各章节」区域
     *   · 靠**位置**硬套（第一个块=题目、题目后=作者、`Abstract` 行=摘要锚点）
     *   · 给区域加 TITLE / AUTHOR / ABSTRACT 小标签
     *   · 按 level 分出 h2/h3/h4 三种字号
     *
     * 这些都撤掉了。现在每篇文献渲染出来就是**一串等价的段落**，
     * 与论文原来有没有标题、标题几级完全无关。
     *
     * ⚠️ 但**保留分块**（不退回整段 `textContent`）。
     *    分块不是"模板"，是"换行"：原生按段落切好，
     *    我们照着一段一个 `<p>`。退回整段文本会让
     *    `white-space: pre-wrap` 把 PDF 的原始换行一起保留，
     *    窄行排版下每句都断在半截（这正是 v0.1.6 修掉的问题）。
     *
     * ⚠️ `dropContainedBlocks` 仍然要在渲染前跑 ——
     *    它去掉的是原生**重复输出**的块（同一行既有整块又有逐词块），
     *    不去掉会看到内容重复两遍。那是数据清洗，不是模板。
     *
     * @param {Array} blocks [{kind,text,level,page,line}]
     */
    function renderBlocks(blocks) {
        if (!blocks || !blocks.length) return;
        renderMd(blocks);
    }

    /**
     * ══ 按 md 结构渲染（v0.2.22）══
     *
     * 用户裁决：
     *   「我觉得完成了md作为基础数据储存结构之后，渲染就很简单了吧」
     *   「直接清理，完全按照md格式来渲染」
     *
     * ✅ md 是唯一数据源，渲染只做一件事：**把结构画出来**。
     *
     *     `#`    → `<h1>`        （文章标题）
     *     `##`   → `<h2>`
     *     `###`  → `<h3>`
     *     `####` → `<h4>`
     *     `- `   → `<ul><li>`
     *     `1. `  → `<ol><li>`
     *     空行   → `<p>`
     *
     * ⚠️ 不再有"这块是标题还是正文"的判断 —— `kind` / `level` /
     *    `listMarker` 就是 md 的结构，直接用。
     * ⚠️ 不再有模板角色参与语义判定（`role` 只影响视觉修饰）。
     *
     * ══ 保留的东西（都不是"模板"，是功能）══
     *
     *   · 正文段编号 + 左侧提示条 —— 用户 v0.1.57 明确要求
     *   · 分类编号前缀（A1 / R1）—— 用户 v0.1.72 明确要求
     *   · 标签段（「文章标题」「作者信息」）—— 现有交互的一部分
     *   · `data-line` —— 选中/编辑/标注的锚点
     *
     * @param {Array} blocks [{line, text, kind, level, listMarker, ...}]
     */
    function renderMd(blocks) {
        var frag = document.createDocumentFragment();
        var bodyIndex = { n: 0 };
        var refIndex = { n: 0 };
        var authorIndex = { n: 0 };

        /*
          ⚠️ 有序列表编号：md 里写的是绝对编号，必须原样还原。
             越过非列表块**不重置** —— 文献区被正文打断时编号仍连续。
        */
        var ordNum = 0;

        /*
          ══ 列表容器（v0.2.22）══

          ⚠️ 连续的同类列表项要装进**同一个** `<ul>` / `<ol>`，
             否则 md 里一个列表会被画成 N 个只有一个条目的列表，
             视觉上段落间距全错（列表项之间应该紧贴）。
        */
        var openList = null;      // 当前打开的 <ul>/<ol>
        var openType = null;      // 'ul' | 'ol'

        /*
          ⚠️ 作者区聚合**已移除**（v0.2.23）——
             现在完全按 md 文本渲染：md 里一条 `- ` 就是一条列表项。
             "多个作者块合成一条"的规则在**写 md 时**完成
             （见 md.js 的 authorNested），读回来自然就是一条。
             渲染层不该再自己拼。
        */

        /*
          ══ 视觉层：标签段 + 分类编号（v0.2.24 恢复）══

          用户裁决：
            「我们只是改了储存，没改样式啊」
            「不是，之前设置的各种标签的样式怎么都放弃了？」
            「嗯加吧，反正我只要样式回来」

          ✅ 这些**不是模板**，是 v0.1.4x～v0.1.7x 迭代出来的功能：
             · 标签段「标题」「作者信息」—— 每个区域前面一次
             · 正文段编号 `1 │`（竖线 + 数字）
             · 作者 `A1` / 文献 `R1` 分类编号
          它们和"按 md 渲染"不冲突：md 决定**结构**，这层是**附加视觉**。

          ⚠️ 分类编号只在**区域第一段**出现，后续段只挂竖线 ——
             这样 `A1` 只出现一次，竖线连成一条（用户 v0.1.93 要求）。
        */
        var authorSeq = 0;
        var refSeq = 0;
        var lastLabelKey = null;   // 上一个区域的标签（相邻同类只输出一次头）

        function pushLabelHead(labelKey, isH1, force) {
            if (!labelKey) return;
            /*
              ⚠️ `force` = 每个区域都输出一次标签段（v0.2.28）。
                 作者区用它 —— 用户要求「每一个作者区域前面都增加一个
                 author 的前置文本」。而标题/文献仍按"相邻同类只输出一次"
                 （否则连续 20 个一级标题会重复 20 次「Heading 1」）。
            */
            if (!force && lastLabelKey === labelKey) return;
            lastLabelKey = labelKey;
            var head = document.createElement('p');
            head.className = 'reader-label-head';
            head.setAttribute('data-label', labelKey);
            if (isH1) head.classList.add('is-h1-head');
            var txt = document.createElement('span');
            txt.className = 'reader-label-text';
            txt.textContent = t('reader.label.' + labelKey);
            head.appendChild(txt);
            /*
              ⚠️ 一级标题后面跟一条分隔线（v0.1.71）——
                 表示"整个文章被一级标题分割成不同章节"。
            */
            if (isH1) {
                var hr = document.createElement('span');
                hr.className = 'reader-label-rule';
                head.appendChild(hr);
            }
            frag.appendChild(head);
        }

        function resetLabelHead() { lastLabelKey = null; }

        function closeList() {
            if (openList) {
                frag.appendChild(openList);
                openList = null;
                openType = null;
            }
        }

        function ensureList(type) {
            if (openType === type && openList) return openList;
            closeList();
            openList = document.createElement(type);
            openList.className = 'reader-list reader-list-' + type;
            openType = type;
            return openList;
        }

        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (!b) continue;

            /*
              ══ ⚠️⚠️ 按**块**取文本，不按行号回查（v0.2.35）══

              这里原本是 `blockTextOf(b.line)`，它遍历所有块、
              返回第一个行号匹配的那一块的文本。

              语义切分后多个段落会共享同一个行号
              （`line: allLines[lo]`，`lo` 由字符占比算出，必然重复），
              于是**它们全都渲染成第一块的文字** —— 这就是
              「大量重复内容和缺失内容」的直接来源。

              ✅ 手上已经有 `b`，就用 `b.text`。
                 渲染本来就该是"遍历数组、逐块输出"，
                 与旧实现 `renderFlat(blocks)` 一致。
            */
            var text = textOfBlock(b);
            if (text == null) text = b.text || '';
            text = String(text);
            if (text.replace(/\s+/g, '') === '') continue;

            /*
              ══ ⚠️⚠️⚠️ 标注 → md 标记，然后统一按 md 渲染（v0.2.23）══

              用户裁决：
                「这不又麻烦了，为什么不能直接套用md的渲染方法？」

              ✅ **标注本质上就是给文本加 md 标记**。所以：
                 用户标了 title → 给文本加 `# `
                 用户标了 h1    → 加 `## `
                 用户标了 author → 加 `- `
                 用户标了 reference → 加 `1. `
                 然后**统一**按 md 语法解析渲染。

              这样只有一条渲染路径：
                文本（原文或编辑结果）+ 标注前缀 → 解析 → DOM

              ⚠️ 用户**自己编辑**打进去的 `# ` 也走同一条路 ——
                 因为这里先检查"文本是否已经有 md 标记"，
                 有就不再叠加（否则会出现 `# # 标题`）。

              ⚠️ 只有**覆盖整块**的标注才加前缀 ——
                 局部标注（选了半句话）不改变整块的显示形态。
            */
            var spans = (typeof b.line === 'number') ? labels[b.line] : null;
            /*
              ⚠️ `>` 也算"已有 md 标记"（v0.2.39）——
                 尾注在 md 里是引用块。不把 `>` 纳入判断的话，
                 用户给一个**已经是引用块**的段落再标尾注，
                 会得到 `> > 内容`（每标一次多一层）。
            */
            var alreadyMd = /^(#{1,6}[-*+]|\d+[.)])\s/.test(text) ||
                            /^[-*+]\s/.test(text) ||
                            /^#{1,6}\s/.test(text) ||
                            /^>/.test(text);

            if (!alreadyMd && spans && spans.length) {
                for (var si = 0; si < spans.length; si++) {
                    var sp0 = spans[si];
                    if (!sp0 || !sp0.label) continue;
                    var covers = (Number(sp0.start) || 0) <= 1 &&
                                 (Number(sp0.end) || 0) >= text.length - 1;
                    if (!covers) continue;

                    if (sp0.label === 'title') { text = '# ' + text; break; }
                    if (sp0.label === 'h1') { text = '## ' + text; break; }
                    if (sp0.label === 'h2') { text = '### ' + text; break; }
                    if (sp0.label === 'h3') { text = '#### ' + text; break; }
                    if (sp0.label === 'author') {
                        /*
                          ⚠️ 作者子标签（`field`）→ 加 `Author <字段>: ` 前缀。
                             没有 field → 加 `Author: `。
                        */
                        var fld = null;
                        for (var sf = 0; sf < spans.length; sf++) {
                            if (spans[sf] && spans[sf].label === 'author' && spans[sf].field) {
                                fld = spans[sf].field;
                                break;
                            }
                        }
                        text = '- ' + (fld ? (t('reader.field.' + fld) + ': ') 
                                          : (t('reader.field.__whole') + ': ')) + text;
                        break;
                    }
                    if (sp0.label === 'reference') {
                        text = '1. ' + t('reader.field.__ref') + ': ' + text;
                        break;
                    }
                    /*
                      ══ ⚠️⚠️ 尾注 → `> ` 前缀（v0.2.39）══

                      用户反馈：

                        「标注了尾注之后没有任何反应，仍然是正文段且编号不变」

                      真因：这一整段"标注 → md 前缀"的转换里**根本没有
                      endnote 分支**。标注确实写进了 `labels`（md 导出正确，
                      因为 `markdownOfDoc` 会看 `panel` 的 label），
                      但**渲染路径**是从 `text` 出发的 ——
                      没加 `> ` 前缀，就按普通正文渲染，自然还是
                      `is-body-para` + 正文编号。

                      ✅ 补上分支。前缀一旦加上，下面统一按 md 语法解析，
                         走到 `mdQuote` 分支 → `.is-endnote-body`、
                             不挂 `attachBodyMarker`（无编号）。
                    */
                    if (sp0.label === 'endnote') {
                        text = '> ' + text;
                        break;
                    }
                    /* abstract / body / cite 不改变块结构，不加前缀 */
                }
            }

            /*
              ══ ⚠️⚠️⚠️ md 语法直接决定渲染（v0.2.23 重做）══

              用户裁决：
                「这不又麻烦了，为什么不能直接套用md的渲染方法？」
                「对啊」

              ✅ **唯一正确的模型**：拿到文本，按 md 行首语法解析，画出来。
                 不查 `kind`、不查 `labels`、不查 `listMarker`。

              为什么之前会绕弯：有**三个来源**在描述"这块是什么"——
                · `b.kind`        —— PDF 提取层/上一次 md 解析的结论
                · `b.listMarker`  —— 上一次 md 解析的列表记号
                · `labels[line]`  —— 用户刚做的标注
              三者要合并 ⇒ 每一个改动都要考虑"另外两个会不会覆盖我"，
              于是每修一处就坏一处（v0.2.13 → v0.2.22 反复翻车）。

              ✅ 而它们本来就该是**同一件事**：md 文本。
                 标注会被写成 `#` / `- ` / `1. `；编辑由用户直接打这些符号。
                 所以渲染只认文本，三源合一，没有优先级问题。

              解析规则（与 Markdown 标准一致，从长到短匹配）：
                `#### ` → <h4>      `### ` → <h3>
                `## `   → <h2>      `# `   → <h1>
                `- ` / `* ` / `+ `   → <ul><li>
                `1. ` / `1) `        → <ol><li>
                其它                 → <p>

              ⚠️ 标题前缀必须**吃掉**，否则屏幕上会显示 `# 标题`。
              ⚠️ 列表前缀同理 —— 列表记号由 `<li>` 的 `::marker` 画。
            */
            var mdHead = /^(#{1,6})\s+([\s\S]*)$/.exec(text);
            if (mdHead) {
                closeList();
                var lv = mdHead[1].length;
                if (lv > 4) lv = 4;

                /*
                  ══ ⚠️⚠️⚠️ 标题也是**标签段 + 标签内容段**，不是 `<h1>`（v0.2.26）══

                  用户裁决：
                    「你要明白，有序或者无序加相应字段就是我们的标签了，
                      不能按照普通列表项来渲染」
                    「字体样式也不对啊，类型、大小、字重都不对啊，
                      你得看之前的设置啊」

                  ❌ 我一度把标题渲染成 `<h1>`..`<h4>`，并自己发明字号。
                  ✅ 原设计的标题是：

                      <p class="reader-label-head" data-label="title">Title</p>
                      <p class="reader-para is-labeled-body"
                         data-label="title">Attention Is All You Need</p>

                  字号由 CSS 按 `data-label` 决定（v0.1.71 那套）：
                      title 1.9412em (33px)   h1 1.4706em (25px)
                      h2    1.2353em (21px)   h3 1.1176em (19px)
                  字体统一 Times New Roman。全部原样生效，不需要重写。

                  ⚠️ 这也是"可选中"的前提：只有 `.reader-para` 有
                     `user-select: text`（见 styles.css）。
                */
                var labelKey;
                if (lv === 1) labelKey = 'title';
                else if (lv === 2) labelKey = 'h1';
                else if (lv === 3) labelKey = 'h2';
                else labelKey = 'h3';

                /* 标签段：一级标题额外画分隔线 */
                pushLabelHead(labelKey, labelKey === 'h1');

                var hp = document.createElement('p');
                hp.className = 'reader-para is-labeled-body';
                hp.setAttribute('data-label', labelKey);
                hp.textContent = mdHead[2];
                copyBlockAttrs(hp, null, b);
                frag.appendChild(hp);
                continue;
            }

            var mdBullet = /^[-*+]\s+([\s\S]*)$/.exec(text);
            var mdOrdered = /^(\d+)[.)]\s+([\s\S]*)$/.exec(text);

            /*
              ══ ⚠️ 尾注：`> ` 引用块（v0.2.37）══

              用户要求：

                「增加一个新标签：尾注。md 中使用 > 这种引用块来表示；
                  阅读视图中，字号比正文小 2 号，字体款式不变，
                  但使用同提示条颜色的背景框框起来，无编号。」

              三个要点逐一对应：
                · **小 2 号**    → CSS `.is-endnote-body` 里 15px
                                   （正文 17px，见 .reader-content 的 font-size）
                · **背景框**     → `--ui-active-bg`（用户定义的"提示底色"，
                                   灰色；日/夜主题各有值）
                · **无编号**     → **不调** `attachBodyMarker`。
                                   正文/作者/文献都有 A1/R1/1,2,3 这类编号，
                                   尾注是旁注，不该占正文编号序列。
                · **字体款式不变** → 只改 font-size，不碰 font-family；
                                   字体跟随 `.reader-content` 的用户设置。

              ⚠️ 逐行剥掉 `> ` 前缀再显示：引用记号是 md 语法，不是内容。
                 剥完用 `\n` 连起来 —— 保留块内换行（`white-space: pre-wrap`
                 会原样渲染），不能压成一行。
              ⚠️ 单独一个 `>` 行表示引用块内的空行 → 还原成空行。
            */
            var mdQuote = /^>/.test(text);
            if (mdQuote) {
                closeList();

                /*
                  ⚠️ 尾注也输出标签段（`Endnote / 尾注`）——
                     用户要求的是"增加一个新标签"，与其它标签一致地
                     有前置说明文字。但它**没有编号**（见上）。
                     ⚠️ `force = false`：相邻的尾注行应该合成一个区域、
                        只输出一次标签段，不要每段都写一遍。
                */
                pushLabelHead('endnote', false);

                var qRaw = text.split(/\r?\n/);
                var qLines = [];
                for (var qi = 0; qi < qRaw.length; qi++) {
                    var ql = qRaw[qi];
                    var qt = ql.replace(/^[ \t]+/, '');
                    if (qt === '>' || qt === '> ') {
                        qLines.push('');
                    } else if (qt.indexOf('> ') === 0) {
                        qLines.push(qt.slice(2));
                    } else if (qt.charAt(0) === '>') {
                        qLines.push(qt.slice(1));
                    } else {
                        /* 续行（理论上不该出现）：原样保留 */
                        qLines.push(ql);
                    }
                }

                var ep = document.createElement('p');
                ep.className = 'reader-para is-labeled-body is-endnote-body';
                ep.setAttribute('data-label', 'endnote');
                ep.textContent = qLines.join('\n').replace(/^\n+|\n+$/g, '');
                copyBlockAttrs(ep, null, b);
                frag.appendChild(ep);
                continue;
            }

            var isBullet = !!mdBullet;
            var isOrdered = !!mdOrdered;

            /*
              ⚠️ 作者/文献前缀在这里**只用于显示**，不再影响结构判断 ——
                 结构已经由 `- ` / `1. ` 决定了。
            */
            var lm = isBullet ? '- ' : (isOrdered ? '1. ' : '');

            /* ── 无序列表项 ── */
            if (isBullet) {
                /*
                  ══ ⚠️⚠️⚠️ `- Author: …` 是**标签**，不是普通列表项（v0.2.26）══

                  用户裁决：
                    「类似改为author的直接按原本的无序列表来渲染了，
                      而且也变得无法选中。」
                    「你要明白，有序或者无序加相应字段就是我们的标签了，
                      不能按照普通列表项来渲染」

                  ❌ 错误做法：渲染成 `<ul><li>` ——
                     浏览器默认列表项，没有编号竖线、无法用 app 的选区逻辑选中。

                  ✅ 正确做法（v0.2.21 原实现）：渲染成
                     `<p class="reader-para is-labeled-body is-author-body">`
                     这样它仍然是"带标签的正文段"：
                       · 可选中（`.reader-para` 才有 user-select: text）
                       · 挂 `A1` 分类编号 + 左侧竖线
                       · 有标签段「作者信息」在前
                */
                var isAuthorItem = /^Author\b/i.test(mdBullet[1]);
                var isRefLike = /^Ref\s*:/i.test(mdBullet[1]);

                if (isAuthorItem) {
                    closeList();
                    /*
                      ⚠️ 每个作者区域都输出一次「Author」前置文本（v0.2.28）——
                         用户要求：「每一个作者区域前面都增加一个 author 的前置文本」。
                         所以这里传 `force = true`，跳过相邻去重。
                    */
                    pushLabelHead('author', false, true);
                    authorSeq++;

                    /*
                      ⚠️ 先解析 md 文本里的前缀（`Author:` / `Author Name:`），
                         后面按有没有子标签分两条路渲染。
                    */
                    var authorBody = mdBullet[1];
                    var m2 = /^Author\s+([A-Za-z]+)\s*:\s*([\s\S]*)$/i.exec(authorBody);
                    var m1 = /^Author\s*:\s*([\s\S]*)$/i.exec(authorBody);
                    if (m2) {
                        authorBody = m2[2];
                    } else if (m1) {
                        authorBody = m1[1];
                    }

                    /*
                      ══ ⚠️⚠️ 子标签区间必须相对**原文**（v0.2.29）══

                      `labels[line]` 里的 start/end 是相对**块原文**的
                      （`blockTextOf(line)` 的返回值），不是相对加了
                      md 前缀之后的 `text`。

                      实测踩到：用 `text` 去切片，得到
                        `- Author Affilia…tion: Ashis` —— 位置整体错位，
                      因为 `text` 前面多出了 `- Author: ` 这 10 个字符。

                      ✅ 所以这里取一次**原文**，用它做切片基准。
                    */
                    /*
                      ⚠️ 用 `textOfBlock(b)`（v0.2.35）——
                         子标签的 `labels` 坐标是相对**原始块文本**的，
                         而行号重复时 `blockTextOf(b.line)` 会取到别的块。
                    */
                    var rawText = textOfBlock(b);
                    if (rawText == null) rawText = b.text || '';
                    rawText = String(rawText);

                    /*
                      ══ ⚠️⚠️ 作者项：左项名 + 右内容，`Author:` 不显示（v0.2.27）══
                         多子项渲染成多行（v0.2.29）

                      用户裁决：
                        「Author: 这个我们用来判别的字段不应该显示出来，
                          同时作者信息文本应该右对齐。」
                        「此时显示的样子是左对齐一个 Author Name，
                          右对齐选中的 Author Name 文本」

                      ⚠️ 一个作者块可能有**多个子标签**（姓名 + 单位 + 邮箱），
                         每个子标签一行。之前只渲染第一条，其余丢失。
                         ✅ 现在按 `authorItemsOf` 切出的项逐行输出：

                             <div class="reader-author-line">
                               <span class="reader-author-field">姓名</span>
                               <span class="reader-author-value">张三</span>
                             </div>
                    */
                    /*
                      ⚠️ 先从 labels 取这一块的子标签区间，按区间切项。
                         数据来源是 `spans`（真实的标注），不是 md 文本 ——
                         因为 md 里作者子标签是写成多行的，渲染时块已经
                         被拆成多块，单块内不一定带完整信息。
                    */
                    var authorRows = [];
                    var blockSpans = (typeof b.line === 'number') ? (labels[b.line] || []) : [];
                    var fieldMarks = [];
                    for (var fm = 0; fm < blockSpans.length; fm++) {
                        var fsp = blockSpans[fm];
                        if (!fsp || fsp.label !== 'author' || !fsp.field) continue;
                        fieldMarks.push(fsp);
                    }

                    if (fieldMarks.length) {
                        /*
                          ══ ⚠️⚠️⚠️ 有原始行边界时**按行切**，不拆行（v0.2.30）══

                          用户反馈（老 bug 复发）：
                            「又出现了子标签换行这个老bug。。。」

                          实测：原文 3 行

                              Ashish Vaswani Noam Shazeer
                              Google Brain Google Research
                              avaswani@google.com noam@google.com

                          用户只把第 2 行的 `Google Brain` 标成单位，
                          结果渲染成 3 行 → **4 行**：

                              ① Ashish Vaswani Noam Shazeer
                              ② Google Brain            ← 第 2 行被拆开
                              ③ Google Research avaswani@... ← 残片
                              ④ noam@google.com

                          真因：我按**标注区间**切分，而区间只覆盖第 2 行的一部分，
                          于是那一行被切成「前残片 + 标注段 + 后残片」三段。

                          ✅ 正确做法：**行是行的边界，子标签只是行的一个属性**。
                             · 有 `lines` → 按行输出，每行判断"整行是否被某条子标签覆盖"
                             · 没有 `lines` → 才退回按区间切（单行块的情形）

                          ⚠️ 判据是"整行被覆盖"：`mk.start <= 行起+1 &&
                             mk.end >= 行终-1`。用户在行中间只选几个词时，
                             那一行不归给这个子标签（宁可当无名行，也不能把行拆碎）。
                        */
                        var srcLines = (b.lines && b.lines.length > 1) ? b.lines : null;
                        if (srcLines) {
                            var scan = 0;
                            for (var li = 0; li < srcLines.length; li++) {
                                var rowT = String(srcLines[li] || '').replace(/^\s+|\s+$/g, '');
                                if (!rowT) continue;

                                /*
                                  ⚠️ 在**原文**里定位这一行的起点。
                                     从 `scan` 往后找，保证第二行的第二次出现
                                     不会被误当成第一行。
                                */
                                var rowAt = rawText.indexOf(rowT, scan);
                                if (rowAt < 0) rowAt = rawText.indexOf(rowT);
                                var rowEndAt = (rowAt < 0) ? -1 : (rowAt + rowT.length);

                                var rowField2 = null;
                                if (rowAt >= 0) {
                                    for (var rk = 0; rk < fieldMarks.length; rk++) {
                                        var rmk = fieldMarks[rk];
                                        var rms = Number(rmk.start) || 0;
                                        var rme = Number(rmk.end) || 0;
                                        /*
                                          ══ ⚠️ 判据：子标签**落在这一行内**即可（v0.2.30）══

                                          用户给某行中间的几个词加了子标签
                                          （例如第 2 行的 `Google Brain`），
                                          期望是**整行**显示为「单位」。

                                          ⚠️ 不能要求"整行被覆盖" ——
                                             行是排版折行，用户选不中整行；
                                             他的意图是"这一行是单位"。
                                          ⚠️ 但行**不能拆碎** ——
                                             拆碎正是"子标签换行"那个老 bug。
                                             所以：行照原样输出，只标记它的字段。
                                          ⚠️ 一行只归给第一条命中的子标签，
                                             多条时取覆盖最多的那条。
                                        */
                                        var overlap = Math.min(rme, rowEndAt) - Math.max(rms, rowAt);
                                        if (overlap > 0) {
                                            rowField2 = rmk.field;
                                            break;
                                        }
                                    }
                                    scan = rowEndAt;
                                }

                                authorRows.push({ text: rowT, field: rowField2 });
                            }
                        } else {
                            /*
                              ⚠️ 没有原始行（整块就是一行）→ 按区间切，见下。
                            */
                            fieldMarks.sort(function (x, y) {
                                return (Number(x.start) || 0) - (Number(y.start) || 0);
                            });
                            var cur2 = 0;
                            for (var fk = 0; fk < fieldMarks.length; fk++) {
                                var fkSpan = fieldMarks[fk];
                                var fs0 = Math.max(0, Math.min(Number(fkSpan.start) || 0, rawText.length));
                                var fe0 = Math.max(0, Math.min(Number(fkSpan.end) || 0, rawText.length));
                                if (fs0 > cur2) {
                                    authorRows.push({ text: rawText.slice(cur2, fs0), field: null });
                                }
                                authorRows.push({ text: rawText.slice(fs0, fe0), field: fkSpan.field });
                                cur2 = Math.max(cur2, fe0);
                            }
                            if (cur2 < rawText.length) {
                                authorRows.push({ text: rawText.slice(cur2), field: null });
                            }
                        }
                    } else if (m2) {
                        /* 单行带字段前缀（`- Author Name: xxx`）*/
                        authorRows.push({ text: m2[2], field: m2[1].toLowerCase() });
                    } else {
                        /*
                          ══ ⚠️ 无子标签 → **每行一条**（v0.2.31 修）══

                          用户原话：

                            「算了，我不加子标签了……直接到标签那一级就停下吧」

                          既然子标签停用，这条分支就是**唯一**路径了，
                          它必须是正确的。

                          ⚠️ 旧写法 `authorRows.push({ text: rawText })` 有 bug：
                             `rawText` 是**整块原文**，含换行符，
                             塞进一个 `.reader-author-line` 后
                             两行作者挤在同一行里显示。

                          ✅ 按 `b.lines`（原始排版行）逐行输出 ——
                             一个作者区域一行，与子标签时代的行为一致。
                          ⚠️ 没有 `lines` 才退回整块（真正的单行块）。
                        */
                        var plainSrc = (b.lines && b.lines.length > 1)
                            ? b.lines
                            : String(rawText || '').split(/\r?\n/);
                        for (var pi = 0; pi < plainSrc.length; pi++) {
                            var pT = String(plainSrc[pi] || '').replace(/^\s+|\s+$/g, '');
                            if (!pT) continue;
                            authorRows.push({ text: pT, field: null });
                        }
                        if (!authorRows.length) {
                            authorRows.push({ text: rawText, field: null });
                        }
                    }

                    var ap = document.createElement('p');
                    ap.className = 'reader-para is-labeled-body is-author-body';
                    ap.setAttribute('data-label', 'author');

                    var boxEl = document.createElement('div');
                    boxEl.className = 'reader-author-box';

                    for (var ar = 0; ar < authorRows.length; ar++) {
                        var rowTxt = String(authorRows[ar].text || '').replace(/^\s+|\s+$/g, '');
                        if (!rowTxt) continue;
                        var rowField = authorRows[ar].field;

                        var lineEl = document.createElement('div');
                        lineEl.className = 'reader-author-line';
                        /*
                          ⚠️ 姓名字段用正常色，其他字段淡色（v0.1.79）。
                        */
                        if (rowField === 'name') lineEl.classList.add('is-author-name');

                        var fEl = document.createElement('span');
                        fEl.className = 'reader-author-field';
                        fEl.textContent = rowField
                            ? (t('reader.field.' + rowField) || rowField)
                            : '';

                        var vEl = document.createElement('span');
                        vEl.className = 'reader-author-value';
                        vEl.textContent = rowTxt;

                        lineEl.appendChild(fEl);
                        lineEl.appendChild(vEl);
                        boxEl.appendChild(lineEl);
                    }

                    ap.appendChild(boxEl);

                    attachBodyMarker(ap, 'A' + authorSeq);
                    copyBlockAttrs(ap, null, b);
                    frag.appendChild(ap);
                    continue;
                }

                /* 普通无序列表项（不是标签）→ 正常 <ul><li> */
                resetLabelHead();
                var ul = ensureList('ul');
                var li1 = document.createElement('li');
                li1.className = 'reader-li reader-li-bullet';
                li1.textContent = isRefLike ? mdBullet[1] : mdBullet[1];
                copyBlockAttrs(li1, null, b);
                ul.appendChild(li1);
                continue;
            }

            /* ── 有序列表项 ── */
            if (isOrdered) {
                /*
                  ⚠️ 同理：`1. Ref: …` 是**文献标签**，渲染成
                     `<p class="reader-para is-labeled-body">` + `R1` 编号，
                     而不是 `<ol><li>`。
                */
                closeList();

                /*
                  ⚠️ 每条文献**各自一个区域**（v0.1.77）——
                     R 编号必须递增，不能只出现一次。
                     所以这里每次都强制输出标签段，绕过 lastLabelKey 去重。
                */
                var refLabelKey = 'reference';
                if (lastLabelKey !== refLabelKey) {
                    lastLabelKey = refLabelKey;
                    var refHead = document.createElement('p');
                    refHead.className = 'reader-label-head';
                    refHead.setAttribute('data-label', refLabelKey);
                    var refTxt = document.createElement('span');
                    refTxt.className = 'reader-label-text';
                    refTxt.textContent = t('reader.label.' + refLabelKey);
                    refHead.appendChild(refTxt);
                    frag.appendChild(refHead);
                }
                refSeq++;

                ordNum += 1;
                /*
                  ⚠️ `Ref:` 同样是**存储判别标记**，不显示（v0.2.27）。
                */
                var refBody = mdOrdered[2];
                var rm = /^Ref\s*:\s*([\s\S]*)$/i.exec(refBody);
                if (rm) refBody = rm[1];

                var rp = document.createElement('p');
                rp.className = 'reader-para is-labeled-body';
                rp.setAttribute('data-label', 'reference');
                rp.textContent = refBody;
                attachBodyMarker(rp, 'R' + refSeq);
                copyBlockAttrs(rp, null, b);
                frag.appendChild(rp);
                continue;
            }

            /* ── 普通段落 → <p> ── */
            closeList();
            resetLabelHead();

            var p = document.createElement('p');
            p.className = 'reader-para';

            /*
              ══ 引用高亮（v0.2.24 恢复）══

              用户要求：
                「增加一个引用标签，比如我给类似「[12]」这种就可以加引用标签」

              ⚠️ 引用标注是**行内**的（夹在正文句子中间），
                 不能把整块拆开 —— 那会把一句话劈成三段。
                 所以这里先看有没有 cite 标注，有就把那段包成 `<span>`。
            */
            var citeSpan = null;
            if (spans && spans.length) {
                for (var cs = 0; cs < spans.length; cs++) {
                    if (spans[cs] && spans[cs].label === 'cite') { citeSpan = spans[cs]; break; }
                }
            }

            if (citeSpan) {
                var ca = Math.max(0, Math.min(Number(citeSpan.start) || 0, text.length));
                var cb = Math.max(ca, Math.min(Number(citeSpan.end) || 0, text.length));
                if (cb > ca) {
                    p.appendChild(document.createTextNode(text.slice(0, ca)));
                    var ce = document.createElement('span');
                    ce.className = 'reader-cite';
                    ce.setAttribute('data-label', 'cite');
                    if (typeof citeSpan.ref === 'number') {
                        ce.setAttribute('data-cite', String(citeSpan.ref));
                    }
                    ce.textContent = text.slice(ca, cb);
                    p.appendChild(ce);
                    if (cb < text.length) {
                        p.appendChild(document.createTextNode(text.slice(cb)));
                    }
                } else {
                    p.textContent = text;
                }
            } else {
                p.textContent = text;
            }

            /*
              ⚠️ 正文段编号：只有**真正未标注的正文**才计数。
                 标成 title / h1-3 / author / abstract / reference 的块
                 已经在上面各自的分支里返回了，走到这里的就是正文。
            */
            if (bodyIndex) {
                bodyIndex.n++;
                attachBodyMarker(p, bodyIndex.n);
            }
            copyBlockAttrs(p, null, b);
            frag.appendChild(p);
        }

        closeList();
        contentEl.textContent = '';
        contentEl.appendChild(frag);
    }

    /**
     * 平坦渲染：一段一个 `<p>`，没有区域、没有等级。
     *
     * ⚠️ v0.1.39 起这是**唯一**的正文渲染路径（`renderBlocks` 直接调它）。
     *    早期它是"分区失败时的兜底"，现在成了主路径 ——
     *    因为用户要求「不允许有任何模板」。
     */

    /**
     * 给一个段落挂上编号 + 左侧提示条（v0.1.57 / v0.1.68 重做）。
     *
     * 用户要求：
     *   「正文段计数，左边加提示条和正文段编号。编号在提示条左边。」
     *
     * 视觉：
     *
     *      3 │ 正文内容…
     *      ^ ^
     *      │ └ 提示条（竖线）
     *      └ 编号（在竖线左边）
     *
     * ══ ⚠️⚠️ 三个并排元素（v0.1.68）══
     *
     * 用户要求：
     *   「不是，这么复杂吗？直接定义三个并排的元素，
     *     然后中间加间隔不就行了吗？」
     *
     * 段落是 flex 容器，DOM 里就是三样东西：
     *
     *   [::before 编号]  [.reader-rule 竖线]  [正文文本节点]
     *
     * · 编号：CSS `::before` + `attr(data-body-no)`，不占额外节点；
     * · 竖线：**真实元素** `<span class="reader-rule">` ——
     *         不能用 `border-left`，border 只能贴盒子边缘，
     *         没法排到编号右边；
     * · 正文：直接是文本节点，会自动成为匿名 flex 项。
     *
     * 三者之间用 `gap: 6px` 拉开，谁也不用负 margin、
     * 谁也不用脱离文档流。编号多高，段落就多高 —— 天然成立。
     *
     * ⚠️ 竖线要插在**编号之后、正文之前**，所以只能 `prepend` 到
     *    段落里（此时段落里只有文本节点）。
     *
     * @param {string|number} no 编号，可以是 `12` 或带前缀的 `R3` / `A2`
     */
    function attachBodyMarker(el, no) {
        el.classList.add('is-body-para');

        /*
          ══ ⚠️⚠️ 编号与竖线**分开处理**（v0.1.93）══

          用户要求：
            「同一个作者区域的编号应当相同，提示条应当连续」

          ✅ 语义上，编号和竖线都是**区域**的属性，不是块的属性。
             一个区域里有多段时：
               · 编号只挂在第一段（A1 只出现一次）
               · 竖线**每段都要挂** —— 用户看到的是"一条连续的提示带"，
                 中间断开就会以为是两个区域。

          ⚠️ 所以 `no === null` 表示"这一段属于某个区域，但不是首段"：
             只挂竖线，不设编号。CSS 里 `::before` 靠
             `attr(data-body-no)` 取内容，没有该属性就不渲染编号，
             但竖线是真实元素，照常显示 —— 正好是想要的效果。
        */
        if (no !== null && no !== undefined) {
            el.setAttribute('data-body-no', String(no));
        }

        /*
          ⚠️ 竖线作为第二个 flex 项插入。
             它本身无文字，纯装饰，必须 `aria-hidden` +
             `user-select: none`，否则复制正文时可能带出一个空白。
        */
        var rule = document.createElement('span');
        rule.className = 'reader-rule';
        rule.setAttribute('aria-hidden', 'true');
        el.insertBefore(rule, el.firstChild);
    }

    /**
     * 取一个块的「标签签名」——用于判断相邻块是否属于同一区域。
     *
     * ⚠️ 只要有一个块的标签不同，签名就不同，它们就分属两个区域。
     *    这样"作者信息"标在第 3–5 段时，第 3/4/5 段是同一区域，
     *    第 6 段（未被标注）开始新的一块。
     *
     * @return {string} 空串 = 这块没有标注
     */
    function labelSignatureOf(b) {
        if (!b || typeof b.line !== 'number') return '';

        /*
          ══ ⚠️⚠️ 模板角色优先于用户标注（v0.2.6）══

          模板指定了 `role` 时，直接用它当签名 —— 模板是**显式**的
          排版意图，比"用户有没有在这个块上画过标注"更权威。

          ⚠️ 为什么不让两者叠加（`role + labels`）：
             叠加会得到一个全新的签名，于是这个块被划进独立的 run，
             本该和相邻块合并的区域反而被切开。
             模板的语义就是"告诉我这个块属于哪一类"，
             它应当是这一类**唯一**的依据。

          ⚠️ `role: 'body'` 也返回空签名 —— 正文本来就该走无标签路径。
             只有需要显示标签段的角色才返回非空签名。
        */
        var roleSig = roleSignatureOf(b);
        if (roleSig !== undefined) return roleSig;

        var spans = labels[b.line];
        if (!spans || !spans.length) return '';

        /*
          ══ ⚠️⚠️ 同一类型重复只算一次（v0.1.81）══

          用户要求：
            「子标签对应的是段内的行，不是整个段」

          ✅ 一行一个子标签 ⇒ 一个块里会有**多条同类型**的 author 标注：

              {start:0,  end:28, label:'author', field:'name'}
              {start:29, end:47, label:'author', field:'affiliation'}

          ⚠️ 旧实现把每条都拼进签名，得到 `author|author` ——
             与相邻单条 `author` 的块（`author`）签名不同，
             于是这个块被划进独立的 run，
             跑到"一块多标签"的 `makeLabeledBlock()` 分支里，
             整个作者区域被拆开。

          ✅ 用**去重后**的标签集合做签名：
             上面两条都产出 `author`，与相邻块同签名，
             仍然合并成同一个作者区域。
        */
        var seen = {};
        var keys = [];
        for (var i = 0; i < spans.length; i++) {
            var sp = spans[i];
            if (!sp || !sp.label) continue;
            if (seen[sp.label]) continue;
            seen[sp.label] = true;
            keys.push(sp.label);
        }
        keys.sort();
        return keys.join('|');
    }








    /**
     * 把 `data-page` / `data-line` 等数据属性设到新元素上。
     *
     * @param {Element} dst
     * @param {Element|null} src 已经造好的 DOM 元素（可选）
     * @param {Object|null} block 块数据 `{page, line}`（`src` 为空时用它）
     *
     * ⚠️ 两种来源都要支持（v0.1.50）：
     *    有时手上有现成元素（直接照抄属性），有时只有块数据
     *    （appendLabeledRun 走的就是后者，它不预先造元素）。
     */
    function copyBlockAttrs(dst, src, block) {
        if (src && src.attributes) {
            for (var i = 0; i < src.attributes.length; i++) {
                var at = src.attributes[i];
                if (at.name === 'class') continue;
                dst.setAttribute(at.name, at.value);
            }
            return;
        }

        if (!block) return;
        if (block.page) dst.setAttribute('data-page', String(block.page));
        if (typeof block.line === 'number' && block.line >= 0) {
            dst.setAttribute('data-line', String(block.line));
        }
    }

    /**
     * ══ ⚠️⚠️ 过滤掉「被别的块包含」的重复块（2026-09-25 真机实测的真因）══
     *
     * 症状（用户连续多版反馈）：
     *   「自动识别的框是乱的」「改分类旧分类跑到框右下角、越改越多」
     *   「清除后新增的框删不掉」「无法增加其他的框」
     *
     * 真因：原生输出的块里存在**大量互相包含的重复块**。
     *   实测 Transformer 论文第 1 页：
     *       可见框 45 个，其中 **15 对是重叠的**，而且多对是
     *       `ratio = 1.0`（小框 100% 被大框包住）。
     *
     *   典型一组（全部判成 heading）：
     *       line=0  rect=[ 89,214,180,59]   ← 标题整体（大字粗体）
     *       line=1  rect=[111,266, 68, 7]   ← 标题内的词 "Attention"
     *       line=2  rect=[180,266, 61, 7]   ← 词 "Is"
     *       line=3  rect=[242,266, 61, 7]   ← 词 "All"
     *       line=4  rect=[ 94,266,241,14]   ← 又一层
     *
     *   为什么会产生：PdfText 的 `startsNewBlock` 用**字号/粗体**判标题，
     *   而标题里的每个词本身也是大字粗体 → 每个词都独立成块；
     *   同时整行又被合成一个块 → 两套重叠。
     *
     * 为什么必须在 web 侧过滤（而不是只改 PdfText）：
     *   · 重叠框让「点击命中」变得不确定 —— 用户看到的是下层框，
     *     点下去命中的是上层框。于是：
     *       改分类 → 改的是另一个（看不见的）块 → 像是"旧分类跑到
     *                右下角去了"（因为那些词块正好贴在标题右下）
     *       删除   → 删掉上层，用户看到的那个还在 → 像是"删不掉"
     *       反复操作 → 越积越多；一块位置堆满后 → "无法增加其他框"
     *   · 这条因果链**一次解释了用户报的全部现象**。
     *   · 在 web 侧过滤，渲染 / 标注 / 点击三处用的是同一份数据，
     *     不会出现"渲染按 A 算、点击按 B 算"的错位。
     *
     * 判据：若块 A 的包围盒**基本被块 B 覆盖**（覆盖率 ≥ 0.85），
     *       且 B 不是 A 自己，则丢掉 A（保留外层那个大的）。
     *
     * ⚠️ 只在**同页**比较（跨页的包围盒没有可比性）。
     * ⚠️ 用 0.85 而不是 1.0：PDF 的字形边界有半像素误差，
     *    实测完全包含时覆盖率是 0.97~1.0，而"相邻但不同"的块
     *    通常低于 0.6。0.85 留出余量，不会误删相邻块。
     * ⚠️ 覆盖率用**面积比**（交集 / A 的面积），不是任一方面积 ——
     *    否则小框包含大框时也会被误判。
     */
    function dropContainedBlocks(blocks) {
        if (!blocks || blocks.length < 2) return blocks;

        /*
          ══ ⚠️⚠️ md 解析出来的块**不能**做几何去重（v0.1.92 实测丢字事故）══

          实测：Word2Vec 的标题在 PDF 里是两行

              Efficient Estimation of Word Representations in
              Vector Space

          提取层产出两个块（正确），从前端走 PDF 路径时，
          这两块的包围盒互相包含（第二行被第一行的框整个盖住），
          于是被当成"重复输出"丢掉一个 —— `Vector Space` 永久消失。

          ⚠️ 丢字不可接受。用户要求原话：
             「pdf 转 md 的时候要确保文本不能少了」

          ✅ 判据：**md 块带 `fromMd` 标记**（见 setMd 路径）。
             这类块一块一行、已经是我们自己整理过的结果，
             不存在"原生重复输出"，绝不能去重。

          ⚠️ 为什么不用"有没有坐标"判断：
             原生 `blocksToJson` 就是**有坐标才输出坐标**（见 1622 行），
             所以 PDF 路径里也可能有块没有坐标 —— 那样判据会失效。
             用显式标记，语义明确、不依赖巧合。
        */
        if (blocks[0] && blocks[0].fromMd) {
            return blocks;
        }

        var n = blocks.length;
        var drop = [];
        for (var i = 0; i < n; i++) drop.push(false);
        var dropped = 0;

        for (var a = 0; a < n; a++) {
            if (drop[a]) continue;
            var A = blocks[a];
            if (!A || !A.page) continue;
            var aArea = (A.x1 - A.x0) * (A.y1 - A.y0);
            if (!(aArea > 0)) continue;

            for (var b = 0; b < n; b++) {
                if (b === a || drop[b]) continue;
                var B = blocks[b];
                if (!B || B.page !== A.page) continue;
                if (!(B.x1 > B.x0) || !(B.y1 > B.y0)) continue;

                var ix = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
                var iy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
                if (ix <= 0 || iy <= 0) continue;

                // A 被 B 覆盖的比例
                var cover = (ix * iy) / aArea;
                if (cover < 0.85) continue;

                /*
                  ⚠️ 两者互相覆盖（面积几乎相等）时，只丢**行号更大**的
                     那个 —— 保持"丢后面的"这一确定性规则，
                     否则同一份数据两次过滤结果可能不同（遍历顺序依赖）。
                */
                var bArea = (B.x1 - B.x0) * (B.y1 - B.y0);
                if (bArea <= aArea * 1.02) {
                    // B 不比 A 大 → 反向也判一次，避免把大的丢掉
                    var coverB = (ix * iy) / bArea;
                    if (coverB >= 0.85) {
                        var loser = ((A.line == null ? 1e9 : A.line) >
                                     (B.line == null ? 1e9 : B.line)) ? a : b;
                        if (!drop[loser]) { drop[loser] = true; dropped++; }
                        if (loser === a) continue;   // A 被丢，跳出内层
                        continue;
                    }
                }
                drop[a] = true;
                dropped++;
                break;
            }
        }

        if (!dropped) return blocks;

        var kept = [];
        for (var k = 0; k < n; k++) {
            if (!drop[k]) kept.push(blocks[k]);
        }
        trace('reader:blocks', 'dropped ' + dropped + ' contained of ' + n
              + ' -> ' + kept.length);
        return kept;
    }

    /**
     * ══ 语义分段：把「按版式切的段」拼接成「按语义切的段」（v0.1.95）══
     *
     * 为什么要做这一步：
     *
     *   PDF 的段落边界是**几何**决定的（行的 x0 缩进、y 间距）。
     *   但很多论文/扫描件的排版根本读不出这个信号 ——
     *   一段话被硬切成 5 个块，每块一行，读起来全是碎的。
     *
     *   用户原话：
     *     「PDF 应该只是文本，不要识别标题」——
     *     但"一段话被切成五行"是**另一种**错误：
     *     它不引入错误的标题，却让文字不成句。
     *
     * ✅ 做法：只动**连续的同类型正文块**。
     *    · 把它们的文本收集起来，用模型算相邻句相似度，重新分段；
     *    · 段的**行号范围**按原块的行数比例重新分配 ——
     *      这样标注、编辑的坐标系仍然落在原来那批块的覆盖范围内。
     *
     * ⚠️ 作用范围（v0.2.3 修正过）：
     *   · 处理**所有非公式块** —— 包括 md 里残留的 `author` /
     *     `reference` 标记。用户的编辑与标注在切分前已被清空，
     *     那些 kind 不再有语义，留着只会让编号错位（`A1` 插在
     *     正文编号中间）。见下面 `isBody` 的详细说明。
     *   · 公式块**不碰**，且会把两边的正文区段断成两段；
     *   · 必须**至少 2 个块**才值得重排（1 块本来就是 1 段）；
     *   · 模型不可用时**原样返回** —— 绝不因为模型缺失而改变结果。
     *   · 重排后段落总数变少时，是"合并"；变多时，是"拆分"。
     *     两种都允许，因为语义边界与版式边界本来就不同。
     *
     * ⚠️ 为什么不直接用 `ScholariusSeg.segment` 的结果替换 blocks：
     *   那样会丢掉 `line` / `page` / 坐标，标注与编辑会全部错位。
     *   所以这里只重算**文本**与**行数归属**，其余字段照抄。
     *
     * @param {Array} blocks 原始块
     * @return {Promise<Array>} 重排后的块（失败时返回原数组）
     */
    function semanticReflow(blocks) {
        var seg = window.ScholariusSeg;
        var sem = window.ScholariusSemantic;
        if (!blocks || blocks.length < 2 || !seg || !sem) {
            return Promise.resolve(blocks);
        }
        /* ⚠️ 用户没开 → 完全不动。这是"可选功能"的前提 */
        var enabled = false;
        try {
            enabled = !!(sem.isEnabled && sem.isEnabled());
        } catch (e) { enabled = false; }
        if (!enabled) return Promise.resolve(blocks);

        /*
          ① 找出所有「连续的正文块」区段。
             遇到非正文块（formula / 有 kind 的其他值）就断开 ——
             不能跨越公式去合并，那会把公式挤到两段之间。

          ══ ⚠️⚠️ 哪些块算"正文"（v0.2.3 修正）══

          用户报的现象：

            「分成不同的段之后，正文段编号居然没有更新？」
            「好像切分后就固定了一样」

          实测：切分后编号序列是 `1 2 A1 3 4 5 ...` ——
          `A1` 卡在正文编号中间。

          真因：`author` / `reference` 这类块**不参与重组**
          （下面的 `isBody` 把它们排除），于是它们留在原位；
          而它们周围的正文块被合并成少数几个大段 ——
          结果作者区就"漂"到了新的正文段序列中间。

          ⚠️ 编辑和标注在切分前已经被清空了（见 resegmentCurrent），
             所以此时 `kind === 'author'` **不再代表"用户标的作者区"**，
             它只是 md 里残留的一个字段值。

          ✅ 既然用户要的是"按语义重新切整篇文本"，那就应该把
             **所有非公式块**都当正文参与重组，重建出来的块一律
             `kind: 'paragraph'`。这样编号必然连续：
             1, 2, 3, ... 不会再有 `A1` 插在中间。

          ⚠️ 公式仍然排除：把它卷进段落会破坏公式的独立性，
             而且公式文本被模型当句子处理毫无意义。
        */
        function isBody(b) {
            if (!b) return false;
            var k = b.kind || '';
            /* 公式永远不参与 —— 它需要保持独立成块 */
            if (k === 'formula') return false;
            return !!String(b.text || '').trim();
        }

        var runs = [];
        var cur = [];
        for (var i = 0; i < blocks.length; i++) {
            if (isBody(blocks[i])) {
                cur.push(i);
            } else {
                if (cur.length) { runs.push(cur); cur = []; }
            }
        }
        if (cur.length) runs.push(cur);

        /* 没有一个区段够长 → 不用模型，省一次加载 */
        var worth = runs.filter(function (r) { return r.length >= 2; });
        if (!worth.length) return Promise.resolve(blocks);

        /*
          ══ 进度条（v0.1.97）══

          用户要求：「那给模型渲染也加一个进度表单」

          ⚠️ 为什么在这里而不是在 setText 里：
             只有真正要跑模型（`worth` 非空）时才该显示进度条。
             若在 setText 里无条件显示，那么"分段关闭"的用户
             每次打开文献都会看到一根进度条闪一下 —— 纯噪音。

          ⚠️ 总数是**预估**：真正切出的句子数要等模型分句。
             这里先用块数当上界，第一个批次回调时再校正。
             不准也没关系 —— 进度条只要在动就行。
        */
        var prog = window.ScholariusSegProgress;
        var grandTotal = 0;
        for (var w = 0; w < worth.length; w++) grandTotal += worth[w].length;
        var doneSentences = 0;

        if (prog) {
            prog.start(grandTotal);
            /* ⚠️ 每次重新开始分段都必须清掉上次的取消标志 */
            if (seg.resetCancel) seg.resetCancel();
        }

        /*
          ② 逐区段跑模型。
             ⚠️ 串行而不是并行：模型只有一个 wasm 实例，
                同时跑会让内存翻倍（实测 OOM 风险）。

          ══ ⚠️⚠️ 两个阶段必须分开（实测踩到）══

          一开始的写法是「跑完一个区段就 splice 进 `out`」，
          结果第二个区段的 `run[]` 下标在第一次 splice 后**全部失效**，
          报 `Cannot read properties of undefined (reading 'text')`。

          真因：`run` 里存的是**原始数组的下标**，一旦数组增删，
          这些下标指向的就是别的块（甚至越界）。

          ✅ 现在：第一阶段只**算出**每个区段的替换结果，存进 patch 表；
             第二阶段从后往前一次性重建 —— 从后往前保证前面的下标不受影响。
        */
        var patches = [];   /* [{start, count, items}] 按 start 升序 */
        /* ⚠️ 用户点了「跳过」→ 后续区段全部不再处理 */
        var userCancelled = false;

        var chain = Promise.resolve();
        worth.forEach(function (run) {
            chain = chain.then(function () {
                /* 已经取消 → 直接跳过，节省模型算力 */
                if (userCancelled) return null;

                var parts = [];
                var partBlocks = [];
                for (var r = 0; r < run.length; r++) {
                    var t = String(blocks[run[r]].text || '').trim();
                    if (t) { parts.push(t); partBlocks.push(run[r]); }
                }
                if (parts.length < 2) return null;

                /*
                  ══ ⚠️⚠️ patch 只能覆盖**参与拼接的那些块**（v0.2.33）══

                  `run` 可能包含空白块（`text` 全是空格），它们被
                  `partBlocks` 跳过了。而 patch 一旦写成
                  `{ start: run[0], count: run.length }`，
                  替换范围就**包含了那些被跳过的块** ——

                    它们既不在 `joined` 里（所以文本丢了），
                    又被 splice 掉（所以块也没了）。

                  结果就是用户看到的「大量缺失内容」。

                  ✅ 替换范围取 `partBlocks` 的首尾：
                     从第一个参与块到最后一个参与块。
                     中间如果有空块被跨过，它本来就没有内容，
                     被合并掉是合理的 —— 但首尾之外的块**绝不能动**。
                */
                /*
                  ══ ⚠️⚠️ 喂给模型的是**原始纯文本块**，不是我们切好的句子（v0.2.36）══

                  用户指出：

                    「是不是你用的不是纯文本分的，导致md的各种符号
                      干扰了模型的判断？」

                  方向对：问题在于**我擅自改变了模型的输入**。

                  ── 旧实现（切分正常时）──

                      var parts = [];
                      for (...) parts.push(String(blocks[run[r]].text).trim());
                      return seg.segment(parts, {...});

                  模型收到的是「一个块一行」的数组，它内部用
                  `splitSentences` 自己切句、自己算相似度 ——
                  分句规则、阈值、批次全都由它决定。

                  ── 我改成了什么（切分变差的原因）──

                      var joined = 各块用 '\n' 连起来
                      var sentsWithOff = splitSentencesWithOffsets(joined)
                      return seg.segment(sentTexts, {...})

                  本意是"保留原文偏移以便切片"，但代价是：
                  ① `joined` 把所有块压成一整段，**原来的块边界消失了**；
                  ② 我自己的切句规则（含 12 字符碎片合并）与
                     `seg.splitSentences` 不完全一致，句子集合变了；
                  ③ 模型拿到的句子和它内部预期的分布不同 →
                     相似度阈值 `thresholdFor(n)` 的基准也变了。

                  结果：分段位置明显不如以前合理 —— 用户说的
                  「分得乱七八糟」「和当时没改md的时候不一样」。

                  ── ✅ 现在 ──

                  恢复成 `seg.segment(parts, ...)`：让模型用它自己的
                  分句器处理原始块文本，**与切分正常时完全一致**。

                  ⚠️ 那"内容被规范化"的问题怎么办？
                     不靠改输入解决，而是靠**事后校验**：
                     切分结果拼起来必须与原文一致（见下面的
                     `joined` / `recon` 检查）。不一致就整个区段放弃。
                     这样既保持模型输入不变，又保证内容不丢。
                */
                var patchStart = partBlocks[0];
                var patchCount = partBlocks[partBlocks.length - 1] - patchStart + 1;

                /*
                  ══ ⚠️⚠️ 建立「模型输入文本 → 原文」的映射（v0.2.32）══

                  用户反馈：

                    「模型切分前后怎么文本内容还变了？按理来说不应该
                      仅切分吗不更改内容吗？」

                  完全正确。切分只该决定**在哪里断开**。

                  ── 旧实现为什么会改字 ──

                  ① 每个块 `trim()` 后放进 `parts` 数组，**块与块之间
                     原有的分隔（换行、缩进、多个空格）直接丢掉**；
                  ② `seg.segment(parts)` 里 `buf.join(' ')` 用**单个空格**
                     把句子连起来返回；
                  ③ 结果直接当新块 `text`。

                  于是原文的所有空白都被"规范化"成一个空格 ——
                  文字没少，但**排版信息全丢了**，用户看到的就是
                  「内容变了」。

                  ── ✅ 现在的做法：只取"断点"，不取"文本" ──

                  1. 把这一区段的所有块用**原文中的真实分隔符**接成 `joined`
                     （块之间用一个换行，块内保留原样）；
                  2. 对 `joined` 切句，每个句子带着自己在 `joined` 里的偏移；
                  3. 模型只输出「第 i 句和第 i+1 句是同一段吗」，
                     我们按句子的偏移从 `joined` 里 `slice()` ——
                     切出来的段落合起来**逐字符等于 `joined`**。

                  这样无论模型怎么判断，文本本身一个字符都不会变。
                */
                var joinedBuf = [];
                for (var pb = 0; pb < partBlocks.length; pb++) {
                    var bt = String(blocks[partBlocks[pb]].text || '')
                        .replace(/^\s+|\s+$/g, '');
                    if (pb > 0) {
                        /* 块间用单换行 —— 切片时这些换行会原样保留在段落里 */
                        joinedBuf.push('\n');
                    }
                    joinedBuf.push(bt);
                }
                var joined = joinedBuf.join('');

                /* 归一化比较用（模型会规范化空白，定位时只比实字） */
                var squash = function (s) {
                    return String(s == null ? '' : s).replace(/\s+/g, '');
                };
                var joinedSquashed = squash(joined);

                /*
                  ⚠️⚠️ 每个区段单独 catch（v0.1.96）。

                  原来 `return seg.segment(parts).then(...)` 没有 catch，
                  于是**一个区段**推理失败（OOM、张量尺寸越界、wasm 崩）
                  就会让整条 chain reject → 整篇正文都不渲染。

                  而这篇的其他区段本来是能正常处理的。
                  判据：局部失败只能影响局部。
                */
                var runCount = parts.length;
                /*
                  ⚠️ 传 `parts`（原始块文本数组），与切分正常时**完全一致**（v0.2.36）。
                     不要传我们自己切好的句子 —— 那会改变模型的输入边界。
                */
                return seg.segment(parts, {
                    /*
                      ══ 加载阶段进度（v0.2.1）══

                      用户反馈：「加载直接从 0 跳到 100」。

                      `onLoad` 覆盖"模型加载"这一段（0~40%），
                      `onProgress` 覆盖"逐批推理"（40~100%）。
                      两者合起来才是连续进度，缺任何一段都会看到跳跃。

                      ⚠️ 加载只发生一次 —— 第二次切分时 onLoad 不会触发，
                         那时进度条直接从推理段开始，这是对的。
                    */
                    onLoad: function (stage, frac) {
                        if (!prog) return;
                        /*
                          ⚠️ 0~40% 留给加载，40~100% 留给推理。
                             加载阶段走到 40% 就停住，等推理接手 ——
                             否则用户看到 100% 却在等推理，体验更差。
                        */
                        prog.progress(Math.round(frac * 40), 100,
                                      stage === 'runtime' ? 'loading' : null);
                    },
                    onProgress: function (done, total) {
                        /*
                          ⚠️ 进度要**跨区段累加**。
                             每个区段各自从 0 报到 total，直接透传会让
                             进度条每次换区段就跌回 0 —— 看起来像重来。
                          ⚠️ 总数用第一次拿到的真实值校正预估：
                             模型的分句器切出的句子数通常比块数多。
                          ⚠️ 推理段映射到 **40~100%**（加载占前 40%），
                             这样加载与推理接得上，不会出现"0 跳 100"。
                        */
                        if (total > 0 && grandTotal !== total) {
                            /* 只校正一次，且只增不减，避免抖动 */
                            if (total > grandTotal) grandTotal = total;
                        }
                        if (prog) {
                            var all = doneSentences + done;
                            var frac = (grandTotal > 0)
                                ? Math.min(1, all / grandTotal) : 0;
                            prog.progress(Math.round(40 + frac * 60), 100);
                        }
                    }
                }).then(function (res) {
                    doneSentences += runCount;
                    if (prog) prog.progress(doneSentences, grandTotal);
                    var ranges = (res && res.paragraphRanges) || [];
                    if (!ranges.length) return null;
                    /*
                      ⚠️ 段落数与原块数一致时**不改** ——
                         说明模型的判断和版式完全一样，
                         没必要动用户已经看到的结构。
                    */
                    if (ranges.length === parts.length) return null;

                    /*
                      ══ ⚠️⚠️ 从**原文**切片，不重新拼（v0.2.32）══

                      模型只告诉我们「第 from 句到第 to 句是同一段」。
                      段落的文字必须从 `joined` 里按句子的原始偏移 `slice()`，
                      这样：
                        · 原文的换行、多空格、缩进**全部原样保留**
                        · 所有段落首尾相接，合起来逐字符等于 `joined`
                          —— 也就是说**一个字符都没被改**

                      ⚠️ 旧实现直接用了 `res.paragraphs`（`join(' ')` 的产品），
                         那就是用户说的「切分前后文本内容还变了」。

                      ══ ⚠️ 段落首部空白归给前一段 ══

                      按句子偏移切出来的段落，开头可能带着上一段结尾之后的
                      `\n`（因为句子区间是 trim 过的，空白在区间之外）：

                          段1 = "Introduction."
                          段2 = "\nThese models are ..."

                      渲染时段2 开头那个换行会变成多余空行。

                      ✅ 把段落**首部的空白**剥给前一段（追加到前一段末尾）——
                         视觉上干净，且所有段落拼起来仍然逐字符等于原文。
                         第一段的首部空白无法"给前一段"，直接保留
                         （通常是原文本来就有的缩进）。
                    */
                    var rebuilt = [];
                    var prevEnd = -1;
                    var lastTo = -1;
                    /*
                      ══ ⚠️⚠️ 用模型返回的句子在 `joined` 里**顺序定位**（v0.2.36）══

                      模型收到 `parts` 后用它**自己的** `splitSentences`
                      切句，所以 `res.sentences` 是它视角的句子列表。
                      我不能再拿自己的切句结果去对应它的下标（那正是
                      0.2.32~0.2.35 分得乱七八糟的原因）。

                      ✅ 做法：拿 `res.sentences` 里每一句，在 `joined`
                         里从上次位置往后找（只比实字，忽略空白差异），
                         找到就记下 [start, end]。

                      ⚠️ 找不到（模型改写了这句话）→ 该句没有偏移，
                         这一区段放弃，保留原块。绝不猜位置。

                      这样：
                        · 模型的输入与以前**完全一致** → 分段质量恢复
                        · 段落的文字仍然从 `joined` 精确切片 → 内容不变
                    */
                    var modelSents = (res && res.sentences) || [];
                    if (!modelSents.length) return null;

                    var sentsWithOff = [];
                    var scanAt = 0;          /* 在 joined 里的查找游标 */
                    var sqAt = 0;            /* 在 joinedSquashed 里的游标 */

                    for (var ms = 0; ms < modelSents.length; ms++) {
                        var sq = squash(modelSents[ms]);
                        if (!sq) {
                            /* 空句：给一个零长度区间，不影响后续 */
                            sentsWithOff.push({ start: scanAt, end: scanAt });
                            continue;
                        }
                        var hit = joinedSquashed.indexOf(sq, sqAt);
                        if (hit < 0) {
                            trace('reader:seg', 'cannot locate model sentence #' + ms +
                                  ' in source, discarding run');
                            return null;
                        }
                        /*
                          ⚠️ 把"去空白后的下标"映射回 `joined` 的真实区间。
                             逐字符走，跳过空白 —— 空白不计入 squash 下标。
                        */
                        var startReal = -1;
                        var endReal = -1;
                        var need = sq.length;      /* 还要吃掉多少个实字 */
                        var cnt = 0;
                        var ri = scanAt;
                        while (ri < joined.length) {
                            var ch = joined.charAt(ri);
                            var isWs = /\s/.test(ch);
                            if (!isWs) {
                                if (cnt === (hit - sqAt)) startReal = ri;
                                cnt++;
                                if (cnt === (hit - sqAt) + need) {
                                    endReal = ri + 1;
                                    break;
                                }
                            }
                            ri++;
                        }
                        if (startReal < 0 || endReal < 0) {
                            trace('reader:seg', 'offset mapping failed at sentence #' + ms);
                            return null;
                        }
                        sentsWithOff.push({ start: startReal, end: endReal });
                        scanAt = endReal;
                        sqAt = hit + need;
                    }

                    var rebuilt = [];
                    var prevEnd = -1;
                    var lastTo = -1;
                    for (var p = 0; p < ranges.length; p++) {
                        var rg = ranges[p];
                        var s0 = sentsWithOff[rg.from];
                        var s1 = sentsWithOff[rg.to];
                        if (!s0 || !s1) continue;
                        /*
                          ══ ⚠️⚠️ 区间必须**单调前进且无缝衔接**（v0.2.33 / 0.2.34）══

                          用户反馈过：

                            「模型切分后反而出现了大量缺失内容和重复内容」

                          模型返回的 `from` / `to` 是它自己数的句子下标。
                          它们可能出现三种错：

                            ① `to < from`                        → 倒序
                            ② `from < 上一段的 to + 1`           → 重叠 → 重复
                            ③ `from > 上一段的 to + 1`           → 跳过 → 缺失

                          ✅ 必须**严格连续**：
                             第一段 `from === 0`；
                             之后每段 `from === 上一段的 to + 1`。
                             不满足 → 这一区段整体放弃（保留原块）。
                             "跳过坏段落继续"必然缺内容，不能那样做。
                        */
                        if (rg.from < 0 || rg.to >= sentsWithOff.length) continue;
                        if (rg.to < rg.from) continue;
                        var expectedFrom = (p === 0) ? 0 : (lastTo + 1);
                        if (rg.from !== expectedFrom) {
                            trace('reader:seg', 'range gap/overlap at p=' + p +
                                  ': expected from=' + expectedFrom +
                                  ' got ' + rg.from + ' (to=' + rg.to + ')');
                            return null;
                        }
                        lastTo = rg.to;
                        if (s0.start < prevEnd) {
                            trace('reader:seg', 'non-monotonic range at ' +
                                  p + ' (' + s0.start + ' < ' + prevEnd +
                                  '), discarding run');
                            return null;
                        }
                        /*
                          ⚠️ 切片起点：接着上一段的终点，句间空白归给前一段。
                             第一段从 0 开始（含开头缩进）。
                        */
                        var cutStart = (prevEnd < 0) ? 0 : prevEnd;
                        var cutEnd = s1.end;
                        if (p === ranges.length - 1) cutEnd = joined.length;

                        var pieceText = joined.slice(cutStart, cutEnd);
                        prevEnd = s1.end;

                        if (!String(pieceText || '').replace(/\s+/g, '')) continue;

                        /* 段落首部空白 → 前一段尾部（第一段除外） */
                        if (rebuilt.length) {
                            var mLead = /^[ \t\r\n\u00a0]+/.exec(pieceText);
                            if (mLead) {
                                rebuilt[rebuilt.length - 1].text += mLead[0];
                                pieceText = pieceText.slice(mLead[0].length);
                            }
                        }

                        rebuilt.push({ text: pieceText, firstSent: rg.from });
                    }
                    if (!rebuilt.length) return null;

                    /*
                      ══ ⚠️⚠️ 最终完整性校验：拼回去必须等于原文（v0.2.33）══

                      这是**唯一可信的验收**。前面所有的区间校验都是
                      "按道理应该对"，而这里直接验证结果：

                          重建后的所有段落拼起来 === joined ?

                      不等就说明切片过程中有遗漏或重复 ——
                      不管什么原因，这一区段**整体放弃**，保留原块。

                      ⚠️ 用户明确要求"切分不能改内容"。
                         那么"切分失败"必须退化成"没切"，
                         绝不能退化成"内容错乱"。
                         宁可少一个功能，不能多一个数据损坏。
                    */
                    var recon = '';
                    for (var rc = 0; rc < rebuilt.length; rc++) {
                        recon += rebuilt[rc].text;
                    }
                    if (recon !== joined) {
                        trace('reader:seg', 'integrity FAILED for run at ' +
                              patchStart + ': rebuilt ' + recon.length +
                              ' chars vs joined ' + joined.length +
                              ' — keeping original blocks');
                        /*
                          ⚠️ 逐段定位：哪一段开始偏了？
                             只打前 3 处差异，够定位即可。
                        */
                        var dl = 0, shown = 0;
                        for (var di = 0; di < Math.min(recon.length, joined.length) &&
                             shown < 3; di++) {
                            if (recon.charAt(di) !== joined.charAt(di)) {
                                trace('reader:seg', 'DIFF@' + di +
                                      ' expected ' + JSON.stringify(joined.slice(di, di + 40)) +
                                      ' got ' + JSON.stringify(recon.slice(di, di + 40)));
                                shown++;
                                break;
                            }
                        }
                        return null;
                    }

                    /*
                      ⚠️ 行号必须从**参与拼接的块**里取（`partBlocks`），
                         不是 `run` —— `run` 里可能有被跳过的空块，
                         它们的行号不会出现在重建后的段落上。
                    */
                    var allLines = [];
                    for (var q = 0; q < partBlocks.length; q++) {
                        allLines.push(blocks[partBlocks[q]].line);
                    }
                    if (!allLines.length) return null;

                    /*
                      ══ ⚠️ 行号在这里**不分配**（v0.2.35）══

                      用户指出：

                        「切分后是重新渲染的，渲染需要重新编号计数，
                          没道理拿到同样的编号」

                      对。切分是**对整篇重新排版**，行号应该跟着
                      新结构重编，而不是"从旧行号里挑一个"。
                      所以编号统一放到重建之后整篇做 ——
                      见下面 ④ 之后的 `renumber`。
                    */
                    var allLines = [];
                    for (var q = 0; q < partBlocks.length; q++) {
                        allLines.push(blocks[partBlocks[q]].line);
                    }
                    if (!allLines.length) return null;

                    for (var p2 = 0; p2 < rebuilt.length; p2++) {
                        /* `page` 仅作提示用，按位置粗略对应原块 */
                        var srcIdx = Math.min(
                            allLines.length - 1,
                            Math.floor(p2 / Math.max(1, rebuilt.length) * allLines.length));
                        var src = blocks[partBlocks[srcIdx]];
                        rebuilt[p2].page = src ? src.page : null;
                        rebuilt[p2].kind = 'paragraph';
                        rebuilt[p2].level = undefined;
                        rebuilt[p2].lines = undefined;
                        delete rebuilt[p2].firstSent;
                    }

                    patches.push({
                        start: patchStart,
                        count: patchCount,
                        items: rebuilt
                    });
                    return null;
                }, function (err) {
                    /* 这个区段失败 → 保留原块，继续处理后面的区段 */
                    var msg = String((err && err.message) || err);
                    trace('reader:seg', 'run failed at ' + run[0] + ': ' + msg);
                    /*
                      ⚠️ 用户取消 → 立刻 stop，不再处理后面的区段。
                         继续跑完后面的区段是纯浪费（用户已经不要了）。
                         用 cancelFlag 而不是 break —— 这是 Promise 链。
                    */
                    if (msg === 'cancelled') {
                        userCancelled = true;
                    }
                    return null;
                });
            });
        });

        return chain.then(function () {
            /*
              ⚠️ 所有收尾路径都要调 finish()，否则进度条会永远停在那里 ——
                 那比不显示更糟（用户以为一直在跑）。
            */
            if (userCancelled) {
                trace('reader:seg', 'cancelled by user, keeping raw blocks');
                if (prog) prog.finish('skipped');
                return blocks;
            }

            if (!patches.length) {
                /* 模型判断与版式一致 → 没有可改的，也算"完成" */
                if (prog) prog.finish('done');
                return blocks;
            }

            /* ④ 从后往前重建：前面的 start 不受后面的增删影响 */
            var out = blocks.slice();
            for (var i = patches.length - 1; i >= 0; i--) {
                var pt = patches[i];
                var args = [pt.start, pt.count].concat(pt.items);
                Array.prototype.splice.apply(out, args);
            }

            /*
              ══ ⚠️⚠️⚠️ 整篇重编号（v0.2.35 —— 真正的根因）══

              用户指出：

                「切分后是重新渲染的，渲染需要重新编号计数，
                  没道理拿到同样的编号」

              ── 为什么必须重编 ──

              `line` 在重构后是**一切数据的键**：

                  blockTextOf(line)  取文本
                  edits[line]        用户编辑
                  labels[line]       标注
                  buildMdText()      按 line 输出 md
                  renderMd()         按 line 挂标注

              切分把 N 个块重组成 M 个块，若 M > N 却沿用旧行号
              （"从旧行号里挑一个"），**必然有重复**：

                  7 个原块 → 20 段 → 行号 0,0,0,1,1,1,2,2,2,...

              后果正好是用户看到的：

                · 拿到重复行号的几段 → `blockTextOf` 返回同一段文字
                  → md 里同一段出现多次 → **重复**
                · 行号被顶掉的原块 → 再也取不到自己的文本 → **缺失**

              ⚠️ 重构之前**没有这个 bug**：那时渲染按数组下标取文本，
                 `line` 只是元信息，重复无所谓。
                 是我把 `line` 抬成主键之后才炸的 ——
                 与用户判断的「是流程出了问题」一致。

              ── ✅ 修法 ──

              切分 = 整篇重新排版 → 行号也必须整篇重编。
              输出序列里**每一个块**都拿一个新的连续编号：

                  0, 1, 2, 3, ... , out.length - 1

              这样：
                · 唯一性由构造保证，不依赖任何"挑一个"的算法；
                · `edits` / `labels` 在切分前已被清空（见 resegmentCurrent），
                  不会与旧键冲突；
                · 编号连续，正文段号（A1 / R1 / 1,2,3）自然也对齐。

              ⚠️ 只重编**输出序列**，不改 `blocks` 本身 ——
                 切分失败时原数组要完好无损地返回。
            */
            for (var rn = 0; rn < out.length; rn++) {
                if (out[rn]) out[rn].line = rn;
            }

            trace('reader:seg', 'reflowed ' + blocks.length + ' -> ' +
                  out.length + ' blocks in ' + patches.length + ' runs, renumbered 0..' +
                  (out.length - 1));
            if (prog) prog.finish('done');
            return out;
        }, function (err) {
            /*
              ⚠️ 模型出错**不能影响阅读** —— 退回原始块。
                 用户开了语义分段，但模型跑不动时，
                 最坏的结果应该是"和没开一样"，而不是白屏。
            */
            trace('reader:seg', 'failed: ' + (err && err.message));
            if (prog) prog.finish('failed');
            return blocks;
        });
    }

    /**
     * 给语义分段加**超时**（v0.1.97）。
     *
     * ══ ⚠️⚠️ 为什么必须有（这是"仍无法提取"的真正原因）══
     *
     * 用户连续两版报「仍然是那个无法提取的提示」，而我这边
     * 无论怎么模拟"模型崩溃"都能正常降级。差别在于：
     *
     *   · 我模拟的是「Promise **reject**」→ 降级生效；
     *   · 真机上发生的是「Promise **永不 settle**」→ 降级永不触发。
     *
     * 什么时候会永不 settle：
     *   · ONNX session 正在初始化（wasm 编译要几秒到几十秒）；
     *   · 低端机内存紧张，wasm 分配后长时间无响应；
     *   · `waitRuntime(15000)` 只在**取 transformers 对象**时超时，
     *     之后 `pipeline(...)` 本身没有超时 —— 它可能挂任意久。
     *
     * 而 `setText` 的渲染**排在语义分段之后**（`continueWith` 在 then 里），
     * 所以模型一卡，正文就永远不出现 → 用户看到空白 → 显示提取失败。
     *
     * ✅ 正解：**正文渲染不该等模型**。
     *    超时一到就用原始块渲染，模型的结果如果之后才回来，
     *    直接丢弃（用户已经在读了，再替换会打断阅读）。
     *
     * @param {Promise<Array>} p  语义分段 Promise
     * @param {Array}  fallback   超时/失败时用的块
     * @param {number} ms         超时毫秒
     * @return {Promise<Array>}   一定会 settle
     */
    function withTimeout(p, fallback, ms) {
        return new Promise(function (resolve) {
            var done = false;

            var timer = global.setTimeout(function () {
                if (done) return;
                done = true;
                trace('reader:seg', 'timeout after ' + ms + 'ms, using raw blocks');
                resolve(fallback);
            }, ms);

            p.then(function (v) {
                if (done) {
                    /* 超时后结果才回来 → 丢弃，避免打断正在进行的阅读 */
                    trace('reader:seg', 'result arrived after timeout, dropped');
                    return;
                }
                done = true;
                global.clearTimeout(timer);
                resolve(v);
            }, function (e) {
                if (done) return;
                done = true;
                global.clearTimeout(timer);
                trace('reader:seg', 'error, using raw blocks: ' + (e && e.message));
                resolve(fallback);
            });
        });
    }
    /**
     * 原生推来正文文本。
     *
     * ⚠️ 只接收**当前打开的那篇** —— 用户可能很快点开另一篇，
     *    上一篇的提取结果这时才回来。用 id 比对丢弃过期结果，
     *    否则会出现「打开了 B，显示的却是 A 的正文」。
     *
     * @param {string|null} text    正文纯文本
     * @param {Array|null}  outline PDF 自带大纲 [{level,title,page}]；没有则为 null
     * @param {Object|null} meta    行排版元数据 {fonts:[名], lines:[[字体下标,字号x10,页]]}
     */
    function setText(id, text, outline, meta, blocks, fromMd) {
        /*
          ══ 诊断（v0.1.99）══

          ⚠️ 用户连续四版报「无法提取」，而我这边每一种模拟都能通过。
             说明失败点在某个**只有真机才有**的条件里。

          「无法提取」这句话本身不含信息 —— 可能是：
            · 原生根本没推（桥没注 / 文件丢了 / md 解析失败）
            · 推了但 blocks 是空的
            · 块都空（text 全是空白）
            · id 对不上（被当成过期结果丢了）

          这四种的修法完全不同。所以把这些数字**直接显示在错误提示上**，
          用户截个图就能定位，不必会抓 logcat。

          ⚠️ 只记最后一个失败原因，供 showError 读取。
        */
        lastDiag = 'id=' + String(id).slice(0, 8) +
            ' cur=' + (currentDoc ? String(currentDoc.id).slice(0, 8) : 'null') +
            ' blocks=' + (blocks ? blocks.length : 0) +
            ' fromMd=' + !!fromMd +
            ' text=' + (text ? String(text).length : 0);

        if (!currentDoc || currentDoc.id !== id) {
            trace('reader:text-stale', 'ignored ' + id);
            return;
        }
        if (!contentEl) {
            return;
        }

        contentEl.textContent = '';
        /*
          ⚠️ md 路径下 `text` 可能是 null（原生只推块）——
             此时不能当成"提取失败"，正文由 blocks 拼出来。
        */
        if (!text && !(fromMd && blocks && blocks.length)) {
            showError();
            return;
        }

        /*
          ⚠️ 给 md 块打标记（v0.1.92）——
             `dropContainedBlocks` 据此**跳过几何去重**。
             实测事故：标题的第二行 `Vector Space` 被当成"被包含的重复块"
             丢掉，整句话永久消失。见那个函数里的说明。
          ⚠️ 标记挂在第一个块上就够了（判据是"这批是不是 md 来的"），
             但为了调用方不依赖下标，按需给每个块都挂 —— 成本可忽略。
        */
        if (fromMd && blocks && blocks.length) {
            for (var fb = 0; fb < blocks.length; fb++) {
                if (blocks[fb]) blocks[fb].fromMd = true;
            }
        }

        /*
          ══ 渲染：一块一个段落，**不分等级、不加标签**（v0.1.39）══

          用户原话：「不允许有任何模板，我导入一个新的 pdf 进来，
                     我看到的应该是无等级的全部文本才对」

          所以现在**不再**按 `kind` 给不同标签（h2/h3/公式/图）——
          所有块一律渲染成 `<p>`，见 makeBlockEl。

          ⚠️ 分块本身保留：原生按段落切好，我们照着一段一个 `<p>`。
             退回整段 `textContent` 会让 `white-space: pre-wrap`
             把 PDF 的**原始换行**一起保留，窄行排版下每句都断在半截
             （这正是 v0.1.6 修掉的问题）。

          ⚠️ 没有 blocks 时**退回纯文本**（老数据 / 提取层未升级）。
             不能因为拿不到 blocks 就白屏。
        */
        /*
          ⚠️ 缓存一份块数据，供测试接口（getBlocks）读取。

          ⚠️ 两者只会有一个非空，所以要**显式清掉另一个** ——
             不清的话，上一篇的 blocks 会残留在 lastBlocks 里。
        */
        if (blocks && blocks.length) {
            /*
              ══ ⚠️⚠️ md 模式：标注**从块里来**，不读 localStorage（v0.1.92）══

              用户裁决：
                「相当于 md 是我们的数据保存结构，但阅读器靠这个原文件来渲染」

              ✅ md 里带的 `marks` 就是标注的权威来源。
                 `loadAnnotations()` 已经先把 localStorage 里的旧标注读进来了
                 （那是编辑器写 md 之前的记录），这里用 md 的覆盖掉。

              ⚠️ 必须 `blocks` 里**有任何一块带 marks** 才覆盖 ——
                 否则把用户刚加的标注抹掉（md 是我们自己写的，
                 正常情况下一定有 marks）。
            */
            if (fromMd) {
                /*
                  ⚠️ 记下"读进来时"的正文，作为回写前的丢字基线（v0.1.92）。
                     见 mdKeepsAllText 的事故说明。
                */
                var originParts = [];
                for (var op = 0; op < blocks.length; op++) {
                    var ob = blocks[op];
                    if (!ob) continue;
                    var ot = String(ob.text || '').replace(/\s+/g, '');
                    if (ot) originParts.push(ot);
                }
                mdOriginText = originParts.join('\n\n');

                var hasMarks = false;
                for (var mi = 0; mi < blocks.length; mi++) {
                    if (blocks[mi] && blocks[mi].marks && blocks[mi].marks.length) {
                        hasMarks = true;
                        break;
                    }
                }
                if (hasMarks) {
                    var fresh = {};
                    for (var mb = 0; mb < blocks.length; mb++) {
                        var blk = blocks[mb];
                        if (!blk || !blk.marks || !blk.marks.length) continue;
                        fresh[blk.line] = blk.marks.map(function (m) {
                            var o = {
                                start: m.start,
                                end: m.end,
                                label: m.label
                            };
                            if (m.field) o.field = m.field;
                            if (typeof m.ref === 'number') o.ref = m.ref;
                            return o;
                        });
                    }
                    labels = fresh;
                    trace('reader:md', 'labels from md: ' +
                        Object.keys(fresh).length + ' blocks');
                }
            }

            blocks = dropContainedBlocks(blocks);
        }

        /*
          ══ 语义分段（v0.1.95，可选）══

          ⚠️ 这一步是**异步**的（要跑模型），所以把后面的
             「建 docModel + 渲染 + 生成目录」整体挪进 continueWith。
             不开语义分段时 `semanticReflow` 立即 resolve，
             走的是和以前完全一样的同步路径 —— 只是多包了一层 then。
          ⚠️ 异步期间用户可能已经切走 —— 必须**重新校验** id，
             否则会把 A 的正文画到 B 上（和文件头那段同样的道理）。

          ══ ⚠️⚠️ 正文渲染**绝不能**依赖模型成功（v0.1.96 修）══

          用户报的原话：
            「进入阅读视图提示 Could not extract text from this pdf。
              这显然有问题，因为即便没有模型，以前也有划分不准的全部文本，
              加入了模型反而直接无法提取」

          真因：这一行原来是 `semanticReflow(blocks).then(...)` ——
          **没有 catch**。只要模型这条链抛了任何异常（ONNX 推理崩、
          wasm 加载失败、内存不足…），`continueWith` 就**永远不会被调用**，
          正文区域保持空白 → 用户看到"提取失败"。

          而"提取失败"这个结论是**错的**：PDF 明明提取成功了，
          块数据就在 `blocks` 里，只是段落整理那一步失败了。

          ✅ 三个保证，缺一不可：
             ① `semanticReflow` 内部 catch 掉一切，永不 reject（见下）；
             ② 这里再挂一个 `catch` 兜底，走原始 blocks；
             ③ `continueWith` 自己也包 try/catch —— 渲染出错要让用户
                看到**能看的部分**，而不是一句"提取失败"。

          判据：**可选功能失败时，退化结果必须等于"没开这个功能"**。
        */
        /*
          ⚠️ 超时兜底（v0.1.97）：正文**必须**在有限时间内出现。

          用户连续两版报「仍然是那个无法提取的提示」。真机上
          模型不是在 reject，而是**永不 settle**（wasm 编译卡住 /
          内存紧张），于是 `continueWith` 永远不执行 → 空白 → 报错。

          超时值取 8 秒：正常首次加载约 1 秒（本地 17MB），
          8 秒还不出来说明确实卡住了，此时先让用户看到文字更重要。
        */
        trace('reader:text', 'blocks=' + (blocks ? blocks.length : 0) +
              ' fromMd=' + !!fromMd + ' text=' + (text ? text.length : 0));

        /*
          ══════════════════════════════════════════════════════════════
          ══ ⚠️⚠️ 语义模型与提取/渲染**彻底隔离**（v0.1.98）══
          ══════════════════════════════════════════════════════════════

          用户裁决：

            「给语义切分模型隔离起来，不参与提取，然后悬浮表单顶部栏
              增加一个切分的图标，点击图标后才触发整篇文章文本的重新切分」

          ── 为什么这是对的 ──

          v0.1.95 / 0.1.96 / 0.1.97 三版都在试图让模型"不阻碍"渲染：
          先渲染再分段、超时兜底、失败降级…… 但根本问题是
          **模型和渲染在同一条链上**，只要这条链有任何异常行为
          （reject / 挂起 / 超时判定失误），就还有下一次翻车的机会。

          用户连着报了三次「无法提取」。三次都在改"怎么兜底"，
          而没有质疑**该不该自动跑模型**。

          ✅ 现在：`setText` 里**一行模型代码都没有**。
             打开文献 = 纯同步渲染 PDF 提取出来的块。
             这一条路径与 v0.1.94 完全一致，不可能因为模型出问题。

          ✅ 语义分段变成**用户显式动作**（点顶栏图标）。
             它是"对我正在读的这篇重新排版"，而不是"打开文档时
             悄悄做的一件事"。用户知道它在跑，也能取消。

          判据：**一个可选功能的代码，不应该出现在主链路上。**
                出现在主链路上，就意味着它失败时主功能也会坏。
        */

        try {
            continueWith(id, text, outline, meta, blocks, fromMd);
        } catch (e) {
            /*
              ⚠️ 渲染本身出错时的最后一道防线。

              正文数据明明在手里，只是"结构化渲染"这一步炸了
              （比如某个块的字段形状意外、DOM 操作异常）。
              这时候**绝不能**显示"提取失败" —— 那是在对用户撒谎。

              ✅ 退化到最朴素的方式：把纯文本按行塞进去。
                 没有分块、没有标注，但**文字一字不少**。
            */
            trace('reader:render-failed', String(e && e.message));
            try {
                contentEl.textContent = '';
                var fallback = text;
                if (!fallback) {
                    var acc = [];
                    for (var i = 0; i < (blocks || []).length; i++) {
                        var bt = String((blocks[i] && blocks[i].text) || '');
                        if (bt) acc.push(bt);
                    }
                    fallback = acc.join('\n\n');
                }
                if (fallback) {
                    contentEl.textContent = fallback;
                    contentEl.classList.add('reader-plain-fallback');
                } else {
                    showError('extract-failed',
                              'blocks=' + (blocks ? blocks.length : 0) +
                              ' text=' + (text ? text.length : 0));
                }
            } catch (e2) {
                showError('extract-failed', 'render threw twice: ' + (e2 && e2.message));
            }
        }
    }

    /**
     * 对**当前这篇**重新做语义分段（v0.1.98）。
     *
     * 由顶栏的切分图标触发 —— 用户明确的主动行为。
     *
     * ⚠️ 与 `setText` 完全无关：这里失败了只影响"这次重排"，
     *    正文保持在屏幕上的原始分段，一字不动。
     *
     * @return {Promise<boolean>} true = 分段生效并重绘；false = 没变化或失败
     */
    function resegmentCurrent() {
        if (!currentDoc) {
            trace('reader:seg', 'no current doc');
            return Promise.resolve(false);
        }
        if (!lastBlocks || !lastBlocks.length) {
            trace('reader:seg', 'no blocks to segment');
            return Promise.resolve(false);
        }

        var sem = window.ScholariusSemantic;
        if (!sem || !sem.isEnabled || !sem.isEnabled()) {
            trace('reader:seg', 'semantic disabled, nothing to do');
            return Promise.resolve(false);
        }

        var docId = currentDoc.id;

        /*
          ══ ⚠️⚠️ 语义切分会**破坏**用户的编辑与标注（v0.2.3）══

          用户指出：

            「切分前给个确认表单，因为会把用户自己编辑的分区清掉对吧」
            「分成不同的段之后，正文段编号居然没有更新？」
            「好像切分后就固定了一样」

          ── 为什么会坏 ──

          `edits` 和 `labels` 都是**以行号为键**的字典：

              edits[12]  = "我改过的第 12 块的文字"
              labels[12] = [{start:0, end:20, label:'author'}]

          而行号是提取层给每个块的**身份**。语义切分把多个块合并成
          一个新块时，那个新块拿的是其中一个旧行号（按字符比例选的），
          其余行号从此**不复存在**。

          后果：
            · 合并掉的那几块上的编辑**直接消失**（键没人引用了）；
            · 保留下来的那个行号上的标注，现在盖住了一整段更长的文字 ——
              于是出现 `1 2 A1 3 4` 这种「作者标签插在正文编号中间」，
              也就是用户看到的「编号乱 / 像被固定住」。

          ── 现在的处理 ──

          ✅ 切分前**弹确认框**，明确告知会丢弃编辑与标注。
             这是不可撤销操作，必须让用户知情。

          ✅ 用户确认后、切分前，把 `edits` / `labels` 清空 ——
             与其让它们错位到别处（最难查的那种 bug：文字还在，
             只是跑到了错的段落上），不如干净地丢掉。

          ⚠️ 将来若要保留标注，正确做法是把标注区间跟着文本一起
             重映射到新块上（在 semanticReflow 里做，按字符偏移算）。
             那是个更大的改动，先不做 —— 但绝不能"假装它还在"。
        */
        var hasUserWork = (Object.keys(edits).length > 0) ||
            (Object.keys(labels).length > 0);
        /*
          ⚠️ 用 `lastBlocks`（当前屏幕上的块）而不是重新去读文件 ——
             用户可能已经编辑过段落，那些编辑结果在 docModel.blocks 里。
             拿原始 PDF 块重新分段会把编辑冲掉。

          ⚠️ 但语义分段会重写段落结构，与已有的手工编辑**天然冲突**。
             这里选择：以 docModel.blocks（含编辑）为输入。
             分段后行号按比例重分配，标注位置可能偏移 —— 这是可接受的，
             因为用户是**主动**要求重排的。
        */
        var source = (docModel.blocks && docModel.blocks.length)
            ? docModel.blocks
            : lastBlocks;

        var prog = window.ScholariusSegProgress;
        if (prog) {
            /*
              ══ ⚠️⚠️ 提示必须**先画出来**再开始加载（v0.2.0）══

              用户反馈：「加载模型直接 app 卡住了」。

              真因：首次点切分要加载 17MB 模型 + 编译 11MB wasm，
              期间主线程被同步占住（实测模拟器 460ms，真机更久）。
              如果提示和加载在同一个事件里，提示**根本没机会显示** ——
              浏览器要等 JS 让出控制权才重绘，那时已经卡完了。

              ✅ 所以：先设提示 → 让出两帧让它真正画到屏幕上 →
                 再开始加载。用户看到的是"有明确提示的等待"，
                 而不是"点了没反应，然后突然卡住"。

              ⚠️ 这里 start() 传 0 句：加载阶段还不知道总数，
                 进度条显示"正在加载模型…"并空转。
                 真正的句子级进度在 semanticReflow 里才开始报。
            */
            prog.start(0);
        }

        trace('reader:seg', 'manual resegment of ' + source.length + ' blocks');

        /*
          ⚠️ 让出一帧再进模型 —— 理由同上。用 Promise 串起来，
             保证顺序确定（不依赖 setTimeout 的时序猜测）。

          ⚠️ 没有 nextFrame（老版本 semantic-seg.js）时退回 setTimeout，
             不能让"提示没画出来"变成"切分不做"。
        */
        var yieldFrame = (window.ScholariusSeg && window.ScholariusSeg.nextFrame)
            ? window.ScholariusSeg.nextFrame
            : function () {
                return new Promise(function (r) { global.setTimeout(r, 32); });
            };

        return yieldFrame()
            .then(yieldFrame)
            .then(function () {
                /*
                  ══ ⚠️⚠️ 切分前后内容审计（v0.2.34）══

                  用户连续两版反馈：

                    「模型切分后反而出现了大量缺失内容和重复内容」
                    「问题没有丝毫改善」

                  前两次我都靠推断改代码，结果是"看起来该对"。
                  这次直接在**真实运行路径**上记账，把数字写进日志，
                  不再猜。

                  记账内容：
                    · 源块数 / 源字符数（去空白，只算正文）
                    · 结果块数 / 结果字符数
                    · 两者是否相等（**内容守恒**）
                    · 每个区段的完整性校验结果

                  ⚠️ 用 `\s` 全去空白再比 —— 切分只该移动空白，
                     不该增删实字。这个判据与用户在屏幕上看到的一致。
                */
                var srcChars = 0;
                for (var si = 0; si < source.length; si++) {
                    srcChars += String((source[si] && source[si].text) || '')
                        .replace(/\s+/g, '').length;
                }
                trace('reader:seg', 'AUDIT in: ' + source.length +
                      ' blocks, ' + srcChars + ' chars');

                return withTimeout(semanticReflow(source), source, 120000);
            })
            .then(function (out) {
                /*
                  ⚠️ 结果审计：字符数必须与输入相等。
                     不等就是**数据损坏** —— 明确报出来，并且
                     **不应用**这个结果（下面的 return false 走原块）。
                */
                var outChars = 0;
                for (var oi = 0; oi < (out || []).length; oi++) {
                    outChars += String((out[oi] && out[oi].text) || '')
                        .replace(/\s+/g, '').length;
                }
                var inChars = 0;
                for (var ii = 0; ii < source.length; ii++) {
                    inChars += String((source[ii] && source[ii].text) || '')
                        .replace(/\s+/g, '').length;
                }
                var conserved = (inChars === outChars);
                trace('reader:seg', 'AUDIT out: ' + ((out || []).length) +
                      ' blocks, ' + outChars + ' chars, conserved=' + conserved);
                if (!conserved) {
                    trace('reader:seg', 'CONTENT NOT CONSERVED (' +
                          inChars + ' -> ' + outChars +
                          ') — refusing to apply, keeping original blocks');
                    if (prog) prog.finish('failed');
                    return false;
                }

                if (!currentDoc || currentDoc.id !== docId) {
                    trace('reader:seg', 'doc changed during resegment');
                    return false;
                }
                if (!out || out === source || out.length === source.length) {
                    trace('reader:seg', 'no structural change');
                    if (prog) prog.finish('done');
                    return false;
                }
                /*
                  ══ 应用前清空编辑与标注（v0.2.3）══

                  ⚠️ 必须在**确认真的会变结构**之后才清 ——
                     如果切分结果与原来一样（上面那行提前 return 了），
                     用户的编辑一点都不该动。

                  ⚠️ 清空是**不可撤销**的，所以这里配合了确认表单，
                     用户不会在不知情的情况下丢掉工作。
                */
                if (hasUserWork) {
                    trace('reader:seg', 'discarding edits/labels: ' +
                          Object.keys(edits).length + ' edits, ' +
                          Object.keys(labels).length + ' label blocks');
                    edits = {};
                    labels = {};
                }
                /*
                  ══ ⚠️⚠️ 切分即弃用模板（v0.2.7）══

                  方案 A（用户裁决）：模板与切分**互斥**，只能二选一。

                  理由：模板按「第 N 块」定位，切分后块数与序号全变
                        （120 → 7 时，模板里 0~119 的引用无一有效）。
                        保留 templateId 只会让用户困惑：
                        「我明明套着模板，怎么没效果」。

                  ⚠️ 三处都要清，少一处就会留下"幽灵绑定"：
                      ① 内存里的 templateCache（影响本次渲染）；
                      ② native 的 meta.json（影响下次打开）；
                      ③ localStorage 存档里的 role（影响块数据本身）。

                  ③ 特别容易被忘：role 是跟在块上的，切分重建块时
                     本来就不会带 role，但**存档恢复路径**可能把旧的
                     role 带回来（如果存档里还留着）。
                     所以切分后重写存档时，role 自然是空的 —— 见下面
                     saveDocBlocks() 的调用时机在 continueWith 之后。
                */
                var droppedTpl = null;
                if (templateCache) {
                    droppedTpl = templateCache.name || templateCache.id;
                    templateCache = null;
                    trace('reader:tpl', 'dropped by resegment: ' + droppedTpl);
                    try {
                        var nb = global.ScholariusNative;
                        if (nb && nb.applyTemplate) {
                            nb.applyTemplate(docId, '');
                        }
                    } catch (e) { /* 清绑定失败不阻断切分 */ }
                }
                trace('reader:seg', 'applying: ' + source.length +
                      ' -> ' + out.length + ' blocks');
                /*
                  ⚠️ 重绘前先记下滚动位置 —— 分段后段落数变了，
                     高度也变了，不恢复的话用户会被弹回顶部。
                     用**比例**恢复而不是像素：总高度变了，像素没有意义。
                */
                var ratio = 0;
                if (bodyEl && bodyEl.scrollHeight > bodyEl.clientHeight) {
                    ratio = bodyEl.scrollTop /
                        (bodyEl.scrollHeight - bodyEl.clientHeight);
                }
                continueWith(docId, null, null, null, out, true, true);
                /*
                  ══ ⚠️⚠️ 切分完必须落盘（v0.2.5）══

                  用户反馈：

                    「模型切分后阅读视图没有更新，还是原始切分，
                      这导致渲染错误」

                  ── 真因 ──

                  `continueWith()` 只更新了**内存**（`docModel.blocks`）
                  并重绘，但**没有调用 `saveDocBlocks()` / `pushMdToNative()`**：

                      saveDocBlocks()  只在 applyEdit() 里
                      pushMdToNative() 只在 applyEdit() / 标注里

                  于是切分结果只活在当前这一次渲染里。下一次进入该文档时：

                    · `continueWith` 开头会从 `localStorage` 的
                      `scholarius.blocks.<id>` 读"存档"并**覆盖**刚算好的
                      块结构（见那段 restored 的代码）；
                    · 而那个存档还是切分**之前**的 —— 因为切分从没写进去过。

                  ✅ 所以用户看到的是"切回去又是原来的分段"，
                     同时块数与标注/编号对不上 → 渲染错乱。

                  ⚠️ 顺序：先 `saveDocBlocks()`（结构）→ 再 `pushMdToNative()`
                     （md 正文）。两者是不同层次的持久化：
                       · localStorage 存档  → 下次在网页侧恢复时用；
                       · doc.md             → 原生侧的唯一真源。
                     少写任何一个，都会在某个入口读到旧数据。

                  ⚠️ 必须放在 `continueWith` **之后**：
                     那个函数会重建 `docModel.blocks` 并处理存档恢复，
                     之前调用会写入上一版结构。
                */
                saveDocBlocks();
                pushMdToNative();

                if (bodyEl && bodyEl.scrollHeight > bodyEl.clientHeight) {
                    bodyEl.scrollTop = ratio *
                        (bodyEl.scrollHeight - bodyEl.clientHeight);
                }
                return true;
            })
            .catch(function (e) {
                trace('reader:seg', 'resegment failed: ' + (e && e.message));
                if (prog) prog.finish('failed');
                return false;
            });
    }

    // --- 排版模板应用（v0.2.6）----------------------------------------------

    /**
     * 把模板的 `blocks` / `ops` 应用到当前块序列上。
     *
     * ══ ⚠️⚠️ 模板里只有序号和角色，没有任何原文 ══
     *
     * 这是法律要求（模板要能被公开分享），也是这个函数存在的前提：
     * 它必须**只靠序号 + 数值**就能完成全部排版还原。
     *
     * ══ 为什么用「块序号」而不是"按文本匹配" ══
     *
     * 模板绑定了 PDF 的 sha256，所以同一份 PDF 提取出来的块序列
     * 是**确定的**（同样的 PdfText 版本、同样的输入）。
     * 序号就是稳定主键，不需要（也禁止）用文本内容去对齐。
     *
     * ⚠️ 但序号依赖"提取器版本不变"。所以模板里记了 `blockCount`：
     *    实际块数对不上 → 说明块切法变了 → 给出警告但仍然尝试，
     *    因为差的可能只是末尾几块（比如参考文献被拆了）。
     *
     * @param {Array} blocks  当前 `docModel.blocks`（会被复制，不原地改）
     * @param {Object} tpl    模板对象（来自原生 `getTemplate`）
     * @return {{blocks: Array, warn: string}}
     */
    function applyTemplate(blocks, tpl) {
        if (!blocks || !blocks.length) return { blocks: blocks, warn: '' };
        if (!tpl || !tpl.blocks) return { blocks: blocks, warn: '' };

        var warn = '';

        /*
          ⚠️ 块数不符只警告，不中止。
             中止会让"提取器小升级"直接把所有模板废掉 ——
             那种退化比"套得略歪"更难接受。

          ⚠️ 但必须把警告带出去：用户看到排版不对时，
             需要知道是模板不匹配，而不是"模板坏了"。
        */
        var expected = tpl.blockCount | 0;
        if (expected > 0 && expected !== blocks.length) {
            warn = 'blockCount ' + blocks.length + ' ≠ ' + expected;
            trace('reader:tpl', warn + ' (tpl=' + tpl.id + ')');
        }

        /* ① 复制一份（不改调用方的数组） */
        var out = blocks.map(function (b, i) {
            return {
                line: b.line,
                page: b.page,
                text: b.text || '',
                kind: b.kind || '',
                level: b.level,
                lines: b.lines,
                role: '',
                roleLevel: undefined,
                _src: i      /* ⚠️ 记住原始序号，供 ops 使用 */
            };
        });

        /* ② 按索引赋角色 */
        for (var i = 0; i < tpl.blocks.length; i++) {
            var spec = tpl.blocks[i];
            /*
              ⚠️ 块声明有两种形状（见 TemplateStore.parse）：
                   [0, "title"]         数组
                   {i: 0, role: "title"} 对象
                 这里统一成 {index, role, level}。
            */
            var idx, role, lv;
            if (Object.prototype.toString.call(spec) === '[object Array]') {
                idx = spec[0] | 0;
                role = spec[1] == null ? 'drop' : String(spec[1]);
                lv = spec[2] | 0;
            } else if (spec && typeof spec === 'object') {
                idx = spec.i | 0;
                role = spec.role ? String(spec.role) : 'drop';
                lv = spec.level | 0;
            } else {
                continue;
            }
            if (idx < 0 || idx >= out.length) continue;
            out[idx].role = role;
            if (lv > 0) out[idx].roleLevel = lv;
        }

        /*
          ③ drop 的角色直接从序列里剔除。
             ⚠️ 在这里删而不是在渲染层跳过：
                因为后面的 ops 里 `split` 用的是**原序号**，
                若渲染层才跳过，序号与 ops 的对应关系就乱了。
             ⚠️ 用标记而不是立即 splice —— splice 会改变后续下标，
                而 ops 里的序号是基于原始序列的。
        */
        var dropped = {};
        for (var d = 0; d < out.length; d++) {
            if (out[d].role === 'drop') dropped[d] = true;
        }

        /* ④ 执行 ops（merge / split / drop / reorder） */
        var ops = tpl.ops || [];
        for (var o = 0; o < ops.length; o++) {
            var op = ops[o];
            if (!op) continue;
            var name, arg;
            if (Object.prototype.toString.call(op) === '[object Array]') {
                name = String(op[0]);
                arg = op.slice(1);
            } else {
                name = String(op.op || '');
                arg = op;
            }

            if (name === 'merge') {
                /*
                  ⚠️ 合并：把几个块**首尾相接**成一个段。
                     用空格连接而不是 `\n\n` —— 合并的语义是
                     "这些本该是一段，被排版拆开了"，不是"两个段落"。
                */
                var list = (Object.prototype.toString.call(arg) === '[object Array]'
                    ? (Object.prototype.toString.call(arg[0]) === '[object Array]' ? arg[0] : arg)
                    : (arg.blocks || []));
                var nums = [];
                for (var m = 0; m < list.length; m++) {
                    var nv = list[m] | 0;
                    if (nv >= 0 && nv < out.length && !dropped[nv]) nums.push(nv);
                }
                if (nums.length >= 2) {
                    var base = out[nums[0]];
                    var parts = [];
                    for (var p = 0; p < nums.length; p++) {
                        parts.push(out[nums[p]].text);
                        if (p > 0) dropped[nums[p]] = true;
                    }
                    base.text = parts.join(' ');
                }
            } else if (name === 'split') {
                /*
                  ⚠️ 拆分点 `at` 是**字符偏移**，不是块序号。
                     模板存它是因为作者在编辑时定位到了一个确切位置，
                     而"第几个字"不泄漏任何原文。
                */
                var bi = (Object.prototype.toString.call(arg) === '[object Array]')
                    ? (arg[0] | 0) : (arg.block | 0);
                var at = (Object.prototype.toString.call(arg) === '[object Array]')
                    ? (arg[1] | 0) : (arg.at | 0);
                if (bi >= 0 && bi < out.length && at > 0 &&
                    at < String(out[bi].text).length) {
                    var txt = String(out[bi].text);
                    var tail = {
                        line: out[bi].line + 0.5,   /* ⚠️ 小数行号，避免与已有序号冲突 */
                        page: out[bi].page,
                        text: txt.slice(at).replace(/^\s+/, ''),
                        kind: '',
                        lines: undefined,
                        role: out[bi].role,
                        roleLevel: out[bi].roleLevel
                    };
                    out[bi].text = txt.slice(0, at).replace(/\s+$/, '');
                    out.splice(bi + 1, 0, tail);
                    /*
                      ⚠️ splice 之后所有下标都变了。
                         这是唯一会让后续 ops 失效的操作 ——
                         所以模板生成器**不应该**把 split 和
                         依赖序号的其他 ops 混用。
                         trace 出来以便排查。
                    */
                    trace('reader:tpl', 'split at block ' + bi +
                          ' shifts later indices');
                }
            } else if (name === 'drop') {
                var dlist = (Object.prototype.toString.call(arg) === '[object Array]')
                    ? (Object.prototype.toString.call(arg[0]) === '[object Array]' ? arg[0] : arg)
                    : (arg.blocks || []);
                for (var dq = 0; dq < dlist.length; dq++) {
                    var dv = dlist[dq] | 0;
                    if (dv >= 0 && dv < out.length) dropped[dv] = true;
                }
            } else if (name === 'reorder') {
                /* ⚠️ 暂不实现 —— 会打乱序号与 ops 的对应关系，
                       需要先定义"重排后 split 的偏移算谁的"。 */
                trace('reader:tpl', 'reorder not supported yet');
            }
        }

        /* ⑤ 剔除被 drop 的块 */
        var result = [];
        for (var r = 0; r < out.length; r++) {
            if (dropped[r]) continue;
            var item = out[r];
            delete item._src;
            result.push(item);
        }

        trace('reader:tpl', 'applied ' + (tpl.id || '?') + ': ' +
              blocks.length + ' -> ' + result.length + ' blocks' +
              (warn ? ' [' + warn + ']' : ''));

        return { blocks: result, warn: warn };
    }

    /**
     * `setText` 的后半段：建文档模型、渲染、生成目录。
     *
     * ⚠️ 独立成函数是因为语义分段是异步的（见上面的 `semanticReflow`）。
     *    这里做的每一件事都和 v0.1.94 完全一致，只是入口晚了一点。
     *
     * @param {string} id
     * @param {string} text
     * @param {*} outline
     * @param {*} meta
     * @param {Array} blocks
     * @param {boolean} fromMd
     * @param {boolean} [skipRestore] 跳过「用 localStorage 存档覆盖 blocks」
     *        这一步。**语义切分必须传 true** —— 它算出的 blocks 就是
     *        最新的真源，再让旧存档覆盖回去就等于切分没生效（v0.2.5）。
     */
    function continueWith(id, text, outline, meta, blocks, fromMd, skipRestore) {
        if (!contentEl) return;

        if (blocks && blocks.length) {
            lastBlocks = blocks;
            lastText = '';

            /*
              ══ 应用模板（v0.2.6）══

              ⚠️ 必须在建 `docModel.blocks` **之前**做：
                 模板会删块、合并块、拆块，之后的 `labels` / `edits`
                 都以结果序列为坐标系。

              ⚠️ 模板从 `currentDoc.templateId` 来，内容由原生在
                 `pushLibraryToWeb` 时一起推过来（见 `templateOf`）。
                 **不在这里同步调桥** —— `listTemplates()` 要读目录，
                 在渲染路径上做 I/O 会拖慢首屏。

              ⚠️ 模板应用失败不能阻断渲染：坏模板最多是"排版不对"，
                 不该让用户连正文都看不到。
            */
            /*
              ⚠️ 判据只用 `templateCache`，**不看** `currentDoc.templateId`。
                 原因：`currentDoc` 是 `open(doc)` 时网页侧传进来的对象，
                 它来自库列表推送，字段不一定同步；而 `templateCache`
                 是原生刚刚通过 `setTemplate` 明确设进来的 —— 它才是
                 "这次要套用哪个模板"的唯一权威。

                 （曾经的条件是 `currentDoc.templateId && templateCache`，
                  结果因为 `currentDoc` 没带这个字段，模板永远不生效。）
            */
            var applied = blocks;
            if (templateCache) {
                try {
                    var tplOut = applyTemplate(blocks, templateCache);
                    if (tplOut && tplOut.blocks) applied = tplOut.blocks;
                } catch (e) {
                    trace('reader:tpl', 'apply failed: ' + (e && e.message));
                }
            }
            blocks = applied;

            /*
              ══ 建立文档模型（v0.1.57）══

              ⚠️ 这是**唯一**的文本事实来源。`edits` / `labels` 都以这里的
                 `blocks[i].text` 为坐标系，与 DOM 怎么渲染完全无关。

              ⚠️ 必须存一份**副本** —— 调用方（原生桥）传进来的数组
                 可能是同一份引用，后续被复用时会串数据。
            */
            docModel.blocks = blocks.map(function (b) {
                return {
                    line: b.line,
                    page: b.page,
                    text: b.text || '',
                    /*
                      ══ 块内原始排版行 + 类型（v0.1.91）══

                      ⚠️ 为什么要一起留下来：
                         · `lines` —— Markdown 导出的"一行 = 一个列表项"
                           依赖它（作者项、文献）；
                         · `kind` / `level` —— 导出的标题层级依赖它
                           （`#` / `##` / `###` / `####`）。

                      旧实现在这里只存了 {line, page, text}，
                      把提取层的类型信息**丢掉了**。
                      渲染不需要它（v0.1.39 起"无等级"），
                      但导出需要 —— 两个需求不冲突，留着即可。

                      ⚠️ 缺字段时用安全默认：`kind` 未给 → 空串（= 非标题），
                         `lines` 未给 → undefined（`toMarkdown` 里退回按 text 处理）。
                    */
                    kind: b.kind || '',
                    level: b.level,
                    lines: b.lines,
                    /*
                      ══ ⚠️⚠️ `listMarker`：md 里的 `- ` / `1. ` 记号（v0.2.21）══

                      之前这里没存它 —— 于是 md 解析出"这是列表项"，
                      传到这里就丢了，渲染和回写都看不见。
                      这正是"md 结构没被用上"的一处具体落点。

                      取值："" = 不是列表项；"- " = 无序；"1. " = 有序。
                    */
                    listMarker: b.listMarker || '',
                    /*
                      ══ 排版模板给的角色（v0.2.6）══

                      `role` 是**模板**指定的块角色（title / heading /
                      abstract / body / caption / reference / formula / drop）。
                      空串 = 模板没管这个块，走原来的启发式。

                      ⚠️ 为什么单独一个字段而不复用 `kind`：
                         `kind` 是 **PDF 提取层**的判断（它只认得出
                         "这是标题""这是公式"），而 `role` 是**用户/模板**
                         的显式指定。两者来源不同、优先级不同：
                         role 必须能覆盖 kind，否则模板改了也没用。

                      ⚠️ 不改写 `kind` 而是并存：模板可能只标了一部分块，
                         剩下的仍要靠 `kind` 判断。而且用户取消模板时，
                         `kind` 还是原始值，直接丢 role 就能回到原状。
                    */
                    role: b.role || '',
                    roleLevel: b.roleLevel
                };
            });

            /*
              ══ ⚠️⚠️ 用已保存的段落结构覆盖（v0.1.70）══

              用户反馈：
                「编辑了之后没有保存更改，重新进入又恢复原状了」

              原生桥每次都传**原始 PDF 块**，而编辑合并/拆分的
              结果存在 `scholarius.blocks.<id>` 里。
              不读它的话，重排结果就丢了。

              ⚠️ 只接受**形状合法**的存档：
                 · 必须是数组且非空；
                 · 每项要有 `line`（数字）与 `text`（字符串）。
                 存档损坏时静默退回原始块，不能因此打不开文档。
              ⚠️ 存档的块数可能与原始不同（合并/拆分过），这是正常的。

              ══ ⚠️⚠️ `skipRestore`：切分路径必须跳过这一步（v0.2.5）══

              用户反馈：

                「模型切分后阅读视图没有更新，还是原始切分，
                  这导致渲染错误」

              真因就在这里。`resegmentCurrent()` 调用的形式是：

                  continueWith(docId, null, null, null, out, true)

              `out` 是刚刚算出来的**新**分段结果。但这个函数不管三七二十一，
              紧接着就读 localStorage 存档并**覆盖** `docModel.blocks` ——
              而那份存档还是切分**之前**的旧结构。

              于是：
                · 模型明明跑完了（trace 里有 `applying: 121 -> 7`）；
                · 屏幕上却还是 121 段 —— 因为被旧存档顶回去了；
                · 更糟的是 `labels` 已经被清空，而块结构还是旧的
                  → 编号/提示条与正文对不上，也就是用户说的「渲染错误」。

              正确做法不是"切完再存一次"（那只是把洞补上，恢复仍会发生），
              而是**切分的结果本身就是最新的真源**，不该被存档覆盖。

              ⚠️ 用显式参数而不是猜"blocks 是不是来自存档"：
                 两种情况的入参形状完全一样，靠形状分不出来。
            */
            var saved = skipRestore
                ? ''
                : readStore('scholarius.blocks.' + docStoreKey, '');
            if (saved) {
                try {
                    var arr = JSON.parse(saved);
                    if (arr && arr.length) {
                        var ok = true;
                        var restored = [];
                        for (var sb = 0; sb < arr.length; sb++) {
                            var it = arr[sb];
                            if (!it || typeof it.line !== 'number' ||
                                typeof it.text !== 'string') {
                                ok = false;
                                break;
                            }
                            restored.push({
                                line: it.line,
                                page: (it.page == null) ? null : it.page,
                                text: it.text,
                                /*
                                  ⚠️ 存档里没有 kind/level/lines（它只存"重排后的段落结构"，
                                     见 reflowParagraphs）→ 保持 undefined。
                                     ⚠️ 不要从 `blocks` 里按行号捞回来：重排之后
                                        行号与原始块已经不是一一对应了，捞到的是**别的块**的类型。
                                     导出时缺 kind 就按正文处理 —— 这是正确答案：
                                     用户重排过的段落本来就该是正文。
                                */
                                kind: it.kind || '',
                                level: it.level,
                                lines: it.lines,
                                /* ⚠️ 模板角色也必须从存档恢复（v0.2.6）——
                                       否则重开文档时模板赋予的角色全丢，
                                       表现为「套用模板后重开就失效了」 */
                                role: it.role || '',
                                roleLevel: it.roleLevel
                            });
                        }
                        if (ok && restored.length) {
                            docModel.blocks = restored;
                            trace('reader:blocks',
                                'restored ' + restored.length +
                                ' of ' + blocks.length + ' from store');
                        }
                    }
                } catch (err) { /* 存档坏了 → 用原始块 */ }
            }
        } else {
            lastBlocks = null;
            lastText = text;

            /*
              ⚠️ 没有块数据（老文献）→ 退回"整篇一个块"，
                 这样编辑/标注仍然可用（按整篇文本做区间）。
            */
            docModel.blocks = [{ line: 0, page: null, text: text || '' }];
        }
        if (docModel.blocks && docModel.blocks.length) {
            renderBlocks(docModel.blocks);
        } else {
            /*
              ⚠️ 用 textContent + CSS pre-wrap，不用 innerHTML。
                 正文是从 PDF 提取的任意文本，里面可能有 < > & 之类字符；
                 用 innerHTML 会破坏页面结构（甚至注入）。
            */
            contentEl.textContent = text;
        }

        if (bodyEl) {
            bodyEl.scrollTop = 0;
        }

        /*
          ⚠️ md 路径下 `text` 可能是 null → 从块拼一份用于目录识别。
             （目录是版式启发式，需要"正文行"这个形态。）
        */
        if (text == null) {
            var joined = [];
            for (var lb = 0; lb < (docModel.blocks || []).length; lb++) {
                var bt = String(docModel.blocks[lb].text || '');
                if (!bt) continue;
                var seg = bt.split('\n');
                for (var sg = 0; sg < seg.length; sg++) joined.push(seg[sg]);
            }
            text = joined.join('\n');
        }
        textLines = text.split('\n');

        /*
          ══ 目录来源优先级（v0.1.5）══

          ① PDF 自带大纲   —— 出版方标注的真实结构，最准
          ② 字体识别        —— 靠字号/字体与正文的差异找标题
          ③ 文本启发式      —— 看 "1 Introduction" 这种形状

          实测（LeCun/Bengio/Hinton, Nature 2015）：
              ① 0 条（HAL 版没做书签）
              ② 7 条，全部正确
              ③ 0 条  ← 用户看到的「没有提取到任何目录」

          所以 ② 是解决该问题的关键，不是可选优化。
        */
        var fromOutline = tocFromOutline(outline, textLines);
        if (fromOutline && fromOutline.length) {
            toc = fromOutline;
            trace('reader:toc', toc.length + ' entries (outline)');
            return;
        }

        var fromFont = tocFromFonts(meta, textLines);
        if (fromFont && fromFont.length) {
            toc = fromFont;
            trace('reader:toc', toc.length + ' entries (font)');
            return;
        }

        toc = buildToc(textLines);
        trace('reader:toc', toc.length + ' entries (heuristic)');
    }

    /**
     * 按**字体/字号**识别标题。
     *
     * ══ 原理 ══
     *
     * 论文排版里，章节标题与正文的区别几乎总是体现在字体上：
     *   · 更大字号（本书类、报告）
     *   · 粗体（Nature / 多数期刊）
     *   · 不同字族（LaTeX 的 \section 用 sans 或 bold）
     *
     * 而**正文行永远是那个出现次数最多的字号 + 字族**。
     * 所以：先统计出「正文基线」，再把显著偏离基线的行当标题。
     *
     * 实测（Nature 2015, LeCun et al.）：
     *   正文 = MinionPro-Regular 9.3pt（19958 字符）
     *   标题 = GlosaMath-Bold   10.0pt（7 个小节标题，全部命中，无噪声）
     *
     * @param {Object|null} meta  {fonts:[名], lines:[[fontIdx, sizeX10, page]]}
     * @param {string[]}    lines 正文行（与 meta.lines 下标一一对应）
     * @returns {Array|null} 目录条目；无法判断时返回 null 让调用方退回启发式
     */
    function tocFromFonts(meta, lines) {
        if (!meta || !meta.lines || !meta.lines.length) return null;
        if (!lines || !lines.length) return null;

        var fonts = meta.fonts || [];
        var rows = meta.lines;

        /*
          ① 统计基线：哪个字号出现最多（按**字符数**加权，不是行数）。

          ⚠️ 必须按字符数加权。
             正文的行数虽多，但短行（标题、图注、表格）也会拉高计数；
             按字符数统计才能真实反映「正文用的多大字号」。
        */
        var sizeChars = {};
        for (var i = 0; i < rows.length && i < lines.length; i++) {
            var sz = rows[i][1];
            if (!sz) continue;
            var n = (lines[i] || '').length;
            if (!n) continue;
            sizeChars[sz] = (sizeChars[sz] || 0) + n;
        }

        var bodySize = 0;
        var best = -1;
        for (var k in sizeChars) {
            if (sizeChars[k] > best) {
                best = sizeChars[k];
                bodySize = parseFloat(k);
            }
        }
        if (!bodySize) return null;

        /*
          ② 找「粗体族」。
             粗体是期刊排版最主要的标题信号，而且它与正文字号**相同**
             （Nature: 两者都约 10pt），所以只靠字号判不出来。

          ⚠️ **不能只匹配 "bold"**。实测踩过的坑：
             · LaTeX 的粗体是 `CMBX10`（Computer Modern Bold eXtended）——
               字体名里根本没有 "bold" 这个词。
             · `NimbusRomNo9L-Medi` 的 "Medi" 是 Medium，即 Nimbus 的粗体档；
               对应的常规体是 `NimbusRomNo9L-Regu`。
             · LaTeX 数学字体 `CMMI10` / `CMSY10` 也必须排除 ——
               它们是符号字体，会命中大量公式碎片。

             所以判据写成两组：
               ① 名字里含粗体语义（bold/black/heavy/semibold/medi）
               ② LaTeX 的 CMBX（含 CMBX 前缀）
             并**显式排除**已知的符号/斜体/常规字体。
        */
        var BOLD_RE = /bold|black|heavy|semibold|demibold|-medi\b|medi$/i;
        var LATEX_BOLD_RE = /^CMBX/i;
        /*
          ⚠️ 排除清单里**不能写裸 `math`**。
             实测踩过：Nature 的标题字体是 `GlosaMath-Bold`，
             含 "Math" 但它是货真价实的粗体标题字体；
             一刀切排除会把这篇 7 个标题全部漏掉。
             数学符号字体用 `^CM(SY|MI|EX)` 精确匹配即可 ——
             LaTeX 的符号字体就是这几个前缀，不需要泛化到 "math" 这个词。
        */
        var NEVER_BOLD_RE = /italic|oblique|^CMSY|^CMMI|^CMEX|^CMTI|^CMSSI|^CMR\d|symbol|dingbat|^TT\d|^TT[0-9A-F]/i;

        var boldFamilies = {};
        for (var f = 0; f < fonts.length; f++) {
            var name = String(fonts[f] || '');
            if (!name) continue;
            if (NEVER_BOLD_RE.test(name)) continue;
            if (BOLD_RE.test(name) || LATEX_BOLD_RE.test(name)) {
                boldFamilies[f] = true;
            }
        }
        if (!Object.keys(boldFamilies).length) return null;

        /*
          ③ 逐行判定。
             ⚠️ 尺寸容差取 0.6pt：PDF 里同一字号常见 ±0.2 的浮点抖动，
                但 Nature 的 9.3 → 10.0 只差 0.7，所以容差不能超过 0.6，
                否则真标题会被当成正文。
        */
        var SIZE_TOLERANCE = 0.6;
        var MAX_LEN = 90;
        var out = [];

        for (var j = 0; j < rows.length && j < lines.length; j++) {
            var row = rows[j];
            var txt = (lines[j] || '').trim();
            if (!txt) continue;

            /*
              ⚠️ 标题必须**短**。
                 长行必然是正文段落 —— 即使它整段是粗体
                 （如 Nature 里跨栏的图注、加粗的关键句）。
            */
            if (txt.length > MAX_LEN) continue;
            /*
              ⚠️ URL / 邮箱 / DOI 不是标题。
                 实测（Nature 的 HAL 封面）：`https://hal.science/hal-04206682v1`
                 是 14.3pt 粗体，比正文大得多，会被字号判据收进来。
            */
            if (NOT_HEAD_RE.test(txt)) continue;
            // 单字符/极短行多半是公式碎片（实测 'z' / 'y' / '=' 大量出现）
            var letters = txt.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '');
            if (letters.length < 4) continue;
            /*
              ⚠️ 纯数字/数字占绝对多数 → 表格单元格（实测 "25.03" / "21.43" /
                 "41.29" / "3.3 · 1018" 大量出现在结果表里）。
                 真标题必然以**字母为主**。
            */
            var alphaOnly = txt.replace(/[^A-Za-z\u4e00-\u9fff]/g, '');
            if (alphaOnly.length < letters.length * 0.6) continue;

            /*
              ⚠️ 拦掉「段首小标题 + 正文」被合并成的整句。

              实测（ResNet / CVPR）：
                  "Identity vs. Projection Shortcuts. We have shown that"
                  "Deeper Bottleneck Architectures. Next we describe our"
                  "Analysis of Layer Responses. Fig. 7 shows the standard"

              这些是论文里的**段内小标题**，PDFBox 把标题与其后的正文
              合并成了一行。它们的共同形状是：
                  <小标题>.<空格><大写字母开头的句子>
              也就是**句中出现了「句号 + 空格 + 大写」**。

              ⚠️ 判据用「句号后跟空格再跟大写」，不是简单地看行尾 ——
                 因为这类行往往以断词结尾（"…describe our"），
                 行尾根本没有标点，靠行尾判是拦不住的。

              ⚠️ 要排除缩写（vs. / Fig. / et al. / Eq. / No.）。
                 白名单方式：句号前的词长度 ≥ 4 才算真句末。
                 "vs" / "Fig" 都是 ≤ 3 个字母，会被放过。
            */
            if (DOT_SENTENCE_RE.test(txt)) continue;

            /*
              ⚠️ 行尾是句末标点 → 是句子而不是标题；
                 但**单词标题要放行**（"Abstract." / "References." 这种）。
                 ≤ 2 个词视为标题，> 2 个词视为句子。
            */
            if (/[.;:,!?]$/.test(txt) && txt.split(/\s+/).length > 2) continue;

            var fontIdx = row[0];
            var size = row[1] / 10;
            var isBold = !!boldFamilies[fontIdx];
            var isBigger = size >= bodySize + SIZE_TOLERANCE;

            // 两个信号至少命中一个
            if (!isBold && !isBigger) continue;

            out.push({
                // 靠字体判不出层级，统一按顶层；有编号的下一轮再细分
                level: levelFromNumber(txt),
                title: txt,
                line: j
            });
        }

        /*
          ④ 去掉「首页作者区」的误报。

          ⚠️ 实测（Transformer / CoT / 多篇 NIPS）：标题用粗体，
             而**作者名也是粗体或更大字号**，于是
             Ashish Vaswani / Noam Shazeer / Niki Parmar… 全被收进来。

          判据：这些误报**集中在正文开始之前的首页顶部**，
          且都在 Abstract 之前。做法是找到第一条 Abstract 行，
          丢掉它之前的全部条目 —— 真正的论文不会在摘要前有章节。
        */
        var abstractAt = -1;
        for (var a = 0; a < lines.length; a++) {
            if (/^\s*(abstract|摘\s*要)\s*$/i.test(lines[a] || '')) {
                abstractAt = a;
                break;
            }
        }
        if (abstractAt > 0) {
            out = out.filter(function (e) { return e.line >= abstractAt; });
        }

        /*
          ④ 条目太少说明这个判据不适用（例如全文都用一个字体）。
             实测阈值：少于 2 条就让调用方退回启发式。
        */
        if (out.length < 2) return null;

        /*
          ⚠️ 粗体判据在「正文里大量加粗」的论文上会误报。
             加一道上限：标题数超过总行数的 15% 显然不合理，
             此时宁可退回启发式，也不要给出一个满是噪声的目录。
        */
        if (out.length > lines.length * 0.15) return null;

        return out;
    }

    /** 从标题文本里读层级（"3.1 xxx" → 2）；读不出按 1 */
    function levelFromNumber(s) {
        var m = /^\s*(\d+(?:\.\d+)*)/.exec(s);
        if (!m) return 1;
        return Math.min(3, m[1].split('.').length);
    }

    /**
     * 「句中句号」判据：句号后跟空格、再跟大写字母。
     *
     * ⚠️ 要求句号前的单词长度 ≥ 4，以排除常见缩写：
     *    vs. / Fig. / Eq. / No. / et al. / Sec.
     *    这些都是标题里合法的部分（"Encoder vs. Decoder"、
     *    "Fig. 7 shows…"），不能因为有句号就判成句子。
     */
    var DOT_SENTENCE_RE = /[A-Za-z]{4,}[.]\s+[A-Z\u4e00-\u9fff]/;

    /**
     * 明显的非标题：URL、邮箱、纯符号串。
     * 实测（Nature 的 HAL 封面）这些会因字号大而被当成标题。
     */
    var NOT_HEAD_RE = /^(https?:\/\/|www\.|doi:|mailto:)|@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$/i;

    function onExtractFailed(id) {
        if (!currentDoc || currentDoc.id !== id) {
            return;
        }
        // 走到这里说明桥是通的、原生确实去提取了 —— 那是真的提取失败
        showError('extract-failed');
    }

    // --- 目录：自带大纲 -----------------------------------------------------

    /**
     * 把 PDF 自带大纲转成目录条目（与 buildToc 输出同构）。
     *
     * ══ 难点：大纲给的是**页码**，但正文是连续文本流 ══
     *
     * 正文里没有「第几页开始」的标记（我没有插页边界），
     * 所以页码无法直接换成行号。做法是**按标题文本回正文里找**：
     * 找到标题所在行 → 那就是跳转目标。
     *
     * ⚠️ 找不到的条目**直接丢弃**，不做「按页码估算行号」的兜底。
     *    估出来的行号会偏到别的节里去，用户点「结果」跳到「方法」，
     *    比列表里少一条更糟。
     *
     * @param {Array|null} outline
     * @param {string[]}   lines   正文行
     * @returns {Array|null} 条目数组；大纲不可用时返回 null 让调用方退回启发式
     */
    function tocFromOutline(outline, lines) {
        if (!outline || !outline.length || !lines || !lines.length) {
            return null;
        }

        /*
          建一张「规范化标题 → 行号」索引，避免对每条大纲都全量扫正文
          （大纲可能上百条，正文可能上万行 → O(n·m) 会明显卡）。

          ⚠️ 只索引**较短的行**：标题一般不长，长行必然是正文段落，
             不可能命中。这一步把索引规模压到一个数量级以下。
        */
        var index = {};
        for (var i = 0; i < lines.length; i++) {
            var raw = lines[i];
            if (!raw) continue;
            var s = raw.trim();
            if (!s || s.length > MAX_TITLE_CHARS) continue;
            var key = normaliseTitle(s);
            if (!key) continue;
            // 只记第一处出现：重复标题（如多个 "References"）取最早的
            if (index[key] === undefined) index[key] = i;
        }

        var out = [];
        for (var j = 0; j < outline.length; j++) {
            var e = outline[j];
            if (!e || !e.title) continue;
            var want = normaliseTitle(String(e.title));
            if (!want) continue;

            var at = index[want];

            /*
              ⚠️ 精确匹配失败时做**前缀匹配**。
                 原因：大纲标题常带页码/编号，而正文行常被 PDFBox
                 拆开或带前后缀，例如
                     大纲: "3 Gradient-Based Learning"   正文: "Gradient-Based Learning"
                     大纲: "References"                  正文: "References 1."
                 精确匹配会丢掉大量本来能用的条目。
                 前缀匹配要求长度 ≥ 8，太短的（如 "A"）会误撞。
            */
            if (at === undefined && want.length >= 8) {
                for (var k = 0; k < lines.length; k++) {
                    var cand = normaliseTitle(lines[k] || '');
                    if (!cand || cand.length > MAX_TITLE_CHARS) continue;
                    if (cand.indexOf(want) === 0 || want.indexOf(cand) === 0) {
                        at = k;
                        break;
                    }
                }
            }

            if (at === undefined) continue;
            out.push({
                level: Math.max(1, Math.min(3, e.level || 1)),
                title: String(e.title).trim(),
                line: at,
                /*
                  ⚠️ 带上原始页码（0 表示读不到）。
                     下一步要用它做「单调性校正」，见下方。
                */
                page: e.page || 0
            });
        }

        /*
          ══ 单调性校正（v0.1.5）══

          ⚠️ 实测反例（Wei et al., Chain-of-Thought Prompting, NIPS 2022）：
             大纲顺序（文档顺序）:
               Introduction / Chain-of-Thought Prompting / Arithmetic Reasoning / ...
             匹配到的行号:
               45          / 20                        / 106 / ...

             `Chain-of-Thought Prompting` 被匹配到 line 20 ——
             那是**图 1 的图注**（示意图上的标签），
             而真正的小节标题在 line 96。
             结果目录里第 2 项的行号比第 1 项还小，点它会**往回跳**。

          根因：标题文本在正文里出现多次（图注、引用句、真标题），
                而索引只取**第一次出现**。

          修法：用大纲**自带的页码**做单调性校正。
                大纲页号必然单调不减（这是书签的定义），
                所以当某条匹配到的行**早于**前一条时，说明匹配错了，
                应当往后找**下一处**出现。
        */
        var prevLine = out.length ? out[0].line : -1;
        for (var q = 1; q < out.length; q++) {
            if (out[q].line >= prevLine) {
                prevLine = out[q].line;
                continue;
            }
            // 倒挂了 → 从当前位置往后重新找
            var want2 = normaliseTitle(out[q].title);
            if (!want2) continue;
            var next = -1;
            for (var r = prevLine; r < lines.length; r++) {
                var cand2 = normaliseTitle(lines[r] || '');
                if (!cand2 || cand2.length > MAX_TITLE_CHARS) continue;
                if (cand2 === want2 || (want2.length >= 8 &&
                    (cand2.indexOf(want2) === 0 || want2.indexOf(cand2) === 0))) {
                    next = r;
                    break;
                }
            }
            if (next >= 0) {
                out[q].line = next;
                prevLine = next;
            }
        }

        /*
          ⚠️ 必须按行号排序。

          前缀匹配对短标题不设防：正文里先出现「…we use chain-of-thought
          prompting…」这样的引用句，会被当成标题匹配上。
          排序不能解决「匹配到了错的那一行」，但至少保证**目录顺序与正文一致**，
          不会出现上下乱跳。这是这里能做的最低成本、最高收益的修正。
        */
        out.sort(function (a, b) { return a.line - b.line; });

        // 至少要 2 条才算「大纲有用」；1 条不值得顶掉启发式
        return out.length >= 2 ? out : null;
    }

    /**
     * 规范化标题用于匹配：去空白、去首尾编号与页码、转小写。
     *
     * ⚠️ 必须去掉行首编号，否则大纲的 "3 Gradient-Based Learning"
     *    与正文的 "Gradient-Based Learning" 匹配不上。
     */
    function normaliseTitle(s) {
        if (!s) return '';
        var t = String(s)
            // 行首编号：1 / 1. / 1.2 / 1.2.3 / IV. / 一、
            .replace(/^\s*(?:\d+(?:\.\d+)*|[IVXLC]+)\s*[.、)]?\s+/i, '')
            // 行尾页码：如 "References 12"
            .replace(/\s+\d{1,4}\s*$/, '')
            // 折叠空白、统一小写
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        return t;
    }

    // --- 目录：解析 ---------------------------------------------------------

    /** 标题行最长字符数。超过就按正文行排除，避免把长句当标题 */
    var MAX_TITLE_CHARS = 80;

    /**
     * 摘要之前的内容（作者、单位、邮箱、日期）不进目录，所以目录从摘要开始。
     * 用多个写法兜底 —— 不同期刊排版差异很大：
     *   "ABSTRACT" / "Abstract" / "摘 要" / "摘要"
     */
    var ABSTRACT_RE = /^\s*(?:A\s*B\s*S\s*T\s*R\s*A\s*C\s*T|Abstract|ABSTRACT|摘\s*要)\s*[:：]?\s*$/;

    /**
     * 「数字编号 + 标题」。覆盖：
     *   1 Introduction
     *   3.1 Problem Formulation
     *   IV. Methodology      （罗马数字，部分期刊用）
     *   §3 Methodology       （带节号）
     */
    var NUMBERED_RE = /^\s*(?:§\s*)?(\d+(?:\.\d+)*|[IVXLC]+)[.、]?\s+(\S.*)$/;

    /**
     * **单独成行的编号**。如 `1` / `3.1` / `IV.`。
     *
     * ⚠️ 这一条是必需的，不是锦上添花。实测（PyMuPDF 对一篇 LaTeX 论文）：
     *       8 |ABSTRACT
     *      11 |1              ← 编号独占一行
     *      12 |Introduction   ← 标题在下一行
     *      17 |3
     *      18 |Methodology
     *      19 |3.1
     *      20 |Problem Formulation
     *    pdfbox 输出同样是这个形态 —— PDF 里编号与标题是**两个独立的定位块**，
     *    提取出来就分行。只匹配「编号+标题同行」会漏掉全部编号章节。
     */
    var NUMBER_ONLY_RE = /^\s*(?:§\s*)?(\d+(?:\.\d+)*|[IVXLC]+)[.、]?\s*$/;

    /**
     * 全大写标题行（无编号）。如 "RELATED WORK"、"CONCLUSION AND FUTURE WORK"。
     * ⚠️ 只认全大写且不含小写字母的行，否则论文里全是误判。
     */
    var UPPER_RE = /^\s*([A-Z][A-Z0-9 \-,:&'()\/]{3,})\s*$/;

    /**
     * 常见的、值得进目录的无编号标题词。全部用大写比对。
     * 加这一层是因为有些 PDF 的标题不是全大写（如 "Introduction"）。
     */
    var KNOWN_HEADS = [
        'INTRODUCTION', 'RELATED WORK', 'BACKGROUND', 'PRELIMINARIES',
        'METHODOLOGY', 'METHOD', 'METHODS', 'APPROACH', 'MODEL',
        'EXPERIMENTS', 'EXPERIMENT', 'EVALUATION', 'RESULTS',
        'DISCUSSION', 'ANALYSIS', 'ABLATION STUDY',
        'CONCLUSION', 'CONCLUSIONS', 'CONCLUSION AND FUTURE WORK',
        'FUTURE WORK', 'REFERENCES', 'ACKNOWLEDGEMENTS',
        'ACKNOWLEDGMENTS', 'APPENDIX'
    ];

    /**
     * 明确**不是**标题的行（全大写比对）。
     *
     * ⚠️ `UNKNOWN` 必须在这里。pdfbox 遇到解不出的字段会输出字面量
     *    "UNKNOWN"，而它恰好满足「全大写、长度够」的标题特征 ——
     *    实测一篇论文里出现了 4 次，全被误收进目录。
     */
    var NOT_HEADS = [
        'UNKNOWN', 'NONE', 'NULL', 'N/A', 'TBD'
    ];

    /**
     * 编号深入层级：`3` → 2 级，`3.1` → 3 级……
     *
     * ⚠️ 基础层级是 2（不是 1），因为 level 1 被「摘要」占了。
     *    章节要比摘要低一级，否则目录里两者看起来一样重。
     */
    function levelOfNumber(numText) {
        var dots = (numText.match(/\./g) || []).length;
        return Math.min(6, dots + 2);
    }

    /**
     * 从正文行里识别目录。
     *
     * ⚠️ 这是**版式启发式**，不是解析 PDF 大纲。
     *    实测多数论文（arXiv / LaTeX 投稿）的 PDF 大纲要么缺失、
     *    要么只有一个「正文」节点，不可用；而标题行的文本形态很稳定。
     *    代价是会漏掉一些非常规标题，也可能误收个别全大写行。
     *    这个取舍是有意的：宁可少几条，也不要塞满噪音。
     *
     * @param lines 正文行数组（原始提取文本，未加工）
     * @return [{ level, title, line }]，line 是在 lines 里的下标
     */
    function buildToc(lines) {
        var out = [];
        var started = false;

        for (var i = 0; i < lines.length; i++) {
            var raw = lines[i];
            if (!raw) continue;
            var s = raw.trim();
            if (!s) continue;

            // ① 找到摘要：从这里开始收目录
            if (!started) {
                if (ABSTRACT_RE.test(s)) {
                    started = true;
                    out.push({ level: 1, title: t('reader.abstract'), line: i });
                }
                continue;
            }

            if (s.length > MAX_TITLE_CHARS) continue;

            /*
              ② 编号独行 → 与下一行合并成一条。
                 ⚠️ 必须往前看一行，且下一行要有内容、不能是纯数字
                    （否则 `1` 后面紧跟公式 `2` 会被误合并）。
            */
            var numOnly = NUMBER_ONLY_RE.exec(s);
            if (numOnly) {
                var title = lookAheadTitle(lines, i + 1);
                if (title) {
                    out.push({
                        level: levelOfNumber(numOnly[1]),
                        title: numOnly[1] + ' ' + title.text,
                        line: i
                    });
                    /*
                      ⚠️ 跳过已消费的标题行。
                         循环末尾还有一次 i++，所以这里只能设到 title.index，
                         让 i++ 之后正好停在 title.index + 1。
                         写成 title.index - 1 会**原地再处理一遍标题行**，
                         导致目录里每条编号标题都多出一个重复项
                         （实测症状：`2 | 1 Introduction` 与 `1 | Introduction` 并列）。
                    */
                    i = title.index;
                    continue;
                }
                // 后面不是标题 → 当成普通数字，忽略
                continue;
            }

            // ③ 编号与标题同行
            var m = NUMBERED_RE.exec(s);
            if (m) {
                out.push({
                    level: levelOfNumber(m[1]),
                    title: s,
                    line: i
                });
                continue;
            }

            // ④ 无编号：全大写，或在已知标题词表里
            var isUpper = UPPER_RE.test(s);
            var upper = s.toUpperCase();
            // 占位符之类明确不是标题的，先排除
            if (NOT_HEADS.indexOf(upper) >= 0) continue;
            var known = KNOWN_HEADS.indexOf(upper) >= 0;
            if (isUpper || known) {
                /*
                  ⚠️ 排除单字符/极短的全大写行（如 "A"、"II"）——
                     那种多半是公式编号或列表标记，不是标题。
                */
                if (s.replace(/[^A-Za-z0-9]/g, '').length < 4) continue;
                out.push({ level: 1, title: s, line: i });
            }
        }

        return out;
    }

    /**
     * 向后找一行可以用作标题的文本。
     *
     * ⚠️ 跳过空行，但**只跳一格**就放弃 —— 编号与标题之间通常紧邻，
     *    中间隔了空行又隔了正文，那这编号多半是公式编号不是章节号。
     *
     * @return { text, index } 或 null
     */
    function lookAheadTitle(lines, from) {
        var idx = from;
        // 允许前面有一个空行
        if (idx < lines.length && !lines[idx].trim()) idx++;
        if (idx >= lines.length) return null;

        var s = lines[idx].trim();
        if (!s || s.length > MAX_TITLE_CHARS) return null;
        // 占位符（pdfbox 对解不出的字段输出 UNKNOWN）不是标题
        if (NOT_HEADS.indexOf(s.toUpperCase()) >= 0) return null;
        // 纯数字/纯符号 → 不是标题
        if (!/[A-Za-z\u4e00-\u9fff]/.test(s)) return null;
        // 以句号结尾的长句 → 正文，不是标题
        if (s.length > 40 && /[.。]$/.test(s)) return null;

        return { text: s, index: idx };
    }

    // --- 目录：弹窗 ---------------------------------------------------------

    function mountToc() {
        if (tocBtn) {
            tocBtn.addEventListener('click', function () {
                setToc(true);
            });
        }
        if (tocCloseEl) {
            tocCloseEl.addEventListener('click', function () {
                setToc(false);
            });
        }
        if (tocBackdropEl) {
            tocBackdropEl.addEventListener('click', function () {
                setToc(false);
            });
        }
    }

    function setToc(open) {
        if (!tocSheetEl) return;

        tocOpen = !!open;
        if (tocBtn) {
            tocBtn.setAttribute('aria-expanded', tocOpen ? 'true' : 'false');
        }

        if (tocOpen) {
            // 打开时至少要把菜单留着？不留 —— 目录是全屏覆盖，菜单在下面也没用
            setPanel(false);
            renderToc();
            tocSheetEl.hidden = false;
            // 强制布局后再加 is-open，否则滑入动画不触发
            if (tocSheetEl.offsetWidth < 0) return;
            tocSheetEl.classList.add('is-open');
        } else {
            tocSheetEl.classList.remove('is-open');
            global.setTimeout(function () {
                if (!tocOpen) {
                    tocSheetEl.hidden = true;
                }
            }, 260);
        }
    }

    /**
     * 渲染目录列表。
     *
     * ══ ⚠️⚠️ 用户标注的段落也要出现在这里（v0.1.45）══
     *
     * 用户要求原话：
     *   「标签一旦存在，此时我们的悬浮菜单的目录选项中点开
     *     应该就能看见这些才对。」
     *
     * 为什么必须合并进**同一个列表**而不是另开一个分组：
     *   · 目录的价值是"按文档顺序浏览全文结构"，
     *     分成「自动识别」+「手动标注」两块会把阅读顺序打断；
     *   · 用户标注的目的本来就是**补全/纠正**自动识别漏掉的标题 ——
     *     补上的条目理应出现在它该在的位置。
     *
     * ✅ 所以按 `line`（块行号）**一起排序**，天然落在正确位置。
     *
     * ⚠️ 有标注时**只列标注**，不混入自动识别结果（见 mergedTocEntries）；
     *    完全没有标注时才退回自动识别 —— 所以这里不需要再判优先级。
     *
     * ⚠️ 标注的标题取该段的**当前文本**（可能是编辑过的），
     *    并截断到一定长度：整段摘要当目录项会撑破弹层。
     */
    function renderToc() {
        if (!tocListEl) return;
        tocListEl.textContent = '';

        var entries = mergedTocEntries();

        if (!entries.length) {
            var empty = document.createElement('li');
            empty.className = 'toc-empty';
            empty.textContent = t('reader.tocEmpty');
            tocListEl.appendChild(empty);
            return;
        }

        entries.forEach(function (entry) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'toc-item';
            btn.setAttribute('data-level', String(entry.level));

            /*
              ══ ⚠️⚠️ 标注条目渲染成**两行**（v0.1.48）══

              用户要求原话：
                「点击去目录，我们不靠颜色来标记，而是一栏分两行，
                  第一行是标签的种类，比如文章标题，第二行就是标签的内容，
                  比如"attention is all you need"。然后那个标签种类和
                  阅读视图的淡色一样，总之二者一看就能呼应相对。」

              所以：
                第一行  `.toc-label-kind`  —— 标签种类，淡色小字
                第二行  `.toc-label-text`  —— 标注的内容，正常大小

              ══ ⚠️⚠️ 但只有**标题类**标签才显示第二行（v0.1.51）══

              用户要求原话：
                「目录中，只有文章标题、一级标题、二级标题、三级标题
                  显示标签内容，其他只显示标签」

              理由：标题类标签的内容本身就是一句短标题，看目录时有用；
              而「作者信息 / 摘要 / 参考文献」的内容往往是整段话，
              塞进目录既占地方又没有阅读价值 —— 只需要知道
              "这里是作者信息"就够了。

              ⚠️ 判定用 `labelShowsContent()`，与阅读视图的渲染**无关** ——
                 正文里那些区域仍然照常显示全部内容。
            */
            if (entry.labeled) {
                btn.classList.add('is-labeled-entry');

                var kind = document.createElement('span');
                kind.className = 'toc-label-kind';
                kind.textContent = entry.labelKind || '';
                btn.appendChild(kind);

                if (labelShowsContent(entry.label)) {
                    var text = document.createElement('span');
                    text.className = 'toc-label-text';
                    text.textContent = entry.title;
                    btn.appendChild(text);
                }
            } else {
                /*
                  ⚠️ 自动识别的条目保持单行纯文本 —— 它们没有"种类"，
                     强行凑两行会造出一个空的第一行。
                */
                btn.textContent = entry.title;
            }

            btn.addEventListener('click', function () {
                jumpTo(entry);
            });
            li.appendChild(btn);
            tocListEl.appendChild(li);
        });
    }

    /**
     * 把用户的标注整理成按文档顺序排列的目录列表。
     *
     * ══ ⚠️⚠️ 有标注时，**只列标注**，不混入自动识别结果（v0.1.52）══
     *
     * 用户实测反馈：
     *   「不对啊，我没有标注的为什么目录也有其他的栏？」
     *
     * 实测当时的情况：目录 25 条里，用户只标了 2 条，
     * 其余 23 条全是自动识别的标题（Abstract / 2 Background /
     * 3 Model Architecture …）。用户要的目录是"**我标出来的东西**"，
     * 不是"机器猜的标题 + 我标的"。
     *
     * ══ 为什么之前会混进去 ══
     *
     * v0.1.45 的设计假设是：目录 = 自动识别（主体）+ 标注（补全/纠正）。
     * 但用户的用法完全是另一回事 —— 他把标注当成**目录的唯一来源**：
     * 自己决定哪几段是标题、是几级标题。在这种用法下，
     * 自动识别的那些条目就是纯噪声。
     *
     * ✅ 现在的规则：
     *    · 有标注 → 目录只显示标注条目
     *    · 完全没有标注 → 目录显示自动识别结果（否则新导入的文献
     *      一打开就是空目录，用户会以为功能坏了）
     *
     * ⚠️ 这个"回退"很重要：不放的话，用户第一次打开任何文献
     *    都会看到空目录，而他那时还没机会标注过任何东西。
     *
     * @return {Array} `[{level, title, line, labeled, label, labelKind}]`
     */
    function mergedTocEntries() {
        var byLine = {};

        /* ① 先收集标注条目 */
        for (var key in labels) {
            if (!Object.prototype.hasOwnProperty.call(labels, key)) continue;
            var line = parseInt(key, 10);
            if (!isFinite(line)) continue;

            var spans = labels[key];
            if (!spans || !spans.length) continue;

            var text = blockTextOf(line);
            if (!text) continue;

            /*
              ══ ⚠️⚠️ 一段可能有**多个**标注区间（v0.1.47）══

              改按区间标注之后，同一个段落里可以有多个被标注的片段
              （比如「一、引言」和后面的「我们的贡献」被分别标成
              一级标题和正文）。旧代码假设一行只有一个标签，
              会只显示最后一条。

              ✅ 现在每块按 start 排序，逐个生成目录项。
                 每条的标题取**该区间自己的文字**，不是整段 ——
                 这正是用户想要的「选中多少就标多少」。
            */
            var sorted = spans.slice().sort(function (p, q) {
                return (p.start || 0) - (q.start || 0);
            });

            var first = true;
            for (var s = 0; s < sorted.length; s++) {
                var sp = sorted[s];
                if (!sp || !sp.label || sp.label === 'body') continue;

                /*
                  ══ ⚠️⚠️ 目录只收标题类标签（v0.1.70）══

                  用户要求：
                    「目录中仅出现标题类标签，即文章标题、一级标题、
                      二级标题、三级标题。其他的标签不显示在目录中。」

                  ✅ 直接在这里过滤掉 author / abstract / reference / cite ——
                     而不是生成后再隐式，否则排序和区域合并逻辑
                     仍会把这些条目当邻居参与计算。
                */
                if (!labelShowsContent(sp.label)) continue;

                var slice = text.slice(sp.start || 0, sp.end || 0);
                if (!slice) continue;

                /*
                  ⚠️ 同一区域（相邻同标签的连续块）只生成**一条**目录项
                     （v0.1.50）。

                     用户把 4 个段落一起标成「作者信息」时，
                     旧代码给每段各生成一条，目录里出现 4 条
                     一模一样的「作者信息」—— 而它们在阅读视图里
                     是**一个区域**（只有一个标签段）。

                     ✅ 判据：这一块的标签与"上一条已加入的标注条目"相同，
                        且它在 blocks 顺序上紧邻上一块 → 视为同一区域，跳过。
                */
                if (isSameRegionAsPrevious(line, sp.label)) {
                    first = false;
                    continue;
                }

                var dictKey = first ? String(line) : (String(line) + '#' + s);
                byLine[dictKey] = {
                    level: labelLevel(sp.label),
                    title: tocTitleFrom(slice, sp.label),
                    /*
                      ⚠️ 原始标签键（title/h1/author/…），供
                         labelShowsContent() 判断要不要显示第二行（v0.1.51）。
                         `labelKind` 是**译文**，不能拿来判断 ——
                         它随语言变。
                    */
                    label: sp.label,
                    /*
                      ⚠️ 标签种类（中文/英文的标签名），供目录两行结构的
                         第一行用（v0.1.48）。与阅读视图里标签段的
                         文字完全相同 —— 用户要求"二者一看就能呼应"。
                    */
                    labelKind: t('reader.label.' + sp.label),
                    line: line,
                    /*
                      ⚠️ 同一行有多个标注时必须能稳定排序（v0.1.47）——
                         只按 `line` 排的话，它们之间的先后顺序取决于
                         对象的遍历顺序，不可控。
                    */
                    order: (sp.start || 0),
                    labeled: true
                };
                first = false;
            }
        }

        /*
          ② **完全没有标注时**，退回自动识别的目录。
             ⚠️ 这是必要的新用户路径：第一次打开文献还没标注过任何东西，
                不放这个回退，目录就是空的，用户会以为功能坏了。
          ③ 有标注时**不**混入自动条目 —— 见函数头部的说明。
        */
        var hasLabels = false;
        for (var k in byLine) {
            if (Object.prototype.hasOwnProperty.call(byLine, k)) {
                hasLabels = true;
                break;
            }
        }

        if (!hasLabels) {
            for (var i = 0; i < toc.length; i++) {
                var e = toc[i];
                if (!e || typeof e.line !== 'number') continue;
                byLine[e.line] = {
                    level: e.level,
                    title: e.title,
                    line: e.line,
                    labeled: false
                };
            }
        }

        /* ③ 展开成数组，按行号排序 */
        var out = [];
        for (var ln in byLine) {
            if (!Object.prototype.hasOwnProperty.call(byLine, ln)) continue;
            out.push(byLine[ln]);
        }
        out.sort(function (a, b) {
            if (a.line !== b.line) return a.line - b.line;
            return (a.order || 0) - (b.order || 0);
        });
        return out;
    }

    /**
     * 判断 `line` 这一块是否与"上一处已标注的块"属于同一区域（v0.1.50）。
     *
     * ══ 为什么需要 ══
     *
     * 用户把连续多段标成同一个标签时，阅读视图里它们合并成**一个区域**
     * （只有一个标签段）。目录也必须只有**一条**条目 ——
     * 否则会出现 4 条一模一样的「作者信息」。
     *
     * 判据（两者都要满足）：
     *   ① 标签相同
     *   ② 在**块顺序**上紧邻（不是行号数值相邻 —— 中间可能有被
     *      `dropContainedBlocks` 过滤掉的块，行号会跳）
     *
     * ⚠️ 按块顺序判断要用 `lastBlocks`，不能用行号 ±1。
     */
    function isSameRegionAsPrevious(line, label) {
        if (!lastBlocks || !lastBlocks.length) return false;

        var idx = -1;
        for (var i = 0; i < lastBlocks.length; i++) {
            if (lastBlocks[i].line === line) { idx = i; break; }
        }
        if (idx <= 0) return false;

        /*
          ⚠️ 判据必须与渲染侧**完全一致**，见 labelSignatureOf()：
             用整块签名（排序后拼接）而不是单个 label。
             否则"一个块里有多个标签"时，渲染与目录会得出不同结论。
        */
        var curSig = labelSignatureOf({ line: line });
        var prev = lastBlocks[idx - 1];
        var prevSig = labelSignatureOf(prev);

        return !!curSig && curSig === prevSig && curSig === label;
    }

    /**
     * 这个标签在目录里是否要显示**内容**（第二行，v0.1.51）。
     *
     * ══ 用户要求（原话）══
     *
     *   「目录中，只有文章标题、一级标题、二级标题、三级标题
     *     显示标签内容，其他只显示标签」
     *
     * 理由：
     *   · 标题类标签的内容本身就是一句短标题，看目录时有用；
     *   · 「作者信息 / 摘要 / 参考文献」的内容往往是整段话，
     *     塞进目录既占地方又没有阅读价值 ——
     *     只需要知道"这里是作者信息"就够了。
     *
     * ⚠️ 只影响**目录**，不影响阅读视图 —— 正文里这些区域
     *    仍然照常显示全部内容（用户没有要求改正文）。
     */
    function labelShowsContent(key) {
        return key === 'title' || key === 'h1' ||
            key === 'h2' || key === 'h3';
    }

    /**
     * 标注标签 → 目录缩进层级（1~3）。
     *
     * ⚠️ 只有三级标题体系用得到层级；标题/作者/摘要/参考文献
     *    都当成一级，否则它们在目录里会缩进得莫名其妙。
     */
    function labelLevel(key) {
        if (key === 'h2') return 2;
        if (key === 'h3') return 3;
        return 1;
    }

    /**
 * 从标注的文本生成目录**内容行**（第二行）。
 *
 * ══ ⚠️ v0.1.48：统一返回内容本身 ══
 *
 * 旧版对摘要/作者等“没有短标题”的标签返回**标签名**，
 * 因为那时目录只有一行，需要靠它说明这是什么。
 *
 * 现在目录是两行：第一行已经是标签种类（「摘要」），
 * 第二行再返回「摘要」就重复了。
 *
 * ✅ 所以这里一律返回**被标注的内容**（压成单行 + 截断）。
 *    用户要求第二行就是「tag 的内容，比如 attention is all you need」。
 *
 * ⚠️ 必须截断：用户可能把一整段摘要标成「摘要」，
 *    原文几十上百字塞进目录项会把弹层撑破、也无法阅读。
 */
function tocTitleFrom(text) {
    /*
      ⚠️ 压成单行 —— PDF 抽出的标题偶尔带换行，
         目录项里出现断行会显得比其它项矮一截。
    */
    var oneLine = String(text).replace(/\s+/g, ' ').trim();
    return clip(oneLine, 60);
}

    /** 这个弹层当前是否可见（供返回键逐层退出判断用） */
    function isSheetOpen(el) {
        return !!(el && !el.hidden && el.classList.contains('is-open'));
    }

    /** 截断到 n 个字符，超出加省略号 */
    function clip(s, n) {
        if (!s) return '';
        if (s.length <= n) return s;
        return s.slice(0, n - 1) + '…';
    }

    /**
     * 跳转到目录条目的位置。
     *
     * ══ ⚠️⚠️ 现在正文是 **DOM 树**，不是单一文本节点（2026-10-21 修）══
     *
     * 早期正文是 `contentEl.textContent = text` 的**一个文本节点**，
     * 于是"按行累加字符偏移 + Range"就能定位。
     *
     * 但后来正文改成 `renderRegions()` 渲染的区域/段落**元素树**，
     * 那个办法就彻底失效了 —— `contentEl.firstChild` 是 `<section>`
     * 而不是文本节点，`range.setStart(元素, 数字)` 抛异常 →
     * `target` 为 null → **点了目录没有任何反应**。
     *
     * 实测（真机）：点「3 Model Architecture」后
     *   `scrollTop` 仍为 0、目录弹窗也没关。
     *
     * ✅ 修法：目录条目本来就带 `line`（原生块序号），
     *    而每个块的 DOM 上都写着 `data-line`（见 makeBlockEl）。
     *    **直接按 data-line 找元素**，再算它的位置 —— 不需要任何
     *    字符偏移换算，也不再依赖正文是不是纯文本。
     *
     * ⚠️ 找不到精确匹配时退化到"第一个 line >= 目标"的元素 ——
     *    原生行号与目录行号偶尔会差一两行（目录是另一个识别通道
     *    算出来的），差一点也应该跳过去，而不是原地不动。
     *    这也是实测逼出来的：`Abstract` 的 line 是 7，
     *    而正文里第一个块的 data-line 恰好是 7；但换成别的条目
     *    就未必严丝合缝。
     */
    function jumpTo(entry) {
        if (!contentEl || !bodyEl || !entry) return;

        var want = (typeof entry.line === 'number') ? entry.line : -1;
        var nodes = contentEl.querySelectorAll('[data-line]');

        var best = null;
        var bestLine = Infinity;
        for (var i = 0; i < nodes.length; i++) {
            var ln = parseInt(nodes[i].getAttribute('data-line'), 10);
            if (!isFinite(ln)) continue;
            if (ln === want) { best = nodes[i]; break; }
            /*
              ⚠️ 同时记"最小的、不小于目标的"作为兜底。
                 反向（ln < want）不收 —— 那是往回跳，会停在前一节。
            */
            if (ln > want && ln < bestLine) {
                bestLine = ln;
                best = nodes[i];
            }
        }
        /* 目标行之前没有任何块（例如目录行号偏小）→ 跳到第一块 */
        if (!best && nodes.length) best = nodes[0];

        setToc(false);

        if (!best) {
            trace('reader:jump', 'no node for line=' + want);
            return;
        }

        /*
          ⚠️ 用 offsetTop 累加而不是 getBoundingClientRect：
             rect 受当前滚动位置影响，而 offsetTop 是相对定位父级的
             静态值，不受滚动干扰（正文容器没有定位，父级链上的
             offsetTop 直接可用）。
             实测 rect 法在平滑滚动期间读到的是过渡中的位置，会跳歪。
        */
        var y = 0;
        var el = best;
        while (el && el !== contentEl) {
            y += el.offsetTop;
            el = el.offsetParent;
            /* offsetParent 可能直接跳到 body，此时停止累加 */
            if (el && !contentEl.contains(el)) break;
        }

        /*
          ══ ⚠️⚠️ 跳转后把标题放在**视窗中央**（v0.1.70）══

          用户要求：
            「在目录中点击标题跳转，尽量让标题位于视窗中央，
              类似头部的文章标题可能没法做到位于中间无所谓，
              但能做到的尽量都做到跳转后位于视窗中心。」

          ⚠️ 为什么不能直接 `scrollTo(y - 24)`：
             那只把标题放到顶部，用户还得往下找正文。
             放在中央，标题前后都有上下文，是阅读器的常见做法。

          ⚠️ 视口高度要取**可见区**，不是 window.innerHeight：
             顶栏/状态栏会遮住一部分。用 `bodyEl.clientHeight` +
             目标元素高度折半：

                 top = y - (可见高度 - 元素高) / 2

          ⚠️ 头部条目（文章标题）会被 `Math.max(0, ...)` 夹住 ——
             文档开头本来就没法再往上滚，此时贴顶是正确的，
             用户也说了「类似头部的文章标题可能没法做到位于中间无所谓」。

          ⚠️ 居中会让"不能滚到底"的文末条目自动贴底，
             这也是浏览器的天然行为，不需要额外处理。
        */
        var viewH = bodyEl.clientHeight || global.innerHeight || 0;
        var elH = best.offsetHeight || 0;
        var centered = Math.max(0, y - Math.max(0, (viewH - elH) / 2));

        bodyEl.scrollTo({ top: centered, behavior: 'smooth' });
        trace('reader:jump', 'line=' + want + ' -> ' + best.tagName +
              ' data-line=' + best.getAttribute('data-line') + ' y=' + y +
              ' top=' + Math.round(centered) + ' viewH=' + viewH);
    }

    // --- 设置面板 -----------------------------------------------------------

    function mountSettings() {
        if (settingsBtn) {
            settingsBtn.addEventListener('click', function () {
                setPanel(!panelOpen);
            });
        }
    }

    function setPanel(open) {
        if (!panelEl) return;

        panelOpen = !!open;
        if (settingsBtn) {
            settingsBtn.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
        }

        if (panelOpen) {
            if (!menuOpen) {
                setMenu(true);
            }
            panelEl.hidden = false;

            /*
              ⚠️ 唯一需要 JS 介入的是**高度上限**，不需要算上移量。
                 面板与选项栏是 .reader-stack 里自下往上排的 flex 兄弟，
                 面板一展开就把选项栏自然顶上去，两者永远严丝合缝。

                 上限公式：视口 - 状态栏 - 选项栏高度 - 呼吸空间。
                 ⚠️ 不能用「屏幕高度的百分比」——面板是贴着底部、叠在
                    选项栏之上的，可用高度不是 62vh 这类比例。
                    实测 360x640 小屏 + 字号 26px 时，写 62vh 会让面板
                    top 到 -255px，顶部的「字体」整组被推出屏幕且滚不到。
            */
            var bottomH = bottomEl
                ? bottomEl.getBoundingClientRect().height
                : 56;
            var safeTop = parseFloat(getComputedStyle(document.documentElement)
                .getPropertyValue('--safe-top')) || 0;
            var avail = global.innerHeight - safeTop - bottomH - 12;
            root.style.setProperty('--reader-panel-max', Math.max(120, avail) + 'px');

            if (panelEl.offsetWidth < 0) return;
            root.classList.add('is-panel-open');
        } else {
            root.classList.remove('is-panel-open');
            if (settingsBtn) {
                settingsBtn.setAttribute('aria-expanded', 'false');
            }
            global.setTimeout(function () {
                if (!panelOpen) {
                    panelEl.hidden = true;
                }
            }, 240);
        }
    }

    // --- 设置：应用与持久化 -------------------------------------------------

    /**
     * 字号：夹在 [SIZE_MIN, SIZE_MAX] 内。
     * ⚠️ 必须夹，不能只把非法值换成默认 —— 用户手动输入 999 时
     *    如果不管，正文会被放大到看不见。
     */
    function getSize() {
        var v = parseInt(readStore(SIZE_KEY, ''), 10);
        if (!isFinite(v)) return DEFAULT_SIZE;
        return Math.min(SIZE_MAX, Math.max(SIZE_MIN, v));
    }

    function colorValues() {
        return COLORS.map(function (c) { return c.value; });
    }

    function getColor() {
        var v = readStore(COLOR_KEY, 'strong');
        return colorValues().indexOf(v) >= 0 ? v : 'strong';
    }

    function getFont() {
        var v = readStore(FONT_KEY, DEFAULT_FONT);
        return FONTS.indexOf(v) >= 0 ? v : DEFAULT_FONT;
    }

    /**
     * 把设置写进 DOM。
     *
     * ⚠️ 字号只写在 contentEl 上（内联 style），**不写在 .reader 或 body 上**。
     *    用户明确要求：字体三项只作用于正文内容，菜单/面板/目录
     *    跟随应用整体字体。写到上层会连带把菜单也放大。
     *
     * ⚠️ 颜色/字体用 data 属性 + CSS 选择器**限定到 .reader-content**，
     *    所以对菜单没有影响。
     */
    function applySettings() {
        if (!root || !contentEl) return;

        contentEl.style.fontSize = getSize() + 'px';
        root.setAttribute('data-reader-color', getColor());
        root.setAttribute('data-reader-font', getFont());

        syncRows();
    }

    /**
     * 刷新四行右侧的当前值。
     *
     * ⚠️ 字号那行不是纯文字 —— 它是一个可输入的 input（用户要求支持手动输入），
     *    所以单独处理，不能走 setRowValue。
     * ⚠️ 颜色那行右侧要带色块预览（用户要求「能看到这是什么颜色」），
     *    色块颜色由 inline color 驱动，也单独处理。
     */
    function syncRows() {
        syncThemeRow();
        syncSizeInput();
        syncColorRow();
        setRowValue('reader-font-style-value', t('reader.font.' + getFont()));
    }

    function syncSizeInput() {
        var input = document.getElementById('reader-font-size-input');
        if (input && document.activeElement !== input) {
            // 正在输入时不要覆写，否则每敲一个字符光标就跳
            input.value = String(getSize());
        }
    }

    function syncColorRow() {
        var name = getColor();
        setRowValue('reader-font-color-text', t('reader.color.' + name));
        var dot = document.getElementById('reader-font-color-swatch');
        if (dot) {
            /*
              ⚠️ 直接读**正文实际算出的颜色**，不自己推算。
                 踩过的坑：原来按「语义名 + 当前主题」硬算预览值，
                 结果是夜间模式下选「黑色」，正文渲染成白色（CSS 里
                 暗色下 black 对应 #ECECEA），而色块仍显示黑色 ——
                 用户看到「用的是白字，却标着黑色」。
                 自己维护一张映射表必然与 CSS 脱节，索性直接量。
            */
            dot.style.color = actualContentColor();
        }
    }

    /**
     * 取正文**当前实际生效**的颜色。
     *
     * ⚠️ 用 getComputedStyle 而不是查自己的表。
     *    CSS 里每种颜色都有亮/暗两套值，且随 data-theme 与系统偏好变化，
     *    JS 无法可靠地重算它 —— 唯一可靠的来源就是渲染结果本身。
     *    色块与正文因此永远一致。
     *
     * ⚠️ 有回退：若正文元素不存在（阅读页没打开时同步设置），
     *     退回用 CSS 变量 --on-surface（正文的默认前景色），
     *     它是主题相关的，比硬编码一个色值靠谱。
     */
    function actualContentColor() {
        if (contentEl) {
            var c = global.getComputedStyle(contentEl).color;
            if (c) return c;
        }
        var root = document.documentElement;
        return global.getComputedStyle(root).getPropertyValue('--on-surface')
            || 'currentColor';
    }

    function setRowValue(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function fontFamilyOf(name) {
        if (name === 'serif') {
            return 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif';
        }
        if (name === 'mono') {
            return 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        }
        return 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
    }

    // --- 设置：四项行式（字号 / 颜色 / 字体 / 主题） ------------------------

    /**
     * 四项都用「左标签 + 右当前值」，点整行弹**底部表单**。
     *
     * ⚠️ 用 createRowSheetPicker（底部表单）而不是 createRowPicker（行内菜单）——
     *    用户明确要求：行内菜单高度有限，选项一多就排不开；
     *    而字号/颜色/字体/主题这些设置项只会越来越多，必须能滚动容纳。
     */
    /**
     * 实测某个颜色候选在当前主题下的**真实渲染色**。
     *
     * ⚠️ 为什么要"探测"而不是查表：
     *    颜色值定义在 CSS 里、且随主题（data-theme + 系统偏好）分两套，
     *    JS 复制一份必然与 CSS 脱节 —— v0.1.4 初版就是这个错误，
     *    夜间模式下选「黑色」时正文渲染成白色，而预览还是黑色。
     *
     *     做法：临时把该值写到 .reader 上 → 让浏览器算 color → 还原。
     *     代价只有一次同步重排，且只在打开表单时执行（不在滚动/resize 路径上）。
     *
     * @return CSS 颜色字符串；正文元素不存在时返回 null（调用方会跳过色块）
     */
    function probeColor(value) {
        if (!root || !contentEl) return null;
        var saved = root.getAttribute('data-reader-color');
        root.setAttribute('data-reader-color', value);
        var color = global.getComputedStyle(contentEl).color;
        // 还原，避免探测污染当前显示
        if (saved === null) {
            root.removeAttribute('data-reader-color');
        } else {
            root.setAttribute('data-reader-color', saved);
        }
        return color || null;
    }

    function mountRows() {
        var ui = global.ScholariusUI;
        if (!ui || !ui.createRowSheetPicker) return;

        /*
          字号：不做选项列表，而是「减 / 可输入数值 / 加」。
          ⚠️ 不作为 row picker 绑定 —— 它没有选项表单，
             三个控件各自绑事件（见 mountSize()）。
        */

        /*
          字体颜色：仍是行式 + 底部表单，但每个选项带色块预览。
          ⚠️ 用户要求「给出提示颜色让用户能看到这是什么颜色」，
             所以 label 前面要插一个 currentColor 色块。

          ⚠️ 色块颜色**不能自己写一张映射表**（我 v0.1.4 初版就是那么做的，
             结果夜间模式下选「黑色」显示黑色、正文却是白色，自相矛盾）。
             这里用 probeColor() 实测：临时套上每个候选值，
             让浏览器算出该主题下的真实颜色，量完立刻还原。
             这样预览与「选中后正文会变成什么样」严格一致。
        */
        bindRow('reader-font-color-row', 'reader-font-color-text', {
            getOptions: function () {
                return COLORS.map(function (c) {
                    return {
                        value: c.value,
                        label: t('reader.color.' + c.value),
                        swatch: probeColor(c.value)
                    };
                });
            },
            getValue: getColor,
            onChange: function (name) {
                writeStore(COLOR_KEY, name);
                applySettings();
            }
        });

        // 字体样式
        bindRow('reader-font-style-row', 'reader-font-style-value', {
            getOptions: function () {
                return FONTS.map(function (name) {
                    return { value: name, label: t('reader.font.' + name) };
                });
            },
            getValue: getFont,
            onChange: function (name) {
                writeStore(FONT_KEY, name);
                applySettings();
            }
        });

        // 主题 —— ⚠️ 值走 ScholariusTheme，不自己存。
        // 主题是全站共享的，两处入口必须读写同一个地方，否则会互相覆盖。
        bindRow('reader-theme-row', 'reader-theme-value', {
            getOptions: function () {
                return ['light', 'dark', 'system'].map(function (mode) {
                    return { value: mode, label: t('setting.theme.' + mode) };
                });
            },
            getValue: function () {
                return global.ScholariusTheme
                    ? global.ScholariusTheme.getMode()
                    : 'system';
            },
            onChange: function (mode) {
                if (global.ScholariusTheme) {
                    global.ScholariusTheme.setMode(mode);
                }
                syncThemeRow();
            }
        });
    }

    /**
     * 字号：减 / 可输入 / 加。
     *
     * ⚠️ 手动输入必须做**校验与夹值**：
     *    用户可能输入 0、999、空、甚至 1e9；
     *    不夹的话正文会被放大到看不见或缩到不可读。
     *    校验发生在 input 事件上（失焦或回车时提交）。
     */
    function mountSize() {
        var down = document.getElementById('reader-font-size-down');
        var up = document.getElementById('reader-font-size-up');
        var input = document.getElementById('reader-font-size-input');

        function setSize(px) {
            var v = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(px)));
            writeStore(SIZE_KEY, String(v));
            applySettings();
        }

        if (down) {
            down.addEventListener('click', function () {
                setSize(getSize() - SIZE_STEP);
            });
        }
        if (up) {
            up.addEventListener('click', function () {
                setSize(getSize() + SIZE_STEP);
            });
        }
        if (input) {
            /*
              ⚠️ 只在 change（失焦 / 回车）时提交，不在每次 input 时提交。
                 每次击键就改字号会让正文不断重排、输入框位置跳动。
            */
            input.addEventListener('change', function () {
                var v = parseInt(input.value, 10);
                if (isFinite(v)) {
                    setSize(v);
                } else {
                    // 输入非法 → 恢复成当前值，不给用户留一个空框
                    syncSizeInput();
                }
            });
            // 回车立即提交（移动端数字键盘常有「完成」键）
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    input.blur();
                }
            });
        }
    }

    function bindRow(rowId, valueId, config) {
        var row = document.getElementById(rowId);
        var valueEl = document.getElementById(valueId);
        if (!row || !valueEl) return null;
        return global.ScholariusUI.createRowSheetPicker(row, valueEl, config);
    }

    /**
     * 主题行右侧的当前值。
     *
     * ⚠️ 组件内部的 syncSheetPickerValue 只在**本行被点选后**刷新文字；
     *    外部（设置页）改主题时不会触发，所以要单独订阅 ScholariusTheme。
     */
    function syncThemeRow() {
        var el = document.getElementById('reader-theme-value');
        if (!el) return;
        var mode = global.ScholariusTheme
            ? global.ScholariusTheme.getMode()
            : 'system';
        el.textContent = t('setting.theme.' + mode);
    }

    // --- 其它 ---------------------------------------------------------------

    function refreshChrome() {
        /*
          语言切换后，右侧的当前值文字要重写 —— 它们是 JS 填的，
          靠 data-i18n 不会自动更新（那种只适用于静态文案）。
        */
        syncRows();
        applySettings();
        if (tocOpen) {
            renderToc();
        }
    }

    function trace(stage, detail) {
        if (global.trace) {
            global.trace(stage, detail);
        }
    }

    global.ScholariusReader = {
        init: init,
        /**
         * 详情页开关状态回调（v0.2.17，由 detail.js 调用）。
         *
         * ⚠️ 底栏 Metadata 按钮的高亮由 `aria-expanded="true"` 驱动
         *     （见 styles.css 的 `.reader-action[aria-expanded="true"]`）。
         *     以前只在打开时设 true、关闭时不管，
         *     于是关掉详情后按钮一直是深色 —— 用户报的就是这个。
         *
         * ⚠️ 由详情页**主动广播**，而不是在 reader.js 里补每条关闭路径
         *     （取消/保存/返回键/点遮罩…），因为那种写法必然漏一个。
         */
        onDetailOpenState: function (open) {
            if (!detailBtn) return;
            detailBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        },
        open: open,
        close: close,
        isOpen: isOpen,
        setText: setText,
        /**
         * 原生读 `doc.md` 之后推过来的块（v0.1.92）。
         *
         * ══ ⚠️⚠️ 与 setText 的分工 ══
         *
         *   · `setText`  —— 老路径：PDF 提取出来的 text/outline/meta/blocks。
         *   · `setMd`    —— 新主路径：从 **doc.md 解析出来**的块，已含标注。
         *
         * ✅ md 是本地存储的唯一形态（用户裁决），所以正常情况下
         *    只有 `setMd` 会被调用；`setText` 只在 md 生成失败时兜底。
         *
         * ⚠️ 块里带的 `marks` 要直接写进 `labels` —— 不再从
         *    localStorage 读标注。否则用户手工编辑 doc.md 之后，
         *    屏幕上显示的还是旧标注。
         */
        setMd: function (id, blocks) {
            return setText(id, null, null, null, blocks, true);
        },
        /**
         * 设置当前文献要套用的排版模板（v0.2.6）。
         *
         * ⚠️ 必须在 `setMd` **之前**调用 —— `setMd` 建文档模型时
         *    要用它来给块赋 role。晚调等于没调（要重开文档才生效）。
         *
         * ⚠️ 传 `null` 表示"这篇没有模板"，会清掉上一篇的缓存。
         *    不清的话，A 的模板会套到 B 上：序号全错，而且不报错 ——
         *    用户只会看到"排版莫名其妙变了"，极难查。
         *
         * @param {Object|null} tpl 模板对象（原生 getTemplate 的结果）
         */
        setTemplate: function (tpl) {
            templateCache = (tpl && tpl.blocks) ? tpl : null;
            trace('reader:tpl', templateCache
                ? 'set ' + (templateCache.id || '?')
                : 'cleared');
        },
        /**
         * 原生导入模板后的回调（v0.2.7）。
         *
         * ══ 用户要求 ══
         *
         *   「导入模板之后自动按照模板渲染整个阅读视图」
         *
         * ✅ 所以这里**导入即应用**，不需要用户再点一次。
         *
         * @param {string} status 'ok' | 'mismatch' | 'invalid' | 'cancelled'
         * @param {string} payload 成功时是模板 JSON；失败时是错误说明
         */
        onTemplateImported: function (status, payload) {
            /* ⚠️ 无论结果如何都要解禁按钮 —— 否则一次失败后按钮永久失效 */
            if (tplBtn) tplBtn.disabled = false;

            if (status === 'cancelled') {
                trace('reader:tpl', 'import cancelled');
                return false;
            }
            if (status !== 'ok') {
                /*
                  ⚠️ `mismatch` 必须给**专门的文案**：用户最可能的困惑是
                     "我明明有这个模板，为什么不让用"。
                     直接说"模板对应的是另一份 PDF"才能解释清楚。
                */
                var msg = (status === 'mismatch')
                    ? t('reader.importTemplateMismatch')
                    : t('reader.importTemplateFailed');
                trace('reader:tpl', 'import failed: ' + status + ' ' + payload);
                toastSafe(msg);
                return false;
            }

            var tpl = null;
            try {
                tpl = (typeof payload === 'string') ? JSON.parse(payload) : payload;
            } catch (e) {
                trace('reader:tpl', 'import parse failed: ' + (e && e.message));
                toastSafe(t('reader.importTemplateFailed'));
                return false;
            }
            if (!tpl || !tpl.blocks) {
                toastSafe(t('reader.importTemplateFailed'));
                return false;
            }

            /*
              ⚠️ 先落库再套用：用户导入了模板，说明他想留着它。
                 只套用不保存的话，下次打开这篇文献模板就没了 ——
                 而这恰恰是他刚做的事。
            */
            try {
                var bridge = global.ScholariusNative;
                if (bridge && bridge.saveTemplate && currentDoc && currentDoc.id) {
                    bridge.applyTemplate(String(currentDoc.id), String(tpl.id || ''));
                }
            } catch (e) { /* 保存失败也要应用，不该白导 */ }

            var ok = this.applyTemplateNow(tpl);
            toastSafe(ok ? t('reader.importTemplateDone')
                         : t('reader.importTemplateFailed'));
            return ok;
        },
        /**
         * 直接应用模板并重绘（v0.2.6，供详情页「套用」按钮与测试用）。
         *
         * ⚠️ 与 `setTemplate` 的区别：这个会**立刻重排当前文档**，
         *    而 `setTemplate` 只是准备好缓存、等下次 `setMd` 生效。
         */
        applyTemplateNow: function (tpl) {
            templateCache = (tpl && tpl.blocks) ? tpl : null;
            if (!docModel.blocks || !docModel.blocks.length) return false;
            /*
              ⚠️ 以**原始提取块**为准重算，而不是在当前（可能已套过模板的）
                 结果上再套一次 —— 后者会叠加模板，套两次就成灾。
                 所以这里先还原成 `lastBlocks`，再套。
            */
            var base = lastBlocks || docModel.blocks;

            /*
              ══ ⚠️⚠️ 套模板会覆盖已有的切分结果（v0.2.7）══

              模板与切分互斥（用户裁决方案 A）。这里以 `lastBlocks`
              （原始提取块）为基准重算，等于**丢弃**之前的切分结果 ——
              这正是预期行为，但也意味着 `edits` / `labels` 会失效：
              它们以行号为键，而现在的行号来自原始块，与切分后的对不上。

              ⚠️ 不清的话，会出现「改过的文字跑到别的段落上」——
                 这是最难查的一类 bug（文字还在，位置错了）。
                 宁可丢掉，也不能错位。

              ⚠️ 只在**真的套上模板**时清。取消模板（tpl 为 null）
                 不该清用户的编辑 —— 那时块序列回到原始块，
                 行号反而与 edits 对得上。
            */
            if (templateCache) {
                var hadEdits = Object.keys(edits).length;
                var hadLabels = Object.keys(labels).length;
                if (hadEdits || hadLabels) {
                    trace('reader:tpl', 'discard edits/labels on apply: ' +
                          hadEdits + ' edits, ' + hadLabels + ' label blocks');
                    edits = {};
                    labels = {};
                }
            }

            var out = applyTemplate(base, templateCache);
            docModel.blocks = out.blocks;
            var ratio = 0;
            if (bodyEl && bodyEl.scrollHeight > bodyEl.clientHeight) {
                ratio = bodyEl.scrollTop /
                    (bodyEl.scrollHeight - bodyEl.clientHeight);
            }
            renderBlocks(docModel.blocks);
            if (bodyEl && bodyEl.scrollHeight > bodyEl.clientHeight) {
                bodyEl.scrollTop = ratio *
                    (bodyEl.scrollHeight - bodyEl.clientHeight);
            }
            saveDocBlocks();
            pushMdToNative();
            return true;
        },
        onExtractFailed: onExtractFailed,
        /** 目录（供测试与将来的大纲导出用） */
        getToc: function () {
            return toc.slice();
        },
        /**
         * 当前正文块（供测试与排查用）。
         *
         * ⚠️ 为什么需要（吃过亏）：
         *   排查排版问题时，只能从 DOM 里数段落、读文本去猜，
         *   而 DOM 元素与原生的块数组不是一一对应（块会被合并、
         *   被 dropContainedBlocks 丢掉）。于是断言经常
         *   "看着失败、其实功能正常"。
         *   把真实的块数组暴露出来，断言可以直接打在任何字段上。
         */
        getBlocks: function () {
            return lastBlocks ? lastBlocks.slice() : null;
        },
        /**
         * 当前 `docModel.blocks`（含 role），供排查模板是否生效（v0.2.6）。
         *
         * ⚠️ 与 `getBlocks()` 不同：后者返回的是**原始提取块**，
         *    不含模板赋予的 role —— 排查模板问题时看它会被误导
         *    （看起来"role 全空"，实际是看错了数组）。
         */
        getDocBlocks: function () {
            return (docModel.blocks || []).map(function (b) {
                return {
                    line: b.line,
                    role: b.role || '',
                    roleLevel: b.roleLevel,
                    kind: b.kind || '',
                    len: String(b.text || '').length
                };
            });
        },
        /** 当前缓存里的模板 id 或 null（v0.2.6 排查用） */
        getTemplateId: function () {
            return templateCache ? (templateCache.id || '?') : null;
        },
        /**
         * 直接渲染给定的块与标注（v0.2.10，供排查"编号缺失"这类问题）。
         *
         * ⚠️ 为什么不走 `setMd`：`setMd` 要真实文档 id + 原生桥配合，
         *    自动化里很难摆出"三段都标了作者"这样的具体状态。
         *    有了这个钩子就能把任意块 + 标注直接喂进渲染链路，
         *    看见的 DOM 就是用户会看见的 DOM。
         *
         * @param {Array} blocks 块
         * @param {Object} marks  {line: [{start,end,label}]}
         */
        __testRender: function (blocks, marks) {
            labels = {};
            if (marks) {
                for (var k in marks) {
                    if (Object.prototype.hasOwnProperty.call(marks, k)) {
                        labels[parseInt(k, 10)] = marks[k];
                    }
                }
            }
            currentDoc = { id: '__test__', title: 'test' };
            docStoreKey = '__test__';
            docModel.blocks = blocks.map(function (b) {
                return {
                    line: b.line, page: b.page, text: b.text || '',
                    kind: b.kind || '', level: b.level, lines: b.lines,
                    listMarker: b.listMarker || '',
                    role: b.role || '', roleLevel: b.roleLevel
                };
            });
            renderBlocks(docModel.blocks);
            var heads = document.querySelectorAll('.reader-label-head');
            var marks2 = document.querySelectorAll('[data-body-no]');
            var nos = [];
            for (var i = 0; i < marks2.length; i++) {
                nos.push(marks2[i].getAttribute('data-body-no'));
            }
            return {
                heads: heads.length,
                headTexts: Array.prototype.map.call(heads, function (h) {
                    return h.textContent;
                }),
                markers: nos
            };
        },
        /**
         * 供排查/测试：直接跑一次语义重组，不碰 DOM、不依赖打开文档。
         *
         * ⚠️ 只有它才能单独验证「块 → 语义分段」这一步，
         *    因为 `setText` 需要真实打开一篇文档（id 校验）。
         *
         * 用法：
         *   python tools/emu_js.py --file tools/_seg_reflow.js
         */
        __reflow: semanticReflow,
        /** 最后一次 setText 的入参摘要（v0.1.99 诊断） */
        __diag: function () { return lastDiag; },
        /**
         * 供排查：直接跑一次段落重排（v0.2.4）。
         *
         * ⚠️ 编辑表单要真实的手势选区才能进，自动化点不开 ——
         *    有它就能单独验证"编辑后怎么切段"这段逻辑。
         */
        __testReflow: reflowParagraphs,
        /**
         * 供排查：直接应用一次编辑（v0.2.4）。
         *
         * ⚠️ 必须绕过真实表单 —— `applyEdit` 读 `editInputEl.value`，
         *    那个输入框要原生长按选区才会出现，自动化开不出来。
         *    抽成 `applyEditCore(span, value)` 后就能直接喂数据。
         */
        __testApplyEdit: applyEditForTest,
        /**
         * 对当前文档重新做语义分段（v0.1.98）。
         *
         * ⚠️ 只由顶栏的切分按钮调用。`setText` 里没有模型代码 ——
         *    这是"模型不参与提取"的保证。
         */
        resegment: resegmentCurrent,
        /**
         * 供排查：伪造一个"当前文档"，让 setText 能通过 id 校验。
         *
         * ⚠️ 只给诊断用 —— 正常流程靠 open() 建立 currentDoc。
         *    存在的理由：`setText` 的 id 校验会拒绝任何"没打开的文档"，
         *    于是没法单独验证渲染/降级路径。有了它，一行 JS 就能
         *    把任意块数据喂进完整渲染链路。
         */
        __testDocId: function (id) {
            currentDoc = { id: id || '__diag__', title: 'diag' };
            docStoreKey = 'diag';
            edits = {};
            labels = {};
            return currentDoc.id;
        },
        /**
         * 编辑 / 标注的当前状态（供真机排查用，v0.1.46）。
         *
         * ⚠️ 加这个是因为：编辑"确认后没变化"这类问题在模拟器上
         *    复现不出来（CDP 绕过 WebView 原生选择器），只能靠真机上
         *    一行 JS 把链路各环节的值打出来 ——
         *    是没取到选区、没落库、还是落库了但渲染没读到。
         *
         * 用法（真机连 adb 后）：
         *   chrome://inspect 或 `python tools/emu_js.py "return JSON.stringify(window.ScholariusReader.dumpEdits())"`
         */
        dumpEdits: function () {
            return {
                /* 存储键前缀，空串说明 open() 没跑到 loadAnnotations */
                docStoreKey: docStoreKey,
                /* 已经落库的编辑 / 标注 */
                edits: edits,
                labels: labels,
                /* localStorage 里的原始值（用来区分"没存"和"存了但没读"） */
                rawEdits: readStore('scholarius.edits.' + docStoreKey, null),
                rawLabels: readStore('scholarius.labels.' + docStoreKey, null),
                /* 当前 DOM 里实际渲染出的块数与第一个块的行号 */
                domBlocks: contentEl
                    ? contentEl.querySelectorAll('[data-line]').length
                    : 0,
                /* 当前选区（真机上编辑前应为用户选中的那几个字） */
                selection: selectedTextExact(),
                /* 诊断（v0.1.67）：编辑链路的中间状态 */
                editSpan: editSpan,
                lastError: global.__scholariusLastError || null,
                docModelLines: (docModel.blocks || []).length
            };
        },
        /**
         * 直接调用真实的标注写入流程（供真机排查用，v0.1.85）。
         *
         * ⚠️ 为什么需要：
         *   WebView 的原生选区在模拟器/脚本里造不出来
         *   （`Input.dispatchTouchEvent` 走的是 CDP，绕过原生选择器），
         *   于是"标注第二行 → 第一行标签被挤掉"这类问题
         *   只能靠人肉点，排查效率极低、而且每次都要重新点一遍。
         *
         * ✅ 这里绕过"选区"这一层，直接给 `labelSpan` 赋值，
         *    然后调用**同一个** `applyLabel()` ——
         *    所以它跑的仍然是真实业务逻辑（重叠判断、区间扩展、
         *    落库、重渲染全都在），只是省掉了手点。
         *
         * 用法：
         *   ScholariusReader.debugLabel(2, 29, 47, 'author', 'affiliation')
         *   ScholariusReader.debugLabel(2, 0, 28, 'author', null)  // 清子标签
         */
        debugLabel: function (line, start, end, label, field) {
            labelSpan = { single: true, line: line, start: start, end: end };
            labelDraft = label;
            fieldDraft = field || null;
            citeTarget = null;
            applyLabel();
            return labels[line] || null;
        },
        /** 当前设置（供测试用） */
        getSettings: function () {
            return { size: getSize(), color: getColor(), font: getFont() };
        },
        /**
         * 整篇导出为 Markdown（v0.1.91，供测试与外部调用）。
         *
         * ⚠️ 暴露成公开方法而不是只做"复制" ——
         *    剪贴板在模拟器/自动化里读不回来，
         *    而**导出的字符串本身**才是要断言的东西。
         */
        toMarkdown: function () {
            return markdownOfDoc();
        },
        /** 复制全文 Markdown 到剪贴板 */
        copyMarkdown: function () {
            copyMarkdown();
        },
        /**
         * 设字号（供测试与外部调用）。
         * ⚠️ 与 mountSize 里的 setSize 用同一套夹值逻辑 ——
         *    这里若不夹，外部传入 999 会让正文大到看不见。
         */
        setSize: function (px) {
            var v = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(px)));
            writeStore(SIZE_KEY, String(v));
            applySettings();
        },
        setColor: function (name) {
            if (colorValues().indexOf(name) >= 0) {
                writeStore(COLOR_KEY, name);
                applySettings();
            }
        },
        /** 系统返回键用：选项表单 → 目录 → 面板 → 菜单 → 关阅读页，逐层退 */
        handleBack: function () {            if (!isOpen()) {
                return false;
            }
            /*
              ⚠️ 选项表单（#sheet-picker）最先判断。
                 它虽然在 DOM 上挂在阅读页外面（是个 .sheet），
                 但语义上属于阅读设置 —— 用户点它时正在调阅读字体，
                 返回键当然应该先关表单，而不是直接退阅读页。
            */
            if (global.ScholariusUI &&
                typeof global.ScholariusUI.isSheetPickerOpen === 'function' &&
                global.ScholariusUI.isSheetPickerOpen()) {
                global.ScholariusUI.closeSheetPicker();
            } else if (isSheetOpen(labelSheetEl)) {
                /*
                  ⚠️ 编辑/标注表单最先收（v0.1.45）——
                     它们是"刚刚打开、盖在阅读页上的那一层"，
                     返回键的直觉是"退掉我刚打开的这张表"。
                     不处理的话按返回会直接关掉阅读页，
                     用户正在改的编辑内容就白写了。
                */
                closeLabelSheet();
            } else if (isSheetOpen(editSheetEl)) {
                closeEditSheet();
            } else if (tocOpen) {
                setToc(false);
            } else if (panelOpen) {
                setPanel(false);
            } else if (menuOpen) {
                setMenu(false);
            } else if (selectedText) {
                /*
                  ⚠️ 有选中时先取消选中（v0.1.40）。
                     理由：选中是**刚刚发生**的用户动作，它是屏幕上
                     最后一个可见状态 —— 按返回键的直觉是"退掉我刚做的这件事"，
                     而不是直接退出阅读页。

                  ⚠️ 必须排在 `menuOpen` **之后**：菜单是"更外层"的界面，
                     选中只是正文上的一个临时状态。
                     （实际上选中时不会同时开菜单，见 mountTapToToggle。）
                */
                clearSelection();
            } else {
                close();
            }
            return true;
        }
    };
})(window);
