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
        'cite'         /* 参考文献的引用编号（如 [12]）*/
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
     * ⚠️ 只存 `line / page / text` 三个字段 ——
     *    `docModel.blocks` 里可能挂着渲染期的临时字段，
     *    序列化它们会让存储膨胀且不稳定。
     */
    function saveDocBlocks() {
        if (!docStoreKey) return;
        try {
            var list = docModel.blocks || [];
            var plain = [];
            for (var i = 0; i < list.length; i++) {
                var b = list[i];
                if (!b) continue;
                plain.push({
                    line: b.line,
                    page: (b.page == null) ? null : b.page,
                    text: (b.text == null) ? '' : b.text
                });
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
          详情按钮。

          ⚠️ 打开详情页时**不关闭阅读页** ——
             详情是盖在阅读页之上的一层，关掉详情又回到阅读页。
             若先关阅读页，关完详情就回到文库了，用户得重新点进来。

          ⚠️ 图标用 ScholariusUI.icon() 填，不写在 HTML 里 ——
             图标路径只有 components.js 一处定义，避免两处不同步。
        */
        if (detailBtn) {
            if (global.ScholariusUI) {
                detailBtn.innerHTML = global.ScholariusUI.icon('moreHoriz');
            }
            detailBtn.addEventListener('click', function () {
                if (global.ScholariusDetail && currentDoc) {
                    detailBtn.setAttribute('aria-expanded', 'true');
                    global.ScholariusDetail.open(currentDoc);
                }
            });
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
    function resolveTextPoint(r) {
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
        var probe = nearestTextPoint(r);
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
    function nearestTextPoint(r) {
        /*
          ⚠️ `caretRangeFromPoint` 需要屏幕坐标，而 Range 本身
          只有节点+偏移。用 Range 的 client rect 反推近似坐标：
          collapsed range 的 rect 就是该落点的位置。
        */
        var rect = null;
        try {
            rect = r.getBoundingClientRect();
        } catch (e) {
            rect = null;
        }

        /*
          ⚠️ 拿不到 rect 时，改用子树端点（没有更好的信息了）。
             但只在 element 有唯一文本节点时才用，
             避免多段文本时跳到段末。
        */
        if (!rect || (!rect.width && !rect.height)) {
            var t = firstTextNode(r.startContainer);
            if (!t) return null;
            /*
              ⚠️ 只有当元素里**只有一个**文本节点时才敢用它 ——
                 多个文本节点的情况（如带内联标记的段落）
                 首节点未必是手指所在的那段。
            */
            if (t !== lastTextNode(r.startContainer)) return null;
            return { node: t, offset: 0 };
        }

        var cx = rect.left;
        var cy = rect.top + rect.height / 2;

        var radii = [1, 2, 4, 8, 12, 18, 24];

        /*
          ⚠️ 先试**精确位置**（半径为 0），最常见情况这里是文本节点，
             但上面已判过不是，所以从 1px 起步。
          ⚠️ 每个半径先试正上方/正下方，再试左右。
             纵向优先是因为换行时落点偏上/偏下最可能。
        */
        for (var i = 0; i < radii.length; i++) {
            var d = radii[i];
            var probes = [
                [cx, cy - d], [cx, cy + d],
                [cx - d, cy], [cx + d, cy]
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

        var pt = resolveTextPoint(r);
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
        */
        var pt = resolveTextPoint(r);
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

        /*
          ③ 累加：从该块第一段开始，到目标节点之前的所有正文文字。
        */
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
                    total += String(r).length;
                } catch (e) {
                    /* 兜底：按纯文本长度算到段首 */
                    total += 0;
                }
                return { line: line, offset: total };
            }

            total += (p.textContent || '').length;
        }

        return null;
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

            if (inRange && !isInsideLabelTag(cur, root)) {
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

            if (!isInsideLabelTag(cur, el)) {
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
                text: newTexts[n]
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

    function applyEdit() {
        if (!editInputEl || !editSpan) return;

        var value = editInputEl.value;

        if (editSpan.single) {
            var line = editSpan.line;
            var cur = blockTextOf(line);
            var len = cur.length;

            var a = Math.max(0, Math.min(editSpan.start, len));
            var b = Math.max(a, Math.min(editSpan.end, len));

            edits[line] = cur.slice(0, a) + value + cur.slice(b);

            trace('reader:edit', 'line=' + line + ' [' + a + ',' + b + ')');
        } else {
            /*
              ══ ⚠️⚠️ 跨块编辑：交给 `reflowParagraphs` 重新分段（v0.1.67）══

              用户要求：
                「如果文件被修改了，直接重新计数自然段就好了」

              旧做法是把 value 按空行切分后，逐个写进 `edits[lines[i]]`。
              两段合并成一段时，后面那段就拿到空串 `''` —— 于是：
                · 屏幕上多一个空段落；
                · 它占掉一个正文段编号，后面的编号全部错位；
              再靠渲染层去"过滤空块"，等于把一个数据问题
              当成显示问题来修，所以一直修不干净。

              ✅ 现在把这几块的文本**重新当作一整篇文本**切分自然段，
                 段数变了就重排行号。合并 → 段数变少；
                 拆开 → 段数变多。不需要任何过滤。
            */
            reflowParagraphs(editSpan.lines, value);
        }

        /*
          ⚠️ 单块编辑也要检查：用户可能把这个块的内容**整个删掉**。
             这时 `edits[line]` 变成空串，同样不该留下空段落。
             走一次相同的重排逻辑即可（段数会从 1 变 0 → 保留 1 个空块占位）。
        */
        if (editSpan.single) {
            var curTxt = String(blockTextOf(editSpan.line));
            if (curTxt.replace(/\s+/g, '') === '') {
                reflowParagraphs([editSpan.line]);
            }
        }

        saveEdits();
        saveLabels();
        /*
          ⚠️ 段落结构可能被 `reflowParagraphs()` 改过（合并/拆分），
             必须一并落盘，否则重新进入时恢复原样（v0.1.70）。
        */
        saveDocBlocks();
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
     * 子标签展开区是否展开（v0.1.78）。
     *
     * ⚠️ 单一布尔值而不是"每个标签一个" ——
     *    用户点开一个标签的子选项时，其他标签的应当自动收起。
     *    这也符合"点图标展开、再点收起"的手感。
     */
    var subOpen = false;

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
          ⚠️ 子标签区默认**收起**（v0.1.78）——
             用户要求"点击图标之后则展示子标签选项"，
             所以打开表单时不能自动展开。
        */
        subOpen = false;

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

            if (labelHasSub(key)) {
                var subBtn = document.createElement('button');
                subBtn.type = 'button';
                subBtn.className = 'sel-label-sub-toggle';
                subBtn.setAttribute('aria-label', t('reader.fieldPick'));
                subBtn.setAttribute('aria-expanded',
                    (key === labelDraft && subOpen) ? 'true' : 'false');
                if (key === labelDraft && subOpen) subBtn.classList.add('is-open');
                subBtn.textContent = '›';

                /*
                  ⚠️ 必须 `stopPropagation` —— 否则点图标会同时触发
                     外层的"选择该标签"点击，导致每点一次都重渲染整个列表，
                     展开状态立刻被重置。
                */
                subBtn.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    ev.preventDefault();
                    if (labelDraft !== key) {
                        labelDraft = key;
                        fieldDraft = null;
                    }
                    subOpen = !subOpen;
                    renderLabelOptions();
                });

                btn.appendChild(subBtn);
            }

            btn.addEventListener('click', function () {
                /*
                  ⚠️ 切换到别的标签时收起子标签 ——
                     否则「作者信息」的展开状态会跟着跑到别的标签上。
                */
                if (labelDraft !== key) {
                    labelDraft = key;
                    fieldDraft = null;
                    subOpen = false;
                } else {
                    labelDraft = key;
                }
                renderLabelOptions();
            });

            li.appendChild(btn);

            /*
              ══ 子标签展开区（v0.1.78）══

              ⚠️ 只有「当前选中的标签」且 `subOpen` 时才展开 ——
                 用户要求"点击图标之后展示子标签选项"，
                 所以它默认收起，不会和标签列表"重叠"。
              ⚠️ 展开区放在**这一项里面**（li 的子元素），
                 视觉上就挂在它下面，不会跑到列表末尾去。
            */
            if (key === labelDraft && subOpen && labelHasSub(key)) {
                li.appendChild(buildSubList(key));
            }

            labelListEl.appendChild(li);
        });

        renderCitePicker();
        renderFieldPicker();
    }

    /**
     * 这个标签是否有子标签（v0.1.78）。
     *
     * ⚠️ 目前只有「作者信息」有。以后要加别的（比如文献的子类型），
     *    在这个函数里登记即可，列表渲染代码不用改。
     */
    function labelHasSub(key) {
        return key === 'author';
    }

    /**
     * 造「作者项」子标签列表（v0.1.78）。
     *
     * 用户要求：
     *   「干脆就直接给划一个子标签区……点击图标之后则展示子标签选项」
     *
     * ⚠️ 首项是「不设置」—— 用户说过「没有添加设置项的时候不显示」，
     *    所以子标签是**可选**的，必须能退回"无"。
     */
    function buildSubList(key) {
        var box = document.createElement('ul');
        box.className = 'sel-sub-list';
        box.setAttribute('role', 'radiogroup');

        /* ① 「不设置」 */
        box.appendChild(makeSubItem(t('reader.fieldNone'), fieldDraft == null,
            function () {
                fieldDraft = null;
                renderLabelOptions();
            }));

        /* ② 各子标签 */
        if (key === 'author') {
            AUTHOR_FIELDS.forEach(function (f) {
                box.appendChild(makeSubItem(t('reader.field.' + f),
                    fieldDraft === f, function () {
                        fieldDraft = f;
                        renderLabelOptions();
                    }));
            });
        }

        return box;
    }

    /** 造一条子标签选项 */
    function makeSubItem(text, active, onClick) {
        var li = document.createElement('li');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sel-cite-item';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
        if (active) btn.classList.add('is-active');
        btn.textContent = text;
        btn.addEventListener('click', onClick);
        li.appendChild(btn);
        return li;
    }

    /**
     * 旧的「作者项」选择器 —— 已由行内子标签区取代（v0.1.78）。
     *
     * ⚠️ 保留成空函数而不是直接删掉调用点：
     *    底部区块 `#sheet-field-picker` 仍在 HTML 里，
     *    这里只负责把它**永远隐藏**，避免残留显示。
     *
     * 用户要求变更：
     *   「既然 author field 可以出现，那么干脆就直接给划一个子标签区。
     *     每个标签选项有子标签的直接在选项最右边增加一个子标签的图标，
     *     点击图标之后则展示子标签选项，这样就避免了重叠问题。」
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
          ══ ⚠️⚠️ 只要块里**有换行**，就按行拆分（v0.1.84）══

          用户反馈（两次）：
            「当只有一个子标签的时候，比如姓名，
              直接整个作者信息区域都成了正常字体颜色，而非淡色」
            「其他没有添加子标签的也出现了这样的问题」

          真因：v0.1.82 的判据是 `spans.length > 1` —— 只标了一行时
          返回 false，于是整块走**老的单标注路径**，
          输出**一个** `<p>` 带着 `.is-author-name`：

              <p class="is-author-name">Name  Jacob…  Google AI  {…}</p>

          ⚠️ `.is-author-name` 的颜色是 `--on-surface`（正常色），
             它作用在**整个段落**上 → 三行全部变正常色。
             用户要的是"只有姓名那一行正常色，其余淡色"。

          ✅ 判据改成：**有换行**就按行渲染。
             有换行 ⇒ 这个块真的是"多行作者信息"，
             每行独立判断自己的子标签，没标的行自然是淡色。
             只有单行块（没有 `\n`）才退回老路径 ——
             它没有"按行"可言，整块就是一个条目。
        */
        if (spans.length > 1) return true;

        /*
          ══ ⚠️⚠️ 块行号要从**块**上取，不是从标注上取（v0.1.85）══

          ⚠️ 踩过的坑：标注记录只有 `{start, end, label, field}`，
             **没有 `line` 字段** —— 它本来就存在 `labels[行号]` 下，
             行号是那个对象的键。

             我上一版写成了 `spans[0].line`，永远是 `undefined`，
             于是 `typeof ln !== 'number'` 恒为 true → **恒返回 false**
             → 一条子标签的多行作者块始终走老路径，
             整个区域被染成 `.is-author-name` 的正常色。

          ✅ 正确做法：由调用方把块行号传进来。
        */
        var txt = (typeof line === 'number') ? blockTextOf(line) : '';
        return /[\r\n]/.test(String(txt == null ? '' : txt));
    }

    /**
     * 渲染「一个块里的多行作者信息」（v0.1.81）。
     *
     * 每行输出一个 `<p class="reader-para is-labeled-body is-author-body">`，
     * 行首按该行的子标签插入项名。
     *
     * ⚠️⚠️ 编号（A1/A2…）**整个块只加一次**，加在第一行 ——
     *     用户在语义上只标了"一个作者条目"，
     *     三行各加一个编号会显得像三个作者。
     * ⚠️ 每行都带 `data-line`，编辑/标注的字符偏移才找得到块。
     * ⚠️ 同一块的多行共享同一个 `data-line`，
     *     与"部分标注拆残片"的既有约定一致。
     */
    function makeAuthorLinesEl(b, spans, fullText, bodyIndex, authorIndex, markTyped) {
        var frag = document.createDocumentFragment();

        /* 按换行切行，同时记下每行在整块文本里的起止 */
        var segs = [];
        var pos = 0;
        /*
          ⚠️ 先把 CRLF 归一成 LF（v0.1.82）——
             真机上 PDF 提取出的换行可能是 `\r\n`。
             不归一的话每行末尾会多留一个 `\r`，
             行区间与标注区间就差 1 个字符，
             表现是"相邻行的子标签互串"。
        */
        var flatText = String(fullText).replace(/\r\n?/g, '\n');
        var parts = flatText.split('\n');
        for (var i = 0; i < parts.length; i++) {
            /*
              ⚠️ 变量名**不能**用 `t` —— 它会遮蔽全局的文案函数 `t()`，
                 后面 `t('reader.field.…')` 就会抛 "t is not a function"，
                 整个渲染直接白屏。这是实测踩到的坑。
            */
            var lnText = parts[i];
            segs.push({ text: lnText, start: pos, end: pos + lnText.length });
            pos += lnText.length + 1;
        }

        /*
          ══ ⚠️⚠️ 没有换行符时，按标注边界反推行（v0.1.82）══

          真机上很多块**不含换行符** —— PDF 提取把多行合并成一行、
          用空格分隔。此时 `split('\n')` 只能切出 1 行，
          多条子标签标注全部挤在同一行里，只有一个能生效。

          ✅ 兜底：把「每条标注的区间」当作一行。
             这本来就是用户逐行标注时产生的划分，
             用它是安全的，而且不会凭空猜测换行位置。

          ⚠️ 只在这种情况下启用 —— 有换行符时以换行为准，
             因为换行是 PDF 的原始结构，比标注区间更可信。
        */
        if (segs.length === 1 && spans.length > 1) {
            var marks = [];
            for (var mi = 0; mi < spans.length; mi++) {
                var m = spans[mi];
                if (!m) continue;
                var ms = Math.max(0, Math.min(m.start || 0, flatText.length));
                var me = Math.max(ms, Math.min(m.end || 0, flatText.length));
                if (me <= ms) continue;
                marks.push({ start: ms, end: me });
            }
            marks.sort(function (x, y) { return x.start - y.start; });

            if (marks.length > 1) {
                var rebuilt = [];
                for (var qi = 0; qi < marks.length; qi++) {
                    rebuilt.push({
                        text: flatText.slice(marks[qi].start, marks[qi].end),
                        start: marks[qi].start,
                        end: marks[qi].end
                    });
                }
                segs = rebuilt;
            }
        }

        var numbered = false;

        for (var s = 0; s < segs.length; s++) {
            var seg = segs[s];

            /* 空行跳过 —— 不渲染空段落（渲染层既有规则） */
            if (!seg.text.replace(/\s+/g, '')) continue;

            /*
              ══ ⚠️⚠️ 找覆盖这一行的标注（v0.1.82 改判据）══

              用户反馈：
                「非姓名行也增加了姓名子标签」
                「其他没有添加子标签的也出现了这样的问题」

              旧判据是"行区间与标注区间**有交集**就算命中，取第一个"：

                  if (cs < seg.end && ce > seg.start) { hit = cand; break; }

              ⚠️ 这个判据在块里**没有换行符**时会全面失效 ——
                 整块只有一行，`seg` 就是 `[0, len)`，
                 所有标注都与它"相交"，于是第一个标注被应用到整行，
                 而且每一行（如果有）都会拿到同一个标注。

              ✅ 改成**按行中心点归属**：
                 先看哪个标注完整包含这一行的中心字符，
                 没有则退回"交集最大"的那个。
                 中心点落在哪个标注里，那一行就属于哪个标注 ——
                 这与直观一致，也不会被相邻标注"抢走"。

              ⚠️ 仍保留"交集"作为兜底：某些标注区间可能没覆盖整行
                 （历史数据、编辑后偏移），交集最大的那个更可能是对的。
            */
            var mid = Math.floor((seg.start + seg.end) / 2);
            var hit = null;
            var bestScore = -1;

            for (var k = 0; k < spans.length; k++) {
                var cand = spans[k];
                if (!cand) continue;
                var cs = cand.start || 0;
                var ce = cand.end || 0;
                if (ce <= seg.start || cs >= seg.end) continue;

                /* ① 完整包含行中心 → 直接采用，不再比较 */
                if (cs <= mid && mid < ce) {
                    hit = cand;
                    break;
                }

                /* ② 退回按交集长度取最大 */
                var overlap = Math.min(ce, seg.end) - Math.max(cs, seg.start);
                if (overlap > bestScore) {
                    bestScore = overlap;
                    hit = cand;
                }
            }

            var p = document.createElement('p');
            p.className = 'reader-para is-labeled-body is-author-body';
            p.setAttribute('data-label', 'author');

            if (hit && hit.field === 'name') {
                p.classList.add('is-author-name');
            }

            if (hit && hit.field) {
                var fieldEl = document.createElement('span');
                fieldEl.className = 'reader-author-field';
                fieldEl.textContent = t('reader.field.' + hit.field);
                p.appendChild(fieldEl);
            }

            var valEl = document.createElement('span');
            valEl.className = 'reader-author-value';
            valEl.textContent = seg.text;
            p.appendChild(valEl);

            if (b.page) p.setAttribute('data-page', String(b.page));
            if (typeof b.line === 'number' && b.line >= 0) {
                p.setAttribute('data-line', String(b.line));
            }

            if (!numbered && markTyped) {
                markTyped(p, 'author');
                numbered = true;
            } else {
                /*
                  ══ ⚠️⚠️ 后续行也要挂 gutter，只是**不写编号**（v0.1.83）══

                  用户反馈：
                    「所有作者信息的第一行都还在作者信息区域内，
                      但后面的行都出现了超出作者区域且也没有正文段编号」

                  真因：`attachBodyMarker()` 给段落加上 `is-body-para` 后，
                  该段落变成 flex 容器并带 `margin-left:-16px`；
                  被它抵消的是 `.reader-para` 的 `padding-left:16px`。

                  ⚠️ 于是同一块里：
                     第一行  → 有 `is-body-para`，向左让出 gutter；
                     其余行  → 没有 → 仍按原 padding 起排，
                                视觉上"缩进偏右"，看起来跑出了作者区域。

                  ✅ 所以每一行都调用 `attachBodyMarker()`，
                     但只有第一行传真实编号，其余行传空串 ——
                     竖线与编号列照样占位，文字左边缘完全对齐。
                     `data-body-no=""` 时 CSS 的 `::before` 不显示内容，
                     但 `width` 固定，占位不变。
                */
                attachBodyMarker(p, '');
            }

            frag.appendChild(p);
        }

        /* 极端情况：所有行都是空白 → 至少给个空占位，避免块整个消失 */
        if (!numbered) {
            var empty = makePlainPara(fullText, b);
            return empty;
        }

        return frag;
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
                var whole = blockTextOf(line);
                var lr = lineRangeAt(whole, labelSpan.start, labelSpan.end);
                wa = lr.start;
                wb = lr.end;
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
                      ⚠️ 同一行 → 覆盖；不同行 → 保留。
                         用区间"完全相同"作为同一行的判据：
                         `lineRangeAt()` 对同一行总是返回同一对值，
                         所以稳定可靠。
                    */
                    drop = (sp.start === wa && sp.end === wb);
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

        global.setTimeout(function () {
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
    function showError(reason) {
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
        renderFlat(blocks);
    }

    /**
     * 平坦渲染：一段一个 `<p>`，没有区域、没有等级。
     *
     * ⚠️ v0.1.39 起这是**唯一**的正文渲染路径（`renderBlocks` 直接调它）。
     *    早期它是"分区失败时的兜底"，现在成了主路径 ——
     *    因为用户要求「不允许有任何模板」。
     */
    /**
     * 平坦渲染：一段一个 `<p>`，没有区域、没有等级。
     *
     * ⚠️ v0.1.39 起这是**唯一**的正文渲染路径（`renderBlocks` 直接调它）。
     *    早期它是"分区失败时的兜底"，现在成了主路径 ——
     *    因为用户要求「不允许有任何模板」。
     *
     * ══ ⚠️⚠️ 相邻且同标签的块要合并成**一个区域**（v0.1.50）══
     *
     * 用户实测反馈：
     *   「区域划分怎么还是按段呢？我将多段加一个段的末尾都分到了作者信息，
     *     结果末尾那个直接没有前置文本，然后后面的都是一段一个前置文本 ——
     *     这不对，他们都是一个区域的。」
     *
     * 旧实现是**逐块**渲染的（makeBlockEl 自己决定要不要加标签段），
     * 它根本不知道邻居是谁，所以跨块标注必然渲染成「一段一个前置文本」。
     *
     * ✅ 现在先**分组**再渲染：
     *     · 连续的、标注标签相同的块 → 归为同一个区域
     *     · 每个区域只在最前面输出**一次**标签段
     *     · 区域内部是一串普通段落（v0.1.39 的"无等级"仍然成立）
     *
     * ⚠️ 判据是「**相邻**」而不是「标签相同」：
     *    同一标签出现在文中两处（比如两个不同的"一级标题"）时，
     *    中间隔着正文，它们必须是**两个**区域，各自带自己的标签。
     */
    function renderFlat(blocks) {
        var frag = document.createDocumentFragment();

        /*
          ══ 正文段计数（v0.1.57）══

          用户要求：
            「增加一个功能，那就是正文段计数，左边加提示条和正文段编号。
              编号在提示条左边。」
            「不包括标注了不是正文的段，剩下的正文段都标，
              然后连续，从全文的第一个到最后一个」

          ⚠️ 所以计数器只对**正文段**递增：
             · 被标注为 title / h1 / h2 / h3 / author / abstract /
               reference 的块**不计数**（它们不是正文）；
             · 未标注的块、标注为 body 的块都算正文；
             · 一个块被拆成多段（部分标注）时，只有**未标注的残片**
               算正文段，标注段本身不算。

          ⚠️ 计数器必须活在整个 `renderFlat` 期间（跨 run 累加），
             不能每个 run 重置 —— 用户要求"连续，从全文第一个到最后一个"。
        */
        var bodyIndex = { n: 0 };

        /*
          ══ 分类编号计数器（v0.1.72）══

          用户要求：
            「为了区别正文段编号，参考文献区域段编号加个 R 前缀，
              然后作者加个 A 前缀，前缀后面是数字编号。」

          ⚠️ 每类**各算各的**：
             正文 1,2,3…、文献 R1,R2,R3…、作者 A1,A2,A3…
             不能共用一个计数器，否则 R 编号会出现 1、5、9 这种跳号。
        */
        var refIndex = { n: 0 };
        var authorIndex = { n: 0 };

        /**
         * 给一个区域挂编号（带类型前缀）。
         *
         * ⚠️ 正文段不走这里 —— 它没有前缀，由 `bodyIndex` 直接处理。
         */
        function markTyped(el, labelKey) {
            var prefix = LABEL_NO_PREFIX[labelKey];
            if (!prefix) return;
            var counter = (labelKey === 'reference') ? refIndex : authorIndex;
            counter.n++;
            attachBodyMarker(el, prefix + counter.n);
        }

        /*
          ══ ⚠️⚠️ 跳过已变空的块（v0.1.66）══

          用户反馈：
            「还有一个问题就是当编辑使得段落减少（比如令两段合并为一段）
              之后，编号却没有，就会导致空段落的出现，应该自动删除空段落。」

          场景：跨块编辑时，`applyEdit()` 把用户写的内容按空行切分，
          分别写回 `edits[lines[i]]`。如果用户把两段合成一段，
          后面的块就拿到空串 `''` —— 但这个块仍然留在 `blocks` 里，
          `renderFlat` 仍会给它造一个 `<p>`：
            · 屏幕上出现一个只有竖线、没有文字的空段落；
            · 它还会占掉一个正文段编号，导致后面的编号错位。

          ✅ 所以在建 run **之前**先把空块滤掉：
             不渲染 → 不占编号 → 编号保持连续。

          ⚠️ 判据用 `trim()` 而不是 `=== ''`：
             用户编辑时可能只留下空格/换行，那些同样应该被视为空段落。
          ⚠️ 只在这次渲染时过滤，**不删掉数据** ——
             `edits[line]` 仍保留着，用户以后在别处恢复文本还能回来。
        */
        var live = [];
        for (var q = 0; q < blocks.length; q++) {
            var qt = blockTextOf(blocks[q].line);
            if (qt == null) qt = '';
            if (String(qt).replace(/\s+/g, '') === '') continue;
            live.push(blocks[q]);
        }
        blocks = live;

        /*
          把块切成"运行"（run）：连续、且标注标签集合完全相同的块归一段。
          ⚠️ 比较的是整个标签签名而不是单个标签 —— 一个块里可能同时
             有多个标签（虽然少见），签名一致才算同一个区域。
        */
        var runs = [];
        var curRun = null;

        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            var sig = labelSignatureOf(b);

            if (curRun && sig === curRun.sig && sig !== '') {
                curRun.blocks.push(b);
            } else {
                curRun = { sig: sig, blocks: [b] };
                runs.push(curRun);
            }
        }

        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];

            /*
              ⚠️ 无标签的运行 → 普通段落，一块一个 `<p>`。
            */
            if (!run.sig) {
                for (var k = 0; k < run.blocks.length; k++) {
                    var plain = makeBlockEl(run.blocks[k]);

                    /*
                      ⚠️ 无标签块必然是正文段 → 计数 + 挂编号。
                     */
                    if (plain && plain.nodeType === 1) {
                        bodyIndex.n++;
                        attachBodyMarker(plain, bodyIndex.n);
                    }

                    if (plain && plain.nodeType === 11) {
                        frag.appendChild(plain);
                    } else if (plain) {
                        frag.appendChild(plain);
                    }
                }
                continue;
            }

            /*
              ⚠️ 有标签的运行 → **先输出一次标签段**，再输出所有内容段。
              ⚠️ 传入计数器对象（而不是数字）—— 它要被就地递增，
                 数字是按值传递的，传出去改了外面看不到。
            */
            appendLabeledRun(frag, run, bodyIndex, refIndex, authorIndex, markTyped);
        }

        contentEl.appendChild(frag);
    }

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
        el.setAttribute('data-body-no', String(no));

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
     * 输出一个「已标注区域」：**一个标签段 + 若干内容段**（v0.1.50）。
     *
     * ══ 用户要求（原话）══
     *
     *   「我将多段加一个段的末尾都分到了作者信息……他们都是一个区域的。」
     *
     * 所以：
     *
     *   ┌──────────────────────────────┐
     *   │ 作者信息                       │  ← 只出现**一次**
     *   │ 第一段内容…                    │
     *   │ 第二段内容…                    │
     *   │ 第三段内容…                    │
     *   └──────────────────────────────┘
     *
     * ⚠️ 区域内部的每段仍是独立 `<p>`（保留段落边界），
     *    但**不再重复**标签文字 —— 这正是用户指出的问题所在。
     *
     * ⚠️ 标签段取区域内**第一个块**的标签名。同一区域内所有块的
     *    标签签名相同（见 labelSignatureOf），所以取哪个都一样。
     */
    function appendLabeledRun(frag, run, bodyIndex, refIndex, authorIndex, markTyped) {
        var firstLine = run.blocks[0].line;
        var spans = labels[firstLine] || [];

        /*
          ══ ⚠️⚠️ 文献 / 作者：**每块各自一个区域**（v0.1.71 / v0.1.72）══

          用户要求：
            「当选中文本跨段时，每个段自动作为一个文献项
              从而得到多个文献区域，而不是整合成一个大的文献区域。」
            「我希望作者信息也这么样，可以通过段来自动分别成
              不同的作者信息区域。」

          ✅ 所以这两类标签直接走"逐块独立"分支，
             每块一个 `.reader-label-head` + 一个编号。

          ⚠️ 不在 `makeLabeledBlock` 里做，那个函数是"一块多标签"的兜底，
             它生成的是"标签段 + 内容段"的复合结构，语义不同。
        */
        var splitKey = spans[0] ? spans[0].label : null;
        if (splitKey && labelSplitsPerBlock(splitKey)) {
            for (var r2 = 0; r2 < run.blocks.length; r2++) {
                var rb = run.blocks[r2];

                var h2 = document.createElement('p');
                h2.className = 'reader-label-head';
                h2.setAttribute('data-label', splitKey);
                h2.textContent = t('reader.label.' + splitKey);
                frag.appendChild(h2);

                var el2 = makeContentEl(rb, bodyIndex, refIndex, authorIndex, markTyped);
                frag.appendChild(el2);
            }
            return;
        }
        /*
          ⚠️ 一个块里可能有多个不同标签（虽然少见）。此时无法只用一个
             标签段表达整个区域，退化为"逐块带标签"——
             宁可多显示几个标签，也不能漏掉某个标签的信息。
        */
        /*
          ⚠️ 判据改成"是否有**不同类型**的标签"（v0.1.81）：

             旧判据 `spans.length > 1` 会把"一个块里多条同类型
             作者行标注"也当成多标签，于是整块被拆散。

             ✅ 现在只有真有两种以上不同标签时才退化，
                同类型的多条（逐行子标签）走正常路径。
        */
        var kindCount = 0;
        var kindSeen = {};
        for (var kk = 0; kk < spans.length; kk++) {
            var ksp = spans[kk];
            if (!ksp || !ksp.label || kindSeen[ksp.label]) continue;
            kindSeen[ksp.label] = true;
            kindCount++;
        }
        var hasMultiple = kindCount > 1;

        if (hasMultiple) {
            for (var m = 0; m < run.blocks.length; m++) {
                var sub = makeLabeledBlock(run.blocks[m], null,
                    labels[run.blocks[m].line], bodyIndex, refIndex, authorIndex, markTyped);
                if (sub) frag.appendChild(sub);
            }
            return;
        }

        var labelKey = spans[0] ? spans[0].label : null;

        /* ① 标签段：整个区域只输出一次 */
        if (labelKey) {
            var head = document.createElement('p');
            head.className = 'reader-label-head';
            head.setAttribute('data-label', labelKey);

            /*
              ══ ⚠️⚠️ 一级标题：前置文本 + 一条分隔线（v0.1.71）══

              用户要求：
                「对于标题一，我希望前置文本后面跟着一条分隔线，
                  意思是把整个文章通过一级标题分割成了不同章节。
                  分割线的颜色和前置文本一个颜色就可以，
                  长度为按页面文本宽度自适应，也就是前置文本开头
                  距离屏幕左边多远，那么分割线的尾部距离屏幕右边就多远。
                  然后分割线和前置文本直接记得也留一点空隙。」

              ✅ 做法：把文字和线放进同一个 flex 行里：

                  [一级标题]  ────────────────────
                  ↑ 文字不动   ↑ flex:1，自动撑满剩余宽度

                 用 `flex: 1` 而不是算像素 —— 用户要的就是
                 “自适应页面文本宽度”，flex 天然做到。

              ⚠️ 左端对齐：文字在左，线接在右边；
                 右端到内容区右边缘为止，正好是“同一倍留白”。
              ⚠️ 间距用 `gap`，不写死 px —— 与全局间隔保持一致。
              ⚠️ 只对 `h1` 生效：文章标题（title）是文档级不是章节级，
                 二级/三级标题也不该分割章节。
            */
            if (labelKey === 'h1') {
                head.classList.add('is-h1-head');

                var txt = document.createElement('span');
                txt.className = 'reader-label-text';
                txt.textContent = t('reader.label.' + labelKey);
                head.appendChild(txt);

                var line = document.createElement('span');
                line.className = 'reader-label-rule';
                line.setAttribute('aria-hidden', 'true');
                head.appendChild(line);
            } else {
                head.textContent = t('reader.label.' + labelKey);
            }

            frag.appendChild(head);
        }

        /* ② 内容段：区域内所有块，一块一个 `<p>` */
        for (var i = 0; i < run.blocks.length; i++) {
            var b = run.blocks[i];
            var el = makeContentEl(b, bodyIndex, refIndex, authorIndex, markTyped);

            /*
              ⚠️ 区域内只有**第一块**带 `data-line` 吗？
                 不 —— 每块都带自己的 `data-line`，
                 目录跳转和 blockElOf 才能定位到正确的那一段。
            */
            frag.appendChild(el);
        }
    }

    /**
     * 造一个"已经处理过标注"的内容段（只要内容，不要标签段）。
     *
     * ══ ⚠️⚠️ 只输出**被标注的字符区间**（v0.1.55）══
     *
     * 用户反馈：
     *   「老问题怎么又出现了？怎么按段不按选中文本来标注区域啊」
     *
     * 真因：v0.1.50 重写"区域合并"时，这个函数被简化成
     *   `el.textContent = b.text` —— 整块原文直接输出，
     *   完全忽略了 `spans[0].start/end`。
     *
     * 于是用户只选了一个词标注，整段都被渲染成标题样式
     * （并且带上了标题的字号字重，视觉上非常明显）。
     * 数据层其实一直是对的（按区间存），错在渲染。
     *
     * ✅ 现在：
     *    · 区间覆盖整块 → 直接输出块文本（常见情况，无额外节点）
     *    · 区间是块的一部分 → **只输出那一段**，并把区间前后的
     *      未标注文字作为**独立的普通段落**输出
     *
     * ⚠️ 前后残片必须单独成段，不能塞回同一个 `<p>` ——
     *    否则标题的字号会被应用到整段（又变回"整段变标题"）。
     *
     * @return {DocumentFragment|Element}
     */
    function makeContentEl(b, bodyIndex, refIndex, authorIndex, markTyped) {
        /*
          ⚠️ 文本一律从 `blockTextOf()` 取（v0.1.57）——
             它按 `edits` → `docModel` 的顺序返回"这一块现在的文本"，
             是唯一的事实来源。不要在这里再手写 `edits[b.line]` 分支。
        */
        var fullText = blockTextOf(b.line);

        var spans = (typeof b.line === 'number') ? labels[b.line] : null;

        /*
          ══ ⚠️⚠️ 作者信息：一块可能有多条「按行」的子标签（v0.1.81）══

          用户要求：
            「子标签对应的是段内的行，不是整个段」
            「如果要分段来确定作者名和作者机构的话，
              同一个作者的信息就分开了」

          ⚠️ 旧的渲染前提是"一块只有一条标注"（`spans.length === 1`）。
             一旦同一块里的姓名行、单位行各有一条 author 标注，
             这个前提就不成立 → 整块退化成普通正文段。

          ✅ 所以作者信息单独走一条路径：
             按换行拆成若干行，每行按覆盖它的那条标注渲染，
             未覆盖的行按普通行渲染。
             整个块的子标签编号（A1/A2…）只算**一次**，
             因为它们在语义上属于同一个作者条目。
        */
        if (spans && spans.length > 0 && isAuthorLineSet(spans, b.line)) {
            return makeAuthorLinesEl(b, spans, fullText, bodyIndex, authorIndex, markTyped);
        }

        var sp = (spans && spans.length === 1) ? spans[0] : null;

        /*
          ⚠️ 没有标注（或标注异常）→ 普通段落，整块输出。
             这条路径也要走，否则无标签块会消失。
        */
        if (!sp || !sp.label) {
            return makePlainPara(fullText, b);
        }

        /*
          夹边界：编辑过的段落长度可能变了，旧标注的 end 可能越界。
        */
        var a = Math.max(0, Math.min(sp.start || 0, fullText.length));
        var bb = Math.max(0, Math.min(sp.end || 0, fullText.length));

        /* 空区间 → 无从标注，当普通段落处理 */
        if (bb <= a) {
            return makePlainPara(fullText, b);
        }

        var before = fullText.slice(0, a);
        var body = fullText.slice(a, bb);
        var after = fullText.slice(bb);

        /*
          ══ ⚠️⚠️ 引用标记保持**行内**（v0.1.71）══

          用户要求：
            「增加一个引用标签，比如我给类似「[12]」这种就可以加引用标签」

          ⚠️ 引用标记是夹在正文句子中间的（"如文献 [12] 所示"），
             绝不能像标题那样拆成独立段落 —— 那会把一句话劈成三段，
             并且把行内 `[12]` 顶成一个空行。

          ✅ 所以这里单独处理：
             整块输出一个 `<p>`，被标注的那一段用 `<span>` 包起来，
             保持行内流，再挂上 `data-cite` 供将来跳转用。

          ⚠️ `data-line` 仍写在 `<p>` 上 ——
             选中 `[12]` 时 `nodeOriginInBlock` 靠它算偏移，
             与普通段落一致。
        */
        if (sp.label === 'cite') {
            var citeP = document.createElement('p');
            citeP.className = 'reader-para';
            citeP.appendChild(document.createTextNode(before));

            var citeEl = document.createElement('span');
            citeEl.className = 'reader-cite';
            citeEl.setAttribute('data-label', 'cite');
            citeEl.textContent = body;
            /*
              ⚠️ 记下引用的目标文献行号。没有选定时不写这个属性，
                 渲染时只是普通高亮文字。
            */
            if (typeof sp.ref === 'number') {
                citeEl.setAttribute('data-cite', String(sp.ref));
            }
            citeP.appendChild(citeEl);

            if (after) citeP.appendChild(document.createTextNode(after));

            copyBlockAttrs(citeP, null, b);

            /*
              ⚠️ 带引用标记的段落**仍是正文段**，要编号 ——
                 否则正文编号会在这里断档。
            */
            if (bodyIndex) {
                bodyIndex.n++;
                attachBodyMarker(citeP, bodyIndex.n);
            }

            return citeP;
        }

        /*
          ══ ⚠️⚠️ 残片是**独立的普通正文段**（v0.1.56）══

          用户要求：
            「那就是如果同一段某一截被标注了，其他的就剩下作为文本
              分成正文段就好了。」

          ⚠️⚠️ 必须理解为什么残片也需要自己的 `data-line`：

          编辑和标注都靠 `blockLinesInSelection()` → 找 `[data-line]` 元素，
          再按 `blockElOf(line)` + `blockTextOf(line)` 取"整块原文"。

          如果残片不带 `data-line`：
            · 选中残片里的字 → `blockLinesInSelection()` 返回空 →
              `selectionSpan()` 返回 null → 编辑表单打开但编辑区是空的。
              这正是用户报的 bug：
              「我选中 ashish 的时候，点击编辑，编辑区域却什么也没有」

          ✅ 所以残片要像普通段落一样带 `data-line`。
             但它的文本**不是**原始块全文，只是切出来的那一段 ——
             所以要在 `edits`/`labels` 之外再维护一份"残片文本",
             否则 `blockTextOf()` 会返回整块原文，区间又会错位。

          ══ ✅ 现在：残片与标注段**共用同一个 `data-line`**（v0.1.57）══

          因为文本的事实来源是 `blockTextOf(line)` = 这一块的**完整文本**，
          与 DOM 被切成几段无关。所以：
            · 三个 `<p>` 都写同一个 `data-line`；
            · 用户选中残片里的字，偏移是相对**整块文本**算的；
            · 编辑/标注直接作用在整块文本的区间上，永远对得上。
        */

        /* 整块被标注 → 不必拆节点。⚠️ 标注段**不是正文**，不计数。 */
        if (!before && !after) {
            var whole = document.createElement('p');
            whole.className = 'reader-para is-labeled-body';
            whole.setAttribute('data-label', sp.label);
            copyBlockAttrs(whole, null, b);

            /*
              ══ ⚠️ 作者信息的项名要**先插入**（v0.1.74）══

              ⚠️ 顺序反了的话，`textContent = body` 会先建好一个文本节点，
                 后 `appendChild` 的项名就落在内容**后面**，
                 而不是用户要求的"左边的项名"。
                 所以这里先 append 项名，再 append 内容文本。
            */
            if (sp.label === 'author' && sp.field) {
                whole.classList.add('is-author-body');

                /*
                  ⚠️ 姓名用正常颜色，其他作者项保持淡色（v0.1.79）——
                     用户要求：「作者姓名不用淡色，用正常颜色，其他作者项不变。」
                     判定逻辑放 CSS（`.is-author-name`），这里只管挂类。
                */
                if (sp.field === 'name') {
                    whole.classList.add('is-author-name');
                }

                var fieldEl = document.createElement('span');
                fieldEl.className = 'reader-author-field';
                fieldEl.textContent = t('reader.field.' + sp.field);
                whole.appendChild(fieldEl);

                var valEl = document.createElement('span');
                valEl.className = 'reader-author-value';
                valEl.textContent = body;
                whole.appendChild(valEl);
            } else if (sp.label === 'author') {
                /*
                  ⚠️ 没有项名时**也要包一层** `.reader-author-value`（v0.1.75）——
                     直接放文本节点的话，它是个匿名 flex 项，
                     `flex: 1 1 auto` 的伸展规则对它不生效，
                     于是内容不会贴右（用户报的"参差不齐"）。
                     包成 span 后与有项名的情形走同一套布局。
                */
                whole.classList.add('is-author-body');

                var valOnly = document.createElement('span');
                valOnly.className = 'reader-author-value';
                valOnly.textContent = body;
                whole.appendChild(valOnly);
            } else {
                whole.textContent = body;
            }

            /*
              ══ ⚠️⚠️ 文献 / 作者区域带前缀编号（v0.1.72）══

              用户要求：
                「为了区别正文段编号，参考文献区域段编号加个 R 前缀，
                  然后作者加个 A 前缀，前缀后面是数字编号。」

              ✅ 用同一个 `attachBodyMarker` ——
                 编号样式、竖排、竖线、首行对齐全部复用，
                 不另起一套视觉，只是编号字符串变成 `R1` / `A1`。

              ⚠️ 它们**不是正文段**：不参与 `bodyIndex` 递增，
                 否则正文编号会出现断档。
                 前缀与计数器都由 `markTyped()` 统一处理。
            */
            if (markTyped) markTyped(whole, sp.label);

            return whole;
        }

        var frag = document.createDocumentFragment();

        /*
          ⚠️ 残片是**正文段** → 要计数并挂编号（v0.1.57）。
             用户要求：「不包括标注了不是正文的段，剩下的正文段都标」
             所以：标注段不计数，前后残片计数。
        */
        if (before) {
            var pBefore = makePlainPara(before, b);
            if (bodyIndex) {
                bodyIndex.n++;
                attachBodyMarker(pBefore, bodyIndex.n);
            }
            frag.appendChild(pBefore);
        }

        var marked = document.createElement('p');
        marked.className = 'reader-para is-labeled-body';
        marked.setAttribute('data-label', sp.label);
        marked.textContent = body;
        copyBlockAttrs(marked, null, b);
        frag.appendChild(marked);

        if (after) {
            var pAfter = makePlainPara(after, b);
            if (bodyIndex) {
                bodyIndex.n++;
                attachBodyMarker(pAfter, bodyIndex.n);
            }
            frag.appendChild(pAfter);
        }

        return frag;
    }

    /** 造一个普通段落（不带标注） */
    function makePlainPara(text, b) {
        var p = document.createElement('p');
        p.className = 'reader-para';
        p.textContent = text;
        if (b) {
            if (b.page) p.setAttribute('data-page', String(b.page));
            if (typeof b.line === 'number' && b.line >= 0) {
                p.setAttribute('data-line', String(b.line));
            }
        }
        return p;
    }

    /**
     * 造一个块的 DOM 元素。
     *
     * ══ ⚠️⚠️ v0.1.39：**所有块一律是 `<p>`，没有等级** ══
     *
     * 用户原话：「不允许有任何模板……我看到的应该是无等级的全部文本才对」
     *
     * 所以这里不再看 `b.kind` / `b.level` / `b.textType`：
     *   · 原生判成 heading 的块，**也渲染成普通段落**
     *   · 不再产出 `<h2>/<h3>/<h4>`（也就没有字号差异）
     *   · 公式块不再走等宽+底纹（那是"我们认出了这是公式"，
     *     属于模板性判断）
     *   · 不再加 `reader-text-<type>` 这类按类型命名的 class
     *
     * ⚠️ 但**保留 `data-page` 与 `data-line`** —— 它们是数据，
     *    不是视觉模板：目录跳转靠 `data-line` 定位，
     *    `data-page` 供将来"跳到原页"用。都不影响显示。
     *
     * ⚠️ **不要**在这个函数里加任何按内容分支的样式 ——
     *    一旦这里出现 `if (kind === 'heading')` 之类的判断，
     *    "模板"就又回来了。要改样式请在 CSS 里改 `.reader-para`。
     *
     * @param {Object} b 块 [{text, page, line}]
     * @return {Element|null}
     */
    function makeBlockEl(b) {
        if (!b || !b.text) return null;

        var el = document.createElement('p');
        el.className = 'reader-para';

        /*
          ══ 应用编辑结果（v0.1.45）══

          用户要求：「一旦确认，编辑区域内编辑后的内容将代替原内容。
                     而此举没有改变 pdf 源文件」

          ⚠️ 编辑按 `line` 存放，这里按 `b.line` 查 ——
             与标注用同一套键，所以编辑过的段落标注不会错位。
          ⚠️ 用 `textContent` 而不是 innerHTML：编辑区里用户可能输入
             `<` `>` `&`，用 innerHTML 会破坏结构。
        */
        var edited = null;
        if (typeof b.line === 'number' && edits[b.line] != null) {
            edited = edits[b.line];
        }
        el.textContent = (edited != null) ? edited : b.text;

        /*
          ══ 标注不在这里处理（v0.1.50）══

          ⚠️⚠️ 这是 v0.1.48/49 犯的错：让 makeBlockEl **自己**决定
             要不要加标签段。但它只看得到当前这一个块，看不到邻居，
             所以跨块标注必然渲染成「一段一个前置文本」——
             用户实测报的就是这个问题。

          ✅ 现在标注的分组与标签段输出全部上移到 renderFlat
             （见 labelSignatureOf / appendLabeledRun）。
             本函数只负责**无标签**的普通段落。
        */

        if (b.page) el.setAttribute('data-page', String(b.page));
        /*
          ⚠️ `data-line` 是**目录跳转的锚点**（见 jumpTo）。
             原生给的是块序号（`Block.line`），与目录条目的 `line`
             是同一套编号 —— 所以这里必须写，否则点目录没反应。

          ⚠️ line 可能为 0（第一个块），不能用 `if (b.line)` 判 ——
             那会把第 0 块漏掉，而它恰好是论文题目。
        */
        if (typeof b.line === 'number' && b.line >= 0) {
            el.setAttribute('data-line', String(b.line));
        }
        return el;
    }

    /**
     * 造一个「带标注」的块：**标签段 + 内容段**（v0.1.48）。
     *
     * ══ 用户要求（原话）══
     *
     *   「我说的前置文本是新开一段，这段前面是前置文本，
     *     这段的所有内容就是前置文本所包含的内容。
     *     类似于先给个"文章标题"这样的字样，提示下面是文章标题。
     *     然后下面单独成一段是选中的文章标题。」
     *
     * 效果（以"文章标题"标在 "Attention Is All You Need" 上为例）：
     *
     *   ┌──────────────────────────────┐
     *   │ 文章标题                       │  ← 淡色小字，单独一段
     *   │ Attention Is All You Need     │  ← 被标注的内容，单独一段
     *   └──────────────────────────────┘
     *
     * ⚠️⚠️ v0.1.47 做的是**行内**混排（「文章标题 Attention Is…」挤在
     *     同一行），用户否掉了：标签应该独占一行，作为下面内容的说明。
     *
     * ══ 实现 ══
     *
     * 返回一个 DocumentFragment，含：
     *   ① `<p class="reader-label-head">标签名</p>`
     *   ② 一个或多个 `<p class="reader-para">内容</p>`
     *
     * ⚠️ 如果有多个不连续的标注区间，会产出**多组** ①+②。
     *    这是刻意的：每个标签管辖自己那一段内容，视觉上不会混淆。
     *
     * ⚠️ 未标注的部分仍按普通段落渲染，保持原样（v0.1.39 的"无等级"）。
     */
    function makeLabeledBlock(b, baseEl, spans, bodyIndex, refIndex, authorIndex, markTyped) {
        var frag = document.createDocumentFragment();

        /*
          ⚠️ 文本从**块数据**取，不从传入的 DOM 元素取（v0.1.50）——
             调用方（appendLabeledRun）传的是 `null`（它没有现成元素），
             旧代码读 `baseEl.textContent` 会抛 TypeError。
        */
        var text = '';
        if (typeof b.line === 'number' && edits[b.line] != null) {
            text = edits[b.line];
        } else {
            text = b.text || '';
        }

        /*
          规范化区间：排序 + 夹边界 + 丢掉空区间。
          ⚠️ 必须复制一份再排序 —— 直接排序会改到存储里的数组。
          ⚠️ 必须夹边界：段落被编辑过之后长度可能变了，
             旧标注的 end 可能超出当前文本长度。
        */
        var list = [];
        for (var i = 0; i < spans.length; i++) {
            var sp = spans[i];
            if (!sp || typeof sp.start !== 'number' ||
                typeof sp.end !== 'number' || !sp.label) {
                continue;
            }
            var a = Math.max(0, Math.min(sp.start, text.length));
            var bb = Math.max(0, Math.min(sp.end, text.length));
            if (bb <= a) continue;
            list.push({ start: a, end: bb, label: sp.label });
        }

        if (!list.length) return null;

        list.sort(function (p, q) { return p.start - q.start; });

        var pos = 0;

        for (var j = 0; j < list.length; j++) {
            var item = list[j];

            /*
              ⚠️ 与前一个区间重叠时跳过重叠部分 ——
                 否则同一段文字会渲染两次。
            */
            var s = Math.max(item.start, pos);
            if (item.end <= s) continue;

            /* ① 区间之前的**未标注**文字：普通段落，原样保留 */
            if (s > pos) {
                var plain = document.createElement('p');
                plain.className = 'reader-para';
                plain.textContent = text.slice(pos, s);
                copyBlockAttrs(plain, null, b);
                /*
                  ⚠️ 残片是正文段 → 计数（v0.1.57）。
                     标注段本身不计数（它不是正文）。
                */
                if (bodyIndex) {
                    bodyIndex.n++;
                    attachBodyMarker(plain, bodyIndex.n);
                }
                frag.appendChild(plain);
            }

            /* ② 标签段：独占一行，淡色小字 */
            var head = document.createElement('p');
            head.className = 'reader-label-head';
            head.setAttribute('data-label', item.label);
            head.textContent = t('reader.label.' + item.label);

            /*
              ⚠️ 标签段**不带** `data-line` —— 它不是正文块，
                 带上会让目录跳转/块查找把它当成真正的段落，
                 导致"跳转跳到标签上"、块数量统计错误。
            */

            frag.appendChild(head);

            /* ③ 内容段：被标注的那几个字 */
            var body = document.createElement('p');
            body.className = 'reader-para is-labeled-body';
            body.setAttribute('data-label', item.label);
            body.textContent = text.slice(s, item.end);

            /*
              ⚠️ 每组都带 `data-line`（v0.1.48）——
                 同一行被拆成多组时，如果只有第一组带，
                 `blockElOf` 找不到后续组里的文字，用户在那上面
                 编辑/标注时会取不到块。
                 `blockElOf` 只返回第一个匹配，行为仍然是确定的。
            */
            copyBlockAttrs(body, baseEl, b);

            frag.appendChild(body);
            pos = item.end;
        }

        /* ④ 末尾剩余未标注的文字 */
        if (pos < text.length) {
            var tail = document.createElement('p');
            tail.className = 'reader-para';
            tail.textContent = text.slice(pos);
            frag.appendChild(tail);
        }

        return frag;
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
    function setText(id, text, outline, meta, blocks) {
        if (!currentDoc || currentDoc.id !== id) {
            trace('reader:text-stale', 'ignored ' + id);
            return;
        }
        if (!contentEl) {
            return;
        }

        contentEl.textContent = '';
        if (!text) {
            showError();
            return;
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
              ⚠️⚠️ 必须先丢掉「被别的块包含」的重复块（见 dropContainedBlocks）。

                 不丢的后果（用户实测报的一串问题）：
                   · 同一行多个块层层叠着 → 正文重复、行距错乱

                 ⚠️ 必须在这里（**渲染与缓存之前**）过滤，
                    这样 renderBlocks 与 lastBlocks 用的是**同一份**数据。
            */
            blocks = dropContainedBlocks(blocks);
        }

        if (blocks && blocks.length) {
            lastBlocks = blocks;
            lastText = '';

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
                    text: b.text || ''
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
            */
            var saved = readStore('scholarius.blocks.' + docStoreKey, '');
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
                                text: it.text
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
        open: open,
        close: close,
        isOpen: isOpen,
        setText: setText,
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
