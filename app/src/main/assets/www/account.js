/**
 * Scholarius - 个人页。
 *
 * 两块内容：
 *   ① 账户信息（头像 / 名字 / @handle）—— 由原生推过来，token 不下发到网页
 *   ② 设置项：Language / Theme / Version / Contact / Sign out
 *
 * 设置项按 Livolog 的做法：每项都是「左名称 / 右当前值」行，
 * 点整行弹出选项（ScholariusUI.createRowPicker）。
 *
 * ⚠️ 有意排除 Livolog 的三个**数据项**（存储位置 / 导入数据 / 导出数据）
 *    —— 用户 2026-09-23 明确要求。
 */
(function (global) {
    'use strict';

    var CONTACT_EMAIL = 'eliaschang@163.com';

    var versionName = '';
    var versionCode = 0;

    /** 当前账号的展示信息（原生推过来；token 不跨层，这里没有） */
    var currentLogin = '';
    var currentAvatar = '';
    var currentId = 0;
    /** 显示名（GitHub 的 name，可能与 login 不同） */
    var displayName = '';

    var setters = {};

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    /** 调试日志当前是否开启（读取权在 app.js，这里只问它） */
    function debugLogOn() {
        return !!(global.ScholariusShell &&
            typeof global.ScholariusShell.isDebugLogEnabled === 'function' &&
            global.ScholariusShell.isDebugLogEnabled());
    }

    function init() {
        buildPickers();
        mountActions();

        if (global.ScholariusTheme) {
            global.ScholariusTheme.onChange(refresh);
        }
        if (global.ScholariusI18n && global.ScholariusI18n.onChange) {
            global.ScholariusI18n.onChange(refresh);
        }
    }

    // --- 设置项 -------------------------------------------------------------

    function buildPickers() {
        if (!global.ScholariusUI) {
            return;
        }

        var ui = global.ScholariusUI;

        var languageRow = document.getElementById('setting-language');
        var languageValue = document.getElementById('setting-language-value');
        if (languageRow && languageValue) {
            setters.language = ui.createRowPicker(languageRow, languageValue, {
                getOptions: function () {
                    return [
                        { value: 'en', label: t('setting.language.en') },
                        { value: 'zh', label: t('setting.language.zh') }
                    ];
                },
                getValue: function () {
                    return global.ScholariusI18n ? global.ScholariusI18n.getLocale() : 'en';
                },
                onChange: function (value) {
                    if (global.ScholariusI18n) {
                        global.ScholariusI18n.setLocale(value);
                    }
                    refresh();
                }
            });
        }

        var themeRow = document.getElementById('setting-theme');
        var themeValue = document.getElementById('setting-theme-value');
        if (themeRow && themeValue) {
            setters.theme = ui.createRowPicker(themeRow, themeValue, {
                getOptions: function () {
                    return [
                        { value: 'light', label: t('setting.theme.light') },
                        { value: 'dark', label: t('setting.theme.dark') },
                        { value: 'system', label: t('setting.theme.system') }
                    ];
                },
                getValue: function () {
                    return global.ScholariusTheme ? global.ScholariusTheme.getMode() : 'system';
                },
                onChange: function (value) {
                    if (global.ScholariusTheme) {
                        global.ScholariusTheme.setMode(value);
                    }
                    refresh();
                }
            });
        }

        var contactValue = document.getElementById('setting-contact-value');
        if (contactValue) {
            contactValue.textContent = CONTACT_EMAIL;
        }

        /*
          调试日志开关。
          用 row picker 而不是 switch —— 与 Language / Theme 的交互一致，
          用户不用为一个开关记两种手感。
          ⚠️ 开启后**不立即显示浮层**：浮层要等下一次 trace() 才创建。
             为避免「开了却什么都没看到」的疑惑，这里切完弹一个 toast 说明。
        */
        var debugRow = document.getElementById('setting-debug');
        var debugValue = document.getElementById('setting-debug-value');
        if (debugRow && debugValue) {
            setters.debug = ui.createRowPicker(debugRow, debugValue, {
                getOptions: function () {
                    return [
                        { value: 'on', label: t('setting.debugLog.on') },
                        { value: 'off', label: t('setting.debugLog.off') }
                    ];
                },
                getValue: function () {
                    return debugLogOn() ? 'on' : 'off';
                },
                onChange: function (value) {
                    var on = value === 'on';
                    if (global.ScholariusShell &&
                        typeof global.ScholariusShell.setDebugLogEnabled === 'function') {
                        global.ScholariusShell.setDebugLogEnabled(on);
                    }
                    if (global.ScholariusUI) {
                        global.ScholariusUI.toast(
                            on ? t('setting.debugLog.restartHint') : t('setting.debugLog.off')
                        );
                    }
                    refresh();
                }
            });
        }

        var contactRow = document.getElementById('setting-contact');
        if (contactRow) {
            contactRow.addEventListener('click', function () {
                if (global.ScholariusNative &&
                    typeof global.ScholariusNative.openExternal === 'function') {
                    global.ScholariusNative.openExternal('mailto:' + CONTACT_EMAIL);
                }
            });
        }
    }

    /**
     * 账户详情页的开合入口。
     * 由 mountAccountDetail() 填充；导出给外部调用。
     */
    var detailController = {
        open: function () { },
        close: function () { }
    };

    /**
     * 账户卡片 → 账户详情页（全屏覆盖层，照搬 Livolog 的 .detail 交互）。
     *
     * ⚠️ 用 `hidden` + `is-open` 两段式，而不是只切 class：
     *    hidden 控制是否参与布局，is-open 控制位移动画。
     *    只切 class 的话元素还在文档流里、且没 hidden，
     *    首屏就会有一层透明的覆盖层盖住内容（点击全被它吃掉）。
     */
    function mountAccountDetail() {
        var card = document.getElementById('account-card');
        var panel = document.getElementById('account-detail');
        var backBtn = document.getElementById('account-detail-back');
        var openBtn = document.getElementById('account-detail-open');

        if (!card || !panel) {
            return;
        }

        function open() {
            panel.hidden = false;
            // 先让浏览器算一次布局，再加 is-open，否则 transition 不触发
            if (panel.offsetWidth < 0) return;
            panel.classList.add('is-open');
        }

        function close() {
            panel.classList.remove('is-open');
            /*
              等滑出动画跑完再 hidden，否则会「啪」地消失。
              280ms 与 .detail 的 transition 时长一致。
            */
            global.setTimeout(function () {
                if (!panel.classList.contains('is-open')) {
                    panel.hidden = true;
                }
            }, 280);
        }

        card.addEventListener('click', open);
        // 键盘可达（卡片是 role="button" tabindex="0"）
        card.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
            }
        });

        if (backBtn) {
            backBtn.addEventListener('click', close);
        }

        if (openBtn) {
            openBtn.addEventListener('click', function () {
                if (currentLogin &&
                    global.ScholariusNative &&
                    typeof global.ScholariusNative.openExternal === 'function') {
                    // 只开公开主页，不带任何凭据
                    global.ScholariusNative.openExternal(
                        'https://github.com/' + encodeURIComponent(currentLogin)
                    );
                }
            });
        }

        // 暴露给外部（例如以后从别处也要打开账户页）
        detailController.open = open;
        detailController.close = close;
    }

    function mountActions() {
        // 账户卡片：进入账户详情页
        mountAccountDetail();

        // 版本行：点一下手动检查更新
        var versionRow = document.getElementById('setting-version');
        if (versionRow) {
            versionRow.addEventListener('click', function () {
                if (global.ScholariusUI) {
                    global.ScholariusUI.toast(t('update.checking'));
                }
                if (global.ScholariusNative &&
                    typeof global.ScholariusNative.checkUpdate === 'function') {
                    global.ScholariusNative.checkUpdate();
                }
            });
        }

        // 退出登录：先弹二次确认，避免误触
        var signOutRow = document.getElementById('setting-signout');
        var sheet = document.getElementById('sheet-signout');
        var signOutCancel = document.getElementById('signout-cancel');
        var signOutConfirm = document.getElementById('signout-confirm');

        if (signOutRow && sheet && global.ScholariusUI) {
            signOutRow.addEventListener('click', function () {
                global.ScholariusUI.openSheet(sheet);
            });
        }
        if (signOutCancel && global.ScholariusUI) {
            signOutCancel.addEventListener('click', function () {
                global.ScholariusUI.closeSheet();
            });
        }
        if (signOutConfirm && global.ScholariusUI) {
            signOutConfirm.addEventListener('click', function () {
                global.ScholariusUI.closeSheet();
                if (global.ScholariusNative &&
                    typeof global.ScholariusNative.signOut === 'function') {
                    global.ScholariusNative.signOut();
                }
            });
        }
    }

    // --- 账户信息 -----------------------------------------------------------

    /**
     * 由 login.js 在登录状态变化时调用。
     * 注意：**没有 token 参数** —— token 不跨层到网页。
     */
    function setAccount(login, name, avatarUrl, accountId) {
        currentLogin = login || '';
        currentAvatar = avatarUrl || '';
        currentId = Number(accountId) || 0;
        displayName = name || login || '';

        var avatarEl = document.getElementById('account-avatar');
        var nameEl = document.getElementById('account-name');
        var handleEl = document.getElementById('account-handle');

        if (nameEl) {
            nameEl.removeAttribute('data-i18n');
            nameEl.textContent = name || login || '';
            // 记下来：i18n.apply() 会无差别覆写，refresh 时要把它写回来
            nameEl.dataset.accountName = name || login || '';
        }
        if (handleEl) {
            handleEl.textContent = login ? '@' + login : '';
            handleEl.hidden = !login;
        }
        if (avatarEl) {
            renderAvatar(avatarEl, avatarUrl, login, 1);
        }

        renderDetail();
    }

    /**
     * 渲染一个头像容器。
     *
     * @param container 目标元素
     * @param avatarUrl 头像地址，空则退回首字母
     * @param login     用来取首字母
     * @param scale     字号系数（列表里 48px 头像用 1，详情页 96px 用 1.8）
     */
    function renderAvatar(container, avatarUrl, login, scale) {
        if (avatarUrl) {
            // 用 <img> 而不是背景图：加载失败时能显示 alt 占位
            container.innerHTML = '';
            var img = document.createElement('img');
            img.src = avatarUrl;
            img.alt = '';
            img.referrerPolicy = 'no-referrer';
            container.appendChild(img);
            return;
        }
        container.textContent = (login || '?').charAt(0).toUpperCase();
        container.style.fontSize = scale > 1 ? '36px' : '';
    }

    /** 把当前账号信息填进账户详情页 */
    function renderDetail() {
        var nameEl = document.getElementById('account-detail-name');
        var handleEl = document.getElementById('account-detail-handle');
        var loginEl = document.getElementById('account-detail-login');
        var displayEl = document.getElementById('account-detail-display');
        var idEl = document.getElementById('account-detail-id');
        var avatarEl = document.getElementById('account-detail-avatar');

        if (nameEl) {
            nameEl.textContent = currentLogin || '—';
        }
        if (handleEl) {
            handleEl.textContent = currentLogin ? '@' + currentLogin : '';
            handleEl.hidden = !currentLogin;
        }
        if (loginEl) {
            loginEl.textContent = currentLogin || '—';
        }
        if (displayEl) {
            displayEl.textContent = displayName || currentLogin || '—';
        }
        if (idEl) {
            /*
              账号 ID 不展示 0 —— 那是「读取失败」的哨兵值，不是真 ID。
              另外用 tabular-nums 让数字等宽，比列右对齐时更整齐。
            */
            idEl.textContent = currentId > 0 ? String(currentId) : '—';
        }
        if (avatarEl) {
            renderAvatar(avatarEl, currentAvatar, currentLogin, 1.8);
        }
    }

    function setVersion(name, code) {
        versionName = name || '';
        versionCode = code || 0;
        refresh();
    }

    function refresh() {
        var versionValue = document.getElementById('setting-version-value');
        if (versionValue) {
            versionValue.textContent = versionName;
        }

        Object.keys(setters).forEach(function (key) {
            if (setters[key] && setters[key].refresh) {
                setters[key].refresh();
            }
        });

        if (global.ScholariusI18n) {
            global.ScholariusI18n.apply();
            // data-i18n 会把账户名覆盖掉，重新写一遍
            reapplyAccountName();
        }

        // 详情页里的值不在 data-i18n 词条里，i18n.apply() 不会碰它们；
        // 但名字/ID 是运行时数据，这里重绘一次保证与 currentXxx 一致
        renderDetail();
    }

    /** i18n.apply() 是无差别覆写，账户名不在词条里，要单独恢复 */
    function reapplyAccountName() {
        var nameEl = document.getElementById('account-name');
        if (nameEl && nameEl.dataset.accountName) {
            nameEl.textContent = nameEl.dataset.accountName;
        }
    }

    global.ScholariusAccount = {
        init: init,
        setAccount: setAccount,
        setVersion: setVersion,
        refresh: refresh,
        openDetail: function () { detailController.open(); },
        closeDetail: function () { detailController.close(); }
    };
})(window);
