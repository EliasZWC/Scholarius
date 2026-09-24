/**
 * Scholarius — 文献详情 / 元数据编辑页。
 *
 * ══ 它解决什么问题 ══
 *
 * 导入 PDF 时能自动抓到的信息很有限（标题/作者/年份，且经常抓不准）。
 * 卷、期、页码、DOI、ISBN、会议地点这些东西 PDF 里**根本没有**，
 * 用户想把文献整理干净就只能手填。
 *
 * 用户原话（2026-09-24）：
 *   「全做，因为可以留空，但如果用户想，就应该能加入这些信息」
 *
 * ══ 表单为什么是「动态生成」的 ══
 *
 * 字段集合**取决于发表物类别**（Zotero 的逻辑）：
 *   期刊 → 卷/期/页码/DOI
 *   会议 → 会议名/简称/地点/页码/DOI
 *   专著 → 出版社/ISBN/版次
 *   …
 *
 * 七种类别 = 七套字段。把它们都写进 HTML 意味着:
 *   ① HTML 里躺着七套表单，六套永远是隐藏的
 *   ② 字段要改时得同时改 HTML 和 meta.js，迟早不同步
 *
 * 所以 HTML 里只有一个空的 `#detail-fields` 容器，
 * 页面打开时按 `ScholariusMeta.fieldsFor(type)` 现生成。
 * **加字段只改 meta.js 一处。**
 *
 * ══ 关键设计：全字段回传，而不是只传改过的 ══
 *
 * 保存时把所有字段（含空串）打包成 JSON 交给原生。
 * 原生的语义是「空串 = 清空该字段」，所以：
 *   用户把「卷」从 "521" 删成空 → 传 volume:"" → 原生删掉这个键 ✔
 *
 * ⚠️ 若只传「改过的」字段，用户就没法**清空**一个已有值 ——
 *    空值不在 patch 里，原生按「没出现 = 保持原值」处理，删不掉。
 *    这是实测踩过的坑（vault.js 的老 updateDoc 就是这个毛病）。
 */
