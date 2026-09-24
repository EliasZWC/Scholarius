/*
  Scholarius — 发表物简称（管理页）。

  ══ 这是什么 ══

  用户维护一张「全名 → 简称」的映射表：

      Neural Information Processing Systems  →  NIPS
      Computer Vision and Pattern Recognition →  CVPR

  卡片上的「载体名」优先显示简称（见 meta.js 的 venueNameOf）——
  因为卡片宽度有限，全名会被截断成
  "Neural Information Processing S…"，反而看不出是哪个会。

  ══ 为什么存在 localStorage 而不是原生数据库 ══

  ⚠️ 这是**用户偏好**，不是文献数据：
     · 与语言 / 主题 / 字体一样属于「本机设置」；
     · 换一台设备重新配一遍是可接受的（本来就只有几十条）；
     · 走原生存储要为它单独设计一张表和一套 CRUD 桥接，
       收益不足以抵这个成本。

  ⚠️ 代价：**清应用数据会丢**，且不跨设备同步。
     若将来有了账号云同步，这里要跟着一起迁过去。

  ══ 匹配规则 ══

  ⚠️ 匹配是**全名精确相等**（去首尾空格 + 大小写不敏感）。

     为什么不做「包含」匹配：
       "Neural Information Processing Systems" 与
       "Advances in Neural Information Processing Systems" 是**两个不同的会议**
       （后者是 NeurIPS 的正式全称）。用包含匹配会把两者混为一谈，
       用户看到 NIPS 而实际是另一个会 —— 这种错比不显示更难发现。

     代价：用户粘贴的全名如果与存的不完全一致（多一个逗号、
       翻译过的中文名），就匹配不上。这是**保守的正确取舍**：
       匹配不上只是退回显示全名，不会显示错的简称。
*/
(function (global) {
    'use strict';

    var STORAGE_KEY = 'scholarius.venueShortcuts';

    var pageEl = null;
    var listEl = null;
    var fullInput = null;
    var shortInput = null;
    var addBtn = null;
    var closeBtn = null;
    var backdropEl = null;

    /** [{ full: string, short: string }]，顺序即用户添加顺序 */
    var entries = [];

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    // --- 持久化 -------------------------------------------------------------

    /**
     * 读存储。
     *
     * ⚠️ 三重防御，任何一步失败都退化成「空表」而不是抛异常：
     *    ① localStorage 本身可能不可用（隐私模式 / 旧 WebView）；
     *    ② 存的内容可能不是合法 JSON（被别的东西写坏）；
     *    ③ 解析出来可能不是数组 / 元素缺字段（版本变动）。
     *
     *    宁可让用户看到空列表重新配，也不要让设置页整个崩掉。
     */
    function load() {
        var raw;
        try {
            raw = global.localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            return [];
        }
        if (!raw) return [];

        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return [];
        }
        if (!Array.isArray(parsed)) return [];

        var out = [];
        for (var i = 0; i < parsed.length; i++) {
            var it = parsed[i];
            if (!it || typeof it !== 'object') continue;
            var full = typeof it.full === 'string' ? it.full.trim() : '';
            var short = typeof it.short === 'string' ? it.short.trim() : '';
            // 两个字段都有的条目才算合法
            if (full && short) out.push({ full: full, short: short });
        }
        return out;
    }

    function save() {
        try {
            global.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        } catch (e) {
            // 存不下就算了，内存里的改动仍然生效（本次会话有效）
        }
    }

    // --- 查询（供 vault.js 用）----------------------------------------------

    /**
     * 按全名查简称。
     *
     * @param {string} fullName 载体全名
     * @returns {string} 简称；没配过则返回空串（调用方据此回退显示全名）
     */
    function lookup(fullName) {
        var key = String(fullName == null ? '' : fullName).trim().toLowerCase();
        if (!key) return '';
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].full.toLowerCase() === key) {
                return entries[i].short;
            }
        }
        return '';
    }

    // --- 渲染 ---------------------------------------------------------------

    function render() {
        if (!listEl) return;
        listEl.textContent = '';

        if (!entries.length) {
            var box = document.createElement('li');
            box.className = 'shortcut-empty';
            var title = document.createElement('p');
            title.className = 'shortcut-empty-title';
            title.textContent = t('shortcut.empty');
            var hint = document.createElement('p');
            hint.className = 'shortcut-empty-hint';
            hint.textContent = t('shortcut.emptyHint');
            box.appendChild(title);
            box.appendChild(hint);
            listEl.appendChild(box);
            return;
        }

        entries.forEach(function (entry, index) {
            var li = document.createElement('li');
            li.className = 'shortcut-item';

            // 键值对：上简称（醒目）、下全名（次要）
            //
            // ⚠️ 顺序是「简称在上」而不是「全名在上」。
            //    用户扫这张表是想确认「NIPS 指向哪个全名」——
            //    简称是检索用的键，放上面更好找。
            var text = document.createElement('div');
            text.className = 'shortcut-item-text';
            var s = document.createElement('span');
            s.className = 'shortcut-item-short';
            s.textContent = entry.short;
            var f = document.createElement('span');
            f.className = 'shortcut-item-full';
            f.textContent = entry.full;
            text.appendChild(s);
            text.appendChild(f);

            var del = document.createElement('button');
            del.className = 'icon-button shortcut-item-del';
            del.type = 'button';
            del.setAttribute('aria-label', t('shortcut.delete'));
            del.innerHTML =
                '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12z' +
                'M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
            del.addEventListener('click', function () {
                entries.splice(index, 1);
                save();
                render();
                syncSettingRow();
            });

            li.appendChild(text);
            li.appendChild(del);
            listEl.appendChild(li);
        });
    }

    // --- 增删 ---------------------------------------------------------------

    /**
     * 同步设置页那行的计数。
     *
     * ⚠️ 增/删之后**必须**调它。
     *    实测踩过：在管理页里加了两条，返回设置页时那一行仍是空的 ——
     *    因为 refresh() 只在 init 和语言切换时跑，
     *    而管理页里的改动没往设置行回写。
     */
    function syncSettingRow() {
        var valueEl = document.getElementById('setting-venue-shortcut-value');
        if (!valueEl) return;
        valueEl.textContent = entries.length
            ? t('shortcut.count').replace('{n}', String(entries.length))
            : '';
    }

    function add() {
        if (!fullInput || !shortInput) return;

        var full = fullInput.value.trim();
        var short = shortInput.value.trim();

        if (!full || !short) {
            toast(t('shortcut.needBoth'));
            return;
        }

        /*
          ⚠️ 查重按**全名**（大小写不敏感）。
             同一个会议配两条简称没有意义，用户多半是重复添加了。
             简称重复则**允许** —— 不同会议偶尔会有相同缩写
             （实际存在，如 "ACL" 同时指 Association for Computational
             Linguistics 和 Association for Computational Learning）。
        */
        var lower = full.toLowerCase();
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].full.toLowerCase() === lower) {
                toast(t('shortcut.duplicate'));
                return;
            }
        }

        entries.push({ full: full, short: short });
        save();
        render();
        syncSettingRow();

        // 清空输入框，方便连着录入多条
        fullInput.value = '';
        shortInput.value = '';
        fullInput.focus();
    }

    function toast(msg) {
        if (global.ScholariusUI && typeof global.ScholariusUI.toast === 'function') {
            global.ScholariusUI.toast(msg);
        }
    }

    // --- 开关 ---------------------------------------------------------------

    function open() {
        if (!pageEl) return;
        // 每次打开都重读存储 —— 万一别处改过（将来的云同步），不会用到旧值
        entries = load();
        render();

        pageEl.hidden = false;
        // 强制布局后再加 is-open，否则滑入动画不触发（与 openSheet 同一坑）
        if (pageEl.offsetWidth < 0) return;
        pageEl.classList.add('is-open');
    }

    function close() {
        if (!pageEl) return;
        pageEl.classList.remove('is-open');
        global.setTimeout(function () {
            // 期间可能又被打开，要复查
            if (!pageEl.classList.contains('is-open')) {
                pageEl.hidden = true;
            }
        }, 300);
    }

    function isOpen() {
        return !!(pageEl && !pageEl.hidden);
    }

    // --- 初始化 -------------------------------------------------------------

    function init() {
        pageEl = document.getElementById('shortcut-page');
        if (!pageEl) return;

        listEl = document.getElementById('shortcut-list');
        fullInput = document.getElementById('shortcut-full');
        shortInput = document.getElementById('shortcut-short');
        addBtn = document.getElementById('shortcut-add');
        closeBtn = document.getElementById('shortcut-close');
        backdropEl = document.getElementById('shortcut-backdrop');

        if (addBtn) {
            addBtn.addEventListener('click', add);
        }
        if (closeBtn) {
            closeBtn.addEventListener('click', close);
        }
        if (backdropEl) {
            backdropEl.addEventListener('click', close);
        }

        /*
          ⚠️ 简称框里按回车 = 添加。
             用户填完简称后回车是最自然的动作（表单习惯）；
             不给这个响应他会以为界面卡住了。
        */
        if (shortInput) {
            shortInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                }
            });
        }

        // 入口：设置页那一行
        var row = document.getElementById('setting-venue-shortcut');
        if (row) {
            row.addEventListener('click', open);
        }

        entries = load();
        refresh();
    }

    /**
     * 刷新设置页那一行的计数，并在管理页开着时重绘列表。
     *
     * ⚠️ 由 app.js 在**语言切换后**调用 ——
     *    否则中文用户切到英文后，那一行还写着「已保存 3 条」。
     */
    function refresh() {
        entries = load();
        syncSettingRow();
        if (isOpen()) render();
    }

    global.ScholariusShortcut = {
        init: init,
        open: open,
        close: close,
        isOpen: isOpen,
        lookup: lookup,
        refresh: refresh
    };
})(window);
