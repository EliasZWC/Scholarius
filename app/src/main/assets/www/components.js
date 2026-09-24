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
    /** 上面那个标记的过期定时器（见 attachLongPress） */
    var longPressExpiry = null;

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

    /**
     * 弹层的遮罩（scrim）。
     *
     * ══ 为什么在这里，而不是在 HTML 里给每个弹层配一个（v0.1.5）══
     *
     * 用户要求：「应用内表单应该是点击表单外的地方表单自动触发取消
     * 然后收起来。」
     *
     * 项目里有 4 个弹层（sheet-picker / sheet-confirm / sheet-update /
     * sheet-signout）。若在每个 HTML 节点旁写一个 backdrop，
     * 就得重复 4 遍结构 + 4 遍样式 + 各自绑一遍点击；
     * 而它们的行为**完全一样**。共用一个动态创建的遮罩，
     * 行为天然一致，将来加弹层也不会漏。
     *
     * ⚠️ 遮罩的 z-index 必须**紧贴**弹层的 100（取 99）。
     *    太高会盖住弹层本身（点不到按钮），
     *    太低会被页面内容盖住（点不到遮罩）。
     */
    var scrimEl = null;

    function ensureScrim() {
        if (scrimEl && scrimEl.parentNode) {
            return scrimEl;
        }
        var el = document.createElement('div');
        el.className = 'sheet-scrim';
        el.hidden = true;
        /*
          ⚠️ 用 click 而不是 touchstart/mousedown。
             touchstart 会在**滚动惯性中**误触发（用户滑动页面想看清
             弹层内容，手指抬起时点到了遮罩上），把弹层关掉。
             click 只在真实的「点按」后触发，滚动时不触发。
        */
        el.addEventListener('click', function () {
            trace('scrim:click', 'dismiss sheet=' + (currentSheet ? currentSheet.id : 'null'));
            closeSheet();
        });
        document.body.appendChild(el);
        scrimEl = el;
        return el;
    }

    function showScrim() {
        var el = ensureScrim();
        el.hidden = false;
        /*
          ⚠️ 淡入必须分两帧。
             和弹层的 transform 动画同一个坑：如果在 hidden=false 的
             同一帧就加 is-open，浏览器会把两次样式变更合并，
             起始态不是 opacity: 0，transition 不触发（直接跳变）。
             requestAnimationFrame 让它先以 opacity:0 真实布局一帧。
        */
        global.requestAnimationFrame(function () {
            if (scrimEl) {
                scrimEl.classList.add('is-open');
            }
        });
    }

    function hideScrim() {
        if (!scrimEl) {
            return;
        }
        scrimEl.classList.remove('is-open');
        /*
          ⚠️ 等过渡结束再置 hidden。
             立刻置 hidden 会让淡出动画被掐断（一闪就没了）。
             240ms 是 .sheet-scrim 的 transition 时长，须与之保持一致。
             用 setTimeout 而不是 transitionend：后者在
             「元素已被 hidden」或「动画被打断」时不会触发，会漏掉清理。
        */
        global.setTimeout(function () {
            // 期间可能又开了新弹层，此时不能藏
            if (!currentSheet && scrimEl) {
                scrimEl.hidden = true;
            }
        }, 260);
    }

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
        showScrim();

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
        hideScrim();

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
     * @param options { title, message, confirmLabel, cancelLabel, onConfirm, danger }
     *
     * ⚠️ danger=true 时确定按钮用删除红（--danger），否则用默认前景色。
     *    这个弹层被两类场景复用：
     *      · 删除文献        → danger=true   （破坏性，不可撤销）
     *      · 登录设备码确认   → danger 省略   （普通动作，绿色/默认才对）
     *    所以颜色**不能写死在 HTML 上**，必须按调用方意图切换。
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

        /*
          确定按钮配色。
          ⚠️ 每次都显式设一遍（含 else 分支），
             否则上一次「删除」留下的红色会残留到下一次「验证码确认」上。
        */
        okBtn.classList.toggle('btn-danger', !!options.danger);
        okBtn.classList.toggle('btn-action', !options.danger);

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
    /**
     * 当前打开的「行内选择菜单」的收尾函数；null 表示没有菜单打开。
     *
     * 为什么要有这个模块级登记：
     *   菜单状态（menu / scrim）本来是在每个 createRowPicker 的闭包里的，
     *   一个 picker 一份，彼此看不见。但系统返回键需要一个**全局**入口问
     *   「现在有没有菜单开着」。用登记表把「当前那个」暴露出来最简单。
     *
     *   菜单是互斥的（同一时刻只有一个），所以只需要存一个。
     */
    var openRowMenuCloser = null;

    /** 有没有行内选择菜单开着 */
    function hasOpenRowMenu() {
        return !!openRowMenuCloser;
    }

    /** 关掉当前打开的行内选择菜单（没有则什么都不做） */
    function closeRowMenu() {
        if (openRowMenuCloser) {
            openRowMenuCloser();
        }
    }

    function createRowPicker(row, valueEl, config) {
        var menu = null;
        /** 菜单的全屏蒙层。必须与 menu 同生共死，见 closeMenu 的说明。 */
        var scrim = null;

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

        /**
         * 收起菜单。
         *
         * ⚠️⚠️ 必须**同时移除蒙层** —— 这里曾造成「选完一项后整个应用冻结」。
         *
         * 原来的写法只移除 menu（而且是在 180ms 后用 setTimeout 延迟移除），
         * 那个全屏蒙层 `.row-menu-scrim` 从来没人删。蒙层覆盖整个视口、
         * 又在 body 最后（层级最高），于是选完任何一项之后，
         * 之后所有点击都落在蒙层上 —— 表现为「整个应用冻结、按钮全失效」。
         *
         * 实测证据（冻结时）：
         *   scrimsAfterSelect = 1
         *   scrimRect = 0,0 → 412×915（全屏）
         *   elementFromPoint(设置项按钮) = "row-menu-scrim"
         */
        function closeMenu() {
            // 先清登记：从这一刻起「没有菜单开着」
            if (openRowMenuCloser === closeMenu) {
                openRowMenuCloser = null;
            }

            if (scrim) {
                if (scrim.parentNode) {
                    scrim.parentNode.removeChild(scrim);
                }
                scrim = null;
            }

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
            scrim = document.createElement('div');
            scrim.className = 'row-menu-scrim';
            scrim.addEventListener('click', closeMenu);

            document.body.appendChild(scrim);
            document.body.appendChild(box);
            menu = box;
            // 登记「当前打开的菜单」，供系统返回键查询（见 openRowMenuCloser）
            openRowMenuCloser = closeMenu;

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
       设置行：点整行弹**底部表单**选项
       ---------------------------------------------------------------------- */

    /**
     * 与 createRowPicker 同一形态（左名称 / 右当前值），但选项弹在**底部表单**里，
     * 而不是贴着行的小菜单。
     *
     * ⚠️ 为什么需要这个组件：
     *    createRowPicker 的行内菜单是限定高度的（estimated 最多 320px），
     *    选项一多就会挤在一起或超出屏幕。设置项将来只会更多
     *    （字号档位、字体、颜色、主题……），必须有个能容纳任意项数的形态。
     *    底部表单可以滚动，项数再多也不会排不开。
     *
     * @param row      整行可点的容器
     * @param valueEl  显示当前值的元素
     * @param config   { getOptions, getValue, onChange, title }
     */
    /**
     * 当前打开表单所对应的 row / 回调。
     *
     * ⚠️ 必须按元素存，**不能共用一个「最后一个绑定的 valueEl」变量**。
     *    踩过的坑：原来写了模块级的 sheetPickerValueEl，每次
     *    createRowSheetPicker 都覆写它，导致所有行都指向最后一行的值元素 ——
     *    实测「字体样式」选完之后，**主题那一行也变成了 Monospace**。
     *    改成挂在 row 上，各行互不干扰。
     */
    var SHEET_PICKER_CONFIG = '_scholariusPickerConfig';
    var SHEET_PICKER_VALUE_EL = '_scholariusPickerValueEl';
    /** 当前打开的 row（关表单时要清掉它的 aria-expanded） */
    var openSheetPickerRow = null;

    function createRowSheetPicker(row, valueEl, config) {
        // 把回调挂在元素上，而不是模块级变量 —— 见上面的说明
        row[SHEET_PICKER_CONFIG] = config;
        row[SHEET_PICKER_VALUE_EL] = valueEl;

        row.addEventListener('click', function () {
            if (row.disabled) return;
            openSheetPicker(row, config);
        });

        var api = {
            refresh: function () {
                syncSheetPickerValue(valueEl, config);
            },
            close: closeSheetPicker
        };
        api.refresh();
        return api;
    }

    /**
     * 打开底部选项表单。
     *
     * ⚠️ 实现上**复用一个静态 DOM**（#sheet-picker），每次打开重建内容。
     *    每行都创建一个 form 会让 DOM 无限增长（设置项多、切页频繁）。
     */
    function openSheetPicker(row, config) {
        var sheet = document.getElementById('sheet-picker');
        if (!sheet) {
            return;
        }

        openSheetPickerRow = row;
        if (row.setAttribute) row.setAttribute('aria-expanded', 'true');

        var titleEl = document.getElementById('sheet-picker-title');
        var listEl = document.getElementById('sheet-picker-list');
        var cancelEl = document.getElementById('sheet-picker-cancel');

        if (titleEl) {
            titleEl.textContent = config.title
                || (row.querySelector('.setting-label')
                    ? row.querySelector('.setting-label').textContent
                    : '');
        }

        if (listEl) {
            listEl.textContent = '';
            var current = config.getValue();
            config.getOptions().forEach(function (opt) {
                var li = document.createElement('li');
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'sheet-picker-item';
                /*
                  ⚠️ opt.muted：把这一项画成**浅色**，表示它不是一个
                     真正的选项（如发表物类别的「未设定」）。

                     用户 2026-09-24：「类型选项中的未设置请用浅色来凸显
                     和其他选项的不同」。

                     ⚠️ 为什么需要这个标记：「未设定」在语义上是
                        「还没判定」，不是七种载体之一。但它在列表里
                        与 Journal / Conference 长得一样，用户会以为
                        它是第八种类型 —— 于是可能"主动选择未设定"，
                        而那是无意义的操作（等于什么都不选）。

                     ⚠️ 标记挂在**按钮**上而不是 label 上：
                        这样后续要淡化图标 / 对勾也有统一的钩子。

                     ⚠️ 用类名而不是 inline style —— 颜色要跟随主题，
                        inline 写死会在日间/夜间之一里错。
                */
                if (opt.muted) btn.className += ' is-muted';
                btn.setAttribute('data-value', String(opt.value));
                btn.setAttribute('aria-pressed',
                    String(opt.value) === String(current) ? 'true' : 'false');

                var label = document.createElement('span');
                label.className = 'sheet-picker-label';
                label.textContent = opt.label;

                /*
                  ⚠️ opt.swatch 是可选的颜色预览（如字体颜色那几个选项）。
                     用户要求「给出提示颜色让用户能看到这是什么颜色」——
                     光有文字（「灰色」「棕褐」）没法确定具体是什么色。
                     色块用 background: currentColor，由 inline color 驱动。
                */
                if (opt.swatch) {
                    var dot = document.createElement('span');
                    dot.className = 'sheet-picker-swatch';
                    dot.setAttribute('aria-hidden', 'true');
                    dot.style.color = opt.swatch;
                    btn.appendChild(dot);
                }

                /*
                  ⚠️ 图标与文字要装进**同一个容器**（.sheet-picker-main）。

                     不能把图标和 label 作为 .sheet-picker-item 的并列子元素 ——
                     那个容器是 `justify-content: space-between`，
                     并列三项会被摊到左 / 中 / 右，
                     文字飘到中间，看起来像居中（实测用户反馈就是这个）。
                     装进一个容器后只有两项可分：本容器 + 对勾，
                     于是「图标 + 文字」整组自然靠左、彼此紧贴 ——
                     与文献卡片的排法一致。

                  ⚠️ opt.swatch 不用装进来：它是**颜色预览**，语义上属于
                     「值」而不是「名称」，且只有字体颜色那几项用 ——
                     放左边会让人以为是分类图标。它保持独立子项。
                */
                var main = document.createElement('span');
                main.className = 'sheet-picker-main';

                /*
                  ⚠️ opt.icon 是可选的图标名（ICON_PATHS 里的键）。

                     用途：发表物类别那几个选项 —— 七个类别的名字
                     （Journal / Conference / Preprint…）光是文字，
                     用户得逐个读完才知道都是什么；配上图标后
                     一眼就能扫到要找的那个。

                     ⚠️ **必须**用 ScholariusUI.icon() 生成，
                        不能自己拼 <svg> —— 那六个图标是 960 体系
                        （viewBox `0 -960 960 960`），不是 24 体系。
                        在这里写死 24 会让图标一个像素都不渲染且不报错。
                        icon() 内部按 ICON_VIEWBOX 表取正确的视口。
                */
                if (opt.icon && typeof icon === 'function') {
                    var mark = document.createElement('span');
                    mark.className = 'sheet-picker-icon';
                    mark.setAttribute('aria-hidden', 'true');
                    mark.innerHTML = icon(opt.icon);
                    main.appendChild(mark);
                }

                main.appendChild(label);
                btn.appendChild(main);

                // 选中标记
                var mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                mark.setAttribute('class', 'sheet-picker-check');
                mark.setAttribute('viewBox', '0 0 24 24');
                mark.setAttribute('aria-hidden', 'true');
                var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                p.setAttribute('d', 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z');
                mark.appendChild(p);
                btn.appendChild(mark);

                btn.addEventListener('click', function () {
                    /*
                      ⚠️ 先关闭再回调。若反过来，回调里改了 DOM 导致
                         行位置变化，弹层的收起动画会从新位置开始，看起来闪一下。

                      ⚠️ 刷新右侧文字要用**这一行自己的** valueEl / config，
                         不能用模块级变量 —— 否则会写到别的行上去。
                    */
                    var valueEl = row[SHEET_PICKER_VALUE_EL];
                    closeSheetPicker();
                    if (typeof config.onChange === 'function') {
                        config.onChange(opt.value);
                    }
                    syncSheetPickerValue(valueEl, config);
                });

                li.appendChild(btn);
                listEl.appendChild(li);
            });
        }

        if (cancelEl) {
            cancelEl.onclick = closeSheetPicker;
        }

        openSheet(sheet, function () {
            /* 被任何其它途径关掉（返回键、被顶掉）都要清掉状态 */
            if (openSheetPickerRow && openSheetPickerRow.setAttribute) {
                openSheetPickerRow.setAttribute('aria-expanded', 'false');
            }
            openSheetPickerRow = null;
        });
    }

    function closeSheetPicker() {
        if (openSheetPickerRow && openSheetPickerRow.setAttribute) {
            openSheetPickerRow.setAttribute('aria-expanded', 'false');
        }
        openSheetPickerRow = null;
        closeSheet();
    }

    function syncSheetPickerValue(valueEl, config) {
        if (!valueEl || !config) return;
        var current = config.getValue();
        var match = null;
        config.getOptions().forEach(function (opt) {
            if (String(opt.value) === String(current)) match = opt;
        });
        valueEl.textContent = match ? match.label : '';
    }

    /** 有没有打开底部选项表单（供返回键查询） */
    function isSheetPickerOpen() {
        var sheet = document.getElementById('sheet-picker');
        return !!(sheet && !sheet.hidden);
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
                /*
                  ⚠️ 标记必须**自动过期**（见 justLongPressed 的说明）。
                     不能只靠"读一次清零"—— 浏览器在长按后**不一定**
                     补发 click（手指移过、或某些 WebView 不补），
                     那样标记会一直挂着，把**下一次真实点击吞掉**。
                     实测：长按设区间起点后，点终点毫无反应。
                */
                if (longPressExpiry) {
                    global.clearTimeout(longPressExpiry);
                }
                longPressExpiry = global.setTimeout(function () {
                    longPressExpiry = null;
                    longPressed = false;
                }, 1200);
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

    /**
     * 读一次就清零：只在长按后的那一次 click 里返回 true。
     *
     * ⚠️ 另有 1200ms 的**自动过期**兜底（见 attachLongPress）。
     *    只靠读一次清是不够的：长按后浏览器不一定补发 click，
     *    标记会一直 true，把用户下一次真实点击吞掉。
     */
    function justLongPressed() {
        var value = longPressed;
        longPressed = false;
        if (longPressExpiry) {
            global.clearTimeout(longPressExpiry);
            longPressExpiry = null;
        }
        return value;
    }

    /* ----------------------------------------------------------------------
       Google Material Icons
       ---------------------------------------------------------------------- */

    /*
      两套坐标系，别混用（详见 icon() 上方的说明）：
        ICONS_VIEWBOX    —— 24 体系，绝大多数图标
        SYMBOLS_VIEWBOX  —— 960 体系，Material Symbols 原生的那几个
    */
    var ICONS_VIEWBOX = '0 0 24 24';
    var SYMBOLS_VIEWBOX = '0 -960 960 960';

    var ICON_PATHS = {
        check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
        chevronRight: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
        refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
        logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
        info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
        copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
        openInNew: 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
        download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
        warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
        /*
          Material Icons: more_horiz（三个横点）
          ⚠️ 24 体系（不在下面的 ICON_VIEWBOX 例外表里）——
             这是 Material **Icons**，不是 Symbols。两者视口不同，
             搞混就是零像素渲染且不报错。
        */
        moreHoriz: 'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
        /* Material Icons: edit（铅笔，用于详情面板的「编辑」入口） */
        editPencil: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
        /* Material Icons: close */
        closeX: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',

        /*
          ⚠️ 这两条是 **Material Symbols（960 体系）**，默认那些是
             Material Icons（24 体系）—— viewBox 不同，已在
             ICON_VIEWBOX 里登记。别照抄上面几条的坐标风格。

          用途：阅读页顶栏切换「阅读视图 / 原始视图」，
              是一对「显示 / 隐藏」语义的开关图标（用户选定）：
                visibility      = 「把原始视图显示出来」
                visibility_off  = 「原始视图已显示，点它收起来」

          ⚠️ 取自官方，**不要手写**（手写 Material 路径出过三次事故）：
             tools/fetch_icon.py visibility
             tools/fetch_icon.py visibility_off
        */
        visibility: 'M480-320q75 0 127.5-52.5T660-500q0-75-52.5-127.5T480-680q-75 0-127.5 52.5T300-500q0 75 52.5 127.5T480-320Zm0-72q-45 0-76.5-31.5T372-500q0-45 31.5-76.5T480-608q45 0 76.5 31.5T588-500q0 45-31.5 76.5T480-392Zm0 192q-146 0-266-81.5T40-500q54-137 174-218.5T480-800q146 0 266 81.5T920-500q-54 137-174 218.5T480-200Zm0-300Zm0 220q113 0 207.5-59.5T832-500q-50-101-144.5-160.5T480-720q-113 0-207.5 59.5T128-500q50 101 144.5 160.5T480-280Z',
        visibilityOff: 'm644-428-58-58q9-47-27-88t-93-32l-58-58q17-8 34.5-12t37.5-4q75 0 127.5 52.5T660-500q0 20-4 37.5T644-428Zm128 126-58-56q38-29 67.5-63.5T832-500q-50-101-143.5-160.5T480-720q-29 0-57 4t-55 12l-62-62q41-17 84-25.5t90-8.5q151 0 269 83.5T920-500q-23 59-60.5 109.5T772-302Zm20 246L624-222q-35 11-70.5 16.5T480-200q-151 0-269-83.5T40-500q21-53 53-98.5t73-81.5L56-792l56-56 736 736-56 56ZM222-624q-29 26-53 57t-41 67q50 101 143.5 160.5T480-280q20 0 39-2.5t39-5.5l-36-38q-11 3-21 4.5t-21 1.5q-75 0-127.5-52.5T300-500q0-11 1.5-21t4.5-21l-84-82Zm319 93Zm-151 75Z',

        /*
          ══ 文献类型图标（v0.1.5）══

          用于文献卡片「发表载体」那一行的左侧，表示载体的**性质**。

          ⚠️⚠️ 这六条与 Vault 图标一样，是 **Material Symbols（960 体系）**，
                所以 viewBox 必须是 `0 -960 960 960`，**不是** `0 0 24 24`。
                写成 24 体系时图形会落在视口外，一个像素都不渲染。

          ⚠️ 路径**逐字**取自 Google Fonts 官方 CDN：
                https://fonts.gstatic.com/s/i/short-term/release/
                    materialsymbolsoutlined/<名字>/default/24px.svg
             这是 Google 官方分发的 SVG，与 google/material-design-icons
             仓库的 symbols/ 目录同源。**不要再凭记忆手写** ——
             本项目已因此出错三次（导航图标缺段 ×2、会议图标拼错 ×1）。

          ⚠️ 换版记录（避免后人改回去）：
             · 会议：`co_present`（拼错的）→ `groups`（太扁，填充率仅 0.46）
                     → **`display_group`**（用户指定）
             · 期刊：`menu_book` → **`import_contacts`**（用户指定，见下）
             · 预印本：`draft` → **`edit_document`**（用户指定）
        */

        /*
          ⚠️ 六条路径**全部**从官方 CDN 取，无一条手写。
             首次提交时 `school` 是凭记忆写的，取回官方版本一比就发现
             坐标完全不同（官方以 L40-600 起笔，我写的以 L80-560 起笔）——
             凭记忆的版本画出来是「扁平的梯形」，官方版是立体的学位帽。

             **判据**：Material Symbols 的路径普遍以「负 y 起笔、大片
             相对坐标、结尾带 `Z`」为特征；若一条路径短得出奇、或者
             坐标都是正数，几乎可以肯定是错的。
        */
        // Material Symbols: group（两个人，用户指定）
        /*
          ⚠️ 会议图标换过**四次**，完整轨迹（别再改回去）：

             ① `co_present` 凭记忆拼的 —— 形状完全不对，像画框。
             ② `groups`（三个人）—— 语义对，但设计框 24×11（宽扁），
                填充率仅 0.46，13px 下看着比别人小一半。
             ③ `display_group`（三人 + 外框 + 三个圆点）—— 尺寸合格
                （0.67），但线条太多，13px 下糊成一团。
             ④ **`group`（两个人，当前）** —— 用户指定，理由：
                「根据简单原则」。两个头 + 两个肩膀，是六类里最简洁的
                "人"意象。

          ⚠️ 判据（与预印本那次同源）：**13px 只能承载一个形体**。
             元素越少越清楚。`display_group` 有外框 + 三个人 + 三个圆点，
             `group` 只有两个头 + 两个肩 —— 后者在 13px 下明显更干净。

          ⚠️ 官方的 `group` 与 `groups` 是**两个不同的图标**，别混：
             · `group`  = 两个人（本图标）
             · `groups` = 三个人（更宽扁，设计框 24×11）
             名字只差一个 s，从 CDN 取的时候务必核对文件名。
        */
        venueConference: 'M40-160v-112q0-34 17.5-62.5T104-378q62-31 126-46.5T360-440q66 0 130 15.5T616-378q29 15 46.5 43.5T680-272v112H40Zm720 0v-120q0-44-24.5-84.5T666-434q51 6 96 20.5t84 35.5q36 20 55 44.5t19 53.5v120H760ZM247-527q-47-47-47-113t47-113q47-47 113-47t113 47q47 47 47 113t-47 113q-47 47-113 47t-113-47Zm466 0q-47 47-113 47-11 0-28-2.5t-28-5.5q27-32 41.5-71t14.5-81q0-42-14.5-81T544-792q14-5 28-6.5t28-1.5q66 0 113 47t47 113q0 66-47 113ZM120-240h480v-32q0-11-5.5-20T580-306q-54-27-109-40.5T360-360q-56 0-111 13.5T140-306q-9 5-14.5 14t-5.5 20v32Zm296.5-343.5Q440-607 440-640t-23.5-56.5Q393-720 360-720t-56.5 23.5Q280-673 280-640t23.5 56.5Q327-560 360-560t56.5-23.5ZM360-240Zm0-400Z',

        // Material Symbols: edit（一支铅笔，用户指定）
        /*
          ⚠️ 预印本原用 `edit_document`（文档 + 铅笔），但与「报告」的
             `description`（文档 + 折角）在 13px 下**轮廓几乎一样** ——
             两者都是一张竖纸，用户分不出来。

             换成 `edit`（只剩铅笔）。用户的原话：
             「因为比较小，所以不能复杂」。

          ⚠️ 这是个可推广的判据：13px 的图标**只能承载一个形体**。
             两个图标若共享主体形状（同为"纸"），差异点必须落在
             主体之外才看得出来（如 `school` 的帽子 vs `book` 的书脊）。
             整批图标排在一起看时，要先问「一眼扫过去会不会撞脸」。

          ⚠️ 代价：`edit` 的线条较多（一支笔 + 笔尖），在 13px 下笔尖
             会糊成一团。但整体轮廓是清晰的斜线，认得出「编辑/草稿」。
             比"和报告撞脸"好。
        */
        venuePreprint: 'M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z',

        // Material Symbols: import_contacts（翻开的书简版，期刊，用户指定）
        /*
          ⚠️ 期刊原本用 `menu_book`，现改为 `import_contacts`（用户指定）。

             两点区别：
               · `menu_book` 书页上有**三行文字**，视觉更密；
                 `import_contacts` 是**简版**（无文字线），在小尺寸下更干净。
               · Vault 标签改用 `menu_book`，所以期刊换掉后两者不再混淆。

          ⚠️ 两者是**同一套 960 体系**，viewBox 一致，可以直接替换。
        */
        venueJournal: 'M260-320q47 0 91.5 10.5T440-278v-394q-41-24-87-36t-93-12q-36 0-71.5 7T120-692v396q35-12 69.5-18t70.5-6Zm260 42q44-21 88.5-31.5T700-320q36 0 70.5 6t69.5 18v-396q-33-14-68.5-21t-71.5-7q-47 0-93 12t-87 36v394Zm-40 118q-48-38-104-59t-116-21q-42 0-82.5 11T100-198q-21 11-40.5-1T40-234v-482q0-11 5.5-21T62-752q46-24 96-36t102-12q58 0 113.5 15T480-740q51-30 106.5-45T700-800q52 0 102 12t96 36q11 5 16.5 15t5.5 21v482q0 23-19.5 35t-40.5 1q-37-20-77.5-31T700-240q-60 0-116 21t-104 59ZM280-494Z',

        // Material Symbols: book（带书签的合上的书，专著的通用意象）
        // ⚠️ 与导航栏 Vault 曾经用过的 `book` 是同一个图标 ——
        //    现在 Vault 换成 menu_book 了，所以不再重复。
        venueBook: 'M240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h480q33 0 56.5 23.5T800-800v640q0 33-23.5 56.5T720-80H240Zm0-80h480v-640h-80v280l-100-60-100 60v-280H240v640Zm0 0v-640 640Zm200-360 100-60 100 60-100-60-100 60Z',

        // Material Symbols: school（学位帽）
        venueThesis: 'M480-120 200-272v-240L40-600l440-240 440 240v320h-80v-276l-80 44v240L480-120Zm0-332 274-148-274-148-274 148 274 148Zm0 241 200-108v-151L480-360 280-470v151l200 108Zm0-241Zm0 90Zm0 0Z',

        // Material Symbols: description（文档）
        venueReport: 'M320-240h320v-80H320v80Zm0-160h320v-80H320v80ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z',

        /*
          ══ 阅读页 · PDF 视图的「标注」入口（v0.1.17）══

          Material Symbols: edit（一支铅笔）
          ⚠️ **960 体系**，viewBox `0 -960 960 960` —— 已在 ICON_VIEWBOX 登记。

          ⚠️ 与 `venuePreprint` 是**同一个图标**（那条也是 edit），
             但不复用：两者用途无关，将来任何一方要换图标时
             不复用才不会互相牵连。多一条路径的代价远小于
             「改 A 结果 B 变了」的排查成本。

          ⚠️ 也不能用上面 24 体系的 `editPencil` —— 两套坐标系不同，
             混用会零像素渲染且不报错（本项目已踩过）。
             那是详情面板的「编辑文献信息」，语义也不同。

          ⚠️ 路径逐字取自官方，**不要手写**：
             tools/fetch_icon.py edit
        */
        annotateEdit: 'M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z',

        /*
          Material Symbols: edit_off（铅笔 + 一道斜杠）—— 960 体系。

          ⚠️ 与 `annotateEdit` 是**一对**，用途与
             visibility / visibility_off 完全同构：

                edit_off  = 当前**不在**编辑模式（点它进入）
                edit      = 当前**在**编辑模式（点它退出）

             ⚠️ 用户 2026-09-24 明确：「默认应该处于 edit off 的状态，
                点击进入编辑模式，图标变成 edit」。
                所以**默认必须是 edit_off**，不要弄反。

             ⚠️ 与 visibility 那对同理：靠**切图标**表达状态，
                不要给按钮加点击特效 / 阴影 / 选中底色。
                见 styles.css 里 `.reader-annotate-btn` 对
                :active 与 [aria-pressed] 的覆盖。

          ⚠️ 逐字取自官方，**不要手写**：tools/fetch_icon.py edit_off
        */
        annotateEditOff: 'm622-453-56-56 82-82-57-57-82 82-56-56 195-195q12-12 26.5-17.5T705-840q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L622-453ZM200-200h57l195-195-28-29-29-28-195 195v57ZM792-56 509-338 290-120H120v-169l219-219L56-792l57-57 736 736-57 57Zm-32-648-56-56 56 56Zm-169 56 57 57-57-57ZM424-424l-29-28 57 57-28-29Z',

        /*
          ══ 标注类型图标（v0.1.17）══

          用在标注模式下的类型选择条上，一个类型一个图标。

          ⚠️ **全部 960 体系**（Material Symbols），已在 ICON_VIEWBOX 登记。
             不要照抄上面 24 体系那几条的坐标风格。

          ⚠️ 路径**逐字**取自 Google Fonts 官方 CDN，无一手写：
                 tools/fetch_icon.py <名字>

          ⚠️ `footnote` 这个图标名在 Material 体系里**不存在**
             （官方 CDN 返回 404）。脚注改用 `sticky_note_2`（带折角的小纸），
             语义最近且 13px 下轮廓清楚。
        */
        // formula：`functions`（Σ 求和号，数学）
        annoFormula: 'M240-160v-80l260-240-260-240v-80h480v120H431l215 200-215 200h289v120H240Z',        // table：`table_chart`（表格）
        annoTable: 'M760-120H200q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120ZM200-640h560v-120H200v120Zm100 80H200v360h100v-360Zm360 0v360h100v-360H660Zm-80 0H380v360h200v-360Z',
        /*
          ⚠️ 编辑模式的四类之一：「文本」。

             前三个（公式/表格/图片）都对应**手画矩形**；
             文本不同 —— 矩形框不住段落（标题居中、摘要两端对齐、
             正文有缩进），所以选「文本」时的操作是
             **选中文字 → 指定类型**，不是拖框。

             图标用 `text_fields`（两个大小 T），比 `subject`
             （四条等长横线，像列表）更明确是「文字」。
             ⚠️ 逐字取自官方：tools/fetch_icon.py text_fields
        */
        annoText: 'M280-160v-520H80v-120h520v120H400v520H280Zm360 0v-320H520v-120h360v120H760v320H640Z',
        // figure：`image`（相框 + 山）
        annoFigure: 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm40-80h480L570-480 450-320l-90-120-120 160Zm-40 80v-560 560Z',
        // title：`title`（一个带衬线的 T，正是标题的意象）
        annoTitle: 'M420-160v-520H200v-120h560v120H540v520H420Z',
        // author：`group`（两个人）—— 与文献类型里会议图标同一条，语义同源
        annoAuthor: 'M40-160v-112q0-34 17.5-62.5T104-378q62-31 126-46.5T360-440q66 0 130 15.5T616-378q29 15 46.5 43.5T680-272v112H40Zm720 0v-120q0-44-24.5-84.5T666-434q51 6 96 20.5t84 35.5q36 20 55 44.5t19 53.5v120H760ZM360-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47Zm400-160q0 66-47 113t-113 47q-11 0-28-2.5t-28-5.5q27-32 41.5-71t14.5-81q0-42-14.5-81T544-792q14-5 28-6.5t28-1.5q66 0 113 47t47 113ZM120-240h480v-32q0-11-5.5-20T580-306q-54-27-109-40.5T360-360q-56 0-111 13.5T140-306q-9 5-14.5 14t-5.5 20v32Zm240-320q33 0 56.5-23.5T440-640q0-33-23.5-56.5T360-720q-33 0-56.5 23.5T280-640q0 33 23.5 56.5T360-560Zm0 320Zm0-400Z',
        // abstract：`article`（一张带三行文字的纸）
        annoAbstract: 'M280-280h280v-80H280v80Zm0-160h400v-80H280v80Zm0-160h400v-80H280v80Zm-80 480q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z',
        // body：`notes`（三条长短不一的横线，正是一段话的样子）
        annoBody: 'M120-240v-80h480v80H120Zm0-200v-80h720v80H120Zm0-200v-80h720v80H120Z',
        // heading：`format_h1`（「H1」字样，直接就是层级标题的记号）
        annoHeading: 'M200-280v-400h80v160h160v-160h80v400h-80v-160H280v160h-80Zm480 0v-320h-80v-80h160v400h-80Z',
        // footnote：`sticky_note_2`（带折角的小纸）—— 见上面关于 footnote 不存在的说明
        annoFootnote: 'M200-200h360v-200h200v-360H200v560Zm0 80q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v400L600-120H200Zm80-280v-80h200v80H280Zm0-160v-80h400v80H280Zm-80 360v-560 560Z',
        // reference：`menu_book`（翻开的书）
        annoReference: 'M560-564v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-600q-38 0-73 9.5T560-564Zm0 220v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-380q-38 0-73 9t-67 27Zm0-110v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-490q-38 0-73 9.5T560-454ZM260-320q47 0 91.5 10.5T440-278v-394q-41-24-87-36t-93-12q-36 0-71.5 7T120-692v396q35-12 69.5-18t70.5-6Zm260 42q44-21 88.5-31.5T700-320q36 0 70.5 6t69.5 18v-396q-33-14-68.5-21t-71.5-7q-47 0-93 12t-87 36v394Zm-40 118q-48-38-104-59t-116-21q-42 0-82.5 11T100-198q-21 11-40.5-1T40-234v-482q0-11 5.5-21T62-752q46-24 96-36t102-12q58 0 113.5 15T480-740q51-30 106.5-45T700-800q52 0 102 12t96 36q11 5 16.5 15t5.5 21v482q0 23-19.5 35t-40.5 1q-37-20-77.5-31T700-240q-60 0-116 21t-104 59ZM280-494Z',
        // keyword：`sell`（价签 / 吊牌）
        annoKeyword: 'M856-390 570-104q-12 12-27 18t-30 6q-15 0-30-6t-27-18L103-457q-11-11-17-25.5T80-513v-287q0-33 23.5-56.5T160-880h287q16 0 31 6.5t26 17.5l352 353q12 12 17.5 27t5.5 30q0 15-5.5 29.5T856-390ZM513-160l286-286-353-354H160v286l353 354ZM260-640q25 0 42.5-17.5T320-700q0-25-17.5-42.5T260-760q-25 0-42.5 17.5T200-700q0 25 17.5 42.5T260-640Zm220 160Z',
        /*
          clear：`delete_sweep`（一个废纸篓 + 几条待清的横线）

          ⚠️ 用于底部编辑栏的「清空」项（用户 2026-09-25 要求）。
             「清空某一类」要表达的是"这里有一堆要整批清掉的东西"，
             delete_sweep 正好是这个意象；普通的 delete（垃圾桶）
             看起来像"删掉这一个"，与"整类清空"不符。

          ⚠️ 逐字取自官方：tools/fetch_icon.py delete_sweep
        */
        annoClear: 'M600-240v-80h160v80H600Zm0-320v-80h280v80H600Zm0 160v-80h240v80H600ZM120-640H80v-80h160v-60h160v60h160v80h-40v360q0 33-23.5 56.5T440-200H200q-33 0-56.5-23.5T120-280v-360Zm80 0v360h240v-360H200Zm0 0v360-360Z',

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

    /*
      ══ 填充版路径（选中态用）══

      ⚠️⚠️ Material Symbols 的 outlined 与 filled 是**两套不同的路径数据**，
          不是同一条路径换填充规则。本项目实测 12 个标注图标里
          **6 个确实不同**（table_chart / image / group / article /
          sticky_note_2 / menu_book / sell），另 6 个官方两态相同。

      所以选中态**必须用两个独立的 <svg>** 切换显示
      （与底部导航栏 .nav-item 的做法完全一致，见 index.html 与 styles.css）。

      ⚠️ 这里只登记**与轮廓版不同**的那些。查不到就退回 ICON_PATHS ——
         官方两态相同时（如 text_fields）本来就该一样。

      ⚠️ 全部来自 Google Fonts 官方 CDN，**不许手写**：
         三次手写 Material 路径都出了错（少一段就认不出形状）。
         抓取脚本见 tools/fetch_icon.py。
    */
    var ICON_PATHS_FILL = {
        // table_chart, filled
        annoTable: 'M120-640v-120q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v120H120Zm80 520q-33 0-56.5-23.5T120-200v-360h180v440H200Zm460 0v-440h180v360q0 33-23.5 56.5T760-120H660Zm-280 0v-440h200v440H380Z',
        // image, filled
        annoFigure: 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm40-160h480L570-480 450-320l-90-120-120 160Z',
        // group, filled
        annoAuthor: 'M40-160v-112q0-34 17.5-62.5T104-378q62-31 126-46.5T360-440q66 0 130 15.5T616-378q29 15 46.5 43.5T680-272v112H40Zm720 0v-120q0-44-24.5-84.5T666-434q51 6 96 20.5t84 35.5q36 20 55 44.5t19 53.5v120H760ZM247-527q-47-47-47-113t47-113q47-47 113-47t113 47q47 47 47 113t-47 113q-47 47-113 47t-113-47Zm466 0q-47 47-113 47-11 0-28-2.5t-28-5.5q27-32 41.5-71t14.5-81q0-42-14.5-81T544-792q14-5 28-6.5t28-1.5q66 0 113 47t47 113q0 66-47 113Z',
        // article, filled
        annoAbstract: 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm80-160h280v-80H280v80Zm0-160h400v-80H280v80Zm0-160h400v-80H280v80Z',
        // sticky_note_2, filled
        annoFootnote: 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v400L600-120H200Zm360-80 200-200H560v200ZM280-400h200v-80H280v80Zm0-160h400v-80H280v80Z',
        // menu_book, filled
        annoReference: 'M560-564v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-600q-38 0-73 9.5T560-564Zm0 220v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-380q-38 0-73 9t-67 27Zm0-110v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-490q-38 0-73 9.5T560-454ZM220-80q-24 0-42-18t-18-42v-482q0-11 5.5-21T182-658q56-17 114-25.5t124-8.5q45 0 88 8.5t84 25.5v470q30-13 62-19.5t66-6.5q36 0 70.5 6t69.5 18v-480q-23-10-46.5-16t-48.5-9v-81q25 4 49 10t47 15q11 5 16.5 15t5.5 21v482q0 23-19.5 35t-40.5 1q-37-20-77.5-31T700-240q-60 0-116 21t-104 59v-514q-41-24-87-36t-93-12q-36 0-71.5 7T160-692v514Z',
    };

    /** 取填充版路径；没有登记就退回轮廓版（官方两态相同的那些就该一样） */
    function iconPathFilled(name) {
        return ICON_PATHS_FILL[name] || ICON_PATHS[name];
    }

    /*
      ⚠️⚠️ viewBox 必须**按图标逐个注册**，不能一律用 0 0 24 24。

      本项目同时存在**两套**互不兼容的 Material 图标坐标系：

        · Material Symbols  →  viewBox `0 -960 960 960`
          路径坐标全在 x∈[0,960]、y∈[-960,0] 之间。
        · Material Icons    →  viewBox `0 0 24 24`
          路径坐标全在 0~24 之间。

      把 960 体系的路径塞进 `0 0 24 24` 的视口，图形**完全落在视口外**
      —— 结果是「图标位置一片空白」，且**不报任何错**，很难查。
      反过来把 24 体系的路径塞进 960 视口，则缩成左上角一个小点。

      所以每个图标的 viewBox 必须跟着它自己的路径走。
      默认 24（兼容既有图标），在下面的表里登记例外。
    */
    var ICON_VIEWBOX = {
        // 960 体系（Material Symbols）—— 见 ICON_PATHS 里同名的注释
        venueConference: SYMBOLS_VIEWBOX,
        venueJournal: SYMBOLS_VIEWBOX,
        venuePreprint: SYMBOLS_VIEWBOX,
        venueBook: SYMBOLS_VIEWBOX,
        venueThesis: SYMBOLS_VIEWBOX,
        venueReport: SYMBOLS_VIEWBOX,
        visibility: SYMBOLS_VIEWBOX,
        visibilityOff: SYMBOLS_VIEWBOX,
        // 阅读页的「标注」入口，同样是 960 体系（见 ICON_PATHS 里的说明）
        annotateEdit: SYMBOLS_VIEWBOX,
        annotateEditOff: SYMBOLS_VIEWBOX,
        // 标注类型图标——十二条全部 960 体系，见 ICON_PATHS 里的分组说明
        annoText: SYMBOLS_VIEWBOX,
        annoFormula: SYMBOLS_VIEWBOX,
        annoTable: SYMBOLS_VIEWBOX,
        annoFigure: SYMBOLS_VIEWBOX,
        annoTitle: SYMBOLS_VIEWBOX,
        annoAuthor: SYMBOLS_VIEWBOX,
        annoAbstract: SYMBOLS_VIEWBOX,
        annoBody: SYMBOLS_VIEWBOX,
        annoHeading: SYMBOLS_VIEWBOX,
        annoFootnote: SYMBOLS_VIEWBOX,
        annoReference: SYMBOLS_VIEWBOX,
        annoKeyword: SYMBOLS_VIEWBOX,
        // 「清空某一类」——见 ICON_PATHS 里的说明
        annoClear: SYMBOLS_VIEWBOX
    };

    /** 返回一段 svg 标记，图标全部来自 Google Material 体系 */
    function icon(name) {
        var path = ICON_PATHS[name];
        if (!path) {
            return '';
        }
        var box = ICON_VIEWBOX[name] || ICONS_VIEWBOX;
        return '<svg viewBox="' + box + '" aria-hidden="true" focusable="false">' +
            '<path d="' + path + '"/></svg>';
    }

    /**
     * 返回**填充版** svg 标记（选中态用）。
     *
     * ⚠️ 调用方必须**同时**放轮廓版与填充版两个 <svg>，
     *    再用 CSS 按选中态切 display —— 不能只换 fill 规则。
     *    理由见 ICON_PATHS_FILL 的说明。
     */
    function iconFilled(name) {
        var path = iconPathFilled(name);
        if (!path) {
            return '';
        }
        var box = ICON_VIEWBOX[name] || ICONS_VIEWBOX;
        return '<svg viewBox="' + box + '" aria-hidden="true" focusable="false">' +
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
        createRowSheetPicker: createRowSheetPicker,
        hasOpenRowMenu: hasOpenRowMenu,
        closeRowMenu: closeRowMenu,
        isSheetPickerOpen: isSheetPickerOpen,
        closeSheetPicker: closeSheetPicker,
        attachLongPress: attachLongPress,
        justLongPressed: justLongPressed,
        icon: icon,
        iconFilled: iconFilled,
        githubMark: githubMark,
        ICON_PATHS: ICON_PATHS
    };
})(window);
