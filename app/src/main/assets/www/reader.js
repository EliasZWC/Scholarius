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
    /**
     * 是否正在等原生把 PDF 装进来。
     *
     * ⚠️ 用来防止重复请求（用户连点两下会发起两次 loadUrl，
     *    查看器会闪）。也用来在原生回报失败时判断该不该回退。
     */
    var rawViewRequested = false;

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
     * 点中间区域切换菜单。
     *
     * ⚠️ 用**点击时的坐标**判断点在不在中间 1/3，而不是给某个元素绑事件：
     *    正文是一个可滚动的大块，若把它整块当"中间"，那点任何地方都会切换，
     *    以后加上翻页就冲突了。按坐标分区从一开始就是对的。
     */
    function mountTapToToggle() {
        if (!bodyEl) {
            return;
        }

        bodyEl.addEventListener('click', function (event) {
            /*
              排除点在链接/按钮上的情况 —— 那些应该走自己的行为。
              （现在正文里还没有交互元素，但以后可能有引用跳转。）
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

            var rect = bodyEl.getBoundingClientRect();
            if (!rect.width) {
                return;
            }
            var x = event.clientX - rect.left;
            var third = rect.width / 3;

            if (x >= third && x < third * 2) {
                toggleMenu();
            }
            /*
              左右两侧暂时不做事（以后是上一页/下一页）。
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
     * ══ ⚠️ 关键：原始视图由一个**覆盖在主 WebView 上的独立 WebView** 承载 ══
     *
     * 这个过程踩了两次坑，都记在这里，别再走回头路：
     *
     * ① 网页里放 `<iframe src="https://.../pdf/<id>">`
     *    实测（用户 2026-09-24：「看不见 pdf」）：iframe 尺寸正常、
     *    URL 也真的发出去了，但**画面是空的**。
     *    根因：Android WebView 的内置 PDF 查看器是为**顶层文档**设计的，
     *    在子框架里不渲染。这是查看器的行为，不是我们代码错。
     *
     * ② 让**主 WebView** 自己 loadUrl(PDF)（顶层，确实能渲染）
     *    但整个网页被替换掉了 —— 顶栏一起消失，
     *    用户**没法切回阅读视图**（反馈：「没有成功转换视图」）。
     *
     * ③ 现在：原生另开一个 WebView（`raw_view`）盖在上面，
     *    PDF 是**它**的顶层文档 → 查看器肯渲染；
     *    我们的网页与顶栏原封不动（只是被盖住），随时能切回来。
     *
     * ⚠️ 因此网页侧**不改变自己的可见性**，只做两件事：
     *      ① 把按钮图标切过去（让用户知道"已经在原始视图了"）
     *      ② 请原生显示覆盖层
     *    顶栏被盖住期间用户看不见按钮 —— 无所谓，
     *    原生的返回键会把覆盖层收掉，那时状态自动归位。
     *
     * @param {string} next 'reading' | 'raw'
     */
    function setView(next) {
        var want = (next === 'raw') ? 'raw' : 'reading';

        /*
          ⚠️ 已经在原始视图时不重复发起 ——
             连续两次 loadUrl 会让查看器闪一下。
        */
        if (want === 'raw' && view === 'raw') return;

        view = want;

        if (want === 'raw') {
            syncViewToggle();
            rawViewRequested = true;

            var bridge = global.ScholariusNative;
            if (bridge && typeof bridge.openRawPdf === 'function' && currentDoc) {
                /*
                  ⚠️ 只传 id（不是 URL）—— URL 由原生拼。
                     理由：id → URL 的规则（主机名、前缀）属于原生侧知识，
                     网页自己拼等于把这份知识复制两份，改一处就错。
                */
                bridge.openRawPdf(String(currentDoc.id));
            } else {
                /*
                  ⚠️ 桥不可用（浏览器预览）→ 回退到阅读视图并提示，
                     不能停在一个永远不出现的原始视图上。
                     实测：预览里点这个按钮却什么都不发生最让人迷惑。
                */
                view = 'reading';
                rawViewRequested = false;
                syncViewToggle();
                showError('no-bridge');
            }
            return;
        }

        /*
          回到阅读视图。

          ⚠️ 正常路径下用户**不必**点这里 ——
             PDF 是全屏覆盖层，顶栏被盖住，用户是用原生的返回键
             关掉覆盖层的（`onRawClosed` 会把状态归位）。

             这条路径留着是因为：覆盖层还可能被非返回键的方式关掉，
             以及状态归位逻辑要有一处统一入口。
        */
        rawViewRequested = false;
        syncViewToggle();
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
    }

    /**
     * 原生回报「已经从 PDF 回来了」。
     *
     * ⚠️ 必须由原生**主动通知**，不能靠网页轮询或猜。
     *    PDF 是盖在别的 WebView 上的独立文档，网页全程收不到任何事件 ——
     *    没有这条通知，按钮会一直停在"原始视图"的图标上。
     */
    function onRawClosed() {
        rawViewRequested = false;
        view = 'reading';
        syncViewToggle();
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

             原始视图现在是“原生把 PDF 装进 WebView”的全屏导航，
             网页被替换掉、不在前台，所以打开新文献时
             网页这边的状态本来就已经是 reading；
             这里显式重置是为了兼容“原生回报失败后转了一圈又回来”的路径。
        */
        rawViewRequested = false;
        view = 'reading';
        syncViewToggle();

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
                rawViewRequested = false;
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
        var frag = document.createDocumentFragment();

        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (!b || !b.text) continue;

            var kind = b.kind || 'paragraph';
            var el;

            if (kind === 'heading') {
                /*
                  ⚠️ 标题层级只映射到 h2 / h3，**不用 h1** ——
                     详情页/页面本身已有 h1 语义（应用标题），
                     正文里再出 h1 会破坏文档大纲。
                     超过 2 级的也压到 h3（视觉上三档够了，
                     再细分在手机上分不出来）。
                */
                var lv = b.level >= 3 ? 3 : (b.level >= 2 ? 3 : 2);
                el = document.createElement('h' + lv);
                el.className = 'reader-heading';

            } else if (kind === 'formula') {
                /*
                  ⚠️ 公式块用等宽字体 + 独立背景。
                     虽然不是真正的 LaTeX（那需要数学 OCR），
                     但「单独成块 + 等宽」已经能让用户把它
                     与正文区分开，不再混在一句话里。

                     ⚠️ 不加 `overflow-x: auto` 之外的交互：
                        本次不做公式识别，所以它仍是文本。
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
                el.textContent = b.text || '';

            } else {
                el = document.createElement('p');
                el.className = 'reader-para';
            }

            if (kind !== 'figure') {
                el.textContent = b.text;
            }
            if (b.page) el.setAttribute('data-page', String(b.page));
            frag.appendChild(el);
        }

        contentEl.appendChild(frag);
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
        /** 原生从 PDF 全屏视图返回后调用（见 setView 的长注释） */
        onRawClosed: onRawClosed,
        /** 目录（供测试与将来的大纲导出用） */
        getToc: function () {
            return toc.slice();
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
