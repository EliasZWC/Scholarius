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
    var viewToggleBtn = null;
    var annotateBtn = null;
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
    /** 当前视图：'reading' | 'raw' */
    var view = 'reading';
    /** 原始视图的文献总页数。0 表示还没问到 / 问不到 */
    var rawPageCount = 0;
    /** 原始视图里所有页的占位元素（按页码顺序），懒加载与清理都要用 */
    var pdfPageEls = [];
    /** 页图懒加载的观察器。切换视图/关闭阅读页时必须断开，否则会泄漏 */
    var pdfSpy = null;
    /**
     * 阅读视图的正文缓存。
     *
     * ⚠️ **必须缓存**：切到原始视图时 contentEl 的内容被图片顶掉了，
     *    切回来要能立刻恢复，不能重新向原生要一遍（那等于把整个 PDF
     *    再解析一次，几百毫秒到几秒）。
     *    两者只会有一个非空：有结构化块时存 blocks，否则存纯文本。
     */
    var lastBlocks = null;
    var lastText = '';

    /*
      ══ 用户标注（v0.1.17）══

      ⚠️⚠️ 两套机制，不能混为一谈。用户原话：
          「标题、摘要、作者肯定都是文本啊，可以选中；我说的不是框，
           而是类似选中的区域，框只能是方的，但区域可以根据文本来」

      | | `textMarks`（文本） | `regionMarks`（矩形） |
      |---|---|---|
      | 内容 | 标题/作者/摘要/正文/章节标题/脚注/参考文献/关键词 | 公式/表格/图片 |
      | 边界 | 由**文字自身**决定（行区间） | 手画**矩形** |
      | 操作 | **选中文字** → 指定类型 | 拖矩形 → 指定类型 |
      | 为什么 | 段落文本**不是矩形**，框不住 | 里面没有可选的文字 |

      ⚠️ **不要给文本加矩形框** —— 段落是不规则形状（标题居中、
         摘要两端对齐、正文有缩进），方框会框进旁边的栏/页眉。

      ⚠️ 两份都是**原生为准**：进阅读页时向桥拉一次，改完写回。
         localStorage 不存标注 —— 标注必须跟着 PDF 走（删文献一起删），
         存两份会出现「删了文献重建同 id 结果旧标注还在」。
    */
    /** 矩形标注：[{x0,y0,x1,y1,page,type}]，坐标归一化 0..1 */
    var regionMarks = [];
    /** 文本标注：[{from,to,type,level}]，from/to 是 0 起的全局行号 */
    var textMarks = [];
    /** 是否处于标注编辑模式（PDF 视图专属） */
    var annotating = false;
    /**
     * 本次编辑会话里**待保存**的改动是否非空。
     *
     * ⚠️ 退出编辑模式才写盘，不是每画一个框都写 ——
     *    手机上连续画十几个框，每个都跨桥写文件会明显卡。
     *    代价：进程被杀会丢未保存的改动。所以退出时必写，
     *    且关闭阅读页时也要写一次（见 close()）。
     */
    var annotateDirty = false;
    /** 编辑模式当前选中的**操作**（'text' | 'formula' | 'table' | 'figure'） */
    var annotateMode = 'text';

    /**
     * 区间选择的**起点**（null = 没在选区间）。`{line, text}`
     *
     * ⚠️ 为什么需要这个状态（实测逼出来的）：
     *    原生的 heading 判据把 ResNet 的**摘要切成 14 个交错的
     *    heading/paragraph 块**（块 7~20）。逐块点的话，
     *    用户要点 14 次、每次只覆盖一行，"把整段摘要标成摘要"
     *    这件事根本做不到。
     *
     *    于是：点第一下 = 设起点并选类型；点第二下 = 设终点，
     *    中间所有块一起归入该类型。
     *
     * ⚠️ 每次落笔 / 退出编辑模式都要清掉 —— 否则上一次的起点
     *    会悄悄影响下一次点选（用户完全看不出来为什么多标了一片）。
     */
    var rangeAnchor = null;

    /**
     * 「清空」悬浮按钮（FAB）。
     *
     * ⚠️ 它跟着**编辑模式**显示/隐藏（用户 2026-09-25：
     *    「清除用悬浮按钮，跟着唤醒菜单一起唤醒和隐藏」）。
     *    开关统一在 [syncBottomBar] 里处理 —— 不要在多处各写一遍，
     *    那个 bug 犯过（底栏与浮层状态不同步）。
     */
    var clearFabEl = null;

    /**
     * 目录条目：[{ level, title, line }]
     * line 是它在**原始提取文本**里的行号，跳转时据此定位。
     */
    var toc = [];
    /** 提取出的原始文本，按行拆好缓存在这里（跳转要算偏移） */
    var textLines = [];

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
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
        viewToggleBtn = document.getElementById('reader-view-toggle');
        annotateBtn = document.getElementById('reader-annotate');
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
        mountViewToggle();
        mountAnnotate();
        mountSelectionFab();
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
              ⚠️ 刚拖拽完的那个 click 是浏览器补发的，不是用户想切菜单。
                 必须吃掉 —— 否则每次画完框菜单都会跳一下。

              ⚠️ 与 justLongPressed 一样，这个标志会**自动过期**，
                 不会残留下来吞掉用户的下一次真实点击。
            */
            if (ui && typeof ui.justDragged === 'function' && ui.justDragged()) {
                return;
            }

            /*
              排除点在链接/按钮上的情况 —— 那些应该走自己的行为。
            */
            if (event.target.closest && event.target.closest('a, button')) {
                return;
            }

            /*
              ⚠️ 点在已有的框上 → 交给框自己处理（那是删除/编辑）。
                 不把这次点击当成切菜单，否则想改一个框却把菜单弹出来。
            */
            if (event.target.closest && event.target.closest('.anno-box')) {
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

            var rect = bodyEl.getBoundingClientRect();
            if (!rect.width || !rect.height) {
                return;
            }

            /*
              ⚠️ 原始视图**也**响应，但判定区放宽到整个正文区。

                 为什么放宽：原始视图里用户要选顶栏/底栏附近的文字，
                 而那里正好在"中间 1/3"之外；若还卡着 1/3，
                 顶部底部依旧唤不出菜单。
                 而"拖拽画框"已经被位移判据分流走了，不会误触。
            */
            if (view === 'raw') {
                toggleMenu();
                return;
            }

            /*
              ⚠️ 阅读视图里**同时**判横向与纵向都在中间 1/3。

                 阅读视图不需要画框，所以这里保留 1/3 ——
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

    // --- 原始 / 阅读 视图 ---------------------------------------------------

    /**
     * 顶栏视图切换按钮：绑事件 + 填图标。
     *
     * ══ 术语：为什么叫「阅读 / 原始」而不是「文本 / PDF」 ══
     *
     * 用户 2026-09-24 定的：
     *   · 阅读视图（reading）= 重排后的正文，用来**读**
     *   · 原始视图（raw）    = 出版方原始版面，用来**核对**
     *
     * 图标：visibility / visibility_off（用户选定）。
     *
     * ⚠️ 它们是**同一状态的两个面**（像"显示/隐藏"），
     *    所以按钮**不要点击特效**，也不要选中态底色 ——
     *    用户 2026-09-24：「二者类似于一个状态，所以不要有按钮的点击特效，
     *    直接切换图标就行」，随后又纠正：「你怎么还是做了阴影？
     *    我说了只转换图标本身」。
     *    见 styles.css 里 .reader-view-toggle 对 :active / [aria-pressed] 的覆盖。
     *
     * ⚠️ 两个图标**都要预先填进按钮**（一个显示、一个隐藏），
     *    切换时只切 hidden，不重建 innerHTML ——
     *    重建会让图标闪一下（浏览器要重新解析 SVG）。
     */
    function mountViewToggle() {
        if (!viewToggleBtn) {
            return;
        }

        var ui = global.ScholariusUI;
        if (ui && ui.icon) {
            /*
              ⚠️ 两个 <span> 各装一只图标，一次性建好，之后只切显示。
                 理由见上：覆盖式重建会闪。
            */
            viewToggleBtn.innerHTML =
                '<span class="reader-view-icon" data-view-icon="raw">' +
                ui.icon('visibilityOff') + '</span>' +
                '<span class="reader-view-icon" data-view-icon="reading">' +
                ui.icon('visibility') + '</span>';
        }

        viewToggleBtn.addEventListener('click', function () {
            setView(view === 'raw' ? 'reading' : 'raw');
        });

        syncViewToggle();
    }

    /**
     * 切换视图。
     *
     * ══ ⚠️ 原始视图是**网页里的一块内容**，不是另一层界面 ══
     *
     * 这个功能试过三种做法，前两种都失败了，全部记在这里别再走回头路：
     *
     * ① 网页里放 `<iframe src="https://.../pdf/<id>">`
     *    实测（用户 2026-09-24：「看不见 pdf」）：iframe 尺寸正常、
     *    URL 也真的发出去了，但**画面是空的**。
     *    根因：Android WebView 的内置 PDF 查看器是为**顶层文档**设计的，
     *    在子框架里不渲染。这是查看器的行为，不是我们代码错。
     *
     * ② 让原生对 WebView 顶层 loadUrl(PDF)（含另开一个覆盖层 WebView）
     *    用户反馈：「没有成功转换视图」→「转换视图直接黑屏了」
     *    →「但唤起菜单应该在 pdf 上面啊」。
     *    两次反馈指明了同一个结构性问题：
     *      · 顶层导航会把**整个界面**换掉，顶栏消失、切不回来；
     *      · 覆盖层 WebView 同样盖住我们自己的菜单，
     *        所以「在 PDF 里点中间唤起菜单」永远不可能实现。
     *    另外黑屏还有一层原因：内置查看器要发 **Range 请求**才能渲染，
     *    而 shouldInterceptRequest 只能给一整段流，给不出 206 分片。
     *
     * ③ 现在（正确）：**原生把页渲染成图片**（系统 PdfRenderer，见 PdfPages），
     *    网页把图片放进 `reader-content`。
     *    PDF 于是只是网页里的一块内容 ——
     *    **顶栏、底栏、设置面板、目录弹窗天然在它上面**，
     *    点中间唤起菜单也照常工作（bodyEl 的点击分区逻辑不用改）。
     *
     * ⚠️ 关键收益：不再有「离开网页」这回事 ——
     *    返回键、菜单、主题、i18n 全部沿用原有路径，不需要任何特例分支。
     *
     * @param {string} next 'reading' | 'raw'
     */
    function setView(next) {
        var want = (next === 'raw') ? 'raw' : 'reading';

        if (want === view) return;

        /*
          ══ ⚠️⚠️ 切视图时必须先退出编辑模式（2026-09-25 真机实测的真因）══

          症状（用户报的，三个问题是同一个根源）：
            1. 「无法拖拽形成框，整个选中功能不可用」
            2. 「单独框点开表单选择清除依旧无法清除」
            3. 「阅读视图没有按照更改后的框重新排版」

          真机抓到的矛盾状态：
              readerClass   : "reader is-open is-menu-open is-annotating"
              hasPageImg    : false     ← 不在原始视图
              hasReaderPara : true      ← 在阅读视图
              layers        : 0         ← **没有任何标注层**
              pressed       : "formula" ← 编辑栏还选着矩形模式

          真因：setAnnotating 里规定了「只有原始视图能进编辑模式」
          （`if (next && view !== 'raw') return;`），
          但那条守卫**只在进入时检查一次**。之后切视图时没有联动 ——
          用户点「视图切换」后：
            · teardownPdfScroll() 把页图连同标注层**全部销毁**
            · restoreReadingContent() 渲染正文
            · **但 annotating 仍是 true**、is-annotating 类还在、
              编辑栏还挂着、annotateMode 还是 formula

          于是用户处于一个"看起来在编辑模式、但页面上没有任何可编辑的东西"
          的状态 —— 想画框没层、想改框没层、阅读视图也不反映标注。

          ✅ 修法：离开原始视图就退出编辑模式。
             理由：进编辑模式本就要求原始视图，那两个状态必须一致；
             用户切到阅读视图的意图是"看正文"，不是"继续标注"。
             退出会走 setAnnotating(false) → 存盘 + 恢复底栏 + 清类。

          ⚠️ 必须在改 `view` **之前**退 —— 因为 setAnnotating 里的
             守卫会看 view；先改 view 再退虽然也能退出，
             但若将来守卫改成"raw 才能退出"就会卡住。
             这里显式调用，顺序依赖最小。
        */
        if (annotating) {
            setAnnotating(false);
        }

        view = want;
        syncViewToggle();

        if (want === 'raw') {
            showPdfScroll();
            return;
        }

        /*
          回到阅读视图：把正文重新渲染出来。

          ⚠️ 这里**必须重新渲染**，不能只把图片藏起来 ——
             原始视图把 contentEl 的内容整个换成了图片。
             用缓存的 blocks/text 重放一次最省事，
             不必再向原生要一遍文本（那要重新解析整个 PDF）。
        */
        teardownPdfScroll();
        restoreReadingContent();
    }

    /**
     * 原始视图：**连续滚动**显示全部页。
     *
     * ══ 为什么不做分页（用户 2026-09-24）══
     *
     * 用户原话：「直接滚动不就好了吗？为什么还要分页？
     *           pdf 阅读器不都是滚动的吗？」
     *
     * 完全正确。分页是我自己加的复杂度，而且代价不小：
     *   · 底部多一整行「上一页 / 页码 / 下一页」，手机上很占地方；
     *   · 每次翻页都要等原生渲染（100-300ms），翻快了会看到空白；
     *   · 想连续看两页之间的内容要来回按，而滚动是自然的。
     *
     * 主流阅读器（Chrome 内置、Adobe、各家 App）默认都是连续滚动，
     * 分页只在横屏/双栏这类特定场景才用。我们没有那个需求。
     *
     * ══ ⚠️ 但仍然不能「一次把所有页都取过来」══
     *
     * 一页 JPEG 的 base64 约 400KB。12 页就是 5MB 字符串跨桥传递 ——
     * 必然卡顿甚至 OOM（这正是我当初改成分页的原因，那个判断没错，
     * 错的是「所以只能分页」这个推论）。
     *
     * **正解：滚动容器铺好全部页的占位，按需加载。**
     *   · 先问总页数，为每页建一个占位框（用页图宽高比撑开正确高度，
     *     这样滚动条长度一开始就是对的，不会边滚边变长）；
     *   · 用 IntersectionObserver 观察每个占位框，
     *     进入视野（含前后各一页的余量）时才向原生要图。
     *
     * 这样既有连续滚动的体验，又永远只有几页图在内存里。
     */
    function showPdfScroll() {
        if (!contentEl || !currentDoc) {
            return;
        }

        var bridge = global.ScholariusNative;
        if (!bridge || typeof bridge.getPdfPage !== 'function') {
            /*
              ⚠️ 桥不可用（浏览器预览）→ 回退到阅读视图并提示。
                 不能停在一条永远不出现的原始视图上 ——
                 实测：预览里点这个按钮却什么都不发生最让人迷惑。
            */
            view = 'reading';
            syncViewToggle();
            showError('no-bridge');
            return;
        }

        var id = String(currentDoc.id);

        try {
            rawPageCount = bridge.getPdfPageCount(id) | 0;
        } catch (e) {
            rawPageCount = 0;
        }

        if (rawPageCount <= 0) {
            /*
              ⚠️ 问不到页数（加密 PDF / 文件损坏）要给**明确提示**，
                 不能留一片空白 —— 用户会以为界面坏了。
            */
            contentEl.textContent = '';
            var hint = document.createElement('div');
            hint.className = 'reader-hint';
            hint.textContent = t('reader.pageUnavailable');
            contentEl.appendChild(hint);
            trace('reader:raw', 'no pages');
            return;
        }

        contentEl.textContent = '';

        /*
          ⚠️ 先断开上一次的观察器再重建。
             直接 `pdfPageEls = []` 是不够的 —— 旧的 observer 仍然
             观察着那批旧元素，它们不会被回收。
        */
        teardownPdfScroll();

        var list = document.createElement('div');
        list.className = 'pdf-scroll';

        /*
          ⚠️ 先取**第 1 页**的宽高比，用同一比例给所有页占位。
             绝大多数 PDF 每页尺寸一致（少数混排的也能接受，
             真遇到时该页加载完会自己纠正高度）。

             ⚠️ 这一步要问原生要一次图才知道比例 —— 但**不能因此
                白白下载第 1 页两次**。所以第 1 页的图顺手留下，
                占位框建好后直接填进去（见下面的 seedData）。
        */
        var seed = '';
        var ratio = 1.414; // A4 默认（高 / 宽），拿不到比例时用
        try {
            seed = bridge.getPdfPage(id, 1) || '';
        } catch (e) {
            seed = '';
        }
        if (seed) {
            // 用第 1 页真实比例；万一取不到就退回 A4
            var probe = new Image();
            probe.src = seed;
            if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
                ratio = probe.naturalHeight / probe.naturalWidth;
            }
        }

        for (var p = 1; p <= rawPageCount; p++) {
            var slot = document.createElement('div');
            slot.className = 'pdf-slot';
            slot.setAttribute('data-page', String(p));
            /*
              ⚠️ 用 padding-top 百分比撑高度 ——
                 百分比 padding 是相对**宽度**算的，
                 所以容器宽度一变（转屏/分屏）高度自动跟着变，
                 不需要监听 resize 重算。这是纯 CSS 的等比占位技巧。
                 `--pdf-ratio` 由这里传入，真正的高度计算在 CSS 里。
            */
            slot.style.setProperty('--pdf-ratio', String(ratio));

            if (p === 1 && seed) {
                slot.appendChild(makePageImg(seed, p, id));
                slot.classList.add('is-loaded');
            }
            list.appendChild(slot);
            pdfPageEls.push(slot);
        }

        contentEl.appendChild(list);
        if (bodyEl) {
            bodyEl.scrollTop = 0;
        }

        startPdfLazyLoad(id);
        trace('reader:raw', rawPageCount + ' pages (scroll)');
    }

    /**
     * 在页图之上叠一层**透明文字**，让 PDF 上的字能被选中。
     *
     * ══ ⚠️⚠️ 为什么需要（用户 2026-09-25，反复反馈后说清）══
     *
     * 用户原话：
     *   「字体根本无法选中啊」
     *   「都是只能识别点击」「面对任何形式的拖拽都没有办法识别」
     *   「我说的是原始视图」
     *
     * 真因：原始视图的页面是 `PdfRenderer` 渲染出的 **JPEG 位图**，
     * 网页这边就是一个 `<img>` —— **位图里没有文字对象**，
     * 手指划过它，浏览器不知道该"选中"什么。
     *
     * 内置 PDF 查看器（PDFium）能选，但它**必须在顶层文档**渲染，
     * 会盖掉顶栏/底栏（见 MainActivity 里三次失败尝试的记录）。
     *
     * ✅ 本方案（Chrome / Adobe 阅读器也是这么做的）：
     *    在页图上面叠一层**真实的文字** ——
     *      · 位置与位图上的字严格重合（用原生给的归一化坐标）
     *      · `color: transparent` → 看不见，视觉上仍是原始版面
     *      · 但文字真实存在 → 手指划过能选中、能高亮、能复制
     *
     * ══ 坐标怎么用 ══
     *
     * 原生给的是**归一化**的 `x0/y0/x1/y1`（0..1，屏幕方向左上原点），
     * 且已经 clamp 过 —— 所以这里直接用百分比定位，
     * **不需要知道页面像素尺寸**，转屏/缩放都自动跟着变。
     *
     * 字号同理：`s` 是磅值，按"页面宽度对应多少 CSS px"换算成
     * 屏幕字号。不这么做的话，文字层的字与位图上的字大小不一致，
     * 选中高亮会偏。
     *
     * ⚠️ 为什么用 `font-size` 而不是 `transform: scale`：
     *    scale 会把字宽也缩放，而位图上的字宽由 PDF 排版决定，
     *    两者对不上时行尾会错位。直接给 font-size 让浏览器排版，
     *    再用 `letter-spacing` 微调，比缩放稳。
     *
     * ⚠️ 不做 `white-space: nowrap` 就会自动换行 ——
     *    而每一"行"的盒子是按位图上的实际宽度给的，
     *    换行会把文字挤到下一行、彻底错位。必须 nowrap。
     *
     * @param slot 页占位元素（.pdf-slot）
     * @param page 页码（从 1 开始）
     * @param id   文献 id
     */
    function mountTextLayer(slot, page, id) {
        var bridge = global.ScholariusNative;
        if (!bridge || typeof bridge.getPdfPageLines !== 'function') {
            return;
        }

        var raw = '';
        try {
            raw = bridge.getPdfPageLines(id, page) || '[]';
        } catch (e) {
            raw = '[]';
        }
        var lines;
        try {
            lines = JSON.parse(raw);
        } catch (e) {
            lines = [];
        }
        if (!lines || !lines.length) return;

        /*
          ⚠️ 已有文字层就先删掉 —— 本函数可能被重复调用
             （页图重新加载、切视图回来），不清会叠出两层，
             选中时拿到重复文字，复制出来是双份。
        */
        var old = slot.querySelector('.pdf-text-layer');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var layer = document.createElement('div');
        layer.className = 'pdf-text-layer';
        /*
          ⚠️ aria-hidden：这层是**给手指选中的**，不是给读屏的 ——
             读屏读的是网页的正文（阅读视图），
             这里再读一遍等于同一页读两遍。
        */
        layer.setAttribute('aria-hidden', 'true');

        var frag = document.createDocumentFragment();
        /*
          ⚠️⚠️ 每个词要知道自己属于**哪一行**（2026-09-25 新增）

          原生给的是**词**级盒子，但要"把选中的文字变成区域"就必须
          知道行号 —— 因为 `textMarks` 的粒度是**行**
          （`[{from, to, type}]`，from/to 是全局行号）。

          行怎么认：**按 y 坐标聚类**。
          PDF 里同一行的词 y0 几乎相同（实测差 < 0.001），
          换行时 y0 会跳一个行距（约 0.012）。
          所以给每个词按 y0 排序，相邻差超过半个行高就断成新行。

          ⚠️ 不能用"四舍五入到某位数"这种固定精度 ——
             不同 PDF 的行距差异很大（单栏论文 vs 双栏幻灯片），
             固定精度要么把两行并成一行，要么把一行拆成好几行。
        */
        var sorted = [];
        for (var k = 0; k < lines.length; k++) {
            var L0 = lines[k];
            if (!L0 || !L0.t) continue;
            if (!((L0.x1 - L0.x0) > 0) || !((L0.y1 - L0.y0) > 0)) continue;
            sorted.push(L0);
        }
        sorted.sort(function (a, b) {
            if (Math.abs(a.y0 - b.y0) > 0.0005) return a.y0 - b.y0;
            return a.x0 - b.x0;
        });

        /*
          ⚠️ 行归属的 y 容差：用**中位行高的一半**。
             取中位数而不是平均值 —— 页面上往往混着大标题（高）
             和正文（矮），平均值会被标题拉高，导致正文行互相吞并。
        */
        var heights = [];
        for (var h2 = 0; h2 < sorted.length; h2++) {
            heights.push(sorted[h2].y1 - sorted[h2].y0);
        }
        heights.sort(function (a, b) { return a - b; });
        var medH = heights.length ? heights[Math.floor(heights.length / 2)] : 0.012;
        var rowTol = medH * 0.5;

        var rowIdx = -1;
        var lastY = null;
        for (var i = 0; i < sorted.length; i++) {
            var L = sorted[i];
            var w = (L.x1 - L.x0);
            var h = (L.y1 - L.y0);

            if (lastY === null || Math.abs(L.y0 - lastY) > rowTol) {
                rowIdx++;
                lastY = L.y0;
            }

            var span = document.createElement('span');
            span.className = 'pdf-text-line';
            span.textContent = L.t;
            /*
              ⚠️ 记下"第几行"（页面内的行号，0 起）——
                 「建立区域」时要靠它换算成全局行号。
                 用 data-* 而不是 JS 变量：span 会被重新挂载
                 （切视图、懒加载重排），属性跟着 DOM 走最可靠。
            */
            span.dataset.row = String(rowIdx);
            span.style.left = (L.x0 * 100) + '%';
            span.style.top = (L.y0 * 100) + '%';
            span.style.width = (w * 100) + '%';
            /*
              ══ ⚠️⚠️ 字号：**直接用行盒子的高度**，不要用磅值换算 ══

              原生给的 `s` 是磅值，要变成屏幕字号就得知道
              "1pt 对应多少 CSS px" —— 那需要页宽（pt）与页面宽度（px），
              两个都不在数据里，硬换算要引入假设（"A4 宽 595pt"），
              遇到 Letter / 自定义版式就错。

              ✅ `y1 - y0` 就是**这一行字在页面上的实际高度占比** ——
                 它天然包含了字号、行距、缩放的全部信息。
                 设 `line-height: 1` 后，元素的 content box 高度
                 就等于 font-size，于是：
                      font-size = 盒子高度
                 不需要任何假设，跨 PDF、跨屏幕都成立。

              ⚠️ 为什么要 `line-height: 1`（见 CSS）：
                 默认 1.2 会让字比盒子**矮**一点，累积到行尾就偏了；
                 而高 DPI 屏上这点偏差正好是"选中的字与看到的字
                 错开半个字"的来源。
            */
            span.style.fontSize = (h * 100) + '%';
            frag.appendChild(span);
        }
        layer.appendChild(frag);
        slot.appendChild(layer);
        bindTextLayerPan(layer);
        bindTextLayerSelect(layer);
    }

    /**
     * 在文字层上接管**选字** —— 用 JS 自己维护选区。
     *
     * ══ ⚠️⚠️ 为什么不能让浏览器自己选（2026-09-25 真机实测）══
     *
     * 文字层要能选字，就必须把整条祖先链的 `touch-action` 锁成 `none`
     * （理由见 styles.css：`touch-action` 取祖先链交集，而 `.reader-body`
     *   是 `overflow-y: auto`，它会把手势判成滚动并发 `pointercancel`）。
     *
     * 但真机实测发现一个更根本的矛盾：
     *
     *     事件序列（tools/_seldiag.py）：
     *       pointerdown @76,655   → SPAN.pdf-text-line
     *       pointermove ×16        → SPAN.pdf-text-line   ← 全部到达
     *       pointerup @228,663    → SPAN.pdf-text-line
     *       滚动: 0 -> 0 （没滚）                          ← touch-action 生效
     *       但选区: len=0                                  ← ❌ 选不上
     *
     * `touch-action: none` 的语义是"**我自己**处理这些手势" ——
     * 浏览器于是**连选字都不做了**。而 `touch-action` 里
     * 没有"只允许选择、不允许滚动"这个值。
     *
     * ✅ 所以自己实现（PDF.js 也是这么做的）：
     *    `pointerdown` 记起点词 + 词内偏移 → `pointermove` 用
     *    `setBaseAndExtent` 更新选区 → `pointerup` 收尾。
     *
     *    实测 `setBaseAndExtent` 确实能产生真实选区（选中了 "R"），
     *    剩下的只是"把坐标算准"。
     *
     * ══ 怎么把屏幕坐标算成"第几个字的第几个字母" ══
     *
     * 原生给的每个条目是一个**词**（`Attention` / `Is` / `All`…），
     * 带归一化盒子。所以：
     *   ① 先在所有词里找**包含这个点**的那个（按 y 容差放宽，再按 x 最近）；
     *   ② 在该词的盒子里，按 (x - x0) / (x1 - x0) 比例 × 词长，
     *      得到词内第几个字符。
     *
     * ⚠️ 比例法是**近似**（等宽假设）—— 但：
     *     · 选中的粒度本来就是"视觉上连续的一段"，差一两个字符感知不到；
     *     · 精确做法要给每个字符量宽度（要再向原生要逐字坐标，
     *       DOM 与跨桥开销都上一个量级），不值得。
     *     · PDF.js 也用的是同一层次的近似。
     */
    function bindTextLayerSelect(layer) {
        var startPt = null;

        /** 把屏幕坐标变成 {node, offset} —— 即"第几个节点的第几个字符" */
        function pointToCaret(x, y) {
            var lines = layer.querySelectorAll('.pdf-text-line');
            if (!lines.length) return null;

            var best = null;
            var bestScore = Infinity;
            for (var i = 0; i < lines.length; i++) {
                var el = lines[i];
                var r = el.getBoundingClientRect();
                if (!r.width) continue;

                /*
                  ⚠️⚠️ y 容差必须**小于行距的一半**（2026-09-25 修）

                  第一版是 `max(height, 6) * 0.9`。实测这行高 8px → 容差 7.2px，
                  而论文行距只有约 9px —— 于是**相邻行也在容差内**，
                  横向拖一行时会不断命中上下邻行，最后选出 7 行。
                  用户看到的就是"涂了一大片"。

                  ✅ 改成 `height * 0.5`：只有手指明确落在本行的
                     上下半个行高内才算它。行距 9px、行高 8px 时
                     容差 4px < 行距一半 4.5px，**不会跨行**。

                  ⚠️ 下限 3px 而不是 6px：行高很小的页（缩略图式渲染）
                     仍要能被点中；3px 已足够吸收手指抖动。
                */
                var midY = r.top + r.height / 2;
                var dy = Math.abs(y - midY);
                var yTol = Math.max(r.height * 0.5, 3);
                if (dy > yTol) continue;

                /*
                  ⚠️ x 方向用"到盒子最近边缘的距离"而不是 contains ——
                     手指滑到行首左边一点时仍应落在这一行的开头，
                     而不是"什么也没选中"。
                */
                var dx = 0;
                if (x < r.left) dx = r.left - x;
                else if (x > r.right) dx = x - r.right;

                /*
                  ⚠️ y 权重必须**远大于** x（2026-09-25 修：原来是 dy*2）——
                     横向拖一行时，x 会跨过好几个词（每个词宽 20~30px），
                     而 y 只差 1~2px。若 y 权重不够，`dx` 大的邻行会赢，
                     行归属就飘了。
                     取 dy * 20：1px 的纵向差 ≈ 20px 的横向差，
                     保证"先按行归属、再按列远近"。
                */
                var score = dy * 20 + dx;
                if (score < bestScore) {
                    bestScore = score;
                    best = { el: el, rect: r };
                }
            }
            if (!best) return null;

            var node = best.el.firstChild;
            if (!node) return null;
            var len = node.nodeValue ? node.nodeValue.length : 0;
            if (!len) return null;

            /* ② 词内偏移：按 x 比例 × 词长（等宽近似） */
            var t = (x - best.rect.left) / (best.rect.width || 1);
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            var off = Math.round(t * len);
            if (off < 0) off = 0;
            if (off > len) off = len;

            return { node: node, offset: off, el: best.el, len: len, off: off };
        }

        /*
          ══ ⚠️⚠️ 高亮**自己画**，不用 `::selection`（2026-09-25 真机结论）══

          用户反馈：「一闪而过，和之前随机框一样」。

          实测（tools/_selvis.py）：手势结束后选区**确实还在**
          （`getSelection().toString().length === 47`，`rangeCount === 1`，
           且 3 秒后依然在），但**屏幕上看不到任何高亮**。

          → `::selection` 画的高亮在 Android WebView 上**松手就不绘制**了：
            选区数据还在，但只由系统层在"触摸激活"期间画，
            手指一抬就没了。CSS 改 `::selection` 的样式救不了。

          ✅ 所以改用真实 DOM：选中的行加个 `.is-selected` 类，
             由 CSS 给它一个真实的背景色。这样：
               · 高亮常驻可见（不依赖触摸状态）
               · 可以随时清掉（切页/换手势）
               · 后面要做"把选中变成区域"时，本来也需要自己持有这个状态
        */
        function clearHighlight() {
            var on = layer.querySelectorAll('.pdf-text-line.is-selected');
            for (var i = 0; i < on.length; i++) {
                on[i].classList.remove('is-selected');
                on[i].style.removeProperty('--sel-from');
                on[i].style.removeProperty('--sel-to');
            }
        }

        /*
          ⚠️⚠️ 高亮必须**精确到字符**，不能整行涂满（2026-09-25 真机修）

          第一版直接给选中的行加类 → 背景铺满**该词的整个盒子**。
          问题是拖 150px 时 `pointToCaret` 的 y 容差把相邻行也算进来，
          于是 7 行全涂 → 用户看到"选中了一大片"，而实际只想选几个词。

          但**真正的错**在于"按行"这个粒度本身：
          用户从 "Recurrent" 拖到 "sequences"，中间那些**行**不该整行高亮 ——
          应该只高亮**从起点字符到终点字符**那一段。

          ✅ 所以给每行两个 CSS 变量（`--sel-from` / `--sel-to`，0~1 的比例），
             由 `::before` 画一个**只在 [from, to] 区间**的色块：
               · 第一行：从起点比例到行尾
               · 中间行：整行
               · 最后一行：从行首到终点比例
             这样高亮形状与"文字被划过的范围"一致，而不是一堆整条横条。
        */
        function paintHighlight(from, to) {
            clearHighlight();

            /*
              ⚠️⚠️ 这里必须按**行**遍历，不能按"词的下标差"（2026-09-25 修）

          踩过的坑：`lines` 是 `querySelectorAll('.pdf-text-line')` ——
          返回的是**所有词**（实测一篇论文 912 个），不是行。
          我原来写 `for (j = first; j <= last; j++)`，
          于是"从第 first 个词到第 last 个词"每个词都加了类 ——
          看起来没错，但：

            · 同一行的多个词各自被标成"第一行/最后一行"，
              各自按自己在行内的 x 比例算 `--sel-from/--sel-to`
              → 中间的词被裁掉一半，高亮出现锯齿断裂
            · 跨行时行归属完全乱掉（词的顺序 ≠ 行的顺序）

          ✅ 正确做法：先按 `dataset.row` 把词**分组成行**，
             再对每一行算它在选区里的角色（首行/中间/末行）。
             行的顺序用 row 号，与词在 DOM 里的顺序解耦。
        */
        var lines = layer.querySelectorAll('.pdf-text-line');
        var byRow = {};
        var rowKeys = [];
        for (var i = 0; i < lines.length; i++) {
            var rk = lines[i].dataset.row;
            if (rk == null) continue;
            if (!byRow[rk]) {
                byRow[rk] = [];
                rowKeys.push(parseInt(rk, 10));
            }
            byRow[rk].push(lines[i]);
        }
        rowKeys.sort(function (a, b) { return a - b; });

        var aRow = parseInt(from.el.dataset.row, 10);
        var bRow = parseInt(to.el.dataset.row, 10);
        if (isNaN(aRow) || isNaN(bRow)) return;

        var rFirst = Math.min(aRow, bRow);
        var rLast = Math.max(aRow, bRow);
        /*
          ⚠️ 起点/终点**在行内的比例**：正向拖时 aRow 是起点行、
             反向拖时 aRow 是终点行 —— 所以要先判断方向再取比例，
             不能硬绑 `from` / `to`。
        */
        var startOff = (aRow <= bRow) ? from.off : to.off;
        var startLen = (aRow <= bRow) ? from.len : to.len;
        var endOff = (aRow <= bRow) ? to.off : from.off;
        var endLen = (aRow <= bRow) ? to.len : from.len;

        for (var ri = 0; ri < rowKeys.length; ri++) {
            var key = rowKeys[ri];
            if (key < rFirst || key > rLast) continue;
            var words = byRow[key];
            var a = (key === rFirst) ? (startOff / Math.max(1, startLen)) : 0;
            var b = (key === rLast) ? (endOff / Math.max(1, endLen)) : 1;
            if (b < a) { var t2 = a; a = b; b = t2; }

            /*
              ⚠️ 行内每个词要按"自己在线上的位置"与 [a, b] 求交，再换算成
                 **词内局部比例**（`--sel-from/--sel-to` 是相对该词的）。

                 位置从哪来：词是**绝对定位**的，`style.left` 就是它相对
                 本行的 x 占比（mountTextLayer 里写的 `x0 * 100%`）。
                 所以**直接读 style，不要调 getBoundingClientRect** ——
                 后者每帧强制重排，912 个词会明显卡顿（实测拖拽变涩）。

                 ⚠️ 但 `left` 是相对**页面**的、不是相对行首 ——
                     PDF 里左右栏的同一行两个词，x0 会相差 0.5 左右。
                     所以要先减去本行的最小 left，才是"行内位置"。
            */
            var items = [];
            var minL = Infinity;
            var maxR = -Infinity;
            for (var w2 = 0; w2 < words.length; w2++) {
                var L = parseFloat(words[w2].style.left) || 0;
                var W = parseFloat(words[w2].style.width) || 0;
                items.push({ el: words[w2], l: L, r: L + W });
                if (L < minL) minL = L;
                if (L + W > maxR) maxR = L + W;
            }
            var span = maxR - minL;
            if (!(span > 0)) continue;

            for (var k2 = 0; k2 < items.length; k2++) {
                var it = items[k2];
                /* 词在**行内**的占比区间 */
                var p0 = (it.l - minL) / span;
                var p1 = (it.r - minL) / span;
                /* 与选中区间 [a, b] 求交 */
                var lo = Math.max(p0, a);
                var hi = Math.min(p1, b);
                if (hi <= lo) continue;
                /* 换算成词内局部比例（0..1） */
                var lf = (p1 > p0) ? ((lo - p0) / (p1 - p0)) : 0;
                var lt = (p1 > p0) ? ((hi - p0) / (p1 - p0)) : 1;
                it.el.classList.add('is-selected');
                it.el.style.setProperty('--sel-from', String(lf));
                it.el.style.setProperty('--sel-to', String(lt));
            }
        }

        /*
          ⚠️ 记下选区归属的**页面内行号区间**（供「建立区域」用）。
             用 dataset.row（mountTextLayer 里按 y 聚类算出来的），
             不是 DOM 索引 —— 同一行的多个词共享一个 row 值。
        */
        currentSelection = { rowFrom: rFirst, rowTo: rLast };
    }

    layer.addEventListener('pointerdown', function (ev) {
        var pt = pointToCaret(ev.clientX, ev.clientY);
        if (!pt) return;
        startPt = pt;
            /*
              ⚠️ 按下就**先收掉旧高亮 + 旧选区** —— 否则用户点一下
                 （想取消选择）会因为"没有更新选区"而留着上次的高亮。
            */
            clearHighlight();
            notifySelection(null);
            try {
                var s = global.getSelection();
                if (s) s.removeAllRanges();
            } catch (e) { /* 忽略 */ }
        });

        layer.addEventListener('pointermove', function (ev) {
            if (!startPt) return;

            /*
              ⚠️ 先看"本次手势归谁"（由 bindTextLayerPan 判定并写在层上）。
                 它判成 'pan' → 这里**什么都不做**，避免一边滚页面
                 一边划选区（两个 handler 各干一半的典型症状）。
                 还没判（null）→ 也不动，等它判完。
            */
            if (layer.__gesture !== 'select') return;

            var pt = pointToCaret(ev.clientX, ev.clientY);
            if (!pt) return;

            paintHighlight(startPt, pt);
            try {
                var sel = global.getSelection();
                if (!sel) return;
                /*
                  ⚠️ 用 setBaseAndExtent 而不是 Range + addRange ——
                     它自带"方向"语义（从 base 到 extent），
                     反向拖拽（从下往上选）时行为才正确。
                     用 Range 的话反选会得到空选区（start > end 被规范化）。

                  ⚠️ 虽然高亮是自己画的，这里**仍要设选区** ——
                     因为"复制"要走系统菜单，那需要真实选区。
                */
                sel.setBaseAndExtent(startPt.node, startPt.offset,
                                     pt.node, pt.offset);
            } catch (e) { /* 跨节点异常时忽略，下一次 move 会再试 */ }
        });

        var finish = function () {
            if (startPt) {
                /*
                  ⚠️ 松手后**不要清高亮** —— 用户还要看着它确认选对了没有。
                     清掉就变成"一闪而过"了。

                  ══ ⚠️⚠️ 选中后**直接浮出类型选项**（2026-09-26 用户纠正）══

                  用户的流程要求：
                    「进编辑模式 → 点「文本」→ 才能选字」
                    「选中后直接浮出类型选项」

                  所以这里不再"浮出一个按钮让用户再点一次" ——
                  那是我第一版的做法，用户指出它让编辑栏的「文本」选项
                  变得毫无作用（"选一个区域，这样文本选项的功能不就空置了吗？"）。

                  ✅ 正确顺序：
                     点「文本」选项（开启选字）→ 划选 → 松手 → 类型直接出来
                  ⚠️ 选完类型后**流程结束**，不自动退出编辑模式 ——
                     用户往往要连着标好几段（标标题、再标摘要）。
                     退出由用户点「文本」取消或点「完成」。
                */
                var text = '';
                try {
                    var s = global.getSelection();
                    text = s ? String(s) : '';
                } catch (e) { text = ''; }

                if (text && currentSelection) {
                    openSelectionTypePicker();
                } else {
                    notifySelection(null);
                }
            }
            startPt = null;
        };
        layer.addEventListener('pointerup', finish);
        layer.addEventListener('pointercancel', finish);
    }

    /**
     * 通知外部「当前选中了什么」—— 用于浮出「建立区域」按钮。
     *
     * ⚠️ 用空实现占位：真正的 UI 由 `bindSelectionFab()` 接。
     *    这样 bindTextLayerSelect 不必知道外面有没有那个按钮。
     */
    function notifySelection(text) {
        if (typeof onTextSelection === 'function') {
            onTextSelection(text, currentSelection);
        }
    }
    var onTextSelection = null;
    /** 最近一次选中的文本行范围（供「建立区域」用） */
    var currentSelection = null;

    /**
     * 在文字层上接管**纵向滚动** —— 让"拖拽"这件事有两种可能的结果。
     *
     * ══ ⚠️⚠️ 为什么必须自己接管（2026-09-25 真机实测）══
     *
     * 文字层要能选字，就必须把整条祖先链的 `touch-action` 锁成 `none`
     * （理由见 styles.css 的详细说明：`touch-action` 取祖先链交集，
     *   而 `.reader-body` 是 `overflow-y: auto`，它会把手势判成滚动）。
     *
     * 但锁成 `none` 之后，**手指在文字层上纵向拖也会变成"选字"** ——
     * 而这在手机上是违反直觉的（用户的第一反应是"页面卡住了"）。
     *
     * 用户明确要求过页面必须能滚：
     *   「编辑模式哪个选项都没点，就不需要画框啊，**比如滚动页面啥的**」
     *
     * ✅ 所以这里手动接管：在文字层上按**纵向为主**拖拽时，
     *    自己改 `.reader-body.scrollTop`。两种手势于是并存：
     *      · 纵向拖 → 滚页面（用户的第一直觉）
     *      · 横向拖 → 选文字（要选字的自然动作）
     *
     * ⚠️ 为什么不用 `touch-action: pan-y`（那样本来能两全）：
     *    实测 `pan-y` 仍然发 `pointercancel` —— 拖拽总带纵向分量，
     *    浏览器照样认领成滚动，选字时断时续。**只有 `none` 稳。**
     *
     * ⚠️ 判据用"纵向位移 > 横向位移"，且要超过一个阈值才开始滚 ——
     *    否则用户想横向选字时，手指的天然抖动会先触发滚动。
     */
    function bindTextLayerPan(layer) {
        var startY = 0;
        var startScroll = 0;
        var startX = 0;
        var panning = false;
        var decided = false;

        /*
          ⚠️ 阈值按物理尺寸定（3mm ≈ 11.3 CSS px），与编辑模式的
             DRAG_SLOP 同一套理由 —— 写死 8px 在真机上会被
             "点一下"的天然抖动触发（实测踩过）。
        */
        var SLOP = 3 * 96 / 25.4;

        layer.addEventListener('pointerdown', function (ev) {
            if (!bodyEl) return;
            startX = ev.clientX;
            startY = ev.clientY;
            startScroll = bodyEl.scrollTop;
            panning = false;
            decided = false;
            /*
              ⚠️ 把"本次手势归谁"的决定共享给 bindTextLayerSelect ——
                 两个 handler 各自判方向的话，一次斜向拖拽会
                 **同时**滚页面 + 划选区，松手后既有位移又有高亮，很混乱。
                 设置 `__gesture = null` 表示"还没决定"。
            */
            layer.__gesture = null;
        });

        layer.addEventListener('pointermove', function (ev) {
            if (!bodyEl) return;
            if (ev.buttons === 0 && ev.pointerType === 'mouse') return;
            var dx = ev.clientX - startX;
            var dy = ev.clientY - startY;

            if (!decided) {
                var adx = Math.abs(dx);
                var ady = Math.abs(dy);
                if (Math.max(adx, ady) < SLOP) return;   // 还没到阈值，继续观察
                decided = true;
                /*
                  ══ ⚠️⚠️ 判定规则：**横向优先**（2026-09-25 用户实测反馈后改）══

                  原来是 `panning = ady > adx`（谁大听谁的）。问题：
                  用户想在**一行字**上选词时，手指天然会上下抖 —— 而
                  PDF 里一行只有 8~10px 高，抖动十几像素就足以让
                  `ady ≥ adx`，于是**永远判成滚动，永远选不中**。
                  用户反馈原话：「随便拖，上下左右都试了」「什么都没发生」。

                  ✅ 改成：**只要横向分量不可忽略，就判成选字。**
                     理由——两种意图的"动作特征"本来就不对称：
                       · 想滚页面 → 手指几乎**纯纵向**移动（人滑列表不会左右划）
                       · 想选文字 → 一定带明显的横向位移（要覆盖若干字符）
                     所以用一个不等号把"横向"的门槛降下来是安全且符合直觉的。
                     PDF 里纵向选多行也仍然可用：那需要**先横向起手**
                    （见下），起手即定。

                  ⚠️ 阈值用 `adx >= ady * 0.6` 而不是 `adx > 0`：
                     完全不带方向性判断的话，纵向滑动的天然左右漂移
                     （实测可达 ±15px）会被判成选字，页面就滑不动了。

                  ⚠️ 判定之后**不再改主意** —— 中途切换会让
                     滚到一半突然变成选字（或反之），体验很糟。
                */
                panning = adx < ady * 0.6;
                layer.__gesture = panning ? 'pan' : 'select';
                if (panning) layer.classList.add('is-panning');
            }
            if (!panning) return;

            /*
              ⚠️ 必须 preventDefault —— 否则浏览器还会拿这次拖拽
                 去尝试长按菜单，与滚动打架。
                 这里能 prevent 是因为层的 touch-action 已是 none。
            */
            ev.preventDefault();
            bodyEl.scrollTop = startScroll - dy;
        });

        var stop = function () {
            panning = false;
            decided = false;
            layer.__gesture = null;
            layer.classList.remove('is-panning');
        };
        layer.addEventListener('pointerup', stop);
        layer.addEventListener('pointercancel', stop);
    }

    /** 造一个页图 <img>。抽出来是因为占位与懒加载两处都要用。 */
    function makePageImg(dataUrl, page, id) {
        var img = document.createElement('img');
        img.className = 'pdf-page-img';
        img.alt = t('reader.rawView') + ' ' + page;
        img.decoding = 'async';
        /*
          ⚠️ 图片加载完要**重新对齐标注浮层**。

             浮层的尺寸靠 `naturalWidth/naturalHeight` 算（见
             positionAnnotateLayer），图没加载完时只能先铺满容器。
             加载完不重算的话，在有留白的页上框会全部偏移。

             ⚠️ 用 `load` 事件而不是在 appendChild 后同步调 ——
                同步调时 naturalWidth 还是 0（解码是异步的）。
        */
        img.addEventListener('load', function () {
            var slot = img.parentNode;
            if (!slot) return;
            var layer = slot.querySelector('.anno-layer');
            if (layer) positionAnnotateLayer(layer);
        });
        img.src = dataUrl;
        return img;
    }

    /**
     * 用 IntersectionObserver 按需装载页图。
     *
     * ⚠️ root 必须是 [bodyEl]（真正滚动的那一层），不是视口 ——
     *    阅读页整体是一个 fixed 覆盖层，滚动发生在 .reader-body 内部，
     *    用默认视口做 root 的话判定会全错（所有页都被认为"在视野里"）。
     *
     * ⚠️ rootMargin 给**上下各一页**的余量：
     *    用户滚到某页才开始加载的话，会看到明显的"白块慢慢变图"。
     *    提前一页加载，滚过去时通常已经就绪。
     *
     * ⚠️ 加载过的页要 `unobserve`（图已经在 DOM 里了，再观察没意义），
     *    否则每次滚动都会重复回调，白白比较。
     *
     * ⚠️ 没有 IntersectionObserver 时（很老的 WebView）**回退成全量加载**：
     *    宁可卡一点也不能整页空白。minSdk 26 起它都有，
     *    但这是十行代码的保险，值得留。
     */
    function startPdfLazyLoad(id) {
        if (!bodyEl || !pdfPageEls.length) return;

        var loadOne = function (el) {
            if (!el || el.classList.contains('is-loaded')) return;
            var page = parseInt(el.getAttribute('data-page'), 10) || 0;
            if (page < 1) return;

            el.classList.add('is-loaded'); // 先打标记，防并发重复请求

            var dataUrl = '';
            try {
                dataUrl = global.ScholariusNative.getPdfPage(id, page) || '';
            } catch (e) {
                dataUrl = '';
            }

            if (dataUrl) {
                el.appendChild(makePageImg(dataUrl, page, id));
                /*
                  ══ ⚠️⚠️ 页图之上叠一层**透明文字**（2026-09-25）══

                  用户反复反馈（最终说清）：
                    「字体根本无法选中啊」「面对任何形式的拖拽
                      都没有办法识别」「我说的是原始视图」

                  真因：原始视图的页面是 `PdfRenderer` 渲染出的
                  **JPEG 位图** —— 位图里没有文字对象，手指划过它
                  浏览器不知道该"选中"什么。

                  ✅ 正解（Chrome/Adobe 阅读器同做法）：
                     在页图**上面**叠一层**真实的文字**，
                     位置与位图上的字严格重合，但
                     `color: transparent` 让它**看不见** ——
                     视觉上还是原始版面，而手指划过能选中。

                  ⚠️ 必须在**页图之后** append —— 文字层要盖在图上，
                     顺序反了会被图挡住（虽然透明，但层级要正确，
                     否则 z-index 与后续标注层会打架）。
                */
                mountTextLayer(el, page, id);
            } else {
                var hint = document.createElement('div');
                hint.className = 'reader-hint pdf-slot-hint';
                hint.textContent = t('reader.pageUnavailable');
                el.appendChild(hint);
            }
        };

        if (!global.IntersectionObserver) {
            for (var i = 0; i < pdfPageEls.length; i++) loadOne(pdfPageEls[i]);
            return;
        }

        var margin = Math.round((bodyEl.clientHeight || 600) * 0.9);
        pdfSpy = new global.IntersectionObserver(function (entries) {
            for (var j = 0; j < entries.length; j++) {
                if (entries[j].isIntersecting) {
                    var el = entries[j].target;
                    loadOne(el);
                    pdfSpy.unobserve(el);
                }
            }
        }, {
            root: bodyEl,
            rootMargin: margin + 'px 0px ' + margin + 'px 0px',
        });

        for (var k = 0; k < pdfPageEls.length; k++) {
            pdfSpy.observe(pdfPageEls[k]);
        }
    }

    /**
     * 断开页图懒加载观察器、清掉引用。
     *
     * ⚠️ **必须显式断开**，不能只把它置 null：
     *    观察器持有所有占位元素的强引用，而占位元素又被它观察着 ——
     *    不断开就是一个自留的环，页图与 observer 都不会被回收。
     *    连开十几篇文献，内存会明显上涨。
     *
     * ⚠️ 在三个地方都要调：
     *    切回阅读视图 / 打开新文献 / 关闭阅读页。
     *    漏掉任何一处都会留住上一篇的那批页图。
     */
    function teardownPdfScroll() {
        if (pdfSpy) {
            try {
                pdfSpy.disconnect();
            } catch (e) {
                /* 忽略：disconnect 失败不该影响界面切换 */
            }
        }
        pdfSpy = null;
        pdfPageEls = [];
    }

    /**
     * 把阅读视图的正文重新放回 contentEl。
     *
     * ⚠️ 用**缓存**而不是重新向原生要文本：
     *    重新要一次会让原生再解析一遍整个 PDF（几百毫秒到几秒），
     *    而内容我们本来就有 —— 只是刚才为了让位给图片把它清掉了。
     *
     * 缓存为空（极端情况：切过去时正文还没回来）就重新请求一次。
     */
    function restoreReadingContent() {
        if (!contentEl) return;

        if (lastBlocks && lastBlocks.length) {
            contentEl.textContent = '';
            renderBlocks(lastBlocks);
            if (bodyEl) bodyEl.scrollTop = 0;
            return;
        }

        if (lastText) {
            contentEl.textContent = lastText;
            if (bodyEl) bodyEl.scrollTop = 0;
            return;
        }

        // 缓存没有（正文还没提取完就切过去又切回来）→ 重新要一遍
        if (currentDoc) {
            showLoading();
            requestText(String(currentDoc.id));
        }
    }

    // --- 用户标注（v0.1.17）-------------------------------------------------

    /**
     * 编辑模式下的四个选项（用户 2026-09-24 定）。
     *
     * ══ ⚠️ 顺序与分组很重要 ══
     *
     * 前三个是**矩形**标注（手画框），最后一个「文本」是
     * **选中文字**，两者的操作方式完全不同：
     *
     *   text    → 选中文字 → 指定为哪类文本（标题/摘要/脚注…）
     *   formula → 拖矩形框
     *   table   → 拖矩形框
     *   figure  → 拖矩形框
     *
     * ⚠️ 为什么「文本」要单独放第一个而不是混在中间：
     *    它是默认选项 —— 用户打开编辑模式时最常做的是
     *    "这段被认错了，改一下"，而不是频繁画框。
     *    放在最左边（拇指最容易够到的位置）也符合这个默认。
     */
    var EDIT_MODES = ['text', 'formula', 'table', 'figure'];

    /**
     * 走**矩形**路径的三个类型。
     *
     * ⚠️ 与 `AnnotationStore.kt` 的 `REGION_*` 一一对应，
     *    改一处必须改两处。原生读盘时会**再校验一遍**并丢掉
     *    未知类型，所以这里漏改的症状是"框画了但重进就没了"。
     *
     * ⚠️ 不含 `text` —— 文本不用矩形，见 EDIT_MODES 的说明。
     */
    var REGION_TYPES = ['formula', 'table', 'figure'];

    /** 「文本」模式下可选的文本类型（用户选定八类） */
    var TEXT_TYPES = [
        'title', 'author', 'abstract', 'body',
        'heading', 'footnote', 'reference', 'keyword'
    ];

    /**
     * 章节标题的最大层级。
     *
     * ⚠️ 定 3 是因为正文大纲普遍到三级（`3.1` / `3.1.1`）；
     *    再深在手机屏上已经看不出缩进差别，反而让左侧竖线糊成一片。
     *    `AnnotationStore.load()` 会把超范围的 level 夹回这个上限。
     */
    var MAX_HEADING_LEVEL = 3;

    /** 各类型对应的 i18n key（菜单文案） */
    var TYPE_LABEL_KEY = {
        text: 'reader.typeText',
        formula: 'reader.typeFormula',
        table: 'reader.typeTable',
        figure: 'reader.typeFigure',
        title: 'reader.typeTitle',
        author: 'reader.typeAuthor',
        abstract: 'reader.typeAbstract',
        body: 'reader.typeBody',
        heading: 'reader.typeHeading',
        footnote: 'reader.typeFootnote',
        reference: 'reader.typeReference',
        keyword: 'reader.typeKeyword'
    };

    /**
     * 类型 → 图标名。
     *
     * ⚠️ 全部对应 `components.js` 的 `ICON_PATHS` 里 `anno*` 那一组
     *    （960 体系，已在 ICON_VIEWBOX 登记）。名字写错的话
     *    `icon()` 返回空串 —— **界面不报错，只是没图标**，
     *    所以改这里之后要看一眼选项栏。
     */
    var TYPE_ICON = {
        text: 'annoText',
        formula: 'annoFormula',
        table: 'annoTable',
        figure: 'annoFigure',
        title: 'annoTitle',
        author: 'annoAuthor',
        abstract: 'annoAbstract',
        body: 'annoBody',
        heading: 'annoHeading',
        footnote: 'annoFootnote',
        reference: 'annoReference',
        keyword: 'annoKeyword'
    };

    /**
     * 顶栏「编辑」按钮：绑事件 + 预置两只图标。
     *
     * ══ ⚠️ 靠**切图标**表达状态，不做点击特效（用户 2026-09-24）══
     *
     * 用户明确：「edit 也不应该有点击特效和阴影，而是通过切换图标来
     * 显示是否处于编辑模式」，并给了两个图标（edit / edit_off）。
     *
     * 这与「阅读/原始」视图切换按钮**完全同构**，
     * 所以做法也一样（照抄 mountViewToggle）：
     *   · 两只图标**一次性预置**在按钮里，切换时只切 `hidden`；
     *   · **不重建 innerHTML** —— 重建会让图标闪一下
     *     （浏览器要重新解析 SVG）。
     */
    function mountAnnotate() {
        if (!annotateBtn) {
            return;
        }

        var ui = global.ScholariusUI;
        if (ui && ui.icon) {
            annotateBtn.innerHTML =
                '<span class="reader-annotate-icon" data-anno-icon="idle">' +
                ui.icon('annotateEditOff') + '</span>' +
                '<span class="reader-annotate-icon" data-anno-icon="editing">' +
                ui.icon('annotateEdit') + '</span>';
        }

        annotateBtn.addEventListener('click', function () {
            setAnnotating(!annotating);
        });

        syncAnnotate();
    }

    /**
     * 刷新编辑按钮的图标、状态、无障碍标签。
     *
     * ══ ⚠️ 图标与标签都描述**动作**，不是"当前状态" ══
     *
     * 与 syncViewToggle 同一条纪律：两者必须同向
     * （图标说"点了会去哪"，标签也说"点了会去哪"）。
     *
     * 图标（用户选定，默认 edit_off）：
     *   未编辑 → edit_off（点它进入编辑模式）
     *   编辑中 → edit    （点它退出）
     */
    function syncAnnotate() {
        if (!annotateBtn) {
            return;
        }

        /*
          ⚠️ 两图标预置在按钮里，靠 hidden 切显示。
             不重建 innerHTML —— 那会让图标闪一下。
        */
        var iconIdle = annotateBtn.querySelector('[data-anno-icon="idle"]');
        var iconEditing = annotateBtn.querySelector('[data-anno-icon="editing"]');
        if (iconIdle) iconIdle.hidden = annotating;
        if (iconEditing) iconEditing.hidden = !annotating;

        annotateBtn.setAttribute('aria-pressed', annotating ? 'true' : 'false');
        annotateBtn.setAttribute(
            'aria-label',
            t(annotating ? 'reader.annotateDone' : 'reader.annotate')
        );
        /*
          ⚠️ 同 syncViewToggle：必须移除 data-i18n-aria-label，
             否则语言切换会把文案刷回模板里的原值，
             把我们算出来的「完成/标注」覆盖掉。
        */
        annotateBtn.removeAttribute('data-i18n-aria-label');
    }

    /**
     * 从原生拉一次标注。
     *
     * ⚠️ 桥不可用（浏览器预览）时**静默留空** ——
     *    预览里没有 PDF 也没有原生存储，报错只会干扰调试。
     *
     * ⚠️ 返回的一定是合法结构（原生那边保证），但这里仍然防一手：
     *    `JSON.parse` 失败就留空，绝不抛出去把整页打断。
     */
    function loadAnnotations(id) {
        regionMarks = [];
        textMarks = [];

        var bridge = global.ScholariusNative;
        if (!bridge || typeof bridge.getAnnotations !== 'function') {
            return;
        }

        var raw = '';
        try {
            raw = bridge.getAnnotations(String(id)) || '';
        } catch (e) {
            raw = '';
        }
        if (!raw) return;

        try {
            var doc = JSON.parse(raw);
            if (doc && Object.prototype.toString.call(doc.regions) === '[object Array]') {
                regionMarks = doc.regions;
            }
            if (doc && Object.prototype.toString.call(doc.texts) === '[object Array]') {
                textMarks = doc.texts;
            }
        } catch (e) {
            regionMarks = [];
            textMarks = [];
        }
    }

    /**
     * 把标注写回原生。
     *
     * ⚠️ 只在**退出编辑模式 / 关闭阅读页**时调，不是每改一处都调
     *    （见 annotateDirty 的说明）。
     *
     * @return 是否成功；失败时由调用方提示
     */
    function saveAnnotations() {
        if (!currentDoc || !annotateDirty) return true;

        var bridge = global.ScholariusNative;
        if (!bridge || typeof bridge.setAnnotations !== 'function') {
            return true; // 预览环境：当成功，不打扰
        }

        var payload = JSON.stringify({
            regions: regionMarks,
            texts: textMarks
        });

        var ok = false;
        try {
            ok = bridge.setAnnotations(String(currentDoc.id), payload) === true;
        } catch (e) {
            ok = false;
        }

        if (ok) {
            annotateDirty = false;
        } else {
            trace('reader:annotate', 'save failed');
        }
        return ok;
    }

    /**
     * 进入 / 退出标注编辑模式。
     *
     * ══ ⚠️ 编辑模式只能发生在**原始视图**（PDF）里 ══
     *
     * 因为要标注的对象（公式/表格/图片）在重排后的文本视图里
     * 已经被"读"成一段段文字了，位置信息不再对应原版面 ——
     * 在文本视图上画框会框到错误的区域。
     *
     * ══ 为什么退出时必写盘 ══
     *
     * 编辑期间的改动只在内存里（见 annotateDirty）。退出是一个明确的
     * "我做完了"信号，此时写盘是自然的。若不写，用户以为存了，
     * 下次进来全没了 —— 这个 bug 比"每画一框写一次"的卡顿糟得多。
     */
    function setAnnotating(on) {
        var next = !!on;

        // 只有原始视图能进编辑模式
        if (next && view !== 'raw') {
            return;
        }
        if (next === annotating) {
            return;
        }

        if (!next) {
            // 退出前先存。失败就提示，但不阻止退出
            // （用户可能就想先出去，不想被卡住）
            if (!saveAnnotations()) {
                showError('saveFailed');
            }
        }

        annotating = next;
        /*
          ⚠️ 进出编辑模式都清掉区间起点（见 rangeAnchor 的说明）。
             不清的话，上次退出前设过起点、这次进来点第一下
             就会莫名标记一大片。
        */
        rangeAnchor = null;

        /*
          ⚠️ 进/出编辑模式时底部选项栏要**换内容**
             （用户要求：下面的选项栏直接换成这四个编辑选项）。
             见 syncBottomBar。
        */
        if (annotating) {
            ensureEditBar();
        }
        syncAnnotate();
        syncBottomBar();

        /*
          ⚠️ 进编辑模式时**什么选项都不选**（annotateMode = null）。

             理由（用户 2026-09-24）：
             「编辑模式哪个选项都没点，就不需要画框啊，比如滚动页面啥的」

             这是最自然的状态：用户先进编辑模式**看看**，
             想好要标什么再点选项。此时页面必须能正常滚动 ——
             否则用户想先翻一遍内容都做不到。

             ⚠️ 不要"顺手选中文本"当默认。那会让文字块铺满页面，
                而用户还没表达任何意图 —— 视觉上很吵。
        */
        if (annotating) {
            annotateMode = null;
            refreshAnnotateMode();
        } else {
            unmountAnnotateLayer();
            /*
              ⚠️ 退出编辑模式**必须**清掉 is-text-mode 类。

                 否则它会残留（实测：退出后 reader 的类是
                 "reader is-open is-menu-open is-text-mode"，
                 没有 is-annotating）—— 一个"看起来在文本模式"
                 但实际不在编辑模式的状态，很容易在后面读到它
                 做错判断。类必须与 annotating 严格同步。

                 ⚠️ 这里不能只靠 syncEditBar()（它在 annotating 为假时
                 可能提前 return），必须显式调 syncModeClass()。
            */
            syncModeClass();
            /*
              ⚠️ 退出编辑模式要把提示气泡收掉 ——
                 否则它会残留几秒，而那时编辑选项栏已经换回
                 「目录 / 设置」了，提示说的操作已经不存在。
            */
            hideAnnoTip();
        }

        trace('reader:annotate', annotating ? 'enter' : 'exit');
    }

    /** 编辑模式下的浮层元素（每页一个），便于统一清理 */
    var annotateLayers = [];
    /** 编辑模式的底部选项栏（懒建，只建一次） */
    var editBarEl = null;
    /** 编辑模式下的操作提示 */
    var annoTipEl = null;
    /** 文本类型选择弹层的元素（打开时非空），便于统一清理 */
    var textPickerEls = [];
    /** 提示气泡的自动关闭定时器 */
    var annoTipTimer = null;

    /**
     * 提示气泡停留时长（毫秒）。
     *
     * ⚠️ 取 2600ms：够看完一句短提示（中文 12-16 字），
     *    又不至于挡着页面太久。
     *    项目里没有别的 toast 可以对齐，这个数是按中文阅读速度估的
     *    （约 300 字/分钟 → 16 字约 3 秒，留一点余量）。
     */
    var ANNO_TIP_MS = 2600;

    /**
     * 建编辑选项栏 + 提示条（**懒建，只建一次**）。
     *
     * ══ ⚠️ 位置：**底部选项栏**，不是顶栏下方（用户 2026-09-24 修正）══
     *
     * 用户原话：
     *   「位置不对，应该在下面的选项栏：因为下面的选项栏的都是为
     *     阅读视图准备的，切换到原始视图就不需要了，所以下面的选项栏
     *     直接换成编辑的这四种选项就可以了」
     *
     * 所以**不新建一条栏** —— 复用 `.reader-bottom` 那个位置：
     * 进编辑模式时把原来的「目录 / 设置」藏掉、把编辑选项放上去；
     * 退出时换回来。见 [syncBottomBar]。
     *
     * ⚠️ 理由（用户给的）很实在：底部那条栏是**视图专属**的。
     *    「目录 / 设置」对原始视图没有意义（原始视图里没有重排正文，
     *    也就没有目录可跳、没有字号可调）。与其让它们留在那里点了没反应，
     *    不如整条换成当前视图真正能做的事。
     */
    function ensureEditBar() {
        if (editBarEl || !root) return;

        editBarEl = document.createElement('div');
        editBarEl.className = 'reader-editbar';
        editBarEl.setAttribute('role', 'toolbar');

        for (var i = 0; i < EDIT_MODES.length; i++) {
            editBarEl.appendChild(makeEditTab(EDIT_MODES[i]));
        }

        /*
          ⚠️ 「清空」**不在这里**（用户 2026-09-25 修正）。

             用户原话：「清除用悬浮按钮，跟着唤醒菜单一起唤醒和隐藏」

             原来把它当底栏第五项，问题是：
               · 底栏四项是一个**互斥的开关组**（模式），
                 而清空是**一次性动作** —— 混在一起语义不齐；
               · 底栏位置会随菜单一起滑动，用户想清空得先唤出菜单，
                 但他往往正是在翻看内容时发现"一团乱麻"；
               · 悬浮按钮可以跟着菜单同时出现/隐藏，
                 既不抢模式的位置，又随时够得着。

             所以改成 FAB，见下面的 mountClearFab。
        */

        annoTipEl = document.createElement('div');
        annoTipEl.className = 'anno-tip';

        /*
          ⚠️ 提示条挂在底部选项栏（#reader-bottom）**内部**，不是挂 root。
             挂 root 的话它不会跟着选项栏的高度/安全区走，
             实测会与选项栏重叠。
        */
        if (bottomEl) {
            bottomEl.appendChild(editBarEl);
        } else {
            root.appendChild(editBarEl);
        }
        root.appendChild(annoTipEl);

        mountClearFab();
        syncEditBar();
    }

    /**
     * 建「清空」悬浮按钮（FAB）。
     *
     * ⚠️ 与编辑模式同生共死 —— 进出编辑模式时一起显示/隐藏
     *    （用户要求：「跟着唤醒菜单一起唤醒和隐藏」）。
     *    具体开关在 syncBottomBar 里一起处理，避免两处状态不同步。
     *
     * ⚠️ 它**只在编辑模式**出现。阅读视图里不需要它
     *    （那里没有框可清）。
     */
    function mountClearFab() {
        if (clearFabEl || !root) return;

        clearFabEl = document.createElement('button');
        clearFabEl.className = 'anno-fab';
        clearFabEl.type = 'button';
        clearFabEl.hidden = true;
        clearFabEl.setAttribute('aria-label', t('reader.clear'));

        var ui = global.ScholariusUI;
        if (ui && ui.icon) {
            clearFabEl.innerHTML = ui.icon('annoClear');
        }

        clearFabEl.addEventListener('click', function () {
            startClearFlow();
        });

        root.appendChild(clearFabEl);
    }

    /**
     * 造一个编辑选项按钮。
     *
     * ⚠️ 结构与 `.reader-action` **完全一致**（图标在上、文字在下），
     *    这样它与「目录 / 设置」在视觉上是同一种元素 ——
     *    用户看到的是"底栏换了内容"，而不是"冒出一条新栏"。
     *
     * ══ ⚠️ 选中态 = **两只 SVG 切换**（用户 2026-09-25 再次要求）══
     *
     * 用户原话：「选中后使用填充图标」，「不使用阴影和点击特效」。
     *
     * ⚠️ 必须与底部导航栏（.nav-item）用**完全相同**的做法：
     *    预置 outline + fill 两只 svg，靠 `aria-pressed` 切 display。
     *    绝不能用"背景色块 / 阴影"表示选中 —— 那不是本项目
     *    导航栏的语言，用户已明确否定过两次。
     *
     * ⚠️ 两只 svg 一次性建好（不重建 innerHTML）：
     *    重建会让图标闪一下（浏览器要重新解析 SVG）。
     */
    function makeEditTab(mode) {
        var tab = document.createElement('button');
        tab.className = 'reader-action reader-edit-tab';
        tab.type = 'button';
        tab.setAttribute('data-edit-mode', mode);
        tab.setAttribute('aria-pressed', 'false');

        var ui = global.ScholariusUI;
        var iconName = TYPE_ICON[mode];

        /*
          ⚠️ 图标要包在 `.reader-action-icon` 里（grid 叠同格），
             否则两只 svg 会上下排列、把按钮撑高。
             与 .nav-icon 的写法一致。
        */
        var iconWrap = document.createElement('span');
        iconWrap.className = 'reader-action-icon';
        if (ui && ui.iconFilled && iconName) {
            iconWrap.innerHTML =
                ui.icon(iconName).replace('<svg ', '<svg class="icon-outline" ') +
                ui.iconFilled(iconName).replace('<svg ', '<svg class="icon-fill" ');
        } else if (ui && ui.icon && iconName) {
            iconWrap.innerHTML = ui.icon(iconName);
        }
        tab.appendChild(iconWrap);

        var label = document.createElement('span');
        label.className = 'reader-action-label';
        label.textContent = t(TYPE_LABEL_KEY[mode] || mode);
        tab.appendChild(label);

        tab.addEventListener('click', function () {
            /*
              ══ ⚠️ 是**开关**，不是单选（用户 2026-09-24 要求）══

                 用户原话：「就是点击这个选项，再点击就可以取消这个选项」

                 所以再点已选中的那个要**取消**（回到"没选任何选项"），
                 而不是像单选按钮那样点不动。

              ⚠️ 取消后 `annotateMode = null`（不是回到 'text'）——
                 因为「文本」也是一个**具体的选项**，
                 取消应该是"什么选项都没选"，
                 而不是"跳到文本模式"。这两者在界面上的表现不同：
                   · annotateMode = 'text' → 文字块显示、可点
                   · annotateMode = null   → 什么块都不显示、页面纯滚动
                 用户说的「哪个选项都没点」就是后者。
            */
            annotateMode = (annotateMode === mode) ? null : mode;

            /*
              ⚠️ 切模式要重建浮层：
                 没选 / 选「文本」时浮层不接手势（页面照常滚动），
                 三个矩形模式才接（touch-action: none）。
                 见 mountAnnotateLayer 与 styles.css 的说明。
            */
            refreshAnnotateMode();
        });

        return tab;
    }

    /**
     * 执行「清空」流程（FAB 点击后走这里）。
     *
     * ══ ⚠️ 为什么必须有这功能（用户 2026-09-25）══
     *
     * 原生自动识别在真论文上错得很离谱：
     *   · ResNet      107 / 1110 块被判成 heading
     *   · Transformer 几乎**整篇**都是 heading
     * 一块一块改在这种量级下不可能完成 —— 需要"整体推翻重来"的出口。
     *
     * ⚠️ 清空范围 = **当前选中的那一类**（用户：「该性质的所有框」）。
     *    没选任何类型时问"清空全部"—— 那是最彻底的"一团乱麻"场景。
     *
     * ⚠️⚠️ 判据必须是 [countTextMarks]（它内部用 effectiveTypeAt），
     *    **不能**只数 textMarks。这里踩过用户报的 bug：
     *      「点击清除提示没有可以删除的，但框都实实在在地在那里」
     *    因为新导入的论文 textMarks 是空的，而屏幕上有 15 个
     *    原生判的 `章节标题` 框。**用户看到的是框，框就是识别结果。**
     *
     * ⚠️ 必须走确认表单，且要**说清影响几个框** ——
     *    用户点之前得知道代价。清空没有撤销。
     */
    function startClearFlow() {
        /*
          ══ ⚠️⚠️ 两个命名空间不能混！══

          这是用户报的第二个 bug 的真因：
            「点击清除提示没有可以删除的，但框都实实在在地在那里」

         我原来写 `var scope = annotateMode`，但：

            · `annotateMode` 是**编辑栏那四个选项**：text/formula/table/figure
            · 而清空要比对的是**文本类型**：title/author/abstract/
              body/heading/footnote/reference/keyword

          两者**毫无交集**！所以 scope='text' 时，
          `countTextMarks('text')` 去找"有效类型是 text 的块"——
          一个都没有（没有任何块的类型叫 text），于是提示"没有可清空的"。

          而屏幕上明明有 15 个 `章节标题` 框。

          ⚠️ 正确做法：清空**默认作用于全部文本类型**（scope=null）。
             用户「一团乱麻」时想清的就是"所有判错的东西"，
             而不是某一个他还没指定的类型。

             将来若要"只清某一类"，入口应该在**类型选择弹层**里
             （那里才知道是 heading 还是 abstract），不是在底栏。
        */
        var scope = null;

        var n = countTextMarks(scope);
        var what = t('reader.clearAllKinds');

        if (!n) {
            // 真的没有可清的 —— 直接告知，不弹确认表单让用户白点一次
            showAnnoTip('reader.clearNothing');
            return;
        }

        var ui = global.ScholariusUI;
        if (!ui || typeof ui.confirmSheet !== 'function') {
            // 预览环境没有确认表单：直接执行，方便本地验证
            clearTextMarksByType(scope);
            return;
        }

        /*
          ⚠️ 用项目既有的 confirmSheet（不是自己造弹层）——
             样式与"删除文献"等破坏性操作保持一致。
        */
        ui.confirmSheet({
            title: t('reader.clearConfirmTitle'),
            message: t('reader.clearConfirmBody')
                .replace('{what}', what)
                .replace('{n}', String(n)),
            confirmLabel: t('action.clear'),
            cancelLabel: t('action.cancel'),
            danger: true,
            onConfirm: function () {
                clearTextMarksByType(scope);
                showAnnoTip('reader.clearDone');
            }
        });
    }

    /**
     * 模式变化后刷新一切依赖它的东西。
     *
     * ⚠️ 抽成一个函数，是因为**三个地方**都要调：
     *    点选项栏、进编辑模式、语言切换。
     *    分散写会漏掉某一处（比如进编辑模式时忘了刷新提示语）。
     */
    function refreshAnnotateMode() {
        /*
          ⚠️ 必须先同步 `is-text-mode` 类，**再**挂浮层。
             因为挂浮层时要读这个类来决定文字块接不接手势
             （CSS `.reader.is-annotating.is-text-mode .anno-block`）。
             顺序反了的话，进编辑模式的第一帧块仍是 auto，
             用户这时拖拽就会被 pointercancel 掐断。
        */
        syncModeClass();
        if (annotating) {
            /*
              ⚠️ **进编辑模式时不要预设任何"画框"模式**，
                 默认停在「文本」—— 用户要求：
                 「编辑模式哪个选项都没点，就不需要画框啊，比如滚动页面啥的」

                 「文本」模式不画框（浮层 pointer-events: none），
                 所以进编辑模式后页面仍然能正常滚动。
            */
            mountAnnotateLayer();
        }
        syncEditBar();
    }

    /**
     * 把当前 annotateMode 同步到 `.reader` 的类上。
     *
     * ⚠️ 目前只有「文本模式」这一个类 —— 它决定文字块
     *    `.anno-block` 接不接手势（见 styles.css 的详细说明）。
     *
     * ⚠️ 单独抽出来是因为它有两个调用时机：
     *    1. refreshAnnotateMode()（进/出编辑模式、切选项）
     *    2. syncEditBar()（语言切换等重绘）
     *    两处都要在**挂浮层之前**生效。
     */
    function syncModeClass() {
        if (!root) return;
        root.classList.toggle('is-text-mode', annotating && annotateMode === 'text');
        /*
          ══ ⚠️⚠️ `is-drawing` 也要写到 `.reader` 上（2026-09-25）══

          以前只有 `.anno-layer` 带 `is-drawing`（控制那一层的
          pointer-events / touch-action）。但那只解决了"层自己收不收手势"，
          **没解决整条祖先链**。

          用户实测：「面对任何形式的拖拽都没有办法识别」
                    「画框也画不了啊」「我说的是原始视图」

          真机事件序列（tools/emu_rawview_probe.py）：
            pointerdown   (103,187)  IMG.pdf-page-img
            touchstart    (103,187)  IMG.pdf-page-img
            pointermove              IMG.pdf-page-img
            touchmove     (120,191)  IMG.pdf-page-img
            **pointercancel**        ← 第 2 次移动就发了
            touchend

          → 拖拽连监听器都没到达。根因：`touch-action` 取
            **整条祖先链的交集**，而链最外层 `body` 是 `manipulation`
            （全局设定），`.reader-body` 又是 `overflow-y: auto`，
            浏览器判定"用户在滚页面" → pointercancel。

          ✅ 所以要在 `.reader` 上也标一个 `is-drawing`，
             CSS 用 `.reader.is-raw.is-annotating.is-drawing ...`
             一次性把整条链的 touch-action 收回给自己。

          ⚠️ 条件必须与 `.anno-layer` 的完全一致（都用 isDrawingMode()），
             否则会出现"层收手势、祖先链不收"的半吊子状态 ——
             那正是现在这个 bug 的形态。
        */
        root.classList.toggle('is-drawing', annotating && isDrawingMode());

        /*
          ⚠️ 离开「文本」模式时要把划选状态一起清掉（2026-09-26）。

             理由：高亮是「文本」模式的**专属视觉** —— 它是"待转化为
             区域的一段文字"。切到画框模式或退出编辑模式后，
             用户看到一段蓝底文字却做不了任何事，只会困惑。

             ⚠️ 放在 syncModeClass 里而不是各调用点 ——
                本函数是 `is-text-mode` 类的**唯一写入者**（见上面的说明），
                状态清理跟着状态写入走才不会漏。
        */
        if (!isTextMode()) {
            clearTextSelection();
            clearRawSelectionHighlight();
        } else {
            /*
              ⚠️ 进入「文本」模式给一句提示（用户 2026-09-26 的流程要求）——
                 否则用户点了「文本」后不知道接下来该干什么：
                 屏幕上看不出任何变化（文字层是透明的）。

                 ⚠️ 复用 showAnnoTip（它自带几秒后自动消失）——
                    常驻的提示条会一直挡着页面内容。
            */
            showAnnoTip('reader.selectTextTip');
        }
    }

    /**
     * 显示一条编辑提示，**几秒后自动消失**（用户 2026-09-24 要求）。
     *
     * ⚠️ 用户原话：「说明气泡也不要一直停留在页面内」
     *
     * 对 —— 常驻的提示条会一直挡着页面内容（它浮在页图下缘），
     * 而用户看完一遍就不需要它了。所以做成 toast：
     * 出现 → 停留几秒 → 淡出。
     *
     * ⚠️ 每次切模式/选项都**重新计时**（clearTimeout 再设），
     *    否则连续切几个选项时，气泡会在最后一次切换后
     *    立刻被前一次的定时器关掉。
     *
     * ⚠️ 用 CSS transition 淡出而不是直接 display:none ——
     *    突然消失会让人以为是渲染出错。
     */
    function showAnnoTip(key) {
        if (!annoTipEl) return;

        annoTipEl.textContent = t(key);

        /*
          ⚠️ 加 is-visible 才显示（CSS 里 .anno-tip 默认 opacity: 0）。
             用 opacity 而不是 display，是为了能做过渡动画。
        */
        annoTipEl.classList.add('is-visible');

        if (annoTipTimer) {
            global.clearTimeout(annoTipTimer);
        }
        annoTipTimer = global.setTimeout(function () {
            annoTipEl.classList.remove('is-visible');
            annoTipTimer = null;
        }, ANNO_TIP_MS);
    }

    /** 立即收起提示气泡（退出编辑模式时用） */
    function hideAnnoTip() {
        if (annoTipTimer) {
            global.clearTimeout(annoTipTimer);
            annoTipTimer = null;
        }
        if (annoTipEl) {
            annoTipEl.classList.remove('is-visible');
        }
    }

    /**
     * 刷新编辑选项栏：选中态 + 文案。
     *
     * ⚠️ 选中态用 `aria-pressed` + 图标**填充**来表达，
     *    与底部导航栏（.nav-item）**同一套**（用户明确要求
     *    「就和导航栏一样，切换到哪个编辑选项，图标就填充然后强调就可以了」）。
     *
     * ⚠️ 所以这里**不能**用背景块/边框那种"chip"式选中效果 ——
     *    那与导航栏不是一套语言。
     */
    function syncEditBar() {
        if (!editBarEl) return;

        /*
          ⚠️ 把当前模式同步到 .reader 的类上 ——
             CSS 需要它来决定**文字块接不接手势**（见 styles.css）。

             只有「文本」模式才给块 `pointer-events: auto`。
             画矩形模式下块必须彻底透明，否则拖拽起点碰到文字块会被
             浏览器判成滚动手势，直接发 pointercancel 掐断（真机实测）。
        */
        syncModeClass();

        var tabs = editBarEl.querySelectorAll('.reader-edit-tab');
        for (var i = 0; i < tabs.length; i++) {
            var mode = tabs[i].getAttribute('data-edit-mode');
            /*
              ⚠️ annotateMode 可能是 null（没选任何选项）——
                 那时所有 tab 都不选中。用严格比较就够了。
            */
            tabs[i].setAttribute(
                'aria-pressed',
                mode === annotateMode ? 'true' : 'false'
            );
            var label = tabs[i].querySelector('.reader-action-label');
            if (label) {
                label.textContent = t(TYPE_LABEL_KEY[mode] || mode);
            }
        }

        /*
          ⚠️ 提示语随状态变，并且**只显示几秒**（见 showAnnoTip）。

             ⚠️ 只在**编辑模式**下弹提示 ——
                语言切换也会调本函数，那时不该突然冒个气泡出来。
        */
        if (annotating) {
            if (annotateMode === 'text') {
                showAnnoTip('reader.annotateTextTip');
            } else if (isDrawingMode()) {
                showAnnoTip('reader.annotateTip');
            } else {
                showAnnoTip('reader.annotatePickTip');
            }
        }
    }

    /**
     * 切换底部选项栏的内容：阅读视图的（目录/设置）↔ 编辑模式的（四类）。
     *
     * ⚠️ 用 CSS 类 + `hidden` 而不是删/建 DOM ——
     *    「目录 / 设置」是常驻元素，删了再建会丢事件绑定。
     */
    function syncBottomBar() {
        if (!bottomEl) return;

        var normal = bottomEl.querySelectorAll('.reader-action:not(.reader-edit-tab)');
        for (var i = 0; i < normal.length; i++) {
            normal[i].hidden = annotating;
        }

        var editbar = bottomEl.querySelector('.reader-editbar');
        if (editbar) {
            editbar.hidden = !annotating;
        }

        /*
          ⚠️ 「清空」FAB 与编辑模式**同生共死**
             （用户：「跟着唤醒菜单一起唤醒和隐藏」）。
             统一在这里开关，不要在别的函数里再改一次 ——
             两处状态不同步会让按钮该出现时不出现。
        */
        if (clearFabEl) {
            clearFabEl.hidden = !annotating;
        }

        if (root) {
            root.classList.toggle('is-annotating', annotating);
        }
    }

    /**
     * 在每一页图上叠一层浮层。
     *
     * ══ ⚠️ 两种模式，浮层职责完全不同 ══
     *
     * **矩形模式**（公式/表格/图片）：
     *   浮层接手势（画框，`touch-action: none`）。
     *   浮层必须与图片实际显示区域**严格重合**，
     *   因为坐标是相对图片归一化的。
     *
     * **文本模式**（默认）：
     *   ⚠️ 浮层**不接手势**，页面照常滚动。
     *   用户原话：「编辑模式哪个选项都没点，就不需要画框啊，
     *   比如滚动页面啥的」—— 对，没选画框类选项时必须能滚。
     *   浮层仍然存在，因为它要承载已有的框 + 可点的文字块。
     *
     * ══ ⚠️ 为什么矩形模式下不直接给 <img> 绑事件 ══
     *
     * <img> 的 `object-fit: contain` 会让图片**不铺满**容器
     * （长宽比不符时上下或左右留白）。事件坐标是相对容器的，
     * 而我们要存的是**相对图片**的归一化坐标 ——
     * 直接绑 img 会在有留白时算错位置，且错得不多不少刚好是留白宽度，
     * 极难发现。
     *
     * 所以浮层必须与**图片实际渲染区域**严格重合。做法是
     * 每页一个绝对定位的 div，尺寸由 JS 按图片的实际 aspect 算好，
     * 见 positionAnnotateLayer。
     */
    function mountAnnotateLayer() {
        unmountAnnotateLayer();

        /*
          ⚠️ 「能不能画框」由**是否选了矩形类选项**决定，
             不是"在不在编辑模式"。见 styles.css 里 .is-drawing 的说明。
        */
        var isDrawing = isDrawingMode();

        for (var i = 0; i < pdfPageEls.length; i++) {
            var slot = pdfPageEls[i];
            var page = parseInt(slot.getAttribute('data-page'), 10) || 0;
            if (page < 1) continue;

            var layer = document.createElement('div');
            layer.className = 'anno-layer';
            layer.setAttribute('data-page', String(page));

            /*
              ⚠️ 只有画框模式才给 is-drawing —— 它同时控制
                 pointer-events 与 touch-action（见 CSS）。
                 不给的话页面能正常滚动。
            */
            if (isDrawing) {
                layer.classList.add('is-drawing');
            }

            // 已有的矩形框先画出来（用户要继续改，得看得见现状）
            drawRegionsOn(layer, page);

            slot.appendChild(layer);
            annotateLayers.push(layer);
            positionAnnotateLayer(layer);

            /*
              ══ ⚠️ 文字块**始终**挂上（用户 2026-09-25 要求）══

              用户原话：「打开编辑模式，各个部分各个性质的框应该显现出来，
                        不是点击选项才显示相关的框」

              这是对的 —— 编辑模式本身就该让用户**看见现状**，
              否则他进来只看到一张干净的页图，根本不知道哪里判错了、
              要改什么。之前要求"点选项才显示"是把因果搞反了：
              用户点选项是**表达意图**，不是"请求显示"。

              ⚠️ 所以文字块在任何模式下都挂（包括三个矩形模式）：
                 · 它们要能看见（已标过的块带颜色与标签）
                 · 矩形模式下它们不接手势（layer 的 touch-action: none
                   已经接管了整层，块自己 pointer-events 由 CSS 控制）
            */
            mountTextBlocksOn(layer, page);

            if (isDrawing) {
                bindLayerDrawing(layer, page);
                trace('anno:bind', 'page=' + page +
                      ' ta=' + getComputedStyle(layer).touchAction +
                      ' pe=' + getComputedStyle(layer).pointerEvents);
            } else if (annotateMode === null) {
                /*
                  ══ ⚠️⚠️ 没选任何类型时，拖拽要给**明确提示**，不能静默无反应 ══

                  用户 2026-09-25 反馈：「无法拖拽形成框，相当于整个选中功能不可用」

                  原因：编辑栏的选项是**开关**语义 —— 再点已选中的会**取消**
                  （见 makeEditTab 的说明），`annotateMode` 变成 null。
                  而 null 时浮层 `pointer-events: none`、也不绑画框监听，
                  页面纯滚动 —— 用户拖了半天什么都画不出来，**且没有任何反馈**，
                  自然会认为"功能坏了"。

                  ⚠️ 「null 时页面纯滚动」这个行为本身是对的
                     （用户明确要求「哪个选项都没点，就不需要画框啊」）。
                     缺的只是**告诉用户为什么**。

                  做法：在层上绑一个**轻量**监听 —— 只在 `pointerup`
                        且位移不明显时弹一次提示气泡，不拦截滚动。
                        ⚠️ 用 `touch-action: auto`（默认，能滚动）+
                          不 preventDefault，所以页面照常滚。
                */
                bindNoModeHint(layer);
            }
        }
    }

    /**
     * 没选类型时：拖拽/点击给出「先选一个框类型」的提示。
     *
     * ⚠️ 只在**短促手势**（点击）时提示，长拖拽（用户其实想滚页面）不打扰 ——
     *    滚动是此时的正常操作，弹提示反而烦。
     * ⚠️ 不 preventDefault、不改 touch-action → 滚动不受影响。
     */
    function bindNoModeHint(layer) {
        var down = null;

        layer.addEventListener('pointerdown', function (ev) {
            down = { x: ev.clientX, y: ev.clientY, t: Date.now() };
        });

        layer.addEventListener('pointerup', function (ev) {
            if (!down) return;
            var dx = Math.abs(ev.clientX - down.x);
            var dy = Math.abs(ev.clientY - down.y);
            var dist = Math.sqrt(dx * dx + dy * dy);
            var dt = Date.now() - down.t;
            down = null;
            /*
              ⚠️ 判据：位移小（< 12px，确实是"点"）且够快（< 600ms）。
                 拖拽滚动不提示 —— 那是用户的正常意图。
            */
            if (dist < 12 && dt < 600) {
                showAnnoTip('reader.annotatePickTip');
            }
        });

        layer.addEventListener('pointercancel', function () {
            down = null;
        });
    }

    /**
     * 当前选的是不是「画矩形」那三个选项之一。
     *
     * ⚠️ `annotateMode` 为 **null**（没选任何选项）时返回 false ——
     *    这是用户明确要求的默认状态：
     *    「编辑模式哪个选项都没点，就不需要画框啊，比如滚动页面啥的」
     */
    function isDrawingMode() {
        return REGION_TYPES.indexOf(annotateMode) >= 0;
    }

    /** 当前是不是「文本」选项（要显示可点的文字块） */
    function isTextMode() {
        return annotateMode === 'text';
    }

    /**
     * 文本模式：把该页**自动识别出的文本块**画成可点区域。
     *
     * ══ ⚠️ 为什么必须这样做（一个绕不过去的事实）══
     *
     * 原始视图里的页是**位图**（原生把 PDF 渲染成 JPEG 再给网页的，
     * 见 PdfPages）。位图里**没有可选的文字** ——
     * `document.getSelection()` 在页面上永远返回空。
     *
     * 所以"在原始视图里选中文字来指定类型"在物理上做不到。
     * 但用户的要求是可实现的，只要换个手法：
     *
     *   我们的 `PdfText` **已经算出了每个块在页面上的包围盒**
     *   （`Block.x0/y0/x1/y1`，归一化 0~1，见 v0.1.17 加的坐标管道）。
     *   把它叠在页图上，就是一个**可点的"文字区域"** ——
     *   点它 = 选中那段文字，然后给它指定类型。
     *
     * 这同时满足了用户的两个说法：
     *   · 「文本…可以选中」      → 点一下即选中（比拖选省事）
     *   · 「框只能是方的，但区域可以根据文本来」
     *                            → 这里的框**不是用户画的**，
     *                              是从文字自身的范围算出来的，
     *                              所以它贴合文字，而不是用户拖的方块
     *
     * ⚠️ 只有**文字块**走这条路。公式/表格/图片里没有可点的文字，
     *    所以那三类仍然是用户手画矩形 —— 那是真正需要人判断的。
     */
    function mountTextBlocksOn(layer, page) {
        var blocks = lastBlocks || [];
        var els = [];
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (!b || !b.text) continue;
            if (b.page !== page) continue;
            // 没有包围盒的块画不出来（原生取不到坐标时）
            if (!(b.x1 > b.x0) || !(b.y1 > b.y0)) continue;
            els.push(b);
        }

        /*
          ══ ⚠️ 必须**从大到小**挂，小块才会在上面（实测逼出来的）══

          同一段落会被切成两类块：
             · 整段一个盒（跨多行，area 大）
             · 每行一个盒（贴在段内，area 小）
          两者的盒是**包含关系**（行盒落在段盒内部）。

          DOM 里后挂的在上层，`elementFromPoint` 命中的是最上层。
          若按原始顺序挂（段盒常常在后），段盒会盖住它内部的所有行盒 ——
          实测 76 个块里 **30 个点不到**（命中率仅 60%），
          症状是"点了没反应 / 点中的是别的行"。

          按面积**降序**挂 → 大盒先入、小盒后入 → 小盒在上。
          这样点小盒得小盒（精确到行），点大盒的空白处仍得大盒。

          ⚠️ 这就是「元素存在、display 正常、却点不到」的又一例 ——
             与项目里 z-index 覆盖那两次事故同一类。
             判据永远是 `elementFromPoint`，不是"元素在不在"。
        */
        els.sort(function (a, b) {
            var aa = (a.x1 - a.x0) * (a.y1 - a.y0);
            var bb = (b.x1 - b.x0) * (b.y1 - b.y0);
            return bb - aa;
        });

        for (var k = 0; k < els.length; k++) {
            layer.appendChild(makeTextBlockEl(els[k], page));
        }
    }

    /**
     * 造一个"可点的文字块"。
     *
     * ⚠️ 坐标用**百分比**（与矩形标注一致），转屏/分屏自动跟着对。
     */
    function makeTextBlockEl(block, page) {
        var el = document.createElement('div');
        el.className = 'anno-block';
        /*
          ⚠️ 已被用户标过的块要显示出来（否则用户不知道哪些改过了）。
             类型+层级都从 textMarks 里查；查不到用原生判的 kind。
        */
        el.setAttribute('data-text-type', 'body');
        el.setAttribute('data-block-line', String(block.line == null ? -1 : block.line));

        el.style.left = (block.x0 * 100) + '%';
        el.style.top = (block.y0 * 100) + '%';
        el.style.width = ((block.x1 - block.x0) * 100) + '%';
        el.style.height = ((block.y1 - block.y0) * 100) + '%';

        var tag = document.createElement('span');
        tag.className = 'anno-block-tag';
        el.appendChild(tag);

        /*
          ⚠️ 样式统一走 [applyBlockStyle] + [effectiveMarkAt]，
             不要在这里再算一套。
             之前这里用 nativeMark、refreshTextBlockStyles 用 markAtLine，
             两套步调不一致 —— 结果是"清空后重进又变回标题"。
        */
        applyBlockStyle(el, effectiveMarkAt(block.line != null ? block.line : -1));

        /*
          ⚠️ 点一下 = 打开类型选择（不是直接删）。
             文本块的常见操作是"改类型"，不是"删掉"。
        */
        el.addEventListener('click', function (ev) {
            ev.stopPropagation();
            /*
              ⚠️ 长按会**补发**一个 click（浏览器行为）。
                 不跳过的话长按设好起点后立刻弹出类型表单，
                 用户还没来得及点终点 —— 区间选择就废了。
                 与项目里 attachLongPress 的用法一致。
            */
            var ui = global.ScholariusUI;
            if (ui && typeof ui.justLongPressed === 'function' && ui.justLongPressed()) {
                return;
            }
            openTextTypePicker(el, block, page);
        });

        /*
          ══ ⚠️ 长按 = 设为区间起点（替代已删除的「选择一段区间」按钮）══

          用户 2026-09-25 两次指出那个按钮多余，已删。
          但区间能力必须留着 —— 原生把摘要切成 14 个交错块，
          逐块点要点 14 次，"把整段摘要标成摘要"根本做不到。

          所以改成**长按触发**：
            · 长按某块 → 它成为区间起点
            · 再普通点另一块 → 弹表单，选类型即覆盖【起点..终点】
          长按是进阶操作，不占界面、不打断「点框→选类型」两步主流程。
        */
        var ui2 = global.ScholariusUI;
        if (ui2 && typeof ui2.attachLongPress === 'function') {
            ui2.attachLongPress(el, function () {
                rangeAnchor = { line: block.line, text: block.text };
                showAnnoTip('reader.rangeArmed');
            });
        }

        return el;
    }

    /**
     * 原生判断的`kind`包装成一个"伪标注"，让未标过的块也有初值。
     *
     * ⚠️ 只用 kind，**不借原生的 level** ——
     *    实测原生 level 要么是 0（判不出）要么猜错，
     *    借它会让未标过的块显示一个假的层级（如 `L2`），
     *    用户以为自己标过。统一从 L1 起，用户想改再改。
     */
    function nativeMark(block) {
        if (block.kind === 'heading') {
            return { type: 'heading', level: 1 };
        }
        return { type: 'body', level: 0 };
    }

    /**
     * 「建立区域」浮动按钮（v0.1.32）。
     *
     * ══ 要解决的问题 ══
     *
     * 用户原话：「不要在这儿停下，**你试着建立新的区域**」。
     *
     * 之前只能靠"逐块点击 → 选类型"，而原生把摘要切成十几块，
     * 想"把这一整段标成摘要"就要点十几次。选字能一次圈住范围，
     * 但选完什么也做不了 —— 高亮只是高亮。
     *
     * ✅ 所以：横向拖选中文字 → 浮出这个按钮 → 选类型 →
     *    把选中的行区间写成一条 `textMark`（`{from, to, type}`）。
     *
     * ⚠️ 与编辑模式的关系：
     *    · 原始视图的**平时态**（非编辑）就能选字建区域 ——
     *      这才是用户要的"随手划一段标成标题"。
     *    · 编辑模式下文字层不接手势（`pointer-events: none`），
     *      这条路径自然不生效，两者不冲突。
     */
    /**
     * 「选中文字 → 建立区域」的接线（v0.1.32，2026-09-26 根据用户纠正重做）。
     *
     * ══ 正确流程（用户明确给出）══
     *
     *   进编辑模式 → 点「文本」选项 → 划选一段文字 → 松手
     *   → **类型选项直接浮出** → 选中类型即落笔
     *
     * 用户原话：
     *   「本身点击选项才应该有选中功能，选中文本应该点击文本选项才行」
     *   「选一个区域，这样文本选项的功能不就空置了吗？」
     *   「选中后直接浮出类型选项」
     *
     * ══ ⚠️⚠️ 我第一版做错了什么 ══
     *
     * 我做成了：非编辑模式也能选字 → 浮出一个「+ Make Region」按钮 →
     * 点按钮才出类型。两个问题：
     *   ① 编辑栏的「文本」选项变得**毫无作用**（它本来是选字的开关）；
     *   ② 多一个多余步骤（选完还要再点一次按钮）。
     *
     * ✅ 现在：选字能力**只属于「文本」选项**，且选中后直接出类型。
     *    那个浮动按钮**已删除**。
     *
     * ⚠️ 「选字能力只属于文本选项」靠 **CSS** 实现（`pointer-events` 只在
     *    `.reader.is-annotating.is-text-mode .pdf-text-layer` 上为 `auto`），
     *    这里不做 JS 判断 —— 一个状态由两处管会出现不同步（本项目吃过亏）。
     */
    function mountSelectionFab() {
        /*
          ⚠️ 保留这个函数名与 `onTextSelection` 接线，因为
             `bindTextLayerSelect` 的 finish 里还会调 `notifySelection`
             （选中为空时用它收尾）。但**不再有任何浮动按钮**。
        */
        onTextSelection = function (text, sel) {
            if (text && sel) {
                currentSelection = sel;
            } else {
                currentSelection = null;
            }
        };
    }

    /**
     * 清掉当前的划选状态（高亮 + 记录的行区间）。
     *
     * ⚠️ 名字从 `hideSelectionFab` 改过来（2026-09-26）——
     *    那个浮动按钮已删，这个函数现在只清状态、不涉及任何按钮。
     */
    function clearTextSelection() {
        currentSelection = null;
    }

    /**
     * 清掉原始视图里所有文字层上的选中高亮（含自己画的色块与 `--sel-*`）。
     *
     * ⚠️ 为什么由这里统一清，而不是各层自己管：
     *    高亮是**跨层**的（用户从一页拖到下一页时，两层都要标），
     *    所以必须有"清全部"的入口 —— 否则切视图后残留的高亮
     *    会在下次进原始视图时莫名其妙地出现。
     */
    function clearRawSelectionHighlight() {
        var on = document.querySelectorAll('.pdf-text-line.is-selected');
        for (var i = 0; i < on.length; i++) {
            on[i].classList.remove('is-selected');
            on[i].style.removeProperty('--sel-from');
            on[i].style.removeProperty('--sel-to');
        }
    }

    /**
     * 把「选中的页内行区间」变成一条 textMark。
     *
     * ══ ⚠️⚠️ 行号体系必须换算，不能直接用（2026-09-25）══
     *
     * `textMarks` 的 `from/to` 是**全局行号**（`textLines` 的下标，
     * 那是整篇论文按 `\n` 切分的行）。
     * 而文字层里的 `data-row` 是**页内行号**（该页按 y 聚类出来的行）。
     *
     * 换算：全局行号 = 该页第一行在全文中的行号 + 页内行号。
     *
     * ⚠️ 页首行号从哪来：`textLines` 里数"这一页有多少行"再累加。
     *    没有逐页行数表可用，所以用**行号区间反查**：
     *    在 `lastBlocks` 里找 y 坐标落在该页的块，取最小行号。
     *
     * ⚠️ 这个换算天然是**近似**的（PDF 的行与"按 \n 切分的行"
     *    不一定一一对应 —— 双栏论文里左右栏的行会交错）。
     *    所以宁可**保守**：算不准就不建区域，而不是建一个错的 ——
     *    「留空可接受，错值不可接受」（本项目一贯判据）。
     */
    function rowsToGlobalFrom(rowFrom, page) {
        if (!lastBlocks || !lastBlocks.length) return null;
        var pageBlocks = [];
        for (var i = 0; i < lastBlocks.length; i++) {
            var b = lastBlocks[i];
            if (b.page !== page) continue;
            if (b.line == null) continue;
            pageBlocks.push(b);
        }
        if (!pageBlocks.length) return null;
        pageBlocks.sort(function (a, b) { return a.line - b.line; });

        /*
          ⚠️ 页内行号是**按 y 排的**，而 b.line 是全局行号 ——
             两者顺序一致（PDF 自上而下），所以可以按下标对齐。
             取该页最小行号 + 页内行号，并要求不越出该页范围。
        */
        var base = pageBlocks[0].line;
        var maxLine = pageBlocks[pageBlocks.length - 1].line;
        var g = base + rowFrom;
        if (g < base || g > maxLine) return null;
        return g;
    }

    function openSelectionTypePicker() {
        var sel = currentSelection;
        if (!sel) return;

        var page = currentSelectionPage();
        var gFrom = rowsToGlobalFrom(sel.rowFrom, page);
        var gTo = rowsToGlobalFrom(sel.rowTo, page);

        if (gFrom == null) {
            showError('annotateNoLine');
            return;
        }
        if (gTo == null || gTo < gFrom) gTo = gFrom;

        /*
          ⚠️ 造一个"伪 block"喂给既有的 openTextTypePicker ——
             它只用到 `block.line` 和 `block.text`：
               · line 用于从 textMarks 查当前类型
               · text 用于数行数（applyTextType 里 `split('\n').length`）
             所以把 text 造成"含 (gTo - gFrom + 1) 行"的字符串，
             让既有逻辑算出正确的 to。
        */
        var rowCount = gTo - gFrom + 1;
        var fakeText = new Array(rowCount + 1).join('x\n').replace(/\n$/, '');
        var fakeBlock = { line: gFrom, text: fakeText, kind: 'paragraph' };

        /*
          ⚠️⚠️ 必须清掉 `rangeAnchor`（2026-09-26）

             它是**逐块点选**那条路径的"区间起点"（长按某块 → 再点另一块）。
             我们这里是划选，区间**已经确定**（gFrom..gTo），
             不需要它参与。

             ⚠️ 不清的后果：`applyTextType` 里
                `hasRange = (toLineOverride != null && rangeAnchor && ...)` ——
                如果上一次逐块操作留了个锚点，这里会按**锚点**算 from，
                落笔位置就完全错了（标到用户没选的地方）。

             实测踩过同类：`rangeAnchor` 残留导致"清空后重新标注落错位置"。
        */
        rangeAnchor = null;

        /*
          ⚠️ 复用编辑模式那套 `.anno-typesheet` 外壳 ——
             用户已经认得那个弹层，另做一个只会让人以为出现了新东西。
        */
        openTextTypePicker(null, fakeBlock, page);
    }

    /** 当前选中的文字层属于第几页（0 起，与 lastBlocks[].page 同口径） */
    function currentSelectionPage() {
        var layers = document.querySelectorAll('.pdf-text-layer');
        for (var i = 0; i < layers.length; i++) {
            if (!layers[i].querySelector('.pdf-text-line.is-selected')) continue;
            var slot = layers[i].closest('.pdf-slot');
            /*
              ⚠️⚠️ `data-page` 是**1 起**的（`for (p = 1; p <= count; p++)`），
                 而 `lastBlocks[].page` 与 `mountTextLayer(slot, page, id)`
                 收的 `page` 都是 **0 起**（原生 `PdfText` 的页码）。
                 这里必须减 1，否则差一页 —— 实测过：
                 第 1 页选中的文字会被当成第 2 页去找块，`rowsToGlobalFrom`
                 找不到块直接返回 null，用户看到的是"点了没反应"。
            */
            if (slot && slot.dataset.page != null) {
                return (parseInt(slot.dataset.page, 10) || 1) - 1;
            }
            var all = document.querySelectorAll('.pdf-slot');
            for (var j = 0; j < all.length; j++) {
                if (all[j] === slot) return j;
            }
            return 0;
        }
        return 0;
    }

    /**
     * 弹出文本类型选择（八类）。
     *
     * ⚠️ 用底部**弹出层**而不是原生的 `<select>` ——
     *    原生 select 在 Android WebView 里会拉起系统滚轮，
     *    样式完全不受我们控制，与阅读页的视觉语言断裂。
     */
    function openTextTypePicker(anchorEl, block, page) {
        closeTextTypePicker();

        var sheet = document.createElement('div');
        sheet.className = 'anno-typesheet';
        sheet.setAttribute('role', 'dialog');

        var title = document.createElement('div');
        title.className = 'anno-typesheet-title title-text';
        /*
          ⚠️ 标题是「编辑」而不是「重新归类 / 改为哪一类」
             （用户 2026-09-25 明确要求）。

             理由：点一个已有的框，用户心里想的是「改这一个」，
             而出厂文案「改为哪一类」听起来像是从头新建。
        */
        title.textContent = t('reader.editMark');
        sheet.appendChild(title);

        /*
          ⚠️ 原来的「将把第 a 行到第 b 行一起标注」提示**已删除**。
             用户原话：「下面"选择一个范围"这个提示文字也多余」。

             区间选择本身留着（它把标一整段摘要从 14 次点击降为 2 次），
             但靠**按钮的按下态**表达"正在选区间"，不再刷一行说明文字 ——
             那条文字每次开表单都在，而用户看一眼就懂了。
        */

        var grid = document.createElement('div');
        grid.className = 'anno-typegrid';

        for (var i = 0; i < TEXT_TYPES.length; i++) {
            grid.appendChild(makeTextTypeOption(TEXT_TYPES[i], block, page));
        }
        sheet.appendChild(grid);

        /*
          ⚠️ 「选择一段区间」按钮**已删除**（用户 2026-09-25 第二次指出）。

             第一次我误以为用户要删的只是那行说明文字
             （「将把第 a 行到第 b 行一起标注」），于是保留了按钮。
             用户随即追问：「选择一段区间这个提示不是没删吗？」
             —— 对，用户要删的就是**这个按钮本身**。

             理由（想清楚了）：它是个多余的中间步骤。
             原来的流程是 点框 → 点「选择一段区间」→ 点终点 → 选类型，
             四步；而普通标注只要 点框 → 选类型，两步。
             为了一类操作凭空多出一步、还常驻在弹层里，
             每次开表单都看见它 —— 这就是"多余"。

             ⚠️ 区间能力**保留**（标一整段摘要必须能一次覆盖，
                否则摘要被原生切成 14 块时要点 14 次），
                改由**长按**触发：长按某块 = 把它设为区间起点。
                长按是"进阶操作"，不占界面、不打断两步主流程。
        */

        /*
          ⚠️ 底部两按钮：取消（左） / 删除（右）——
             用户 2026-09-25 要求：「选项除了取消，右边应该是删除」。

          ⚠️ 删除用 `.btn-danger`（红色），不是 `.btn-primary`（绿色）——
             绿色在本项目里专表「确认某操作」，而删除是破坏性的。
             见 styles.css 的按钮规范。
        */
        var cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.type = 'button';
        cancel.textContent = t('action.cancel');
        cancel.addEventListener('click', function () {
            /*
              ⚠️ 「取消」要**连区间起点一起清**。
                 （而点背景只关弹层、保留起点）
                 用户按取消 = 我这一次整个不要了。
            */
            rangeAnchor = null;
            closeTextTypePicker();
        });

        var del = document.createElement('button');
        del.className = 'btn btn-danger';
        del.type = 'button';
        del.textContent = t('action.delete');
        del.addEventListener('click', function () {
            /*
              ⚠️ 删除 = **去掉该块上的标注**，让它回到自动识别的结果。
                 不是删除 PDF 里的内容 —— 文字还在，只是不再被标识为某个类型。
                 所以提示语不能写"删除"这种吓人的词（见 confirmText）。
            */
            clearTextMarkFor(block);
            rangeAnchor = null;
            closeTextTypePicker();
        });

        var actions = document.createElement('div');
        actions.className = 'form-actions';
        actions.appendChild(cancel);
        actions.appendChild(del);
        sheet.appendChild(actions);

        var backdrop = document.createElement('div');
        backdrop.className = 'anno-typebackdrop';
        /*
          ⚠️ 点背景**只关弹层，不清区间起点**。

             这里踩过一次：最初写成 backdrop 也清 rangeAnchor，
             结果「点起点 → 选区间 → 关弹层 → 点终点」的流程
             到终点时起点已经没了，终点只标了自己一块 ——
             区间功能等于没用（实测确认）。

             用户关掉弹层多半是想**看清页面再决定终点**，
             不是想放弃区间。真正要清的是「取消」按钮。
        */
        backdrop.addEventListener('click', closeTextTypePicker);

        if (root) {
            root.appendChild(backdrop);
            root.appendChild(sheet);
        }
        textPickerEls = [backdrop, sheet];
    }

    /** 造类型选择里的一个选项 */
    function makeTextTypeOption(type, block, page) {
        var btn = document.createElement('button');
        btn.className = 'anno-typeopt';
        btn.type = 'button';

        /*
          ⚠️ 当前生效的类型要高亮（用户 2026-09-25 要求"选中后填充图标"）。

             这里是**八选一**的选择器，所以"选中"指"这个块现在就是这个类型"。
             用 `aria-pressed` + 两只图标切换，与底栏编辑项同一套语言。

             ⚠️ 不能靠背景色块表示选中 —— 用户已明确否定过
                「不要阴影和点击特效」，且那不是本项目导航栏的语言。
        */
        var current = markAtLine(block.line != null ? block.line : -1) || nativeMark(block);
        var selected = current.type === type;
        btn.setAttribute('aria-pressed', selected ? 'true' : 'false');

        var ui = global.ScholariusUI;
        if (ui && ui.icon && ui.iconFilled && TYPE_ICON[type]) {
            var nm = TYPE_ICON[type];
            btn.innerHTML =
                ui.icon(nm).replace('<svg ', '<svg class="icon-outline" ') +
                ui.iconFilled(nm).replace('<svg ', '<svg class="icon-fill" ');
        } else if (ui && ui.icon && TYPE_ICON[type]) {
            btn.innerHTML = ui.icon(TYPE_ICON[type]);
        }

        var label = document.createElement('span');
        label.textContent = t(TYPE_LABEL_KEY[type] || type);
        btn.appendChild(label);

        btn.addEventListener('click', function () {
            /*
              ⚠️ 「章节标题」多一步：先问**哪一级**，再落笔。

                 用户要求「先分…各个一级大纲标题所表示的区域，
                 然后每个一级章节区域可以再分」——
                 "再分"就是靠这里的层级表达的。
                 其余类型没有层级概念，点一下直接落笔（保持一步操作）。

              ⚠️ 层级那一步同样要**带上区间**（rangeEndFor）——
                 否则「区间 + 章节标题」组合会把区间吞掉，
                 用户选了区间却只标中一块，而提示语还说标了一片。
                 实测验过：漏传时 7~19 全是 body。
            */
            if (type === 'heading') {
                openHeadingLevelPicker(block, page, rangeEndFor(block));
                return;
            }
            applyTextType(block, type, 0, rangeEndFor(block));
            closeTextTypePicker();
        });

        return btn;
    }

    /**
     * 这次点选的**终点行号**（没有选起点时返回 null）。
     *
     * ⚠️ 见 [applyTextType] 里 RangeSpan 的说明 —— 摘要被原生切成
     *    14 个交错块，必须能一次覆盖一整个区间。
     *
     * ⚠️ 终点**必须晚于起点**。用户先点下面、再点上面时，
     *    要把两者对调而不是报错（否则得重新点一遍，很恼人）。
     */
    function rangeEndFor(block) {
        if (!rangeAnchor || block.line == null) return null;
        if (block.line === rangeAnchor.line) return null;   // 同一点两下 = 取消区间
        if (block.line < rangeAnchor.line) {
            // 反向选：把锚点改到上面那块，终点取原来的锚点
            var lower = block.line;
            var upper = rangeAnchor.line;
            rangeAnchor = { line: lower, text: block.text };
            return upper;
        }
        return block.line;
    }

    /**
     * 区间选择的第一步：把某块设为**起点**，并打开类型选择。
     *
     * ⚠️ 为什么起点也要弹类型选择（而不是"选起点→选终点→再选类型"）：
     *    用户点第一下时心里已经有目标类型了。让他先选类型、
     *    再点终点确认，比"点两下再选类型"少一步。
     */
    function startRangeFrom(block, page) {
        rangeAnchor = { line: block.line, text: block.text };
        openTextTypePicker(null, block, page);
    }

    /**
     * 区间是否可用（有起点，且当前块不与起点同行）。
     */
    function canUseRange(block) {
        return !!(rangeAnchor && block.line != null && block.line !== rangeAnchor.line);
    }

    /**
     * 第二步：选章节标题的层级（一级 / 二级 / 三级）。
     *
     * ⚠️ 复用同一个弹层外壳（`.anno-typesheet`），只是把内容换成层级 ——
     *    不新造一个风格不同的弹层（用户明确要求样式通用：
     *    「不能随便一个新场景就用新字体样式」）。
     *    所以标题仍用 `.title-text`、按钮仍用 `.anno-typeopt`。
     */
    function openHeadingLevelPicker(block, page, toLine) {
        closeTextTypePicker();

        var sheet = document.createElement('div');
        sheet.className = 'anno-typesheet';
        sheet.setAttribute('role', 'dialog');

        var title = document.createElement('div');
        title.className = 'anno-typesheet-title title-text';
        title.textContent = t('reader.pickHeadingLevel');
        sheet.appendChild(title);

        var grid = document.createElement('div');
        grid.className = 'anno-typegrid';

        for (var lv = 1; lv <= MAX_HEADING_LEVEL; lv++) {
            grid.appendChild(makeHeadingLevelOption(lv, block, toLine));
        }
        sheet.appendChild(grid);

        var cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.type = 'button';
        cancel.textContent = t('action.cancel');
        cancel.addEventListener('click', function () {
            // 返回上一步而不是全关：用户多半是点错了
            openTextTypePicker(null, block, page);
        });

        var actions = document.createElement('div');
        actions.className = 'form-actions';
        actions.appendChild(cancel);
        sheet.appendChild(actions);

        var backdrop = document.createElement('div');
        backdrop.className = 'anno-typebackdrop';
        /*
          ⚠️ 同样**保留区间起点**（与类型弹层一致）。
             两处行为不一致会让人不敢相信任何一处。
        */
        backdrop.addEventListener('click', closeTextTypePicker);

        if (root) {
            root.appendChild(backdrop);
            root.appendChild(sheet);
        }
        textPickerEls = [backdrop, sheet];
    }

    /** 造层级选择里的一个选项 */
    function makeHeadingLevelOption(lv, block, toLine) {
        var btn = document.createElement('button');
        btn.className = 'anno-typeopt anno-levelopt';
        btn.type = 'button';
        btn.setAttribute('data-level', String(lv));

        /*
          ⚠️ 用「L1/L2/L3」而不是再画一只图标。
             层级是**数值关系**，文字比图标更直接；
             而且 8 个类型各有图标时再来 3 只同族图标只会更乱。
        */
        var mark = document.createElement('span');
        mark.className = 'anno-levelmark';
        mark.textContent = 'L' + lv;
        btn.appendChild(mark);

        var label = document.createElement('span');
        label.textContent = t('reader.headingLevel' + lv);
        btn.appendChild(label);

        btn.addEventListener('click', function () {
            /*
              ⚠️ toLine 必须**原样透传**。
                 漏传的话「区间 + 章节标题」会把区间吞掉，
                 用户选了区间却只标中一块（实测过）。
            */
            applyTextType(block, 'heading', lv, toLine);
            closeTextTypePicker();
        });

        return btn;
    }

    /**
     * 把一段文字标成某个类型。
     *
     * ⚠️ 存的是**行号区间**（TextMark.from/to），不是坐标 ——
     *    文本区域由文字自身界定，行号才是稳定的表示。
     *    见 AnnotationStore.TextMark 的说明。
     *
     * ⚠️ 同类型的旧标注要先**替换**，不能叠加 ——
     *    同一个块被标两次会留下两条记录，渲染时谁生效取决于顺序，
     *    那是不可预期的。
     *
     * @param {Number} lv 仅对 `heading` 有意义：大纲层级 1/2/3。
     *
     *     ══ ⚠️ 为什么必须由用户给层级（2026-09-24 实测）══
     *     此前写死 `block.level || 1`，而 `block.level` 是**原生猜的**，
     *     实测在这篇论文上要么是 0（判不出）要么猜错，导致：
     *         · 用户标的所有标题都变成 level 1
     *         · 阅读视图永远是 78 个**平坦** lv1 区域，层级立不起来
     *         · 用户要求的「每个一级章节区域可以再分」**无法表达**
     *     所以层级改成用户显式指定，不再从原生借。
     */
    function applyTextType(block, type, lv, toLineOverride) {
        /*
          ══ ⚠️ 区间选择：起点是**锚点**，不是这次点的块 ══

          这里踩过一次：最初写成 `from = block.line`（本次点的块 = 终点），
          而 `to` 只往后延伸（`toLineOverride > to` 才生效），
          于是「起点 7 → 终点 20」算出 from=20、to=19 —— 区间为空，
          最后**只有终点那一块**被标注（实测：块 20 变 abstract，
          7~19 全是 body）。界面上提示语却老老实实写着
          "将把第 7 行到第 20 行一起标注" —— 提示和结果不一致。

          正确：区间生效时 from 取锚点（较小那端），to 取终点。
        */
        var hasRange = (toLineOverride != null && rangeAnchor &&
                        toLineOverride !== rangeAnchor.line);
        var from = hasRange
            ? Math.min(rangeAnchor.line, toLineOverride)
            : ((block.line == null) ? null : block.line);

        /*
          ⚠️ 块没有行号时无法存（见 AnnotationStore.TextMark 的说明）。
             这是数据缺失而不是用户错误，所以**静默不改**并记一条日志，
             而不是弹一个用户看不懂的错误。
        */
        if (from == null || from < 0) {
            trace('reader:annotate', 'block has no line number, skip');
            showError('annotateNoLine');
            return;
        }

        // 行数按 \n 数估，与 buildRegions 的口径一致
        var n = block.text.split('\n').length;
        var to = from + n - 1;

        /*
          ══ ⚠️ 区间选择（RangeSpan，2026-09-24）══

          为什么必须有：原生的 heading 判据在这篇论文上把**摘要切成
          14 个交错的 heading/paragraph 块**（实测块 7~20）。
          逐块标的话用户要点 14 次、且每次都只覆盖一行 ——
          根本不可能把整段摘要标成"摘要"。

          做法：用户先点**起点**，再点**终点**，中间全部归入同一类型。
          起点存在 `rangeAnchor`，终点就是本次点的那一块。

          ⚠️ 用**行号**而不是块号表达区间：
             与 TextMark 的存储单位一致（都是全局行号），
             存下来就是一条 mark，不需要新数据结构。
        */
        if (hasRange) {
            to = Math.max(to, toLineOverride);
        }

        /*
          ⚠️ 层级必须夹在 1..MAX_HEADING_LEVEL 内。
             渲染侧的单行标记按 `border-left` 宽度区分层级，
             层级过大没有对应样式（也不会报错，只是看不出差别）。
        */
        var level = 0;
        if (type === 'heading') {
            level = (lv > 0 && lv <= MAX_HEADING_LEVEL) ? lv : 1;
        }

        // 先删掉与该区间重叠的旧标注
        var kept = [];
        for (var i = 0; i < textMarks.length; i++) {
            var m = textMarks[i];
            var overlaps = !(m.to < from || m.from > to);
            if (!overlaps) kept.push(m);
        }
        kept.push({
            from: from,
            to: to,
            type: type,
            level: level
        });
        textMarks = kept;
        annotateDirty = true;
        /*
          ⚠️ 落笔后清掉区间起点 —— 一次区间只服务一次落笔。
             不清的话下一次点选会静默地带上一片区间。
        */
        rangeAnchor = null;

        /*
          ⚠️ 改完立刻局部重画 —— 用户要看到"这块现在被标成摘要了"。
             只重画那一个块的样式，不整页重建（重建会把滚动位置抖动）。
        */
        refreshTextBlockStyles();

        /*
          ⚠️ 落笔后把「建立区域」按钮和选中高亮**一起收掉**（2026-09-25）。

             用户的动作序列是：选字 → 点「建立区域」→ 选类型。
             选完类型这条流程就结束了 —— 按钮还留着的话，
             用户会以为"还要再点一次"，而再点只会重复标同一段。

             ⚠️ 高亮也要清：它现在代表"选中的待标注内容"，
                标注完了就不再是"待标注"，留着会让人以为还悬着。
        */
        clearTextSelection();
        clearRawSelectionHighlight();

        trace('reader:annotate', 'text ' + type +
            (type === 'heading' ? ' L' + level : '') + ' @' + from + '-' + to);
    }

    /**
     * 去掉某一块上的标注（回到自动识别的结果）。
     *
     * ⚠️ 是"删掉用户标的类型"，**不是**删除 PDF 里的文字 ——
     *    文字还在，只是不再被强制归到某个类型。
     */
    function clearTextMarkFor(block) {
        if (!block || block.line == null) return;

        var from = block.line;
        var to = from + block.text.split('\n').length - 1;
        var kept = [];
        for (var i = 0; i < textMarks.length; i++) {
            var m = textMarks[i];
            var overlaps = !(m.to < from || m.from > to);
            if (!overlaps) kept.push(m);
        }
        if (kept.length === textMarks.length) {
            // 本来就没标过 —— 不用改动，也不必标脏
            return;
        }
        textMarks = kept;
        annotateDirty = true;
        refreshTextBlockStyles();
        trace('reader:annotate', 'clear text @' + from + '-' + to);
    }

    /**
     * **按类型清空**（用户 2026-09-25 要求）。
     *
     * 用户原话：「当自动识别的结果一团乱麻的时候，一个个改太难了，
     *            直接给一个清空选项，确认表单确认之后该性质的所有框
     *            都直接清除」
     *
     * ══ ⚠️⚠️ 关键：必须作用于**有效类型**，不能只看 textMarks ══
     *
     * 这里踩过一个很典型的坑（用户报的）：
     *   「点击清除提示没有可以删除的，但框都实实在在地在那里」
     *
     * 根因是有**两层**类型来源：
     *   ① 原生自动识别（block.kind）→ 用户**看到**的那些框
     *   ② 用户标注（textMarks）      → 用户**改过**的
     * 最初的实现只数 ②。一篇刚导入、还没标过的论文 ② 是空的，
     * 于是提示"没有可清空的标注" —— 而屏幕上明明写着 15 个
     * `章节标题` 框（来自 ①）。**用户看到的是框，框就是识别结果本身。**
     *
     * 所以清空要把 ① 也算进来，做法是：
     *   把命中类型的块**显式标成"正文"**，用一条用户标注去**覆盖**
     *   原生的判断。这样语义上也说得通 —— "我不同意你判的，
     *   我按我的来"，而且它可保存、可撤销（再改回别的类型即可）。
     *
     * ⚠️ 但不能真去改 `block.kind`：那是提取层的产物，
     *    重进页面就重新算一遍，改动留不下来。
     *
     * @param {String} type 要清空的类型；null 表示清空**全部**类型
     * @return {Number} 被清掉了几块
     */
    function clearTextMarksByType(type) {
        var blocks = lastBlocks || [];
        var kept = [];
        var removed = 0;

        /*
          ══ ⚠️⚠️ 第 1 步：丢掉命中类型的用户标注，但**保留 body 覆盖** ══

          这里踩过一个很严重的坑（用户 2026-09-25 实测反馈）：
            「一开始自动识别的框是乱的 → 点清除 → 清除后还剩一个
              改不掉的框 → 再清除 → 又回到了自动识别的那些乱框」

          根因：清除是**两步**——
            ① 丢掉 textMarks 里命中的标注
            ② 把当前非 body 的块标成 body（用**用户标注覆盖**原生判断，
               因为原生判断改不动，见下面第 2 步的说明）

          而 `type = null`（清除全部）时，第 ① 步会把第 ② 步上一轮
          产生的覆盖标注**一起丢掉** → `effectiveTypeAt` 退回原生判定
          → 第 ② 步又看到 heading → 重建覆盖。

          看起来像"幂等"，实际每次清除都在
          「丢掉上一轮的覆盖 → 按原生结果重新生成覆盖」之间循环。
          而两次之间只要有任何**原生判非 body、但这次跳过了**的块
          （比如 `b.line == null`，第 ② 步会 continue），
          它的覆盖就丢了 → **原生乱框复活**。

          真机实测（tools/emu_clear_check.py）：
            ① 初始        : {"heading/L1": 1}
            ② 清除一次后   : {}                  ← 清干净
            ③ 再清除后     : {"heading/L1": 1}   ← ❌ 复活
            日志：两次都是 `clear by type (all) affected=3`
                  —— 第二次"清除"反而清出了 3 个东西

          ✅ 解法：**覆盖标注是"清除操作的状态"，不是"用户的意图"**，
             所以清空时不能丢它。判据：`type === 'body'` 的标注
             一律保留 —— 它要么是上次清除留下的覆盖，
             要么是用户手标的"这段是正文"（清空"全部"时也该留着，
             因为它正是"我不想要任何特殊标记"的表达）。
        */
        for (var i = 0; i < textMarks.length; i++) {
            var m = textMarks[i];
            /*
              ⚠️ body 覆盖一律留下（理由见上）。
                 非 body 的才按 type 过滤丢掉。
                 `!type` 表示清空全部 —— 那时丢掉所有非 body 标注。
            */
            if (m.type === 'body') {
                kept.push(m);
                continue;
            }
            if (!type || m.type === type) {
                removed++;
                continue;
            }
            kept.push(m);
        }

        /*
          ⚠️ 第 2 步：把**原生判成该类型**、且用户没另行标注过的块，
             显式标成"正文"（覆盖原生判断）。
             这一步才是用户真正想要的 —— 他看到的那 15 个框。
        */
        for (var j = 0; j < blocks.length; j++) {
            var b = blocks[j];
            if (!b || !b.text || b.line == null) continue;

            var eff = effectiveTypeAt(b.line, b);
            if (type && eff !== type) continue;

            /*
              ⚠️ 已经是 body 的块**不用**再标一条 —— 没有意义，
                 还白占存储。只有"原生判错了"的才需要覆盖。
            */
            if (eff === 'body') continue;

            kept.push({
                from: b.line,
                to: b.line + b.text.split('\n').length - 1,
                type: 'body',
                level: 0
            });
            removed++;
        }

        if (removed) {
            textMarks = kept;
            annotateDirty = true;
            refreshTextBlockStyles();
            /*
              ══ ⚠️⚠️ 清空后必须**重新渲染阅读视图**（2026-09-25 用户实测）══

              用户原话：
                「我在编辑模式里面清空了所有区域，怎么阅读视图还没有变化？」

              真机实测（tools/emu_clear_fab.py）：
                清空前 类型分布: {"heading":4,"body":619,"author":1}
                清空后 类型分布: {"body":624}          ← 数据全变了
                日志：clear by type (all) affected=10

                但阅读视图的标签：
                  "Attention Is All You Need"  H2 → H2   ❌ 没变
                  "Uszkoreit∗Google Brain"     H2 → H2   ❌ 没变
                  "Kaiser∗Google"              H2 → H2   ❌ 没变
                  "Abstract The"               H2 → H2   ❌ 没变
                6 个里只有 2 个碰巧变了。

              ⚠️ 根因：阅读视图的 DOM（h2/p）是上次 renderBlocks 时
                 生成的，标签与字号**在那一刻就定死了**。
                 `refreshTextBlockStyles()` 只刷新**编辑模式页图上**
                 那些 `.anno-block` 的样式，**碰不到阅读视图的字**。
                 所以清空只改了数据，画面不动。

              ✅ 修法：数据变过就重放一次正文渲染。
                 复用 restoreReadingContent（它内部就是
                 `contentEl.textContent=''` + `renderBlocks(lastBlocks)`，
                 与"从原始视图切回阅读视图"走同一条路，
                 保证两条路径渲染结果一致 —— 这正是之前
                 refreshTextBlockStyles 注释里强调过的"同源"要求）。
            */
            if (!annotating) {
                /*
                  ⚠️ 只在**不在编辑模式**时重渲。
                     编辑模式下 contentEl 里是页图（不是正文），
                     重渲会把页图清掉 —— 那是灾难性的。
                     编辑模式里改了类型，退出时（setAnnotating(false)）
                     本来就会走一次重渲，这里不必也不该插手。
                */
                restoreReadingContent();
            }
        }
        trace('reader:annotate', 'clear by type ' + (type || '(all)') + ' affected=' + removed);
        return removed;
    }

    /**
     * 某一行**当前生效**的类型（用户标注优先，否则用原生判断）。
     *
     * ⚠️ 这是"清空"与"高亮"共用的判据 —— 两处必须完全一致，
     *    否则会出现"高亮说它是章节标题、清空却说不关我事"的矛盾。
     *    实测踩过：清空只数 textMarks，屏幕上却有 15 个原生判的标题框。
     */
    function effectiveTypeAt(line, block) {
        var m = markAtLine(line);
        if (m) return m.type;
        var b = block || blockAtLine(line);
        return b ? nativeMark(b).type : 'body';
    }

    /** 按行号找回那个块（lastBlocks 里查） */
    function blockAtLine(line) {
        var blocks = lastBlocks || [];
        for (var i = 0; i < blocks.length; i++) {
            if (blocks[i] && blocks[i].line === line) return blocks[i];
        }
        return null;
    }

    /**
     * 数一下清空**实际会影响多少块**（给确认文案用）。
     *
     * ⚠️⚠️ 不能只数"有效类型等于 type 的块" —— 那样会把
     *    **本来就该是正文**的块也算进去。
     *
     *    实测：ResNet 全篇 1110 块里只有 107 个是原生判的 heading，
     *    其余 1003 个本来就是 body。若照单全收会显示
     *    「将清除 1110 个区域」，而实际只动 107 个 —— 数字夸大十倍，
     *    用户会被吓到，而且这是**假信息**。
     *
     * ⚠️ 判据必须与 [clearTextMarksByType] 完全一致：
     *    只有"消除后**类型会变**"的块才算。
     *      · 用户标过的、命中 scope    → 会变（标注被删）
     *      · 原生判非 body、命中 scope → 会变（会被显式标成 body）
     *      · 本来就是 body 且没标注    → 不变，不计
     */
    function countTextMarks(type) {
        var blocks = lastBlocks || [];
        var n = 0;
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (!b || !b.text || b.line == null) continue;

            var mark = markAtLine(b.line);
            if (mark) {
                // 用户标过的：命中 scope 就会被删掉
                if (!type || mark.type === type) n++;
                continue;
            }

            // 没标过的：只有原生判成非 body 才需要覆盖
            var native = nativeMark(b).type;
            if (native === 'body') continue;
            if (type && native !== type) continue;
            n++;
        }
        return n;
    }

    /** 关掉类型选择弹层 */
    function closeTextTypePicker() {
        for (var i = 0; i < textPickerEls.length; i++) {
            var el = textPickerEls[i];
            if (el && el.parentNode) el.parentNode.removeChild(el);
        }
        textPickerEls = [];
    }

    /** 按新的 textMarks 刷新页上文字块的类型样式与标签 */
    function refreshTextBlockStyles() {
        for (var i = 0; i < annotateLayers.length; i++) {
            var layer = annotateLayers[i];
            var blocks = layer.querySelectorAll('.anno-block');
            for (var k = 0; k < blocks.length; k++) {
                var el = blocks[k];
                var line = parseInt(el.getAttribute('data-block-line'), 10);
                if (isNaN(line) || line < 0) continue;

                /*
                  ⚠️ 必须用 [effectiveTypeAt]（标注优先、否则原生）——
                     不能只传 markAtLine 然后让 applyBlockStyle 默认成 body。
                     那样会让"清空"后的块全部看起来是正文，
                     而重进页面（走 makeTextBlockEl）又变回原生判的标题。
                     两条路径必须同源，否则症状是"改了又变回去"。
                */
                applyBlockStyle(el, effectiveMarkAt(line));
            }
        }
    }

    /**
     * 某一行**当前生效**的那条标注（合成后的）。
     *
     * ⚠️ 与 [effectiveTypeAt] 的区别：这个返回完整的 mark 对象
     *    （带 level），供样式使用；effectiveTypeAt 只要类型字符串。
     *    两个都要有 —— 硬合成一个会让调用处到处拆字段。
     */
    function effectiveMarkAt(line) {
        var m = markAtLine(line);
        if (m) return m;
        var b = blockAtLine(line);
        return b ? nativeMark(b) : { type: 'body', level: 0 };
    }

    /**
     * 把一个块的样式/标签按它当前的标注刷新。
     *
     * ⚠️ 抽出来是因为有**两个**调用点：
     *    · refreshTextBlockStyles（改完标注后整层刷）
     *    · makeTextBlockEl（新挂的块要显示已存标注）
     *    两边写法不一致过 —— 一处显示层级一处不显示，
     *    用户就会觉得"标注没生效"。
     */
    function applyBlockStyle(el, mark) {
        var ttype = mark ? mark.type : 'body';
        var lv = (ttype === 'heading' && mark && mark.level > 0) ? mark.level : 0;

        /*
          ⚠️ 只换 `anno-block-*` 这一个类，**不能整串覆盖 className**。
             makeTextBlockEl 和这里都往块上加类，整串覆盖会把
             对方加的类抹掉（现在只有 anno-block-*，但两边写法
             必须一致，否则将来加类的人会踩坑）。
        */
        var keep = [];
        var parts = String(el.className).split(/\s+/);
        for (var q = 0; q < parts.length; q++) {
            if (parts[q] && parts[q].indexOf('anno-block-') !== 0) {
                keep.push(parts[q]);
            }
        }
        keep.push('anno-block-' + ttype);
        /*
          ⚠️ 层级也做成类（`anno-block-heading-lv2`），
             因为渲染侧的左缩进/竖线粗细由 CSS 给 ——
             把层级写进 style 会让"层级→样式"的定义散在 JS 里。
             （CSS 不搭字体，只管布局与缩进；用户要求样式集中通用。）
        */
        if (lv > 0) {
            keep.push('anno-block-heading-lv' + lv);
        }
        el.className = keep.join(' ');

        el.setAttribute('data-text-type', ttype);
        el.setAttribute('data-text-level', String(lv));

        var tag = el.querySelector('.anno-block-tag');
        if (tag) tag.textContent = blockTagText(ttype, lv);
    }

    /**
     * 块小标签的文案。
     *
     * ⚠️ 章节标题要带上层级（`章节标题 L2`）。
     *    不带的话用户根本分不清自己标的是哪一级 ——
     *    而层级正是这个功能的全部意义（用户要求"可以再分"）。
     */
    function blockTagText(ttype, lv) {
        var base = t(TYPE_LABEL_KEY[ttype] || ttype);
        if (ttype === 'heading' && lv > 0) {
            return base + ' L' + lv;
        }
        return base;
    }

    /** 查某一行对应的标注（没有则 null） */
    function markAtLine(line) {
        for (var i = 0; i < textMarks.length; i++) {
            var m = textMarks[i];
            if (line >= m.from && line <= m.to) return m;
        }
        return null;
    }

    /** 查某一行属于哪个文本类型（用户标过优先） */
    function typeAtLine(line) {
        var m = markAtLine(line);
        return m ? m.type : 'body';
    }


    function unmountAnnotateLayer() {
        for (var i = 0; i < annotateLayers.length; i++) {
            var el = annotateLayers[i];
            if (el && el.parentNode) {
                el.parentNode.removeChild(el);
            }
        }
        annotateLayers = [];
    }

    /**
     * 把浮层对齐到**图片实际显示区域**。
     *
     * ⚠️ 必须等图片加载完再算（`naturalWidth` 才有值）。
     *    所以这里既在 mount 时调一次，也在 img 的 load 事件里调一次。
     *
     * ⚠️ 用 `object-fit: contain` 的等效算法：
     *    先按容器宽高比与图片宽高比比较，决定是"上下留白"还是"左右留白"。
     */
    function positionAnnotateLayer(layer) {
        if (!layer) return;
        var slot = layer.parentNode;
        if (!slot) return;

        var img = slot.querySelector('.pdf-page-img');
        if (!img || !img.naturalWidth || !img.naturalHeight) {
            /*
              ⚠️ 图还没加载出来（懒加载尚未触发）—— 先铺满容器。
                 等 img 的 load 事件到了会重算。铺满而不是隐藏，
                 是为了让用户能立刻开始画（不要留一片点不到的区域）。
            */
            layer.style.left = '0';
            layer.style.top = '0';
            layer.style.width = '100%';
            layer.style.height = '100%';
            return;
        }

        var cw = slot.clientWidth;
        var ch = slot.clientHeight;
        if (!cw || !ch) return;

        var imgRatio = img.naturalWidth / img.naturalHeight;
        var boxRatio = cw / ch;

        var w, h;
        if (imgRatio > boxRatio) {
            // 图更宽 → 以宽为准，上下留白
            w = cw;
            h = cw / imgRatio;
        } else {
            // 图更高 → 以高为准，左右留白
            h = ch;
            w = ch * imgRatio;
        }

        layer.style.width = w + 'px';
        layer.style.height = h + 'px';
        layer.style.left = Math.round((cw - w) / 2) + 'px';
        layer.style.top = Math.round((ch - h) / 2) + 'px';
    }

    /** 在浮层上画出该页已有的矩形标注 */
    function drawRegionsOn(layer, page) {
        for (var i = 0; i < regionMarks.length; i++) {
            var m = regionMarks[i];
            if (m.page !== page) continue;
            layer.appendChild(makeRegionBox(m, i));
        }
    }

    /**
     * 造一个矩形标注的 DOM。
     *
     * ⚠️ 坐标是归一化的，这里用**百分比**定位 ——
     *    这样浮层尺寸怎么变（转屏/分屏）框都跟着对，
     *    不需要监听 resize 重算每一个框。
     */
    function makeRegionBox(mark, index) {
        var box = document.createElement('div');
        box.className = 'anno-box anno-box-' + mark.type;
        box.setAttribute('data-index', String(index));
        box.style.left = (mark.x0 * 100) + '%';
        box.style.top = (mark.y0 * 100) + '%';
        box.style.width = ((mark.x1 - mark.x0) * 100) + '%';
        box.style.height = ((mark.y1 - mark.y0) * 100) + '%';

        var tag = document.createElement('span');
        tag.className = 'anno-box-tag';
        tag.textContent = t(TYPE_LABEL_KEY[mark.type] || mark.type);
        box.appendChild(tag);

        /*
          ⚠️⚠️ 这里**没有** click 监听 —— 删除不靠 click。

             原来是有的（`box.addEventListener('click', ...)` 直接 splice），
             但用户 2026-09-25 反馈「框无法删除」。原因：

             `.anno-layer` 上必须有 `touch-action: none`
             （否则手指拖拽被浏览器解释成滚动，画不出框），
             而它在真机上让整块**不再派发 click** ——
             鼠标调试正常、手机永远不触发，典型的"桌面能跑手机不能"。

             ✅ 删除改由 `bindLayerDrawing` 的 `endGesture` 用坐标做命中测试。
                见那里 `boxAt()` 与 `pend.hitBox` 的说明。

          ⚠️ 不要再把它加回来。加回来会变成"删除执行两次"
             （pointerup 一次 + click 一次）—— 真机上 click 不来所以看不出，
             鼠标调试时却会一次删掉两个框，很难查。
        */

        return box;
    }

    /** 重画某页的标注框（删/加之后调） */
    function refreshAnnotateLayer(page) {
        for (var i = 0; i < annotateLayers.length; i++) {
            var layer = annotateLayers[i];
            if (parseInt(layer.getAttribute('data-page'), 10) !== page) continue;

            // 只清框，保留浮层本身（不然事件绑定也一起没了）
            var boxes = layer.querySelectorAll('.anno-box');
            for (var k = 0; k < boxes.length; k++) {
                if (boxes[k].parentNode) {
                    boxes[k].parentNode.removeChild(boxes[k]);
                }
            }
            drawRegionsOn(layer, page);
            return;
        }
    }

    /**
     * 在浮层上绑定「拖拽画框」。
     *
     * ══ ⚠️ 用 Pointer Events，不用 mouse/touch 两套 ══
     *
     * `pointerdown/move/up` 在 WebView 里统一了鼠标与触摸，
     * 而且自带 `setPointerCapture` —— 手指滑出浮层边界时仍然收到
     * move 事件。用 mouse+touch 两套则要自己处理
     * 「touchmove 期间滚动页面」这类冲突，代码量翻倍且容易漏。
     *
     * ⚠️ 坐标换算：`clientX - rect.left`，再除 `rect.width` 得归一化值。
     *    用 getBoundingClientRect 而不是 offsetLeft 累加 ——
     *    后者在有 transform/缩放时要自己算，前者已经是最终值。
     */
    function bindLayerDrawing(layer, page) {
        /** 拖拽起点（归一化）。null = 当前没有正在拖的框 */
        var start = null;
        /** 拖拽中的虚线框 */
        var ghost = null;
        /**
         * 本次手势的起始屏幕坐标 + 是否已经确认是拖拽。
         *
         * ⚠️⚠️ 这是"点击 vs 拖拽"分流的关键。
         *
         *    之前的问题是：pointerdown 就立刻开始画框，
         *    于是**每一次轻点都会先画一个 0×0 的鬼框**，
         *    pointerup 再把它丢掉 —— 看起来是"点了没反应"，
         *    而且那一次点击还顺带把菜单切了，顶部/底部永远选不中。
         *
         *    现在改成**逆来顺受地看着**：按下时先不画，
         *    等位移超过 DRAG_SLOP 才认定为拖拽、才开始画。
         *    没超过就当作一次普通点击 —— 不画框，让 click 正常冒泡去切菜单。
         */
        var pending = null;
        var dragging = false;

        /*
          ══ ⚠️⚠️ 位移阈值：必须够宽，不能写死 8 个 CSS 像素 ══

             2026-09-25 用户实测：「我没有拖拽，点击了一下直接生成了一个框」。

             —— 写死的 8px 太小了。真机手指"点一下"的天然抖动
             轻易就有 10~15 个 CSS 像素（高 DPI 屏上更明显），
             于是每一次轻点都被判成拖拽，既画出莫名其妙的框，
             又吞掉了本该用来删除已有框的那一次点击。

          ⚠️ 用**物理尺寸**定阈值：3 毫米，再按 CSS 基准密度换算。
             96 CSS px = 1 英寸 = 25.4mm，所以 1mm ≈ 3.78 CSS px。

             · 比 Android 的 ViewConfiguration.getScaledTouchSlop()
               （8dp ≈ 1.4mm）宽一倍多 —— 那个是给"滚动"用的，
               我们要区分的是"点击"与"有意的拖拽"，该更宽松；
             · 又远小于"想画一个框"的必要位移（通常 > 5mm）。
        */
        var DRAG_SLOP_MM = 3;
        var DRAG_SLOP = DRAG_SLOP_MM * 96 / 25.4;   // ≈ 11.3 CSS px

        /**
         * 命中测试：屏幕上这个点下面有没有已有的框？
         *
         * ⚠️⚠️ 为什么**不能**靠框自己的 click 事件来删除。
         *
         *    用户 2026-09-25 反馈「框无法删除」。根因在 CSS：
         *
         *        .reader.is-annotating .anno-layer.is-drawing {
         *            touch-action: none;      ← 这个
         *        }
         *
         *    `touch-action: none` 是**必须**的（不给的话手指拖拽会被
         *    浏览器解释成滚动页面，pointermove 收不到几个点，框只画一小段）。
         *    但它在真机上会让这一整块**不再派发 click** ——
         *    浏览器认为这里是"拖拽区"，不会补发 click。
         *    于是 `.anno-box` 上那个 click 监听形同虚设：
         *    鼠标调试时一切正常（鼠标没有 touch-action 的概念），
         *    真机上永远不触发 —— 典型的"桌面能跑、手机不能"。
         *
         *    ✅ 所以删除改在 **pointerup** 里用坐标自己做命中测试，
         *       与"画新框"共用同一套 pointer 事件，不再依赖 click。
         */
        function boxAt(clientX, clientY) {
            /*
              ⚠️ 从后往前找 —— 后 append 的画在上层，
                 与视觉层级一致（重叠时点到的是用户看到的那个）。
            */
            var boxes = layer.querySelectorAll('.anno-box:not(.is-ghost)');
            for (var i = boxes.length - 1; i >= 0; i--) {
                var r = boxes[i].getBoundingClientRect();
                if (clientX >= r.left && clientX <= r.right &&
                    clientY >= r.top && clientY <= r.bottom) {
                    return boxes[i];
                }
            }
            return null;
        }

        function normalised(ev, rect) {
            var x = (ev.clientX - rect.left) / rect.width;
            var y = (ev.clientY - rect.top) / rect.height;
            return {
                x: Math.min(1, Math.max(0, x)),
                y: Math.min(1, Math.max(0, y))
            };
        }

        /** 用两个归一化点更新一个元素的位置（百分比定位） */
        function place(el, a, b) {
            var x0 = Math.min(a.x, b.x);
            var y0 = Math.min(a.y, b.y);
            var x1 = Math.max(a.x, b.x);
            var y1 = Math.max(a.y, b.y);
            el.style.left = (x0 * 100) + '%';
            el.style.top = (y0 * 100) + '%';
            el.style.width = ((x1 - x0) * 100) + '%';
            el.style.height = ((y1 - y0) * 100) + '%';
            return { x0: x0, y0: y0, x1: x1, y1: y1 };
        }

        layer.addEventListener('pointerdown', function (ev) {
            var rect = layer.getBoundingClientRect();
            if (!rect.width || !rect.height) return;

            /*
              ⚠️ 按在**已有的框**上时，记下"这一下可能是删除"，
                 但**不立刻删** —— 要等 pointerup 确认这是一次点击
                 （而不是用户想从这个框的位置起笔拖一个新框）。

              ⚠️⚠️ 这里**不能**像以前那样直接 `return`。

                 以前写的是「点在已有框上时交给框自己处理」，
                 但框自己**收不到事件**（touch-action: none 之下
                 整块不派发 click，见 boxAt 的说明）。
                 于是那个 return 等于把这一下彻底吞了 ——
                 既没删掉框，也没让框收到点击。这就是"框无法删除"。

                 所以判定必须**全部在 layer 里做**。
            */
            var hit = boxAt(ev.clientX, ev.clientY);

            pending = {
                pointerId: ev.pointerId,
                clientX: ev.clientX,
                clientY: ev.clientY,
                startNorm: normalised(ev, rect),
                hitBox: hit,
                /*
                  ══ ⚠️⚠️ 意图在**按下的一瞬间**就定下来 ══

                     用户 2026-09-25 第二次反馈「框依旧无法删除」。

                     上一版是按**位移**分流的：
                       · 位移没超阈值 → 点击（可能删除）
                       · 位移超了阈值 → 拖拽（画框）
                     起点在框上时还把阈值放宽到 2 倍。

                     还是在真机上不行。因为真机"点一下"产生的
                     pointermove 序列累积位移能轻松超过 2 倍阈值
                     （手指压在屏幕上本身就有微动，加上滚动惯性），
                     于是被判成"拖拽" → 走画框分支 →
                     框和新框完全重合，看上去就是"点了没反应"。

                     ❌ 错的根源：**用一把尺子（位移）去量两件不同的事**。

                     ✅ 正解：**按下的位置本身就已经表达了意图**：
                       · 按在已有框上 → 他想处理这个框（删除），
                         绝不是"在同一位置再画一个重合的框" ——
                         后者没有任何使用价值。
                       · 按在空白处 → 才可能是画新框。

                     所以 `onBox` 为 true 时，这一次手势**只走删除判定**，
                     位移多少都不画框。
                */
                onBox: !!hit
            };
            dragging = false;

            /*
              ══ ⚠️⚠️ 在这里阻止滚动，而不是靠 CSS 的 touch-action: none ══

                 用户 2026-09-25 实测「连拖拽都建不了框」——
                 pointer 事件根本没到达监听器（能到达的话日志里会有 anno:down）。

                 根因：Android WebView 给元素加 `touch-action: none` 后，
                 部分版本**连 pointer 事件一起不派发**了。
                 而桌面 Chromium 没这个行为 → 本地测全绿、真机全废。

                 ✅ 改成 CSS 用 `manipulation`（不禁滚动），
                    真正的"别滚动"在**我们自己的代码**里做 ——
                    不受 WebView 的 touch-action 实现差异影响。

                 ⚠️ 必须**无条件** preventDefault（不管 onBox 与否）：
                    · onBox —— 手指微动不该让页面滚走，否则松手时
                      位置已变，命中测试的框可能已经移出视野；
                    · 空白处 —— 不阻止的话手指拖拽会被当成滚动手势，
                      pointermove 收不到几个点，框只画出一小段。

                 ⚠️ 代价：编辑模式 + 画矩形模式下**页面不能滚动**了。
                    这是**设计如此**（见上方 CSS 注释里用户那句
                    「编辑模式哪个选项都没点，就不需要画框啊，
                      比如滚动页面啥的」—— 反过来，选了画矩形就该锁住滚动）。
                    要滚动就先取消选项。
            */
            if (ev.cancelable) {
                ev.preventDefault();
            }

            /*
              ⚠️ 诊断日志（排查"真机上完全没反应"用）。

                 用户 2026-09-25：「无法删除框，无法拖拽建立新框，
                                  基本这个功能没用」。
                 连拖拽都建不了框 —— 说明 pointer 事件**根本没进来**，
                 不是某个判据写错。所以先把"进来没有"这件事记下来。

                 日志里带上 pe/ta 的实际计算值 ——
                 这两项能直接区分"事件没来"和"来了但判据不对"。
            */
            trace('anno:down',
                  'hit=' + (hit ? 'box' : 'none') +
                  ' page=' + page +
                  ' pe=' + getComputedStyle(layer).pointerEvents +
                  ' ta=' + getComputedStyle(layer).touchAction);
        });

        layer.addEventListener('pointermove', function (ev) {
            if (!pending) return;

            /*
              ══ ⚠️⚠️ 按在已有框上 → 这一次手势**永不画框** ══

                 位移多少都不画。理由见 pointerdown 里的长注释：
                 用户按在框上就是想处理这个框，"再画一个重合的框"
                 没有使用价值；而真机上"点一下"的微动足以骗过位移阈值。

                 ⚠️ 直接从 pointermove 里退出，连鬼框都不建 ——
                    建了会闪一下虚线框，用户以为要画框了。
            */
            if (pending.onBox) return;

            /*
              还没确认成拖拽 —— 看位移够不够。
              不够就什么都不做，手指可能只是在按着没动。
            */
            if (!dragging) {
                var dx = Math.abs(ev.clientX - pending.clientX);
                var dy = Math.abs(ev.clientY - pending.clientY);

                /*
                  ⚠️ 用**欧氏距离**而不是 max(|dx|,|dy|)。

                     用 max 会把"两个方向各移 8px"（实际位移 11.3px）
                     判成没动 —— 斜向的轻抖因此漏判。
                     欧氏距离才是"手指移动了多远"的真实度量。
                */
                var moved = Math.sqrt(dx * dx + dy * dy);
                if (moved < DRAG_SLOP) return;

                trace('anno:drag', 'moved=' + Math.round(moved) + ' slop=' + Math.round(DRAG_SLOP));

                /*
                  确认是拖拽了 —— 现在才真正开始：
                    · 鬼框建起来
                    · 吃掉后续的 click（画完框不该顺带切菜单）
                */
                dragging = true;
                var ui0 = global.ScholariusUI;
                if (ui0 && typeof ui0.markDragged === 'function') ui0.markDragged();

                var rect0 = layer.getBoundingClientRect();
                if (!rect0.width || !rect0.height) return;

                start = pending.startNorm;
                ghost = document.createElement('div');
                ghost.className = 'anno-box anno-box-' + annotateMode + ' is-ghost';
                place(ghost, start, start);
                layer.appendChild(ghost);

                try {
                    layer.setPointerCapture(pending.pointerId);
                } catch (e) { /* 个别 WebView 不支持 Pointer Capture，忽略 */ }
            }

            if (!start || !ghost) return;
            var rect = layer.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            place(ghost, start, normalised(ev, rect));
        });

        /**
         * 结束手势。**画新框和删除已有框都在这里收口**。
         *
         * ⚠️ pointercancel 也走这里：真机上系统手势（下拉通知栏、来电）
         *    会中断 pointer 序列，此时必须把 pending 清干净，
         *    否则下一次按下会带着旧的 pending 状态。
         */
        function endGesture(ev, cancelled) {
            trace('anno:up', 'cancelled=' + !!cancelled + ' pending=' + !!pending +
                  ' dragging=' + dragging);
            if (!pending) return;

            var pend = pending;
            pending = null;

            /* 被系统打断 —— 什么都别做，把半成品鬼框收掉 */
            if (cancelled) {
                if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
                ghost = null;
                start = null;
                dragging = false;
                return;
            }

            /*
              ══ 情况一：按下的位置就在一个已有框上 ══

                 不管位移多少，这一次手势都只处理这个框 —— 删除它。
                 位移多少都不画框（理由见 pointerdown 的长注释）。

                 ⚠️ 这就是"点击删除"的实现。不再依赖 click 事件 ——
                    `touch-action: none` 之下真机不派发 click，
                    框自己那个监听形同虚设（桌面能跑、手机不能）。
            */
            if (pend.onBox) {
                dragging = false;
                trace('anno:delete-try', 'onBox=true hitBox=' + !!pend.hitBox);
                if (pend.hitBox) {
                    var idx = parseInt(pend.hitBox.getAttribute('data-index'), 10);
                    if (!isNaN(idx) && idx >= 0 && idx < regionMarks.length) {
                        /*
                          ⚠️ 复查一次：确认这个下标指向的确实是**这一页**的框。

                             防的是"DOM 上的 data-index 与 regionMarks 的下标
                             因多页/重绘而错位" —— 错位就会删掉别的页的框，
                             而这种 bug 很难复现（要恰好两页都有框）。
                             ⚠️ 代价是每次删一个框多两次属性读，可忽略。
                        */
                        if (regionMarks[idx].page === page) {
                            regionMarks.splice(idx, 1);
                            annotateDirty = true;
                            refreshAnnotateLayer(page);

                            /*
                              ⚠️ 删完也要"吃掉随后的 click"。

                                 框被删掉之后，`bodyEl` 的切菜单监听里那句
                                 `event.target.closest('.anno-box')` 就失效了 ——
                                 因为那个框已经不在 DOM 里，event.target 变成了
                                 底下的 .anno-layer。于是这一次点击会
                                 顺带把菜单切一下（用户看到"删个框菜单乱跳"）。

                                 复用 markDragged 这个标志：它本来就是
                                 "刚刚发生过一次版面操作，别把补发的 click
                                  当作用户想切菜单"。
                            */
                            if (global.ScholariusUI &&
                                typeof global.ScholariusUI.markDragged === 'function') {
                                global.ScholariusUI.markDragged();
                            }
                        }
                    }
                }
                return;
            }

            /*
              ══ 情况二：没在框上、而且没有拖动 ══

                 用户的意图是**普通点击** —— 在原始视图里那意味着"唤出/收起菜单"
                 （与 mountTapToToggle 的分工一致）。

                 用户 2026-09-25 明确要求：
                   「点击可用，但这是错误的逻辑，因为单纯点击应该是唤出菜单，
                     而不是形成一个框（且框的大小无法确定）」

                 ⚠️ 为什么这里要**主动 toggleMenu**，而不是让 click 冒泡去处理：
                    `touch-action: none` 之下真机**不派发 click**
                    （见 makeRegionBox 的说明），所以 bodyEl 的切菜单监听
                    在原始视图里收不到这一次点击 ——
                    不主动唤起的话，矩形模式下点空白处**毫无反应**。

                 ⚠️ 唤菜单前先 markDragged()：这一次 pointerup 之后
                    浏览器仍可能补发一个 click（桌面 / 部分机型），
                    不标记的话会**再切一次**，菜单闪一下又回去。
            */
            if (!dragging) {
                dragging = false;
                start = null;
                trace('anno:click-blank', 'toggle menu');
                if (global.ScholariusUI &&
                    typeof global.ScholariusUI.markDragged === 'function') {
                    global.ScholariusUI.markDragged();
                }
                toggleMenu();
                return;
            }

            dragging = false;
            if (!start) return;

            var rect = layer.getBoundingClientRect();
            var from = start;
            start = null;

            if (ghost && ghost.parentNode) {
                ghost.parentNode.removeChild(ghost);
            }
            ghost = null;

            if (!rect.width || !rect.height) return;

            var box = place(document.createElement('div'), from, normalised(ev, rect));

            /*
              ══ ⚠️⚠️ 误触判据：**至少一个方向要够长**，不是"两轴都够长" ══

              这里连续错了两版，都记下来别再走回头路：

              ① 第一版（原始）：`w < MIN || h < MIN` → 要求两轴**各自**达标。
                 错。竖直拖拽 w≈0 → 直接丢弃 → 框画不出来（用户实测）。

              ② 第二版：改成面积 `w * h < MIN*MIN`。
                 还是错。因为**纯竖直**拖拽 w **恰好是 0**，
                 面积恒为 0 → 同样被丢弃。

              ③ 现在：`max(w, h) < MIN` → 只要**有一个方向够长**就保留。
                 这才对得上"误触"的真实定义：
                   误触 = 手指点一下没移动 → w、h **都**小
                   竖直框 = w≈0 但 h 很大 → 保留 ✓
                   水平框 = h≈0 但 w 很大 → 保留 ✓

              ⚠️ 现在又加了一层保险：到了这里的手势已经过 DRAG_SLOP 筛选，
                 所以这个 MIN 主要是防"手拖了一点点又放下"。

              ⚠️ 后果：真正的一维细框（w=0）会被存下来，
                 而 `AnnotationStore.load()` 会把 `x1 <= x0` 当退化数据丢掉
                 → 用户重进页面框就消失了。所以下面还要给退化边
                 一个最小宽度（MIN_EDGE），让它在数据上合法。

              ══ ⚠️⚠️ MIN 从 0.012 提到 0.05（2026-09-25 真机实测）══

              用户原话：「无法拖拽形成框……点击可用，但这是错误的逻辑，
                        因为单纯点击应该是唤出菜单，而不是形成一个框
                        （且框的大小无法确定）」

              原因：0.012 是**归一化**值，在 412px 宽的页面上只相当于
                    0.012 × 412 ≈ **4.9 CSS px**。
                    而 DRAG_SLOP 是 11.3px —— 只要抖动超过 slop
                    （约 12px 位移）就能产生 4.9px 以上的框。
                    于是"点一下"经常被记成一个**极小的框**，
                    用户看到的就是"点击却生成了框，大小还莫名其妙"。

              改成 0.05 ≈ 20.6 CSS px：这是"至少拖出一小段"的合理下限。
                    真想画框时随手一拖都是几十像素；
                    "点一下 + 抖动"到不了这个尺寸。
          */
            var MIN = 0.05;
            var w = box.x1 - box.x0;
            var h = box.y1 - box.y0;
            if (Math.max(w, h) < MIN) {
                trace('anno:reject', 'too-small w=' + w.toFixed(4) + ' h=' + h.toFixed(4));
                return;
            }

            /*
              ⚠️⚠️ 给退化边一个**最小值**，否则存了也白存。

                 `AnnotationStore.load()` 会把 `x1 <= x0` 或 `y1 <= y0`
                 的框当作退化数据**直接丢弃**。而竖直拖拽的 `w`
                 就是 0 —— 那样用户现在看得见框，重进页面后框
                 **凭空消失**，比一开始就不给画还费解。

                 所以把两条边都撑到至少 MIN_EDGE（很细但非零）。
                 视觉上是一条极细的线，"框住一列公式"这种用法没问题。
            */
            var MIN_EDGE = 0.002;
            if (w < MIN_EDGE) {
                var cx = (box.x0 + box.x1) / 2;
                box.x0 = Math.max(0, cx - MIN_EDGE / 2);
                box.x1 = Math.min(1, cx + MIN_EDGE / 2);
            }
            if (h < MIN_EDGE) {
                var cy = (box.y0 + box.y1) / 2;
                box.y0 = Math.max(0, cy - MIN_EDGE / 2);
                box.y1 = Math.min(1, cy + MIN_EDGE / 2);
            }

            regionMarks.push({
                x0: box.x0,
                y0: box.y0,
                x1: box.x1,
                y1: box.y1,
                page: page,
                type: annotateMode
            });
            annotateDirty = true;
            trace('anno:added', 'page=' + page + ' type=' + annotateMode +
                  ' rect=' + box.x0.toFixed(3) + ',' + box.y0.toFixed(3) + ' ' +
                  box.x1.toFixed(3) + ',' + box.y1.toFixed(3) + ' total=' + regionMarks.length);
            refreshAnnotateLayer(page);
        }

        layer.addEventListener('pointerup', function (ev) {
            endGesture(ev, false);
        });

        /* 系统手势打断（下拉通知栏、来电等）—— 收干净，别留半成品 */
        layer.addEventListener('pointercancel', function (ev) {
            endGesture(ev, true);
        });

        layer.addEventListener('pointercancel', function () {
            start = null;
            if (ghost && ghost.parentNode) {
                ghost.parentNode.removeChild(ghost);
            }
            ghost = null;
        });
    }

    /**
     * 刷新视图切换按钮：图标、状态、无障碍标签。
     *
     * ══ 图标与标签都描述**动作**，不是"当前状态" ══
     *
     * ⚠️ 两者**必须同向**：图标说"往哪去"、标签也说"往哪去"。
     *    曾经把标签写成动作、图标写成当前状态 ——
     *    按钮在说两件事，谁看都会错。
     *
     * ⚠️ 那「当前在哪个视图」由谁表达？**只由图标本身**表达。
     *    aria-pressed 保留给读屏器（可访问性），
     *    但 CSS 里**不给它任何视觉**（用户要求"只转换图标本身"）。
     *
     * 图标含义（visibility 系列，用户选定）：
     *   阅读视图 → 显示 visibility     （把原始视图"显示出来"）
     *   原始视图 → 显示 visibility_off （原始视图已显示，点它收起来）
     */
    function syncViewToggle() {
        /*
          ⚠️ 视图状态类必须**无条件**先写 —— 它决定原始视图能不能拖拽
             （见下面 is-raw 的说明），不能因为"按钮还没建好"就跳过。
             `isRaw` 只看 `view`，与按钮无关。
        */
        if (root) {
            root.classList.toggle('is-raw', view === 'raw');
        }

        /*
          ⚠️ 切视图 / 关阅读页时必须把「建立区域」按钮和选中高亮一起收掉
             （2026-09-25）。

             理由：那个按钮浮在文字层之上，而切到阅读视图时文字层会被
             `teardownPdfScroll()` 整个删掉 —— 按钮却还在，指向一个
             已经不存在的选区。用户点它只会得到"没有行号数据"。
             收掉比留一个坏按钮好。
        */
        if (view !== 'raw') {
            clearTextSelection();
        } else {
            clearRawSelectionHighlight();
        }

        if (!viewToggleBtn) {
            return;
        }
        var isRaw = (view === 'raw');

        /*
          ⚠️ 两图标预置在按钮里，靠 hidden 切显示。
             不重建 innerHTML —— 那会让图标闪一下。
        */
        var iconRaw = viewToggleBtn.querySelector('[data-view-icon="raw"]');
        var iconReading = viewToggleBtn.querySelector('[data-view-icon="reading"]');
        if (iconRaw) iconRaw.hidden = isRaw;
        if (iconReading) iconReading.hidden = !isRaw;

        viewToggleBtn.setAttribute('aria-pressed', isRaw ? 'true' : 'false');
        viewToggleBtn.setAttribute(
            'aria-label',
            t(isRaw ? 'reader.readingView' : 'reader.rawView')
        );
        /*
          ⚠️ data-i18n-aria-label 必须**移除** ——
             它在语言切换时会把属性重刷成模板里的原始文案，
             把我们这里算出来的「即将切到哪个视图」覆盖掉。
             i18n 刷新由 refreshChrome() 主动调本函数负责。
        */
        viewToggleBtn.removeAttribute('data-i18n-aria-label');

        /*
          ══ ⚠️⚠️ 视图状态类（详见本函数开头）══

          真因：`touch-action` 取**整条祖先链的交集**，而链的最外层
          `body` 是 `manipulation`（全局设定，界面需要）。原始视图里
          `.reader-body` 又是 `overflow-y: auto`（真能滚），
          两者一结合 → 浏览器把拖拽判成"滚页面" → 发 `pointercancel`
          → pointer 链断掉 → 画框的监听器永远收不到 move。

          真机事件序列（tools/emu_rawview_probe.py）：
            pointerdown   (103,187)  IMG.pdf-page-img
            touchstart    (103,187)  IMG.pdf-page-img
            pointermove              IMG.pdf-page-img
            touchmove     (120,191)  IMG.pdf-page-img
            **pointercancel**        ← 第 2 次移动就发了
            touchend

          ✅ 修法：CSS 里 `.reader.is-raw ...` 把整条链的 touch-action
             收回给自己。类已在函数开头写好，这里不再重复。
        */
        /*
          ⚠️ 标注按钮**只在原始视图里出现**。
             它是 PDF 专属功能：文本视图里段落本来就是可选的，
             用不着画框（用户原话：「文本本身就可以选中」）。

          ⚠️ 切回阅读视图时要**同时退出编辑模式** ——
             否则 annotating 留着 true，下次进 PDF 视图会
             直接是编辑态，而用户以为自己只是切了个视图。
        */
        if (annotateBtn) {
            annotateBtn.hidden = !isRaw;
        }
        if (!isRaw && annotating) {
            setAnnotating(false);
        }
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
          ⚠️ 每次打开都回到**阅读视图**（重置视图状态）。

             原始视图现在是网页里的一块内容（原生渲染的页图），
             所以“网页侧状态”与“用户看到的画面”现在是同一件事了 ——
             但上一位用户可能停在原始视图上，打开新文献时必须重置到阅读视图。
        */
        view = 'reading';
        rawPageCount = 0;
        lastBlocks = null;
        lastText = '';
        teardownPdfScroll();
        syncViewToggle();

        /*
          ⚠️ 标注也必须重置并重新拉。
             不同文献的标注完全不同，留着上一篇的就是错的。

          ⚠️ 先把上一份**未保存**的改动写掉再清 —— 否则
             上篇的改动就跟着 regionMarks = [] 一起没了。
        */
        saveAnnotations();
        annotating = false;
        annotateDirty = false;
        syncAnnotate();
        /*
          ══ ⚠️⚠️ 编辑态类必须**成套**清掉，不能只删 is-annotating ══

          用户实测（2026-09-25，tools/emu_watch.py 旁观记录）：

              「我进了模拟器这个框也消不掉啊」

          记录里打开的论文，reader 类是：
              reader is-text-mode is-open
                        ^^^^^^^^^^^^ 不该存在（当时并没有在编辑模式）

          真因就在这里：原来只写了
              root.classList.remove('is-annotating')
          而编辑态其实有**三个配套的类**：
              is-annotating   —— 在编辑模式
              is-text-mode    —— 编辑模式 + 选了「文本」选项
              is-drawing      —— 编辑模式 + 选了画框选项之一

          只删第一个 → 后两个残留 → 下一篇文献打开时：
            · `reader is-text-mode is-open`
            · CSS 里 `.reader.is-annotating.is-text-mode .anno-block`
              虽然要求同时有 is-annotating（所以块样式没被带偏），
              但**任何"看到 is-text-mode 就以为是文本模式"的判断都会错**，
              而这正是后面一连串怪状态的温床。

          ✅ 修法：交给 syncModeClass() —— 它是**唯一**负责写这两个类的
             地方（判据 `annotating && annotateMode === 'text'` /
             `annotating && isDrawingMode()`），这里 annotating 已是
             false，所以两个类都会被 toggle 掉。
             ⚠️ 不要在这里手写 remove —— 漏一个就又回到今天这个 bug。
        */
        if (root) root.classList.remove('is-annotating');
        syncModeClass();
        regionMarks = [];
        textMarks = [];
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
          ⚠️ 关闭阅读页时**必须**把未保存的标注写掉。
             退出编辑模式时已经写了一次，但用户可能**在编辑模式下
             直接按返回键**关掉阅读页 —— 那时 setAnnotating(false)
             从未被调用，不写就全丢了。
        */
        saveAnnotations();

        global.setTimeout(function () {
            if (!root.classList.contains('is-open')) {
                root.hidden = true;
                currentDoc = null;
                toc = [];
                textLines = [];
                if (contentEl) {
                    contentEl.textContent = '';
                }
                view = 'reading';
                rawPageCount = 0;
                lastBlocks = null;
                lastText = '';
                annotating = false;
                annotateDirty = false;
                /*
                  ⚠️ 关闭阅读器时也要把**三个**编辑态类清干净 ——
                     只清 annotating 不行（见 open() 里同一处的说明）。
                     这里连 is-annotating 都得补上：原先一行都没写，
                     于是完全靠 open() 兜底，而 open() 也漏了两个。
                */
                if (root) {
                    root.classList.remove('is-annotating');
                }
                syncModeClass();
                regionMarks = [];
                textMarks = [];
                teardownPdfScroll();
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
     * 把结构化块渲染成 DOM。
     *
     * ══ ⚠️ 从这里开始是「文本分级」（v0.1.17）══
     *
     * 用户的要求（原话）：
     *   「文本分级，先分作者、标题、摘要和各个一级大纲标题所表示的区域，
     *     然后每个一级章节区域可以再分」
     *   「分到哪一层由用户决定（可手动折叠/展开）」
     *
     * 于是渲染分两步：
     *   ① [buildRegions] 把平坦的 blocks 切成**有层级的区域树**；
     *   ② [renderRegions] 把它渲染成可折叠的 DOM。
     *
     * ⚠️ 为什么必须两步而不是边遍历边渲染：
     *    折叠/展开要能作用于"整棵子树"，
     *    而 DOM 一旦生成就成了树，再想按层级折叠就得反查父节点。
     *    先在纯数据上把层级算清，渲染只是照着画。
     *
     * ══ 为什么要分块（v0.1.6）══
     *
     * 纯文本流无法表达「这是标题 / 这是段落 / 这是公式」，
     * 所以整篇看起来是一团字。分块之后每类元素有自己的
     * 标签与样式，层次才立得起来。
     *
     * ⚠️ 一律用 `document.createElement` + `textContent`，
     *    **绝不**用 innerHTML 拼字符串。
     *    正文来自 PDF，可能含 `<` `>` `&` —— 拼字符串会破坏
     *    页面结构（甚至注入）。这是本项目一贯的硬约束。
     *
     * ⚠️ 段落内的换行用 CSS `white-space: pre-wrap` 处理，
     *    不在这里手工插 <br>。理由：pre-wrap 能正确保留
     *    连续空格与制表符（公式对齐要用），手工插 <br> 会丢。
     *
     * ⚠️ `page` 记在 `data-page` 上：将来做「跳到原页」要用，
     *    现在只存不用（不加可见 UI，避免引入没做完的功能）。
     *
     * @param {Array} blocks [{kind,text,level,page}]
     */
    function renderBlocks(blocks) {
        var regions = buildRegions(blocks, textMarks);
        if (!regions.length) {
            // 没有任何可分区的内容：退回平坦渲染（保持旧行为，别白屏）
            renderFlat(blocks);
            return;
        }
        renderRegions(regions);
    }

    /**
     * 把平坦的块序列切成**区域树**。
     *
     * ══ 区域类型（用户选定）══
     *
     * 首页区（各成一块）：
     *     标题 / 作者 / 摘要 / 关键词
     * 正文区：
     *     一级章节开头 → 开一个 level 1 区域
     *     其下遇到 level 2 标题 → 嵌一个 level 2 区域
     *     再下 level 3 → 继续嵌
     *
     * ══ ⚠️ 用户标注优先，自动识别兜底 ══
     *
     * `marks` 是用户在文本视图里**选中文字后指定的类型**
     * （注意：文本不用矩形框 —— 段落不是矩形，方框会框进
     *  旁边的栏和页眉。见 reader.js 顶部 state 区的说明）。
     * 一个块若落在某个 mark 的行区间内，就用 mark 的类型 ——
     * 这覆盖自动判断的结果。没被标过的块仍按 [guessKind] 猜。
     *
     * ⚠️ 行号是**全局行号**（mark.from / mark.to），而 blocks 是
     *    **块序列**，两者单位不同。这里用「累计块长度」估算每个块的
     *    起始行 —— 这是近似：真实对应关系需要原生给块↔行的映射。
     *    ⚠️ 近似必然有偏移，所以这一步**宁可少覆盖**：
     *      只有当 mark 区间**完整包含**该块的估算范围时才生效，
     *      部分重叠就忽略（避免把相邻块一起误标）。
     *
     * @param  {Array} blocks [{kind,text,level,page}]
     * @param  {Array} marks  [{from,to,type,level}]
     * @return {Array} 区域树 [{type, level, heading, blocks, children}]
     */
    function buildRegions(blocks, marks) {
        var out = [];
        if (!blocks || !blocks.length) return out;

        // 估算每个块的全局行号区间（供 mark 匹配）
        var rowAt = [];
        var row = 0;
        for (var i = 0; i < blocks.length; i++) {
            var b0 = blocks[i];
            if (!b0 || !b0.text) { rowAt.push(null); continue; }
            /*
              ⚠️ 行数按 `\n` 个数 + 1 估。
                 段落块内部的行数就是换行符个数 + 1，
                 与原生 mergeParagraphs 的产物一致（段落用 \n 连接）。
            */
            var n = b0.text.split('\n').length;
            rowAt.push({ from: row, to: row + n - 1 });
            /*
              ⚠️ 把估算出来的**起始行号写回块本身**。
                 编辑模式（原始视图）要用它把"点中的文字块"
                 映射成 TextMark 的 from/to —— 那里拿不到
                 buildRegions 的局部变量，只能靠这个字段。
            */
            b0.line = row;
            row += n;
        }

        /** 查某个块被用户标成了什么；没标过返回 null */
        function markFor(idx) {
            var span = rowAt[idx];
            if (!span) return null;
            for (var k = 0; k < marks.length; k++) {
                var m = marks[k];
                if (!m || m.from > span.from || m.to < span.to) continue;
                // 完整覆盖才认（见函数头的「宁可少覆盖」）
                /*
                  ⚠️ 调试用：打一条日志说明"这个 mark 命中了哪个块"。
                     排查"改了标注但阅读视图不变"时，这是最快的定位点 ——
                     要么这里没命中（行号对不上），要么命中了但渲染没用它。
                */
                trace('reader:mark-hit', 'mark ' + m.type + ':' + m.from + '-' + m.to +
                      ' -> block#' + idx + ' span ' + span.from + '-' + span.to);
                return m;
            }
            return null;
        }

        /*
          ⚠️ 首页区只在**文章开头**认。
             正文中间也可能出现 "Abstract" 字样（引用别人的摘要），
             那时已经进入章节区了，不该再开一个"摘要区"。
             用一个开关：一旦开出第一个章节区就不再回头。
        */
        var sawBody = false;
        var stack = []; // 当前打开的章节区域栈（level 递增）
        /*
          ⚠️ 用来认「标题区」和「作者区」：
             题目 = 首页的第一个块（无论它被判成什么）；
             作者 = 紧随题目之后的那一段。见下面两处的说明。
        */
        var sawTitle = false;
        var authorPending = false;
        /** 调试计数：标注命中/未命中的块数（见下方 markHit++） */
        var markHit = 0;
        var markMiss = 0;
        /*
          ⚠️ 当前"敞开着的"首页区（title/author/abstract/keyword）。
             摘要标题之后的正文要靠它归位 —— 见下面用到处的说明。
             null = 首页已结束或还没开始。
        */
        var frontOpen = null;

        for (var j = 0; j < blocks.length; j++) {
            var blk = blocks[j];
            if (!blk || !blk.text) continue;

            var mark = markFor(j);
            var type = mark ? mark.type : guessKind(blk, sawBody);
            /*
              ⚠️ 调试：统计"有标注但没生效"的块数。
                 用户报「阅读视图没按标注重排」时，
                 若这里命中数为 0 而 textMarks 非空 → 行号对不上（本函数的问题）；
                 若命中数 > 0 但视图没变 → 渲染侧没用 textType（makeBlockEl 的问题）。
            */
            if (mark) markHit++; else if (marks.length) markMiss++;
            /*
              ⚠️ 层级：**用户标的优先且不合并原生猜测**。

                 用户显式选了「章节标题 L2」就是 L2 —— 不能再 `|| blk.level`
                 退到原生。原生的 level 实测要么 0（判不出）要么猜错，
                 一旦被借来用，用户标 L2 却渲染成 L1（或反之），
                 而他**无法从界面上看出被改了**。

                 未标过的块才用原生 level（那是自动识别的初值，
                 用户没表态，只能信它）。
            */
            var level = mark
                ? (mark.type === 'heading' ? (mark.level > 0 ? mark.level : 1) : 0)
                : blk.level;

            /*
              ══ ⚠️⚠️ 把最终类型写回块上，供渲染读取 ══

              用户 2026-09-25 反馈：「阅读视图并没有按照更改后的框重新排版。」

              真因：渲染侧 `makeRegionEl` 调的是
                  `makeBlockEl(b, b.textType)`
              而 **`b.textType` 全项目没有任何地方赋值** ——
              它永远是 `undefined`，于是 `makeBlockEl` 只按 `b.kind`
              （**原生判定**）决定标签与样式。用户改的标注对阅读视图
              毫无影响，改完切回去看还是原样。

              ✅ 这里补上赋值。放在**算完 type / level 之后**，
                 保证写进去的是"用户标注优先"的最终结果。

              ⚠️ 同时写 level：`makeBlockEl` 用 `b.level` 决定 h2/h3/h4，
                只用 `b.kind` 会拿原生的 level，用户标的层级就丢了。
            */
            blk.textType = type;
            if (type === 'heading') blk.level = level;

            /*
              ⚠️ 标题区是**位置**判据：文章的**第一个块**就是题目。

                 判据从"内容像不像标题"改成位置，是因为：
                   · 原生的 heading 判据（字号大）在封面页可能失灵
                     （整页字号都大）；
                   · 反过来，题目有时被判成 paragraph
                     （字号与正文相同、只是加粗居中）。
                 而"第一个块"这个位置在所有论文里都成立。
            */
            /*
              ══ ⚠️⚠️ 位置判据只在**用户没标注**时才生效 ══

              用户 2026-09-25：「阅读视图并没有按照更改后的框重新排版。」

              真因：下面这两处"位置判据"会**覆盖用户标注**：
                 `if (!sawBody && !sawTitle && …) type = 'title';`
                 `if (!sawBody && authorPending && type === 'body') type = 'author';`
              实测：用户把 `line=48` 那一段标成「章节标题」，
                   但那一段在首页（题目之后、摘要之前）→ 被判据强制改成
                   `author` → 归入作者首页区 → 走 `makeRegionHeader`
                   渲染成作者标签，**完全不读 region.blocks**，
                   于是 `makeBlockEl(b, b.textType)` 那条路根本不执行，
                   用户的标注被彻底忽略（日志可见：render-block 只打了 line=0）。

              ✅ 修法：**用户标注（mark）优先，位置判据只做兜底**。
                 这与本函数开头写的原则一致（"用户标注优先，自动识别兜底"），
                 只是下面这两处当初漏了加 `!mark` 守卫。

              ⚠️ 判据用 `mark`（而不是 `type !== 'heading'`）——
                 用户标的可能是 abstract / keyword 等任何类型，
                 只要他表过态，就不该被位置判据改写。
            */
            if (!mark && !sawBody && !sawTitle &&
                type !== 'abstract' && type !== 'keyword') {
                type = 'title';
            }

            /*
              ⚠️ 作者区同样是**位置**判据，不是内容判据。

                 论文首页的排布是固定套路：
                     题目 → 作者 → 单位/邮箱 → 摘要
                 题目后面紧跟的是作者，**再后面**是单位/邮箱。

                 ⚠️ 为什么不按"像人名"来认：
                    人名判据（2-5 个首字母大写的词）会把单位、邮箱、
                    会议名全部误判。位置判据在本场景下可靠得多 ——
                    题目已经被认出来了，紧跟其后的就是作者。

                 ⚠️ 单位/邮箱也要**并进作者区**，不能只认一段。
                    只认一段的话，第二段（"Microsoft Research"）
                    会掉进正文，变成一个没有标题的"本节"区域 ——
                    实测就是这个症状。所以作者窗口开在
                    **摘要/关键词之前**整段，靠"遇到 abstract/keyword
                    就关窗"来收口。
            */
            if (!mark && !sawBody && authorPending && type === 'body') {
                type = 'author';
            }

            /*
              ══ 首页区：标题 / 作者 / 摘要 / 关键词 ══
            */
            if (!sawBody && (type === 'title' || type === 'author' ||
                             type === 'abstract' || type === 'keyword')) {
                pushFrontRegion(out, type, blk);
                /*
                  ⚠️ 记住"当前停在哪个首页区"。
                     摘要标题之后紧跟的就是摘要正文 —— 它会被
                     guessKind 判成 body，若没有这个记录就会掉进
                     章节流程，凭空多出一个"本节"区域。
                     实测就是这个症状：摘要区是空的，
                     摘要正文变成了一个叫"本节"的章节。
                */
                frontOpen = type;
                if (type === 'title') {
                    sawTitle = true;
                    authorPending = true;
                } else if (type === 'author') {
                    /*
                      ⚠️ 作者区之后是单位/邮箱，仍属作者区；
                         但再之后可能是正文（没有摘要的论文）。
                         所以这里不关窗口，靠"遇到摘要/关键词/标题"收口。
                    */
                } else if (type === 'abstract' ||
                           type === 'keyword') {
                    authorPending = false;
                }
                continue;
            }

            /*
              ⚠️ 首页区还没结束时的**正文块**（摘要正文、关键词列表）
                 要并进刚开的那个首页区，不能去开章节。
            */
            if (!sawBody && frontOpen && type === 'body') {
                pushFrontRegion(out, frontOpen, blk);
                continue;
            }

            /*
              ⚠️ 一旦出现章节标题，首页就结束了 —— 关掉首页窗口，
                 后面所有内容都走章节流程。
            */
            if (type === 'heading') {
                frontOpen = null;
                authorPending = false;
            }

            /*
              ══ 章节区 ══

              ══ ⚠️⚠️ `blk.kind === 'heading'` 这个后门必须被用户标注盖住 ══

              用户原话（2026-09-25）：
                「我在编辑模式里面清空了所有区域，怎么阅读试图还没有变化？」

              真机实测（tools/emu_clear_why.py）抓到的矛盾：
                每个块的字段：
                  line=0  kind=heading    textType=body   ← textType 已是 body
                  line=1  kind=heading    textType=body
                  line=3  kind=heading    textType=body
                但阅读视图仍然渲染成 H2 21.25px × 4。

              根因就是下面这个 `|| blk.kind === 'heading'`：
                清空后 `type` 正确变成了 `'body'`（用户标注没了），
                **但 `blk.kind` 仍是原生判的 `'heading'`** ——
                这个 `||` 让块照样进 openRegion，变成**区域头**。
                而区域头由 makeRegionHeader 渲染，**永远输出
                `<h2>/<h3>/<h4>`，根本不读 textType** ——
                所以清空对画面毫无影响。

              ⚠️ 同一个后门还导致另一个更常见的毛病：
                 用户在编辑模式里把某个原生判成标题的块改成「正文」，
                 阅读视图**不会**降级 —— 因为 `blk.kind` 还是 heading。
                 「改了标注没反应」的一半症状都出自这里。

              ✅ 判据：`blk.kind === 'heading'` **只在用户没表态时**算数。
                 用户明确标了 body（清空留下的覆盖、或手标的"这段是正文"）
                 → 必须尊重他，落成 <p>。

              ⚠️ 为什么不能简单删掉 `blk.kind === 'heading'`：
                 没有它，那些"原生判成标题、但位置启发式没认出来"的块
                 会掉进下一段（`appendToStack` 当正文）——
                 实测那会让原本正常的标题全部降级成段落。
                 所以是**加守卫**，不是删除。
            */
            if (type === 'heading' ||
                (!mark && blk.kind === 'heading')) {
                var lv = (level > 0) ? level : 1;
                sawBody = true;
                stack = openRegion(out, stack, lv, blk);
                continue;
            }

            /*
              ⚠️ 正文的第一块若还没开章节区（有的 PDF 直接从正文开始，
                 没有一级标题），补一个"无标题的一级区"，
                 否则这些内容会挂在顶层、无法折叠。
            */
            if (!sawBody) {
                sawBody = true;
                stack = openRegion(out, stack, 1, null);
            }

            appendToStack(stack, out, blk, type);
        }

        /*
          ⚠️ 调试总结（见上面 markHit++ 处的说明）。
             排查「改了标注但阅读视图不变」时一眼定位：
                hit=0 且 marks 非空 → 行号对不上（本函数的 markFor 匹配问题）
                hit>0               → 行号没问题，查渲染侧
        */
        if (marks.length) {
            trace('reader:marks', 'marks=' + marks.length + ' hit=' + markHit +
                  ' miss=' + markMiss + ' blocks=' + blocks.length);
        }

        return out;
    }

    /** 把一个首页块并进 out 里对应的前区（没有就新建） */
    function pushFrontRegion(out, type, blk) {
        for (var i = 0; i < out.length; i++) {
            if (out[i].type === type && out[i].level === 0) {
                out[i].blocks.push(blk);
                return;
            }
        }
        out.push({ type: type, level: 0, heading: null, blocks: [blk], children: [] });
    }

    /**
     * 开一个新的章节区并正确嵌套。
     *
     * ⚠️ 嵌套规则：level 比栈顶**大**就嵌进去；**小于等于**就先把
     *    栈顶及更深的一路弹出，直到找到比自己浅的那一层。
     *    这是解析标题层级的标准做法（与建目录树同理）。
     */
    function openRegion(out, stack, lv, headingBlock) {
        // 弹出所有 >= 本层级的（它们已经结束了）
        while (stack.length && stack[stack.length - 1].level >= lv) {
            stack.pop();
        }

        var region = {
            type: 'section',
            level: lv,
            heading: headingBlock,
            blocks: [],
            children: []
        };

        if (stack.length) {
            stack[stack.length - 1].children.push(region);
        } else {
            out.push(region);
        }

        stack.push(region);
        return stack;
    }

    /** 把内容块追加到当前最深的那一层区域里 */
    function appendToStack(stack, out, blk, type) {
        var target = stack.length
            ? stack[stack.length - 1]
            : (out[out.length - 1] || null);
        if (!target) return;

        /*
          ⚠️ 把这个块被判定的文本类型带上（textType），
             渲染时给不同样式 —— 脚注/参考文献不该混在正文段落里。
        */
        target.blocks.push({
            kind: blk.kind,
            text: blk.text,
            page: blk.page,
            /*
              ⚠️⚠️ 必须带上 **level**（2026-09-25 补）。
                 原来只带 kind —— 于是 `makeBlockEl` 里
                 `var lv = (b.level >= 3) ? 4 : (...)`
                 读到 undefined → 恒为 h2，用户标的 L2/L3 全部丢失。
                 在 `makeBlockEl` 从 `textType` 推导 kind 之后，
                 level 也必须一起传，否则层级依然错。
            */
            level: blk.level,
            textType: type
        });
    }

    /**
     * 猜一个块属于哪个文本类型（用户没标过时用）。
     *
     * ⚠️ 这里**故意只认首页那几类**，不去猜"脚注 / 参考文献"这类
     *    需要语义理解的东西 —— 猜错比不猜更糟
     *    （用户看到摘要被标成"参考文献"会完全不信任这个功能）。
     *    猜不出的统一当正文。
     *
     * ══ ⚠️ 为什么摘要/关键词的检查要**先于** kind==='heading' ══
     *
     * 原生侧把 `Abstract` 判成 heading 是**对的** ——
     * 它确实是标题（字号大、全大写、独立成行），
     * 而且标题层级也是对的（它确实是一级）。
     *
     * 但在**区域划分**这个语境下，"Abstract 这一行"属于
     * **首页的摘要区**，而不是一个正文章节。两者的区别是
     * "它在文章结构里的位置"，不是"它长得像不像标题"。
     *
     * 实测症状：先判 heading 的话，摘要会变成一个
     * 与 "1 Introduction" 平级的章节区，用户看到的是
     * 一个"Abstract"章节 + 一段内容，而不是一个"摘要区"。
     */
    function guessKind(blk, sawBody) {
        if (!sawBody) {
            var txt = blk.text.trim();
            /*
              ⚠️ 摘要 / 关键词的提示词。中英文都列 ——
                 两种写法在真实论文里都常见。

              ⚠️ 用 `^`（行首）而不是 `contains` ——
                 正文里引用别人的摘要也会出现 "abstract"，
                 但不会在行首。行首匹配大幅降低误判。

              ⚠️⚠️ **不能用 `\b` 收尾**。这条踩过坑：
                   · `\b` 在中文后面**不成立**（中文字符在 JS 里
                     算 word character），所以 `^(摘要)\b` 永远匹配不上
                     `摘要：本文…`；
                   · `Keywords` 后面是 `:`，而 `\b` 在 `s` 与 `:` 之间
                     确实成立 —— 但 `^(keywords?)\b` 对
                     `Keywords`（整行就这一个词，行尾即字符串尾）
                     在 `s` 后面没有字符，`\b` 仍然成立，
                     所以那条其实是对的；
                     真正坏掉的是中文那条。

                 改成**显式列举可接受的分隔符**：空白、行尾、
                 中英文冒号、各种破折号。这样中英文都覆盖，
                 且不会把 "Abstracting away..." 这类词误判
                 （它后面是字母，不在分隔符集合里）。
            */
            if (/^(abstract|摘要)(\s|$|[:：—–-])/i.test(txt)) return 'abstract';
            if (/^(keywords?|index terms|关键词)(\s|$|[:：—–-])/i.test(txt)) return 'keyword';
        }

        if (blk.kind === 'heading') return 'heading';
        return 'body';
    }

    /** 平坦渲染（无区域时兜底，行为与 v0.1.16 一致） */
    function renderFlat(blocks) {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < blocks.length; i++) {
            /*
              ⚠️ 传 `blocks[i].textType` 而不是 null ——
                 兜底路径也要反映用户标注（见 buildRegions 里写回 textType 的说明）。
            */
            var el = makeBlockEl(blocks[i], blocks[i].textType);
            if (el) frag.appendChild(el);
        }
        contentEl.appendChild(frag);
    }

    /**
     * 造一个块的 DOM 元素。
     *
     * ⚠️ 这是**唯一**决定"某种块长什么样"的地方 ——
     *    平原渲染与区域渲染都调它，避免两套样式各自演化。
     *
     * @param {Object} b        块 [{kind,text,level,page,textType}]
     * @param {string|null} ttype 文本类型（用户标注或猜出来的）
     * @return {Element|null}
     */
    function makeBlockEl(b, ttype) {
        if (!b || !b.text) return null;

        /*
          ══ ⚠️⚠️ `kind` 的判据：**用户标注（ttype）优先于原生判定（b.kind）** ══

          用户 2026-09-25：「阅读视图并没有按照更改后的框重新排版。」

          原来这里只读 `b.kind` —— 那是**原生自动识别**的结果，
          不含用户标注。于是用户把一段正文标成「章节标题」之后，
          阅读视图里它**仍然是 <p>**，看起来标注毫无作用。

          ⚠️ 映射关系：
             ttype === 'heading'      → 当标题渲染（h2/h3/h4）
             ttype === 'formula'      → 当公式渲染（等宽 + 底纹）
             其它 / 未标注            → 沿用原生 kind
             ⚠️ 逆向不需要：用户把原生的标题标成「正文」时，
                `ttype === 'body'` 会让它落到 else 分支 → <p> ——
                正是期望的行为（用户有权把误判的标题降为正文）。
        */
        var kind;
        if (ttype === 'heading') {
            kind = 'heading';
        } else if (ttype === 'formula') {
            kind = 'formula';
        } else if (ttype) {
            /*
              ⚠️ 用户明确标了某个**非标题/非公式**的类型
                 （body / abstract / author / title / keyword / …）→
                 不再当作 heading。
                 理由：用户去编辑模式里改它，就是要推翻原生判断；
                 这里若还沿用 `b.kind === 'heading'`，改了就白改。
                 ⚠️ 但 formula 由原生判成 formula 时仍要保留等宽样式 ——
                    所以只在"用户标了东西"时覆盖，不标时才信原生。
            */
            kind = 'paragraph';
        } else {
            kind = b.kind || 'paragraph';
        }
        var el;

        if (kind === 'heading') {
            /*
              ⚠️ 标题层级映射到 h2 / h3 / h4，**不用 h1** ——
                 页面本身已有 h1 语义（应用标题），
                 正文里再出 h1 会破坏文档大纲。

             层级来源（原生侧 PdfText.classifyBlock）：
                1 = 章（`3` / `Abstract`，字号最大）
                2 = 节（`3.1`，字号次之或粗体）
                3 = 更深层（`3.1.1`），原生侧封顶到 3

             ⚠️ 三档全部保留 —— 早先这里把 level>=2 一律压到 h3，
                于是「章」与「节」在视觉上分不出来，
                而 CSS 里本来就为三档各写了字号（见 styles.css）。
                 映射：level 1 → h2，2 → h3，>=3 → h4
            */
            var lv = (b.level >= 3) ? 4 : ((b.level === 2) ? 3 : 2);
            el = document.createElement('h' + lv);
            el.className = 'reader-heading';

        } else if (kind === 'formula') {
            /*
              ⚠️ 公式块用等宽字体 + 独立背景。
                 虽然不是真正的 LaTeX（那需要数学 OCR），
                 但「单独成块 + 等宽」已经能让用户把它
                 与正文区分开，不再混在一句话里。
            */
            el = document.createElement('div');
            el.className = 'reader-formula';

        } else if (kind === 'figure') {
            /*
              ⚠️ 目前**不会**产出 figure（抽取 PDF 图片是独立一项）。
                 但这里先把渲染路径写好 —— 原生侧将来只要开始
                 产出 figure，前端立刻就能正确显示，不用再改这里。
            */
            el = document.createElement('div');
            el.className = 'reader-figure';

        } else {
            el = document.createElement('p');
            el.className = 'reader-para';
        }

        /*
          ⚠️ 文本类型还要表达在 class 上（脚注/参考文献/关键词等），
             这样各类可以有不同样式。CSS 里对应 .reader-text-<type>。
             正文（body）不加 class —— 那是绝大多数，加了只是噪声。
        */
        if (ttype && ttype !== 'body' && ttype !== 'heading') {
            el.className += ' reader-text-' + ttype;
        }

        el.textContent = b.text;
        if (b.page) el.setAttribute('data-page', String(b.page));
        return el;
    }

    /**
     * 把区域树渲染成可折叠的 DOM。
     *
     * ══ 折叠 / 展开（用户要求「分到哪一层由用户决定」）══
     *
     * 每个章节区渲染成一个 `<section class="rd-region">`，
     * 里面：
     *   · 一个可点的头部（章节标题 + 展开箭头）
     *   · 一个内容容器（下面直接的内容块 + 更深层的子区域）
     *
     * ⚠️ 折叠状态**不持久化**。理由：用户折叠多半是为了
     *    "跳过这段看看后面"，不是长期偏好；存起来反而
     *    会出现"我明明展开过怎么又是收着的"。
     *    默认全展开 —— 用户的要求是"能手动折叠/展开"，
     *    没说默认收起。
     *
     * ⚠️ 折叠只改 `hidden`，**不重建 DOM** ——
     *    重建会让滚动位置跳到顶部，用户折叠一个远处的章节
     *    结果视线被拽走，很烦。
     */
    function renderRegions(regions) {
        var frag = document.createDocumentFragment();
        trace('reader:regions', 'count=' + regions.length);
        for (var i = 0; i < regions.length; i++) {
            /*
              ⚠️ 每建一个区域都记一条 —— 排查"某个区域凭空消失"时，
                 这能立刻看出是"没建出 region"还是"建了但渲染抛异常"。
            */
            try {
                var el = makeRegionEl(regions[i]);
                trace('reader:region-el', '#' + i + ' type=' + regions[i].type +
                      ' lv=' + regions[i].level +
                      ' head=' + (regions[i].heading ? String(regions[i].heading.text).slice(0, 24) : 'null') +
                      ' blocks=' + regions[i].blocks.length +
                      ' el=' + (el ? el.tagName : 'null'));
                if (el) frag.appendChild(el);
            } catch (e) {
                trace('reader:region-err', '#' + i + ' ' + (e && e.message));
            }
        }
        contentEl.appendChild(frag);
    }

    /** 首页区的区域小标签文案（与 TEXT_TYPES 的前四类对应） */
    var FRONT_LABEL_KEY = {
        title: 'reader.typeTitle',
        author: 'reader.typeAuthor',
        abstract: 'reader.typeAbstract',
        keyword: 'reader.typeKeyword'
    };

    /** 造一个区域（首页区或章节区）的 DOM */
    function makeRegionEl(region) {
        var sec = document.createElement('section');
        sec.className = 'rd-region rd-region-' + (region.type || 'section');
        if (region.level) {
            sec.className += ' rd-region-lv' + Math.min(region.level, 3);
        }

        /*
          ⚠️ 首页区（标题/作者/摘要/关键词）**没有可折叠的头部** ——
             它们本身就是一小段内容，折叠没意义，
             多一个可点的标题反而让人以为漏了内容。

          ⚠️ 但**要有一个小标签**说明"这段是摘要" ——
             否则用户看到一段独立成块的文字，不知道它是被识别出来的
             区域还是排版巧合。标签是纯视觉的，不接手势。

          ⚠️ 标签用 .rd-region-titletext，
             与论文题目（.rd-region-title 容器）区分开，见我 CSS 里的说明。
        */
        if (region.type === 'section') {
            /*
              ⚠️ makeRegionHeader 可能返回 null（无真标题的兜底区，
                 见它的说明）—— 不能无条件 appendChild，否则
                 `appendChild(null)` 会抛 TypeError，
                 整个区域渲染失败（症状：阅读视图一片空白）。
            */
            var head = makeRegionHeader(region);
            if (head) {
                sec.appendChild(head);
            }
        } else if (FRONT_LABEL_KEY[region.type]) {
            var label = document.createElement('div');
            label.className = 'rd-region-titletext';
            label.textContent = t(FRONT_LABEL_KEY[region.type]);
            sec.appendChild(label);
        }

        var body = document.createElement('div');
        body.className = 'rd-region-body';

        // 直接内容
        for (var i = 0; i < region.blocks.length; i++) {
            var b = region.blocks[i];
            /*
              ⚠️ 调试：确认渲染侧拿到的 textType 与 line。
                 排查「buildRegions 命中了标注、但视图没变」时，
                 这一条能立刻区分：
                   · 这里 textType 为空 → buildRegions 写的不是同一个对象
                   · 这里 textType 有值 → 问题在 makeBlockEl 的分支
            */
            if (b && b.textType && b.textType !== 'body') {
                trace('reader:render-block', 'line=' + b.line + ' textType=' +
                      b.textType + ' kind=' + b.kind);
            }
            var el = makeBlockEl(b, b.textType);
            if (el) body.appendChild(el);
        }

        // 更深层的子区域
        for (var j = 0; j < region.children.length; j++) {
            body.appendChild(makeRegionEl(region.children[j]));
        }

        sec.appendChild(body);
        return sec;
    }

    /**
     * 造章节区的头部。
     *
     * ══ ⚠️ 这里**故意没有折叠功能**（用户 2026-09-24 明确要求）══
     *
     * 用户原话：「阅读视图不许折叠，无法修改，想修改必须去原始视图（pdf）中修改分区」
     *
     * 道理：阅读视图是**结果**，不是编辑界面。
     * 它显示的是「我们（或用户）判定出来的分区」，
     * 用户在这里唯一该做的是**读**。要改分区就去原始视图，
     * 那里能看到版面、能画框、能选中文本 —— 那才是改的地方。
     *
     * ⚠️ 所以上一版做的这些全部**删掉**，不要加回来：
     *    · `<button class="rd-region-head">` + aria-expanded
     *    · 点击折叠逻辑
     *    · 左侧那个旋转三角（CSS 的 .rd-region-head::before）
     *    留一个可点的标题会让用户以为"点一下能改什么"，
     *    而点了没反应比没有这个交互更让人困惑。
     *
     * ⚠️ 因此这里返回的是**纯 `<h2>/<h3>/<h4>`**，
     *    不带任何交互语义（不是按钮、没有 tabindex、没有 cursor:pointer）。
     */
    function makeRegionHeader(region) {
        var lv = region.level >= 3 ? 4 : (region.level === 2 ? 3 : 2);
        var title = document.createElement('h' + lv);
        title.className = 'reader-heading rd-region-title';
        /*
          ══ ⚠️⚠️ 没有真标题时**不出这个头部**（2026-09-25 用户实测）══

          用户原话（关于「清空」的预期）：「**全部拍平成纯正文**」。

          清空后所有块的 textType 都成了 body → buildRegions 里
          没有任何块走"首页区"或"章节区"的判据 → 整篇落进那条
          兜底分支 `openRegion(out, stack, 1, null)`（headingBlock = null）。

          旧行为：给这个无标题区起个占位文案
                  `t('reader.untitledSection')` = **"Section"**，
                  于是阅读视图顶上凭空出现一个 `H2 "Section"`。

          真机实测（tools/emu_clear_why.py）清空后的阅读视图：
              H2 21.25px  "Section"              ← 这个是伪标题
              P  17px     "Attention Is All You N"
              P  17px     "Uszkoreit∗Google Brain"
              …

          用户要的是"拍平成纯正文"，而这个 H2 "Section" 把正文
          又切出了一个区、凭空造了一个不存在的章节名 ——
          它**没有任何信息量**（既不是论文里的词，也不表示任何结构），
          纯粹是内部数据结构的产物泄漏到了界面上。

          ✅ 修法：没有 heading 就不出头部。
             区域本身仍然存在（DOM 结构、CSS 都照旧），
             只是不渲染那行标题文字 —— 正文照样拍平，
             且不会出现凭空的 "Section"。
        */
        if (!region.heading || !region.heading.text) {
            return null;
        }
        title.textContent = region.heading.text;
        return title;
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
          ══ 渲染：优先用结构化块（v0.1.6）══

          ⚠️ 为什么必须分块渲染（用户 2026-09-24 的反馈）：
             「阅读内容仍然无法阅读 …… 所有文本也挤在了一起，
              总之非常难以辨认」。

             纯文本 + pre-wrap 的问题是**结构信息为零** ——
             标题、段落、公式在视觉上完全一样，
             于是整篇看起来是一大团字。而 PDF 里它们本来是
             可以区分的（字号、粗细、间距）。

             所以原生侧现在产出 blocks（heading / paragraph /
             formula / figure），前端按 kind 给不同标签与样式：
                heading   → <h2>/<h3>，字号更大、有上间距
                paragraph → <p>，段距 + 首行缩进
                formula   → <div class="reader-formula">，等宽 + 底纹
                figure    → <div class="reader-figure">（暂无产出）

          ⚠️ 没有 blocks 时**退回纯文本**（老数据 / 提取层未升级）。
            不能因为拿不到 blocks 就白屏 —— 那比排版差严重得多。
        */
        /*
          ⚠️ 缓存一份，供「从原始视图切回阅读视图」时重放
             （见 restoreReadingContent），
             以及供编辑模式在页图上画出"可点的文字块"
             （见 mountTextBlocksOn）。

          ⚠️ **必须在 renderBlocks 之前赋值**！——
             renderBlocks 内部的 buildRegions 会把行号写回块
             （block.line），而编辑模式靠它把点中的块映射成
             TextMark 的 from/to。晚赋值的话 lastBlocks 里
             的块**没有 line 字段**，文字块会全部点不动。

          ⚠️ 两者只会有一个非空，所以要**显式清掉另一个** ——
             不清的话，上一篇的 blocks 会残留在 lastBlocks 里，
             下一次切回时重新渲染出**上一篇的正文**（而不是本篇的纯文本）。
        */
        if (blocks && blocks.length) {
            /*
              ⚠️⚠️ 必须先丢掉「被别的块包含」的重复块（见 dropContainedBlocks）。

                 不丢的后果（用户实测报的一串问题）：
                   · 框是乱的（同一行 4 个框层层叠着）
                   · 改分类变了另一个看不见的块 → "旧分类跑到右下角"
                   · 删除删的是上层 → "删不掉"
                   · 反复操作越积越多 → "最多三个"
                   · 那块位置被占满 → "无法增加其他框"

                 ⚠️ 必须在这里（**渲染与缓存之前**）过滤，
                    这样 renderBlocks / lastBlocks / 编辑模式的文字块
                    用的是**同一份**数据，不会出现"渲染算一套、点击算另一套"。
            */
            blocks = dropContainedBlocks(blocks);
        }

        if (blocks && blocks.length) {
            lastBlocks = blocks;
            lastText = '';
        } else {
            lastBlocks = null;
            lastText = text;
        }

        if (blocks && blocks.length) {
            renderBlocks(blocks);
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

    function renderToc() {
        if (!tocListEl) return;
        tocListEl.textContent = '';

        if (!toc.length) {
            var empty = document.createElement('li');
            empty.className = 'toc-empty';
            empty.textContent = t('reader.tocEmpty');
            tocListEl.appendChild(empty);
            return;
        }

        toc.forEach(function (entry) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'toc-item';
            btn.setAttribute('data-level', String(entry.level));
            btn.textContent = entry.title;
            btn.addEventListener('click', function () {
                jumpTo(entry);
            });
            li.appendChild(btn);
            tocListEl.appendChild(li);
        });
    }

    /**
     * 跳转到目录条目的位置。
     *
     * ⚠️ 定位方式：把正文按行渲染，每条目录记着行号。
     *    跳转时用**该行第一个字符在渲染文本里的偏移**算像素位置。
     *
     *    为什么不用给每行套 <span id>：正文可能几十万字符，
     *    为每一行建元素会让 WebView 的内存和布局开销爆炸
     *    （实测一篇 17 页论文 5 千行，建 5 千个元素已经明显卡顿）。
     *    用 Range + getBoundingClientRect 只对目标行算一次，成本极低。
     */
    function jumpTo(entry) {
        if (!contentEl || !bodyEl) return;

        var offset = 0;
        for (var i = 0; i < entry.line && i < textLines.length; i++) {
            offset += textLines[i].length + 1;   // +1 是换行符
        }

        /*
          ⚠️ 用 Range 而不是 childNodes 遍历：正文是单一文本节点
             （textContent 设进去的），所以只有一个子节点，
             偏移可以直接用在它身上。若将来改成多节点，这里要跟着改。
        */
        var target = null;
        var node = contentEl.firstChild;
        if (node && node.nodeType === 3) {
            var len = node.nodeValue.length;
            var start = Math.min(offset, len);
            try {
                var range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, Math.min(start + 1, len));
                target = range.getBoundingClientRect();
            } catch (e) {
                target = null;
            }
        }

        setToc(false);

        if (target && target.height >= 0) {
            // 目标相对正文容器的位置 + 当前滚动量 = 绝对滚动位置
            var bodyTop = bodyEl.getBoundingClientRect().top;
            var y = bodyEl.scrollTop + (target.top - bodyTop);
            /*
              留出顶部栏高度，否则跳过去的标题正好被顶栏压住。
              菜单这时是收起的（点目录时菜单收起了吗？没有 ——
              所以顶栏是隐藏的，只留一点点呼吸空间即可）。
            */
            bodyEl.scrollTo({ top: Math.max(0, y - 24), behavior: 'smooth' });
        }
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
        /*
          ⚠️ 视图切换按钮也要刷 —— 它的 aria-label 是「即将切到哪个视图」，
             由 JS 按当前 view 算出来。i18n 的 data-i18n-aria-label 已被
             syncViewToggle 摘掉（否则会被刷成固定文案），
             所以这里不补这一句，切语言后读屏标签就一直是旧语言。
        */
        syncViewToggle();
        /*
          ⚠️ 编辑按钮与编辑选项栏同理：它们的文案都是 JS 填的
             （类型名、提示语、"标注/完成"），
             不刷的话切语言后这两处会一直停在旧语言。

             ⚠️ syncEditBar 内部对 editBarEl 做了空判 ——
                没进过编辑模式时选项栏还不存在，不能直接调它的
                querySelectorAll（会 null 崩）。
        */
        syncAnnotate();
        syncEditBar();
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
         *   以前排查「框乱 / 改不掉 / 重排不生效」时，只能从 DOM 里数
         *   `.anno-block`、读 `data-block-line` 去猜。但：
         *     · `.anno-block` 是**空定位框**（文字在页图位图里），
         *       `textContent` 只有标签文字，取不到块文本；
         *     · `data-block-line` 是**按累计行数估算**的，
         *       与 DOM 元素不是一一对应。
         *   于是断言经常"看着失败、其实功能正常"。
         *   把真实的块数组暴露出来，断言可以直接打在任何字段上。
         */
        getBlocks: function () {
            return lastBlocks ? lastBlocks.slice() : null;
        },
        /**
         * 当前正文块（供测试与排查用）。
         *
         * ⚠️ 为什么需要（吃过亏）：
         *   以前排查"框乱/改不掉/重排不生效"时，只能从 DOM 里数
         *   `.anno-block`、读 `data-block-line` 猜。但：
         *     · `.anno-block` 是**空定位框**（文字在页图位图里），
         *       `textContent` 只有标签文字；
         *     · `data-block-line` 是**按累计行数估算**的，
         *       与 DOM 元素不是一一对应。
         *   于是断言经常"看着失败其实功能正常"。这里直接把
         *   真实的块数组暴露出来，断言可以打在任何字段上。
         */
        getBlocks: function () {
            return lastBlocks ? lastBlocks.slice() : null;
        },
        /** 文本标注（供测试与排查用，理由同 getBlocks） */
        getTextMarks: function () {
            return textMarks.slice();
        },
        /** 最近一次在原始视图里选中的行区间（供测试用） */
        getRawSelection: function () {
            return currentSelection
                ? { rowFrom: currentSelection.rowFrom, rowTo: currentSelection.rowTo }
                : null;
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
        handleBack: function () {
            if (!isOpen()) {
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
            } else if (tocOpen) {
                setToc(false);
            } else if (panelOpen) {
                setPanel(false);
            } else if (menuOpen) {
                setMenu(false);
            } else {
                close();
            }
            return true;
        }
    };
})(window);
