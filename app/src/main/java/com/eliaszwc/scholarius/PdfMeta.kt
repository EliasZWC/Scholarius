package com.eliaszwc.scholarius

import android.util.Log
import java.io.File
import java.util.zip.InflaterInputStream

/**
 * 从 PDF 里尽力提取标题 / 作者 / 发表物。
 *
 * ## 为什么自己写而不引库
 *
 * 常用选择是 PDFBox-Android，但它会让 APK 增加约 5MB —— 而我们只需要
 * 读 `/Info` 字典里三个字符串字段，为此付 5MB 不划算。
 *
 * ## 提取策略（逐层降级）
 *
 * ```
 * ① PDF 的 /Info 字典        ← 最可靠，但很多学术 PDF 是空的
 * ② XMP 元数据（dc:title 等） ← 学术 PDF 常见，出版社自动生成
 * ③ 首页文本的前几行         ← 纯猜，容易抽到页眉/期刊名
 * ④ 文件名                  ← 兜底
 * ```
 *
 * ## 已知局限（必须诚实记录）
 *
 * · **只处理未压缩或 FlateDecode 的流**。其他过滤器（LZW、JPX 等）跳过。
 * · **不解析交叉引用表**，直接全文扫。所以对大文件会有多余扫描 ——
 *   但只在导入时跑一次，可接受。
 * · 中文 PDF 的 `/Info` 常用 UTF-16BE 带 BOM，也有用 PDFDocEncoding
 *   或 GBK 的。这里处理 UTF-16 与 Latin-1 两种，**GBK 会乱码**。
 *   → 这种情况退回文件名，不显示乱码。宁可没有，不要难看。
 */
object PdfMeta {

    private const val TAG = "Scholarius"

    data class Meta(
        val title: String = "",
        val author: String = "",
        val venue: String = "",
        /**
         * 发表年份，如 `2015`。**取不到就是空串，绝不猜。**
         *
         * ⚠️ 用 String 而不是 Int：空值与「真的第 0 年」要能区分，
         *    且这个值直接进 JSON 给前端显示，不需要做数值运算。
         *    前端拿到空串就留白。
         */
        val year: String = "",
        /**
         * 按类别细分的元数据（DOI / 卷 / 期 / 页码 / 出版社 …）。
         *
         * ⚠️ **只放真有值的键**。空值不存 —— 与 LibraryStore.parseFields
         *    同一套约定，索引里不堆 `"doi": ""` 这种无意义键。
         *
         * ⚠️ 键名必须与前端 `meta.js` 的字段表一致。
         *    这里抓不到的字段（ISBN、会议缩写、报告编号…）压根不出现，
         *    等用户在详情弹窗里手填。
         */
        val fields: Map<String, String> = emptyMap(),
    )

    /** 单个字段的最大长度，防止把整段正文当标题 */
    private const val MAX_FIELD_LEN = 300

    fun extract(pdf: File, displayName: String): Meta {
        val bytes = try {
            pdf.readBytes()
        } catch (t: Throwable) {
            Log.w(TAG, "读取 PDF 失败", t)
            return Meta()
        }

        val info = try {
            readInfoDict(bytes)
        } catch (t: Throwable) {
            Log.w(TAG, "解析 /Info 失败", t)
            emptyMap()
        }

        val xmp = try {
            readXmp(bytes)
        } catch (t: Throwable) {
            Log.w(TAG, "解析 XMP 失败", t)
            Meta()
        }

        // 逐层降级：Info → XMP → 文件名
        val title = firstNonBlank(
            info["Title"],
            xmp.title,
        )
        val author = firstNonBlank(
            info["Author"],
            xmp.author,
        )
        // 发表物没有标准字段，各家出版社埋在不同地方，尽力而为
        val venue = firstNonBlank(
            info["Subject"],
            xmp.venue,
            info["Keywords"],
        )

        return Meta(
            title = clean(title),
            author = clean(author),
            venue = cleanVenue(venue),
            year = extractYear(xmp.year, info),
        )
    }

    // -----------------------------------------------------------------------
    // 发表年份
    // -----------------------------------------------------------------------

    /** 年份的合理区间。下界 1850 = 现代学术出版起点；上界 = 当前年 + 1 */
    private const val YEAR_MIN = 1850

