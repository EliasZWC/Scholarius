package com.eliaszwc.scholarius

import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.InflaterInputStream

/**
 * 从 PDF 里提取正文文本，输出为 LaTeX 形式。
 *
 * ## 为什么不引第三方库
 *
 * PDFBox-Android 能正确提取文本，但会让 APK 增加约 5MB。
 * 我们自己只需要「读内容流 → 取 Tj/TJ 里的字符串」这一条路径，
 * 为此付 5MB 不划算。
 *
 * ## 实现路径
 *
 * ```
 * ① 扫全部 `stream ... endstream` 块
 * ② 尝试 FlateDecode（最常见）
 * ③ 在解压后的内容流里找文本定位操作符：
 *      (字符串) Tj
 *      [ ... ] TJ        （数组形式，元素间用数字表示间距）
 *      '  和  "          （换行 + 显示，少见）
 * ④ 把提取到的字符串按阅读顺序拼接
 * ```
 *
 * ## ⚠️ 已知局限（必须诚实记录，不要假装完整）
 *
 * **这是一个「尽力而为」的提取器，不是完整的 PDF 文本提取实现。**
 *
 * · **不处理字体编码映射（ToUnicode CMap）**。
 *   这是最大的局限：PDF 里的文本是按字形索引存的，要还原成
 *   Unicode 必须查字体的 ToUnicode 表。没有它，
 *   **中文、以及用了子集化字体的 PDF，提取出来的会是乱码。**
 *   本实现只对「ASCII / Latin-1 直接编码」的 PDF 可靠 ——
 *   也就是多数英文论文。
 *
 * · 不处理加密 PDF（直接失败，返回 null）。
 * · 不按坐标排序，依赖内容流本身的书写顺序 ——
 *   双栏排版可能串行（左栏一段、右栏一段交替）。
 * · 不处理 Type3 字体、不处理内嵌的 XObject Form。
 * · 不解析 PDF 对象之间的引用关系，直接全文扫 stream 块。
 *
 * ## 为什么输出 LaTeX 形式
 *
 * 用户要求「保存形式是 latex 形式」。当前实现做的是：
 * **把提取到的纯文本转义成 LaTeX 安全的形式**（`\` `$` `%` `&` 等转义），
 * 使它可以被直接放进 LaTeX 文档而不破坏语法。
 *
 * ⚠️ 这**不是**「把公式还原成 LaTeX 源码」——
 *    公式在 PDF 里是排版后的字形，还原成 `\frac{a}{b}` 需要
 *    识别数学布局，那是 OCR 级别的任务，本实现不做。
 */
object PdfText {

    private const val TAG = "Scholarius"

    /** 单个 PDF 最多提取多少字符，防止异常文件把内存吃爆 */
    private const val MAX_CHARS = 2_000_000

    /** 单个内容流解压后的上限，防 zip bomb */
    private const val MAX_STREAM_BYTES = 8 * 1024 * 1024

