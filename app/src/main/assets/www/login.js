/**
 * Scholarius - 登录页。
 *
 * 走 GitHub 的 **Device Flow**：网页只管显示，HTTP 请求全部由原生做
 * （WebView 里 fetch github.com 会被 CORS 拦，GitHub 不返回 ACAO 头）。
 *
 * 原生 → 网页（都挂在 ScholariusShell 上）：
 *   setAccount(signedIn, login, name, avatarUrl)  登录状态变化
 *   onLoginCode(userCode, verificationUri, expiresIn)  拿到设备码，显示给用户
 *   onLoginWaiting(waitedSeconds)                 轮询中，秒数递增
 *   onLoginFailed(reason)                         失败（对应 i18n 的 login.error.*）
 *
 * 网页 → 原生（ScholariusNative）：
 *   startLogin()   开始
 *   cancelLogin()  取消轮询
 */
(function (global) {
    'use strict';

    var root = null;
    var textEl = null;
    var codeBox = null;
    var codeEl = null;
    var waitEl = null;
    var errorEl = null;
    var actionBtn = null;
    /** 按钮里的**文字**节点。按钮现在含图标，不能再整体改 textContent */
    var actionLabel = null;
    var cancelBtn = null;

    var signedIn = false;
    /** 正在走登录流程（设备码已到手，等用户授权） */
    var inProgress = false;
    /** start() 的超时计时器；0 表示未计时 */
    var startTimer = 0;

    /**
     * 点了登录后多久没任何回调就判定失败。
     * 拿设备码是本地一次 HTTP，正常在 3s 内；给 15s 足够宽容，
     * 同时不至于让用户对着一个禁用按钮干等。
     */
    var LOGIN_START_TIMEOUT_MS = 15000;

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    function init() {
        root = document.getElementById('login');
        textEl = document.getElementById('login-text');
        codeBox = document.getElementById('login-code-box');
        codeEl = document.getElementById('login-code');
        waitEl = document.getElementById('login-code-wait');
        errorEl = document.getElementById('login-error');
        actionBtn = document.getElementById('login-action');
        actionLabel = document.getElementById('login-action-label');
        cancelBtn = document.getElementById('login-cancel');

        if (!root) {
            return;
        }

        actionBtn.addEventListener('click', start);
        cancelBtn.addEventListener('click', cancel);

        // 点设备码本身即复制 —— 用户要去浏览器里手输它，复制能省事
        codeEl.addEventListener('click', copyCode);
    }

    // --- 原生回调 -----------------------------------------------------------

    /**
     * 登录状态变化。这是「进哪个界面」的唯一判据：
     *   signedIn=true  → 收起登录页
     *   signedIn=false → 显示登录页（强制登录，没有跳过）
     */
    function setAccount(isSignedIn, login, name, avatarUrl) {
        signedIn = !!isSignedIn;

        if (signedIn) {
            inProgress = false;
            hide();
            // 账号信息交给 account.js 渲染，这里只管进出
            if (global.ScholariusAccount) {
                global.ScholariusAccount.setAccount(login, name, avatarUrl);
            }
            return;
        }

        // 未登录：清空上一次的残留，显示登录页
        inProgress = false;
        resetUi();
        show();
    }

    function onCode(userCode, verificationUri, expiresIn) {
        inProgress = true;
        clearStartTimer();

        codeEl.textContent = userCode;
        codeEl.dataset.uri = verificationUri || '';
        codeBox.hidden = false;

        waitEl.textContent = t('login.waiting');
        errorEl.hidden = true;

        /*
          ⚠️ 按钮**不能只是隐藏** —— 那会让用户卡死。

          原来的写法是 `actionBtn.hidden = true`，只留一个「取消」。
          但如果自动跳转没成功（GitHub App 拉不起来、浏览器也没起、
          或用户跳过去又退回来了），**就再也没有入口可以重新打开授权页** ——
          用户只能干瞪眼看设备码。

          改成：按钮留着，文字变成「打开授权页」，点击重新跳转。
          这样即使一次跳转失败，用户永远有办法自己再试。
        */
        actionBtn.hidden = false;
        actionBtn.disabled = false;
        setActionLabel(t('login.openPage'));
        cancelBtn.hidden = false;

        // 顺手复制一次：多数用户会去浏览器粘贴
        copyCode(true);

        if (global.ScholariusUI) {
            global.ScholariusUI.toast(t('login.codeCopied'));
        }
    }

    function onWaiting(waitedSeconds) {
        if (!inProgress) {
            return;
        }
        // 已等待秒数，让用户知道它还在转
        waitEl.textContent = t('login.waitingFor').replace('{s}', String(waitedSeconds));
    }

    function onFailed(reason) {
        inProgress = false;
        clearStartTimer();

        codeBox.hidden = true;
        actionBtn.hidden = false;
        cancelBtn.hidden = true;

        var key = 'login.error.' + (reason || 'unknown');
        var message = t(key);
        errorEl.textContent = (message === key) ? t('login.error.unknown') : message;
        errorEl.hidden = false;

        resetButton();
    }

    // --- 交互 ---------------------------------------------------------------

    function start() {
        // 已在等授权（按钮此时是「打开授权页」）→ 重新跳转，不要重开流程
        if (inProgress) {
            openVerificationPage();
            return;
        }

        errorEl.hidden = true;
        actionBtn.disabled = true;

        if (!global.ScholariusNative ||
            typeof global.ScholariusNative.startLogin !== 'function') {
            // 浏览器预览环境：没有原生桥，直接说明
            onFailed('unknown');
            return;
        }

        /*
          ⚠️ 启动超时保护。
          原生既要发 HTTP 请求拿设备码，又要跳转授权页 —— 任何一步卡住，
          都可能既不回调 onCode 也不回调 onFailed，按钮就永久禁用，
          用户只能卸载重装。这里兜一个超时，到点就恢复按钮并提示。
        */
        startTimer = global.setTimeout(function () {
            startTimer = 0;
            if (inProgress) {
                return;
            }
            onFailed('network');
        }, LOGIN_START_TIMEOUT_MS);

        global.ScholariusNative.startLogin();
    }

    /** 重新打开 GitHub 授权页（设备码已经在手上时用） */
    function openVerificationPage() {
        var uri = codeEl.dataset.uri;
        if (!uri) {
            return;
        }
        if (global.ScholariusNative &&
            typeof global.ScholariusNative.openExternal === 'function') {
            global.ScholariusNative.openExternal(uri);
        }
    }

    function clearStartTimer() {
        if (startTimer) {
            global.clearTimeout(startTimer);
            startTimer = 0;
        }
    }

    function cancel() {
        clearStartTimer();

        if (global.ScholariusNative &&
            typeof global.ScholariusNative.cancelLogin === 'function') {
            global.ScholariusNative.cancelLogin();
        }

        inProgress = false;
        resetUi();
        textEl.textContent = t('login.intro');
    }

    function copyCode(silent) {
        var code = codeEl.textContent;
        if (!code) {
            return;
        }

        var done = function () {
            if (!silent && global.ScholariusUI) {
                global.ScholariusUI.toast(t('login.codeCopied'));
            }
            codeEl.classList.add('is-copied');
            global.setTimeout(function () {
                codeEl.classList.remove('is-copied');
            }, 900);
        };

        // navigator.clipboard 在 WebView 里需要安全上下文；我们有 https 源，可用
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(done, function () {
                fallbackCopy(code, done);
            });
        } else {
            fallbackCopy(code, done);
        }
    }

    /** 老 WebView 没有 clipboard API 时的兜底 */
    function fallbackCopy(text, done) {
        try {
            var input = document.createElement('textarea');
            input.value = text;
            input.setAttribute('readonly', '');
            input.style.position = 'fixed';
            input.style.opacity = '0';
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            done();
        } catch (e) {
            // 复制失败不影响流程：码就显示在屏幕上，用户能手动输
        }
    }

    // --- 显示 ---------------------------------------------------------------

    function resetUi() {
        codeBox.hidden = true;
        codeEl.textContent = '';
        errorEl.hidden = true;
        actionBtn.hidden = false;
        cancelBtn.hidden = true;
        resetButton();
    }

    function resetButton() {
        actionBtn.disabled = false;
        setActionLabel(t('login.action'));
    }

    /**
     * 只改按钮里的**文字节点**，不能写 actionBtn.textContent ——
     * 那会把里面的 GitHub 图标一起抹掉。
     */
    function setActionLabel(text) {
        if (actionLabel) {
            actionLabel.removeAttribute('data-i18n');
            actionLabel.textContent = text;
        }
    }

    function show() {
        root.hidden = false;
        void root.offsetWidth;
        root.classList.add('is-open');
    }

    function hide() {
        root.classList.remove('is-open');
        root.hidden = true;
    }

    function isVisible() {
        return root && !root.hidden;
    }

    global.ScholariusLogin = {
        init: init,
        setAccount: setAccount,
        onCode: onCode,
        onWaiting: onWaiting,
        onFailed: onFailed,
        isVisible: isVisible,
        isSignedIn: function () {
            return signedIn;
        }
    };
})(window);