    /**
     * 用于年份上界校验。
     *
     * ⚠️ 用 `java.time.Year` 而不是硬编码 —— 硬编码的年份过一年就过期，
     *    会把新论文的年份误判为不合理。需要 API 26（本项目 minSdk 26，OK）。
     */
    private val CURRENT_YEAR: Int = java.time.Year.now().value

    /**
     * 年份的来源，按**可靠性从高到低**尝试，任一命中即返回。
     *
     * ```
     * ① XMP 的 prism:publicationDate / dc:date    ← 出版方写的，最可信
     * ② /Info 的 Subject / Keywords 里的可信年份   ← 次要，见 extractYearFromInfo
     * ③ 都不中就留空
     * ```
     *
     * ══ 实测命中率（12 篇真实论文集，见 tools/check-year.py）══
     *
     * ```
     *   正确 2 篇  ·  错误 0 篇  ·  留空 6 篇  ·  文件名无年份 4 篇
     * ```
     *
     * **命中率低是数据源的客观限制，不是实现缺陷。**
     * 这批 arXiv/会议 PDF 里：
     *   · 11/12 篇**根本没有 XMP 包**
     *   · `Subject` 多是 "Neural Information Processing Systems http…"
     *     或 HAL 的学科分类，**不含年份**
     *   · 真正的年份（`© 2015`、`CVPR 2016`）都在**压缩的正文流**里
     *
     * 命中的 2 篇都是同一形态：`Subject` = "2016 IEEE Conference on
     * Computer Vision and Pattern Recognition" —— 出版社把年份写进了
     * Subject 开头。
     *
     * ══ 为什么**刻意不用** /Info 的 CreationDate ══
     *
     * ⚠️ `CreationDate` 是「**这个 PDF 文件什么时候生成的**」，
     *    不是论文发表年。**实测证据（这条最重要）**：
     *
     *       · LeCun《Deep learning》(Nature 2015)
     *             CreationDate = **2026-03-16**（就是抓取当天）
     *             → 用它会显示 2026，而论文是 2015 年的
     *       · Rumelhart《反向传播》(Nature 1986)
     *             CreationDate = 2004
     *             → 相差 18 年
     *
     *    宁可留空让用户手填，也不要显示一个**看起来很像真的**错年份 ——
     *    错年份比空值更误导，因为用户不会去核对。
     *    同理不使用 `ModDate`。
     *
     * ══ 为什么不从**首页正文**抓 ══
     *
     * 首页年份最丰富（`© 2015 IEEE`、`CVPR 2016`），但正文在 PDF 里是
     * **压缩过的内容流**（通常 FlateDecode）。要读它必须先解压，
     * 而 `PdfMeta` 的定位是「只扫元数据、不解压」——
     *    解压是 `PdfText` 的职责，且它已经在导入时跑过一次。
     *
     * ══ 为什么不加「ACL / DOI 编码推年份」的规则 ══
     *
     * 实测 BERT 那篇的 DOI 是 `10.18653/v1/S17-2001`，
     * 其中 `S17` 按 ACL Anthology 的编码规则确实是 2017 年。
     * **但收益与风险不成比例，刻意不加：**
     *
     *   · 收益：只能多救 1 篇（12 篇里的 1 篇）
     *   · 风险：`[A-Z]\d{2}-\d{4}` 这个形态在学术 PDF 里到处都是
     *           （标准号、专利号、产品型号、ISO 编号），
     *           误判一次就是**错的年份**，而错年份是最坏结果
     *   · 本质：这是**领域特例**，不是通用规律
     *
     * 同样不加「裸的 4 位数字」规则 —— 参考文献、DOI、页码里全是年份。
     *
     * 因此这里只做**元数据层面**的尽力而为：取不到就留空。
     * 用户后续可以手改（`year` 是独立字段，改它不影响别的）。
     *
     * @param xmpYear  XMP 里取到的年份（可能为空）
     * @param info     `/Info` 字典（用于 ② 的兜底）
     */
    private fun extractYear(xmpYear: String, info: Map<String, String>): String {
        if (xmpYear.isNotBlank()) return xmpYear
        return extractYearFromInfo(info)
    }

