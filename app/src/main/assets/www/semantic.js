/*
 * ══ 语义分段设置（v0.1.94）══
 *
 * 用户要求（原话）：
 *   「这个吧，我觉得可以放在设置里面，到时候用户自己选择要不要用语义模型
 *     来分，如果要，让用户自己下载，这就和安装包解体了」
 *   「设置的 Vault 区新加一个语义模型选项，然后选择关闭，也可以选开启，
 *     选开启后自动检测是否本地下了模型，没有就弹出表单下载，
 *     否则回到 off 状态」
 *
 * ══ 这个文件只做"开关 + 模型存在性"两件事 ══
 *
 * ⚠️ 分段本身**不在这里**。
 *    这里只负责回答两个问题：
 *      ① 用户想不想用语义分段？（持久化一个布尔）
 *      ② 模型文件在不在？（查原生）
 *    真正的分段在 PdfText 提取层，读这两个答案。
 *
 * ══ 为什么开关不能"假装打开" ══
 *
 * 用户明确要求：「没有就弹出表单下载，否则回到 off 状态」。
 * 这是对的 —— 如果开关显示 On 而模型不存在，用户会以为段落变好了，
 * 其实走的还是标点分段。**撒谎的开关比没有开关更糟。**
 *
 * 所以状态机只有三种：
 *
 *     off       → 用户没开
 *     on        → 用户开了 **且** 模型在本地
 *     （没有"on 但没有模型"这个状态）
 */
