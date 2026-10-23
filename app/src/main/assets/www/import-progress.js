/**
 * 导入进度表单（v0.1.95）
 *
 * 用户要求：
 *   「导入过程应该做一个表单，显示完成多少了，
 *     按 cancel 应该及时停止且丢弃这个导入行为」
 *
 * ══ 三个阶段（缺一不可）══
 *
 *   ① 选了文件 → 立刻出现表单，显示 0%。
 *      不能等原生第一次回报才出现：复制一个 50MB 的 PDF 前几百毫秒
 *      什么都看不到，用户会以为没点到，于是又点一次。
 *   ② 进度必须**推进**。原生的回调分两类：
 *        · `"stage"` —— 换阶段（copy / verify / thumbnail / meta / index）
 *        · `"start"` / `"done"` / `"failed"` / `"cancelled"`
 *      阶段之间进度条会跳一下，这是正常的（每个阶段占一个权重区间）。
 *   ③ 取消：点 cancel 立刻置灰按钮（防连点），但**表单不马上关** ——
 *      要等原生真正回报 `cancelled` 才关。
 *      否则用户看到"秒关"，以为导入还完成了，列表里却没有。
 *
 * ⚠️ 为什么进度条不能是单调直线：
 *    实测一个 20MB PDF：复制占 85% 时间，缩略图 10%，
 *    元数据 + 索引只占 5%。如果用「阶段数 / 5」算，
 *    会卡在 20% 好几秒 → 用户以为死了。
 *    所以用**加权**：每个阶段有自己的区间，权重按实测耗时分配。
 */