    /**
     * 提取正文。
     *
     * @return LaTeX 形式的文本；失败或无文本给 null
     */
    fun extract(pdf: File): String? {
        val bytes = try {
            pdf.readBytes()
        } catch (t: Throwable) {
            Log.w(TAG, "读取 PDF 失败", t)
            return null
        }

        val out = StringBuilder()

        try {
            forEachStream(bytes) { data ->
                if (out.length < MAX_CHARS) {
                    appendTextFromContentStream(data, out)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "提取文本失败", t)
        }

        val raw = out.toString().trim()
        if (raw.isEmpty()) {
            Log.i(TAG, "[reader] no text extracted")
            return null
        }

        val latex = toLatex(raw)
        Log.i(TAG, "[reader] extracted ${latex.length} chars")
        return latex
    }

    // -----------------------------------------------------------------------
    // 遍历 stream 块
    // -----------------------------------------------------------------------

    /**
     * 扫出所有 `stream ... endstream` 里的数据，逐个交给 [onStream]。
     *
     * ⚠️ 用「按字节找关键字」而不是解析 PDF 对象结构。
     *    正确做法应是解析 xref 表 → 对象 → 流；但那样要处理
     *    交叉引用流、对象流、增量更新等一堆格式变体，代码量大得多。
     *    直接扫 stream 关键字在实践中能覆盖绝大多数 PDF，
     *    代价是可能误命中二进制数据里恰好出现的 stream 字样 ——
     *    后续的内容流解析会滤掉那些假数据。
     */
    private inline fun forEachStream(bytes: ByteArray, onStream: (ByteArray) -> Unit) {
        val streamTag = "stream".toByteArray(Charsets.US_ASCII)
        val endTag = "endstream".toByteArray(Charsets.US_ASCII)

        var index = 0
        while (index < bytes.size) {
            val start = indexOf(bytes, streamTag, index)
            if (start < 0) break

            // `stream` 后面按规范应跟 CRLF 或 LF
            var dataStart = start + streamTag.size
            if (dataStart < bytes.size && bytes[dataStart] == 0x0D.toByte()) dataStart++
            if (dataStart < bytes.size && bytes[dataStart] == 0x0A.toByte()) dataStart++

            val end = indexOf(bytes, endTag, dataStart)
            if (end < 0) break

            // endstream 前通常有一个换行，去掉
            var dataEnd = end
            if (dataEnd > dataStart && bytes[dataEnd - 1] == 0x0A.toByte()) dataEnd--
            if (dataEnd > dataStart && bytes[dataEnd - 1] == 0x0D.toByte()) dataEnd--

            if (dataEnd > dataStart) {
                val slice = bytes.copyOfRange(dataStart, dataEnd)
                onStream(slice)
            }

            index = end + endTag.size
        }
    }

    /** 字节数组里找子序列，返回起始下标；找不到给 -1 */
    private fun indexOf(haystack: ByteArray, needle: ByteArray, from: Int): Int {
        if (needle.isEmpty() || from >= haystack.size) return -1
        val limit = haystack.size - needle.size
        var i = from
        outer@ while (i <= limit) {
            if (haystack[i] == needle[0]) {
                var j = 1
                while (j < needle.size) {
                    if (haystack[i + j] != needle[j]) {
                        i++
                        continue@outer
                    }
                    j++
                }
                return i
            }
            i++
        }
        return -1
    }

    // -----------------------------------------------------------------------
    // 内容流解析
    // -----------------------------------------------------------------------

    /**
     * 从一段内容流里抽文本。
     *
     * 先试直接解析；若解析不出内容，再试 FlateDecode 解压后解析。
     * （有些 PDF 的内容流是未压缩的，有些是 FlateDecode 的。）
     */
    private fun appendTextFromContentStream(data: ByteArray, out: StringBuilder) {
        if (out.length >= MAX_CHARS) return

        // 内容流通常是二进制里夹杂 ASCII 操作符。先按 Latin-1 看待。
        val direct = String(data, Charsets.ISO_8859_1)
        if (looksLikeContentStream(direct)) {
            appendFromOperators(direct, out)
        }

        // 再试解压
        if (out.length < MAX_CHARS) {
            val inflated = inflate(data)
            if (inflated != null) {
                val text = String(inflated, Charsets.ISO_8859_1)
                if (looksLikeContentStream(text)) {
                    appendFromOperators(text, out)
                }
            }
        }
    }

    /** 快速判断这段数据像不像内容流（含 PDF 文本操作符） */
    private fun looksLikeContentStream(s: String): Boolean =
        s.contains("Tj") || s.contains("TJ") || s.contains("BT")

    /**
     * 遍历内容流，抽出所有被 `Tj` / `TJ` / `'` / `"` 显示的字符串。
     *
     * 这是本实现的核心。做法是**扫描字符串字面量与十六进制串**，
     * 然后看它后面跟的是不是文本显示操作符。
     */
    private fun appendFromOperators(content: String, out: StringBuilder) {
        var i = 0
        val n = content.length

        while (i < n && out.length < MAX_CHARS) {
            val ch = content[i]

            when {
                // 字面量字符串：( ... )
                ch == '(' -> {
                    val parsed = readLiteralString(content, i)
                    if (parsed != null) {
                        i = parsed.nextIndex
                        /*
                          看它后面（跳过空白与数字/数组符号）是否是文本操作符。
                          若不是，说明这只是一个普通的 PDF 字符串参数
                          （比如 /Title (...)），不该收进正文。
                        */
                        if (isFollowedByTextOperator(content, i)) {
                            out.append(decodeLiteral(parsed.value))
                            out.append('\n')
                        }
                    } else {
                        i++
                    }
                }

                // 十六进制串：< ... >
                ch == '<' && i + 1 < n && content[i + 1] != '<' -> {
                    val parsed = readHexString(content, i)
                    if (parsed != null) {
                        i = parsed.nextIndex
                        if (isFollowedByTextOperator(content, i)) {
                            out.append(parsed.value)
                            out.append('\n')
                        }
                    } else {
                        i++
                    }
                }

                else -> i++
            }
        }
    }

    /**
     * 看位置 [from] 之后是否很快出现文本显示操作符。
     *
     * 文本操作符是 `Tj` / `TJ` / `'` / `"`。
     * `[...] TJ` 这种数组形式里，字符串后面先跟 `]` 再跟 `TJ`，
     * 所以跳过 `]`、空白、数字、标点。
     */
    private fun isFollowedByTextOperator(content: String, from: Int): Boolean {
        var i = from
        var skipped = 0
        while (i < content.length && skipped < 24) {
            val c = content[i]
            when {
                c.isWhitespace() || c == ']' || c == '[' -> {
                    i++
                    skipped++
                }
                c == '\'' || c == '"' -> return true
                // Tj / TJ
                c == 'T' -> {
                    val rest = content.substring(i, minOf(i + 3, content.length))
                    return rest.startsWith("Tj") || rest.startsWith("TJ")
                }
                else -> return false
            }
        }
        return false
    }

    /** 解析结果：值 + 下一个扫描位置 */
    private class Parsed(val value: String, val nextIndex: Int)

    /**
     * 读 `( ... )` 字面量字符串，处理转义与嵌套括号。
     *
     * 返回的 value 是**原始字节按 Latin-1 映射的字符串**
     * （PDF 字符串是字节，不是字符；编码要另外判断）。
     */
    private fun readLiteralString(content: String, start: Int): Parsed? {
        if (start >= content.length || content[start] != '(') return null

        val sb = StringBuilder()
        var i = start + 1
        var depth = 1
        // 转义字节收集：\ddd 是八进制码
        val octal = StringBuilder()

        while (i < content.length && depth > 0) {
            val ch = content[i]

            if (ch == '\\' && i + 1 < content.length) {
                val next = content[i + 1]
                when {
                    next in '0'..'7' -> {
                        // 最多三位八进制
                        octal.setLength(0)
                        var j = i + 1
                        var count = 0
                        while (j < content.length && count < 3 &&
                            content[j] in '0'..'7'
                        ) {
                            octal.append(content[j])
                            j++
                            count++
                        }
                        val code = octal.toString().toIntOrNull(8) ?: 0
                        sb.append(code.toChar())
                        i = j
                        continue
                    }
                    next == 'n' -> sb.append('\n')
                    next == 'r' -> sb.append('\r')
                    next == 't' -> sb.append('\t')
                    next == 'b' -> sb.append('\b')
                    next == 'f' -> sb.append('\u000C')
                    else -> sb.append(next)
                }
                i += 2
                continue
            }

            if (ch == '(') {
                depth++
                sb.append(ch)
                i++
                continue
            }
            if (ch == ')') {
                depth--
                if (depth > 0) sb.append(ch)
                i++
                continue
            }

            sb.append(ch)
            i++
        }

        return if (depth == 0) Parsed(sb.toString(), i) else null
    }

    /**
     * 读 `< ... >` 十六进制串。
     *
     * 解出来的字节若是 UTF-16BE（带 FEFF 前缀）或 ASCII，转成文本；
     * 否则丢弃（多为 CID 字体的字形索引，没有 ToUnicode 表无法还原）。
     */
    private fun readHexString(content: String, start: Int): Parsed? {
        val end = content.indexOf('>', start + 1)
        if (end < 0) return null

        val hex = content.substring(start + 1, end).replace(Regex("\\s"), "")
        if (hex.isEmpty() || hex.length % 2 != 0 || hex.length > 4096) {
            return Parsed("", end + 1)
        }

        return try {
            val bytes = ByteArray(hex.length / 2) { i ->
                hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
            }
            Parsed(decodeBytes(bytes), end + 1)
        } catch (t: Throwable) {
            Parsed("", end + 1)
        }
    }

    /** 字面量字符串（Latin-1 映射得到）→ 文本 */
    private fun decodeLiteral(value: String): String {
        if (value.isEmpty()) return ""
        val bytes = value.toByteArray(Charsets.ISO_8859_1)
        return decodeBytes(bytes)
    }

    /**
     * 字节 → 文本。
     *
     * ⚠️ 只能处理 UTF-16BE（带 BOM）与 ASCII/Latin-1。
     *    没有字体的 ToUnicode 表，CID 编码的文本无法还原 ——
     *    此时**返回空串而不是乱码**，宁可少一段内容，不要显示垃圾。
     */
    private fun decodeBytes(raw: ByteArray): String {
        if (raw.size >= 2 && raw[0] == 0xFE.toByte() && raw[1] == 0xFF.toByte()) {
            return String(raw, 2, raw.size - 2, Charsets.UTF_16BE)
        }

        // 全是可打印 ASCII + 常见空白 → 直接当 Latin-1
        var printable = 0
        var highBytes = 0
        for (b in raw) {
            val v = b.toInt() and 0xFF
            when {
                v == 0x09 || v == 0x0A || v == 0x0D -> printable++
                v in 0x20..0x7E -> printable++
                v >= 0x80 -> highBytes++
            }
        }
        // 高字节占比过大，多半是字形索引而非文本，丢弃
        if (raw.isNotEmpty() && highBytes > raw.size / 3) {
            return ""
        }
        return if (printable > 0) String(raw, Charsets.ISO_8859_1) else ""
    }

    /** FlateDecode 解压；失败给 null */
    private fun inflate(data: ByteArray): ByteArray? = try {
        InflaterInputStream(data.inputStream()).use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            var total = 0
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                total += read
                if (total > MAX_STREAM_BYTES) return null
                out.write(buffer, 0, read)
            }
            out.toByteArray()
        }
    } catch (t: Throwable) {
        null
    }

    // -----------------------------------------------------------------------
    // LaTeX 化
    // -----------------------------------------------------------------------

    /**
     * 把纯文本转成「可安全放进 LaTeX 文档」的形式。
     *
     * ⚠️ 做的是**转义**，不是**公式还原**。区别很重要：
     *
     * · 转义：把 `\` `{` `}` `$` `&` `%` `#` `_` `^` `~` 换成
     *   对应命令（`\textbackslash{}` 等），使文本不会破坏 LaTeX 语法。
     * · 公式还原：把 PDF 里排版好的 `a/b` 识别成 `\frac{a}{b}` ——
     *   这需要识别数学布局，**本实现不做**。
     *
     * 所以输出里的 `$` 会变成 `\$`，而不是被当作数学定界符。
     * 这样用户拿到的是一份**语法安全**的 LaTeX 文本，
     * 公式部分仍是原样的符号排列。
     */
    private fun toLatex(text: String): String {
        val sb = StringBuilder(text.length + text.length / 8)

        for (ch in text) {
            when (ch) {
                '\\' -> sb.append("\\textbackslash{}")
                '{' -> sb.append("\\{")
                '}' -> sb.append("\\}")
                '$' -> sb.append("\\$")
                '&' -> sb.append("\\&")
                '%' -> sb.append("\\%")
                '#' -> sb.append("\\#")
                '_' -> sb.append("\\_")
                '^' -> sb.append("\\textasciicircum{}")
                '~' -> sb.append("\\textasciitilde{}")
                /*
                  连字与特殊空白：LaTeX 里 `--` 会渲染成 en dash、
                  `---` 成 em dash。从 PDF 提取的文本里这些是普通字符，
                  要拆开以免被当成连字。
                */
                '-' -> sb.append("-\\/")
                else -> sb.append(ch)
            }
        }

        /*
          折叠过多空行：PDF 提取常产生一堆空行（每个 Tj 后我们都加了 \n）。
          最多保留一个空行，否则正文会变得极长且难读。
        */
        return sb.toString()
            .replace(Regex("[ \\t]+\\n"), "\n")
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()
    }
}
