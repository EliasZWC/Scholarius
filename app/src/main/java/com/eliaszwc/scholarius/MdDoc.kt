/*
 * 正文的 Markdown 存储格式（v0.1.92）。
 *
 * ══ ⚠️⚠️ 为什么需要“带标注的 md”，而不是纯 md ══
 *
 * 用户裁决：
 *   「pdf 转我们的文本时，原本保存的格式我不知道是什么？也许是 json？
 *     现在直接改为 md 就可以了，就相当于这就是我们本地保存的形式」
 *   「相当于 md 是我们的数据保存结构，但阅读器靠这个原文件来渲染」
 *
 * 所以 `doc.md` 是唯一数据源。但阅读视图需要的信息有两类：
 *
 *   ① 正文与结构   —— 标题层级、列表、段落。md 原生能表达。
 *   ② 用户标注     —— 「这一块是作者信息」「这段是 h2」「这个词是引用」。
 *                     md **没有**字符区间这个概念。
 *
 * ✅ 解法：每个块一行 Markdown，**块级标注**就地写进该行；
 *    **行内**标注（引用 `[12]`、作者子标签）用行尾 HTML 注释携带：
 *
 *      ## 1 Introduction                      ← 标题：md 原生
 *      - Tomas Mikolov                          ← 列表：md 原生
 *         <!--@a:0-14=name-->                   ← 子标签（行内标注）
 *      This is text[12] with a cite.           ← 正文
 *         <!--@c:14-18-->                       ← 引用区间
 *
 * ══ ⚠️ 关键设计：注释里**只存标注**，不存正文 ══
 *
 * 正文就是 md 本身。这样：
 *   · 用户把 doc.md 拷出去，得到的是**干净可读**的 Markdown；
 *   · 我们读回来时，正文从 md 解析，标注从注释解析，两者对齐。
 *
 * ⚠️ 注释前缀用 `@` 与其他注释区分：
 *     `<!--@b-->`       块类型 body
 *     `<!--@t-->`       块类型 title
 *     `<!--@a:0-14=name-->`   author 标注 + 子标签
 *     `<!--@r:0-120-->`  reference
 *     `<!--@c:14-18=12-->`    cite，`=12` 是目标文献的块序号
 *
 * ══ ⚠️⚠️ 解析必须宽容 ══
 *
 * 用户可能手工编辑 doc.md（那是它的价值所在）。解析时：
 *   · 认不出的注释 → 忽略，不能因此打不开文档；
 *   · 注释里的区间越界 → 夹到正文长度内；
 *   · 行首不是 `#`/`-`/`1.` 的行 → 一律当普通段落。
 */
package com.eliaszwc.scholarius

object MdDoc {

    /** 一个块（与 PdfText.Block 对齐，但只保留存储需要的字段） */
    data class Block(
        /** 块在文档里的序号（从 0 连续）—— 标注的区间就挂在这个键上 */
        val line: Int,
        /** 提取层的类型：heading / paragraph / formula / figure / body … */
        val kind: String,
        /** 标题层级：1 / 2 / 3（0 = 不是标题） */
        val level: Int,
        /** 该块的正文（**不含** md 记号，也不含注释） */
        val text: String,
        /** 块内的原始排版行（作者/文献的一行一项靠它） */
        val lines: List<String> = emptyList(),
        /** 用户标注：[{start, end, label, field, ref}] */
        val marks: List<Mark> = emptyList(),
        /** 该行在 md 里用的记号：mdHeadingPrefix 的结果（""=普通段落） */
        val mdPrefix: String = "",
        /** 列表记号：""=普通段落，"- "=无序，"1. "=有序 */
        val listMarker: String = ""
    )

    /** 一条标注（字段与 reader.js 的 labels[line] 完全一致） */
    data class Mark(
        val start: Int,
        val end: Int,
        /** body / title / author / abstract / h1 / h2 / h3 / reference / cite */
        val label: String,
        /** 作者子标签：name / affiliation / email / contact */
        val field: String? = null,
        /** 引用指向的文献块序号 */
        val ref: Int? = null
    )