    /**
     * 从 `/Info` 的 `Subject` / `Keywords` 里捞年份。
     *
     * ⚠️ 只认「年份紧邻出版方 / 会议名」的形态，裸年份一律不取。
     *
     * 实测数据（本地 12 篇论文集）：
     *
     *   `Subject` = "2016 IEEE Conference on Computer Vision and Pattern Recognition"
     *        → 命中 `2016 IEEE`，正确
     *
     *   `Subject` = "N19-1 2019"
     *        → 这是 ACL 的论文编号；`2019` 虽然是对的，
     *          但它**紧邻的是编号不是出版方**，按规则不取 → 留空。
     *          宁可空着等用户填，也不建立「编号后面跟数字就是年份」这种
     *          会到处误伤的规则。
     *
     *   `Subject` = "Computer Science [cs]/Artificial Intelligence"
     *        → 无年份，留空
     */
    private fun extractYearFromInfo(info: Map<String, String>): String {
        val haystack = listOf(info["Subject"], info["Keywords"])
            .filterNotNull()
            .joinToString(" ")
        if (haystack.isBlank()) return ""

        /*
          ⚠️ 顺序即优先级。两条都要求年份与「强特征」相邻。
        */
        val patterns = listOf(
            // 2015 IEEE / 2016 ACM / 2015 Springer —— 年份 + 出版方
            Regex(
                """\b((?:19|20)\d{2})\s+(?:IEEE|ACM|Springer|Elsevier|Wiley|Cambridge|Oxford|MIT Press)\b""",
                RegexOption.IGNORE_CASE
            ),
            // CVPR 2016 / ICML 2015 / NeurIPS 2017 —— 会议缩写 + 年份
            Regex(
                """\b(?:CVPR|ICCV|ECCV|ICML|ICLR|NIPS|NeurIPS|ACL|EMNLP|NAACL|AAAI|IJCAI|SIGIR|KDD|WWW|ICDM|CIKM)""" +
                    """[\s'’]*((?:19|20)\d{2})\b""",
                RegexOption.IGNORE_CASE
            ),
            // © 2015 / (c) 2015 / Copyright 2015 —— 版权年
            Regex(
                """(?:©|\(c\)|copyright)[^\n]{0,24}?\b((?:19|20)\d{2})\b""",
                RegexOption.IGNORE_CASE
            ),
        )

        for (p in patterns) {
            val y = p.find(haystack)?.groupValues?.get(1)
            if (y != null && isPlausibleYear(y)) return y
        }
        return ""
    }

    /**
     * 年份是否落在合理区间。
     *
     * ⚠️ 必须校验，否则这些会被当成发表年：
     *    · `© 1899`（版权行里的旧日期，可能是原作者生年）
     *    · OCR / 排版噪音出来的 `2099`、`9999`
     */
    private fun isPlausibleYear(year: String): Boolean {
        val n = year.toIntOrNull() ?: return false
        return n in YEAR_MIN..(CURRENT_YEAR + 1)
    }

    /**
     * 从 XMP 里读年份。
     *
     * 三个来源按可信度排序：
     *   · `prism:publicationDate` —— 出版方显式声明，最准
     *   · `dc:date`               —— 标准 Dublin Core 日期，可能是完整时间戳
     *   · `xmp:CreateDate`        —— **最后手段**，语义同 PDF 的 CreationDate
     *                                （文件生成时间），只在前面都缺失时才用
     *
     * ⚠️ 三者拿到的都可能带时间，统一剥出 4 位年份。
     */
    private fun readXmpYear(xmp: String): String {
        /*
          ⚠️ firstOrNull 返回的是 `String?`（列表里可能一条都不匹配），
             extractFourDigitYear 收非空 String —— 直接传会编译不过
             （CI 实测：`actual type is 'kotlin.String?',
              but 'kotlin.String' was expected`）。

             所以这里补 `?: ""`，把 null 归一成空串。
             "" 对 extractFourDigitYear 是合法的（它找不到年份就返回 ""），
             语义也正是想要的「这一路没取到」。
        */
        val raw = listOf(
            readXmpValue(xmp, "prism:publicationDate"),
            readXmpValue(xmp, "dc:date"),
        ).firstOrNull { it.isNotBlank() } ?: ""

        val year = extractFourDigitYear(raw)
        if (year.isNotBlank()) return year

        // 兜底：xmp:CreateDate（可信度低，仅在无其它信息时用）
        val created = readXmpValue(xmp, "xmp:CreateDate")
        return extractFourDigitYear(created)
    }

