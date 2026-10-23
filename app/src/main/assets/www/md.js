/* =====================================================================
   文本 → Markdown 导出（v0.1.91）

   ══ ⚠️⚠️ 为什么用 Markdown，而不是自己发明结构（用户裁决）══

   用户原话：

     「我知道了，也许我们保存的形式可以不是纯文本，而是md？」
     「直接用 md 来储存，那么段、项目、排序项等结构都是原生的，
       这不需要我们自己来专门写一份结构分割算法了」
     「此时，文章标题就是单个井号，一级标题两个井号，
       二级三个，三级四个，直接统一了」
     「作者项可以直接分为一个个无序列表」
     「文献用有序列表」
     「正文当然肯定不能用列表，所以正文编号这个确实还得用算法添加」

   ✅ 所以本文件的职责只有**翻译**：
      块的类型（kind / level / 用户标注）→ Markdown 记号。
      不做任何"猜边界"的算法 —— 那正是反复出错的地方
      （见记忆 constraints.md §0.-2.1，作者信息连错七版）。

   ══ 层级映射（唯一约定）══

        文章标题   →  `#`      只出现在全文第一块
        一级标题   →  `##`
        二级标题   →  `###`
        三级标题   →  `####`
        无标签正文 →  普通段落（段落之间空一行）
        作者项     →  `- ` 无序列表
        文献       →  `1. ` 有序列表

   ⚠️ `#` 永远只有一个 —— 章节从 `##` 起，
      与阅读视图里的标注体系一一对应，不另维护一套编号。
   ===================================================================== */