    // ---------------------------------------------------------------------
    // 写
    // ---------------------------------------------------------------------

    /**
     * 把块序列化成 md。
     *
     * ⚠️ 块与块之间用**空行**分隔 —— 这是 Markdown 段落的标准写法。
     *    列表项之间也用空行：本项目的阅读视图是“一块一段”，
     *    用空行能保证回读时一行不多一行不少。
     */
    fun serialize(blocks: List<Block>): String {
        val sb = StringBuilder(blocks.size * 96)
        for (b in blocks) {
            val body = b.text.replace("\r\n", "\n").trim()
            if (body.isEmpty()) continue

            val marker = if (b.listMarker.isNotEmpty()) b.listMarker
            else if (b.mdPrefix.isNotEmpty()) b.mdPrefix + " "
            else ""

            /*
              ══ ⚠️⚠️ 作者块的多行必须写进 md 的**结构**（v0.1.93 修 bug）══

              用户反馈：
                「当给作者信息区域第二行标注子标签时，出现了换行——
                  请确定，是否目前是遵循 md 格式切分实现的，
                  因为如果按照嵌套项而言，应该不会出现切分问题。」

              **用户判断对了。** 之前把 `b.lines`（提取层给的原始排版行）
              整块丢掉了，md 里只剩一整行拼接字符串。读回来时不知道
              原来在哪换行，渲染层只能按标注区间的端点硬切 →
              第二行被凭空切断，看起来"加了个子标签就多出一行"。

              ✅ 现在把行边界写进 md：**同一列表项内的续行**（markdown 原生）。

                  - Google Inc., Mountain View, CA Google Inc., Mountain View, CA
                    tmikolov@google. com kaichen@google. com

              缩进 2 空格 = "这是上一个列表项的续行"，而不是新列表项。
              读回来时把续行并回同一块、`lines` 恢复成两行。
              纯文本 md 依然可读，不引入任何私有语法。

              ⚠️ 只对**有多行**的块这样做；正文段落不写行（那是排版折行，
                 见 www/md.js 里"正文不能硬换行"的说明）。
            */
            val rows = b.lines
            if (rows.size > 1 && marker.isNotEmpty()) {
                sb.append(marker).append(rows[0])
                for (k in 1 until rows.size) {
                    val row = rows[k]
                    if (row.isBlank()) continue
                    /* 续行缩进 = 记号宽度（`- ` 是 2，`1. ` 是 3）+ 2 */
                    sb.append('\n').append(contIndent(marker)).append(row)
                }
            } else {
                sb.append(marker).append(body)
            }

            /* 行内标注（引用、作者子标签）跟在正文后面 */
            for (m in b.marks) {
                val tag = encodeMark(m)
                if (tag.isNotEmpty()) sb.append(' ').append(tag)
            }
            sb.append("\n\n")
        }
        return sb.toString()
    }

    /** 列表项续行的缩进（`- ` → 4 空格；`1. ` → 4 空格，统一取 4 最安全） */
    private fun contIndent(marker: String): String = "    "

    /**
     * 一条标注 → HTML 注释。
     *
     * ⚠️ 覆盖整块的块级标注（body/title/author/reference/h1/h2/h3/abstract）
     *    **不写** —— 它们已经由 md 的记号（`##` / `- ` / 有序编号）表达。
     *    再写一遍是冗余，而且用户手工改 md 后会立刻不一致。
     */
    private fun encodeMark(m: Mark): String {
        val body = when (m.label) {
            /* 行内标注才需要注释 */
            "cite" -> "c:" + m.start + "-" + m.end +
                (m.ref?.let { "=$it" } ?: "")
            "author" -> if (m.field == null) "" else
                "a:" + m.start + "-" + m.end + "=" + m.field
            else -> ""
        }
        return if (body.isEmpty()) "" else "<!--@$body-->"
    }

