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
    var DEFAULT_TAB = 'vault';
    var TAB_ORDER = ['vault', 'explore', 'profile'];

    /**
     * 启动动画时长，**必须与 styles.css 里 .splash 的 animation-duration 一致**。
     *
     * 这是退场时机的基准：动画播完的那一刻正好收起 splash。
     * 若样式表已生效，会用 getComputedStyle 读到的实际值覆盖它；
     * 这个常量只在样式表还没到位时兜底 —— 此时**宁可偏长也不偏短**。
     *
     * ⚠️ 改 styles.css 的动画时长时，这里要同步改。
     */
    var SPLASH_DURATION_MS = 2600;

    /**
     * 兜底余量：主时机没生效时（例如系统把动画延长了）再多等这么久。
     * 只是保险丝，正常路径用不到。
     */
    var SPLASH_FALLBACK_EXTRA_MS = 1200;


    var tabs = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));
    var titleEl = document.getElementById('page-title');
    var appEl = document.getElementById('app');
    var pages = {};
    TAB_ORDER.forEach(function (name) {
        pages[name] = document.getElementById('page-' + name);
    });

    var currentTab = null;

    /** 上一个 tab。用于检测「从文库页切走」，好让文库收尾（退多选） */
    var previousTab = null;
    /** 原生推过来的登录状态；null 表示还没收到 */
    var signedIn = null;
    /** 启动动画是否已播完 */
    var splashDone = false;
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
    function setAccount(isSignedIn, login, name, avatarUrl, accountId) {
        signedIn = !!isSignedIn;
        trace('account', 'signedIn=' + signedIn +
            ' splashDone=' + splashDone +
            ' @' + Math.round(performance.now()) + 'ms');

        if (window.ScholariusLogin) {
            window.ScholariusLogin.setAccount(isSignedIn, login, name, avatarUrl, accountId);
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

    /*
      ⚠️ 这些转发**必须 return** 下层结果。

      原生的 evaluateInWebChecked() 会把表达式的值回传到 logcat，
      用来区分「注入没执行」和「执行了但弹窗没出来」——
      中间少一个 return 就会全部变成 undefined，回报彻底失效。
    */
    function onUpdateAvailable(version, current, size, stalled) {
        if (window.ScholariusUpdate) {
            return window.ScholariusUpdate.onAvailable(version, current, size, stalled);
        }
        return 'no-update-module';
    }

    function onUpdateNone() {
        if (window.ScholariusUpdate) {
            return window.ScholariusUpdate.onNone();
        }
        return 'no-update-module';
    }

    function onUpdateProgress(percent) {
        if (window.ScholariusUpdate) {
            return window.ScholariusUpdate.onProgress(percent);
        }
        return 'no-update-module';
    }

    function onUpdateReady() {
        if (window.ScholariusUpdate) {
            return window.ScholariusUpdate.onReady();
        }
        return 'no-update-module';
    }

    function onUpdateFailed(reason, downloaded) {
        if (window.ScholariusUpdate) {
            return window.ScholariusUpdate.onFailed(reason, downloaded);
        }
        return 'no-update-module';
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
        onUpdateFailed: onUpdateFailed,
        /*
          文献库：原生推列表过来。
          ⚠️ 与「更新」那一组一样，转发**必须 return** 下层结果，
             否则 evaluateInWebChecked 的注入回报永远是 undefined。
        */
        setLibrary: function (docs) {
            if (window.ScholariusVault) {
                return window.ScholariusVault.setLibrary(docs);
            }
            return 'no-vault-module';
        },
        onImportFailed: function () {
            if (window.ScholariusVault) {
                return window.ScholariusVault.onImportFailed();
            }
            return 'no-vault-module';
        },
        /*
          阅读页正文。text 为 null 表示提取失败或无文本。
          ⚠️ 必须 return，理由同上面几个转发函数。
        */
        readerText: function (id, text) {
            if (!window.ScholariusReader) {
                return 'no-reader-module';
            }
            if (text === null || text === undefined) {
                return window.ScholariusReader.onExtractFailed(id);
            }
            return window.ScholariusReader.setText(id, text);
        },
        /*
          原生 → 网页的诊断日志入口。
          原生日志只会进 logcat，手机上根本看不到；
          这个接口让原生把关键信息直接画到屏幕上。
          是否显示由设置页的「Debug log」开关决定（见 setDiagEnabled）。
        */
        diag: function (message) {
            trace(String(message));
        },
        /** 设置页用来读/写诊断日志开关 */
        isDebugLogEnabled: diagEnabled,
        setDebugLogEnabled: setDiagEnabled
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

        /*
          导入按钮只在文库页显示。
          用 class 切 visibility（不是 display）—— 保留占位宽度，
          否则标题会因为右侧变空而横移。
        */
        var importBtn = document.getElementById('vault-import');
        if (importBtn) {
            importBtn.classList.toggle('is-hidden', name !== 'vault');
        }

        /*
          离开文库页时通知它收尾（退出多选模式）。
          否则切到别的页再回来，批量操作条还在，但选中项已经不显示在屏幕上。
        */
        if (previousTab === 'vault' && name !== 'vault' &&
            window.ScholariusVault && window.ScholariusVault.onLeave) {
            window.ScholariusVault.onLeave();
        }

        currentTab = name;
        previousTab = name;

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
        if (window.ScholariusVault) {
            window.ScholariusVault.init();
        }
        if (window.ScholariusReader) {
            window.ScholariusReader.init();
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

        // 调试日志已开启：立刻把浮层建出来，让用户看到开关生效
        if (diagEnabled()) {
            ensureDiagPanel();
            trace('diag:ready', 'debug log enabled');
        }

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
      诊断浮层：把启动/登录/更新时序显示成**可复制、可开关**的浮层。

      设计要点：
        · 日志往往很长，直接铺在屏幕上既挡视野又没法完整看到，
          所以做成「默认折叠成一条细横条」，点一下才展开；
        · 展开后日志区可选中复制，用户能整段粘贴出来；
        · 提供 Copy / Clear 按钮。

      ⚠️ 文案**固定英文**，不随语言切换。
         它是给排查问题看的，贴到 issue / 聊天里时混中文更难读。
         设置项名称本身走 i18n（见 setting.debugLog）。

      ⚠️ 开关存在 localStorage，不走原生 —— 原生的 EncryptedSharedPreferences
         是给 token 用的，一个调试开关没必要过桥。
    */
    var DIAG_HEIGHT_KEY = 'scholarius.diagHeight';
    var DIAG_ENABLED_KEY = 'scholarius.debugLog';

    function diagEnabled() {
        try {
            return localStorage.getItem(DIAG_ENABLED_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    /**
     * 开关诊断日志。返回切换后的状态。
     *
     * 关掉时**立刻移除浮层**，不用等下次启动。
     * 打开时**立刻建出浮层** —— 否则要等下一次 trace() 才出现，
     * 用户会以为开关没生效。
     */
    function setDiagEnabled(on) {
        try {
            localStorage.setItem(DIAG_ENABLED_KEY, on ? '1' : '0');
        } catch (e) { /* 忽略 */ }

        var panel = document.getElementById('__diag');
        if (on) {
            ensureDiagPanel();
        } else if (panel && panel.parentNode) {
            panel.parentNode.removeChild(panel);
        }
        return on;
    }

    function ensureDiagPanel() {
        if (!diagEnabled()) return null;
        var panel = document.getElementById('__diag');
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = '__diag';
        panel.innerHTML =
            '<div class="diag-bar">' +
            '  <span class="diag-title">Logger</span>' +
            '  <span class="diag-count" id="__diagCount">0</span>' +
            '  <span class="diag-spacer"></span>' +
            '  <button type="button" class="diag-btn" id="__diagCopy">Copy</button>' +
            '  <button type="button" class="diag-btn" id="__diagClear">Clear</button>' +
            '  <button type="button" class="diag-btn" id="__diagToggle">Expand</button>' +
            '</div>' +
            '<pre class="diag-log" id="__diagLog" hidden></pre>';

        document.body.appendChild(panel);

        var logEl = panel.querySelector('#__diagLog');
        var countEl = panel.querySelector('#__diagCount');
        var toggleEl = panel.querySelector('#__diagToggle');

        var setExpanded = function (expanded) {
            logEl.hidden = !expanded;
            toggleEl.textContent = expanded ? 'Collapse' : 'Expand';
            try {
                localStorage.setItem(DIAG_HEIGHT_KEY, expanded ? '1' : '0');
            } catch (e) { /* 忽略 */ }
        };

        toggleEl.addEventListener('click', function () {
            setExpanded(logEl.hidden);
        });

        panel.querySelector('#__diagCopy').addEventListener('click', function () {
            var text = logEl.textContent || '';
            var done = function () {
                flash(panel, 'Copied ' + text.split('\n').length + ' lines');
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done, function () {
                    selectAndCopy(logEl, done);
                });
            } else {
                selectAndCopy(logEl, done);
            }
        });

        panel.querySelector('#__diagClear').addEventListener('click', function () {
            logEl.textContent = '';
            window.__bootLog = [];
            updateCount();
        });

        function updateCount() {
            var n = (logEl.textContent || '').split('\n').filter(Boolean).length;
            countEl.textContent = String(n);
        }
        panel.__updateCount = updateCount;

        // 折叠状态跨启动记忆：正在排查的人希望一直是展开的
        var remembered = '0';
        try {
            remembered = localStorage.getItem(DIAG_HEIGHT_KEY) || '0';
        } catch (e) { /* 忽略 */ }
        setExpanded(remembered === '1');

        return panel;
    }

    /** 把 <pre> 里的内容全选并复制（clipboard API 不可用时的兜底） */
    function selectAndCopy(el, done) {
        try {
            var range = document.createRange();
            range.selectNodeContents(el);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('copy');
            done();
        } catch (e) {
            /* 让用户手动长按选中 */
        }
    }

    /** 在标题上闪一条简短反馈 */
    function flash(panel, message) {
        var title = panel.querySelector('.diag-title');
        if (!title) return;
        title.textContent = message;
        window.setTimeout(function () {
            title.textContent = 'Logger';
        }, 1400);
    }

    function trace(stage, detail) {
        var line = stage + (detail === undefined ? '' : ' | ' + detail);
        var stamp = Math.round(performance.now()) + 'ms ';

        try {
            if (window.ScholariusNative &&
                typeof window.ScholariusNative.trace === 'function') {
                window.ScholariusNative.trace(line);
            }
        } catch (e) { /* 预览环境没有桥 */ }

        try {
            (window.__bootLog = window.__bootLog || []).push(stamp + line);
        } catch (e) { /* 忽略 */ }

        try {
            var panel = ensureDiagPanel();
            if (!panel) return;
            var logEl = panel.querySelector('#__diagLog');
            logEl.textContent += stamp + line + '\n';
            if (panel.__updateCount) panel.__updateCount();
        } catch (e) { /* 忽略 */ }
    }

    /**
     * 启动动画的收尾。
     *
     * 职责：等启动动画播完，收起 splash。
     *
     * ⚠️ 这里**刻意不用 animationend 事件**，改为「显式计时 + 动画时长对齐」。
     *
     *    原因是踩过太多次坑，且每次现象都不一致：
     *      · animationend 可能在样式表未生效时被 animationDuration:0s 立刻触发；
     *      · 子元素（.splash-logo / .splash-name）的动画事件会冒泡上来，
     *        必须靠 event.target 过滤，而这个过滤在某些机型上不可靠；
     *      · CSS 动画的「起点」是元素渲染时刻，而脚本执行时刻晚于它，
     *        两者不同步会让「已播时长」算不准。
     *
     *    显式计时的确定性最高：
     *      t=0 开始等待 → SPLASH_DURATION_MS 后收起。
     *    这个时长与 styles.css 里 .splash 的 animation-duration 保持一致，
     *    动画自然结束的那一刻，我们也正好收起它。
     *
     *    为了容忍真实动画因低端机首帧延迟而整体后移，
     *    额外加 FALLBACK 余量：先按 DURATION 收，收不掉就等 FALLBACK。
     *    但**绝不允许早于 DURATION 收起** —— 那就是「一闪而过」。
     */
    function setupSplash() {
        var splash = document.getElementById('splash');
        if (!splash) {
            trace('splash:missing');
            splashDone = true;
            tryDismissSplash();
            return;
        }

        var cs = getComputedStyle(splash);
        var boot = window.__boot || {};
        var anims = splash.getAnimations ? splash.getAnimations() : null;

        trace('splash:setup',
            'readyState=' + document.readyState +
            ' cssDur=' + cs.animationDuration +
            ' animName=' + cs.animationName +
            ' animCount=' + (anims ? anims.length : 'n/a'));
        trace('splash:boot',
            'navStart=' + boot.navStart +
            ' domReady=' + boot.domReady +
            ' sheetApplied=' + boot.stylesheetApplied +
            ' atDomReady=' + JSON.stringify(boot.splashAtDomReady));

        /*
          读一次 CSS 里声明的动画时长，用它当退场时刻。
          读不到（样式表还没生效）就退回内置常量 —— 总之**不会提前收**。
        */
        var durationMs = SPLASH_DURATION_MS;
        var parsed = parseFloat(cs.animationDuration);
        if (!isNaN(parsed) && parsed > 0) {
            durationMs = parsed * 1000;
        } else {
            trace('splash:noCssDuration', '用内置时长 ' + durationMs + 'ms');
        }

        var start = Date.now();
        trace('splash:timer', '将在 ' + durationMs + 'ms 后退场');

        var dismiss = function (why) {
            if (splashDone) {
                return;
            }
            splashDone = true;
            trace('splash:done',
                why + ' @' + (Date.now() - start) + 'ms');
            tryDismissSplash();
        };

        // 主时机：与 CSS 动画时长对齐
        window.setTimeout(function () {
            dismiss('timer');
        }, durationMs);

        // 兜底：主时机没生效（例如动画被系统延长）也不能永久卡住
        window.setTimeout(function () {
            dismiss('fallback');
        }, durationMs + SPLASH_FALLBACK_EXTRA_MS);
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

    /**
     * 处理系统返回键。原生调这个方法，用返回值决定是否自己吞掉按键。
     *
     * @return true  网页已经处理了（关了某个覆盖层），原生什么都不用做
     *         false 网页无事可做，原生应该退出应用
     *
     * ⚠️ 为什么必须由网页来判定：
     *    Scholarius 是**单页应用**（只有一个 index.html，界面全靠 JS 切换），
     *    `WebView.canGoBack()` 永远是 false —— 所以原生那边「有历史才回退」
     *    的判断不成立，按返回键会直接退出应用，
     *    即使屏幕上正开着一个全屏覆盖层（账户页 / 弹窗 / 菜单）。
     *
     * 收尾顺序遵循「最上层先关」：
     *    行内菜单 → 弹层（sheet）→ 账户详情页
     *    （账户页是最底层的覆盖层，所以最后关）
     */
    function handleBack() {
        /*
          ① 阅读页最先处理。
             它的逻辑是「菜单开着就先关菜单，否则关阅读页」，
             即返回键要按两次才退出阅读页 —— 与主流阅读器一致。
        */
        if (window.ScholariusReader && window.ScholariusReader.isOpen &&
            window.ScholariusReader.isOpen()) {
            window.ScholariusReader.handleBack();
            trace('back', 'reader handled');
            return true;
        }

        // ② 行内选择菜单（语言 / 主题 / Logger 弹出的那个）
        if (window.ScholariusUI &&
            typeof window.ScholariusUI.hasOpenRowMenu === 'function' &&
            window.ScholariusUI.hasOpenRowMenu()) {
            window.ScholariusUI.closeRowMenu();
            trace('back', 'closed row menu');
            return true;
        }

        // ③ 底部弹层（更新 / 退出登录 / 通用确认）
        if (window.ScholariusUI &&
            typeof window.ScholariusUI.isSheetOpen === 'function' &&
            window.ScholariusUI.isSheetOpen()) {
            window.ScholariusUI.closeSheet();
            trace('back', 'closed sheet');
            return true;
        }

        // ④ 文库的多选模式
        if (window.ScholariusVault && window.ScholariusVault.isSelecting &&
            window.ScholariusVault.isSelecting()) {
            window.ScholariusVault.exitSelection();
            trace('back', 'exited selection');
            return true;
        }

        // ⑤ 账户详情页（全屏覆盖层）
        var detail = document.getElementById('account-detail');
        if (detail && !detail.hidden) {
            if (window.ScholariusAccount &&
                typeof window.ScholariusAccount.closeDetail === 'function') {
                window.ScholariusAccount.closeDetail();
            }
            trace('back', 'closed account detail');
            return true;
        }

        trace('back', 'nothing to close, letting native exit');
        return false;
    }

    // 暴露给后续功能扩展使用
    window.Scholarius = {
        selectTab: selectTab,
        TAB_ORDER: TAB_ORDER,
        handleBack: handleBack,
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
