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
    /** 已完成的最大百分比 —— 进度只许前进，见 progress() 里的说明 */
    var lastPct = 0;
    /** 完成后自动收起的计时器 */
    var hideTimer = null;
    /** 背景蒙层（v0.2.1）—— 加载期间压暗正文，表示"现在不能操作" */
    var scrimEl = null;

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    // ------------------------------------------------------------------
    // 构建
    // ------------------------------------------------------------------

    function build() {
        if (barEl) return;

        /*
          ══ 背景蒙层（v0.2.1）══

          用户裁决：

            「加载模型时由于阅读视图无法操作，所以请将背景文字都蒙淡，
              意思就是不解除现在的进程背景文字也无法操作」

          为什么需要：加载模型期间主线程被 wasm 编译占住，
          用户的**点击、滚动全部没有反应**。
          如果界面看起来完全正常，用户会以为"点不动 = 坏了"，
          于是反复点、反复滑 —— 每次操作都堆进事件队列，
          加载完之后一次性执行，界面突然乱跳。

          ✅ 压暗 + 吃掉触摸事件，让"暂时不可用"变成**可见的事实**。
             这比"界面看着正常但没反应"诚实得多。

          ⚠️ 层级要低于进度条本身（进度条 z-index 60，这里 59），
             否则蒙层会把"跳过"按钮也盖住，用户就没法取消了。
        */
        scrimEl = document.createElement('div');
        scrimEl.className = 'seg-scrim';

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

        /*
          ⚠️ 蒙层先插 → 在 DOM 里排在进度条之前，天然在它下面。
             再配合 z-index 明确指定，双保险。
        */
        document.body.appendChild(scrimEl);
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
        /* ⚠️ 每次开始都要清零，否则上一次的 100% 会堵死本次进度 */
        lastPct = 0;

        skipEl.disabled = false;
        skipEl.textContent = t('seg.skip');
        barEl.querySelector('.seg-bar-fill').style.width = '0%';
        pctEl.textContent = '0%';
        textEl.textContent = t('seg.loading');
        barEl.dataset.total = String(total || 0);

        /*
          ══ ⚠️⚠️ 显示前必须**断开过渡**（v0.2.0，实测出的坑）══

          现象：点了切分按钮，进度条**根本不出现** —— 实测
          `getComputedStyle(bar).opacity` 在 2 帧之后仍然是 `0`，
          而 `is-open` class 明明已经加上。

          真因：这是**第二次**使用进度条时的典型症状。
            上次结束时 `hide()` 移除了 `is-open`，过渡把 opacity
            从 1 渐变到 0（240ms）。如果用户在这 240ms 内又点了切分
            （或者上一次的过渡还没跑完），`start()` 立刻加回
            `is-open`。浏览器会把"移除 → 添加"这两个 class 变化
            **合并到同一帧**，等于"没有变化"，于是不启动新过渡，
            opacity 就卡在中间值或 0。

          ✅ 修法（标准做法）：先把 `transition` 置 none、移除 class，
             强制读一次 `offsetHeight` 触发重排（让浏览器**确认**
             样式已经回到初始态），再恢复 transition、加回 class。
             这样新过渡一定从头开始。

          ⚠️ 不能只写 `barEl.offsetHeight;` 而不改 transition ——
             重排会算，但过渡仍然是"同一个未完成的过程"，不会重启。
        */
        barEl.style.transition = 'none';
        barEl.classList.remove('is-open');
        /* 强制重排：读 offsetHeight 会让浏览器把上面的样式状态落实 */
        void barEl.offsetHeight;
        barEl.style.transition = '';
        barEl.classList.add('is-open');

        /* 背景同时压暗 —— 表示"现在不能操作" */
        if (scrimEl) scrimEl.classList.add('is-open');
    }

    /**
     * 进度。
     *
     * @param {number} done  已完成量
     * @param {number} total 总量
     * @param {string} [phase] 阶段标识，决定文案：
     *        'loading' → 「正在加载模型…」
     *        其它/省略 → 按百分比自动选「正在划分段落…」/「正在判定边界…」
     *
     * ⚠️ 必须支持 phase（v0.2.1）：加载模型占前 40% 时间，
     *    那一段如果显示「正在划分段落…」是错的 ——
     *    用户会以为模型早就好了、只是分得慢。
     */
    function progress(done, total, phase) {
        if (!visible || cancelled) return;

        var pct = (total > 0)
            ? Math.max(0, Math.min(100, Math.round(done / total * 100)))
            : 0;

        /*
          ══ ⚠️⚠️ 进度只许前进，不许后退（v0.2.1）══

          用户反馈：「加载直接从 0 跳到 100」。

          除了"没报加载进度"，还有一个原因：进度会**倒退**。
             · 加载阶段报到 40%
             · 进入推理，某个区段从 0 开始报 → 屏幕跳回 40%
             · 下一区段又从头 → 再跳一次
          来回跳几次之后，最后一下跳到 100，主观感受就是"乱跳"。

          ✅ 记住已到达的最高百分比，只接受更大的值。
             真实总进度本来就不会倒退，倒退一定是换算错误。
        */
        if (pct < lastPct) pct = lastPct;
        lastPct = pct;

        barEl.querySelector('.seg-bar-fill').style.width = pct + '%';
        pctEl.textContent = pct + '%';

        /*
          ⚠️ 分段分两个阶段：加载模型 → 算向量 → 判边界。
             每段文案不同，否则用户看到百分比不动却不知道为什么。
        */
        if (phase === 'loading') {
            textEl.textContent = t('seg.loading');
        } else if (pct >= 100) {
            textEl.textContent = t('seg.boundaries');
        } else {
            textEl.textContent = (lastPct <= 40 && pct <= 40)
                ? t('seg.loading')
                : t('seg.working');
        }
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
        if (scrimEl) scrimEl.classList.remove('is-open');
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
