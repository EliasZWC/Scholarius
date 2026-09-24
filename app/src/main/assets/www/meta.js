/*
  Scholarius — 文献元数据的「可编辑字段」定义。

  ══ 为什么单独一个文件 ══

  这个功能有三处必须**严格一致**，否则会各处对不上：
    ① 弹窗表单要按类别渲染不同字段
    ② 卡片要按类别显示图标 + 从字段里取值
    ③ 原生侧 Doc / 索引 JSON 要能存这些字段

  把字段表集中在这里，三处都从它派生 —— 加字段只改一个地方。

  ══ 设计依据（用户 2026-09-24）══

  「全做，因为可以留空，但如果用户想，就应该能加入这些信息」
  「发表物类别应该是第一个选项，确定了发表物类别后，
    就可以根据发表物类别填写表单了 —— zotero 不就是这个逻辑嘛」

  ══ 关键约束：所有字段都可为空 ══

  ⚠️ **没有必填项**。用户导入的 PDF 抓不到某个值时，那一项就空着；
     他愿意填就填，不愿意就留空 —— 不要用红框/禁用保存来逼迫。

  ⚠️ 因此「保存」按钮在**任何状态下都可点**，哪怕是全空。
     唯一例外：`venueType` 决定表单显示哪些字段，
     它自己有默认值 `unknown`（= 只显示通用字段）。
*/
(function (global) {
    'use strict';

    /**
     * 发表物类别。**顺序即表单里的显示顺序**。
     *
     * `unknown` 放最后：它是「还没判定的初始态」，不是一类载体。
     *
     * ⚠️ `value` 是存进 JSON 的稳定标识，**不要改**（改了老数据读不出来）。
     *    显示文字走 i18n（`venue.type.<value>`）。
     */
    var VENUE_TYPES = [
        { value: 'journal', icon: 'venueJournal' },
        { value: 'conference', icon: 'venueConference' },
        { value: 'preprint', icon: 'venuePreprint' },
        { value: 'book', icon: 'venueBook' },
        { value: 'thesis', icon: 'venueThesis' },
        { value: 'report', icon: 'venueReport' },
        { value: 'unknown', icon: '' }
    ];

    /**
     * 通用字段 —— **每个类别都有**。
     *
     * ⚠️ 这里的 `key` 必须与 Kotlin 侧 Doc 的 JSON 键逐字相同。
     *    大小写敏感。
     */
    var COMMON_FIELDS = [
        {
            key: 'title',
            label: 'vault.field.title',
            // 标题是唯一的「清空后会被兜底填回文件名」的字段（见 LibraryStore.update）
            kind: 'text',
            maxLength: 300
        },
        {
            key: 'author',
            label: 'vault.field.author',
            kind: 'text',
            maxLength: 300,
            placeholder: 'vault.hint.author'
        },
        {
            /*
              ⚠️ key 仍然是 `year`，**不能改成 date**。

                 它是存进索引 JSON 的稳定标识，也是原生 Doc 的字段名
                 （见 LibraryStore.Doc.year / PdfMeta.extractYear）。
                 改名意味着老数据的年份读不出来，要写迁移 ——
                 而我们只是把**显示名**和**输入形式**放宽，存储没变。

              ⚠️ kind = 'date'：渲染成 **8 个单字输入框占满一行**
                 （YYYYMMDD 逐位，用户要求）。

                 ⚠️ 不用 <input type="date">：
                   · 它只接受完整日期，塞 "2015" 会被静默清空；
                   · 显示格式由系统 locale 决定（中文环境显示「年/月/日」
                     而不是我们要的 YYYY-MM-DD）；
                   · 必须带原生日历弹窗，与逐位手输不是一回事。

                 8 格各自可空，所以「只填年」「年+月」「完整日期」
                 「全不填」天然都支持 —— 粒度由「填到第几格」决定
                 （见 detail.js 的 syncDateToDraft）。
            */
            key: 'year',
            label: 'vault.field.date',
            kind: 'date'
        }
    ];

    /**
     * 各类别的**专属字段**。
     *
     * ⚠️ 顺序 = 表单里的显示顺序。越重要的越靠前。
     *
     * ⚠️ `kind` 决定输入控件与校验：
     *      text   —— 普通单行文本
     *      date   —— 逐位日期（年/月/日，8 格）
     *      number —— 纯数字（卷/期/页码起止）
     *      select —— 下拉选项（学位类型）
     *      doi    —— DOI 专用（10. + 注册机构号 / 后缀）
     *
     * ⚠️ 每个字段都标注了「能否从 PDF 抓到」——
     *    抓不到不代表不做，只代表用户要手填。
     */
    var TYPE_FIELDS = {
        // 期刊：卷期页码是标准的三件套
        journal: [
            {
                key: 'journalName', label: 'vault.field.journalName',
                kind: 'text', maxLength: 120,
                placeholder: 'vault.hint.venueName',
                // PDF 能抓到（Subject / 引用段）
                hints: { fromPdf: true }
            },
            {
                key: 'volume', label: 'vault.field.volume',
                kind: 'text', maxLength: 20,
                placeholder: 'vault.hint.volume',
                hints: { fromPdf: true }   // 引用段 "521 (7553)"
            },
            {
                key: 'issue', label: 'vault.field.issue',
                kind: 'text', maxLength: 20,
                placeholder: 'vault.hint.issue',
                hints: { fromPdf: true }
            },
            /*
              ⚠️ 页码拆成**两个字段**（用户 2026-09-24 要求）。

                 原来是一个 `pages` 文本框，用户要求「划分为两个框，
                 一个是开始页码，一个是终止页码」。

              ⚠️ 存储键是 `pageStart` / `pageEnd`，**不再是 `pages`**。
                · 老数据里的 `pages`（形如 "436-444"）由
                  LibraryStore 在读取时拆分兜底（见 Kotlin 侧）；
                · 之所以直接换键而不是保留 `pages` 再解析：
                  文本框本来就是自由格式（"436-444"、"436–444"、
                  "436 ff." 都合法），靠正则拆永远有漏网的；
                  两个数字框从**输入层面**就消灭了歧义。

              ⚠️ 两个字段都是纯数字，但**不做强校验**：
                 用户可能只知道起始页（"436 ff."）——填一半也算数。
            */
            {
                key: 'pageStart', label: 'vault.field.pageStart',
                kind: 'number', maxLength: 12, placeholder: 'vault.hint.pageStart',
                hints: { fromPdf: true }
            },
            {
                key: 'pageEnd', label: 'vault.field.pageEnd',
                kind: 'number', maxLength: 12, placeholder: 'vault.hint.pageEnd',
                hints: { fromPdf: true }
            },
            {
                key: 'doi', label: 'vault.field.doi',
                /*
                  ⚠️ kind = 'doi'：DOI 有固定语法，用**结构化的两个框**
                     （前缀 / 后缀）而不是一个自由文本框。

                     DOI 的正式语法（ISO 26324 / doi.org）：
                       10.<registrant>/<suffix>
                     —— 前缀一定以 "10." 开头，后跟 4~9 位注册机构号，
                        然后一个 "/"，后面是发行方自定义的后缀。

                     ⚠️ 不做「10.」+ 前缀 + 「/」+ 后缀 **四段**：
                        太碎，而且 "10." 是常量，让用户打是浪费。
                        前缀里再分段（"10.1038" 拆成 1038）没必要。

                     ⚠️ 存储值仍是完整 DOI 字符串（"10.1038/nature14539"）：
                        Kotlin 侧 Doc 的键与值不变，也不需要迁移。
                        前缀 / 后缀只是**输入形式**，保存前拼回完整串。
                */
                kind: 'doi',
                maxLength: 120,
                hints: { fromPdf: true }   // ⟨10.1038/nature14539⟩
            }
        ],

        // 会议：缩写最重要（卡片上要显示），地点是 Zotero 也有的字段
        conference: [
            {
                key: 'conferenceName', label: 'vault.field.conferenceName',
                kind: 'text', maxLength: 160,
                placeholder: 'vault.hint.conferenceName',
                hints: { fromPdf: true }
            },
            {
                key: 'conferenceShort', label: 'vault.field.conferenceShort',
                kind: 'text', maxLength: 40,
                placeholder: 'vault.hint.abbrev',
                // ⚠️ 缩写抓不到 —— PDF 里没有「这个会议的缩写是什么」这种信息。
                //    用户可以在「设置 → 发表物简称」里建映射表自动填（后续版本）。
                hints: { fromPdf: false }
            },
            {
                key: 'conferencePlace', label: 'vault.field.conferencePlace',
                kind: 'text', maxLength: 80,
                placeholder: 'vault.hint.place',
                hints: { fromPdf: false }
            },
            {
                key: 'pageStart', label: 'vault.field.pageStart',
                kind: 'number', maxLength: 12, placeholder: 'vault.hint.pageStart',
                hints: { fromPdf: true }
            },
            {
                key: 'pageEnd', label: 'vault.field.pageEnd',
                kind: 'number', maxLength: 12, placeholder: 'vault.hint.pageEnd',
                hints: { fromPdf: true }
            },
            {
                key: 'doi', label: 'vault.field.doi',
                kind: 'doi',
                maxLength: 120,
                hints: { fromPdf: true }
            }
        ],

        // 预印本：平台 + 编号（arXiv ID 是预印本的唯一标识）
        preprint: [
            {
                key: 'preprintServer', label: 'vault.field.preprintServer',
                kind: 'text', maxLength: 60,
                placeholder: 'vault.hint.server',
                hints: { fromPdf: true }   // "arXiv"
            },
            {
                key: 'preprintId', label: 'vault.field.preprintId',
                kind: 'text', maxLength: 60, placeholder: 'vault.hint.preprintId',
                hints: { fromPdf: true }   // "arXiv:1508.01234"
            },
            {
                key: 'doi', label: 'vault.field.doi',
                kind: 'doi',
                maxLength: 120,
                hints: { fromPdf: true }
            }
        ],

        // 专著：出版社 + ISBN
        book: [
            {
                key: 'publisher', label: 'vault.field.publisher',
                kind: 'text', maxLength: 120,
                placeholder: 'vault.hint.publisher',
                hints: { fromPdf: true }
            },
            {
                key: 'isbn', label: 'vault.field.isbn',
                kind: 'text', maxLength: 30,
                placeholder: 'vault.hint.isbn',
                hints: { fromPdf: false }
            },
            {
                key: 'edition', label: 'vault.field.edition',
                kind: 'text', maxLength: 40,
                placeholder: 'vault.hint.edition',
                hints: { fromPdf: false }
            }
        ],

        // 学位论文：学校 + 学位类型
        thesis: [
            {
                key: 'institution', label: 'vault.field.institution',
                kind: 'text', maxLength: 160,
                placeholder: 'vault.hint.institution',
                hints: { fromPdf: true }
            },
            {
                key: 'thesisType', label: 'vault.field.thesisType',
                kind: 'select', maxLength: 40,
                // ⚠️ 用固定选项而不是自由文本：学位类型就那么几种，
                //    自由填写会变成「PhD」「Ph.D.」「博士」三种写法并存。
                options: ['phd', 'master', 'bachelor', 'other'],
                hints: { fromPdf: false }
            }
        ],

        // 报告：机构 + 编号
        report: [
            {
                key: 'institution', label: 'vault.field.institution',
                kind: 'text', maxLength: 160,
                placeholder: 'vault.hint.institution',
                hints: { fromPdf: true }
            },
            {
                key: 'reportNumber', label: 'vault.field.reportNumber',
                kind: 'text', maxLength: 60,
                placeholder: 'vault.hint.reportNumber',
                hints: { fromPdf: false }
            }
        ],

        // 未判定：只有通用字段
        unknown: []
    };

    /**
     * 取某类别要显示的完整字段表（通用 + 专属）。
     *
     * @param {string} type venueType 值
     * @returns {Array} 字段定义数组
     */
    function fieldsFor(type) {
        var extra = TYPE_FIELDS[type] || TYPE_FIELDS.unknown;
        return COMMON_FIELDS.concat(extra);
    }

    /**
     * 类别 → 卡片上显示的「载体名」用哪个字段。
     *
     * ⚠️ 这就是「发表物」这一栏在多类别下的取值规则。
     *    用户之前指定的卡片形态是：左边类别图标 + 右边载体名。
     *    现在载体名的来源按类别不同：
     *
     *      期刊   → journalName   （"Nature"）
     *      会议   → conferenceShort || conferenceName   （"NIPS" / 全名）
     *      预印本 → preprintServer （"arXiv"）
     *      专著   → publisher     （"人民邮电出版社"）
     *      学位论文 → institution （"University of Toronto"）
     *      报告   → institution   （"OpenAI"）
     *
     * ⚠️ 会议优先用缩写：卡片宽度有限，全名会被截断成
     *    "Neural Information Processing S…"，反而看不出是哪个会。
     *
     * ⚠️ 为什么不用「按类别固定一个字段」而是按优先级取值：
     *    实测 ResNet 的 PDF 里 `Subject` = "2016 IEEE Conference on
     *    Computer Vision and Pattern Recognition"，而
     *    `conferenceShort` 抓不到（PDF 里没有）。若只认缩写，
     *    这张卡片就没有载体名了 —— 全名总比空着好。
     */
    var VENUE_NAME_FIELDS = {
        journal: ['journalName'],
        conference: ['conferenceShort', 'conferenceName'],
        preprint: ['preprintServer'],
        book: ['publisher'],
        thesis: ['institution'],
        report: ['institution']
    };

    /**
     * **文章简称**（不是发表物简称！）。
     *
     * ⚠️⚠️ 这两个概念**必须分清**（用户 2026-09-24 专门指出）：
     *
     *   ┌─────────────────────┬──────────────────────────────┬──────────────────┐
     *   │                     │ 是什么                       │ 例子             │
     *   ├─────────────────────┼──────────────────────────────┼──────────────────┤
     *   │ 发表物简称 / Venue  │ **发表载体**本身的名字缩写   │ Neural Info...   │
     *   │ 简称                │                              │ Systems → NIPS   │
     *   ├─────────────────────┼──────────────────────────────┼──────────────────┤
     *   │ 文章简称 / Document │ **这一篇文献**自己的短名     │ “Attention is…”  │
     *   │ 简称（本字段）      │                              │  → “Attention”   │
     *   └─────────────────────┴──────────────────────────────┴──────────────────┘
     *
     *   · 发表物简称是**全局映射表**（shortcut.js / localStorage），
     *     一条配置服务**所有**发表在同一个会议/期刊的文献；
     *     它的用途是「卡片上省宽度」（见 meta.js 的 venueNameOf），
     *     作用在卡片的**③发表物那一行**。
     *
     *   · 短标题是**单篇文献的一个字段**（存在 doc.shortTitle），
     *     一篇一个值。⚠️ 它的用途是**顶替卡片①行的标题**
     *     （用户 2026-09-24：「short name 一旦确定，列表卡片的
     *     文章标题就用 short name 代替」）——
     *     不是用来当载体名的，与上面那个完全无关。
     *
     *   ⚠️ 所以**不能**把文章简称的提示写成 "e.g. NIPS" ——
     *      那是在用一个「发表物简称」的例子去解释「文章简称」，
     *      正好把两个概念搅在一起（犯过这个错）。
     *      文章简称的例子应该是一篇**文献的短名**，不是会议的缩写。
     *
     *   ⚠️ 所以**不能**把文章简称的提示写成 "e.g. NIPS" ——
     *      那是在用一个「发表物简称」的例子去解释「文章简称」，
     *      正好把两个概念搅在一起（犯过这个错）。
     *      文章简称的例子应该是一篇**文献的短名**，不是会议的缩写。
     *
     * ⚠️ 它**不属于** COMMON_FIELDS，是单独一项。
     *
     *    理由：它在详情页的**形态与其它字段不同** ——
     *    是「左标签 + 右输入框」贴在同一行（因为简称很短，
     *    不需要占满一整行），而 COMMON_FIELDS 里的字段都是
     *    「标签在上、输入框在下占满一行」。
     *
     *    若塞进 COMMON_FIELDS，fieldsFor() 会把它也生成成
     *    占满行的形态，然后 detail.js 还得再特判一次「这个要用
     *    另一种排法」—— 同一件事在两处描述，容易漂移。
     *
     * ⚠️ key 用 `shortTitle`，**已从 `venueShort` 改名**（用户 2026-09-24 拍板）。
     *
     *    旧名 `venueShort` 的毛病有两个，第二个是致命的：
     *      ① 读起来像「发表物简称」——而它存的是短标题，
     *         正是用户抱怨的混淆点；
     *      ② **它与 Kotlin 侧对不上**，导致真机上短标题永远存不住。
     *         `LibraryStore.TOP_LEVEL_KEYS` 里没有 `venueShort`，
     *         `Doc` 也没有这个字段，`writeIndex` 更不会写出它 ——
     *         于是保存时它被当普通类别字段塞进 `fields`，
     *         而 `parseDoc` 又只读顶层 `json.optString("venueShort")`，
     *         读不到。**表现为填了短标题、保存、重开就没了。**
     *         （浏览器预览看不出来 —— dev-library.js 的 TOP 白名单里
     *          把它当顶层了，所以只在真机上复现。）
     *
     *    ⚠️ 改名后**两边必须逐字一致**：
     *         meta.js 的 TOP_LEVEL_KEYS
     *         Kotlin 的 LibraryStore.TOP_LEVEL_KEYS
     *         Kotlin 的 Doc.shortTitle / parseDoc / writeIndex
     *         dev-library.js 的 TOP
     *       四处缺一不可。
     *
     *    ⚠️ 不做旧数据迁移：
     *       `venueShort` 从未真正落盘过（上述 bug 导致它总是进 fields，
     *       而那也读不回来），所以线上不存在带 `venueShort` 的数据。
     *       万一有脏数据残在 `fields.venueShort`，它只是读不到，无害。
     */
    var SHORT_NAME_FIELD = {
        key: 'shortTitle',
        label: 'vault.field.shortTitle',
        kind: 'text',
        maxLength: 40,
        placeholder: 'vault.hint.shortTitle'
    };

    /**
     * DOI 前缀里那个**恒定**的开头。
     *
     * ⚠️ 为什么不把 "10." 也做成一个输入框：
     *    它是 DOI 语法的常量（ISO 26324 / doi.org），
     *    让用户每次打一遍纯属浪费。所以把它固化成输入框的
     *    **无边框前缀文字**（见 detail.js buildDoiField），
     *    用户只需要填注册机构号 + 后缀。
     *
     * ⚠️ 显示上是不可编辑的装饰，但**它属于值的一部分** ——
     *    拼接时一定要带上，否则存进去的 DOI 就是错的。
     */
    var DOI_PREFIX = '10.';

    /**
     * 拆一个 DOI 串成「注册机构号 + 后缀」两段。
     *
     *     "10.1038/nature14539"  → { registrant: '1038', suffix: 'nature14539' }
     *     "10.1109/CVPR.2016.90" → { registrant: '1109', suffix: 'CVPR.2016.90' }
     *
     * ⚠️ 必须**容忍脏输入**。真实来源有三个：
     *      ① PDF 抓的正文里可能是 "https://doi.org/10.1038/nature14539"
     *         或 "<10.1038/nature14539>" 甚至 "doi:10.1038/nature14539"；
     *      ② 用户从浏览器复制的是完整 URL；
     *      ③ 老数据里 `pages` 那种自由文本风格的写入。
     *    所以先做一轮清洗：去掉 URL 头 / 尖括号 / "doi:" 前缀，
     *    再找最左的 "10."。
     *
     * ⚠️ 用**最左**的 "10."（`indexOf` 而不是正则全局匹配）：
     *    后缀里完全可能出现 "10."（如 ".../j.1467-8659.2012.10."），
     *    取最后一个会把前缀切错。
     *
     * ⚠️ 找不到 "10." 时，**整串当后缀**、registrant 留空 ——
     *    这样用户至少能看到自己填过的东西，不会"输入消失"。
     *    拼回去时若 registrant 为空，则不加 "10." 前缀
     *    （避免把 "arxiv:1234" 这类非 DOI 串污染成 "10.arxiv:1234"）。
     *
     * @param {string} raw 原始 DOI 串（可能含 URL / 尖括号 / 空格）
     * @returns {{registrant: string, suffix: string}}
     */
    function splitDoi(raw) {
        var out = { registrant: '', suffix: '' };
        var s = String(raw == null ? '' : raw).trim();
        if (!s) return out;

        // ① 去掉常见的外层包装
        s = s.replace(/^\s*<|>\s*$/g, '');
        s = s.replace(/^\s*(https?:\/\/)?(dx\.)?doi\.org\//i, '');
        s = s.replace(/^\s*doi\s*:\s*/i, '');
        // ② 圆括号包装（部分引用格式写作 "(10.1038/nature14539)"）
        s = s.replace(/^\((.*)\)$/, '$1');
        s = s.trim();
        if (!s) return out;

        var at = s.indexOf(DOI_PREFIX);
        if (at < 0) {
            // 不是标准 DOI —— 整串留作后缀，不假装有前缀
            out.suffix = s;
            return out;
        }

        var rest = s.slice(at + DOI_PREFIX.length);
        var slash = rest.indexOf('/');
        if (slash < 0) {
            // 有前缀没后缀（"10.1038"）—— 注册机构号先存着
            out.registrant = rest.trim();
            return out;
        }
        out.registrant = rest.slice(0, slash).trim();
        out.suffix = rest.slice(slash + 1).trim();
        return out;
    }

    /**
     * 把「注册机构号 + 后缀」拼回完整 DOI 串。
     *
     * ⚠️ 与 splitDoi **必须互逆**（对标准 DOI 而言）。
     *    改一个时另一个一定要跟着改，否则会出现
     *    「打开详情 → 直接保存 → DOI 变了」这种静默数据损坏。
     *
     * ⚠️ 两段都空 → 返回空串（而不是 "10." 这种残渣）。
     *    只填了后缀、没填注册机构号 → 只返回后缀（见 splitDoi 的注释）。
     */
    function joinDoi(registrant, suffix) {
        var r = String(registrant == null ? '' : registrant).trim();
        var f = String(suffix == null ? '' : suffix).trim();
        if (!r && !f) return '';
        if (!r) return f;
        if (!f) return DOI_PREFIX + r;
        return DOI_PREFIX + r + '/' + f;
    }

    /**
     * 顶层（非 fields 嵌套）字段的 key 集合。
     *
     * ⚠️ 与 Kotlin 侧 LibraryStore.TOP_LEVEL_KEYS 必须**逐字一致**：
     *       setOf("title", "author", "year", "venueType", "venue", "shortTitle")
     *    这里多一个 `venue` —— 它是老数据的载体名兼容字段。
     *
     * ⚠️ `shortTitle` 必须在里面。之前它叫 `venueShort` 且**不在这里**，
     *    导致它被当普通字段写进 `fields`，读回来时只读顶层，
     *    于是短标题保存后消失（详见 SHORT_NAME_FIELD 的注释）。
     */
    var TOP_LEVEL_KEYS = {
        title: 1, author: 1, year: 1, venueType: 1, venue: 1,
        shortTitle: 1
    };

    /**
     * 从 doc 里取「载体名」用于卡片显示。
     *
     * ⚠️ 兜底链：类别字段 → `doc.venue` → 空串。
     *
     *    为什么要有 `doc.venue` 这一层：
     *      ① 老数据（v0.1.5 之前导入的）没有类别字段，只有 venue；
     *      ② 用户把类别改成 unknown 时，之前填的类别字段就失效了，
     *         但他可能已经在抬头行填过「发表物」。
     *    两层都空就留白 —— 卡片那一栏本来就是「可为空」的。
     *
     * @param {Object} doc 文献对象
     * @returns {string} 载体名（可能为空串）
     */
    function venueNameOf(doc) {
        if (!doc) return '';
        var keys = VENUE_NAME_FIELDS[doc.venueType] || [];
        for (var i = 0; i < keys.length; i++) {
            var v = doc[keys[i]];
            if (v && String(v).trim()) return String(v).trim();
        }
        return doc.venue && String(doc.venue).trim() || '';
    }

    global.ScholariusMeta = {
        VENUE_TYPES: VENUE_TYPES,
        COMMON_FIELDS: COMMON_FIELDS,
        TYPE_FIELDS: TYPE_FIELDS,
        SHORT_NAME_FIELD: SHORT_NAME_FIELD,
        TOP_LEVEL_KEYS: TOP_LEVEL_KEYS,
        DOI_PREFIX: DOI_PREFIX,
        fieldsFor: fieldsFor,
        venueNameOf: venueNameOf,
        splitDoi: splitDoi,
        joinDoi: joinDoi
    };
})(window);
