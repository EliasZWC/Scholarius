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
          ⚠️ 每次打开都重置正文缓存。
             上一位用户可能停在同一篇的某一个位置，但缓存必须清 ——
             否则新文献加载期间会短暂显示上一篇的内容。
        */
        lastBlocks = null;
        lastText = '';

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
        var regions = buildRegions(blocks);
        if (!regions.length) {
            // 没有任何可分区的内容：退回平坦渲染（保持旧行为，别白屏）
            renderFlat(blocks);
            return;
        }
        renderRegions(regions);
    }

    /**
     * 把平坦的块序列切成**区域树**。类型**完全由原生识别**决定。
     *
     * ══ 区域类型 ══
     *
     * 首页区（各成一块）：
     *     标题 / 作者 / 摘要 / 关键词
     * 正文区：
     *     一级章节开头 → 开一个 level 1 区域
     *     其下遇到 level 2 标题 → 嵌一个 level 2 区域
     *     再下 level 3 → 继续嵌
     *
     * ══ ⚠️ 用户标注已整体移除（v0.1.37）══
     *
     * 早期版本允许在「原始视图（PDF 位图）」里画框/选字改类型，
     * 再把结果覆盖到这里。那套机制已被**整体删除** ——
     * 用户 2026-10-21 的决定：
     *   「算了，直接清除原视图这个设计吧…随之清除相关的图标和选项」
     *
     * 所以这里不再有 `marks` 参数，也不再读 `mark / byUser /
     * frontHeuristicsOff` 这一类"用户表态优先"的分支。
     * 唯一的输入是原生给的 `blocks`（kind / level / line / text）。
     *
     * ⚠️ 想恢复"人工纠正"能力时，**不要**去翻旧的 marks 代码 ——
     *    那套东西的问题不在实现，在交互载体（位图上画框）。
     *    先重新设计一个不依赖位图的做法（例如在阅读视图里直接
     *    长按段落改类型），再接回来。
     *
     * @param  {Array} blocks [{kind,text,level,page,line}]
     * @return {Array} 区域树 [{type, level, heading, blocks, children}]
     */
    function buildRegions(blocks) {
        var out = [];
        if (!blocks || !blocks.length) return out;

        /*
          ⚠️ 兜底：原生没给行号时按"块内行数"累加估算。
             目录跳转用的 `textLines[block.line]` 需要这个字段。

          ⚠️ 有原生行号时**原样保留**，不要覆盖 ——
             原生行号与 `textLines` 是同一套编号
             （见 Kotlin 侧 globalLine 的说明）。
        */
        var row = 0;
        for (var i = 0; i < blocks.length; i++) {
            var b0 = blocks[i];
            if (!b0 || !b0.text) continue;
            if (typeof b0.line === 'number' && b0.line >= 0) continue;
            var n = b0.text.split('\n').length;
            b0.line = row;
            row += n;
        }

        /*
          ⚠️ 首页区只在**文章开头**认。
             正文中间也可能出现 "Abstract" 字样（引用别人的摘要），
             那时已经进入章节区了，不该再开一个"摘要区"。
        */
        var sawBody = false;
        var stack = []; // 当前打开的章节区域栈（level 递增）
        /*
          ⚠️ 用来认「标题区」和「作者区」：
             题目 = 首页的第一个块（无论它被判成什么）；
             作者 = 紧随题目之后的那一段。
        */
        var sawTitle = false;
        var authorPending = false;
        /**
         * 首页区是否**真的**结束了（v0.1.35 引入，v0.1.37 保留）。
         *
         * ⚠️ 与 `sawBody` 是**两件事**，不要再混用：
         *    `sawBody`   = 章节栈开了没有（决定要不要补无标题兜底区）
         *    `frontDone` = 首页区结束了没有（决定还能不能认标题/摘要）
         *
         * 历史：早期这两件事共用一个 `sawBody`，而它在**第一个块**上
         * 就被正文兜底置 true 了 —— 于是摘要检查永远不生效。
         */
        var frontDone = false;
        /*
          ⚠️ 当前"敞开着的"首页区（title/author/abstract/keyword）。
             摘要标题之后的正文要靠它归位。
             null = 首页已结束或还没开始。
        */
        var frontOpen = null;

        for (var j = 0; j < blocks.length; j++) {
            var blk = blocks[j];
            if (!blk || !blk.text) continue;

            var type = guessKind(blk, frontDone);
            var level = blk.level;

            /*
              ══ ⚠️⚠️ 把最终类型写回块上，供渲染读取 ══

              渲染侧 `makeRegionEl` / `makeBlockEl` 读的是 `b.textType`。
              不写的话它永远是 undefined，只能退回 `b.kind`（原生判定），
              而 `b.kind` 里没有 abstract / keyword 这两类。
            */
            blk.textType = type;
            if (type === 'heading' && !(level > 0)) blk.level = 1;

            /*
              ⚠️ 标题区是**位置**判据：文章的**第一个块**就是题目。
                 （不用"内容像不像标题"，因为封面页整页字号都大、
                   而题目有时被判成 paragraph。）
            */
            if (!frontDone && !sawTitle &&
                type !== 'abstract' && type !== 'keyword') {
                type = 'title';
                blk.textType = type;
            }

            /*
              ⚠️ 作者区同样是**位置**判据：题目后面紧跟的就是作者。
                 单位/邮箱也要并进作者区（靠"遇到摘要/关键词就关窗"收口）。
            */
            if (!frontDone && authorPending && type === 'body') {
                type = 'author';
                blk.textType = type;
            }

            /*
              ══ 首页区：标题 / 作者 / 摘要 / 关键词 ══
            */
            if (!frontDone && (type === 'title' || type === 'author' ||
                              type === 'abstract' || type === 'keyword')) {
                pushFrontRegion(out, type, blk);
                frontOpen = type;
                if (type === 'title') {
                    sawTitle = true;
                    authorPending = true;
                } else if (type === 'abstract' || type === 'keyword') {
                    authorPending = false;
                }
                continue;
            }

            /*
              ⚠️ 首页区还没结束时的**正文块**（摘要正文、关键词列表）
                 要并进刚开的那个首页区，不能去开章节。
            */
            if (!frontDone && frontOpen && type === 'body') {
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
              ══ 走到这里 = 可以认定首页区结束了 ══
              能落到这一点，说明它没被任何前区分支接住。
            */
            if (frontOpen !== null || type === 'heading') {
                frontDone = true;
            }

            /*
              ══ 章节区 ══

              ⚠️ 只看 `type`，**不再**额外挂 `blk.kind === 'heading'` 这个后门。

                 早期写法是 `if (type === 'heading' || blk.kind === 'heading')`，
                 本意是"原生判定的 heading 兜底开区"。但实际上
                 `guessKind` 在首页之外**已经**返回 `blk.kind === 'heading'`
                 的结果，这个 `||` 完全冗余 —— 而在首页之内它反而是**有害**的：
                 它会让首页里被原生误判成 heading 的作者行/单位行
                 强行开出一个章节区，把摘要整段吞进去
                 （2026-10-21 真机实测的症状，见 guessKind 里的说明）。

                 所以删掉它：`type` 是唯一判据，语义只有一处。
            */
            if (type === 'heading') {
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
     *
     * ══ ⚠️⚠️ 第二个参数是 `frontDone`，**不是 `sawBody`**（2026-09-28 修）══
     *
     * 原来传的是 `sawBody`，而 `sawBody` 在**第一个块**上就被
     * 正文兜底 `openRegion(lv=1, null)` 置 true 了
     * （见 buildRegions 里"正文的第一块若还没开章节区"那段）。
     *
     * 后果：**摘要检查永远不生效** —— j=5 那一行 `"Abstract"`
     * 明明是行首且是纯标题词，却因为 `sawBody` 已 true
     * 而跳过了摘要判据 → 落成 `heading` → 摘要变成一个章节区。
     *
     * 实测（reader:fb 日志）：修复前**没有** `PRE j=5 type=abstract`
     * 这一条，只有 `FLIP j=18 line=20 type=heading`；
     * 修复后 j=5 正确判出 `abstract`。
     *
     * ⚠️ `frontDone` 与 `sawBody` 的区别见它在 buildRegions 里的定义：
     *    `sawBody`   = "章节栈开了没有"（决定要不要补兜底区）
     *    `frontDone` = "首页区结束了没有"（决定还能不能认标题/摘要）
     *    这是**两件事**，之前混用导致了本 bug。
     */
    /**
     * 这一行的文本是不是**首页结构锚点**（摘要 / 关键词）。
     *
     * ⚠️ 唯一来源：`guessKind` 用它把「Abstract」这一行认成摘要。
     *    抽成常量的理由是**正则细节容易改错** ——
     *    为什么不用 `\b`、为什么显式列分隔符，见下面 guessKind 里的说明。
     *    将来要放宽/收紧只改这里一处。
     *
     * ⚠️ 正则的细节（为什么不用 `\b`、为什么显式列分隔符）
     *    见下面 guessKind 里那段长注释，这里只做搬运、不改语义。
     *    若将来要放宽/收紧，改这里一处即可，两个调用点同步生效。
     */
    var FRONT_ANCHOR_ABSTRACT = /^(abstract|摘要)(\s|$|[:：—–-])/i;
    var FRONT_ANCHOR_KEYWORD =
        /^(keywords?|index terms|关键词)(\s|$|[:：—–-])/i;

    /**
     * **真章节标题**的编号前缀：`1` / `3.1` / `4.2.1`，后面跟空白再跟标题文字。
     *
     * ⚠️ 只给「首页里判原生 heading」那一处用（见 guessKind）。
     *    首页里有大量字号较大、被原生判成 heading 的**非标题行**
     *    （作者、单位、邮箱、会议名），必须靠编号把它们区分开，
     *    否则首页永远关不掉、摘要区会吞掉整篇。
     *
     * ⚠️ 要求编号后**必须**跟空白 —— 否则 `3D` / `2017` 这种
     *    以数字开头的正文也会命中。
     */
    var SECTION_NUMBER_RE = /^\d+(?:\.\d+)*\.?\s+\S/;

    /** 这一行是不是摘要/关键词锚点（见上） */
    function isFrontAnchorText(text) {
        if (text == null) return false;
        var txt = String(text).trim();
        return FRONT_ANCHOR_ABSTRACT.test(txt) ||
               FRONT_ANCHOR_KEYWORD.test(txt);
    }

    function guessKind(blk, frontDone) {
        if (!frontDone) {
            var txt = blk.text.trim();
            /*
              ⚠️ 摘要 / 关键词的提示词。中英文都列 ——                 两种写法在真实论文里都常见。

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
            if (FRONT_ANCHOR_ABSTRACT.test(txt)) return 'abstract';
            if (FRONT_ANCHOR_KEYWORD.test(txt)) return 'keyword';

            /*
              ══ ⚠️⚠️ 首页里**不能**直接用原生的 `kind === 'heading'` ══
                 （2026-10-21 真机实测的真因）

              ══ 症状 ══

              真机上打开 Transformer 论文，阅读视图首屏是：

                  READER.TYPETITLE
                  Attention Is All You Need Ashish Vaswani∗…
                  ┃ Vaswani∗Noam Shazeer∗Niki Parmar∗Jakob Uszkoreit∗
                  ┃ Google Brain Google Brain … avaswani@google.com …
                  ┃ Google Research University of Toronto … aidan@cs…
                  Abstract
                  The dominant sequence transduction models are based on …

              作者、单位、邮箱全被**吞进一个叫「Vaswani∗Noam Shazeer∗…」
              的二级章节区**里 —— 摘要区没建出来，摘要标题变成那个假章节里的正文。

              ══ 真因 ══

              原生 `PdfText.classifyBlock` 把作者行

                  "Vaswani∗Noam Shazeer∗Niki Parmar∗Jakob Uszkoreit∗"

              判成了 `heading`（level 2）—— 它字号确实比正文大、
              独立成行、没有句末标点，三条启发式全部命中。

              而这个函数原来无条件信任它：

                  if (blk.kind === 'heading') return 'heading';

              → `buildRegions` 走 `openRegion(out, stack, 2, blk)` 开章节 →
              **作者行成了区域头**，后续单位/邮箱按"章节正文"appendToStack
              进同一个区 → 直到遇到 `Abstract`（标题）才又开一个区。
              所以摘要区被整个吃掉了。

              ⚠️ 这个 bug 与标注无关，是**一直存在**的 ——
                 早期版本里作者区判据会把它改写成 `author`，恰好挡住；
                 v0.1.37 删掉标注后作者区判据只剩位置判据，
                 而位置判据要求 `type === 'body'`，heading 进不去，
                 于是问题首次暴露。

              ══ ✅ 修法 ══

              首页（`!frontDone`）里，原生判的 heading **默认不当章节标题** ——
              降级成 `body`，交给 `buildRegions` 的位置判据去归位
              （题目 → title，题目之后 → author）。

              ⚠️ 但**必须有例外**，否则首页永远关不掉（2026-10-21 第二次实测）：

                 第一次修完只做了"降级"，于是 `1 Introduction` 也成了 body，
                 `frontOpen` 再也遇不到 heading → 永远不关
                 → 摘要区把**后面全部 326 个块**吞进去。
                 真机日志：`#2 type=abstract blocks=326`（应为 12）。

              ✅ 例外判据：**带章节编号的**才算真章节标题。
                 摘要是 `Abstract` 这种纯词，作者行是 `Vaswani∗Noam…`，
                 单位/邮箱不带编号 —— 只有 `1 Introduction` / `3.1 Encoder`
                 这类"数字 + 空格 + 标题文字"才是正文的开始。

                 ⚠️ 只认**行首的数字编号**，不认 `Abstract`。
                     `Abstract` 在上面的锚点判断里已经返回了，走不到这里。
                 ⚠️ 也不认罗马数字 —— 首页的 `I` / `II` 更可能是版式符号，
                     而真章节标题几乎都有阿拉伯数字编号。
            */
            if (blk.kind === 'heading' && SECTION_NUMBER_RE.test(txt)) {
                return 'heading';
            }

            /*
              ⚠️ 摘要/关键词之后的正文（摘要正文、关键词列表）
                 仍返回 body，由 `frontOpen` 收编 —— 见 buildRegions。
            */
            return 'body';
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
        /*
          ⚠️ 区域头也要带 `data-line` —— 目录里绝大多数条目是
             **章节标题**，它们只存在于区域头里，正文块列表里没有。
             漏了这一步，点目录就只能靠"跳到下一个正文块"的兜底，
             位置会差一行（落在标题下面那段的第一行）。
        */
        if (typeof region.heading.line === 'number' && region.heading.line >= 0) {
            title.setAttribute('data-line', String(region.heading.line));
        }
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
          ⚠️ 缓存一份块数据，供测试接口（getBlocks）读取。

          ⚠️ **必须在 renderBlocks 之前赋值** ——
             renderBlocks 内部的 buildRegions 会把行号写回块（block.line）。
             晚赋值的话 lastBlocks 里的块**没有 line 字段**。

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
          留出顶部栏高度，否则跳过去的标题正好被顶栏压住。
          菜单这时是收起的，所以只需一点呼吸空间。
        */
        bodyEl.scrollTo({ top: Math.max(0, y - 24), behavior: 'smooth' });
        trace('reader:jump', 'line=' + want + ' -> ' + best.tagName +
              ' data-line=' + best.getAttribute('data-line') + ' y=' + y);
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