    /**
     * 从任意日期串里剥出 4 位年份。
     *
     * 支持的输入形态（实测常见）：
     *   `2015`                  纯年份
     *   `2015-08-20`            ISO 日期
     *   `2015-08-20T10:30:00Z`  ISO 时间戳
     *   `D:20150820103000+08'00'`  PDF 的日期格式
     */
    private fun extractFourDigitYear(value: String): String {
        if (value.isBlank()) return ""
        val m = Regex("""\b((?:19|20)\d{2})\b""").find(value) ?: return ""
        val year = m.groupValues[1]
        return if (isPlausibleYear(year)) year else ""
    }

    private fun firstNonBlank(vararg values: String?): String =
        values.firstOrNull { !it.isNullOrBlank() }.orEmpty()

    /**
     * 清理「发表载体」字段：去 URL、剥离学科分类、拒绝明显不是载体的内容。
     *
     * ══ 为什么需要（v0.1.5，用真实论文测出来的）══
     *
     * ⚠️ 术语：这个字段叫 venue（发表载体），**不叫期刊**。
     *    它可能是会议、预印本（arXiv）、专著、学位论文、技术报告……
     *    实测 12 篇本地论文里就有会议（CVPR/NIPS/ICML）与 Nature 两种形态。
     *    所以判据不能假设它是期刊名。
     *
     * venue 只能从 PDF 的 `Subject` / `Keywords` 里猜，而各家出版社
     * 往这两个字段里塞的东西五花八门。实测：
     *
     *   Nature 2015  `Subject` = "Computer Science [cs]/Artificial Intelligence
     *                           [cs.AI], Computer Science [cs]/Neural and
     *                           Evolutionary Computing [cs.NE]"
     *                → HAL 的**学科分类**，不是载体
     *
     *   Transformer  `Subject` = "Neural Information Processing Systems
     *                           http://nips.cc/"
     *                → 正确，但尾巴拖了个网址
     *
     *   ResNet       `Subject` = "2016 IEEE Conference on Computer Vision
     *                           and Pattern Recognition"
     *                → 完全正确，必须原样保留
     *
     *   BERT         `Subject` = "N19-1 2019"
     *                → ACL Anthology 的**卷期号碎片**，是噪声
     *
     * 所以不能简单地「有就用」或「一律丢弃」，要清理 + 判断。
     */
    private fun cleanVenue(value: String): String {
        var s = clean(value)
        if (s.isEmpty()) return ""

        // ① 去掉网址（含 http:// https:// www. 以及裸域名）
        s = s.replace(Regex("https?://\\S+"), " ")
        s = s.replace(Regex("\\bwww\\.\\S+"), " ")
        // 独立成词的裸域名，如 "nips.cc/" / "ieee.org"
        s = s.replace(Regex("\\s+[A-Za-z0-9-]+\\.[A-Za-z]{2,6}/?(?=\\s|$)"), " ")
        s = s.replace(Regex("\\s+"), " ").trim().trimEnd(',', ';', '/').trim()

        /*
          ② 拒绝学科分类串。

          HAL / arXiv 之类的 `Subject` 是形如
              "Computer Science [cs]/Artificial Intelligence [cs.AI], ..."
          的特征：含方括号缩写、含斜杠分级、逗号分隔多项。
          这类内容对用户没有意义（他搜的是标题/作者），
          显示出来只会把列表行撑爆。
        */
        val categoryHits = Regex("\\[[a-zA-Z]{2}\\.[A-Za-z]{2,4}]").findAll(s).count()
        if (categoryHits >= 1) return ""
        if (s.count { it == '/' } >= 2 && s.count { it == ',' } >= 1) return ""

        /*
          ③ 拒绝卷期号/编号碎片。

          ⚠️ 实测（BERT 的 ACL Anthology 版）：
                 `Subject` = "N19-1 2019"
             这是个会议论文编号 + 年份，既不是载体名也不是任何
             对用户有用的东西。它的特征：几乎没有小写字母，
             只有大写字母、数字、连字符和空格。

          判据：**去掉数字与常见分隔符后，剩下的字母少于 3 个**
                → 说明主体是编号而不是名称。
                这样 "N19-1 2019"（剩下 "N"）会被拦掉，
                而 "CVPR 2016"（剩下 "CVPR"）会保留。
        */
        val lettersOnly = s.replace(Regex("[^A-Za-z\\u4e00-\\u9fff]"), "")
        if (lettersOnly.length < 3) return ""

        /*
          ④ 太长的一律丢弃。
             真载体名几乎不会超过 80 字符；
             超长基本是分类串或摘要片段。
        */
        if (s.length > MAX_VENUE_LEN) return ""

        return s
    }

