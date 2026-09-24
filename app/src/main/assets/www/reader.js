/**
 * Scholarius - 阅读页。
 *
 * ## 交互（与主流阅读器一致）
 *
 * · **点正文中间的 1/3 区域**切换菜单显隐（左 1/3、右 1/3 留给翻页，
 *   本版还没做翻页，但区域先留出来，避免以后改交互位置）
 * · 菜单分上下两条：顶部栏（左返回）、底部选项栏（先留空）
 * · 菜单显隐用 transform 滑动，**正文位置不动** —— 否则阅读进度会跳
 *
 * ## 为什么正文用 LaTeX 源码而不是排版后的公式
 *
 * 用户明确要求「保存形式是 latex 形式」。这带来两个后果，都要记住：
 *
 *   ① 正文里会**看到 `\alpha`、`$x^2$` 这样的原始标记**，不是渲染后的符号。
 *      这是**有意为之**（保存形式就是如此），不是渲染失败。
 *   ② 以后若要显示成排版效果，需要引入 KaTeX/MathJax 之类的渲染器；
 *      届时「LaTeX 源码」仍然是存储形态，渲染只在展示层。
 *
 * ## 文本从哪来
 *
 * 由原生从 PDF 提取（`PdfText.extract`）后推过来，网页不接触 PDF 文件
 * —— WebView 的 allowFileAccess=false，读不到应用私有目录。
 */
(function (global) {
    'use strict';

    var root = null;
    var bodyEl = null;
    var contentEl = null;
    var topEl = null;
    var backBtn = null;
    var titleEl = null;

    /** 当前打开的文献 */
    var currentDoc = null;
    /** 菜单是否可见 */
    var menuOpen = false;

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    function init() {
        root = document.getElementById('reader');
        bodyEl = document.getElementById('reader-body');
        contentEl = document.getElementById('reader-content');
        topEl = document.getElementById('reader-top');
        backBtn = document.getElementById('reader-back');
        titleEl = document.getElementById('reader-title');

        if (!root) {
            return;
        }

        mountBack();
        mountTapToToggle();

        if (global.ScholariusI18n && global.ScholariusI18n.onChange) {
            global.ScholariusI18n.onChange(refreshChrome);
        }
    }

    function mountBack() {
        if (backBtn) {
            backBtn.addEventListener('click', close);
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

    function toggleMenu() {
        setMenu(!menuOpen);
    }

    function setMenu(open) {
        menuOpen = !!open;
        if (root) {
            root.classList.toggle('is-menu-open', menuOpen);
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

        if (titleEl) {
            // 菜单里显示标题。不放作者 —— 阅读时没人在意，位置也挤
            titleEl.textContent = doc.title || doc.sourceName || '';
        }

        showLoading();

        root.hidden = false;
        // 强制布局后再加 is-open，否则滑入动画不触发
        if (root.offsetWidth < 0) return;
        root.classList.add('is-open');

        // 初始不显示菜单，纯正文
        setMenu(false);

        /*
          菜单栏在隐藏态是 translateY(±100%)。
          首次显示时要保证 transform 已生效再滑动 —— 上面强制布局已经处理。
        */

        requestText(doc.id);
    }

    function close() {
        if (!root) {
            return;
        }
        root.classList.remove('is-open');
        setMenu(false);
        global.setTimeout(function () {
            if (!root.classList.contains('is-open')) {
                root.hidden = true;
                currentDoc = null;
                if (contentEl) {
                    contentEl.textContent = '';
                }
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

    function showError(reason) {
        if (!contentEl) {
            return;
        }
        contentEl.textContent = '';
        var hint = document.createElement('div');
        hint.className = 'reader-hint';
        hint.textContent = t('reader.extractFailed');
        contentEl.appendChild(hint);
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
     * 原生推来正文文本。
     *
     * ⚠️ 只接收**当前打开的那篇** —— 用户可能很快点开另一篇，
     *    上一篇的提取结果这时才回来。用 id 比对丢弃过期结果，
     *    否则会出现「打开了 B，显示的却是 A 的正文」。
     */
    function setText(id, text) {
        if (!currentDoc || currentDoc.id !== id) {
            trace('reader:text-stale', 'ignored ' + id);
            return;
        }
        if (!contentEl) {
            return;
        }

        contentEl.textContent = '';
        if (!text) {
            showError('empty');
            return;
        }

        /*
          ⚠️ 用 textContent + CSS pre-wrap，不用 innerHTML。
             正文是从 PDF 提取的任意文本，里面可能有 < > & 之类字符；
             用 innerHTML 会破坏页面结构（甚至注入）。
             LaTeX 源码里的 \ 与 $ 也要原样显示，不能被当作标记解析。
        */
        contentEl.textContent = text;
        // 回到顶部
        if (bodyEl) {
            bodyEl.scrollTop = 0;
        }
    }

    function onExtractFailed(id) {
        if (!currentDoc || currentDoc.id !== id) {
            return;
        }
        showError('failed');
    }

    function refreshChrome() {
        if (isOpen() && titleEl && currentDoc) {
            titleEl.textContent = currentDoc.title || currentDoc.sourceName || '';
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
        /** 系统返回键用：菜单开着就先关菜单，否则关阅读页 */
        handleBack: function () {
            if (!isOpen()) {
                return false;
            }
            if (menuOpen) {
                setMenu(false);
            } else {
                close();
            }
            return true;
        }
    };
})(window);
