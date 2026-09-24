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
        var haystack = [
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

        var title = document.createElement('span');
        title.className = 'doc-title';
        title.textContent = doc.title || doc.sourceName || '';
        info.appendChild(title);

        /*
          作者与发表物可能缺失，缺失就不加这个元素 ——
          空元素占位会让卡片看起来偏高、也不整齐。
        */
        var line2 = composeMeta([doc.author, doc.venue]);
        if (line2) {
            var meta = document.createElement('span');
            meta.className = 'doc-meta';
            meta.textContent = line2;
            info.appendChild(meta);
        }

        var line3 = composeMeta([
            doc.pages ? t('vault.pages').replace('{n}', String(doc.pages)) : '',
            formatSize(doc.size)
        ]);
        if (line3) {
            var meta3 = document.createElement('span');
            meta3.className = 'doc-meta';
            meta3.textContent = line3;
            info.appendChild(meta3);
        }

        li.appendChild(thumb);
        li.appendChild(info);

        mountCard(li, doc);
        return li;
    }

    /** 把非空片段用分隔符连起来；全空则返回空串 */
    function composeMeta(parts) {
        var kept = parts.filter(function (p) {
            return p && String(p).trim();
        });
        return kept.join(' · ');
    }

    function formatSize(bytes) {
        var n = Number(bytes) || 0;
        if (n <= 0) {
            return '';
        }
        if (n < 1024) {
            return n + ' B';
        }
        if (n < 1024 * 1024) {
            return (n / 1024).toFixed(0) + ' KB';
        }
        return (n / 1024 / 1024).toFixed(1) + ' MB';
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
