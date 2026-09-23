/**
 * Scholarius - 通用 UI 组件。
 *
 * 提供设置页与个人页要用的几样东西：
 *   toast            底部浮现的短提示
 *   openSheet/closeSheet  底部弹层（更新弹窗、确认弹窗都用它）
 *   createRowPicker  「左名称 / 右当前值，点整行弹选项」的设置行
 *   attachLongPress  长按（退出登录的二次确认会用到）
 *
 * 设计约束（继承 Livolog）：
 *   · 弹层打开时 body 加 .sheet-open，遮罩与滚动锁都靠它
 *   · 弹层自己不负责关闭动画之外的收尾，调用方要显式 closeSheet()
 */
(function (global) {
    'use strict';

    var currentSheet = null;
    /** 当前弹层的「被关掉」回调，见 notifyDismissed() */
    var currentDismissHandler = null;
    var toastTimer = null;
    var longPressed = false;

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    /**
     * 诊断日志。走 app.js 的全局 trace()，未加载时静默跳过。
     *
     * ⚠️ 弹窗「开了但看不见」曾困扰很久，排查时最关键的一步就是
     *    把 openSheet 内部的状态打出来 —— 原生侧只知道「已请求」。
     */
    function trace(stage, detail) {
        if (global.trace) {
            global.trace(stage, detail);
        }
    }

    /* ----------------------------------------------------------------------
       toast
       ---------------------------------------------------------------------- */

    function toast(message) {
        var el = document.getElementById('toast');
        if (!el) {
            return;
        }

        el.textContent = message;
        el.classList.add('is-visible');

        if (toastTimer) {
            global.clearTimeout(toastTimer);
        }
        toastTimer = global.setTimeout(function () {
            el.classList.remove('is-visible');
        }, 2200);
    }

    /* ----------------------------------------------------------------------
       底部弹层
       ---------------------------------------------------------------------- */

    function openSheet(sheet, onDismiss) {
        trace('sheet:open', 'incoming=' + (sheet ? sheet.id : 'null') +
            ' hidden=' + (sheet ? sheet.hidden : '-') +
            ' current=' + (currentSheet ? currentSheet.id : 'null'));

        if (!sheet) {
            trace('sheet:open', '放弃：sheet 为空');
            return;
        }

        // 同一时刻只允许一个弹层
        if (currentSheet && currentSheet !== sheet) {
            currentSheet.hidden = true;
            notifyDismissed();
        }

        sheet.hidden = false;
        currentSheet = sheet;
        currentDismissHandler = typeof onDismiss === 'function' ? onDismiss : null;
        document.body.classList.add('sheet-open');

        /*
          ⚠️ 进场动画的强制回流，必须**把读到的值用起来**。

          原来写的是 `void sheet.offsetWidth;` —— 这行的返回值被丢弃，
          而 `offsetWidth` 是无副作用的 getter，JS 引擎在优化模式下
          完全可以把整句删掉。删掉之后浏览器会把
          「取消 hidden」和「加 is-open」合并成一次样式计算，
          起始态就不再是 translateY(100%)，transition 不触发，
          弹窗永远停在屏幕外（实测 rect.top === innerHeight）。

          改成 if 条件使用它，引擎就无法省略这次布局读取。
        */
        if (sheet.offsetWidth < 0) {
            return;
        }
        sheet.classList.add('is-open');

        trace('sheet:open', 'done id=' + sheet.id +
            ' class=' + sheet.className +
            ' h=' + Math.round(sheet.getBoundingClientRect().height));
    }

    function closeSheet() {
        var sheet = currentSheet;
        if (!sheet) {
            return;
        }

        currentSheet = null;
        document.body.classList.remove('sheet-open');
        sheet.classList.remove('is-open');

        sheet.hidden = true;
        notifyDismissed();
    }

    /**
     * 弹层被关掉时通知调用方做收尾。
     *
     * 为什么需要：有些弹层（更新提示）在原生侧也有一份状态，
     * 关了不告诉原生，那边就会一直以为「弹窗还开着」，之后再也不会检查更新。
     * 用回调比在全局挂一个 scrim 的点击监听可靠 —— 后者在
     * 「按返回键关闭」「被其它弹层顶掉」这些路径上都不会触发。
     */
    function notifyDismissed() {
        var handler = currentDismissHandler;
        currentDismissHandler = null;
        if (handler) {
            try {
                handler();
            } catch (e) {
                /* 收尾失败不该影响关闭本身 */
            }
        }
    }

    function isSheetOpen() {
        return !!currentSheet;
    }

    function currentSheetEl() {
        return currentSheet;
    }

    /* ----------------------------------------------------------------------
       通用确认弹层
       ---------------------------------------------------------------------- */

    /** 当前的确认回调；null 表示弹层没开 */
    var confirmHandler = null;

    /**
     * 弹一个「标题 + 正文 + 取消/确定」的确认框。
     *
     * @param options { title, message, confirmLabel, cancelLabel, onConfirm }
     *
     * 为什么不复用 sheet-signout：那个的文案写死在 i18n 里，
     * 而这里要显示运行时才拿到的设备码，必须动态填。
     */
    function confirmSheet(options) {
        var sheet = document.getElementById('sheet-confirm');
        if (!sheet) {
            // 没有元素就地降级：直接执行，不让功能卡住
            if (options && typeof options.onConfirm === 'function') {
                options.onConfirm();
            }
            return;
        }

        var titleEl = document.getElementById('confirm-title');
        var messageEl = document.getElementById('confirm-message');
        var okBtn = document.getElementById('confirm-ok');
        var cancelBtn = document.getElementById('confirm-cancel');

        titleEl.textContent = options.title || '';
        /*
          ⚠️ 用 textContent 而不是 innerHTML ——
              正文里含用户可见的设备码，虽然是我们自己传的，
              但保持「不用 innerHTML 渲染动态内容」这条规矩能避免以后出错。
        */
        messageEl.textContent = options.message || '';
        okBtn.textContent = options.confirmLabel || '';
        cancelBtn.textContent = options.cancelLabel || '';

        confirmHandler = typeof options.onConfirm === 'function'
            ? options.onConfirm
            : null;

        okBtn.onclick = function () {
            var handler = confirmHandler;
            confirmHandler = null;
            closeSheet();
            if (handler) {
                handler();
            }
        };

        cancelBtn.onclick = function () {
            confirmHandler = null;
            closeSheet();
        };

        openSheet(sheet, function () {
            /* 被任何其它途径关掉（返回键、被顶掉）都视为取消 */
            confirmHandler = null;
        });
    }

    /* ----------------------------------------------------------------------
       设置行：左名称 / 右当前值，点整行弹选项
       ---------------------------------------------------------------------- */

    /**
     * @param row      整行可点的容器（通常是 <button class="setting-action">）
     * @param valueEl  显示当前值的元素
     * @param config   { getOptions, getValue, onChange, placeholder, isDisabled }
     *                 getOptions() -> [{ value, label }]
     */
    function createRowPicker(row, valueEl, config) {
        var menu = null;

        function refresh() {
            var value = config.getValue();
            var found = null;
            var options = config.getOptions() || [];
            for (var i = 0; i < options.length; i++) {
                if (options[i].value === value) {
                    found = options[i];
                    break;
                }
            }

            valueEl.textContent = found
                ? found.label
                : (config.placeholder ? config.placeholder() : '');
            row.disabled = config.isDisabled ? !!config.isDisabled() : false;
        }

        function closeMenu() {
            if (!menu) {
                return;
            }
            var el = menu;
            menu = null;
            el.classList.remove('is-open');
            global.setTimeout(function () {
                if (el.parentNode) {
                    el.parentNode.removeChild(el);
                }
            }, 180);
        }

        function openMenu() {
            if (menu) {
                closeMenu();
                return;
            }

            var options = config.getOptions() || [];
            if (!options.length) {
                return;
            }

            var box = document.createElement('div');
            box.className = 'row-menu';

            options.forEach(function (option) {
                var item = document.createElement('button');
                item.type = 'button';
                item.className = 'row-menu-item';
                if (option.value === config.getValue()) {
                    item.classList.add('is-selected');
                }

                var label = document.createElement('span');
                label.className = 'row-menu-label';
                label.textContent = option.label;
                item.appendChild(label);

                if (option.value === config.getValue()) {
                    // Google Material Icons: check
                    var check = document.createElement('span');
                    check.className = 'row-menu-check';
                    check.innerHTML =
                        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                        '<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
                    item.appendChild(check);
                }

                item.addEventListener('click', function () {
                    closeMenu();
                    if (option.value !== config.getValue()) {
                        config.onChange(option.value);
                        refresh();
                    }
                });

                box.appendChild(item);
            });

            // 蒙层：点别处就收起
            var scrim = document.createElement('div');
            scrim.className = 'row-menu-scrim';
            scrim.addEventListener('click', closeMenu);

            document.body.appendChild(scrim);
            document.body.appendChild(box);
            menu = box;

            // 贴着该行下沿展开
            var rect = row.getBoundingClientRect();
            var spaceBelow = global.innerHeight - rect.bottom;
            var estimated = Math.min(options.length * 48 + 16, 320);
            var openUp = spaceBelow < estimated + 20;

            box.style.left = '16px';
            box.style.right = '16px';
            if (openUp) {
                box.style.bottom = (global.innerHeight - rect.top + 6) + 'px';
            } else {
                box.style.top = (rect.bottom + 6) + 'px';
            }

            void box.offsetWidth;
            box.classList.add('is-open');
            row.setAttribute('aria-expanded', 'true');
        }

        row.addEventListener('click', function () {
            if (row.disabled) {
                return;
            }
            openMenu();
        });

        // 页面滚动/切页时收起，避免菜单浮在别处
        global.addEventListener('scroll', closeMenu, true);
        global.addEventListener('resize', closeMenu);

        refresh();

        return {
            refresh: refresh,
            close: closeMenu
        };
    }

    /* ----------------------------------------------------------------------
       长按
       ---------------------------------------------------------------------- */

    /**
     * 长按 600ms 触发 handler，并置一个「刚长按过」的标记，
     * 供 click 里判断要不要跳过（长按后系统还会补一个 click）。
     */
    function attachLongPress(element, handler) {
        var timer = null;

        function cancel() {
            if (timer) {
                global.clearTimeout(timer);
                timer = null;
            }
        }

        element.addEventListener('touchstart', function () {
            cancel();
            timer = global.setTimeout(function () {
                timer = null;
                longPressed = true;
                handler();
            }, 600);
        }, { passive: true });

        ['touchend', 'touchcancel', 'touchmove'].forEach(function (type) {
            element.addEventListener(type, cancel, { passive: true });
        });

        element.addEventListener('contextmenu', function (event) {
            event.preventDefault();
        });
    }

    /** 读一次就清零：只在长按后的那一次 click 里返回 true */
    function justLongPressed() {
        var value = longPressed;
        longPressed = false;
        return value;
    }

    /* ----------------------------------------------------------------------
       Google Material Icons
       ---------------------------------------------------------------------- */

    var ICON_PATHS = {
        check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
        chevronRight: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
        refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
        logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
        info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
        copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
        openInNew: 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
        download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
        warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'
    };

    /*
      GitHub 官方 Octocat 标识（github-mark.svg 的路径，MIT 许可）。

      这是 ICON_PATHS 之外单独放的 —— 上面的都是 Google Material Icons，
      而 Material 体系里**没有第三方品牌 logo**。
      「用 GitHub 登录」按钮上放 GitHub 自己的标识是官方推荐的品牌用法，
      不能拿 Material 的通用图标（code / hub 之类）替代，用户认不出来。

      viewBox 与 Material 一样是 0 0 24 24，只是路径是 GitHub 官方的。
    */
    var GITHUB_MARK_VIEWBOX = '0 0 16 16';
    var GITHUB_MARK_PATH =
        'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 ' +
        '0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 ' +
        '1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 ' +
        '0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 ' +
        '2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 ' +
        '3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 ' +
        '8c0-4.42-3.58-8-8-8z';

    /** 返回一段 svg 标记，图标全部来自 Google Material Icons */
    function icon(name) {
        var path = ICON_PATHS[name];
        if (!path) {
            return '';
        }
        return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
            '<path d="' + path + '"/></svg>';
    }

    /** GitHub 官方标识（不属于 Material 体系，单独一支） */
    function githubMark() {
        return '<svg viewBox="' + GITHUB_MARK_VIEWBOX + '" aria-hidden="true" focusable="false">' +
            '<path d="' + GITHUB_MARK_PATH + '"/></svg>';
    }

    global.ScholariusUI = {
        t: t,
        toast: toast,
        openSheet: openSheet,
        closeSheet: closeSheet,
        notifyDismissed: notifyDismissed,
        isSheetOpen: isSheetOpen,
        currentSheet: currentSheetEl,
        confirmSheet: confirmSheet,
        createRowPicker: createRowPicker,
        attachLongPress: attachLongPress,
        justLongPressed: justLongPressed,
        icon: icon,
        githubMark: githubMark,
        ICON_PATHS: ICON_PATHS
    };
})(window);