    // ---------------------------------------------------------------------
    // 读
    // ---------------------------------------------------------------------

    /** 解析结果：块 + 是否有任何可识别内容 */
    data class Parsed(val blocks: List<Block>, val recognised: Boolean)

    /**
     * 解析 md。
     *
     * ══ ⚠️ 块怎么切 ══
     *
     * 按**空行**切块（与 serialize 对称）。每块再判断：
     *   · 首行以 `#` 开头 → heading，层级数 = `#` 个数
     *   · 首行以 `- ` 开头 → 无序列表项（kind=author 由块级注释或上层决定）
     *   · 首行以 `1. ` 开头 → 有序列表项（kind=reference）
     *   · 其它 → paragraph
     *
     * ⚠️ 这个解析只服务“阅读视图渲染”，不需要 100% 还原 Markdown 语义。
     *    遇到复杂结构（嵌套列表、表格）就退化成一个段落 ——
     *    本项目生成的 md 不会出现那些，只有用户手工改才会。
     */
    fun parse(md: String): Parsed {
        val src = md.replace("\r\n", "\n")
        val chunks = src.split(Regex("\n{2,}"))
        val blocks = ArrayList<Block>(chunks.size)

        var any = false
        for (raw in chunks) {
            val chunk = raw.trim()
            if (chunk.isEmpty()) continue

            /*
              ══ ⚠️⚠️ 列表块要按**行**解析，不能整块当一个段落（v0.1.92）══

              作者块在 md 里是若干独立的列表项（每项之间空行）：

                  - Tomas Mikolov Kai Chen <!--@a:0-22=name-->
                  - Google Inc., …          <!--@a:0-102=affiliation-->

              上面的 `split("\n{2,}")` 已经把它们拆成单独 chunk 了，
              每一项是一个独立块 —— 这正是我们要的：
              每项自己的注释区间相对**它自己那一行**。
            */
            val marks = ArrayList<Mark>()
            val withoutMarks = stripAndCollectMarks(chunk, marks)
            val text = withoutMarks.trim()
            if (text.isEmpty()) continue

            var kind = "paragraph"
            var level = 0
            var mdPrefix = ""
            var listMarker = ""

            val hash = Regex("^(#{1,6})\\s+(.*)$", RegexOption.DOT_MATCHES_ALL)
            val bullet = Regex("^[-*+]\\s+(.*)$", RegexOption.DOT_MATCHES_ALL)
            val ordered = Regex("^\\d+[.)]\\s+(.*)$", RegexOption.DOT_MATCHES_ALL)

            var body = text
            val hm = hash.matchEntire(text)
            val bm = bullet.matchEntire(text)
            val om = ordered.matchEntire(text)

            if (hm != null) {
                val hashes = hm.groupValues[1].length
                kind = "heading"
                level = hashes
                mdPrefix = hm.groupValues[1]
                body = hm.groupValues[2].trim()
                any = true
            } else if (bm != null) {
                kind = "author"
                listMarker = "- "
                body = bm.groupValues[1].trim()
                /*
                  ══ ⚠️⚠️ 还原作者条目的前缀（v0.2.23）══

                  写入方向（见 www/md.js 的 authorNested）有两种形态：

                    · 没标子标签 → `- Author: ashish vaswani google brain`
                    · 标了子标签 → `- Author Name: ashish vaswani`

                  ✅ 读回来时：
                    · `Author:`        → 剥掉前缀，**不加** field 标注
                        （整段就是"作者信息"，没有细分）
                    · `Author <字段>:` → 剥掉前缀，补一条 field 标注

                  ⚠️ 顺序不能反：先试「带字段名的」，再试「纯 Author:」。
                     否则 `- Author Name: x` 会被 `Author:` 规则
                     匹配成「前缀 = 'Name'」，正文变成 `Name: x`。
                  ⚠️ 只认**已知**字段名，不认任意前缀 —— 否则作者名里
                     出现「Author: xxx」这种字样就会被误拆。
                */
                val fieldHit = AUTHOR_FIELD_PREFIX.matchEntire(body)
                if (fieldHit != null) {
                    val fieldText = fieldHit.groupValues[1]
                    val rest = fieldHit.groupValues[2].trim()
                    val fieldKey = AUTHOR_FIELD_BY_LABEL[fieldText.lowercase()]
                    if (fieldKey != null && rest.isNotEmpty()) {
                        body = rest
                        marks.add(Mark(0, rest.length, "author", fieldKey))
                    }
                } else {
                    /* `- Author: 整段内容` → 剥掉前缀，不产生 field */
                    val whole = AUTHOR_WHOLE_PREFIX.matchEntire(body)
                    if (whole != null) {
                        val rest = whole.groupValues[1].trim()
                        if (rest.isNotEmpty()) {
                            body = rest
                            marks.add(Mark(0, rest.length, "author", null))
                        }
                    }
                }
                any = true
            } else if (om != null) {
                kind = "reference"
                listMarker = "1. "
                body = om.groupValues[1].trim()
                /*
                  ⚠️ 文献前缀 `Ref: ` 剥掉（v0.2.23）——
                     它是条目标记而不是内容，留在正文里会显示成
                     `1. Ref: Ref: ...`（每导出一次多一个）。
                */
                val refWhole = REF_WHOLE_PREFIX.matchEntire(body)
                if (refWhole != null) {
                    val rest = refWhole.groupValues[1].trim()
                    if (rest.isNotEmpty()) body = rest
                }
                any = true
            } else if (text.isNotEmpty()) {
                any = true
            }

            /*
              ══ ⚠️⚠️ 还原列表项的**续行**（v0.1.93 修 bug）══

              serialize 把作者块的多行写成"同一列表项的续行"：

                  - Google Inc., Mountain View, CA …
                    tmikolov@google. com kaichen@google. com

              ✅ 这里把续行并回 `body`（用空格连接，与提取层一致），
                 同时保留 `rows` —— 渲染层靠它知道**原来在哪换行**，
                 加子标签时才不会把一行硬切成两段。

              ⚠️ **顺序至关重要**：注释里的 `start/end` 是相对
                 「所有行用空格连接后的整块文本」的（写的时候就是这么算的，
                 见 reader.js 的 buildMdText）。
                 所以必须先 `joinToString(" ")` 得到 `body`，再夹区间 ——
                 反过来会让区间全错位。

              ⚠️ 正文段落同样会走到这里（多行 → 并成一段），
                 那是排版折行，不是语义换行，合并是正确的。
            */
            val rawRows = body.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
            if (rawRows.size > 1) {
                body = rawRows.joinToString(" ")
            }

            /*
              ⚠️ 注释里的区间是相对**去掉记号后的正文**的（`body`），
                 而入库的 `text` 也是 `body` —— 两者天然对齐。
            */
            val safeMarks = marks.mapNotNull { m ->
                val a = m.start.coerceIn(0, body.length)
                val b = m.end.coerceIn(0, body.length)
                if (b <= a) null else m.copy(start = a, end = b)
            }

            blocks.add(
                Block(
                    line = blocks.size,
                    kind = kind,
                    level = level,
                    text = body,
                    /*
                      ⚠️ 用**合并前**的 `rawRows`，不是 `body`（v0.1.93）——
                         `body` 已经被空格连成一行了，拿它拆 `lines`
                         永远只有一条，等于把行边界又丢掉一次。
                         这正是"给第二行加子标签就多出换行"的根因。
                    */
                    lines = if (rawRows.size > 1) rawRows else emptyList(),
                    marks = safeMarks,
                    mdPrefix = mdPrefix,
                    listMarker = listMarker
                )
            )
        }
        return Parsed(blocks, any)
    }

