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
    /** 左上角的返回按钮（不是叉号 —— 这是设置项的子页，见 index.html 的注释） */
    var backBtn = null;
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

            /*
              ⚠️⚠️ 整行是一个 <button>，用来进入编辑表单。

                 之前这里是个 <li>，右侧另放一个 40×40 的图标删除按钮。
                 用户反馈「无法删除和修改」，两个问题都在这个设计上：

                 · **无法修改** —— 根本没有编辑功能，只有删除。
                   用户配错一个字母只能删掉重建，而"全名"很长，
                   重打一遍极其烦人。

                 · **无法删除** —— 删除只能靠点中右下角那个 40×40 的小圆点。
                   在手机上手势稍一移动就被 WebView 判定成滚动，
                   click 根本不触发。整个条目那么大一片区域，能点的只有那一小块。

                 改成"点整行 → 弹编辑表单"，一次解决两个问题：
                   ① 修改有了；
                   ② 删除按钮从表单里出，比那个小圆点大得多，
                      而且不再依赖精准点击。
            */
            var btn = document.createElement('button');
            btn.className = 'shortcut-item-btn';
            btn.type = 'button';
            btn.setAttribute('aria-haspopup', 'dialog');
            btn.setAttribute('aria-label', entry.short + ' — ' + t('shortcut.edit'));

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

            // 右侧的 ›（chevron），提示"点进去能改"
            var chev = document.createElement('span');
            chev.className = 'shortcut-item-chev';
            chev.setAttribute('aria-hidden', 'true');
            chev.innerHTML =
                '<svg viewBox="0 0 24 24" focusable="false">' +
                '<path d="M9.29 6.71a.996.996 0 0 0 0 1.41L13.17 12l-3.88 3.88a.996.996 0 1 0 ' +
                '1.41 1.41l4.59-4.59a.996.996 0 0 0 0-1.41L10.7 6.7a.996.996 0 0 0-1.41 0z"/>' +
                '</svg>';

            btn.appendChild(text);
            btn.appendChild(chev);
            btn.addEventListener('click', function () {
                openEditForm(index);
            });

            li.appendChild(btn);
            listEl.appendChild(li);
        });
    }

    // --- 增删改 -------------------------------------------------------------

    /*
      ══ 编辑表单 ══

      点列表里任意一行弹出，用来**修改**一条已存的映射，或在里面**删除**它。

      ⚠️ 为什么单独做一个表单，而不是把列表行做成可直接编辑的输入框：
         表单是"聚焦一件事"的场合，用户点进来就是为了改这一条，
         改完就走。列表行如果直接放输入框，会变成十几行同时在编辑状态，
         而且"哪个输入框属于哪一行"在视觉上很难一眼分清。

      ⚠️ 用 .sheet（底部弹层）而不是新开一页：
         只改两个短字段，弹层够了，且不打断"我刚在看设置"的上下文。
         键盘弹起时 .sheet 有 --keyboard 补偿（见 styles.css）。
    */
    var editSheetEl = null;
    var editScrimEl = null;
    var editIndex = -1;

    function buildEditSheet() {
        if (editSheetEl) return;

        editScrimEl = document.createElement('div');
        editScrimEl.className = 'sheet-scrim';
        editScrimEl.hidden = true;
        editScrimEl.addEventListener('click', closeEditForm);

        editSheetEl = document.createElement('div');
        editSheetEl.className = 'sheet';
        editSheetEl.setAttribute('role', 'dialog');
        editSheetEl.hidden = true;
        editSheetEl.innerHTML =
            '<div class="shortcut-edit-head">' +
            '<div class="sheet-title title-text" data-edit-title></div>' +
            '<button class="icon-button shortcut-edit-del" type="button" data-edit-del></button>' +
            '</div>' +
            '<input class="shortcut-input" type="text" data-edit-full ' +
            'autocomplete="off" autocapitalize="off" spellcheck="false" />' +
            '<input class="shortcut-input shortcut-edit-short" type="text" data-edit-short ' +
            'autocomplete="off" autocapitalize="off" spellcheck="false" />';
        // 上面两个 input 的 placeholder / aria-label 在 open 时按语言填

        /*
          ⚠️ 删除放在**标题栏右侧**，不放在底部按钮区。

             理由：底部只有左/右两个位置（.form-actions 是 space-between），
             而"保存"必须占右边（它是主操作）。若把删除也塞进底部，
             它会和"取消"或"保存"挤在一起 —— 破坏性操作紧挨着主操作，
             误触代价太大。

             放到标题栏右侧后：底部是干净的 取消 / 保存，
             删除单独待在右上角，与项目里"标题栏右一个操作"的惯例一致
             （见 .detail-header / .shortcut-head）。
        */
        var delBtn = editSheetEl.querySelector('[data-edit-del]');
        delBtn.addEventListener('click', function () {
            var idx = editIndex;
            if (idx < 0 || idx >= entries.length) return closeEditForm();
            entries.splice(idx, 1);
            save();
            render();
            syncSettingRow();
            closeEditForm();
            toast(t('shortcut.deleted'));
        });

        var actions = document.createElement('div');
        actions.className = 'form-actions';

        var cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.type = 'button';
        cancel.textContent = t('action.cancel');
        cancel.addEventListener('click', closeEditForm);

        /*
          ⚠️⚠️ 必须有「保存」按钮，不能只靠回车。

             第一版我只绑了 Enter 键就收工了 —— 实测在手机上是
             不可用的：软键盘的"回车"是换行/完成，各机型行为不一，
             而且用户改完一个字，第一反应是找按钮，不是敲回车。
             没有保存按钮 = 用户改完不知道怎么存 = "无法修改"。

          ⚠️ 布局：取消（左） / 保存（右），删除放在**中间偏左**？
             不 —— 底部只有两个位置（.form-actions 是 space-between），
             所以做成三个按钮会是 左/中/右。

             但破坏性操作不该和"确认"并排抢位置。所以这里用
             取消（左）+ 保存（右），删除移到**表单标题右边**，
             作为一个图标按钮 —— 与项目里"标题栏右侧一个操作"的
             惯例一致（见 .detail-header / .shortcut-head）。
        */
        var saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary';
        saveBtn.type = 'button';
        saveBtn.textContent = t('action.save');
        saveBtn.addEventListener('click', saveEdit);

        actions.appendChild(cancel);
        actions.appendChild(saveBtn);
        editSheetEl.appendChild(actions);

        var root = document.getElementById('shortcut-page');
        if (root) {
            root.appendChild(editScrimEl);
            root.appendChild(editSheetEl);
        }
    }

    function openEditForm(index) {
        buildEditSheet();
        if (!editSheetEl) return;
        if (index < 0 || index >= entries.length) return;

        editIndex = index;
        var entry = entries[index];

        var titleEl = editSheetEl.querySelector('[data-edit-title]');
        var fullEl = editSheetEl.querySelector('[data-edit-full]');
        var shortEl = editSheetEl.querySelector('[data-edit-short]');

        // ⚠️ 每次打开都重填文案 —— 语言可能在两次打开之间切换过
        titleEl.textContent = t('shortcut.edit');
        fullEl.placeholder = t('shortcut.fullPlaceholder');
        shortEl.placeholder = t('shortcut.shortPlaceholder');
        fullEl.setAttribute('aria-label', t('shortcut.fullLabel'));
        shortEl.setAttribute('aria-label', t('shortcut.shortLabel'));

        // 删除按钮的图标 + 无障碍名（也要按语言重填）
        var delBtn = editSheetEl.querySelector('[data-edit-del]');
        delBtn.setAttribute('aria-label', t('action.delete'));
        /*
          ⚠️ 图标路径用 ScholariusUI.icon，不在本地手写 SVG ——
             项目里"凡是图标路径只在 components.js 一处定义"的规矩。
        */
        var ui = global.ScholariusUI;
        if (ui && ui.icon) {
            delBtn.innerHTML = ui.icon('trash');
        } else {
            delBtn.textContent = t('action.delete');
        }

        fullEl.value = entry.full;
        shortEl.value = entry.short;

        editScrimEl.hidden = false;
        editSheetEl.hidden = false;
        // 强制布局后再加 is-open，否则滑入动画不触发（与 open() 同一坑）
        if (editSheetEl.offsetWidth < 0) return;
        editScrimEl.classList.add('is-open');
        editSheetEl.classList.add('is-open');

        fullEl.focus();

        // 回车 = 保存
        fullEl.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
        };
        shortEl.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
        };
    }

    function saveEdit() {
        if (editIndex < 0 || editIndex >= entries.length) return closeEditForm();

        var fullEl = editSheetEl.querySelector('[data-edit-full]');
        var shortEl = editSheetEl.querySelector('[data-edit-short]');

        var full = fullEl.value.trim();
        var short = shortEl.value.trim();

        if (!full || !short) {
            toast(t('shortcut.needBoth'));
            return;
        }

        /*
          ⚠️ 改名查重时要**跳过自己**，否则改简称（全名没动）会被
             自己的旧条目判成重复，导致永远存不进去。
        */
        var lower = full.toLowerCase();
        for (var i = 0; i < entries.length; i++) {
            if (i !== editIndex && entries[i].full.toLowerCase() === lower) {
                toast(t('shortcut.duplicate'));
                return;
            }
        }

        entries[editIndex] = { full: full, short: short };
        save();
        render();
        syncSettingRow();
        closeEditForm();
    }

    function closeEditForm() {
        if (!editSheetEl) return;
        editIndex = -1;
        editSheetEl.classList.remove('is-open');
        editScrimEl.classList.remove('is-open');
        global.setTimeout(function () {
            /*
              ⚠️ 期间可能又被打开，要复查（与 close() 同一个坑）。
            */
            if (!editSheetEl.classList.contains('is-open')) {
                editSheetEl.hidden = true;
                editScrimEl.hidden = true;
            }
        }, 240);
    }

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
        /*
          ⚠️ 一并收起编辑表单 —— 否则关掉管理页时，
             它作为子元素还浮在上面（scrim 盖着整个屏幕），
             下次打开会看到一个"凭空出现的弹层"。
        */
        closeEditForm();
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
        backBtn = document.getElementById('shortcut-back');
        backdropEl = document.getElementById('shortcut-backdrop');

        if (addBtn) {
            /*
              ⚠️ 图标由 JS 注入，不在 HTML 里手写 SVG ——
                 门户项目里"图标路径只在 components.js 一处定义"的规矩。
                 加号没有独立填充变体，outline 与 fill 逐字相同。
            */
            var ui = global.ScholariusUI;
            if (ui && ui.icon) {
                addBtn.innerHTML = ui.icon('add');
            }
            addBtn.addEventListener('click', add);
        }
        if (backBtn) {
            backBtn.addEventListener('click', close);
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
