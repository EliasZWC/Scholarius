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

        codeEl.textContent = userCode;
        codeEl.dataset.uri = verificationUri || '';
        codeBox.hidden = false;

        waitEl.textContent = t('login.waiting');
        errorEl.hidden = true;

        actionBtn.hidden = true;
        cancelBtn.hidden = false;

        // 顺手复制一次：多数用户会去手机浏览器粘贴
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
        errorEl.hidden = true;
        actionBtn.disabled = true;

        if (!global.ScholariusNative ||
            typeof global.ScholariusNative.startLogin !== 'function') {
            // 浏览器预览环境：没有原生桥，直接说明
            onFailed('unknown');
            return;
        }

        global.ScholariusNative.startLogin();
    }

    function cancel() {
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
        /*
          只重置**文字节点**，不能写 actionBtn.textContent ——
          那会把里面的 GitHub 图标一起抹掉。
        */
        if (actionLabel) {
            actionLabel.setAttribute('data-i18n', 'login.action');
            actionLabel.textContent = t('login.action');
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