    /**
     * `- Author <字段名>: <文本>` 的前缀（v0.2.22）。
     *
     * ⚠️ 第 1 组是字段名，第 2 组是正文。
     * ⚠️ 冒号后有空格（与写入侧一致），避免把 `Author Name:` 本身当内容。
     */
    private val AUTHOR_FIELD_PREFIX =
        Regex("^Author\\s+([A-Za-z]+)\\s*:\\s*(.+)$", RegexOption.IGNORE_CASE)

    /**
     * `- Author: <整段内容>` 的前缀（v0.2.23）。
     *
     * 作者区**没有**标注任何子标签时，整个作者区合成一条并带此前缀。
     *
     * ⚠️ 必须**在** `AUTHOR_FIELD_PREFIX 之后**匹配** ——
     *    否则 `Author Name: x` 会被这条先命中（`Name` 当成内容的一部分）。
     */
    private val AUTHOR_WHOLE_PREFIX =
        Regex("^Author\\s*:\\s*(.+)$", RegexOption.IGNORE_CASE)

    /**
     * `1. Ref: <文献内容>` 的前缀（v0.2.23）。
     *
     * ⚠️ 只剥 `Ref:`，不剥编号 —— 编号是 md 的有序列表记号。
     */
    private val REF_WHOLE_PREFIX =
        Regex("^Ref\\s*:\\s*(.+)$", RegexOption.IGNORE_CASE)

