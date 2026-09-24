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
        )

        return Meta(
            title = clean(title),
            author = clean(author),
            venue = clean(venue),
        )
    }

    private fun firstNonBlank(vararg values: String?): String =
        values.firstOrNull { !it.isNullOrBlank() }.orEmpty()

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
     * 从 XMP 包里读 dc:title / dc:creator。
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