(function (global) {
    'use strict';

    var LS_KEY = 'scholarius.semantic.enabled';

    /** 设置页那一行的 value 元素 */
    var valueEl = null;
    /** 下载确认表单（弹层） */
    var sheetEl = null;
    var sheetDescEl = null;
    var sheetStatusEl = null;
    var sheetOkEl = null;
    var sheetCancelEl = null;
    var sheetScrimEl = null;
    /** 进度条（v0.1.95） */
    var progressEl = null;
    var progressFillEl = null;
    var progressPctEl = null;

    /** 模型是否已在本地。null = 还没问过原生 */
    var modelReady = null;
    /** 下载进行中（防止重复点） */
    var downloading = false;

    /**
     * 取文案。
     *
     * ⚠️ 必须自己包一层：`t` 不是全局函数，它在每个模块里各自定义
     *    （见 shortcut.js 同名函数）。直接用 `t(...)` 会报
     *    `ReferenceError: t is not defined` —— 实测踩到。
     * ⚠️ i18n 未就绪时退回 key 本身，而不是抛错：
     *    初始化顺序变化时不至于让整个设置页崩掉。
     */
    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    // ------------------------------------------------------------------
    // 原生桥
    // ------------------------------------------------------------------

    function bridge() {
        return global.ScholariusNative || null;
    }

    /**
     * 问原生：模型文件在不在？
     *
     * ⚠️ 原生没实现这个方法时（老版本）返回 **false** ——
     *    宁可显示"需要一个模型"，也不要假装有。
     */
    function checkModel() {
        var b = bridge();
        if (!b || typeof b.semanticModelReady !== 'function') return false;
        try {
            return !!b.semanticModelReady();
        } catch (e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // 持久化
    // ------------------------------------------------------------------

    function loadEnabled() {
        try {
            return global.localStorage.getItem(LS_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function saveEnabled(on) {
        try {
            global.localStorage.setItem(LS_KEY, on ? '1' : '0');
        } catch (e) { /* 隐私模式下写不进，忽略 */ }
    }

    /**
     * 当前**有效**状态。
     *
     * ⚠️ 必须两个条件同时成立：用户想开 **且** 模型在。
     *    这就是上面说的"没有 on-but-no-model 状态"。
     */
    function isEnabled() {
        return loadEnabled() && !!modelReady;
    }

    // ------------------------------------------------------------------
    // 设置行
    // ------------------------------------------------------------------

    function syncSettingRow() {
        if (!valueEl) return;
        /*
          ⚠️ 显示的是**有效状态**而不是用户的意愿。
             如果用户上次开了、但模型被删了，这里必须显示「关闭」——
             否则他以为在生效。见文件头那段说明。
        */
        valueEl.textContent = isEnabled() ? t('semantic.on') : t('semantic.off');
    }

    // ------------------------------------------------------------------
    // 下载确认表单
    // ------------------------------------------------------------------

    function buildSheet() {
        if (sheetEl) return;

        sheetScrimEl = document.createElement('div');
        sheetScrimEl.className = 'sheet-scrim';
        sheetScrimEl.hidden = true;

        sheetEl = document.createElement('section');
        sheetEl.className = 'sheet';
        sheetEl.setAttribute('role', 'dialog');
        sheetEl.setAttribute('aria-modal', 'true');
        sheetEl.setAttribute('aria-labelledby', 'sheet-semantic-title');
        sheetEl.hidden = true;

        var title = document.createElement('h2');
        title.className = 'sheet-title';
        title.id = 'sheet-semantic-title';
        title.textContent = t('semantic.title');
        sheetEl.appendChild(title);

        sheetDescEl = document.createElement('p');
        sheetDescEl.className = 'sheet-text';
        sheetDescEl.textContent = t('semantic.needModel');
        sheetEl.appendChild(sheetDescEl);

        sheetStatusEl = document.createElement('p');
        sheetStatusEl.className = 'sheet-text';
        sheetStatusEl.hidden = true;
        sheetEl.appendChild(sheetStatusEl);

        /*
          进度条（v0.1.95）—— 复用更新弹层那套 .update-progress 结构，
          不新造样式（见 index.html 的 #update-progress）。
        */
        progressEl = document.createElement('div');
        progressEl.className = 'update-progress';
        progressEl.hidden = true;

        var track = document.createElement('div');
        track.className = 'update-track';
        progressFillEl = document.createElement('span');
        progressFillEl.className = 'update-fill';
        track.appendChild(progressFillEl);
        progressEl.appendChild(track);

        progressPctEl = document.createElement('span');
        progressPctEl.className = 'update-percent';
        progressEl.appendChild(progressPctEl);

        sheetEl.appendChild(progressEl);

        var actions = document.createElement('div');
        actions.className = 'form-actions';

        sheetCancelEl = document.createElement('button');
        sheetCancelEl.type = 'button';
        sheetCancelEl.className = 'btn';
        sheetCancelEl.textContent = t('semantic.cancel');
        sheetCancelEl.addEventListener('click', onCancel);
        actions.appendChild(sheetCancelEl);

        sheetOkEl = document.createElement('button');
        sheetOkEl.type = 'button';
        sheetOkEl.className = 'btn btn-action';
        sheetOkEl.textContent = t('semantic.download');
        sheetOkEl.addEventListener('click', startDownload);
        actions.appendChild(sheetOkEl);

        sheetEl.appendChild(actions);
        document.body.appendChild(sheetScrimEl);
        document.body.appendChild(sheetEl);
    }

    function openSheet() {
        buildSheet();
        sheetScrimEl.hidden = false;
        sheetEl.hidden = false;
        // 下一帧加 is-open，让 CSS 过渡生效
        global.setTimeout(function () {
            sheetEl.classList.add('is-open');
            sheetScrimEl.classList.add('is-open');
        }, 0);
    }

    function closeSheet() {
        if (!sheetEl) return;
        sheetEl.classList.remove('is-open');
        sheetScrimEl.classList.remove('is-open');
        /*
          ⚠️ 等过渡结束再 hidden，否则动画看不到。
             期间可能又被打开 —— 所以 setTimeout 里要复查。
        */
        global.setTimeout(function () {
            if (!sheetEl.classList.contains('is-open')) {
                sheetEl.hidden = true;
                sheetScrimEl.hidden = true;
            }
        }, 240);
    }

    function isSheetOpen() {
        return !!(sheetEl && !sheetEl.hidden);
    }

    // ------------------------------------------------------------------
    // 下载
    // ------------------------------------------------------------------

    function setStatus(text, isError) {
        if (!sheetStatusEl) return;
        if (!text) {
            sheetStatusEl.hidden = true;
            return;
        }
        sheetStatusEl.hidden = false;
        sheetStatusEl.textContent = text;
        sheetStatusEl.classList.toggle('is-error', !!isError);
    }

    /**
     * 取消。
     *
     * ══ ⚠️⚠️ 取消不是"关掉表单"，而是**真的停止并丢弃** ══
     *
     * 用户要求（原话）：
     *   「如果用户想要在导入过程中停下，按 cancel 应该及时停止
     *     且丢弃这个导入行为」
     *
     * ✅ 所以下载中按取消要：
     *    ① 通知原生停止下载线程
     *    ② 原生清理已下载的文件（见 SemanticModel.download 的 finally）
     *    ③ 状态回到 off
     *
     * ⚠️ 只关表单不通知原生，下载会在后台继续跑完，
     *    然后弹一个"下载完成"—— 用户明明取消了。
     */
    function onCancel() {
        if (downloading) {
            var b = bridge();
            if (b && typeof b.semanticCancelDownload === 'function') {
                b.semanticCancelDownload();
            }
            downloading = false;
        }
        /* 取消后一律回到 off（用户原话：「否则回到 off 状态」） */
        modelReady = false;
        saveEnabled(false);
        syncSettingRow();
        setStatus('', false);
        if (progressEl) progressEl.hidden = true;
        if (sheetOkEl) {
            sheetOkEl.disabled = false;
            sheetOkEl.textContent = t('semantic.download');
        }
        if (sheetCancelEl) sheetCancelEl.disabled = false;
        closeSheet();
    }

    /**
     * 下载进度回调（原生 → 网页）。
     *
     * ══ ⚠️⚠️ 必须节流（v0.1.95 实测）══
     *
     * 用户反馈：
     *   「点击 Download 之后一瞬间的 download...，然后瞬间回到 Download」
     *
     * 实测原生推送 **1809 次** 进度（每 64KB 一次）——
     * 每次都是一次 `evaluateJavascript` 跨语言调用，
     * 把 WebView 的 UI 线程占满，导致：
     *   · 进度条**根本来不及重绘**（实测 barWidth 一直是空串）
     *   · 按钮文字来回闪
     * 也就是说：进度条写了，但用户看不见。
     *
     * ✅ 只接受**百分比变化**时才更新 DOM。
     *    29MB / 1% ≈ 300KB ≈ 5 次回调 —— 从 1809 次降到约 100 次。
     *
     * ⚠️ 不要改成"每 N 次更新一次"：那样在不同网速下表现不一致。
     *    按百分比变化判断，慢网和快网都是 100 次左右。
     *
     * @param {number} bytes 已下载字节数
     */
    var lastPct = -1;

    function downloadProgress(bytes) {
        if (!downloading || !progressEl) return;

        var b = bridge();
        var total = (b && typeof b.semanticTotalBytes === 'function')
            ? Number(b.semanticTotalBytes()) : 0;
        if (!total || total <= 0) return;

        var pct = Math.max(0, Math.min(100, Math.round(bytes * 100 / total)));
        /* ⚠️ 百分比没变就不碰 DOM —— 见上面那段说明 */
        if (pct === lastPct) return;
        lastPct = pct;

        progressEl.hidden = false;
        progressFillEl.style.width = pct + '%';
        progressPctEl.textContent = pct + '%';
    }

    /**
     * 开始下载模型。
     *
     * ⚠️ 实际下载由**原生**做（要写应用私有目录），这里只发指令。
     * ⚠️ 下载中**取消按钮保持可用** —— 用户要能随时停。
     *    开始下载时只禁用「下载」按钮本身，不禁用取消。
     */
    function startDownload() {
        if (downloading) return;

        var b = bridge();
        if (!b || typeof b.semanticDownloadModel !== 'function') {
            setStatus(t('semantic.failed'), true);
            return;
        }

        downloading = true;
        sheetOkEl.disabled = true;
        sheetOkEl.textContent = t('semantic.downloading');
        setStatus('', false);

        /* 进度条归零并显示 */
        lastPct = -1;
        if (progressEl) {
            progressEl.hidden = false;
            progressFillEl.style.width = '0%';
            progressPctEl.textContent = '0%';
        }

        try {
            b.semanticDownloadModel();
        } catch (e) {
            downloading = false;
            sheetOkEl.disabled = false;
            sheetOkEl.textContent = t('semantic.download');
            setStatus(t('semantic.failed'), true);
        }
    }

    /**
     * 原生 → 网页：下载结束。
     *
     * @param {boolean} ok 是否成功
     */
    function downloadFinished(ok) {
        downloading = false;
        if (sheetOkEl) {
            sheetOkEl.disabled = false;
            sheetOkEl.textContent = t('semantic.download');
        }
        if (sheetCancelEl) sheetCancelEl.disabled = false;

        /*
          ══ ⚠️⚠️ 完成时**强制**置 100%（v0.1.95 实测）══

          实测：进度条停在 95% 就结束了 —— 因为 TOTAL_BYTES 是估算，
          与实际总量（29,430,672 字节）有偏差。

          卡在 95% 然后突然关闭，看起来就像"下载失败但界面不动"。

          ✅ 成功时把进度条填满再收起。这样无论总量估得准不准，
             用户看到的都是"100% → 完成"，语义明确。
        */
        if (ok && progressEl) {
            progressFillEl.style.width = '100%';
            progressPctEl.textContent = '100%';
            /* 让 100% 停留一下再隐藏，否则一闪而过看不清 */
            global.setTimeout(function () {
                if (progressEl) progressEl.hidden = true;
            }, 400);
        } else if (progressEl) {
            progressEl.hidden = true;
        }

        if (ok) {
            modelReady = true;
            saveEnabled(true);
            syncSettingRow();
            setStatus(t('semantic.ready'), false);
            global.setTimeout(closeSheet, 600);
        } else {
            /*
              ⚠️ 失败时**必须回到 off**（用户原话：「否则回到 off 状态」）。
                 不能留下"用户点了开启但没成功"的中间态。
            */
            modelReady = false;
            saveEnabled(false);
            syncSettingRow();
            setStatus(t('semantic.failed'), true);
        }
    }

    // ------------------------------------------------------------------
    // 开关
    // ------------------------------------------------------------------

    /**
     * 用户点了设置行。
     *
     * 语义（严格按用户要求）：
     *   · 当前 on  → 关掉（清除标记）
     *   · 当前 off → 先查模型
     *       · 有 → 打开
     *       · 没有 → 弹下载表单；用户取消则**保持 off**
     */
    function toggle() {
        if (isEnabled()) {
            saveEnabled(false);
            syncSettingRow();
            return;
        }

        modelReady = checkModel();
        if (modelReady) {
            saveEnabled(true);
            syncSettingRow();
            /*
              ⚠️ 重新打开时必须重置引擎状态（v0.1.96）。

              引擎有熔断（连续失败 3 次就停止尝试）。如果不重置，
              用户关掉再打开也还是熔断状态 —— 开关看着是"开启"，
              实际每次分段都直接失败，正文只能退回原始块。
              那会让人以为"功能坏了、修不好"。

              重置代价是一次重新加载（17MB 本地读，约 1 秒），
              但只在用户主动操作时发生，可接受。
            */
            if (global.ScholariusSeg &&
                typeof global.ScholariusSeg.retry === 'function') {
                global.ScholariusSeg.retry();
            }
            return;
        }

        /* 没有模型 → 弹表单。此时**状态仍是 off**（还没写标记） */
        syncSettingRow();
        openSheet();
    }

    // ------------------------------------------------------------------
    // 初始化
    // ------------------------------------------------------------------

    function init() {
        valueEl = document.getElementById('setting-semantic-value');

        modelReady = checkModel();
        /*
          ⚠️ 迁移：上次开了、但模型已经不在了（用户清了数据 / 换设备）
             → 把标记清掉，让状态和实际一致。
        */
        if (loadEnabled() && !modelReady) {
            saveEnabled(false);
        }
        syncSettingRow();

        var row = document.getElementById('setting-semantic');
        if (row) row.addEventListener('click', toggle);
    }

    /**
     * 语言切换后刷新文案。
     *
     * ⚠️ 由 app.js 在切语言时调用（与 ScholariusShortcut.refresh 同理）——
     *    否则英文用户切到中文后，这一行还写着 "Off"。
     */
    function refresh() {
        syncSettingRow();
        /*
          ⚠️ 表单里的文案也要更新。它可能是懒创建的 ——
             没创建过就不用管（下次打开会用新语言重建）。
        */
        if (sheetEl) {
            sheetDescEl.textContent = t('semantic.needModel');
            sheetOkEl.textContent = t('semantic.download');
            sheetCancelEl.textContent = t('semantic.cancel');
        }
    }

    global.ScholariusSemantic = {
        init: init,
        refresh: refresh,
        isEnabled: isEnabled,
        downloadFinished: downloadFinished,
        downloadProgress: downloadProgress,
        cancelDownload: onCancel,
        isSheetOpen: isSheetOpen,
        closeSheet: closeSheet,
        /* 供测试：强制重查模型 */
        recheck: function () {
            modelReady = checkModel();
            syncSettingRow();
            return modelReady;
        }
    };
})(window);
