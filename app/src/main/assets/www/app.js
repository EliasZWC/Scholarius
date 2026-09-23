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

    /**
     * 启动动画的兜底超时。
     *
     * ⚠️ 必须**大于** styles.css 里 .splash 的动画时长（2600ms），
     *    否则会抢在 animationend 之前把启动页收掉 —— 表现就是「一闪而过」。
     *    留 1s 余量，覆盖低端机首帧延迟。
     */
    var SPLASH_FALLBACK_MS = 3600;

    /**
     * 启动页最短可见时长。
     *
     * ⚠️ 这是「一闪而过」的兜底保险。
     *    样式表在 WebView 里是异步加载的：若脚本执行时 styles.css 还没生效，
     *    .splash 上根本没有 animation，animationDuration 会是 0s，
     *    于是 animationend 会**立即**触发，启动页瞬间被收掉。
     *
     *    ⚠️ 必须**小于**真实动画时长（2600ms）且留出余量，
     *       否则会抢在正常 animationend 之前收掉启动页 ——
     *       那反而会把完整的动画腰断。取 2400ms。
     */
    var SPLASH_MIN_VISIBLE_MS = 2400;


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
    /** 启动动画是否已播完 */
    var splashDone = false;
    /** 启动页开始显示的时刻（用于最短可见时长判定），见 setupSplash() */
    var splashStartedAt = 0;
    /** 是否已为「过早的 animationend」排过一次延后收尾，避免重复排 */
    var splashRetryScheduled = false;
    /** 是否需要退场（动画播完 && 登录状态已知，两个条件都满足才退） */
    var pendingDismiss = false;

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
        trace('account', 'signedIn=' + signedIn +
            ' splashDone=' + splashDone +
            ' @' + Math.round(performance.now()) + 'ms');

        if (window.ScholariusLogin) {
            window.ScholariusLogin.setAccount(isSignedIn, login, name, avatarUrl);
        }

        /*
          ⚠️ 这里直接 applyGate，**不再等 splash**。

          之前调的是 tryDismissSplash()，它要求「动画播完 且 状态已知」两个条件。
          这在实机上有风险：一旦动画事件因任何原因没到达，
          splash 永不退场 → applyGate 永不被调 → **登录成功了也进不去**。

          启动动画只是**视觉遮罩**，不该拥有阻塞功能的权力。
          正确分工：
            · 界面切换（界面层）← 只看 signedIn
            · splash 退场（视觉层）← 只看动画
          两者各自独立，互不干扰。
        */
        applyGate();
        tryDismissSplash();
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
     * 登录门控：只按**登录状态**决定显示哪个界面。
     *
     * 未登录 → 只显示登录页，应用外壳整个藏起来。
     *          用 hidden 而不是盖遮罩 —— 藏起来才不会被别的路径绕进去。
     * 已登录 → 显示应用外壳。
     *
     * ⚠️ 这里**不**检查 splashDone。
     *    早期版本要求「splash 演完」才放行，结果一旦动画事件丢失，
     *    登录成功也进不去（用户卡在登录页）—— 视觉不该阻塞功能。
     *    splash 的退场由 tryDismissSplash() 单独负责。
     */
    function applyGate() {
        if (signedIn === null) {
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
     *
     * ⚠️ 退场条件是**两个**：动画播完 **且** 登录状态已知。
     *
     * 为什么不能只看 animationend：原生的 setAccount() 到达时机不确定。
     * 若动画先结束、状态后到达，而这里先把 splash 藏了，就会出现
     * 「splash 没了、登录页还没显示、应用也藏着」的一段全黑。
     * 反过来若状态先到、动画后结束，只看状态也会让 splash 提前消失
     * —— 用户看到的就是「启动页一闪而过」。
     *
     * 所以两个条件都满足才退场；先到的那个只是记一个标记。
     */
    /*
      ⚠️ 临时诊断（v0.0.6）：把启动时序送到 logcat。
      真机上「一闪而过」在桌面浏览器复现不出来，只能靠现场数据定位。
      定位完就删掉这个函数及其调用点。
    */
    function trace(stage, detail) {
        try {
            if (window.ScholariusNative &&
                typeof window.ScholariusNative.trace === 'function') {
                window.ScholariusNative.trace(
                    stage + (detail === undefined ? '' : ' | ' + detail));
            }
        } catch (e) {
            /* 预览环境没有桥，忽略 */
        }
    }

    /**
     * 启动动画的收尾。
     *
     * 动画本身完全由 CSS 驱动（见 styles.css 的 .splash），这里只负责：
     *   1) 等到「动画播完」且「登录状态已知」两个条件都满足；
     *   2) 把 splash 从文档里摘掉；
     *   3) 通知原生切回正常主题。
     *
     * ⚠️ 判断「播完」只用 animationend 事件，**不要**用 getAnimations() 去查 ——
     *    DOMContentLoaded 可能在 CSS 应用之前触发，那时 getAnimations() 返回空数组，
     *    会被误判成「动画已结束」而立刻跳过启动页（实测踩过这个坑）。
     *
     * ⚠️ 兜底超时必须**大于** CSS 里的动画时长（2.2s），否则会抢在 animationend
     *    之前把 splash 收掉。这里取 3.4s 留出余量。
     */
    function setupSplash() {
        var splash = document.getElementById('splash');
        if (!splash) {
            trace('splash:missing');
            splashDone = true;
            tryDismissSplash();
            return;
        }

        var cssDur = getComputedStyle(splash).animationDuration;
        var anims = splash.getAnimations ? splash.getAnimations() : null;
        trace('splash:setup',
            'readyState=' + document.readyState +
            ' cssDur=' + cssDur +
            ' animCount=' + (anims ? anims.length : 'n/a') +
            ' reduced=' + (window.matchMedia
                ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
                : 'n/a'));

        /*
          ⚠️ 关键防御：不能只认 animationend。

          如果 styles.css 还没被应用（WebView 里样式表是异步加载的），
          .splash 上根本没有 animation，animationDuration 会是 0s，
          于是「动画」瞬间就算走完、animationend 立即触发 ——
          表现就是**启动页一闪而过**。

          这是本次「一闪而过」最可能的机制：脚本执行早于样式表生效。

          所以这里记下开始时刻，收尾时用「真实经过时间」兜住下限：
          splash 至少要显示 SPLASH_MIN_VISIBLE_MS 才能退场。
        */
        splashStartedAt = Date.now();

        var markDone = function (why) {
            if (splashDone) {
                return;
            }

            var elapsed = Date.now() - splashStartedAt;
            if (elapsed < SPLASH_MIN_VISIBLE_MS) {
                /*
                  还没到最小可见时长 —— 判定为「样式表尚未生效导致的假 animationend」，
                  延后到补足时长再收，别让品牌动画一闪而过。
                */
                trace('splash:early', why + ' elapsed=' + elapsed + 'ms，延后');
                if (!splashRetryScheduled) {
                    splashRetryScheduled = true;
                    window.setTimeout(function () {
                        splashRetryScheduled = false;
                        markDone('delayed:' + why);
                    }, SPLASH_MIN_VISIBLE_MS - elapsed);
                }
                return;
            }

            splashDone = true;
            trace('splash:done', why + ' @' + elapsed + 'ms');
            tryDismissSplash();
        };

        splash.addEventListener('animationend', function (event) {
            // 只认 splash 自己的动画；logo / 名称的 animationend 会一起冒泡上来
            if (event.target === splash) {
                markDone('animationend:' + event.animationName);
            }
        });

        window.setTimeout(function () {
            markDone('fallback');
        }, SPLASH_FALLBACK_MS);
    }

    /** 启动动画播完 → 收起启动页。**只关心动画**，与登录状态无关。 */
    function tryDismissSplash() {
        if (!splashDone) {
            trace('dismiss:blocked', 'splashDone=false');
            return;
        }

        var splash = document.getElementById('splash');
        if (splash && !splash.hidden) {
            splash.hidden = true;
            trace('splash:hidden', '@' + Math.round(performance.now()) + 'ms');

            try {
                if (window.ScholariusNative &&
                    typeof window.ScholariusNative.finishSplash === 'function') {
                    window.ScholariusNative.finishSplash();
                }
            } catch (e) {
                /* 浏览器预览环境，忽略 */
            }
        }

        /*
          兜一层：splash 可能晚于登录状态到达。
          状态先到时 applyGate() 已经跑过（界面已切好），这里再调一次是幂等的；
          若状态还没到，applyGate() 自己会 return，等 setAccount 再来。
        */
        applyGate();
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
