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
              ══ 日期：YYYY-MM-DD 逐位输入 ══

              ⚠️ 交互是「单个输入框 + 视觉覆盖层」，不是 8 个真输入框。

                 外表仍是一行「8 个圆角小格 + 两个 '-' 分隔符」
                 （用户要求：八个数字框占满一行、每格一位）——
                 但那 8 个格子是**纯展示的 span**，
                 真正接收输入的是**一个铺满整行的透明 <input>**。

              ══ 为什么要这样改（v0.1.6 的真机 bug）══

                 原方案是 8 个真的单字输入框，靠每格的 `keydown`
                 自己写值、自己决定「写哪一格」。真机上表现为
                 **输入卡在第二个框**：后续任何数字都只改第二格。

                 根因（已实测复现）：Android 的软键盘（尤其输入法、
                 数字键盘）输入数字时**不派发带字符的 keydown** ——
                 事件是 `keydown`(key=Unidentified/229) + `input`(IME 上屏)。
                 而所有逻辑（覆盖位判定、找下一个空格、移动焦点）
                 全写在 keydown 分支里 → **在真机上这段代码从不执行**。
                 于是字符被浏览器默认插进当前聚焦的那一格，
                 input 分支只看到 length===1、只调用同步函数，
                 **不推进**。第二格因此越攒越长（"20"、"203"…），
                 整行再也不会前进。

                 桌面浏览器 keydown 正常，所以以前在 PC 上测不出来。

              ══ 为什么「单输入框」是正解 ══

                 多格方案的脆弱之处在于：**格子的推进必须在
                 keydown 里做**，因为键盘事件才带「要写哪一格」的意图。
                 而真实键盘的事件模型不保证 keydown 给字符。

                 单输入框方案把「哪一格」交给**值本身的位置**决定：
                 "2015" 的第 0 位显示在第 0 格，第 1 位显示在第 1 格 ——
                 不需要任何事件做推进，光标位置天然就是索引。
                 于是 keydown / input / beforeinput / 粘贴 / 输入法
                 / 语音输入**全部自动正确**，因为都是同一条路径：
                 浏览器往 value 里插字符 → 我们剥出数字 → 重画覆盖层。

              ══ 与旧方案的兼容 ══

                 存储格式完全不变（仍是 "2015" / "2015-06" / "2015-06-24"），
                 输入形式也没变（看起来还是 8 个格子），
                 用户无感知，老数据无需迁移。
            */
            wrap.appendChild(buildDateField(field, value));
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
     *    `<key>-suffix`），与 DOI 的另一套约定一致。
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
     * 逐位提示文字，**只含数字位**，不含分隔符。
     *
     * ⚠️ 长度必须等于 DATE_SLOTS（8），且**不能**写成 "YYYY-MM-DD"。
     *
     *    踩过的坑：曾把提示串写成 "YYYY-MM-DD"（长度 10），
     *    然后按 `charAt(i)` 逐格取 —— 于是第 4 格（下标 4）
     *    取到的是 "-" 而不是月份的第一个 M，8 个格子显示成
     *    `Y Y Y Y - M M -`，最后两个日的位置还取不到字符（空）。
     *
     *    根因：提示串里有没有分隔符，与**格子有没有分隔符**是两件事。
     *    分隔符是 DOM 里的 span，不占格子；提示串只服务格子。
     *    两者混在一起数位就会错。
     *
     *    显示效果（- 是 DOM 的 span）：
     *      [Y][Y][Y][Y] - [M][M] - [D][D]
     */
    var DATE_HINT = 'YYYYMMDD';

    /**
     * 存储值 → 纯数字串。
     *
     * ⚠️ 先**剥成纯数字串**，不把 "2015-06-24" 切三段。
     *
     *    理由：8 格方案里每格只放一个字符，
     *    而分隔符（"-"）由我们自己按位插入 ——
     *    若按「年段/月段/日段」处理，分隔符的位置就无处安放。
     *    剥成 "20150624" 后逐位对照，位置天然对齐。
     *
     * ⚠️ **不补零**，只按已有位数填。
     *    "2015" → 前 4 格有值、后 4 格空 —— 这样用户一眼看出
     *    自己只填到了年，而不是被自动补成 "2015-00-00"。
     *
     * @param {string} raw
     * @returns {string} 0-8 位的数字串
     */
    function parseDateDigits(raw) {
        var s = String(raw || '').trim();
        if (!s) return '';
        return s.replace(/\D/g, '').slice(0, DATE_SLOTS);
    }

    /**
     * 纯数字串 → 存储值。
     *
     * ⚠️ 按**用户填到的最高位**决定粒度，不补零：
     *      4 位 → "2015"
     *      6 位 → "2015-06"
     *      8 位 → "2015-06-24"
     *
     * ⚠️ 不足 4 位（年不完整）**返回空串** —— "201" 不是年份。
     *    空串的语义是「清空该字段」，比存一个假年份安全。
     *    （判据同 PDF 元数据：宁可留空，不可存错值。）
     *
     * ⚠️ 只保留偶数位的月/日（4→年、6→年月、8→年月日）。
     *    5 位（"20150"）这种半截状态按「只到年」处理，
     *    因为它连月份的第一位都还没凑齐。
     *
     * @param {string} digits 纯数字串
     * @returns {string} 存储用的日期字符串
     */
    function formatDateValue(digits) {
        var d = String(digits || '').replace(/\D/g, '').slice(0, DATE_SLOTS);
        if (d.length < 4) return '';
        var out = d.slice(0, 4);
        if (d.length >= 6) out += '-' + d.slice(4, 6);
        if (d.length >= 8) out += '-' + d.slice(6, 8);
        return out;
    }

    /**
     * 造日期行：**一个铺满整行的透明 input + 8 个纯展示的格子**。
     *
     * ══ 结构 ══
     *
     *   .detail-date                      （position: relative 的容器）
     *     ├─ .detail-date-input           （透明 input，绝对定位铺满，真正接收输入）
     *     └─ .detail-date-cells           （pointer-events: none 的展示层）
     *          ├─ .detail-date-seg × 4     （年，每格显示一位或占位字母）
     *          ├─ .detail-date-sep         （"-"）
     *          ├─ .detail-date-seg × 2     （月）
     *          ├─ .detail-date-sep         （"-"）
     *          └─ .detail-date-seg × 2     （日）
     *
     * ══ 为什么是「一个 input」而不是「8 个 input」══
     *
     * 见 buildField 里 date 分支的长注释。一句话：
     * 真机上软键盘不派发带字符的 keydown，而 8 格方案的
     * 「推进到下一格」逻辑必须挂在 keydown 上 → 整行卡死。
     * 单 input 方案里「哪一格」由**值的位置**决定，不依赖事件类型。
     *
     * ⚠️ 展示层必须 `pointer-events: none`，否则点在格子上
     *    不会把焦点交给下面的 input（点哪儿都没反应）。
     *    这与「覆盖层不能挡住点击」是同一个教训（elementFromPoint）。
     *
     * @param {Object} field meta.js 里的字段定义
     * @param {string} value 当前存储值（如 "2015-06-24"）
     * @returns {HTMLElement} 完整的 .detail-date 容器
     */
    function buildDateField(field, value) {
        var group = document.createElement('div');
        group.className = 'detail-date';

        /*
          ⚠️ 真正的输入控件。

             `type="text"` + `inputMode="numeric"`：手机弹数字键盘，
             但仍允许退格、粘贴、输入法 —— 不用 type="number"
             （它会在部分 WebView 里显示调节箭头，且非法值时
             `.value` 返回空串，表现为"打一个字母整格清空"）。

             ⚠️ 设 maxLength = 8 —— 超过就插不进来，
                省得我们自己再截断（截断会造成光标跳动）。
                粘贴 "2015-06-24" 共 10 字符会被截到 8，
                但我们在 input 里先剥非数字，所以粘贴的连字符
                不占额度：剥完是 8 位数字，正好。
                实测：先剥后截的顺序必须如此 ——
                若先按原始长度截断会把结尾的 "24" 切掉。
        */
        var input = document.createElement('input');
        input.className = 'detail-date-input';
        input.id = 'detail-input-' + field.key;
        input.type = 'text';
        input.inputMode = 'numeric';
        input.autocomplete = 'off';
        input.autocapitalize = 'off';
        input.spellcheck = false;
        /*
          ⚠️ 可见的占位提示不能靠 input 自己（它是透明的，
             caret 之外什么都看不见），由下面的格子显示
             "YYYY-MM-DD"。但这里仍给个 aria-label 供读屏使用。
        */
        input.setAttribute('aria-label', t('vault.field.date'));
        input.value = parseDateDigits(value);

        /* 展示层：8 个格子 + 2 个分隔符，纯展示 */
        var cells = document.createElement('div');
        cells.className = 'detail-date-cells';
        // ⚠️ 挡住点击就等于整行点不动（用户会以为控件坏了）
        cells.setAttribute('aria-hidden', 'true');

        var segEls = [];
        for (var i = 0; i < DATE_SLOTS; i++) {
            // 4 位（年后）与 6 位（月后）之前插 "-"
            if (i === 4 || i === 6) {
                var sep = document.createElement('span');
                sep.className = 'detail-date-sep';
                sep.textContent = '-';
                cells.appendChild(sep);
            }
            var seg = document.createElement('span');
            seg.className = 'detail-date-seg';
            cells.appendChild(seg);
            segEls.push(seg);
        }

        /**
         * 把 input 的当前值画到 8 个格子上。
         *
         * ⚠️ 每格显示「该位的数字」或「DATE_HINT 里对应的字母」——
         *    用户要求「提示填充文字也得是 YYYY-MM-DD」。
         *    于是空格子依次显示 Y Y Y Y - M M - D D。
         *
         * ⚠️ 不要给整串 "YYYY-MM-DD"（每格都显示全部反而看不懂），
         *    所以按位取字符。
         *
         * ⚠️ 用 `is-filled` 类而不是 `:placeholder-shown` 来决定
         *    边框深浅 —— 已经没有 placeholder 了（span 没有这个概念）。
         */
        function paint() {
            var d = input.value.replace(/\D/g, '');
            for (var k = 0; k < DATE_SLOTS; k++) {
                var ch = d.charAt(k);
                segEls[k].textContent = ch || DATE_HINT.charAt(k);
                if (ch) {
                    segEls[k].classList.add('is-filled');
                } else {
                    segEls[k].classList.remove('is-filled');
                }
            }
            /*
              ⚠️ 高亮「下一个字符会落到哪一格」= 当前已填位数那一格。

                 为什么需要它（v0.1.7 用户反馈「第二位框前面冒出输入符号」）：
                 透明 input 的 caret 位置由**它自己的排版**决定
                 （7.5px/字，从最左连续排），而展示层的格子是
                 「48px 宽 + 8px 间隔 + 两个 '-' 分隔符」——
                 两套位置对不上，caret 会飘到格子之间或边框上。

                 修法是**把 caret 藏掉**（见 styles.css 的
                 .detail-date-input），焦点位置改由这里表达：
                 高亮下一个待填格。既没有位置不准的竖线，
                 又能让用户知道「现在填到第几位」。

                 ⚠️ 已填满 8 位时没有"下一个待填格"，此时高亮**最后一格**
                    （用户继续打字会覆盖末位，高亮那里语义一致）。
            */
            var cursorAt = Math.min(d.length, DATE_SLOTS - 1);
            for (var m = 0; m < DATE_SLOTS; m++) {
                if (m === cursorAt) {
                    segEls[m].classList.add('is-cursor');
                } else {
                    segEls[m].classList.remove('is-cursor');
                }
            }
        }

        /*
          ⚠️ 输入处理：**唯一**的入口。

             不需要 keydown / paste / beforeinput 分开处理 ——
             浏览器负责插入（含粘贴、输入法上屏），
             我们只做两件事：
               ① 剥掉非数字、截到 8 位（规范值）
               ② 重画格子

             ⚠️ 这就是修复的核心：**不再有「往哪一格写」的逻辑**。
                哪一格由字符在值里的下标决定，任何输入方式都一样。

             ⚠️ 只在值真的变了时才回写 input.value ——
                无条件回写会重置光标到末尾，用户想在中间插入
                一位时就会"跳到末尾"。
        */
        input.addEventListener('input', function () {
            var cleaned = input.value.replace(/\D/g, '').slice(0, DATE_SLOTS);
            if (cleaned !== input.value) {
                /*
                  ⚠️ 保留光标：把光标放在「它前面有多少个数字」
                     对应的位置上。剥掉非数字后长度会变短，
                     直接用原 selectionStart 会越界飘走。
                */
                var pos = input.selectionStart || 0;
                var before = input.value.slice(0, pos).replace(/\D/g, '').length;
                input.value = cleaned;
                try {
                    input.setSelectionRange(before, before);
                } catch (e) {
                    // 某些老 WebView 在非聚焦状态下会抛 —— 忽略即可
                }
            }
            writeValue(field.key, formatDateValue(input.value));
            paint();
        });

        /*
          ⚠️ 点击 / 聚焦时把光标放到**末尾**（已有的值之后）。

             理由：日期是「从左往右逐位填」的，用户点进来
             几乎总是要继续往后填。若光标停在中间，
             新输入会插在中间，与"续填"的预期不符。

             ⚠️ 只在**空格子**（cursor 已在末尾）时无所谓；
                已有值时 `setSelectionRange(len, len)` 保证续填。
        */
        input.addEventListener('focus', function () {
            var len = input.value.length;
            /*
              ⚠️ 用 requestAnimationFrame 推迟一帧：
                 点击时浏览器会在 mouseup 后重置选区，
                 同步设置会被这次重置覆盖掉（老 WebView 实测）。
            */
            var place = function () {
                try {
                    input.setSelectionRange(len, len);
                } catch (e) { /* 同上，忽略 */ }
            };
            place();
            if (typeof global.requestAnimationFrame === 'function') {
                global.requestAnimationFrame(function () {
                    if (document.activeElement === input) place();
                });
            }
            /*
              ⚠️ 聚焦时才显示「下一格」高亮（paint 里加 is-cursor）。
                失焦后不该还留着一格高亮，否则看起来像始终处于编辑态。
            */
            group.classList.add('is-focused');
        });

        /*
          ⚠️ 失焦：撤掉 is-focused 与格高亮。

             为什么高亮开关要两处都做（这里 + paint）：
             paint() 每次都重算 is-cursor，但它不知道焦点状态 ——
             它只管"下一个待填格"。所以用 group 上的 is-focused
             作为**门**，由 CSS 决定焦点之外不显示高亮。
             这样即使失焦时又触发了一次 paint，视觉也不会漏。
        */
        input.addEventListener('blur', function () {
            group.classList.remove('is-focused');
        });

        group.appendChild(input);
        group.appendChild(cells);
        paint();

        /*
          ⚠️ 登记 input 供 collectPatch 读取。
             collectPatch 走的是通用分支（`inputs[key].value`），
             所以这里给的 **必须已经是存储格式**的字符串 ——
             而 input.value 是纯数字串（"20150624"）。
             故 collector 里对 date 有特判（见 collectPatch）。
             为保持一致，这里把规范化后的值同步进 draft 即可，
             collectPatch 的 date 分支直接读 draft。
        */
        inputs[field.key] = input;
        writeValue(field.key, formatDateValue(input.value));

        return group;
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
                 每次 input 都由 formatDateValue() 规范好写进 draft
                 （粒度天然由「填了几位」决定）。
                 早先用 <input type="date"> 时得把「补全的 01-01」
                 还原成原始粒度，那套 normalizeDate() 已随之删除。

                 ⚠️ 也不能走下面「读 inputs[key].value」的通用分支 ——
                    日期 input 里存的是**纯数字串**（"20150624"），
                    而存储格式是 "2015-06-24"。
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

            /*
              ⚠️ 日期同样要**走 draft 特判**。

                 它的 <input> 里存的是**纯数字串**（"20150624"），
                 而存储格式是 "2015-06-24" —— 两者不同。
                 通用分支会直接把数字串存进去，表现为
                 「保存后日期变成 20150624」。所以这里读 draft
                 （每次 input 都由 formatDateValue 规范化后写入）。
            */
            if (field.kind === 'date') {
                patch[field.key] = String(draft[field.key] || '');
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
