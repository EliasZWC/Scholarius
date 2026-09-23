/**
 * Scholarius - 应用外壳逻辑。
 *
 * 负责三件事：
 *   ① 底部导航切换、顶部标题同步
 *   ② 启动动画的收尾
 *   ③ **登录门控**：splash 演完之后，按登录状态决定进哪个界面
 *      （用户 2026-09-23 裁决：强制登录，不登录进不去应用）
 *
 * 同时定义 window.ScholariusShell —— 原生 → 网页的唯一入口。
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'scholarius.activeTab';
    var DEFAULT_TAB = 'library';
    var TAB_ORDER = ['library', 'ranking', 'profile'];

    var tabs = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));
    var titleEl = document.getElementById('page-title');
    var appEl = document.getElementById('app');
    var pages = {};
    TAB_ORDER.forEach(function (name) {
        pages[name] = document.getElementById('page-' + name);
    });

    var currentTab = null;
    /** 原生推过来的登录状态；null 表示还没收到 */
    var signedIn = null;
    var splashDone = false;

    /* ----------------------------------------------------------------------
       原生 → 网页 的入口。
       必须挂在 window 上，且要在页面加载的瞬间就存在
       （onPageFinished 可能早于我们下面的初始化）。
       原生侧永远带 `window.ScholariusShell &&` 前缀，缺函数不会抛错。
       ---------------------------------------------------------------------- */
    var rootEl = document.documentElement;

    function setInsets(top, right, bottom, left, keyboard) {
        // 原生推的是 dp 数值，这里当 px 用；15px 基准下 1dp≈1px，视觉一致
        rootEl.style.setProperty('--safe-top', (top || 0) + 'px');
        rootEl.style.setProperty('--safe-right', (right || 0) + 'px');
        rootEl.style.setProperty('--safe-bottom', (bottom || 0) + 'px');
        rootEl.style.setProperty('--safe-left', (left || 0) + 'px');
        rootEl.style.setProperty('--keyboard', (keyboard || 0) + 'px');
    }

    function setVersion(name, code) {
        rootEl.setAttribute('data-app-version', (name || '') + '+' + (code || ''));
        if (window.ScholariusAccount) {
            window.ScholariusAccount.setVersion(name, code);
        } else {
            // account.js 还没就绪就先存着，init 时补发
            window.SCHOLARIUS_VERSION_NAME = name;
            window.SCHOLARIUS_VERSION_CODE = code;
        }
    }

    function setThemeMode(mode) {
        if (window.ScholariusTheme) {
            window.ScholariusTheme.applyFromNative(mode);
        }
    }

    /** 登录状态变化：这是「进哪个界面」的唯一判据 */
    function setAccount(isSignedIn, login, name, avatarUrl) {
        signedIn = !!isSignedIn;

        if (window.ScholariusLogin) {
            window.ScholariusLogin.setAccount(isSignedIn, login, name, avatarUrl);
        }

        applyGate();
    }

    function onLoginCode(userCode, verificationUri, expiresIn) {
        if (window.ScholariusLogin) {
            window.ScholariusLogin.onCode(userCode, verificationUri, expiresIn);
        }
    }

    function onLoginWaiting(waited) {
        if (window.ScholariusLogin) {
            window.ScholariusLogin.onWaiting(waited);
        }
    }

    function onLoginFailed(reason) {
        if (window.ScholariusLogin) {
            window.ScholariusLogin.onFailed(reason);
        }
    }

    // --- 更新（转发给 update.js）--------------------------------------------

    function onUpdateAvailable(version, current, size, stalled) {
        if (window.ScholariusUpdate) {
            window.ScholariusUpdate.onAvailable(version, current, size, stalled);
        }
    }

    function onUpdateNone() {
        if (window.ScholariusUpdate) {
            window.ScholariusUpdate.onNone();
        }
    }

    function onUpdateProgress(percent) {
        if (window.ScholariusUpdate) {
            window.ScholariusUpdate.onProgress(percent);
        }
    }

    function onUpdateReady() {
        if (window.ScholariusUpdate) {
            window.ScholariusUpdate.onReady();
        }
    }

    function onUpdateFailed(reason, downloaded) {
        if (window.ScholariusUpdate) {
            window.ScholariusUpdate.onFailed(reason, downloaded);
        }
    }

    window.ScholariusShell = {
        setInsets: setInsets,
        setVersion: setVersion,
        setThemeMode: setThemeMode,
        setAccount: setAccount,
        onLoginCode: onLoginCode,
        onLoginWaiting: onLoginWaiting,
        onLoginFailed: onLoginFailed,
        onUpdateAvailable: onUpdateAvailable,
        onUpdateNone: onUpdateNone,
        onUpdateProgress: onUpdateProgress,
        onUpdateReady: onUpdateReady,
        onUpdateFailed: onUpdateFailed
    };

    /* ----------------------------------------------------------------------
       导航
       ---------------------------------------------------------------------- */

    function selectTab(name) {
        if (!pages[name]) {
            name = DEFAULT_TAB;
        }

        tabs.forEach(function (tab) {
            var active = tab.dataset.page === name;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        });

        TAB_ORDER.forEach(function (key) {
            if (pages[key]) {
                pages[key].hidden = key !== name;
            }
        });

        if (titleEl) {
            // 标题文案复用导航词条，切语言时也能一起更新
            titleEl.setAttribute('data-i18n', 'nav.' + name);
            titleEl.textContent = window.ScholariusI18n
                ? window.ScholariusI18n.t('nav.' + name)
                : name;
        }

        currentTab = name;

        try {
            localStorage.setItem(STORAGE_KEY, name);
        } catch (e) {
            /* 隐私模式下忽略 */
        }
    }

    /**
     * 登录门控：splash 结束 + 拿到登录状态之后才放行。
     *
     * 未登录 → 只显示登录页，应用外壳整个藏起来。
     *          用 hidden 而不是盖遮罩 —— 藏起来才不会被别的路径绕进去。
     * 已登录 → 显示应用外壳。
     */
    function applyGate() {
        // 登录状态还没到、或 splash 还在演：都先不动，避免闪一下登录页
        if (signedIn === null || !splashDone) {
            return;
        }

        var loggedIn = signedIn;

        if (appEl) {
            appEl.hidden = !loggedIn;
        }
        if (loggedIn && currentTab === null) {
            selectTab(readInitialTab());
        }
    }

    function readInitialTab() {
        try {
            return localStorage.getItem(STORAGE_KEY) || DEFAULT_TAB;
        } catch (e) {
            return DEFAULT_TAB;
        }
    }

    /* ----------------------------------------------------------------------
       初始化
       ---------------------------------------------------------------------- */

    function init() {
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                selectTab(tab.dataset.page);
            });
        });

        if (window.ScholariusTheme) {
            window.ScholariusTheme.init();
        }
        if (window.ScholariusI18n) {
            window.ScholariusI18n.apply();
        }
        if (window.ScholariusLogin) {
            window.ScholariusLogin.init();
        }
        if (window.ScholariusUpdate) {
            window.ScholariusUpdate.init();
        }
        if (window.ScholariusAccount) {
            window.ScholariusAccount.init();
            // 补上 setVersion 早于 account.js 就绪的情况
            if (window.SCHOLARIUS_VERSION_NAME !== undefined) {
                window.ScholariusAccount.setVersion(
                    window.SCHOLARIUS_VERSION_NAME,
                    window.SCHOLARIUS_VERSION_CODE
                );
            }
        }

        selectTab(readInitialTab());

        // 未登录时先把应用藏起来，避免登录页闪一下又切走
        if (appEl) {
            appEl.hidden = true;
        }

        setupSplash();

        // 禁止双指缩放 / 长按放大镜造成的页面抖动
        document.addEventListener('gesturestart', function (event) {
            event.preventDefault();
        });
    }

    /**
     * 启动动画由 CSS 自己播完（见 styles.css 的 .splash）：
     *   1) 播完通知原生，把窗口底色与系统栏图标切回正常主题；
     *   2) 把元素从文档树里摘掉，别留着挡住无障碍树；
     *   3) 触发登录门控 —— splash 演完才决定进哪个界面。
     */
    function setupSplash() {
        var splash = document.getElementById('splash');
        if (!splash) {
            splashDone = true;
            applyGate();
            return;
        }

        var closeSplash = function () {
            if (splash.hidden) {
                return;
            }
            splash.hidden = true;
            splashDone = true;

            try {
                if (window.ScholariusNative &&
                    typeof window.ScholariusNative.finishSplash === 'function') {
                    window.ScholariusNative.finishSplash();
                }
            } catch (e) {
                /* 浏览器预览环境，忽略 */
            }

            applyGate();
        };

        splash.addEventListener('animationend', function (event) {
            if (event.target === splash) {
                closeSplash();
            }
        });

        // 兜底：万一动画事件没来（比如用户系统里把动画整个关掉了）
        window.setTimeout(closeSplash, 3000);
    }

    // 暴露给后续功能扩展使用
    window.Scholarius = {
        selectTab: selectTab,
        TAB_ORDER: TAB_ORDER,
        isSignedIn: function () {
            return signedIn === true;
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
