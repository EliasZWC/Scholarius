package com.eliaszwc.scholarius

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 排版模板（v0.2.5）。
 *
 * ## 模板是什么
 *
 * 一个 `.json` 文件，记录「某一份 PDF 的块序列该怎么解释」：
 * 哪些块是标题、哪些是正文、哪些要拆开或丢弃，以及渲染样式。
 *
 * ## ⚠️⚠️ 绝对不包含原文
 *
 * 这是**法律要求**，也是整个设计的前提。模板里只允许出现：
 *
 *   · `source.sha256`  —— 整份 PDF 的哈希（单向，无法还原内容）
 *   · 块「序号」        —— 整数
 *   · 块「角色」        —— 枚举（title / body / heading …）
 *   · 编辑「位置」      —— 拆分点字符偏移，整数
 *   · 样式值            —— CSS 属性
 *
 * 禁止出现：任何块文本、任何原文片段、文本前缀/后缀、
 * 关键词、"摘要第一句"这类可推断内容的东西。
 *
 * 为什么：模板要公开发布（用户可以分享自己调好的排版）。
 * 一旦带了原文，就从「排版规则」变成「论文副本」，直接侵权。
 * 而只要全是数值，「拿到模板也无法还原论文」—— 这是可验证的：
 * 任何人打开这个 JSON 都能确认里面没有原文，才敢用。
 *
 * ## 为什么绑定 PDF 哈希
 *
 * 用户裁决（原话）：
 *   「只需要pdf相同就可以了，如果是不同版本的pdf，比如预印版
 *     和期刊版，不需要全覆盖，只需要对应相应的pdf就可以了」
 *
 * 同一篇论文的预印版与期刊版块结构完全不同，共用一个模板必然套错。
 * 而标题/文件名不可靠（用户会改名、PDF 元数据常为空），
 * 内容哈希是唯一能确定"就是这份文件"的判据。
 *
 * ## 文件位置
 *
 * ```
 * filesDir/templates/&lt;templateId&gt;.json     用户导入/保存的模板
 * assets/templates/&lt;name&gt;.json            内置模板（随 APK）
 * ```
 *
 * 一个模板一个文件：删除、拷贝、审阅都简单，和文献库同一套思路。
 */
object TemplateStore {

    private const val TAG = "Scholarius"

    private const val TEMPLATE_DIR = "templates"
    private const val ASSET_DIR = "templates"

    /** 模板文件大小上限。正常模板只有几 KB，2 MB 已经极宽松 */
    private const val MAX_BYTES = 2 * 1024 * 1024

    /** 当前支持的 schema 版本 */
    private const val SCHEMA = 1

    /**
     * 一个块的角色。
     *
     * ⚠️ 用字符串枚举而不是 Kotlin enum：这些值要原样写进 JSON
     *    并与网页侧共用。enum 需要额外的序列化映射，
     *    而且网页拿到的是字符串，多一层转换没有收益。
     */
    object Role {
        const val TITLE = "title"
        const val AUTHOR = "author"
        const val ABSTRACT = "abstract"
        const val HEADING = "heading"
        const val BODY = "body"
        const val CAPTION = "caption"
        const val REFERENCE = "reference"
        const val FORMULA = "formula"
        /** 丢弃该块（页眉页脚、页码、水印） */
        const val DROP = "drop"

        val ALL = setOf(
            TITLE, AUTHOR, ABSTRACT, HEADING, BODY,
            CAPTION, REFERENCE, FORMULA, DROP
        )
    }

    /**
     * 一个块的指定。
     *
     * @param index PDF 块序号（0 起，与 PdfText 提取顺序一致）
     * @param role  [Role] 之一
     * @param level 标题层级，1 起；非标题为 0
     */
    data class BlockSpec(
        val index: Int,
        val role: String,
        val level: Int = 0,
    )

    /**
     * 一个编辑操作。同样只含数值。
     */
    sealed class Op {
        /** 把连续的几个块合并成一个正文段 */
        data class Merge(val blocks: List<Int>) : Op()

        /** 在某个块的第 [at] 个字符处拆成两段 */
        data class Split(val block: Int, val at: Int) : Op()

        /** 丢弃若干块 */
        data class Drop(val blocks: List<Int>) : Op()

        /** 把 [from] 块移到 [to] 位置之前 */
        data class Reorder(val from: Int, val to: Int) : Op()
    }