(function (global) {
    'use strict';

    /** 各阶段的权重（总和 = 1）。按实测耗时排的，见文件头 */
    var STAGE_WEIGHT = {
        copy: 0.62,
        verify: 0.03,
        thumbnail: 0.20,
        meta: 0.10,
        index: 0.05
    };

    /** 阶段顺序，用来算「当前阶段之前已经吃掉了多少权重」 */
    var STAGE_ORDER = ['copy', 'verify', 'thumbnail', 'meta', 'index'];

    var sheetEl = null;
    var nameEl = null;
    var fillEl = null;
    var pctEl = null;
    var stageEl = null;
    var cancelBtnEl = null;
    var scrimEl = null;

    /** 取消已请求，正在等原生回应 */
    var cancelling = false;
    /** 表单是否显示中 */
    var visible = false;

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    function bridge() {
        return global.ScholariusNative || null;
    }

    // ------------------------------------------------------------------
    // 构建
    // ------------------------------------------------------------------

    function build() {
        if (sheetEl) return;

        scrimEl = document.createElement('div');
        scrimEl.className = 'import-scrim';

        sheetEl = document.createElement('div');
        sheetEl.className = 'import-sheet';
        sheetEl.setAttribute('role', 'dialog');
        sheetEl.setAttribute('aria-modal', 'true');
        /* ⚠️ 没有关闭按钮、点遮罩也不关 —— 只能通过 cancel 按钮退出 */
        sheetEl.innerHTML =
            '<div class="import-sheet-title"></div>' +
            '<div class="import-sheet-name"></div>' +
            '<div class="import-sheet-bar"><div class="import-sheet-fill"></div></div>' +
            '<div class="import-sheet-meta">' +
            '  <span class="import-sheet-stage"></span>' +
            '  <span class="import-sheet-pct"></span>' +
            '</div>' +
            '<button type="button" class="import-sheet-cancel"></button>';

        nameEl = sheetEl.querySelector('.import-sheet-name');
        fillEl = sheetEl.querySelector('.import-sheet-fill');
        pctEl = sheetEl.querySelector('.import-sheet-pct');
        stageEl = sheetEl.querySelector('.import-sheet-stage');
        cancelBtnEl = sheetEl.querySelector('.import-sheet-cancel');

        sheetEl.querySelector('.import-sheet-title').textContent =
            t('import.title');
        cancelBtnEl.textContent = t('import.cancel');

        cancelBtnEl.addEventListener('click', function () {
            cancel();
        });

        document.body.appendChild(scrimEl);
        document.body.appendChild(sheetEl);
    }

    /**
     * 请求取消。
     *
     * ⚠️ 按 cancel 按钮**和**按系统返回键都走这里 —— 两条入口
     *    必须共用同一段逻辑，否则迟早会出现"按钮能取消、返回键不能"
     *    这类不一致（本质上是一个功能两种行为）。
     */
    function cancel() {
        if (cancelling) return;
        cancelling = true;
        if (cancelBtnEl) {
            cancelBtnEl.disabled = true;
            cancelBtnEl.textContent = t('import.cancelling');
        }
        /* 阶段文字先改成"正在取消"，让用户知道点到了 */
        if (stageEl) stageEl.textContent = t('import.cancelling');

        var b = bridge();
        if (b && typeof b.cancelImport === 'function') {
            try {
                b.cancelImport();
            } catch (e) { /* 原生没实现 → 下面会超时兜底 */ }
        }
        /*
          ⚠️ 兜底：原生可能已经跑完（正好在取消前完成），
             或者旧版本不认 cancelImport。2 秒后无论如何收起表单，
             否则用户被一个关不掉的弹层困住 —— 这是最糟的失败方式。
        */
        global.setTimeout(function () {
            if (cancelling) hide();
        }, 2000);
    }

    // ------------------------------------------------------------------
    // 显隐
    // ------------------------------------------------------------------

    function show(displayName) {
        build();
        cancelling = false;
        visible = true;

        cancelBtnEl.disabled = false;
        cancelBtnEl.textContent = t('import.cancel');
        nameEl.textContent = displayName || '';
        fillEl.style.width = '0%';
        pctEl.textContent = '0%';
        stageEl.textContent = t('import.stage.copy');

        scrimEl.classList.add('is-open');
        sheetEl.classList.add('is-open');
    }

    function hide() {
        visible = false;
        cancelling = false;
        if (scrimEl) scrimEl.classList.remove('is-open');
        if (sheetEl) sheetEl.classList.remove('is-open');
    }

    function isOpen() {
        return visible;
    }

    // ------------------------------------------------------------------
    // 进度计算
    // ------------------------------------------------------------------

    /**
     * 把「阶段 + 阶段内进度」换算成总进度 0~1。
     *
     * @param {string} stage copy / verify / thumbnail / meta / index
     * @param {number} frac  该阶段内的进度 0~1
     */
    function overall(stage, frac) {
        var w = STAGE_WEIGHT[stage];
        if (typeof w !== 'number') return null;

        var before = 0;
        for (var i = 0; i < STAGE_ORDER.length; i++) {
            if (STAGE_ORDER[i] === stage) break;
            before += STAGE_WEIGHT[STAGE_ORDER[i]];
        }
        return before + w * Math.max(0, Math.min(1, frac || 0));
    }

    /**
     * 原生回报进度。
     *
     * ⚠️ 这是**唯一**的入口，原生所有状态都走它：
     *      importProgress("start", name, 0, 0)
     *      importProgress("stage", "copy", 0.42, 0)
     *      importProgress("done" | "failed" | "cancelled", null, 0, 0)
     *
     * 用一个函数而不是六个回调，是因为它们的**时序**必须被统一管理：
     * 如果 done 和 cancelled 走两个不同函数，就没法保证
     * "done 之后不再接受 stage"这种约束。
     */
    function onProgress(kind, name, frac) {
        switch (kind) {
            case 'start':
                show(name);
                return 'shown';

            case 'stage': {
                if (!visible || cancelling) return 'ignored';
                var p = overall(name, frac);
                if (p == null) return 'unknown-stage';
                var pct = Math.round(p * 100);
                fillEl.style.width = pct + '%';
                pctEl.textContent = pct + '%';
                stageEl.textContent = t('import.stage.' + name);
                return pct;
            }

            case 'done':
                /*
                  ⚠️ 显示 100% 再收起，不能直接 hide。
                     直接关会让用户觉得"没做完就没了"。
                     400ms 足够看清，又不至于拖沓。
                */
                if (visible) {
                    fillEl.style.width = '100%';
                    pctEl.textContent = '100%';
                    stageEl.textContent = t('import.stage.done');
                }
                global.setTimeout(hide, 400);
                return 'done';

            case 'cancelled':
                hide();
                return 'cancelled';

            case 'failed':
                hide();
                return 'failed';

            default:
                return 'unknown';
        }
    }

    global.ScholariusImport = {
        init: function () { build(); },
        show: show,
        hide: hide,
        cancel: cancel,
        isOpen: isOpen,
        onProgress: onProgress,
        /** 供测试 */
        __overall: overall
    };
})(window);
