/**
 * Scholarius - 主题模式管理。
 *
 * 三种模式：light / dark / system（默认 system）。
 * 落点有两处，必须同时改：
 *   1. <html data-theme="light|dark">  —— 网页层自己用（styles.css 里按它选变量）
 *   2. 通知原生 setThemeMode()          —— 系统栏图标与窗口底色要跟着变
 *
 * ⚠️ 原生也会反向推主题过来（applyTheme 时调 ScholariusShell.setThemeMode），
 *    所以这里必须做「同值短路」，否则两边来回推会死循环。
 */
(function (global) {
    'use strict';

    var STORAGE_KEY = 'scholarius.theme';
    var MODES = { LIGHT: 'light', DARK: 'dark', SYSTEM: 'system' };

    var listeners = [];
    /** 原生推过来的那次改动不该再推回去 */
    var suppressPush = false;

    var media = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;

    function normalize(mode) {
        if (mode === MODES.LIGHT || mode === MODES.DARK) return mode;
        return MODES.SYSTEM;
    }

    function getMode() {
        try {
            return normalize(localStorage.getItem(STORAGE_KEY));
        } catch (e) {
            return MODES.SYSTEM;
        }
    }

    /** 当前实际生效的外观（system 时看系统偏好） */
    function resolve(mode) {
        var m = normalize(mode || getMode());
        if (m !== MODES.SYSTEM) return m;
        return media && media.matches ? MODES.DARK : MODES.LIGHT;
    }

    /** 把外观写到 <html>：只有显式指定时才写 data-theme，system 时摘掉属性 */
    function paint(mode) {
        var root = document.documentElement;
        if (mode === MODES.LIGHT || mode === MODES.DARK) {
            root.setAttribute('data-theme', mode);
        } else {
            root.removeAttribute('data-theme');
        }
    }

    function notify() {
        var mode = getMode();
        listeners.forEach(function (fn) {
            try {
                fn(mode);
            } catch (e) { /* 单个订阅者出错不影响其它 */ }
        });
    }

    function setMode(mode, options) {
        var next = normalize(mode);
        if (next === getMode()) {
            // 同值短路：避免与原生来回推造成死循环
            paint(next);
            return;
        }

        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch (e) { /* 隐私模式下忽略 */ }

        paint(next);
        notify();

        if (!suppressPush && !(options && options.fromNative)) {
            pushToNative(next);
        }
    }

    function pushToNative(mode) {
        try {
            if (global.ScholariusNative &&
                typeof global.ScholariusNative.setThemeMode === 'function') {
                global.ScholariusNative.setThemeMode(mode);
            }
        } catch (e) { /* 浏览器预览环境，忽略 */ }
    }

    /** 原生 → 网页。不回推，避免死循环 */
    function applyFromNative(mode) {
        suppressPush = true;
        try {
            setMode(mode, { fromNative: true });
        } finally {
            suppressPush = false;
        }
    }

    function onChange(fn) {
        if (typeof fn === 'function') listeners.push(fn);
    }

    function init() {
        paint(getMode());

        // system 模式下，系统换外观时要跟着重绘
        if (media) {
            var handler = function () {
                if (getMode() === MODES.SYSTEM) {
                    paint(MODES.SYSTEM);
                    notify();
                }
            };
            if (media.addEventListener) {
                media.addEventListener('change', handler);
            } else if (media.addListener) {
                media.addListener(handler);   // 旧版 WebView 兜底
            }
        }
    }

    global.ScholariusTheme = {
        MODES: MODES,
        init: init,
        getMode: getMode,
        resolve: resolve,
        setMode: setMode,
        applyFromNative: applyFromNative,
        onChange: onChange
    };
})(window);