    /**
     * 一个模板。
     *
     * @param id         模板自己的 id（`tpl-` 前缀 + 8 位十六进制）
     * @param pdfSha256  绑定的 PDF 的 SHA-256
     * @param blockCount 母本 PDF 的块数。用于检测提取器变更：
     *                   实际块数与之不符时，说明块切法变了，
     *                   按序号套用会错位（此时给用户提示）。
     */
    data class Template(
        val id: String,
        val name: String,
        val author: String,
        val license: String,
        val pdfSha256: String,
        val pdfSize: Long,
        val pdfPages: Int,
        val blockCount: Int,
        val extractor: String,
        val blocks: List<BlockSpec>,
        val ops: List<Op>,
        val style: Map<String, String>,
    ) {
        /** 该模板是否适用于这份 PDF */
        fun matches(sha256: String): Boolean =
            sha256.isNotBlank() && pdfSha256.equals(sha256, ignoreCase = true)
    }

    // -----------------------------------------------------------------------
    // 路径
    // -----------------------------------------------------------------------

    fun templateDir(context: Context): File =
        File(context.filesDir, TEMPLATE_DIR).apply { mkdirs() }

    fun templateFile(context: Context, id: String): File =
        File(templateDir(context), sanitiseId(id) + ".json")

    /**
     * 把 id 限制成安全文件名。
     *
     * ⚠️ 必须做：`id` 来自用户导入的 JSON 文件内容，
     *    这是**不可信输入**。不校验就能用 `../../` 写出模板目录
     *    （路径穿越），直接覆盖别的应用数据。
     */
    private fun sanitiseId(raw: String): String {
        val cleaned = raw.replace(Regex("[^A-Za-z0-9._-]"), "")
        return cleaned.take(64).ifBlank { "template" }
    }

    // -----------------------------------------------------------------------
    // 列表
    // -----------------------------------------------------------------------

