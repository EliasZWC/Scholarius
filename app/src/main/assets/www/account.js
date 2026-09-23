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

    var setters = {};

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
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

    function mountActions() {
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
    function setAccount(login, name, avatarUrl) {
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
            if (avatarUrl) {
                // 用 <img> 而不是背景图：加载失败时能显示 alt 占位
                avatarEl.innerHTML = '';
                var img = document.createElement('img');
                img.src = avatarUrl;
                img.alt = '';
                img.referrerPolicy = 'no-referrer';
                avatarEl.appendChild(img);
            } else {
                avatarEl.textContent = (login || '?').charAt(0).toUpperCase();
            }
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
        refresh: refresh
    };
})(window);