    /** venue 长度上限。超过视为分类串/摘要碎片，丢弃 */
    private const val MAX_VENUE_LEN = 80

    /** 去掉控制字符、压缩空白；过长则截断 */
    private fun clean(value: String): String {
        val filtered = value
            .filter { it == '\n' || it == ' ' || !it.isISOControl() }
            .replace(Regex("\\s+"), " ")
            .trim()
        return if (filtered.length > MAX_FIELD_LEN) {
            filtered.substring(0, MAX_FIELD_LEN)
        } else {
            filtered
        }
    }

    // -----------------------------------------------------------------------
    // /Info 字典
    // -----------------------------------------------------------------------

    /**
     * 扫出 PDF 的 `/Info` 字典，返回字段名 → 值。
     *
     * 做法：找到 `trailer` 里的 `/Info N 0 R`，再从全文找 `N 0 obj`。
     * 找不到 trailer 就退化为「扫全文所有 `/Title(...)`」—— 会误命中
     * 其它字典里的同名字段，但实践中 Info 通常是最先出现的那个。
     */
    private fun readInfoDict(bytes: ByteArray): Map<String, String> {
        val text = latin1(bytes)

        // 先试精确定位 trailer → /Info → 该 object
        val infoObjNum = Regex("/Info\\s+(\\d+)\\s+\\d+\\s+R")
            .find(text)?.groupValues?.get(1)

        val scope = if (infoObjNum != null) {
            val m = Regex("(?m)^\\s*$infoObjNum\\s+0\\s+obj\\b").find(text)
            if (m != null) {
                // 只在这个 object 到 endobj 之间找，避免误命中别处
                val start = m.range.last
                val end = text.indexOf("endobj", start).takeIf { it > 0 } ?: text.length
                text.substring(start, minOf(end, start + 20000))
            } else {
                text
            }
        } else {
            text
        }

        val result = mutableMapOf<String, String>()
        for (field in listOf("Title", "Author", "Subject", "Keywords")) {
            parseField(scope, field)?.let { result[field] = it }
        }
        return result
    }

    /**
     * 解析 `/Field` 的值，支持三种写法：
     *
     * ```
     * /Title (plain text)              ← 直接字面量
     * /Title <FEFF0041...>             ← 十六进制（多为 UTF-16BE 带 BOM）
     * ```
     *
     * 嵌套括号的字面量按 PDF 规范要转义（`\(` `\)`），这里也处理。
     */
    private fun parseField(scope: String, field: String): String? {
        // 十六进制形式
        val hexRe = Regex("/$field\\s*<([0-9A-Fa-f\\s]+)>")
        hexRe.find(scope)?.let { m ->
            val hex = m.groupValues[1].replace(Regex("\\s"), "")
            decodeHexString(hex)?.takeIf { it.isNotBlank() }?.let { return it }
        }

        // 字面量形式（要处理嵌套与转义括号）
        val litStart = Regex("/$field\\s*\\(").find(scope) ?: return null
        var index = litStart.range.last + 1
        val out = StringBuilder()
        var depth = 1

        while (index < scope.length && depth > 0) {
            val ch = scope[index]
            when {
                ch == '\\' && index + 1 < scope.length -> {
                    // 转义序列：常见的是 \( \) \\ \n \r \t
                    val next = scope[index + 1]
                    when (next) {
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        else -> out.append(next)
                    }
                    index += 2
                }
                ch == '(' -> {
                    depth++
                    out.append(ch)
                    index++
                }
                ch == ')' -> {
                    depth--
                    if (depth > 0) out.append(ch)
                    index++
                }
                else -> {
                    out.append(ch)
                    index++
                }
            }
        }

        return decodeLiteral(out.toString())
    }

    /**
     * 十六进制字符串 → 文本。
     * 有 `FEFF` 前缀说明是 UTF-16BE，否则按 Latin-1。
     */
    private fun decodeHexString(hex: String): String? {
        if (hex.length < 2) return null
        return try {
            val raw = ByteArray(hex.length / 2) { i ->
                hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
            }
            decodeBytes(raw)
        } catch (t: Throwable) {
            null
        }
    }

    /** 字面量：可能是 UTF-16BE（带 BOM）或单字节编码 */
    private fun decodeLiteral(value: String): String? {
        if (value.isEmpty()) return null
        val raw = value.toByteArray(Charsets.ISO_8859_1)
        return decodeBytes(raw)
    }