    /**
     * 字段名 → `author` 标注的 `field` 键。
     *
     * ⚠️ 键必须与 www/i18n.js 的 `reader.field.<键>` **一一对应**，
     *    也要与 reader.js 的 AUTHOR_FIELDS 一致。
     * ⚠️ 中英文都收：md 可能是任意一种语言写出来的，
     *    读回来都要认（用户可能换过界面语言）。
     */
    private val AUTHOR_FIELD_BY_LABEL: Map<String, String> = mapOf(
        "name" to "name",
        "affiliation" to "affiliation",
        "email" to "email",
        "contact" to "contact",
        "姓名" to "name",
        "单位" to "affiliation",
        "邮箱" to "email",
        "联系方式" to "contact"
    )

    /**
     * 从一块文本里剥掉注释，并把可识别的标注收集出来。
     *
     * ⚠️ 注释位置必须记录下来再剥离 —— 标注的 `start/end` 是相对
     *    **去掉注释后的正文**的，不是相对原始 md。
     */
    private fun stripAndCollectMarks(chunk: String, out: MutableList<Mark>): String {
        val re = Regex("<!--@([^>]*)-->")
        val sb = StringBuilder(chunk.length)
        var last = 0
        for (m in re.findAll(chunk)) {
            sb.append(chunk, last, m.range.first)
            last = m.range.last + 1
            decodeMark(m.groupValues[1], out)
        }
        sb.append(chunk, last, chunk.length)
        return sb.toString()
    }

    /**
     * `c:14-18=12` / `a:0-14=name` → Mark
     *
     * ⚠️ 任何格式不对都**静默忽略**，不能让一条坏注释毁掉整篇文档。
     */
    private fun decodeMark(spec: String, out: MutableList<Mark>) {
        val kind = spec.substringBefore(':', "")
        val rest = spec.substringAfter(':', "")
        if (kind.isEmpty() || rest.isEmpty()) return

        val rangePart = rest.substringBefore('=')
        val extra = rest.substringAfter('=', "")

        val a = rangePart.substringBefore('-').toIntOrNull() ?: return
        val b = rangePart.substringAfter('-', "").toIntOrNull() ?: return
        if (b <= a || a < 0) return

        when (kind) {
            "c" -> out.add(
                Mark(a, b, "cite", null, extra.toIntOrNull())
            )
            "a" -> out.add(
                Mark(a, b, "author", extra.ifEmpty { null }, null)
            )
            else -> Unit
        }
    }
}
