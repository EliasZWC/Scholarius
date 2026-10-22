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
     * @param level    层级（1 / 2 / 3；提取层最多给到 2）
     * @param isFirst  是不是全文第一个块
     * @return 前缀字符串，空串表示"不是标题"
     */
    function headingPrefix(kind, level, isFirst) {
        if (kind !== 'heading') return '';
        var lv = Number(level) || 0;

        /*
          ⚠️ 文章标题的唯一判据是"全文第一块 + 是标题"。
             不能用 `level === 1` 单独判 —— 正文里的章标题也是 1。
        */
        if (isFirst) return '#';
        if (lv <= 1) return '##';
        if (lv === 2) return '###';
        return '####';
    }

    // ------------------------------------------------------------------
    // 主入口
    // ------------------------------------------------------------------

    /**
     * 把块数组翻译成 Markdown。
     *
     * @param blocks  形如 `[{ kind, level, text, lines }]`。
     *                `kind` 应当是**用户标注生效后**的类型，
     *                `lines` 可选（提取层给的多行原文）。
     * @param opts    { listKinds: { author: true, reference: true } }
     * @return Markdown 字符串（以 `\n` 结尾）
     */
    function toMarkdown(blocks, opts) {
        var o = opts || {};
        var listKinds = o.listKinds || {};
        var out = [];
        var seenBlock = false;
        var refCounter = 0;

        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i] || {};
            var text = String(b.text == null ? '' : b.text);
            if (!text.replace(/\s+/g, '')) continue;

            var kind = b.kind || 'body';
            var isFirst = !seenBlock;
            seenBlock = true;

            // ① 标题：一行，不需要列表也不需要换行处理
            var pref = headingPrefix(kind, b.level, isFirst);
            if (pref) {
                out.push(pref + ' ' + text.replace(/\s*\n\s*/g, ' ').replace(/^\s+|\s+$/g, ''));
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
                      ⚠️ 作者项：一行一项（用户裁决「作者项可以直接分为
                         一个个无序列表」）。这里**不**做编号分组 ——
                         「Tomas Mikolov Kai Chen」和「Google Inc., …」
                         本来就是两个独立的项，都该有 `- `。
                    */
                    for (var a = 0; a < rows.length; a++) {
                        out.push(listItem('- ', [rows[a]], LIST_CONT_WIDTH));
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

        return out.length ? out.join('\n\n') + '\n' : '';
    }

    global.ScholariusMarkdown = {
        toMarkdown: toMarkdown,
        headingPrefix: headingPrefix,
        /** 供测试用：常量也暴露出来，断言里可以直接引用 */
        HARD_BREAK: HARD_BREAK,
        INDENT: INDENT
    };
})(window);