    /**
     * 字节 → 字符串。
     *
     * · 以 `FE FF` 开头 → UTF-16BE
     * · 以 `EF BB BF` 开头 → UTF-8
     * · 全为可打印 ASCII/Latin-1 → 直接当 Latin-1
     * · 其余（如 GBK 中文）→ **返回 null，让调用方退回文件名**
     *   宁可没有标题，也不要显示乱码
     */
    private fun decodeBytes(raw: ByteArray): String? {
        if (raw.size >= 2 && raw[0] == 0xFE.toByte() && raw[1] == 0xFF.toByte()) {
            return String(raw, 2, raw.size - 2, Charsets.UTF_16BE)
        }
        if (raw.size >= 3 && raw[0] == 0xEF.toByte() && raw[1] == 0xBB.toByte() &&
            raw[2] == 0xBF.toByte()
        ) {
            return String(raw, 3, raw.size - 3, Charsets.UTF_8)
        }

        val asLatin1 = String(raw, Charsets.ISO_8859_1)
        // Latin-1 范围内 0x80-0x9F 是控制区，出现说明不是 Latin-1 文本
        val hasC1Control = raw.any { (it.toInt() and 0xFF) in 0x80..0x9F }
        return if (hasC1Control) null else asLatin1
    }

    // -----------------------------------------------------------------------
    // XMP
    // -----------------------------------------------------------------------

    /**
     * 从 XMP 包里读 dc:title / dc:creator / dc:source / 发表年份。
     *
     * XMP 是固定的 XML 包，用正则比引 XML 解析器简单得多 ——
     * 而且 XMP 里嵌套结构复杂（rdf:Bag/rdf:li），解析器反而更难写对。
     */
    private fun readXmp(bytes: ByteArray): Meta {
        val raw = latin1(bytes)
        val start = raw.indexOf("<x:xmpmeta")
        if (start < 0) return Meta()
        val end = raw.indexOf("</x:xmpmeta>", start)
        val xmp = if (end > 0) raw.substring(start, end + 12) else raw.substring(start)

        return Meta(
            title = readXmpValue(xmp, "dc:title"),
            author = readXmpValue(xmp, "dc:creator"),
            venue = readXmpValue(xmp, "dc:source"),
            year = readXmpYear(xmp),
        )
    }

    /** 取 `dc:title` 下第一个 `<rdf:li>` 的文本；也兼容属性形式 */
    private fun readXmpValue(xmp: String, tag: String): String {
        val escaped = Regex.escape(tag)

        // <dc:title><rdf:Alt><rdf:li ...>值</rdf:li>
        Regex("<$escaped[^>]*>.*?<rdf:li[^>]*>(.*?)</rdf:li>", RegexOption.DOT_MATCHES_ALL)
            .find(xmp)?.groupValues?.get(1)
            ?.let { decodeXmlEntities(it)?.takeIf { s -> s.isNotBlank() } }
            ?.let { return it }

        // 属性形式：<rdf:Description dc:title="值">
        Regex("$escaped\\s*=\\s*\"([^\"]*)\"")
            .find(xmp)?.groupValues?.get(1)
            ?.let { decodeXmlEntities(it)?.takeIf { s -> s.isNotBlank() } }
            ?.let { return it }

        return ""
    }

    private fun decodeXmlEntities(value: String): String = value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .trim()

    // -----------------------------------------------------------------------

    /**
     * 字节数组按 Latin-1 转字符串。
     *
     * ⚠️ 这是**为了扫描结构用的**，不是为了得到正确文本 ——
     *    PDF 的语法标记（`/Title`、`obj`、`<<`）都是 ASCII，
     *    按 Latin-1 逐字节映射能保证「字节位置 = 字符位置」，
     *    不会因为多字节字符导致偏移错乱。
     *    真正的文本解码在 decodeBytes() 里做。
     */
    private fun latin1(bytes: ByteArray): String = String(bytes, Charsets.ISO_8859_1)

    /**
     * 尝试解压 FlateDecode 流。当前未使用（首页文本提取需要它），
     * 保留给后续「从正文猜标题」的实现。
     */
    @Suppress("unused")
    private fun inflate(data: ByteArray): ByteArray? = try {
        InflaterInputStream(data.inputStream()).use { it.readBytes() }
    } catch (t: Throwable) {
        null
    }
}