    /**
     * 列出所有可用模板（用户目录 + APK 内置）。
     *
     * ⚠️ 用户模板**优先**：同 id 时覆盖内置的，
     *    这样用户能修改内置模板而不必改 APK。
     * ⚠️ 解析失败的模板**静默跳过**，不中断整个列表 ——
     *    一个坏文件不该让所有模板都用不了。
     */
    fun list(context: Context): List<Template> {
        val out = LinkedHashMap<String, Template>()

        // ① 内置
        try {
            context.assets.list(ASSET_DIR)?.forEach { name ->
                if (!name.endsWith(".json")) return@forEach
                try {
                    val text = context.assets.open("$ASSET_DIR/$name")
                        .bufferedReader().use { it.readText() }
                    val t = parse(text) ?: return@forEach
                    out[t.id] = t
                } catch (t: Throwable) {
                    Log.w(TAG, "内置模板读取失败：$name", t)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "内置模板目录不可用", t)
        }

        // ② 用户目录（覆盖同名 id）
        templateDir(context).listFiles()?.forEach { f ->
            if (!f.isFile || !f.name.endsWith(".json")) return@forEach
            try {
                if (f.length() > MAX_BYTES) {
                    Log.w(TAG, "模板过大，跳过：${f.name}")
                    return@forEach
                }
                val t = parse(f.readText()) ?: return@forEach
                out[t.id] = t
            } catch (e: Throwable) {
                Log.w(TAG, "模板解析失败：${f.name}", e)
            }
        }

        return out.values.toList()
    }

    /**
     * 找出适用于该 PDF 的模板。
     *
     * ⚠️ 可能返回多个（同一份 PDF 的精校版/极简版），
     *    由用户选择；调用方不应假设唯一。
     */
    fun findFor(context: Context, sha256: String): List<Template> {
        if (sha256.isBlank()) return emptyList()
        return list(context).filter { it.matches(sha256) }
    }

    fun get(context: Context, id: String): Template? {
        // 先看用户目录（可能覆盖内置）
        val f = templateFile(context, id)
        if (f.exists()) {
            return try {
                parse(f.readText())
            } catch (e: Throwable) {
                Log.w(TAG, "模板读取失败：$id", e)
                null
            }
        }
        return list(context).firstOrNull { it.id == id }
    }

    // -----------------------------------------------------------------------
    // 保存 / 删除
    // -----------------------------------------------------------------------

    /** 把模板写进用户目录。返回是否成功 */
    fun save(context: Context, t: Template): Boolean = try {
        val target = templateFile(context, t.id)
        val tmp = File(target.parentFile, target.name + ".tmp")
        tmp.writeText(toJson(t).toString(2))
        if (target.exists()) target.delete()
        if (!tmp.renameTo(target)) {
            target.writeText(toJson(t).toString(2))
            tmp.delete()
        }
        true
    } catch (e: Throwable) {
        Log.w(TAG, "模板保存失败：${t.id}", e)
        false
    }

    fun delete(context: Context, id: String): Boolean = try {
        templateFile(context, id).delete()
    } catch (e: Throwable) {
        false
    }

    // -----------------------------------------------------------------------
    // 解析 / 序列化
    // -----------------------------------------------------------------------

    /**
     * 解析并校验模板。
     *
     * ⚠️ 返回 null 表示"这不是一个可用的模板"。**不做尽力而为**：
     *    模板套错了会把用户排好版的文章弄乱，比明确失败糟得多。
     *
     * 校验顺序（先便宜后昂贵）：
     *   ① 体积；② 必须是 JSON 对象；③ schema 版本；
     *   ④ sha256 格式；⑤ blocks / ops 结构。
     */
    fun parse(text: String): Template? {
        if (text.length > MAX_BYTES) return null
        val root = try {
            JSONObject(text)
        } catch (e: Throwable) {
            return null
        }

        val schema = root.optInt("schema", 0)
        if (schema != SCHEMA) {
            Log.w(TAG, "模板 schema 不支持：$schema")
            return null
        }

        val source = root.optJSONObject("source") ?: return null
        val sha = source.optString("sha256")
        /* ⚠️ 必须是 64 位十六进制。不做这个校验的话，
              一个空串/乱码会"匹配"到别的空串模板 */
        if (sha.length != 64 || !sha.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
            Log.w(TAG, "模板 sha256 格式非法：$sha")
            return null
        }

        val blocksJson = root.optJSONArray("blocks") ?: JSONArray()
        val blocks = ArrayList<BlockSpec>(blocksJson.length())
        for (i in 0 until blocksJson.length()) {
            /*
              ⚠️ 块的两种写法都接受：
                 `[0, "title"]`            紧凑（推荐，省体积）
                 `{"i":0,"role":"title"}`  可读
                 后者是给人手改模板时用的，解析成本几乎一样。
            */
            val item = blocksJson.opt(i)
            val spec = when (item) {
                is JSONArray -> parseBlockArray(item)
                is JSONObject -> parseBlockObject(item)
                else -> null
            } ?: continue
            blocks.add(spec)
        }

        val opsJson = root.optJSONArray("ops") ?: JSONArray()
        val ops = ArrayList<Op>(opsJson.length())
        for (i in 0 until opsJson.length()) {
            parseOp(opsJson.opt(i))?.let { ops.add(it) }
        }

        val styleJson = root.optJSONObject("style")
        val style = LinkedHashMap<String, String>()
        if (styleJson != null) {
            val keys = styleJson.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                style[k] = styleJson.optString(k)
            }
        }

        return Template(
            id = root.optString("id").ifBlank { "tpl-" + sha.take(8) },
            name = root.optString("name").ifBlank { "未命名模板" },
            author = root.optString("author"),
            license = root.optString("license"),
            pdfSha256 = sha.lowercase(),
            pdfSize = source.optLong("size"),
            pdfPages = source.optInt("pages"),
            blockCount = root.optInt("blockCount", blocks.size),
            extractor = root.optString("extractor"),
            blocks = blocks,
            ops = ops,
            style = style,
        )
    }

    /** `[index, role, level?]` */
    private fun parseBlockArray(arr: JSONArray): BlockSpec? {
        val idx = arr.optInt(0, -1)
        if (idx < 0) return null
        /* ⚠️ 角色为 null 等价于 drop（紧凑写法 `[3, null]`） */
        val roleRaw = if (arr.isNull(1)) Role.DROP else arr.optString(1)
        val role = if (roleRaw in Role.ALL) roleRaw else Role.BODY
        return BlockSpec(idx, role, arr.optInt(2, 0))
    }

    /** `{"i":0,"role":"title","level":1}` */
    private fun parseBlockObject(obj: JSONObject): BlockSpec? {
        val idx = obj.optInt("i", -1)
        if (idx < 0) return null
        val roleRaw = obj.optString("role")
        val role = if (roleRaw in Role.ALL) roleRaw else Role.BODY
        return BlockSpec(idx, role, obj.optInt("level", 0))
    }

