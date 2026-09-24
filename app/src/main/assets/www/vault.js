/**
 * Scholarius - 文库页。
 *
 * 职责：展示用户导入的 PDF、搜索过滤、导入、删除（单个 / 批量）。
 *
 * 原生 → 网页（挂在 ScholariusShell 上）：
 *   setLibrary(docs)      推文献列表（导入完成、删除完成时都会推）
 *   onImportFailed()      导入失败
 *
 * 网页 → 原生（ScholariusNative）：
 *   getThumbnail(id)      同步取缩略图 base64（返回空串表示没有）
 *   deleteDocs(idsJson)   删除若干文献
 *   updateDoc(...)        改元数据
 *   requestLibrary()      主动拉一次列表
 *
 * ⚠️ **网页拿不到 PDF 文件**。WebView 的 allowFileAccess=false，
 *    应用私有目录对网页不可见。缩略图由原生以 base64 传过来。
 *    阅读页需要的通道下个版本设计。
 */
(function (global) {
    'use strict';

    var listEl = null;
    var emptyEl = null;
    var emptyTextEl = null;
    var emptyHintEl = null;
    var searchEl = null;
    var searchClearEl = null;
    var importBtn = null;
    var fileInput = null;
    var selectionBar = null;
    var selectionCountEl = null;
    var selectionCloseEl = null;
    var selectionDeleteEl = null;

    /** 全部文献（原生推过来的，未过滤） */
    var docs = [];
    /** 当前搜索词（小写，已 trim） */
    var query = '';
    /** 多选模式：null 表示未进入；否则是选中 id 的集合 */
    var selection = null;

    /**
     * 文献类型 → 图标名。
     *
     * ⚠️ 这是一张**白名单表**，同时承担两个职责：
     *    ① 把类型映射到图标
     *    ② 校验传进来的 type 是否合法 —— 查不到就是 undefined，
     *       不会进 innerHTML，所以用户数据无法注入 DOM
     *
     * ⚠️ 路径由 components.js 的 ICON_PATHS 提供（Material Symbols 官方）。
     *
     * ⚠️ unknown 故意**不在表里** —— 未知类型不显示任何图标，
     *    这与「猜错比不显示更糟」的取舍一致。
     */
    var VENUE_TYPE_ICON = {
        conference: 'venueConference',
        journal: 'venueJournal',
        preprint: 'venuePreprint',
        book: 'venueBook',
        thesis: 'venueThesis',
        report: 'venueReport'
    };

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    function native() {
        return global.ScholariusNative || null;
    }

    function init() {
        listEl = document.getElementById('doc-list');
        emptyEl = document.getElementById('vault-empty');
        emptyTextEl = document.getElementById('vault-empty-text');
        emptyHintEl = document.getElementById('vault-empty-hint');
        searchEl = document.getElementById('vault-search');
        searchClearEl = document.getElementById('vault-search-clear');
        importBtn = document.getElementById('vault-import');
        fileInput = document.getElementById('vault-file-input');
        selectionBar = document.getElementById('selection-bar');
        selectionCountEl = document.getElementById('selection-count');
        selectionCloseEl = document.getElementById('selection-close');
        selectionDeleteEl = document.getElementById('selection-delete');

        if (!listEl) {
            return;
        }

        mountImport();
        mountSearch();
        mountBulk();

        // 语言切换后空状态文案要更新
        if (global.ScholariusI18n && global.ScholariusI18n.onChange) {
            global.ScholariusI18n.onChange(render);
        }
    }

    // --- 导入 ---------------------------------------------------------------

    function mountImport() {
        if (!importBtn || !fileInput) {
            return;
        }

        importBtn.addEventListener('click', function () {
            /*
              点「+」= 点那个隐藏的 file input。
              它会触发原生的 WebChromeClient.onShowFileChooser，
              由原生弹出系统文件选择器。
            */
            fileInput.click();
        });

        fileInput.addEventListener('change', function () {
            /*
              ⚠️ 这里**不需要**读 file 内容。
                 真正的导入完全在原生侧完成（它拿到的是 content:// URI，
                 能直接读），导入完成后原生会调 setLibrary() 推新列表。
                 网页只需要把 input 清空，好让用户能连续导入同一个文件。
            */
            fileInput.value = '';
        });
    }

    // --- 搜索 ---------------------------------------------------------------

    function mountSearch() {
        if (!searchEl) {
            return;
        }

        searchEl.addEventListener('input', function () {
            query = (searchEl.value || '').trim().toLowerCase();
            if (searchClearEl) {
                searchClearEl.hidden = !query;
            }
            render();
        });

        if (searchClearEl) {
            searchClearEl.addEventListener('click', function () {
                searchEl.value = '';
                query = '';
                searchClearEl.hidden = true;
                searchEl.focus();
                render();
            });
        }
    }

    /** 一个文献是否匹配当前搜索词。空搜索词匹配全部 */
    function matches(doc) {
        if (!query) {
            return true;
        }
        // 标题 / 作者 / 发表物 / 原文件名都参与匹配 ——
        // 用户可能记得的是文件名而不是标题
        //
        // ⚠️ doc.venueShort（文章简称）**必须也在内**。
        //    卡片上显示的标题就是它（见 renderCard）——
        //    用户在列表里看到 "BERT paper" 然后去搜 "BERT"，
        //    搜不到是最让人恼火的一类 bug：
        //    屏幕上明明写着，却搜不出来。
        var haystack = [
            doc.venueShort || '',
            doc.title || '',
            doc.author || '',
            doc.venue || '',
            doc.sourceName || ''
        ].join(' ').toLowerCase();
        return haystack.indexOf(query) !== -1;
    }

    // --- 多选与删除 ---------------------------------------------------------

    function mountBulk() {
        if (selectionCloseEl) {
            selectionCloseEl.addEventListener('click', exitSelection);
        }
        if (selectionDeleteEl) {
            selectionDeleteEl.addEventListener('click', confirmDeleteSelected);
        }
    }

    function enterSelection(id) {
        selection = selection || {};
        selection[id] = true;
        updateSelectionBar();
    }

    function exitSelection() {
        selection = null;
        if (selectionBar) {
            /*
              ⚠️ 先移除 is-open（滑出动画），再等动画结束设 hidden。
                 直接 hidden 会让它「啪」地消失，与滑入动画不对称。
                 220ms 与 .selection-bar 的 transition 时长一致。
            */
            selectionBar.classList.remove('is-open');
            global.setTimeout(function () {
                // 期间用户可能又进了多选，必须复查
                if (!selection && selectionBar) {
                    selectionBar.hidden = true;
                }
            }, 220);
        }
        render();
    }

    function selectedIds() {
        return selection ? Object.keys(selection).filter(function (k) {
            return selection[k];
        }) : [];
    }

    /**
     * 刷新多选操作栏（顶部）。
     *
     * ⚠️ 显示用「hidden + is-open」两段式：
     *    hidden 控制是否参与布局，is-open 控制位移动画。
     *    先 hidden=false 再加 is-open，否则 transition 不触发（元素从未渲染过）。
     */
    function updateSelectionBar() {
        if (!selectionBar) {
            return;
        }

        if (!selection) {
            selectionBar.classList.remove('is-open');
            selectionBar.hidden = true;
            return;
        }

        var ids = selectedIds();
        if (selectionBar.hidden) {
            selectionBar.hidden = false;
            // 强制一次布局，保证下面的 is-open 能触发 transition
            if (selectionBar.offsetWidth < 0) return;
        }
        selectionBar.classList.add('is-open');

        if (selectionCountEl) {
            selectionCountEl.textContent = t('selection.count').replace('{n}', String(ids.length));
        }
        if (selectionDeleteEl) {
            /*
              一条都没选时禁用删除。
              ⚠️ 用 disabled 而不是隐藏 —— 位置固定，按钮不会跳。
            */
            selectionDeleteEl.disabled = ids.length === 0;
        }

        // 同步每张卡片的选中样式
        var cards = listEl ? listEl.querySelectorAll('.doc-card') : [];
        Array.prototype.forEach.call(cards, function (card) {
            var id = card.dataset.id;
            card.classList.toggle('is-selected', !!(selection && selection[id]));
        });
    }

    function confirmDeleteSelected() {
        var ids = selectedIds();
        if (!ids.length) {
            /*
              ⚠️ 一条都没选时也要**退出多选**，不能直接 return。

              原来的写法是 `if (!ids.length) return;` ——
              结果用户长按进入多选、又取消了所有选中项、点「删除」时，
              什么都不会发生，批量条永久留在屏幕上，只能靠切 tab 才消失。
              对用户来说就是「卡在多选模式里出不来」。
            */
            exitSelection();
            return;
        }

        if (!global.ScholariusUI || !global.ScholariusUI.confirmSheet) {
            doDelete(ids);
            return;
        }

        global.ScholariusUI.confirmSheet({
            title: t('vault.deleteTitle'),
            message: t('vault.deleteMessage').replace('{n}', String(ids.length)),
            confirmLabel: t('action.delete'),
            cancelLabel: t('action.cancel'),
            // 破坏性且不可撤销 → DELETE 用删除红
            danger: true,
            onConfirm: function () {
                doDelete(ids);
            }
        });
    }

    function confirmDeleteOne(doc) {
        if (!global.ScholariusUI || !global.ScholariusUI.confirmSheet) {
            doDelete([doc.id]);
            return;
        }
        global.ScholariusUI.confirmSheet({
            title: t('vault.deleteTitle'),
            message: t('vault.deleteOneMessage').replace('{title}', doc.title || ''),
            confirmLabel: t('action.delete'),
            cancelLabel: t('action.cancel'),
            // 破坏性且不可撤销 → DELETE 用删除红
            danger: true,
            onConfirm: function () {
                doDelete([doc.id]);
            }
        });
    }

    function doDelete(ids) {
        var bridge = native();
        if (bridge && typeof bridge.deleteDocs === 'function') {
            bridge.deleteDocs(JSON.stringify(ids));
        }
        exitSelection();
    }

    // --- 渲染 ---------------------------------------------------------------

    /** 原生推来新列表 */
    function setLibrary(next) {
        docs = Array.isArray(next) ? next : [];
        /*
          列表变了就退出多选 —— 否则会残留指向已删文献的选中项，
          批量条上显示的数字与实际不符。
        */
        if (selection) {
            exitSelection();
        } else {
            render();
        }
    }

    function render() {
        if (!listEl) {
            return;
        }

        var visible = docs.filter(matches);

        listEl.innerHTML = '';
        visible.forEach(function (doc) {
            listEl.appendChild(buildCard(doc));
        });

        // 空状态：区分「一篇都没有」和「搜不到」
        if (emptyEl) {
            if (visible.length === 0) {
                emptyEl.hidden = false;
                if (docs.length === 0) {
                    if (emptyTextEl) {
                        emptyTextEl.setAttribute('data-i18n', 'vault.empty');
                        emptyTextEl.textContent = t('vault.empty');
                    }
                    if (emptyHintEl) {
                        emptyHintEl.setAttribute('data-i18n', 'vault.emptyHint');
                        emptyHintEl.textContent = t('vault.emptyHint');
                        emptyHintEl.hidden = false;
                    }
                } else {
                    if (emptyTextEl) {
                        emptyTextEl.removeAttribute('data-i18n');
                        emptyTextEl.textContent = t('vault.noResult');
                    }
                    if (emptyHintEl) {
                        emptyHintEl.hidden = true;
                    }
                }
            } else {
                emptyEl.hidden = true;
            }
        }

        updateSelectionBar();
    }

    /** 组装一张文献卡片 */
    function buildCard(doc) {
        var li = document.createElement('li');
        li.className = 'doc-card';
        li.dataset.id = doc.id;
        li.setAttribute('role', 'button');
        li.tabIndex = 0;

        // ① 缩略图
        var thumb = document.createElement('div');
        thumb.className = 'doc-thumb';
        if (doc.hasThumb && native() && typeof native().getThumbnail === 'function') {
            var dataUrl = '';
            try {
                dataUrl = native().getThumbnail(doc.id) || '';
            } catch (e) {
                dataUrl = '';
            }
            if (dataUrl) {
                var img = document.createElement('img');
                img.src = dataUrl;
                img.alt = '';
                thumb.appendChild(img);
            } else {
                thumb.appendChild(placeholderIcon());
            }
        } else {
            thumb.appendChild(placeholderIcon());
        }

        // ② 信息
        var info = document.createElement('div');
        info.className = 'doc-info';

        /*
          ══ 卡片固定四行（v0.1.5，用户明确要求）══

              ① 标题
              ② 作者
              ③ 发表物
              ④ 页数 · 大小

          ⚠️ 原来是「标题 / 作者·发表物 / 页数·大小」三行 ——
             作者与发表物挤在一行。实测真实论文时这一行会长到
             变成两三行（如 HAL 的分类串、NIPS 带 URL 的会议名），
             卡片高度参差不齐，很难扫读。

          ⚠️ 缺字段时**要占位**（留一个空行），不能直接省略元素。
             否则缺作者的卡片三行、齐全的四行，高度对不齐 ——
             这正是用户要「固定四行」的原因。
             用 &nbsp; 之类会引入不可见的字符，所以用 CSS 撑高
             （见 .doc-line 的 min-height），元素照常创建但内容为空。
        */
        /*
          ① 标题。

          ⚠️⚠️ **文章简称一旦填了，就顶替标题显示**（用户 2026-09-24：
             「short name 一旦确定，列表卡片的文章标题就用
               short name 代替」）。

             语义：文章简称是**用户自己给这篇文献起的短名** ——
             他既然专门起了名，就是为了在列表里一眼认出来。
             这时候还显示那一长串正式标题（常常被截断成
             "Attention is All you N…"）反而更难认。

             ⚠️ 注意这只影响**卡片显示**，不改 doc.title 本身 ——
                详情页里的「Title」字段、搜索、删除确认弹窗
                全部仍用完整标题。简称是「显示别名」，不是「改名」。
                否则用户改简称就会把真实标题冲掉，不可逆。

          ⚠️ 兜底链：文章简称 → 标题 → 原文件名。
             第三层是必需的：标题可能被用户清空
             （LibraryStore.update 里清了标题会落回文件名，
              但那是**保存时**才发生，本地 draft 里可能还是空），
             此时卡片不能是空白。

          ⚠️ 空串要 fall through 到下一层，不能当成"有值"。
             doc.venueShort 可能存着 '' 或 '   '（用户填了又删），
             所以必须 trim 后判空。
        */
        var shortName = (doc.venueShort || '').trim();
        var title = document.createElement('span');
        title.className = 'doc-title';
        if (shortName) {
            title.textContent = shortName;
            /*
              ⚠️ 标记出来是**简称**而不是标题。

                 为什么需要这个标记：简称顶替标题后，卡片上再没有
                 任何线索说明"这行字是用户自己起的短名"。
                 用户过一段时间回来看，可能会以为自己当初
                 把标题填错了 —— 然后把标题改得乱七八糟。

                 加了属性之后，将来可以做悬停/长按显示完整标题。

              ⚠️ 用 data-* 而不是 class：这是**语义信息**不是样式钩子。
                 样式若需要，用 [data-doc-short] 选择器即可。
            */
            title.setAttribute('data-doc-short', '1');
        } else {
            title.textContent = doc.title || doc.sourceName || '';
        }
        info.appendChild(title);

        // ② 作者
        info.appendChild(buildMetaLine('doc-author', doc.author));

        /*
          ③ 发表载体（venue）。

          ⚠️ 术语：venue 可能是会议 / 预印本 / 专著 / 学位论文，
             不一定是期刊。

          ══ 结构：左类型 · 右载体名（v0.1.5，用户要求）══

              ┌──────────────────────────────────────────────┐
              │ [图标] 会议          Neural Information...   │
              └──────────────────────────────────────────────┘

          左侧是**类型**（图标 + 文字），右侧是**载体名**。
          载体名优先用用户设的**简称**（如 NIPS），没设才用全名。

          ⚠️ 外面包一层 .doc-venue-line 才能让两者分列两端。
             直接给 .doc-venue 加 text-align: right 的话，
             它仍是块级、仍占满宽度，底色会从最左铺到最右
             （变成一条分隔带，而不是标签）。
        */
        var venueLine = document.createElement('span');
        venueLine.className = 'doc-venue-line';

        /*
          ⚠️ 类型目前**恒为 unknown**，所以图标与文字都不显示。
             PDF 里没有权威的载体类型字段（实测 12 篇里 6 篇无任何信号，
             而猜错会把 Nature 标成「会议」，代价比不显示更大）。
             数据来源与设置项后续再做 —— 这里先把结构与渲染路径接好，
             将来只需让 doc.venueType 有值，图标与文字就自动出现。
        */
        var type = doc.venueType || 'unknown';
        if (type !== 'unknown') {
            var typeEl = document.createElement('span');
            typeEl.className = 'doc-venue-type';
            var iconName = VENUE_TYPE_ICON[type];
            if (iconName && global.ScholariusUI && global.ScholariusUI.icon) {
                /*
                  ⚠️ 这里用 innerHTML 是**安全**的，与正文渲染不同：
                     icon() 返回的是我们自己硬编码的 SVG 字符串
                     （路径全部来自 Material Symbols 常量表），
                     不含任何用户数据。用户可影响的只有 type 值本身，
                     而它经过 VENUE_TYPE_ICON 白名单查表 ——
                     查不到就是 undefined，不会进 innerHTML。
                */
                typeEl.innerHTML = global.ScholariusUI.icon(iconName);
            }
            var typeText = t('venue.type.' + type);
            if (typeText) {
                var labelEl = document.createElement('span');
                labelEl.className = 'doc-venue-type-label';
                labelEl.textContent = typeText;
                typeEl.appendChild(labelEl);
            }
            venueLine.appendChild(typeEl);
        }

        /*
          载体名：优先用**发表物简称**。

          ⚠️⚠️ 这里取的是哪种「简称」，极容易搞混（用户 2026-09-24 指出）：

             · **发表物简称**（NIPS / CVPR）—— 会议/期刊名字的缩写，
               存在 shortcut.js 的**全局映射表**里（localStorage），
               一条配置服务**所有**发表在同一载体的文献。
               ★ 卡片这里要用的就是这个。

             · **文章简称** —— 这一篇文档自己的短名，
               存在 doc.venueShort（详情页那一行输入框）。
               它**不用在载体名上**，而是**顶替①行的标题**
               （见上面渲染 title 的地方）。

          ⚠️ 踩过的坑：这里原本写的是 `doc.venueShort || doc.venue` ——
             把**文章简称**当成了载体名的优先来源。后果是：
             用户给一篇文献填了文章简称 "BERT paper"，
             卡片上的「发表物」那一栏就显示成 "BERT paper"，
             完全看不出它发在哪。而且 doc.venueShort 与
             ScholariusShortcut.lookup() 是两套数据，
             用户在设置里配的 NIPS 映射**永远不会生效**
             （lookup 定义了却没人调）。

          ⚠️ 查表用**未截断的原始 venue**（doc.venue），
             不能用显示用的值 —— 将来若对 venue 做清洗，
             查表要拿清洗后的值与用户设置时的值对齐。
             lookup 自己做 trim + 大小写归一，这里不必重复。

          ⚠️ 兜底链：发表物简称 → doc.venue → 空。
             前两层都空就留白（卡片那一栏本来就是「可为空」的）。
        */
        var venueLabel = doc.venue;
        if (global.ScholariusShortcut && typeof global.ScholariusShortcut.lookup === 'function') {
            var abbr = global.ScholariusShortcut.lookup(doc.venue || '');
            if (abbr) venueLabel = abbr;
        }
        venueLine.appendChild(buildMetaLine('doc-venue', venueLabel));
        info.appendChild(venueLine);

        // ④ 页数（左）· 发表年份（右）
        /*
          ⚠️ 这一行是**两端对齐**的（v0.1.5，用户要求）：
                 页数靠左 ......................... 发表年份靠右

             所以不能像上面三行那样塞进一个元素 ——
             必须两个独立的元素，由 CSS 的 justify-content:
             space-between 把它们推到两端。

          ⚠️ 两者都可能为空（页数取不到 / 年份没抓到）。
             空的那个仍然要保留元素，否则剩下的那个会跑到中间去
             （space-between 只有一个子元素时会左对齐，看起来还行，
              但两个都空时高度会塌掉，四行结构就破了）。

          ⚠️ 年份为空时**什么都不显示**（不是显示「未知」「—」）。
             用户明确说过：测不出来的留空就行，后面手动改。
             占位符反而要先解释一遍自己是什么，是负担。
        */
        var stats = document.createElement('span');
        stats.className = 'doc-meta doc-stats';
        stats.appendChild(buildStat('doc-pages',
            doc.pages ? t('vault.pages').replace('{n}', String(doc.pages)) : ''));
        stats.appendChild(buildStat('doc-year', formatYear(doc.year)));
        info.appendChild(stats);

        li.appendChild(thumb);
        li.appendChild(info);

        mountCard(li, doc);
        return li;
    }

    /**
     * 造一行元数据。
     *
     * ⚠️ 即使内容为空也要返回元素 —— 空元素由 CSS 的 min-height
     *    撑出与有内容时相同的高度，这样卡片恒为四行。
     *    少了这个占位，缺作者的卡片就会矮一行，列表参差不齐。
     */
    function buildMetaLine(className, value) {
        var el = document.createElement('span');
        el.className = 'doc-meta ' + className;
        el.textContent = value || '';
        return el;
    }

    /** 页数/大小这种「行内的一个片段」，不带 .doc-meta 的块级行为 */
    function buildStat(className, value) {
        var el = document.createElement('span');
        el.className = className;
        el.textContent = value || '';
        return el;
    }

    /**
     * 发表年份 → 显示文本。
     *
     * ⚠️ 只接受 4 位数字，其余一律返回空串。
     *
     *    为什么要校验而不是直接显示：这个值来自 PDF 的元数据，
     *    是**外部输入**。PDF 可能是手工编辑过的，或者出版社塞了
     *    `2015-08-20`、`D:2015`、`©2015` 之类的形态。直接显示会
     *    把整行撑歪，也难看。
     *
     * ⚠️ 存储层（详情页的「日期」字段）现在允许 `YYYY-MM-DD`，
     *    但**卡片只显示 4 位年份**（用户明确要求）。
     *    所以这里要把日期里的年份**取出来**，
     *    而不是像早期版本那样「格式不对就整个丢弃」——
     *    那会让填了完整日期的文献在卡片上完全没有年份。
     *
     * @param {string} value 存储里的值：'' / '2015' / '2015-06' / '2015-06-24'
     * @returns {string} 4 位年份，认不出则空串
     */
    function formatYear(value) {
        var s = String(value == null ? '' : value).trim();
        if (!s) return '';

        /*
          ⚠️ 以 `YYYY` 开头就取这 4 位。
             模式用 ^\d{4} 而不是完整匹配 —— 只为兼容
             `2015-06-24`、`2015/06`、`2015年` 这些前缀是年份的写法。
             范围校验（1800~2099）仍留着，防 `0000` 之类的脏值。
        */
        var m = s.match(/^(\d{4})/);
        if (!m) return '';
        return /^(1[89]\d{2}|20\d{2})$/.test(m[1]) ? m[1] : '';
    }

    function placeholderIcon() {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        // Material Icons: description（文件图标）
        path.setAttribute('d', 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z');
        svg.appendChild(path);
        return svg;
    }

    /**
     * 卡片交互：短按进阅读页；长按进多选。
     *
     * ⚠️ 用 `attachLongPress` 的统一实现（600ms + justLongPressed 标记），
     *    不要自己写 touchstart/touchend 计时 ——
     *    长按结束后系统还会补一个 click，自己写容易漏判，
     *    表现是「长按后顺手就进了阅读页」。
     */
    function mountCard(li, doc) {
        if (global.ScholariusUI && global.ScholariusUI.attachLongPress) {
            global.ScholariusUI.attachLongPress(li, function () {
                /*
                  ⚠️ 长按回调里必须**立刻消费掉 longPressed 标记**。

                  attachLongPress 的机制是：长按后置一个全局标记，
                  由下一次 click 通过 justLongPressed() 读走，用来跳过
                  「长按结束时系统补发的那次 click」。

                  问题在于：如果用户长按后**直接去点别的卡片**（很常见 ——
                  长按选第一张、再逐张点选），那个标记还没被消费，
                  于是**第一次点击会被误判成「长按的补发 click」而丢弃**。
                  实测表现：长按选中第 1 张后，点第 2 张没反应。

                  所以在长按回调里主动清掉它 —— 这一次长按已经处理完了，
                  后续的点击都应是真实意图。
                */
                if (global.ScholariusUI.justLongPressed) {
                    global.ScholariusUI.justLongPressed();
                }

                if (!selection) {
                    enterSelection(doc.id);
                } else {
                    // 已在多选模式：长按 = 切换该项
                    selection[doc.id] = !selection[doc.id];
                    updateSelectionBar();
                }
            });
        }

        li.addEventListener('click', function () {
            // 长按后的那次补发 click 要忽略（标记已在长按回调里消费，这里兜底）
            if (global.ScholariusUI && global.ScholariusUI.justLongPressed &&
                global.ScholariusUI.justLongPressed()) {
                return;
            }

            if (selection) {
                // 多选模式：点卡片 = 切换选中
                selection[doc.id] = !selection[doc.id];
                updateSelectionBar();
                return;
            }

            openReader(doc);
        });

        li.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (selection) {
                    selection[doc.id] = !selection[doc.id];
                    updateSelectionBar();
                } else {
                    openReader(doc);
                }
            }
        });
    }

    /** 进阅读页 */
    function openReader(doc) {
        if (global.ScholariusReader) {
            global.ScholariusReader.open(doc);
        }
    }

    /** 导入失败（原生回调） */
    function onImportFailed() {
        if (global.ScholariusUI) {
            global.ScholariusUI.toast(t('vault.importFailed'));
        }
    }

    /**
     * 原生回报「某篇文献的元数据保存完了」。
     *
     * ⚠️ 这里**不做任何界面更新** —— 原生保存成功后会再推一次
     *    完整的 setLibrary()，列表自然就刷新了。
     *    职责分工：本函数只把结果转给详情页（它要收起面板 + 提示）。
     *
     *    这样分工的原因：详情页可能已经关了（用户在保存途中点了关闭），
     *    那时 detail 模块自己的 id 核对会拦住，不会误报。
     */
    function onDocUpdated(id, ok) {
        if (global.ScholariusDetail) {
            return global.ScholariusDetail.onDocUpdated(id, ok);
        }
        return 'no-detail-module';
    }

    /** 当前页面被切走时：退出多选，避免状态残留 */
    function onLeave() {
        if (selection) {
            exitSelection();
        }
    }

    global.ScholariusVault = {
        init: init,
        setLibrary: setLibrary,
        onImportFailed: onImportFailed,
        onDocUpdated: onDocUpdated,
        onLeave: onLeave,
        /** 系统返回键用：是否处于多选模式 */
        isSelecting: function () {
            return !!selection;
        },
        exitSelection: exitSelection,
        /** 供原生/其它模块查当前篇数 */
        count: function () {
            return docs.length;
        }
    };
})(window);