(function (global) {
    'use strict';

    var root = null;
    var typeRowEl = null;
    var typeValueEl = null;
    var typeValueIconEl = null;
    var typePicker = null;
    var fieldsEl = null;
    var shortNameInput = null;
    var saveBtn = null;
    var cancelBtnEl = null;

    /** 当前正在编辑的文献（打开时传入，保存时用它的 id） */
    var currentDoc = null;
    /**
     * 工作副本：类别与所有字段值。
     *
     * ⚠️ 必须与 currentDoc 分开 —— 用户改到一半点关闭，
     *    currentDoc 不能被污染（下次打开还是原值）。
     *    保存成功时再把工作副本写回 currentDoc。
     */
    var draft = null;
    /** 输入框元素表：key → <input>，保存时按它取值 */
    var inputs = {};
    /** 是否已打开（供返回键查询） */
    var isOpenFlag = false;
    /** 关闭动画的定时器 —— 快速开关时要用它取消上一次的收尾 */
    var closeTimer = null;

    function t(key) {
        return global.ScholariusI18n
            ? global.ScholariusI18n.t(key)
            : key;
    }

    /**
     * 带参数的文案。
     *
     * ⚠️ i18n 的 t() **只接受 key，不做插值**（见 i18n.js 的 t()）。
     *    `{n}` 这类占位符要在调用处替换 —— 全站都是这个做法
     *    （vault.js 里 `t('vault.pages').replace('{n}', …)`）。
     *
     * ⚠️ 踩过的坑：想当然写成 t(key, {n:5})，参数被静默忽略，
     *    界面上直接显示 `{n} Pages`。i18n 不会报错，
     *    因为它只是把 key 查出来返回而已。
     */
    function tWith(key, vars) {
        var text = t(key);
        if (vars) {
            for (var k in vars) {
                if (Object.prototype.hasOwnProperty.call(vars, k)) {
                    text = text.split('{' + k + '}').join(String(vars[k]));
                }
            }
        }
        return text;
    }

    /**
     * 是否是顶层字段（存在 doc 本身而不是 doc.fields 里）。
     *
     * ⚠️ 用 meta.js 的 TOP_LEVEL_KEYS 表，**不在这里硬编码**。
     *    之前写的是 `key === 'title' || key === 'author' || key === 'year'`，
     *    加 shortTitle 时就得记得同时改三处（读/写/提交），
     *    漏一处就会出现「填了简称但保存后不见了」。
     *    表单从一份表派生，判断也从同一份表派生。
     */
    function isTopLevel(key) {
        var table = global.ScholariusMeta
            ? global.ScholariusMeta.TOP_LEVEL_KEYS
            : null;
        return !!(table && table[key]);
    }

    /**
     * 取字段现值。
     *
     * ⚠️ 顶层键与类别字段（fields.xxx）存在两个地方，必须分开找 ——
     *    这也是 meta.js 里区分 COMMON_FIELDS 和 TYPE_FIELDS 的原因。
     */
    function readValue(key) {
        if (!draft) return '';
        if (isTopLevel(key)) {
            return draft[key] || '';
        }
        return (draft.fields && draft.fields[key]) || '';
    }

    /** 写入工作副本 */
    function writeValue(key, value) {
        if (!draft) return;
        if (isTopLevel(key)) {
            draft[key] = value;
        } else {
            if (!draft.fields) draft.fields = {};
            draft.fields[key] = value;
        }
    }

    /* ---------------------------------------------------------------------
       打开 / 关闭
       --------------------------------------------------------------------- */

    /**
     * 打开详情页。
     *
     * @param {Object} doc 文库里的文献对象
     *        （含 id/title/author/year/shortTitle/venueType/fields…）
     */
    function open(doc) {
        if (!root || !doc) return;

        currentDoc = doc;
        /*
          ⚠️ 深拷贝 fields。直接用 doc.fields 的引用会让「改到一半关闭」
             直接改到文库数据上（下次渲染卡片就显示未保存的值）。

          ⚠️ shortTitle 也必须拷 —— 它是顶层字段，同样不能在
             draft 上直接持有 currentDoc 的值（否则「取消」无效）。
        */
        draft = {
            id: doc.id,
            title: doc.title || '',
            author: doc.author || '',
            year: doc.year || '',
            shortTitle: doc.shortTitle || '',
            venueType: doc.venueType || 'unknown',
            fields: {}
        };
        if (doc.fields) {
            for (var k in doc.fields) {
                if (Object.prototype.hasOwnProperty.call(doc.fields, k)) {
                    draft.fields[k] = doc.fields[k];
                }
            }
        }

        /*
          ⚠️ 只调 renderAll()，**不要再单独调 renderReadonly()** ——
             renderAll → renderFields → renderReadonly 已经把只读项
             追加进字段容器。重复调会让它们被加两遍。
        */
        renderAll();
        syncShortName();

        root.hidden = false;
        // 取消上一次关闭残留的收尾定时器（快速连续开关时）
        if (closeTimer) {
            global.clearTimeout(closeTimer);
            closeTimer = null;
        }
        // 强制布局后再加 is-open，否则滑入动画不触发。
        // ⚠️ 必须把读到的值用起来 —— 光是 `void el.offsetWidth` 会被引擎优化掉。
        if (root.offsetWidth < 0) return;
        root.classList.add('is-open');
        isOpenFlag = true;

        trace('detail:open', doc.id);
    }

    function close() {
        if (!root) return;
        root.classList.remove('is-open');
        isOpenFlag = false;
        /*
          ⚠️ 延时 280ms 与 CSS transition 对齐。
             期间若又打开另一篇，open() 会清掉这个定时器 ——
             否则它会把刚打开的面板 hidden 掉。
        */
        closeTimer = global.setTimeout(function () {
            closeTimer = null;
            if (!root.classList.contains('is-open')) {
                root.hidden = true;
                currentDoc = null;
                draft = null;
                inputs = {};
            }
        }, 280);
        trace('detail:close', '');
    }

    function isOpen() {
        return isOpenFlag;
    }

    /* ---------------------------------------------------------------------
       渲染
       --------------------------------------------------------------------- */

    /** 类别行 + 字段表一起重画（换类别会改变字段表） */
    function renderAll() {
        syncTypeRow();
        renderFields();
    }
    /**
     * 类别行：左图标 + 中名称 + 右当前值。
     *
     * ⚠️ 用 createRowSheetPicker（底部选项表单）而不是卡片网格。
     *    理由见 styles.css 的 .detail-type-row 注释：省一整行高度、
     *    且与全站「多选一」入口形态一致。
     *
     * ⚠️ createRowSheetPicker 是**一次性绑定**的（它在 row 上挂
     *    config 再 addEventListener），所以这个方法只在 init 里调一次。
     *    换类别后只需刷新右侧文字与图标 —— 见 syncTypeRow。
     */
    function mountTypeRow() {
        if (!typeRowEl || !typeValueEl) return;

        var types = global.ScholariusMeta
            ? global.ScholariusMeta.VENUE_TYPES
            : [];

        typePicker = global.ScholariusUI.createRowSheetPicker(
            typeRowEl, typeValueEl, {
                title: t('meta.typeLabel'),
                getOptions: function () {
                    return types.map(function (type) {
                        /*
                          ⚠️ icon 传给 sheet-picker 渲染在选项左侧。
                             用户原话：「不同图标对应着不同的发表物类型」——
                             七个选项光看文字要逐个读完，配上图标
                             一眼就能扫到目标。

                          ⚠️ unknown 的 icon 是空串，不传即可 ——
                             条目会退化成纯文字，这也是对的
                             （「未设定」本来就不对应任何载体）。
                        */
                        var opt = {
                            value: type.value,
                            label: t('venue.type.' + type.value)
                        };
                        if (type.icon) opt.icon = type.icon;
                        /*
                          ⚠️ 「未设定」用**浅色**渲染（用户 2026-09-24：
                             「类型选项中的未设置请用浅色来凸显和其他
                              选项的不同」）。

                             ⚠️ 为什么不按 value === 'unknown' 硬编码在组件里：
                                组件是通用的（设置页的语言/主题/调试
                                也用它），它不该认识"发表物类别"这个概念。
                                由调用方声明哪一项是 muted，组件只负责画。
                                这与 opt.icon / opt.swatch 是同一套设计。

                             ⚠️ 判断依据用 `type.icon` 也行（unknown 的
                                icon 是空串），但**不能**那样写 ——
                               将来若给 unknown 配了个图标，
                               这条淡化就会静默失效。语义要显式表达。
                        */
                        if (type.value === 'unknown') opt.muted = true;
                        return opt;
                    });
                },
                getValue: function () {
                    return draft ? draft.venueType : 'unknown';
                },
                onChange: function (value) {
                    if (!draft || draft.venueType === value) return;
                    /*
                      ⚠️ 切换类别**不清空**已填的字段值。
                         用户可能先填了卷期页码才想起来改类别 ——
                         清空等于让他重填一遍。
                         残留的其它类别字段不会进保存 patch（见 collectPatch），
                         所以留在 draft 里不脏数据。
                    */
                    draft.venueType = value;
                    /*
                      ⚠️ 文字由 createRowSheetPicker 自己 syncSheetPickerValue()
                         写好，但**图标不在它的职责内**（它只知道 label），
                         所以这里要单独刷一次。
                    */
                    syncTypeValueIcon();
                    renderFields();
                }
            }
        );
    }

    /**
     * 刷新类别行（右侧的**图标 + 类别名**）。
     *
     * ⚠️ 每次 open() 都必须调。
     *
     *    踩过的坑：原来指望 createRowSheetPicker 在绑定时就刷好文字 ——
     *    但绑定发生在 init()（那时 draft 还是 null），
     *    getValue() 返回 'unknown'，于是右侧永远停在「Not Set」，
     *    而选项表单里却正确勾着 Conference：同一行两处显示不同答案。
     *
     * ⚠️ 文字走 picker.refresh()，图标必须**单独**刷 ——
     *    createRowSheetPicker 只负责把值换成对应选项的 label（纯文字），
     *    它不知道图标的事。两者职责分开，都在这里调一次。
     */
    function syncTypeRow() {
        if (!draft) return;

        if (typePicker && typePicker.refresh) {
            typePicker.refresh();
        }
        syncTypeValueIcon();
    }

    /**
     * 刷类别行右侧的小图标。
     *
     * ⚠️ 图标名来自 meta.js 的常量表（可信），所以用 innerHTML 安全。
     *    unknown 类别的 icon 是空串 —— 此时清空容器，
     *    由 CSS 的 `.detail-type-value-icon:empty { display:none }`
     *    让它不占位，文字自然靠右，不会留一块空白。
     */
    function syncTypeValueIcon() {
        if (!typeValueIconEl || !draft) return;

        var types = global.ScholariusMeta
            ? global.ScholariusMeta.VENUE_TYPES
            : [];
        var current = null;
        for (var i = 0; i < types.length; i++) {
            if (types[i].value === draft.venueType) { current = types[i]; break; }
        }

        typeValueIconEl.innerHTML = (current && current.icon && global.ScholariusUI)
            ? global.ScholariusUI.icon(current.icon)
            : '';
    }

    /**
     * 重画字段表。
     *
     * ⚠️ 只读项（来源文件 / 文件页数）**接在可编辑字段之后**，
     *    所以这里清空容器后必须重新追加它们（见 renderReadonly）。
     *
     *    调度关系：renderAll() → renderFields() → renderReadonly()。
     *    只调 renderFields() 而忘了只读项，换类别时它们会消失
     *    （因为 textContent='' 把它们一起清了）。
     */
    function renderFields() {
        if (!fieldsEl) return;
        fieldsEl.textContent = '';
        inputs = {};

        var fields = global.ScholariusMeta
            ? global.ScholariusMeta.fieldsFor(draft.venueType)
            : [];

        fields.forEach(function (field) {
            fieldsEl.appendChild(buildField(field));
        });

        // ⚠️ 紧跟着补上只读的两项
        renderReadonly();
    }

    /**
     * 把 draft 里的**文章简称**写进行内输入框。
     *
     * ⚠️ 这个输入框**不参与 renderFields() 的重建** ——
     *    它是 HTML 里的静态元素（见 index.html 的 detail-inline-field），
     *    因为它的形态与字段表不同（行内而非整行），
     *    由 renderFields 生成反而要写一堆特判。
     *    代价是换类别 / 重开时得单独同步一次，就是本函数。
     *
     * ⚠️ 用 value 赋值而不是 textContent —— 它是 <input>。
     */
    function syncShortName() {
        if (!shortNameInput || !draft) return;
        shortNameInput.value = draft.shortTitle || '';
        /*
          ⚠️ 占位提示在这里补上（用户要求「所有空的输入框都给个提示填充文字」）。

             为什么不写在 HTML 的 placeholder 属性里：
             HTML 里那个值在切换语言时不会更新（i18n 是 JS 驱动的），
             所以由这里按当前 locale 写入。
        */
        var field = global.ScholariusMeta
            ? global.ScholariusMeta.SHORT_NAME_FIELD
            : null;
        if (field && field.placeholder) {
            shortNameInput.placeholder = t(field.placeholder);
        }
    }

    /** 造一行「标签 + 输入控件」 */
    function buildField(field) {
        var wrap = document.createElement('div');
        wrap.className = 'detail-field';

        var label = document.createElement('label');
        label.className = 'detail-field-label';
        label.textContent = t(field.label);
        label.setAttribute('for', 'detail-input-' + field.key);
        wrap.appendChild(label);

        var value = readValue(field.key);

        /*
          ⚠️ thesisType 是下拉（见 meta.js：学位类型只有那么几种，
             自由填写会变成 "PhD" / "Ph.D." / "博士" 三种写法并存）。
             用原生 <select> 而不是自造的弹层：
             这个页面本来就是表单，系统选择器的体验最省事，
             而且不用管键盘遮挡的问题。
        */
        if (field.kind === 'select') {
            var sel = document.createElement('select');
            sel.className = 'detail-input';
            sel.id = 'detail-input-' + field.key;

            var empty = document.createElement('option');
            empty.value = '';
            // 未填时显示占位而不是空白项，用户才知道这是「可以不管的」
            empty.textContent = t('meta.placeholder');
            sel.appendChild(empty);

            (field.options || []).forEach(function (opt) {
                var o = document.createElement('option');
                o.value = opt;
                /*
                  ⚠️ 用 `thesis.<opt>` 而不是直接显示 opt。
                     opt 是存储用的稳定标识（phd/master），
                     直接显示会漏出英文小写关键词。
                */
                o.textContent = t('thesis.' + opt);
                sel.appendChild(o);
            });

            sel.value = value;
            sel.addEventListener('change', function () {
                writeValue(field.key, sel.value);
            });
            inputs[field.key] = sel;

            wrap.appendChild(sel);
            return wrap;
        }

        if (field.kind === 'date') {
            /*
              ══ 日期：年 / 月 / 日 三个分段输入框 ══

              ⚠️ 这套交互是**照搬 Livolog** 的（E:\product\Livolog 的
                 datetime.js buildDateGroup + styles.css 的 .seg）。

                 抄而不是自己设计，理由：两个 app 是同一人手下的姊妹项目，
                 用户已在 Livolog 里用惯这套输入（统计页的起止日期）。
                 这里换个花样会让他学两遍。

              ⚠️ 为什么不用 <input type="date">：
                 · 它只接受**完整日期**，塞 "2015" 会被浏览器静默清空
                   （实测），「只填年」这条根本做不到；
                 · 显示格式由系统 locale 决定 —— 中文环境显示「年/月/日」，
                   而不是想要的 YYYY-MM-DD；
                 · 它强制带原生日历弹窗，与手输的交互不是一回事。

              ⚠️ Livolog 的实现里有三个细节，自己写很容易漏：

                 ① placeholder 用 `YYYY`/`MM`/`DD` 提示位数，
                    不能只靠 aria-label（那是给读屏的，眼睛看不见）；
                 ② focus 时 `select()` 全选 —— 点进去直接打字就能覆盖，
                    不用先按退格删掉旧值；
                 ③ 在**空**框里按退格要回退到上一格 ——
                    否则连按退格会卡住，用户得手动点回去改前一位。

                 补充：填满自动跳下一格（Livolog 也有）。
            */
            var group = document.createElement('div');
            group.className = 'detail-date';

            /*
              ⚠️ 八个**单字符**输入框，均分整行宽度（用户要求
                 「八个数字框占满一行」）。

                 位置：0-3 年、4-5 月、6-7 日。
                 中间两个分隔符 "-" 插在 4 和 6 之前。

              ⚠️ 为什么用 8 个单字框，而不是 3 个多位框：
                 单字框的「填满即跳下一格」是**逐位**发生的，
                 用户连续敲 20150624 就能自动走完，
                 不用在年/月/日之间手动点三次。

              ⚠️ 值按**位**取，不按字段取。
                 存储里的 "2015-06-24" 要先剥成 "20150624" 再逐位填 ——
                 否则分隔符的位置和位数对不上（见 parseDateDigits）。
            */
            var digits = parseDateDigits(value);

            /*
              ⚠️⚠️ 必须给每一格开一个**独立的作用域**（IIFE），
                     不能直接在 for 循环里用 `var seg` 绑事件。

                     踩过的坑（本项目最隐蔽的一个）：写的是

                         for (var i = 0; i < 8; i++) {
                             var seg = document.createElement('input');
                             seg.addEventListener('keydown', function () {
                                 ... seg.value = event.key; ...
                             });
                         }

                     `var` 是**函数作用域**，8 次循环共用同一个 `seg` 变量。
                     等用户按键时循环早已结束，`seg` 停在最后一次赋的值上
                     —— 也就是第 8 格。

                     实测症状：**无论点进哪一格，输入都写进最后一格**，
                     焦点也跳到最后一格。逐个格派发 keydown 验证：
                     从第 0/1/2/3 格发起，结果全都是 `_______9`。

                     ⚠️ 这个 bug 极难从现象反推：「输入跑到最后一格」
                     看起来像焦点管理或索引算错（我先后怀疑过 4 种时序
                     问题，都不是）。**判据**：如果「所有元素表现一致，
                     且都指向最后一个」，先怀疑循环变量捕获。

                     ⚠️ 用 IIFE 而不是 `let`：这个文件通篇是 ES5 写法
                     （为了兼容老 WebView），混用 let 会不一致。
            */
            for (var i = 0; i < DATE_SLOTS; i++) {
                (function (slotIndex) {
                // 4 位（年后）与 6 位（月后）之前插 "-"
                if (slotIndex === 4 || slotIndex === 6) {
                    var sep = document.createElement('span');
                    sep.className = 'detail-date-sep';
                    sep.setAttribute('aria-hidden', 'true');
                    sep.textContent = '-';
                    group.appendChild(sep);
                }

                var seg = document.createElement('input');
                seg.className = 'detail-date-seg';
                seg.type = 'text';
                seg.inputMode = 'numeric';
                seg.autocomplete = 'off';
                seg.autocapitalize = 'off';
                seg.spellcheck = false;
                /*
                  ⚠️ **不要设 maxLength**。

                     踩过的坑：设了 maxLength=1 之后，连续输入 "2015"
                     只有第 1 个字符进得去 —— 因为格子填满后，
                     maxLength 会在字符插入**之前**就拦掉后续按键，
                     连 `input` 事件都不触发，于是「填满即跳下一格」
                     的代码根本没机会执行。实测表现为：
                     8 格永远只有第 1 格有值，焦点不动。

                     正确做法：**不限制 DOM 层面的长度**，
                     由下面的 input 处理器自己取「最后一位数字」
                     并把多余的丢掉。这样每次按键都会触发 input，
                     跳格逻辑才跑得起来。
                */
                seg.value = digits[slotIndex] || '';
                /*
                  ⚠️ placeholder 逐位给「YYYYMMDD」里的对应字符。

                     用户要求：「里面的提示填充文字也得是 YYYY-MM-DD」。

                     于是 8 个格子依次显示：
                        Y Y Y Y - M M - D D
                     拼起来读就是 YYYY-MM-DD —— 用户一眼知道
                     「第 1 格填年的千位、第 5 格填月的十位」，
                     不用猜每一格该填什么。

                  ⚠️ 不能给整串 "YYYY-MM-DD"（那样每格都显示全部，
                     反而看不懂）。所以按位取字符。

                  ⚠️ 这个 placeholder 同时承担另一个职责：
                     它是 `:placeholder-shown` 的触发条件 ——
                     空格子的边框画淡靠它（见 styles.css）。
                     所以**绝不能留空**。
                */
                seg.placeholder = DATE_HINT.charAt(slotIndex) || ' ';
                seg.setAttribute('aria-label', dateSlotLabel(slotIndex));
                seg.dataset.index = String(slotIndex);

                /*
                  ⚠️ `overwriteArmed`：这一格是否处于「用户要来改这一位」状态。

                     背景（两个 bug 互相拉扯，必须同时满足）：

                       bug A（连打）：用户依次打 20150624，
                         焦点不动，每次按键都要落到**顺序的下一个空格**。
                       bug B（修改）：用户点进某个已填的格子改一位，
                         按键必须**覆盖这一格**，而不是往后找空位。

                     单看"当前格有没有值"分不出这两者 ——
                     连打时第一键之后当前格就有值了，
                     若一律覆盖，结果就是 `4_______`（实测踩到）。

                     ⚠️ 判据：**这一格的 focus 是不是由"点击"引发的**。
                        · 点击进入 → 用户有明确的"改这一位"意图 → 覆盖；
                        · 连打过程中焦点自己移过来（或压根没动）
                          → 没有点击意图 → 顺序往后找空位。

                     ⚠️ 为什么用 focus 事件而不是 click 事件：
                        格子可能被**键盘/Tab**聚焦，也可能被
                        spreadDigits 里的逻辑聚焦 —— 那些都不该
                        触发覆盖。focus 是"焦点真的落到这里"的唯一
                        统一入口，click 只是其中一种成因。
                        所以这里在 focus 里置位，并在第一次
                        按键后立刻消费掉（见 keydown）。
                */
                var overwriteArmed = false;

                /*
                  ⚠️ 输入走 keydown，焦点**不逐格移动** ——
                     改为「把这一位写进第一个空格」。

                     ══ 为什么不用「填一格跳一格」（踩了 4 轮坑）══

                     最初的写法是：每格填上就 focus() 下一格。
                     试过 4 种做法，全都不成立（弹层确认是打开的）：

                       ① input 里同步 focus()      → 被本次按键后续处理覆盖
                       ② setTimeout(fn, 0)         → 同一批次，仍被覆盖
                       ③ requestAnimationFrame     → 同样无效
                       ④ keydown 里 preventDefault + focus()

                     ④ 看起来对了（焦点确实动了），但产生新问题：
                     连打 20150624 时，每次按键都把焦点推一格，
                     而**打字速度比焦点落定快** ——
                     实测结果变成 `[0,0,0,0,0,0,0,1]`，
                     只有最后一位落进末格，前面全空。

                     根因：在「按键」这个粒度上挪焦点，就等于
                     假设每次按键之间焦点一定已经落定。这个假设
                     在真实设备上也不可靠（尤其输入法、快速连打）。

                     ══ 现在的做法 ══

                     焦点**留在用户点的那个格子里不动**；
                     每次按键把这一位写进「从当前格起第一个空位」。
                     写完把光标留在那一格，用户继续打就行。

                     于是连打 20150624 的结果必然是 2,0,1,5,0,6,2,4
                     依次落进 8 个格子 —— 不依赖任何时序假设。

                     ⚠️ 覆盖已填的格子：若用户点回第 3 格重打，
                        会把第 3 格改掉，**不会**往后堆。
                        这是刻意的（见下）。
                */
                seg.addEventListener('keydown', function (event) {
                    /*
                      ⚠️ 退格：当前格有值就清掉，空格就回上一格清掉。
                    */
                    if (event.key === 'Backspace') {
                        event.preventDefault();
                        if (seg.value) {
                            seg.value = '';
                        } else {
                            var prev = siblingSeg(seg, -1);
                            if (prev) {
                                prev.value = '';
                                prev.focus();
                            }
                        }
                        syncDateToDraft(field.key);
                        return;
                    }

                    // 只接管单个数字键；其余（Tab / 方向键 / 组合键）放行
                    if (event.key.length !== 1 || !/\d/.test(event.key)) return;
                    if (event.ctrlKey || event.metaKey || event.altKey) return;

                    /*
                      ⚠️ preventDefault：不让浏览器自己插入。
                         由我们写入并同步值，避免"浏览器先插一次、
                         我们再覆盖"造成的双写与焦点竞争。
                    */
                    event.preventDefault();

                    /*
                      ══ 写入位置 ══

                      两种意图，靠 `overwriteArmed` 区分（见它的声明处）：

                      ⚠️① **overwriteArmed = true**：用户刚点进这一格，
                            明确要来改这一位 → **覆盖当前格**。

                            消费掉标记（一帧只服务一次点击）——
                            否则连打时第一次按键覆盖了当前格，
                            后续按键还会继续覆盖同一格，
                            结果就是 `4_______`（实测踩过）。

                      ⚠️② **未 armed**：连打中。从当前格起往后找第一个空位。

                      ⚠️③ 往后也找不到空位（8 格全满且未 armed）→
                            退回覆盖**当前格**，而不是丢弃按键。

                            丢弃会让用户以为输入坏了 ——
                            这正是"卡在前两位不动"那个 bug 的成因。
                */
                    var target = null;

                    if (overwriteArmed) {
                        // 消费掉：这一格只在"刚点进来"的第一次按键时覆盖
                        overwriteArmed = false;
                        target = seg;
                    } else {
                        target = seg;
                        while (target && target.value) {
                            target = siblingSeg(target, 1);
                        }
                        /*
                          ⚠️ 连打走到这里说明**当前格是空**（所以第一轮
                             while 不执行，target 仍是 seg）。
                             若 while 走完变成 null，说明从当前格到末尾
                             全满 —— 覆盖当前格比丢弃好。
                        */
                        if (!target) target = seg;
                    }

                    target.value = event.key;

                    /*
                      ⚠️ 光标要落在**真正被写入的那一格**上。

                         连打时焦点可能停在别的格（比如第 1 格），
                         而写入落到了后面的空格 —— 把光标移过去，
                         后续输入才连贯，用户也能看到"写到哪了"。
                    */
                    if (target !== seg && document.activeElement !== target) {
                        target.focus();
                    }

                    syncDateToDraft(field.key);
                });

                seg.addEventListener('input', function () {
                    /*
                      ⚠️ input 只处理**粘贴**（keydown 拿不到剪贴板内容）。

                         单次按键已在 keydown 里防止了默认插入，
                         所以走到这里的多字符必然来自粘贴/输入法上屏 ——
                         铺开正合适。
                    */
                    var d = seg.value.replace(/\D/g, '');
                    if (d.length > 1) {
                        spreadDigits(seg, d, field.key);
                        return;
                    }
                    syncDateToDraft(field.key);
                });

                /*
                  ⚠️ 显式监听 paste，**不要只靠 input**。

                     踩过的坑：Android WebView 里粘贴一个 "20150624"，
                     若起始格已有值且被 select() 全选，浏览器会
                     用粘贴内容**替换**选区，但仍只放进这一格 ——
                     input 里 seg.value 变成 "20150624"，理论上是能铺开的，
                     但实测某些 WebView 版本会把插入截断到 1 个字符
                     （受 inputMode=numeric 影响），input 里只剩 1 位，
                     于是铺开分支根本进不去，多出的位次直接丢失。

                     显式拿 clipboardData 自己铺，就绕开了浏览器的插入行为。
                */
                seg.addEventListener('paste', function (event) {
                    var clip = event.clipboardData || window.clipboardData;
                    if (!clip) return;   // 拿不到就让浏览器按默认行为走
                    var text = clip.getData('text') || '';
                    var d = text.replace(/\D/g, '');
                    if (!d) return;
                    event.preventDefault();
                    spreadDigits(seg, d, field.key);
                });

                /*
                  ⚠️ 用 pointerdown（不是 click）来标记「用户是点进来的」。

                     理由：click 在 **mouseup 之后**才触发，而用户
                     点一下立刻打字时，keydown 可能早于 click ——
                     那时标记还没置上，按键会走"往后找空位"，
                     表现为"点了却改不了"。pointerdown 早于一切
                     输入事件，时序上必然已经置好位。

                     ⚠️ 它只负责记录"这一次 focus 是点击引起的"；
                        真正决定是否覆盖在 focus 里做（见下），
                        因为覆盖还要求「格子已有值」。
                */
                var pointerArmed = false;
                seg.addEventListener('pointerdown', function () {
                    pointerArmed = true;
                });

                seg.addEventListener('focus', function () {
                    /*
                      ⚠️ 判定「用户要来改这一位」并 arm 覆盖模式。

                         两个条件缺一不可：
                           ① 这次 focus 由 pointerdown 引起
                              （或由键盘 Tab 引起 —— 见下面的说明）；
                           ② 这一格**已有值**（空格子没有"改"的语义）。

                         ⚠️ 为什么必须排除「连打时 keydown 里的
                            target.focus()」这条路径：
                            它也会触发 focus。若无条件 arm，
                            连打的每一键都会变成覆盖同一格 ——
                            实测结果 `4_______`（只留最后一位）。
                            而 pointerArmed 在那条路径上是 false
                            （是代码调 focus()，没有 pointerdown），
                            所以能正确区分。

                         ⚠️ 键盘用户（Tab）没有 pointerdown。
                            这里用「focus 时没有 pointerArmed 且
                            不是连打路径」无法与连打区分 ——
                            所以键盘场景**不做 arm**：
                            键盘用户可以用 Backspace 清掉一位再填，
                            而连打（最常见的输入方式）绝不能被破坏。
                            取舍明确：宁可键盘改一位要多按一下退格，
                            也不能让连打失效。
                    */
                    if (seg.value && pointerArmed) overwriteArmed = true;
                    pointerArmed = false;

                    /*
                      ⚠️ 只对**已有内容**的格子全选。

                         空格子是「准备接下一个字符」的状态，
                         全选会把它变成覆盖模式，看起来像输入被吃掉。

                      ⚠️⚠️ 但**不能只靠 select()**（踩过的坑）。

                         实测（Android WebView + Playwright 都复现）：
                         点击一个有值的单字格，`select()` 之后
                         `selectionStart/selectionEnd` 是 `0-0`
                         —— 也就是**光标没选中任何字符**，
                         而不是期望的 `0-1` 全选。

                         ⚠️ 所以这里**不依赖 select() 的结果**：
                            覆盖行为完全由 `overwriteArmed` 决定
                            （见上面的写入位置注释 ①），
                            select() 只是**尽力**给出视觉反馈。

                         ⚠️ 用 requestAnimationFrame 再 select 一次：
                            点击时浏览器会在 mouseup 后重置选区，
                            同步调用 select() 会被这次重置覆盖掉。
                            推迟一帧才落得住 —— 这是修复
                            `0-0` 那个现象的实际措施。
                    */
                    if (!seg.value) return;
                    seg.select();
                    if (typeof global.requestAnimationFrame === 'function') {
                        global.requestAnimationFrame(function () {
                            /*
                              ⚠️ 再确认一次仍是当前焦点格。
                                 一帧之内用户可能已经点到别处了，
                                 那时不该抢他的选区。
                            */
                            if (document.activeElement === seg) seg.select();
                        });
                    }
                });

                group.appendChild(seg);
                inputs[field.key + '-slot' + slotIndex] = seg;
                })(i);
            }

            wrap.appendChild(group);
            return wrap;
        }

        /*
          ══ DOI：恒定的 "10." 前缀 + 注册机构号 / 后缀 ══

          ⚠️ 形态："10." 是**装饰性前缀**（不可编辑、无边框），
             后面两个圆角框分别是注册机构号与后缀，中间一个 "/"。

                 10. [ 1038 ] / [ nature14539 ]

             ⚠️ 为什么把 "10." 拿出来当装饰：
                DOI 的语法（ISO 26324）规定前缀一定是 "10." 开头，
                让用户每次打这 3 个字符是纯粹的浪费，而且打了还可能打错。
                但**它属于值的一部分** —— 拼接时必须带上（joinDoi）。

          ⚠️ 用两个框而不是一个：
             用户要求「DOI 也有自己的格式，把输入框形式化」。
             前缀（注册机构号）与后缀语义不同：
               · 前缀是**注册机构**（1038 = Nature，1109 = IEEE），
                 有权威列表可校验；
               · 后缀是发行方自定义的，任意字符。
             分开之后将来可以只对前缀做校验/联想，不影响后缀。

          ⚠️ 存储值仍是完整字符串，与老数据兼容 —— 输入形式变了，键没变。
        */
        if (field.kind === 'doi') {
            return buildDoiField(field, value);
        }

        var input = document.createElement('input');
        input.className = 'detail-input';
        input.id = 'detail-input-' + field.key;
        input.value = value;
        input.autocomplete = 'off';
        // 元数据都是术语/编号，自动首字母大写会帮倒忙
        input.autocapitalize = 'off';
        input.spellcheck = false;
        if (field.maxLength) input.maxLength = field.maxLength;

        /*
          ⚠️ 占位提示（用户要求：「所有空的输入框都给个提示填充文字」）。

             ⚠️ 提示键由字段自己给（meta.js 的 field.placeholder），
                不在这里按 key 硬编码 switch —— 加字段时只改一个地方。

             ⚠️ 提示文字里**都带一个真实示例值**（"e.g. 521"），
                而不是干巴巴的量词（"卷号"）。
                理由：用户看到示例才知道格式约定
                （卷是纯数字、页码不带 "pp."、ISBN 带连字符），
                量词说明不了这些。
        */
        if (field.placeholder) {
            input.placeholder = t(field.placeholder);
        }

        /*
          ⚠️ kind = 'number'：**只过滤字符，不做数值校验**。

             用户要求页码「划分为两个框」，但没说必须合法。
             `inputMode = 'numeric'` 让手机弹数字键盘；
             同时在 input 里剥掉非数字，避免 "436a" 这种混入
             （虽然不做拦截，但也不主动放进来）。

             ⚠️ 不用 `<input type="number">`：
                · 它在部分 WebView 里会显示上下调节箭头；
                · 值非法时 `input.value` 返回**空串**（而不是原始输入），
                  表现为「打了一个字母，整格突然清空」—— 很惊悚；
                · 我们存的是字符串，number 类型的科学计数法转换是多余的。
        */
        if (field.kind === 'number') {
            input.inputMode = 'numeric';
            input.addEventListener('input', function () {
                var cleaned = input.value.replace(/[^\d\u2013\u2014-]/g, '');
                if (cleaned !== input.value) {
                    // ⚠️ 只在真的变了时才回写，避免打断输入法的组合状态
                    input.value = cleaned;
                }
                writeValue(field.key, cleaned);
            });
            inputs[field.key] = input;
            wrap.appendChild(input);
            return wrap;
        }

        input.addEventListener('input', function () {
            writeValue(field.key, input.value);
        });

        inputs[field.key] = input;
        wrap.appendChild(input);
        return wrap;
    }

    /**
     * 造 DOI 行的输入控件：`10.` + [注册机构号] + `/` + [后缀]。
     *
     * ⚠️ 两个框都走 `writeDoiToDraft()` 拼回完整串写进 draft，
     *    所以**存储层完全不知道**这里是两个框 ——
     *    collectPatch() 拿到的仍是 `10.1038/nature14539`。
     *
     * ⚠️ 两个子框分别登记在 inputs 表里（`<key>-registrant` /
     *    `<key>-suffix`），与日期的 `-slotN` 同一套约定。
     *    但 **`inputs[field.key]` 不登记** —— 它不是一个真实控件，
     *    真正的值在 draft 里（由 collectPatch 读 draft 还是读 inputs？
     *    见下面 collectPatch 的特判）。
     *
     * @param {Object} field 字段定义（key / label / maxLength）
     * @param {string} value 当前 DOI 完整串
     * @returns {HTMLElement} 字段行
     */
    function buildDoiField(field, value) {
        var wrap = document.createElement('div');
        wrap.className = 'detail-field';

        var label = document.createElement('label');
        label.className = 'detail-field-label';
        label.textContent = t(field.label);
        label.setAttribute('for', 'detail-input-' + field.key);
        wrap.appendChild(label);

        var parts = global.ScholariusMeta
            ? global.ScholariusMeta.splitDoi(value)
            : { registrant: '', suffix: '' };

        var row = document.createElement('div');
        row.className = 'detail-join-row detail-doi';

        /*
          ⚠️ "10." 是**纯装饰**的 <span>，不是 input。

             ⚠️ 它必须与 <input> 视觉上连成一体（等宽字体、同字号、
                同一基线），否则看起来像两个不相干的东西。
                样式见 styles.css 的 .detail-join-prefix。

             ⚠️ aria-hidden：读屏用户不需要听到 "10." ——
                它在拼回的完整值里，且对输入无意义。
        */
        var prefix = document.createElement('span');
        prefix.className = 'detail-join-prefix';
        prefix.setAttribute('aria-hidden', 'true');
        prefix.textContent = global.ScholariusMeta
            ? global.ScholariusMeta.DOI_PREFIX
            : '10.';
        row.appendChild(prefix);

        var reg = document.createElement('input');
        reg.className = 'detail-input detail-join-seg detail-join-registrant';
        reg.id = 'detail-input-' + field.key;
        reg.type = 'text';
        reg.inputMode = 'numeric';
        reg.autocomplete = 'off';
        reg.autocapitalize = 'off';
        reg.spellcheck = false;
        reg.value = parts.registrant;
        reg.placeholder = '1038';
        reg.setAttribute('aria-label', t('vault.field.doiRegistrant'));
        row.appendChild(reg);

        var slash = document.createElement('span');
        slash.className = 'detail-join-sep';
        slash.setAttribute('aria-hidden', 'true');
        slash.textContent = '/';
        row.appendChild(slash);

        var suf = document.createElement('input');
        suf.className = 'detail-input detail-join-seg detail-join-suffix';
        suf.id = 'detail-input-' + field.key + '-suffix';
        suf.type = 'text';
        suf.autocomplete = 'off';
        suf.autocapitalize = 'off';
        suf.spellcheck = false;
        suf.value = parts.suffix;
        suf.placeholder = 'nature14539';
        suf.setAttribute('aria-label', t('vault.field.doiSuffix'));
        row.appendChild(suf);

        function writeDoiToDraft() {
            /*
              ⚠️ 注册机构号框里只保留数字 ——
                 注册机构号按规范一定是数字（4~9 位）。
            */
            var r = reg.value.replace(/\D/g, '');
            if (r !== reg.value) reg.value = r;

            var full = global.ScholariusMeta
                ? global.ScholariusMeta.joinDoi(r, suf.value)
                : r;
            writeValue(field.key, full);
        }

        /*
          ⚠️ **粘贴 / 一次填入整串**的处理 —— 这是必需的，不是锦上添花。

             踩过的坑：用户从浏览器或 PDF 里复制一个完整 DOI
             （"https://doi.org/10.1038/nature14539"），
             粘到**注册机构号**那个框里。
             若只做「剥掉非数字」，那一串会被碾成
             "10103814539"（斜杠被删除 → 注册机构号与后缀黏在一起），
             存进去的 DOI 就是 "10.10103814539" —— **静默损坏**，
             而且用户看不出哪里错了（实测过，确实发生）。

             正确做法：检测到"一次进来的内容里带了 DOI 结构"时，
             用 splitDoi 把它**拆开重新分配到两个框**，
             而不是在单个框里做字符过滤。

          ⚠️ 触发条件是「值里含 "/" 或含 "10."」而不是「长度 > N」：
             用户正常逐位打 "1038" 时长度也会到 4，
             不能凭长度判断这是粘贴。
        */
        function absorbPastedDoi(sourceEl, otherEl) {
            var raw = sourceEl.value;
            if (!raw) return false;
            // 只在「看起来是一整串 DOI」时才接管
            if (raw.indexOf('/') < 0 && raw.indexOf('10.') < 0) return false;

            var parts = global.ScholariusMeta
                ? global.ScholariusMeta.splitDoi(raw)
                : null;
            if (!parts) return false;

            reg.value = parts.registrant;
            suf.value = parts.suffix;
            writeDoiToDraft();
            return true;
        }

        reg.addEventListener('input', function () {
            if (absorbPastedDoi(reg, suf)) return;
            writeDoiToDraft();
        });
        suf.addEventListener('input', function () {
            if (absorbPastedDoi(suf, reg)) return;
            writeDoiToDraft();
        });

        /*
          ⚠️ 两个子框都登记（用于 focus 恢复 / 测试断言），
             但 **inputs[field.key] 故意不登记** ——
             它是"一个字段两个控件"，登记单个控件会误导
             collectPatch 去读一个数不到完整值的元素。
             完整值从 draft 读（见 collectPatch 的 doi 特判）。
        */
        inputs[field.key + '-registrant'] = reg;
        inputs[field.key + '-suffix'] = suf;

        wrap.appendChild(row);

        /*
          ⚠️ **不要加"完整示例"说明行**（曾经加过，已删除）。

             用户指出：「DOI 下方不需要提示文字啊，输入框里不是有吗？」

             他是对的，而且理由比"省一行"更硬：
             两个框里已经有 placeholder（"1038" / "nature14539"），
             它们**就在填的位置上**，用户低头就看见。
             再在下方挂一行 "e.g. 10.1038/nature14539" 是同一信息的第二次陈述 ——
             而且那行是"10."前缀的说明，前缀本身已经画在框左边了，
             等于把已经可见的东西又用文字重复一遍。

          ⚠️ 顺带一个代价：那一行让 DOI 字段比其他字段高出一截，
             在 85vh 的滚动区里是实打实的空间浪费。
        */

        return wrap;
    }

    /**
     * 日期一共几位：YYYY(4) + MM(2) + DD(2)。
     *
     * ⚠️ 分隔符**不占格**（它们是插在格与格之间的 span），
     *    所以位数就是纯数字的个数。
     */
    var DATE_SLOTS = 8;

    /**
     * 逐位提示文字，**只含数字位的字母**，不含分隔符。
     *
     * ⚠️ 长度必须等于 DATE_SLOTS（8），且**不能**写成 "YYYY-MM-DD"。
     *
     *    踩过的坑：曾把提示串写成 "YYYY-MM-DD"（长度 10），
     *    然后按 `charAt(i)` 逐格取 —— 于是第 4 格（下标 4）
     *    取到的是 "-" 而不是月份的第一个 M，8 个格子显示成
     *    `Y Y Y Y - M M -`，最后两个日的位置还取不到字符（空）。
     *
     *    根因：提示串里有没有分隔符，与**格子有没有分隔符**是两件事。
     *    分隔符是 HTML 里的 span，不占格子；提示串只服务格子。
     *    两者混在一起数位就会错。
     *
     *    显示效果（- 是 HTML 的 span）：
     *      [Y][Y][Y][Y] - [M][M] - [D][D]
     */
    var DATE_HINT = 'YYYYMMDD';

    /**
     * 某一格的读屏标签。
     *
     * ⚠️ 单字框没有可见标签（8 格并排不可能每个都写标签），
     *    所以 aria-label 是**唯一**能让读屏用户知道
     *    「现在在第几位」的信息。
     *
     * ⚠️ 不去 i18n 里为每一格建键 —— 那样要 8 个键且语义重复。
     *    这里按「属于哪一段」拼出来更直接。
     */
    function dateSlotLabel(i) {
        var part = i < 4 ? 'year' : (i < 6 ? 'month' : 'day');
        // 段内序号：年是 1-4，月/日是 1-2
        var posInPart = i < 4 ? (i + 1) : (i < 6 ? (i - 4 + 1) : (i - 6 + 1));
        return t('detail.datePart.' + part) + ' ' + posInPart;
    }

    /**
     * 把一串数字从某一格开始顺次铺到后面的格子里。
     *
     * ⚠️ 用途：**粘贴**（以及部分输入法一次上屏多个字符）。
     *    单字格的 maxLength 已被刻意去掉（见 buildField 的注释），
     *    所以「一次进来 8 个字符」是可能发生的 ——
     *    这时不能让它们挤在一格里然后丢掉大部分，
     *    而要铺开，让粘贴 "20150624" 能一次填满整行。
     *
     * ⚠️ 起点是**传入的那一格**，不是第 0 格 ——
     *    用户可能在第 5 格粘贴（想从月的位置开始填），
     *    从第 0 格开始会覆盖他已有的年份。
     *
     * ⚠️ 铺完后焦点落在**下一个空格**（没有空格就留在最后一格），
     *    这样用户接着打字是自然的续写。
     *
     * @param {HTMLElement} startSeg 起始格
     * @param {string} digits 纯数字串
     * @param {string} [fieldKey] 字段名；给了就直接用它同步 draft
     */
    function spreadDigits(startSeg, digits, fieldKey) {
        var wrap = startSeg.parentNode;
        if (!wrap) return;
        var all = Array.prototype.slice.call(
            wrap.querySelectorAll('.detail-date-seg')
        );
        var start = all.indexOf(startSeg);
        if (start < 0) return;

        for (var i = 0; i < digits.length; i++) {
            var cell = all[start + i];
            if (!cell) break;   // 超出末尾就丢弃多余字符
            cell.value = digits.charAt(i);
        }

        // 清掉起始格后面、本次未被覆盖的残留（粘贴短串时避免旧值还在）
        for (var j = start + digits.length; j < all.length; j++) {
            all[j].value = '';
        }

        /*
          ⚠️ **不要在这里 focus**。

             实测：粘贴后调 focus() 会被 WebView 回退，
             并且焦点争夺会让随后的一次输入落错格。
             焦点保持不动即可 —— keydown 的写入逻辑
             本来就是"从当前格往后找空位"，不依赖焦点。
        */

        // ⚠️ 铺开后要刷一次 draft —— 否则只更新了 DOM，值没进 draft
        if (fieldKey) {
            syncDateToDraft(fieldKey);
        } else {
            syncDateToDraftByWrap(wrap);
        }
    }

    /**
     * 从容器反查它属于哪个字段，然后同步 draft。
     *
     * ⚠️ 存在的理由：spreadDigits 只拿到 DOM 容器（它由 startSeg.parentNode
     *    取得），没有字段 key。而 key 是我们自己生成的 `-slotN` 前缀，
     *    从 inputs 表反查得到 —— 比给容器挂 dataset 更省事。
     */
    function syncDateToDraftByWrap(wrap) {
        var segs = wrap.querySelectorAll('.detail-date-seg');
        if (!segs.length) return;
        for (var key in inputs) {
            if (inputs[key] === segs[0]) {
                /*
                  ⚠️ key 形如 `year-slot0`，**必须**去掉 `-slot0` 后缀
                     才是字段名。直接传 key 会让 writeValue 写到
                     `draft['year-slot0']` 上去（一个不存在的顶层键），
                     表现为「粘贴后保存丢了」。
                */
                syncDateToDraft(key.replace(/-slot0$/, ''));
                return;
            }
        }
    }

    /**
     * 取相邻的格子（不移动焦点）。
     *
     * ⚠️ 作用域限定在同一个 .detail-date 容器内，不是整页找 `.detail-date-seg`。
     *    将来若有第二个日期字段，全局查找会跨字段乱跳。
     *
     * @param {HTMLElement} seg 当前格
     * @param {number} step +1 下一格 / -1 上一格
     * @returns {HTMLElement|null} 相邻格；越界返回 null
     */
    function siblingSeg(seg, step) {
        var wrap = seg.parentNode;
        if (!wrap) return null;
        var all = Array.prototype.slice.call(
            wrap.querySelectorAll('.detail-date-seg')
        );
        var idx = all.indexOf(seg);
        if (idx < 0) return null;
        return all[idx + step] || null;
    }

    /**
     * 焦点移到相邻格。
     *
     * ⚠️ 只在**退格**路径使用（把光标退回上一格）。
     *    输入数字时**不**用这个 —— 逐格跳的时序不可靠，
     *    见 buildField 里日期输入那段的长注释。
     */
    function focusDateSibling(seg, step) {
        var next = siblingSeg(seg, step);
        if (next) next.focus();
    }

    /**
     * 存储值 → 8 个格子的初值（按位）。
     *
     * ⚠️ 先**剥成纯数字串**再按位填，不是把 "2015-06-24" 切三段。
     *
     *    理由：8 格方案里每格只放一个字符，
     *    而分隔符（"-"）自己占一格位置 ——
     *    若按「年段/月段/日段」填，分隔符的位置就无处安放。
     *    剥成 "20150624" 后逐位对照，位置天然对齐。
     *
     * ⚠️ 补到 8 位时**不补零**，只按已有位数填。
     *    "2015" → 前 4 格有值、后 4 格空 —— 这样用户一眼看出
     *    自己只填到了年，而不是被自动补成 "2015-00-00"。
     *
     * @param {string} raw
     * @returns {string} 0-8 位的数字串
     */
    function parseDateDigits(raw) {
        var s = String(raw || '').trim();
        if (!s) return '';
        var digits = s.replace(/\D/g, '');
        return digits.slice(0, DATE_SLOTS);
    }

    /**
     * 8 个格子 → 存储值，写进 draft。
     *
     * ⚠️ 按**用户填到的最高位**决定粒度，不补零：
     *      只填到第 4 格        → "2015"
     *      填到第 6 格          → "2015-06"
     *      填到第 8 格          → "2015-06-24"
     *
     * ⚠️ **必须从第 1 格起连续**，中间不能空。
     *    踩不到的坑要提前堵：用户可能只填了年和日、漏了月，
     *    此时把格子的值直接拼起来会得到 "2015" + "" + "24" = "201524"，
     *    长度是 6 → 会被当成 "2015-24"（12 月？）—— 完全错乱。
     *
     *    所以这里**先找出最后一个已填格**，若它之前有空位
     *    就**整串丢弃**（返回空）。宁可暂时不存，也不能存错的。
     *    用户填完月那一刻，空位消失，值自然就存进去了。
     *
     * ⚠️ 年不足 4 位也丢弃（"201" 不是年份）。
     */
    function syncDateToDraft(key) {
        if (!draft) return;

        var cells = [];
        for (var i = 0; i < DATE_SLOTS; i++) {
            var el = inputs[key + '-slot' + i];
            var ch = el ? String(el.value || '').replace(/\D/g, '') : '';
            cells.push(ch ? ch.charAt(0) : '');
        }

        // 最后一个已填格的下标；全空则 -1
        var last = -1;
        for (var j = DATE_SLOTS - 1; j >= 0; j--) {
            if (cells[j]) { last = j; break; }
        }
        if (last < 0) {
            writeValue(key, '');
            return;
        }

        // ⚠️ 从第 1 格到 last 必须连续，有一个空位就整串作废
        for (var k = 0; k <= last; k++) {
            if (!cells[k]) {
                writeValue(key, '');
                return;
            }
        }

        // 年不够 4 位 → 还不是合法年份
        if (last < 3) {
            writeValue(key, '');
            return;
        }

        var buf = cells.slice(0, last + 1).join('');
        var out = buf.slice(0, 4);
        if (buf.length >= 6) out += '-' + buf.slice(4, 6);
        if (buf.length >= 8) out += '-' + buf.slice(6, 8);

        writeValue(key, out);
    }

    /**
     * 只读信息：来源文件 / 文件页数。
     *
     * ⚠️ 形态与上面的可编辑字段**完全一致**（标签在上、值在下），
     *    只是值是纯文本而非 <input>。

     *    用户要求：「把来源文件和文件页数都跟上面的表单一样，
     *    把值换行处理，只不过不给输入框，意思是无法改动的信息」。
     *
     * ⚠️ 为什么不用 <input disabled>：
     *     disabled 的输入框在很多 WebView 里颜色被系统强制改掉，
     *     而且它仍然可聚焦、会进 Tab 序列 —— 对一个纯展示项是干扰。
     *     用 <div> 才能真正表达「这不是输入控件」。
     *
     * ⚠️ 追加到 #detail-fields（与可编辑字段同一个容器），
     *    不是单独一组 —— 因为已经没有「File」标题了，
     *    它们就是这个字段列表的延续。
     */
    function renderReadonly() {
        if (!fieldsEl || !currentDoc) return;

        var rows = [
            {
                label: t('detail.sourceFile'),
                value: currentDoc.sourceName || t('meta.placeholder')
            },
            {
                /*
                  ⚠️ 这里是「文件页数」，不是元数据里的「起止页码」。

                     两者定义不同：
                       · 起止页码（Page Range, 如 436-444）
                         = 论文**在发表载体中的位置**，属于元数据，用户可填
                       · 文件页数（File Pages, 如 11）
                         = **这个 PDF 文件**有几页，属于文件属性，用户填不了

                     而且它们会不一致：同一篇论文的 arXiv 版和出版版
                     页数往往不同，起止页码却不变。

                     ⚠️ 所以**不能**复用卡片用的 vault.pages（那是简短形式，
                        卡片宽度有限），这里用 detail.filePages 把「文件」
                        这个限定词写出来，与 Page Range 区分开。
                */
                label: t('detail.filePages'),
                value: currentDoc.pages
                    ? tWith('vault.pages', { n: currentDoc.pages })
                    : t('meta.placeholder'),
                /*
                  ⚠️ 页数**排成一行**（标签靠左、值靠右），
                     与上面「文章简称」那一行同一形态。

                     用户 2026-09-24：「文件页数单行显示呢？」
                     并按确认的选项选了「标签左、值右，同一行
                     （像上面的 Short Name 行）」。

                     ⚠️ 为什么页数可以一行、文件名不行：
                        页数最多 "1234 Pages" 十几个字符，一行放得下；
                        文件名能到 60+ 字符（"2015_深度学习里程碑综述_
                        Nature_LeCun.pdf"），硬排一行会被截断成
                        看不出是哪个文件 —— 而文件名正是辨认文献的关键。
                        所以**只有页数**改单行，来源文件保持两行。
                        （用户也明确选了「来源文件保持两行不动」。）

                     ⚠️ 省下的是**一整行高度**（约 27px）。
                        详情页最多 85vh，字段却有二十来个，
                        每一行都是抠出来的。
                */
                singleRow: true
            }
        ];

        rows.forEach(function (row) {
            var wrap = document.createElement('div');
            /*
              ⚠️ 复用 .detail-field —— 于是它自动获得与 Title/Author
                 相同的间距与 min-height。不要另起一个类名，
                 否则两处的高度规则会各自漂移。
            */
            wrap.className = 'detail-field detail-field-readonly';

            /*
              ⚠️ 单行形态挂的是 .detail-field-inline，不是 .detail-field。

                 为什么换类而不是在这个类上覆盖 flex-direction：
                 .detail-field 的 `flex-direction: column` 是它的**定义**
                 （所有整行字段都靠它），在这里覆盖属于"反着用再改回来"，
                 将来改 .detail-field 时很容易把这条覆盖漏掉。
                 直接换成横向的类更清楚。
            */
            if (row.singleRow) {
                wrap.className += ' detail-field-inline';
            }

            var l = document.createElement('div');
            l.className = 'detail-field-label';
            l.textContent = row.label;

            /*
              ⚠️ 值用 div + .detail-readonly-value（而不是 .detail-input）——
                 它需要「换行显示」（用户要求），而 .detail-input 是
                 单行输入框形态。
                 换行由 CSS 的 word-break 处理，见 styles.css。

              ⚠️ row.singleRow 的项额外挂 .detail-readonly-inline，
                 去掉 min-height 与上下 padding（单行不需要为
                 "输入框那一行"预留高度）。
            */
            var v = document.createElement('div');
            v.className = 'detail-readonly-value'
                + (row.singleRow ? ' detail-readonly-inline' : '');
            v.textContent = row.value;

            wrap.appendChild(l);
            wrap.appendChild(v);
            fieldsEl.appendChild(wrap);
        });
    }

    /* ---------------------------------------------------------------------
       保存
       --------------------------------------------------------------------- */

    /**
     * 收集要提交的 patch。
     *
     * ⚠️ 把**所有**当前字段都放进去（含空串），不是只放改过的。
     *    理由见文件头：空串是「清空」的唯一表达方式。
     *
     * ⚠️ 只收集**当前类别下显示中的字段** + 顶层字段。
     *    切换类别后残留的旧字段（比如从期刊改成专著，fields 里还留着
     *    volume）**不进 patch** —— 它们既没显示也没被用户确认过，
     *    静默保留在库里比较安全（用户改回期刊时还能拿回来）。
     */
    function collectPatch() {
        var patch = {
            title: draft.title,
            author: draft.author,
            /*
              ⚠️ 日期取 draft 里的值，**不再需要归一化** ——
                 三个分段框每次输入都经 syncDateToDraft() 直接拼好
                 写进 draft（粒度天然由「填了几格」决定）。
                 早先用 <input type="date"> 时得把「补全的 01-01」
                 还原成原始粒度，那套 normalizeDate() 已随之删除。
            */
            year: draft.year,
            /*
              ⚠️ **短标题**要显式带上 —— 它不在 fieldsFor() 的结果里
                 （见 meta.js：SHORT_NAME_FIELD 是独立的一项，
                 因为它在界面上是行内形态而非整行形态）。

                 ⚠️ 这一行还不够 —— 光把它放进 patch，Kotlin 侧
                    若不把 `shortTitle` 列进 TOP_LEVEL_KEYS，
                    它会被当普通类别字段写进 `fields`，读回来时
                    又只读顶层，于是保存后消失。
                    四处必须一致（见 meta.js SHORT_NAME_FIELD 的注释）。
            */
            shortTitle: draft.shortTitle,
            venueType: draft.venueType
        };

        var fields = global.ScholariusMeta
            ? global.ScholariusMeta.fieldsFor(draft.venueType)
            : [];

        fields.forEach(function (field) {
            // 顶层字段已经单独放了，不要重复进 fields
            // （year 也在其中 —— 它虽是日期控件，但存的是顶层 year 键）
            if (isTopLevel(field.key)) {
                return;
            }

            /*
              ⚠️ DOI 是**一个字段两个控件**，`inputs[field.key]` 故意没登记
                 （见 buildDoiField 的注释），所以不能走下面那条
                 「读 inputs[key].value」的通用分支 —— 它会拿到空串，
                 表现为「填了 DOI 但保存后没了」。

                 DOI 的完整串在输入时就已由 writeDoiToDraft() 写进 draft，
                 这里直接取 draft 的值即是最新的。
            */
            if (field.kind === 'doi') {
                patch[field.key] = String(draft.fields && draft.fields[field.key] || '');
                return;
            }

            var el = inputs[field.key];
            patch[field.key] = el ? String(el.value || '') : '';
        });

        return patch;
    }

    function save() {
        if (!draft || !currentDoc) return;

        var bridge = global.ScholariusNative;
        if (!bridge || typeof bridge.updateDoc !== 'function') {
            global.ScholariusUI.toast(t('detail.saveFailed'));
            return;
        }

        var patch = collectPatch();
        trace('detail:save', JSON.stringify(patch).slice(0, 200));

        /*
          ⚠️ 这里**不**立即关闭、也不立即提示「已保存」。
             保存要写索引文件，可能失败。等原生回报（ScholariusShell.docUpdated）。
             前端自己宣布成功会撒谎：列表显示新标题、重启后变回旧的。
        */
        saveBtn.disabled = true;
        bridge.updateDoc(currentDoc.id, JSON.stringify(patch));
    }

    /**
     * 取消：丢弃改动并关闭。
     *
     * ⚠️ 不需要做额外的事 —— draft 是与 currentDoc 分离的副本
     *    （见 open() 里的深拷贝），所以直接关掉就等于放弃修改。
     *    这正是当初要深拷贝的原因：否则「取消」得逐个字段回滚。
     */
    function cancel() {
        trace('detail:cancel', currentDoc ? currentDoc.id : '');
        close();
    }

    /**
     * 原生回报保存结果。
     *
     * ⚠️ 必须核对 id —— 用户可能在保存途中就关了详情页去点别的文献，
     *    这时回报的是上一篇的结果，不能把当前这篇标成「已保存」。
     */
    function onDocUpdated(id, ok) {
        if (saveBtn) saveBtn.disabled = false;

        if (!currentDoc || currentDoc.id !== id) {
            // 已经切走了：只提示，不动界面
            if (ok && global.ScholariusUI) {
                global.ScholariusUI.toast(t('meta.saved'));
            }
            return;
        }

        if (!ok) {
            global.ScholariusUI.toast(t('detail.saveFailed'));
            return;
        }

        // 保存成功：把工作副本写回 currentDoc，避免关闭后对象还是旧值
        currentDoc.title = draft.title;
        currentDoc.author = draft.author;
        currentDoc.year = draft.year;
        currentDoc.shortTitle = draft.shortTitle;
        currentDoc.venueType = draft.venueType;
        currentDoc.fields = draft.fields;

        global.ScholariusUI.toast(t('meta.saved'));
        close();
    }

    /* ---------------------------------------------------------------------
       初始化
       --------------------------------------------------------------------- */

    function trace(stage, detail) {
        if (global.trace) global.trace(stage, detail);
    }

    function init() {
        root = document.getElementById('detail-page');
        if (!root) return;

        typeRowEl = document.getElementById('detail-type-row');
        typeValueEl = document.getElementById('detail-type-value');
        typeValueIconEl = document.getElementById('detail-type-value-icon');
        fieldsEl = document.getElementById('detail-fields');
        shortNameInput = document.getElementById('detail-input-shortName');
        saveBtn = document.getElementById('detail-save');
        cancelBtnEl = document.getElementById('detail-cancel');

        /*
          ⚠️ 短标题在 HTML 里是静态元素，绑定只需做一次。
             writeValue 会按 meta.js 的 TOP_LEVEL_KEYS 判断出
             shortTitle 属于顶层，所以直接调它即可，不用在这里特判。
        */
        if (shortNameInput) {
            shortNameInput.addEventListener('input', function () {
                writeValue('shortTitle', shortNameInput.value);
            });
        }

        // ⚠️ 类别行的事件只在 init 绑一次（见 mountTypeRow 的注释）
        mountTypeRow();

        var closeBtn = document.getElementById('detail-close');
        var backdrop = document.getElementById('detail-backdrop');

        if (closeBtn) closeBtn.addEventListener('click', cancel);
        if (backdrop) backdrop.addEventListener('click', cancel);
        /*
          ⚠️ 右上角的关闭按钮、点背景、底部的「取消」**三者语义相同**
             （都是「不保存、退出」），所以全部走 cancel()。
             不要给其中某一个写单独的逻辑 ——
             将来若要加「有未保存改动时先确认」，改 cancel() 一处即可。
        */
        if (cancelBtnEl) cancelBtnEl.addEventListener('click', cancel);
        if (saveBtn) saveBtn.addEventListener('click', save);

        // 语言切换后要重画（类别名/字段标签/只读行名都是 JS 填的）
        if (global.ScholariusI18n && global.ScholariusI18n.onChange) {
            global.ScholariusI18n.onChange(function () {
                if (isOpenFlag) {
                    /*
                      ⚠️ picker.refresh() 会按 getOptions() 重算当前值 ——
                         语言变了选项文字也变了，必须让它重算，
                         否则右侧还停在上一种语言。
                    */
                    syncTypeRow();
                    renderFields();
                    /*
                      ⚠️ syncShortName() **必须也调**（踩过的坑）。

                         它不只写值，还负责写「短标题」输入框的占位提示
                         （placeholder 是 JS 按当前语言填的，见上面
                         syncShortName 里的注释）。

                         ⚠️ 漏掉它的表现：切到中文后，
                            · 标签「短标题」变了 —— 那是 i18n 扫描
                              data-i18n 属性自动更新的；
                            · 占位提示却还停在英文 ——
                              因为它是 JS 塞的，不在扫描范围内。
                            同一行里中英混排，实测就是这个结果。

                         ⚠️ 为什么以前没暴露：早先中英的
                            vault.hint.shortName 是同一个英文串
                            （"e.g. NIPS"），不切换也看不出来。
                            中文侧改成有意义的文案后才显形 ——
                            所以「占位提示必须随语言刷新」这条约束
                            是独立于文案内容的。
                    */
                    syncShortName();
                }
            });
        }
    }

    global.ScholariusDetail = {
        init: init,
        open: open,
        close: close,
        isOpen: isOpen,
        onDocUpdated: onDocUpdated
    };
})(window);
