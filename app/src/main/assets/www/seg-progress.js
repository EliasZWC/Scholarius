/**
 * 分段进度表单（v0.1.97）
 *
 * 用户要求：「那给模型渲染也加一个进度表单」
 *
 * ══ 与导入进度表单的区别（为什么不能共用）══
 *
 *   导入表单                    分段表单
 *   ────────────────────────    ────────────────────────────
 *   阻塞式，必须等它完成        后台式，正文**已经可读**
 *   取消 = 丢弃整个导入          取消 = 放弃优化，正文不变
 *   用户不能做别的事            用户可以继续阅读/滚动
 *   模态遮罩                    轻量提示条，不拦操作
 *
 * ⚠️ 所以这里**不能**用遮罩盖住正文 —— 那是本末倒置：
 *    用户已经能看到文字了，弹一个模态框挡住它是纯打扰。
 *
 * ✅ 形态：固定在底部的一根细条（类似"正在保存…"），
 *    显示阶段 + 百分比 + 一个「跳过」按钮。
 *    完成后 800ms 自动消失。
 *
 * ══ 为什么必须显示它 ══
 *
 * 分段要跑本地模型，首次约 1~3 秒（低端机可能十几秒）。
 * 用户看文字时若**突然重排**（段落合并/拆分），会以为出了 bug。
 * 提前告知"正在优化段落"，重排就是可预期的行为。
 */

(function (global) {
    'use strict';

    var barEl = null;
    var textEl = null;
    var pctEl = null;
    var skipEl = null;

    var visible = false;
    var cancelled = false;
    /** 完成后自动收起的计时器 */
    var hideTimer = null;

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    // ------------------------------------------------------------------
    // 构建
    // ------------------------------------------------------------------

    function build() {
        if (barEl) return;

        barEl = document.createElement('div');
        barEl.className = 'seg-bar';
        barEl.setAttribute('role', 'status');
        /*
          ⚠️ aria-live=polite：读屏器会在它变化时播报，
             但不打断当前的朗读。用 assertive 会把用户正在听的内容切掉。
        */
        barEl.setAttribute('aria-live', 'polite');

        barEl.innerHTML =
            '<div class="seg-bar-fill"></div>' +
            '<div class="seg-bar-row">' +
            '  <span class="seg-bar-text"></span>' +
            '  <span class="seg-bar-pct"></span>' +
            '  <button type="button" class="seg-bar-skip"></button>' +
            '</div>';

        textEl = barEl.querySelector('.seg-bar-text');
        pctEl = barEl.querySelector('.seg-bar-pct');
        skipEl = barEl.querySelector('.seg-bar-skip');

        skipEl.addEventListener('click', function () {
            /*
              ⚠️ 「跳过」= 放弃这次优化，**不改动已显示的正文**。
                 不能调 hide() 假装成功 —— 要通知引擎停下，
                 否则模型继续跑、白耗电，而且可能在用户已经
                 开始阅读之后再重排正文（最糟的时机）。
            */
            skipEl.disabled = true;
            if (global.ScholariusSeg &&
                typeof global.ScholariusSeg.cancel === 'function') {
                global.ScholariusSeg.cancel();
            }
            finish('skipped');
        });

        document.body.appendChild(barEl);
    }

    // ------------------------------------------------------------------
    // 显隐
    // ------------------------------------------------------------------

    /** 开始分段：显示进度条。`total` 是句子总数，未知时传 0 */
    function start(total) {
        build();
        if (hideTimer) {
            global.clearTimeout(hideTimer);
            hideTimer = null;
        }
        visible = true;
        cancelled = false;

        skipEl.disabled = false;
        skipEl.textContent = t('seg.skip');
        barEl.querySelector('.seg-bar-fill').style.width = '0%';
        pctEl.textContent = '0%';
        textEl.textContent = t('seg.loading');

        barEl.classList.add('is-open');
        barEl.dataset.total = String(total || 0);
    }

    /** 进度：`done`/`total` 都是句子数 */
    function progress(done, total) {
        if (!visible || cancelled) return;

        var pct = (total > 0)
            ? Math.max(0, Math.min(100, Math.round(done / total * 100)))
            : 0;

        barEl.querySelector('.seg-bar-fill').style.width = pct + '%';
        pctEl.textContent = pct + '%';

        /*
          ⚠️ 分段分两个阶段：算向量 → 判边界。
             向量算完（100%）不代表做完，所以文案要换。
             不换的话用户看到 100% 还以为卡住了。
        */
        textEl.textContent = (pct >= 100)
            ? t('seg.boundaries')
            : t('seg.working');
    }

    /** 结束：`result` 取 'done' | 'skipped' | 'failed' */
    function finish(result) {
        if (!visible) return;
        visible = false;

        if (result === 'done') {
            /*
              ⚠️ 先显示"完成"再收起。
                 直接消失会让用户不知道是自己跳过了还是做完了。
            */
            textEl.textContent = t('seg.done');
            pctEl.textContent = '100%';
            barEl.querySelector('.seg-bar-fill').style.width = '100%';
            hideTimer = global.setTimeout(hide, 800);
        } else if (result === 'failed') {
            /*
              ⚠️ 失败也要告知，但**不报错弹窗** ——
                 正文已经能读了，分段失败只是"段落切得粗糙"。
                 弹个红色错误框会让人以为出了大问题。
            */
            textEl.textContent = t('seg.failed');
            pctEl.textContent = '';
            hideTimer = global.setTimeout(hide, 1600);
        } else {
            hide();
        }
    }

    function hide() {
        visible = false;
        if (barEl) barEl.classList.remove('is-open');
        if (hideTimer) {
            global.clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    function isOpen() {
        return visible;
    }

    global.ScholariusSegProgress = {
        init: function () { build(); },
        start: start,
        progress: progress,
        finish: finish,
        hide: hide,
        isOpen: isOpen
    };
})(window);