    /**
     * 解析一个操作。
     *
     * ⚠️ 两种写法都接受（数组紧凑 / 对象可读），与块一致。
     */
    private fun parseOp(item: Any?): Op? = when (item) {
        is JSONArray -> {
            when (item.optString(0)) {
                "merge" -> {
                    val arr = item.optJSONArray(1) ?: return null
                    val list = ArrayList<Int>(arr.length())
                    for (i in 0 until arr.length()) list.add(arr.optInt(i))
                    if (list.size < 2) null else Op.Merge(list)
                }
                "split" -> {
                    val b = item.optInt(1, -1)
                    val at = item.optInt(2, -1)
                    if (b < 0 || at <= 0) null else Op.Split(b, at)
                }
                "drop" -> {
                    val arr = item.optJSONArray(1) ?: return null
                    val list = ArrayList<Int>(arr.length())
                    for (i in 0 until arr.length()) list.add(arr.optInt(i))
                    if (list.isEmpty()) null else Op.Drop(list)
                }
                "reorder" -> {
                    val f = item.optInt(1, -1)
                    val t = item.optInt(2, -1)
                    if (f < 0 || t < 0) null else Op.Reorder(f, t)
                }
                else -> null
            }
        }
        is JSONObject -> {
            when (item.optString("op")) {
                "merge" -> {
                    val arr = item.optJSONArray("blocks") ?: return null
                    val list = ArrayList<Int>(arr.length())
                    for (i in 0 until arr.length()) list.add(arr.optInt(i))
                    if (list.size < 2) null else Op.Merge(list)
                }
                "split" -> {
                    val b = item.optInt("block", -1)
                    val at = item.optInt("at", -1)
                    if (b < 0 || at <= 0) null else Op.Split(b, at)
                }
                "drop" -> {
                    val arr = item.optJSONArray("blocks") ?: return null
                    val list = ArrayList<Int>(arr.length())
                    for (i in 0 until arr.length()) list.add(arr.optInt(i))
                    if (list.isEmpty()) null else Op.Drop(list)
                }
                "reorder" -> {
                    val f = item.optInt("from", -1)
                    val t = item.optInt("to", -1)
                    if (f < 0 || t < 0) null else Op.Reorder(f, t)
                }
                else -> null
            }
        }
        else -> null
    }

    /**
     * 序列化成公开的 JSON 格式。
     *
     * ⚠️ 用紧凑数组写法（`[0,"title"]`）：
     *    一个模板可能有 200 个块，对象写法会让文件大一倍。
     *    JSON 的缩进（`toString(2)`）已经保证了可读性。
     *
     * ⚠️ 这个函数的输出会被用户公开发布，
     *    所以每加一个字段都要问一次：它能还原原文吗？不能才能加。
     */
    fun toJson(t: Template): JSONObject = JSONObject().apply {
        put("schema", SCHEMA)
        put("id", t.id)
        put("name", t.name)
        if (t.author.isNotBlank()) put("author", t.author)
        if (t.license.isNotBlank()) put("license", t.license)

        put("source", JSONObject().apply {
            put("sha256", t.pdfSha256)
            put("size", t.pdfSize)
            put("pages", t.pdfPages)
        })
        if (t.extractor.isNotBlank()) put("extractor", t.extractor)
        put("blockCount", t.blockCount)

        put("blocks", JSONArray().apply {
            t.blocks.forEach { b ->
                if (b.level > 0) {
                    put(JSONArray().put(b.index).put(b.role).put(b.level))
                } else {
                    put(JSONArray().put(b.index).put(b.role))
                }
            }
        })

        if (t.ops.isNotEmpty()) {
            put("ops", JSONArray().apply {
                t.ops.forEach { op ->
                    when (op) {
                        is Op.Merge -> put(JSONArray().put("merge")
                            .put(JSONArray().apply { op.blocks.forEach { put(it) } }))
                        is Op.Split -> put(JSONArray().put("split")
                            .put(op.block).put(op.at))
                        is Op.Drop -> put(JSONArray().put("drop")
                            .put(JSONArray().apply { op.blocks.forEach { put(it) } }))
                        is Op.Reorder -> put(JSONArray().put("reorder")
                            .put(op.from).put(op.to))
                    }
                }
            })
        }

        if (t.style.isNotEmpty()) {
            put("style", JSONObject().apply {
                t.style.forEach { (k, v) -> put(k, v) }
            })
        }
    }

    /**
     * 生成模板 id。
     *
     * ⚠️ 用 `sha256(pdfHash + 导出时间)` 而不是随机 UUID：
     *    同一份 PDF 可以导出多个模板（精校版 / 极简版），
     *    id 不冲突；同时它**可复现** —— 同样的输入得到同样的 id，
     *    便于排查"这个模板到底从哪来的"。
     */
    fun newId(pdfSha256: String, stamp: Long): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest((pdfSha256 + ":" + stamp).toByteArray(Charsets.UTF_8))
        val hex = bytes.take(4).joinToString("") { String.format("%02x", it) }
        return "tpl-$hex"
    }
}