(function (global) {
    'use strict';

    /**
     * 正文里"行"的语义：段内换行 → Markdown 硬换行（行尾两个空格）。
     *
     * ⚠️ 不能用空行 —— 空行在 Markdown 里是**新段落**，
     *    而这里说的是同一段的排版换行。
     * ⚠️ 也不能直接 `\n` —— CommonMark 会把单换行当空格，
     *    用户看到的就还是一整行。
     */
    var HARD_BREAK = '  \n';

    /** 一个缩进（子项用），4 空格 —— 兼容所有 Markdown 实现 */
    var INDENT = '    ';

    /**
     * 列表项内部的换行缩进宽度。
     *
     * ⚠️ 必须是"标记宽度"（`- ` = 2）+ 空格，否则续行会被当成新段落，
     *    整条列表项就断了。有序列表 `12. ` 是 4 —— 取 4 两边都安全。
     */
    var LIST_CONT_WIDTH = 4;

    // ------------------------------------------------------------------
    // 内部工具
    // ------------------------------------------------------------------

    function pad(s) {
        return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
    }

    /** 把一段多行文本按 `\n` 拆开、去空行、去首尾空白 */
    function cleanLines(text) {
        return String(text == null ? '' : text)
            .split('\n')
            .map(pad)
            .filter(function (l) { return l.length > 0; });
    }

    /**
     * 把一行文字包成列表项（含内部的硬换行缩进）。
     *
     * @param marker  `- ` 或 `12. `
     * @param lines   该列表项的原文行
     */
    function listItem(marker, lines, contWidth) {
        var body = lines.join(HARD_BREAK + repeat(' ', contWidth));
        return marker + body;
    }

    function repeat(ch, n) {
        var s = '';
        for (var i = 0; i < n; i++) s += ch;
        return s;
    }

    /**
     * 文献条目的起始标记（行首）：`[12]` 或 `12.` / `12、`。
     *
     * ⚠️ 这是从 PDF 原文里**读到**的事实，不是推断 ——
     *    文献列表天然带编号，用它切条目最可靠。
     */
    var REF_START_RE = /^\s*(\[\d+\]|\d+[.、])\s/;

    /**
     * 渲染**带子标签的作者项**（v0.1.91）。嵌套输出。
     *
     * 用户原话：「内部的嵌套项则是子标签」
     * 用户认可的形式：
     *
     *     - Jacob Devlin
     *       - 单位：Google AI Language
     *       - 邮箱：jacobdevlin@google.com
     *
     * ══ ⚠️⚠️ 为什么"父项"是**未标注的普通行**，不是姓名字段 ══
     *
     * 实测 Word2Vec 的作者块：
     *
     *     Tomas Mikolov Kai Chen                      ← 未标注（父）
     *     Google Inc., Mountain View, CA …            ← field=affiliation
     *     tmikolov@google. com kaichen@google. com    ← field=email
     *
     * 父项（姓名行）**没有**子标签 —— 用户只给下面两行加了「单位」「邮箱」。
     * 所以父项 = 按原文顺序排的、没有 `field` 的行。
     *
     * ⚠️ 但用户也可能给姓名行加 `field=name`。那种情况下**不能**输出
     *    `- 姓名：Tomas Mikolov` —— 姓名是父项本身，加标签反而啰嗦。
     *    ✅ 所以 `name` 作父项内容（不带前缀），其余 field 作子项。
     *
     * @param items  [{ text, field }] —— 按原文顺序，field 可为 null
     * @param labelFn  field → 显示名（i18n）
     * @return {string[]} 若干行（已含缩进）
     */
    function authorNested(items, labelFn) {
        var lines = [];

        /*
          ══ ⚠️⚠️ 两种情况（v0.2.23 用户裁决）══

          用户原话：
            「作者区域应该是 - Author: ashish vaswani google brain...，
              而一旦标注子标签，就应该是 - Author Name 啥的了。」

          ① **没标注任何子标签** → 整个作者区合成**一条**：
                 - Author: ashish vaswani google brain avaswani@google.com

          ② **标注了子标签** → 每个子标签一条：
                 - Author Name: ashish vaswani
                 - Author Affiliation: google brain

          ⚠️ 之前的实现是"每个输入项一条 `- 文本`"，
             导致没标子标签时变成 `- Ashish Vaswani` / `- Google Brain`
             两个**平级条目** —— 用户要的是合成一条并带 `Author:` 前缀。
          ⚠️ 判断依据：这一组 items 里**有没有任何 field 非空**。
             全空 → 情况①；有任何一个 → 情况②。
        */
        var hasField = false;
        for (var q = 0; q < items.length; q++) {
            if (items[q] && items[q].field) { hasField = true; break; }
        }

        if (!hasField) {
            /*
              ══ ⚠️ **每条一行**（v0.2.31 改）══

              用户原话：
                「算了，我不加子标签了，我觉得你怎么都弄不好，
                  直接到标签那一级就停下吧」

              ⚠️ 上一版（v0.2.23）在这里把所有项**用空格拼成一条**：

                  - Author: Ashish Vaswani Google Brain avaswani@...

              那是在子标签时代的权宜 —— 因为"整块"就是一条作者信息。
              **但作者块的常见形态是多行、一行一位作者**，
              拼成一条就把多行并成一行，正是反复出现的"换行/拆行" bug 的
              另一个面：渲染侧拆碎、导出侧粘连。

              ✅ 现在子标签停用，`items` 就是**逐行的作者**。
                 一条一个 `- Author: …`，与渲染侧一行一条完全对应。
              ⚠️ 只有一个 item 时结果与旧行为一致，不引入变化。
            */
            for (var k = 0; k < items.length; k++) {
                var tk = pad(items[k] && items[k].text);
                if (!tk) continue;
                lines.push('- ' + labelFn('__whole') + ': ' + tk);
            }
            return lines;
        }

        /* ② 逐子标签一条 */
        for (var j = 0; j < items.length; j++) {
            var it = items[j];
            var text = pad(it && it.text);
            if (!text) continue;
            if (!it.field) {
                /*
                  ⚠️ 有子标签的组里出现无标签行 → 它属于"没归类的部分"，
                     用同一个 Author 前缀输出，不要丢。
                */
                lines.push('- ' + labelFn('__whole') + ': ' + text);
            } else {
                lines.push('- ' + labelFn(it.field) + ': ' + text);
            }
        }
        return lines;
    }

    /**
     * 把若干排版行按「条目起始标记」重新分组。
     *
     * ══ ⚠️ 为什么需要 ══
     *
     * 一条文献在 PDF 里常常折成 2~4 行：
     *
     *     [3] T. Brants, … Large language models in machine
     *     translation. In Proceedings of the Joint Conference …
     *     Processing and Computational Language Learning, 2007.
     *
     * 按行输出会把一条文献拆成三个编号项（实测踩到）。
     *
     * ✅ 行首**带编号**才开新条目，其余行并进上一条。
     * ⚠️ 第一条行首没有编号时（PDF 丢了编号），把**所有行并成一条** ——
     *    比硬切成多条安全：少一个编号，好过把一条文献劈成几截。
     *
     * @param rows  原始排版行
     * @param re    条目起始正则
     * @return 二维数组，每项是一条完整条目（内部仍保留换行）
     */
    function groupEntries(rows, re) {
        var groups = [];
        var cur = null;
        for (var i = 0; i < rows.length; i++) {
            var line = pad(rows[i]);
            if (!line) continue;
            if (re.test(line)) {
                if (cur) groups.push(cur);
                cur = [line];
            } else if (cur) {
                cur.push(line);
            } else {
                /* 还没有任何条目 → 这几行属于同一条 */
                cur = [line];
            }
        }
        if (cur) groups.push(cur);
        return groups;
    }

    // ------------------------------------------------------------------
    // 标题
    // ------------------------------------------------------------------

    /**
     * 计算标题前缀。
     *
     * @param kind     块类型（提取层给的 `heading` / `paragraph` …，
     *                 或用户标注覆盖后的类型）
     * @param level    层级（0=文章标题 / 1 / 2 / 3；提取层最多给到 2）
     * @param isFirst  是不是全文第一个块
     * @return 前缀字符串，空串表示"不是标题"
     */
    function headingPrefix(kind, level, isFirst) {
        /*
          ⚠️ `h1` / `h2` / `h3` 也算标题（v0.2.21）——
             用户标注层用 h1/h2/h3 作为标签名，reader.js 会把
             kind 规范成 heading，但兜底逻辑也要认，
             否则直接传 h1 时前缀为空、标题退化成正文。
        */
        if (kind === 'h1' || kind === 'h2' || kind === 'h3') {
            var hv = kind === 'h1' ? 1 : (kind === 'h2' ? 2 : 3);
            if (level != null) hv = Number(level) || hv;
            if (hv <= 1) return '##';
            if (hv === 2) return '###';
            return '####';
        }
        if (kind !== 'heading') return '';
        var lv = Number(level);
        if (isNaN(lv)) lv = -1;

        /*
          ══ ⚠️⚠️ 层级映射：`#` 数量 = level + 1（v0.2.23 统一）══

          用户裁决：
            「标注为文章标题的，应为md的一级标题；文章中的Heading
              分别对应md的二三四级标题。」

              title (level 0) → `#`     文章标题
              h1    (level 1) → `##`
              h2    (level 2) → `###`
              h3    (level 3) → `####`

          ⚠️ 渲染侧用的是 `<h1>`..`<h4>` 标签（+1 之后），
             两边必须一致，否则"屏幕上 h2、文件里 #"。

          ⚠️ 老数据（`MdDoc.parse` 出来的）`level` 已经是
             **`#` 的个数**（1..4），那正好落在同一个区间里 ——
             但要区分"来自 md 的 1"和"标注 h1 的 1"，两者都是 `##`，
             所以不需要区分：md 里 `#` 个 = 1 的就是文章标题，
             而标注 title 也映射到 level 0 → 同样出 `#`。
        */
        if (lv >= 0 && lv <= 4) {
            var count = lv + 1;
            if (count > 4) count = 4;
            var s = '';
            for (var i = 0; i < count; i++) s += '#';
            return s;
        }

        /* 老数据：只有 isFirst 信息，按"首块=文章标题"兜底 */
        return isFirst ? '#' : '##';
    }

    // ------------------------------------------------------------------
    // 主入口
    // ------------------------------------------------------------------

    /**
     * 把块数组翻译成 Markdown。
     *
     * @param blocks  形如 `[{ kind, level, text, lines, authorItems }]`。
     *                `kind` 应当是**用户标注生效后**的类型，
     *                `lines` 可选（提取层给的多行原文），
     *                `authorItems` 可选（`[{text, field}]`，仅作者块用）。
     * @param opts    { listKinds: {...}, fieldLabel: function(field)->string }
     *                ⚠️ `fieldLabel` 缺省时直接把 field 当显示名 ——
     *                    测试里不必准备 i18n。
     * @return Markdown 字符串（以 `\n` 结尾）
     */
    function toMarkdown(blocks, opts) {
        var o = opts || {};
        var listKinds = o.listKinds || {};
        if (typeof o.fieldLabel !== 'function') {
            o.fieldLabel = function (f) { return String(f || ''); };
        }
        /*
          ══ ⚠️⚠️ 两个"伪字段"：`__whole` 与 `__ref`（v0.2.23）══

          它们不是真正的 author 子标签，而是**条目前缀**：
            `__whole` → `Author`    （作者区整段一条时用）
            `__ref`   → `Ref`       （文献条目前缀）

          走同一个 `fieldLabel` 通道，这样 i18n 侧只需在
          `reader.field.__whole` / `reader.field.__ref` 各加一条文案，
          不必给 `toMarkdown` 新增参数。
        */
        function labelFnRef() {
            return o.fieldLabel('__ref');
        }
        var out = [];
        var seenBlock = false;
        var refCounter = 0;
        /*
          ══ 连续的 author 块要合成**一个**列表（v0.1.91 实测）══

          实测 Word2Vec：姓名行在块 2，单位/邮箱在块 3（提取层各成一个块）。

              - Tomas Mikolov Kai Chen          ← 块 2 的父项
              - Affiliation：Google Inc., …      ← 块 3 的子项

          块 3 单独作为一个列表时**没有父项**，渲染出来是两个
          游离的子项（多缩进一级、看着像孤儿）。

          ✅ 按"连续的 author 块"分组：把它们的 items 拼起来，
             再一次性做嵌套。父项 = 组内第一个无 field/姓名的行。
        */
        var authorBuf = [];

        function flushAuthor() {
            if (!authorBuf.length) return;
            var lines = authorNested(authorBuf, o.fieldLabel);
            for (var k = 0; k < lines.length; k++) out.push(lines[k]);
            authorBuf = [];
        }

        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i] || {};
            var text = String(b.text == null ? '' : b.text);
            if (!text.replace(/\s+/g, '')) continue;

            var kind = b.kind || 'body';
            var isFirst = !seenBlock;
            seenBlock = true;

            /*
              ══ ⚠️⚠️ md 原有的列表记号：**原样输出**（v0.2.22）══

              用户裁决：
                「直接清理，完全按照md格式来渲染」

              `listMarker` 是从 md 解析出来的**原文记号**（`- ` / `1. `）。
              这份块存在，说明 md 里本来就是列表项 —— 必须原样写回，
              不能重新判断"它是不是文献/作者"。

              ⚠️ 之前只看 `kind === 'reference'`，而 `kind` 来源于
                 用户标注。于是"从 md 读进来、用户没动过"的文献列表，
                 再导出时全部退化成普通段落 —— **结构被破坏**。
                 这是 md 作为数据结构最不该犯的错。

              ⚠️ 无序列表（作者）走 `authorBuf` 聚合，因为它可能有
                 子标签需要拼前缀；有序列表直接输出（序号由计数器给）。
            */
            var mdMarker = String(b.listMarker || '');
            if (mdMarker) {
                var isMdBullet = mdMarker.indexOf('-') >= 0 || mdMarker.indexOf('*') >= 0;
                if (isMdBullet) {
                    /*
                      ⚠️ md 里的 `- Author: xxx` / `- Author Name: xxx` 已经
                         带了前缀，读进来时 `MdDoc.parse` 已把前缀剥掉、
                         还原成 field 标注。这里再 push 无 field 的原文本，
                         会**丢掉**前缀信息。
                         ✅ 所以：如果这一项本来就带 `Author` 前缀，
                            原样写回（不重新拼）。
                    */
                    var rawBullet = String(b.text || '');
                    /*
                      ══ ⚠️⚠️ `authorItems` 优先，且**不依赖 `kind`**（v0.2.31 修）══

                      旧代码把 `authorItems` 的判断挂在 `b.kind === 'author'` 下。
                      但 `kind` 只有在**用户整块标注**时才被赋成 'author'；
                      从 md 读进来的作者块、或只靠 `listMarker` 识别的块，
                      `kind` 是空的 → 落到最后那个 `else`
                      「普通无序列表项：原样输出」：

                          out.push('- ' + text.replace(所有换行 → 空格))

                      于是多行作者区在导出时被**压成一行**，
                      正是用户反复遇到的「行没了」。

                      ✅ `authorItems` 是渲染侧按行算好的，只要它存在就是
                         作者区，与 `kind` 无关。放在最前面处理。
                    */
                    if (b.authorItems && b.authorItems.length) {
                        for (var aq0 = 0; aq0 < b.authorItems.length; aq0++) {
                            authorBuf.push(b.authorItems[aq0]);
                        }
                        continue;
                    }
                    /*
                      ══ ⚠️ 兜底：多行无序项 → 每行一条（v0.2.31）══

                      走到这里说明 `authorItems` 不存在（块不是作者区）。
                      但**多行**的无序项仍不能压成一行 —— 那会让行消失。
                      只有当它是"用户自己写的普通列表项"且确实单行时才原样输出。
                    */
                    var rawLines = String(text || '').split(/\r?\n/).filter(function (z) {
                        return String(z || '').replace(/\s+/g, '') !== '';
                    });
                    if (b.kind === 'author' || rawLines.length > 1) {
                        for (var aq3 = 0; aq3 < rawLines.length; aq3++) {
                            var at3 = String(rawLines[aq3]).replace(/^\s+|\s+$/g, '');
                            if (at3) authorBuf.push({ text: at3, field: null });
                        }
                    } else {
                        /* 普通单行无序列表项：原样输出 */
                        flushAuthor();
                        out.push('- ' + rawLines[0]);
                    }
                    continue;
                }
                /*
                  ══ ⚠️ 文献：`1. Ref: 内容`（v0.2.23 用户裁决）══

                  用户原话：
                    「文献的项改为 1. Ref: 然后跟着文献引用。」

                  ⚠️ 已经有 `Ref:` 前缀的不再重复加 ——
                     否则每导出一次就多一个 `Ref: Ref: ...`。
                  ⚠️ **先把作者缓冲区刷出去**（v0.2.23）——
                     否则顺序会错：作者延迟到遇到非 author 才输出，
                     而文献是立即输出的，结果文献跑到作者前面。
                */
                flushAuthor();
                refCounter += 1;
                var refText = text.replace(/\s*\n\s*/g, ' ');
                if (!/^Ref\s*:/i.test(refText)) {
                    refText = labelFnRef() + ': ' + refText;
                }
                out.push(refCounter + '. ' + refText);
                continue;
            }

            /* ⚠️ 非 author 块出现 → 上一段作者区结束，必须先刷出去 */
            if (kind !== 'author') flushAuthor();

            // ① 标题：一行，不需要列表也不需要换行处理
            var pref = headingPrefix(kind, b.level, isFirst);
            if (pref) {
                out.push(pref + ' ' + text.replace(/\s*\n\s*/g, ' ').replace(/^\s+|\s+$/g, ''));
                continue;
            }

            /*
              ── ② 用户标注成 author / reference（**没有** md 记号）──

              ⚠️ 这段只在 `listMarker` 为空时才会走到 ——
                 有 md 记号的情况已经在上面处理并 `continue` 了。
                 所以这里处理的都是"用户在 app 里新标注的类型"。

              ⚠️ 顺序很重要：必须在 `listKinds` 分支**之前**判断，
                 否则有 reference 标注的块会既走标注分支、
                 又被下面的 REF_START_RE 切一次（实测产生 `2. .`）。
            */
            if (kind === 'reference') {
                refCounter += 1;
                var refTxt = text.replace(/\s*\n\s*/g, ' ');
                if (!/^Ref\s*:/i.test(refTxt)) refTxt = labelFnRef() + ': ' + refTxt;
                out.push(refCounter + '. ' + refTxt);
                continue;
            }
            if (kind === 'author') {
                /*
                  ══ ⚠️⚠️ 绝不把多行压成一行（v0.2.31 修）══

                  旧代码先把整块文本压成一行（把所有换行替换成空格）：
                  那一步对"多行作者区"是破坏性的。

                  后果：一个作者区域里
                      · 一行多位作者（`Ashish Vaswani Noam Shazeer`）→ 没问题
                      · **多行分别是姓名 / 单位 / 邮箱** → 全被空格连成一句

                          - Author: Ashish Vaswani Google Brain avaswani@...

                  用户看到的就是"行没了"。这与渲染侧的"拆行"是同一个
                  问题的两个面：渲染侧拆碎、导出侧粘连。

                  ✅ `authorBuf` 是**按条**聚合的，一条 = 一行。
                     多行就多 push 几条，`md.authorNested` 逐条输出。
                  ✅ 有 `authorItems`（渲染侧已按行算好）优先用它。
                */
                if (b.authorItems && b.authorItems.length) {
                    for (var aq = 0; aq < b.authorItems.length; aq++) {
                        authorBuf.push(b.authorItems[aq]);
                    }
                } else {
                    var aRows = (b.lines && b.lines.length > 1)
                        ? b.lines
                        : String(text || '').split(/\r?\n/);
                    var aPushed = 0;
                    for (var ar2 = 0; ar2 < aRows.length; ar2++) {
                        var aTxt = String(aRows[ar2] == null ? '' : aRows[ar2])
                            .replace(/^\s+|\s+$/g, '');
                        if (!aTxt) continue;
                        authorBuf.push({ text: aTxt, field: null });
                        aPushed += 1;
                    }
                    if (!aPushed) {
                        authorBuf.push({ text: String(text || ''), field: null });
                    }
                }
                continue;
            }

            /*
              ② 列表类块（用户裁决：作者项无序、文献有序）

              ⚠️ 行优先用 `lines`（提取层保留的**原始排版行**），
                 没有才退回按 `\n` 拆 text。
                 —— 这正是「不自己写分割算法」的落点：
                    行边界是提取层给的事实，不是我们猜的。
            */
            if (listKinds[kind]) {
                /*
                  ══ ⚠️⚠️ 条目边界：**行**，不是 lines 里的每一行（v0.1.91 实测后改）══

                  实测 Word2Vec 文献区（真实 PDF）：

                      [3] T. Brants, … Large language models in machine
                      translation. In Proceedings of the Joint Conference …
                      Processing and Computational Language Learning, 2007.

                  这三行是**一条**文献的排版折行，不是三条文献。
                  按 `lines` 每行出一项 → 一条文献被拆成 3 个编号项，
                  而且第 2、3 项是小写开头，看起来完全错乱。

                  ✅ 判据：**行首带编号标记的行**才是新条目。
                     · 文献：行首 `[n]` 或 `n.`
                     · 作者：行首是「姓名」形状（大写开头）——但作者项
                       本来就是一行一个，见下。

                  ⚠️ 不能用"上一行是否以句号结尾"来切 ——
                     句号后面常常还有"…2007." 这类结尾，切不准；
                     而编号标记是 PDF 原文里**真实存在**的，不靠推断。
                */
                var rows = (b.lines && b.lines.length > 1) ? b.lines : cleanLines(text);
                if (!rows.length) continue;

                if (kind === 'reference') {
                    /*
                      ⚠️ 有序列表的序号由渲染器生成 —— 但**必须显式写数字**：
                         Markdown 里 `1.` 开头的连续项会被自动重新编号，
                         而文献往往跨多个块（每条一个块），
                         不写数字就会全部变成 1、2、3… 重新开始。
                    */
                    var entries = groupEntries(rows, REF_START_RE);
                    for (var r = 0; r < entries.length; r++) {
                        refCounter += 1;
                        out.push(listItem(refCounter + '. ', entries[r], LIST_CONT_WIDTH));
                    }
                } else {
                    /*
                      ══ 作者项：收集到缓冲区，等这一组结束再统一嵌套（v0.1.91）══

                      用户裁决：
                        「作者项可以直接分为一个个无序列表」
                        「内部的嵌套项则是子标签」

                      ⚠️ 子标签来自 `b.authorItems`（reader.js 从
                         `labels[line]` 的 `field` 算出，按原文顺序）。
                         没有 `authorItems` 时按"一行一项"补进去，
                         仍然与相邻块的子项合成同一个列表。
                    */
                    if (b.authorItems && b.authorItems.length) {
                        for (var q = 0; q < b.authorItems.length; q++) {
                            authorBuf.push(b.authorItems[q]);
                        }
                    } else {
                        for (var a = 0; a < rows.length; a++) {
                            authorBuf.push({ text: rows[a], field: null });
                        }
                    }
                }
                continue;
            }


            /*
              ③ 普通正文：段落之间空一行，**段内不硬换行**。

              ══ ⚠️⚠️ 正文**不能**用 `lines` 拼硬换行（v0.1.91 实测后改）══

              实测导出 Word2Vec 后前 5 段变成：

                  We propose two novel model architectures for computing
                  continuous vector repre-                      ← 断在半截
                  is measured in a word similarity task, …

              真因：`lines` 是**排版折行**（PDF 每行几十个字符就换），
              不是作者的语义换行。用硬换行导出，等于把 PDF 的窄栏
              当成 Markdown 的换行 —— 整篇断成一截一截。

              ✅ 正文一律**输出合并后的 text**（提取层已经用空格拼好了），
                 让 Markdown 渲染器按屏幕宽度自己折行。

              ⚠️ 只有 `author` / `reference` 才用 `lines` ——
                 那两类里「一行 = 一个条目」是**语义**，不是排版。
                 用户裁决原话：
                 「作者项可以直接分为一个个无序列表」
                 「此时直接不需要换行了，将提取的文字变成项目就可以了」
            */
            var body = text.replace(/^\s+|\s+$/g, '');
            if (body) out.push(body);
        }

        /*
          ⚠️ 收尾：最后一组如果是作者区，必须刷出来 ——
             漏掉这一步会让文末的作者块整个消失（静默丢内容）。
        */
        flushAuthor();
        /*
          ══ ⚠️ 丢弃空条目（v0.2.23）══

          实测：`splitBlockByMarks` 在标注边界与块边界不完全重合时
          会切出一个**只含空白**的片段。它被 `toMarkdown` 的空文本
          判断过滤掉了，但 `listKinds` 分支里 `groupEntries` 仍可能
          产出空条目 —— 结果 md 里出现 `2. Ref: .`。

          ✅ 在这里统一兜底：去掉"只有列表记号、没有正文"的行。

          ⚠️ 判据要**容忍前缀**：`- Author: ` 后面没内容、`1. Ref: `
             后面没内容，都算空条目。
        */
        var cleaned = [];
        for (var ci = 0; ci < out.length; ci++) {
            var line = out[ci];
            if (line == null) continue;
            var probe = String(line)
                .replace(/^[-*+]\s+/, '')
                .replace(/^\d+[.)]\s+/, '')
                .replace(/^Author(\s+[A-Za-z]+)?\s*:\s*/i, '')
                .replace(/^Ref\s*:\s*/i, '')
                .trim();
            if (probe === '') continue;
            cleaned.push(line);
        }
        return joinBlocks(cleaned);
    }

    /** 一个不可再分的行是不是列表项（`- x` / `1. x` / 缩进的子项） */
    function isListItemLine(s) {
        return /^\s*([-*+]|\d+[.)])\s/.test(s);
    }

    /**
     * 拼接各"块"：普通块之间空一行，**连续的列表行之间只换行**。
     *
     * ══ ⚠️⚠️ 为什么必须区分（v0.1.91 实测踩到）══
     *
     * 作者块嵌套输出：
     *
     *     - Tomas Mikolov Kai Chen
     *       - affiliation：Google Inc., …
     *
     * 如果用 `\n\n` 连接，Markdown 会把它读成**两个独立列表**，
     * 子项就不再属于父项（渲染出来是并列的两个项目符号）。
     * 序号同理：文献每块一个 `1.` `2.`，用 `\n\n` 连接会被
     * 各自重新编号，全变成 1。
     *
     * ✅ 规则：相邻两个单元**都是列表行** → 只用一个 `\n`；
     *    否则用空行（正文段落之间必须空行，这是 Markdown 语法）。
     */
    function joinBlocks(units) {
        if (!units.length) return '';
        var s = units[0];
        for (var i = 1; i < units.length; i++) {
            var prev = units[i - 1];
            var cur = units[i];
            /*
              ⚠️ 只看两个单元**各自的首行** —— 一个单元可能是多行文本
                 （正文段落带硬换行），那种后面必须空行。
            */
            var both = isListItemLine(prev) && isListItemLine(cur) &&
                prev.indexOf('\n') < 0;
            s += (both ? '\n' : '\n\n') + cur;
        }
        return s + '\n';
    }

    global.ScholariusMarkdown = {
        toMarkdown: toMarkdown,
        headingPrefix: headingPrefix,
        /** 供测试用：常量也暴露出来，断言里可以直接引用 */
        HARD_BREAK: HARD_BREAK,
        INDENT: INDENT
    };
})(window);
