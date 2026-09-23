/**
 * Scholarius - 应用内更新。
 *
 * 原生壳进入前台时去 GitHub 查一次最新 Release，有新版本就把版本号推过来，
 * 这里弹窗询问；用户确认后由原生下载 APK，进度再推回来；
 * 下载完成原生直接拉起系统安装器。
 *
 * 原生 → 网页（都挂在 ScholariusShell 上）：
 *   onUpdateAvailable(version, current, size, stalled)  发现新版本
 *   onUpdateNone()                              已是最新（手动检查时才有）
 *   onUpdateProgress(percent)                   下载进度 0~100
 *   onUpdateReady()                             下载完成，安装器已拉起
 *   onUpdateFailed(reason, downloaded)          失败；downloaded=true 表示包已下好，可直接重试安装
 *
 * 网页 → 原生（ScholariusNative）：
 *   downloadUpdate()   开始下载
 *   installUpdate()    重试安装已下好的包
 *   closeUpdate()      弹窗被关掉，原生可以重置「本次进入已检查过」的状态
 */
(function (global) {
    'use strict';

    var STATE_AVAILABLE = 'available';
    var STATE_DOWNLOADING = 'downloading';

    var sheet = null;
    var textEl = null;
    var stalledEl = null;
    var progressEl = null;
    var fillEl = null;
    var percentEl = null;
    var laterBtn = null;
    var confirmBtn = null;

    var state = STATE_AVAILABLE;
    /** 包已经下好，只差安装（点确定走 installUpdate 而不是重新下载） */
    var downloaded = false;
    var info = null;

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    function init() {
        sheet = document.getElementById('sheet-update');
        textEl = document.getElementById('update-text');
        stalledEl = document.getElementById('update-stalled');
        progressEl = document.getElementById('update-progress');
        fillEl = document.getElementById('update-fill');
        percentEl = document.getElementById('update-percent');
        laterBtn = document.getElementById('update-later');
        confirmBtn = document.getElementById('update-confirm');

        if (!sheet) {
            return;
        }

        laterBtn.addEventListener('click', dismiss);
        confirmBtn.addEventListener('click', confirm);
    }

    // --- 原生回调 -----------------------------------------------------------

    function onAvailable(version, current, size, stalled) {
        if (!sheet) {
            return;
        }

        info = {
            version: String(version),
            current: String(current),
            size: String(size || ''),
            stalled: !!stalled
        };
        downloaded = false;
        setState(STATE_AVAILABLE);
        renderText();

        global.ScholariusUI.openSheet(sheet);
    }

    /** 手动点了「检查更新」但已是最新 */
    function onNone() {
        if (global.ScholariusUI) {
            global.ScholariusUI.toast(t('update.upToDate'));
        }
    }

    function onProgress(percent) {
        if (!sheet || state !== STATE_DOWNLOADING) {
            return;
        }

        var value = Math.max(0, Math.min(100, Number(percent) || 0));
        fillEl.style.width = value + '%';
        percentEl.textContent = value + '%';
    }

    function onReady() {
        // 安装器已经起来，收起弹窗并给一句反馈
        downloaded = false;
        setState(STATE_AVAILABLE);
        global.ScholariusUI.closeSheet();
        global.ScholariusUI.toast(t('update.installing'));
    }

    function onFailed(reason, isDownloaded) {
        if (!sheet) {
            return;
        }

        downloaded = !!isDownloaded;
        setState(STATE_AVAILABLE);

        var key = 'update.failed.' + (reason || 'unknown');
        var message = t(key);
        textEl.textContent = (message === key) ? t('update.failed.unknown') : message;
        confirmBtn.textContent = t(downloaded ? 'update.retryInstall' : 'update.now');
    }

    // --- 交互 ---------------------------------------------------------------

    function confirm() {
        if (state === STATE_DOWNLOADING) {
            return;
        }

        if (downloaded) {
            if (global.ScholariusNative &&
                typeof global.ScholariusNative.installUpdate === 'function') {
                global.ScholariusNative.installUpdate();
            } else {
                // 浏览器预览环境：没有原生桥，别静默无反应
                global.ScholariusUI.toast(t('update.failed.install'));
            }
            return;
        }

        if (!global.ScholariusNative ||
            typeof global.ScholariusNative.downloadUpdate !== 'function') {
            // 没有原生桥就没人能下载，说清楚而不是让按钮看起来坏了
            global.ScholariusUI.toast(t('update.failed.network'));
            return;
        }

        setState(STATE_DOWNLOADING);
        global.ScholariusNative.downloadUpdate();
    }

    function dismiss() {
        if (state === STATE_DOWNLOADING) {
            // 下载中不给关，避免界面与原生状态脱节
            return;
        }

        downloaded = false;
        global.ScholariusUI.closeSheet();
        notifyNativeClosed();
    }

    /** 告诉原生「弹窗没了」，它才能重置「本次进入已检查过」的状态 */
    function notifyNativeClosed() {
        if (global.ScholariusNative &&
            typeof global.ScholariusNative.closeUpdate === 'function') {
            global.ScholariusNative.closeUpdate();
        }
    }

    // --- 渲染 ---------------------------------------------------------------

    function setState(next) {
        state = next;
        var busy = next === STATE_DOWNLOADING;

        progressEl.hidden = !busy;
        laterBtn.disabled = busy;
        confirmBtn.disabled = busy;
        confirmBtn.textContent = busy ? t('update.downloading') : t('update.now');

        if (busy) {
            fillEl.style.width = '0%';
            percentEl.textContent = '0%';
            textEl.textContent = t('update.downloading');
        }
    }

    function renderText() {
        textEl.textContent = t('update.message')
            .replace('{version}', info ? info.version : '')
            .replace('{size}', info ? info.size : '')
            .replace('{current}', info ? info.current : '');

        stalledEl.hidden = !(info && info.stalled);
        if (info && info.stalled) {
            stalledEl.textContent = t('update.stalled');
        }
    }

    global.ScholariusUpdate = {
        init: init,
        onAvailable: onAvailable,
        onNone: onNone,
        onProgress: onProgress,
        onReady: onReady,
        onFailed: onFailed
    };
})(window);
