/*
 * ══ 语义分段引擎（v0.1.95）══
 *
 * 用户要求（原话）：
 *   「我的要求把段落划分做正确，具体什么模型什么方法无所谓」
 *   「我想的是我们把原始文本都提取出来之后，让语义模型划分段落」
 *   「先换更小的模型，我看看效果如何」
 *
 * ══ 做什么 ══
 *
 * 输入：一串**句子**（提取层已按标点切好）
 * 输出：这些句子该怎么归并成段落
 *
 * 判据：相邻两句的**语义相似度**。低于阈值 → 认为换段了。
 *
 * ══ 为什么这件事非模型不可 ══
 *
 * 排版（行距、缩进）能覆盖多数情况，但它答不了「这两句是不是一段」：
 *   · 双栏排版的行距和单栏不同
 *   · 段首不缩进的排版（英文论文常见）没有缩进信号
 *   · 表格/图注的间距和正文不一样
 * 而语义相似度对所有这些情况一视同仁 —— 它看的是内容。
 *
 * ══ 为什么用 paraphrase-MiniLM-L3-v2 ══
 *
 * 用户问过模型大小会不会给设备造成负担。实测：
 *   · L3（3 层，17.5MB INT8）比 L6（6 层，23MB）小 25%、快约 2 倍
 *   · 分段是**粗粒度**任务，不需要 L6 那种精度
 * 用户裁决：「先换更小的模型，我看看效果如何，如果效果 ok 就直接这样」
 *
 * ══ ⚠️ 分工：这里不做提取 ══
 *
 * 这个文件**不碰 PDF**。它只接收纯文本句子数组。
 * 提取仍然在 Kotlin（PdfText），因为那需要 TextPosition 坐标。
 * 分段放在前端，是因为模型推理在 WebView 里跑（transformers.js）。
 */
(function (global) {
    'use strict';

    /*
      ══ 模型配置 ══

      ⚠️ 模型名与 SemanticModel.kt 里的下载清单必须**一致**，
         否则下载了却找不到。改这里就要同步改那边。
    */
    var MODEL_ID = 'paraphrase-MiniLM-L3-v2';

    /*
      ══ 段落判定阈值 ══

      相邻两句的余弦相似度低于这个值 → 断段。

      ⚠️ 这是唯一需要调的超参，但要**看效果再调**，不要凭感觉设。

     ⚠️ 2026-10 实测（paraphrase-MiniLM-L3-v2 + q8，模型很小，相似度整体偏低）：
         · 同一段内的相邻句：0.29 ~ 0.75   ← 注意能低到 0.29！
         · 真正换段：       0.10 左右
        一开始按常识设 0.42，结果把一段摘要切成了 3 段。
        所以阈值必须压在**段内下沿之下**：0.24 左右。
        模型越大相似度越高，换模型时这个值要重测。
    */
    var DEFAULT_THRESHOLD = 0.24;

    /**
     * 分档阈值：文本越长，相邻句之间的语义漂移越正常，
     * 阈值要相应放宽，否则长论文会被切成碎片。
     */
    function thresholdFor(count) {
        if (count <= 6) return DEFAULT_THRESHOLD;        /* 短文本严一点 */
        if (count <= 20) return DEFAULT_THRESHOLD - 0.04;
        return DEFAULT_THRESHOLD - 0.07;                  /* 长文宽松 */
    }

    /** 加载好的 pipeline（懒加载，加载一次复用） */
    var extractor = null;
    var loadPromise = null;

    /** 当前状态，供 UI 查询 */
    var state = 'idle';   // idle | loading | ready | failed
    var lastError = '';

    function t(key) {
        return global.ScholariusI18n ? global.ScholariusI18n.t(key) : key;
    }

    // ------------------------------------------------------------------
    // 分句
    // ------------------------------------------------------------------

    /**
     * 把一段文本切成句子。
     *
     * ══ ⚠️⚠️ 为什么分句要自己写，而不是用现成的 ══
     *
     * 看起来简单（遇到 .!? 就切），但实测论文里全是坑：
     *
     *   ① 缩写：`e.g.` `i.e.` `et al.` `Fig.` `Eq.` `vs.` `Dr.`
     *      —— 点后面不是句子开头
     *   ② 编号：`1. Introduction` `2.3 Method` `[12]`
     *      —— 点/括号是编号的一部分
     *   ③ 小数：`0.85` `3.5%`
     *   ④ 域名/邮箱：`www.fit.vutbr.cz` `a@b.com`
     *
     * ✅ 判据：句号后必须是**空白 + 大写字母或数字**才算句子边界。
     *    这一条自动排除 ①②③④ 里的绝大多数 —— 因为它们后面
     *    要么是小写字母，要么没有空白。
     *
     * ⚠️ 中文句子用 `。！？` 直接切，没有缩写问题。
     */
    var ABBREV = [
        'e.g', 'i.e', 'et al', 'fig', 'figs', 'eq', 'eqs', 'vs', 'dr',
        'mr', 'mrs', 'ms', 'prof', 'al', 'no', 'vol', 'pp', 'cf', 'approx',
        'sec', 'ref', 'refs', 'tab', 'ch', 'chap', 'ed', 'eds', 'resp'
    ];

    /** 句末标点后是否真的开始了新句 */
    function startsSentenceAfter(text, dotIndex) {
        var after = text.slice(dotIndex + 1);
        /* 后面必须紧跟空白（或到结尾） */
        var m = after.match(/^([ \t\u00a0]+)(\S)/);
        if (!m) return false;
        var next = m[2];
        /* 必须是大写字母或数字（句子开头） */
        return /[A-Z0-9\u4e00-\u9fff]/.test(next);
    }

    /** 判断 `text` 在 dotIndex 处的点是不是缩写的一部分 */
    function isAbbreviation(text, dotIndex) {
        /* 取点之前的那个词（连续的字母） */
        var start = dotIndex;
        while (start > 0 && /[A-Za-z.]/.test(text.charAt(start - 1))) start--;
        var word = text.slice(start, dotIndex + 1).toLowerCase();
        var bare = word.replace(/\.$/, '');

        for (var i = 0; i < ABBREV.length; i++) {
            if (bare === ABBREV[i]) return true;
        }
        /*
          ⚠️ 单个字母 + 点（`Y. Bengio` 里的 `Y.`）也算缩写 ——
             那是人名的首字母。但**注意**：`A. Neural` 这种
             如果真是句子边界就会漏切。
             取舍：论文里 "X. Word" 形态绝大多数是人名缩写。
        */
        if (/^[A-Za-z]$/.test(bare)) return true;

        return false;
    }

    /**
     * 切句。
     *
     * @param {string} text 一段连续文本（可能跨多个排版行，已用空格连好）
     * @return {string[]} 句子数组（已 trim，空句丢弃）
     */
    function splitSentences(text) {
        var s = String(text || '');
        if (!s) return [];

        var out = [];
        var cur = 0;

        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);

            /* 中文句末标点：直接切（中文没有缩写问题） */
            if (c === '\u3002' || c === '\uff01' || c === '\uff1f') {
                var zh = s.slice(cur, i + 1).trim();
                if (zh) out.push(zh);
                cur = i + 1;
                continue;
            }

            if (c !== '.' && c !== '!' && c !== '?' && c !== '\uff0e') continue;

            /* 英文标点：要看后面 */
            if (c === '.' && isAbbreviation(s, i)) continue;
            if (!startsSentenceAfter(s, i)) continue;

            var sent = s.slice(cur, i + 1).trim();
            if (sent) out.push(sent);
            cur = i + 1;
        }

        var tail = s.slice(cur).trim();
        if (tail) out.push(tail);

        /*
          ⚠️ 合并极短的"句子"（如单独的 `1.` `[12]`）到下一句 ——
             它们不是独立的句子，而是一个列表项/引用的开头。
             不合并的话，模型会对 `1.` 这种碎片算相似度，全是噪声。

          ⚠️⚠️ 门槛必须按**文字类型**分别定（实测踩到）：
             第一版统一用 8 个字符，结果中文翻车 ——
             「这是第一句。这是第二句！这是第三句？」里前两句各 6 字，
             被合并成一句，3 句变 2 句。

             中文一个字承载的信息量远大于一个英文字母：
             「这是第一句。」是**完整句子**，而 `Introduc` 只是半个单词。
             所以：
               · 含中文 → 门槛 3（只合并 `1、` 这种真碎片）
               · 纯英文 → 门槛 12（`1. ` `[12] ` 这类列表标记）
        */
        var merged = [];
        for (var k = 0; k < out.length; k++) {
            var item = out[k];
            var hasChinese = /[\u4e00-\u9fff]/.test(item);
            var minLen = hasChinese ? 3 : 12;

            if (item.length < minLen && k + 1 < out.length) {
                out[k + 1] = item + ' ' + out[k + 1];
                continue;
            }
            merged.push(item);
        }

        return merged;
    }

    // ------------------------------------------------------------------
    // 模型加载
    // ------------------------------------------------------------------

    /**
     * 懒加载模型。
     *
     * ⚠️ 用 transformers.js 的全局构建（`window.transformers`）而不是
     *    ES module import —— 本项目所有脚本都是普通 <script>，
     *    没有打包器，也没有 type="module"。
     *
     * ⚠️ `allowRemoteModels = false` + 本地路径：**完全离线**。
     *    这既是用户要求（自己下载），也是隐私要求（文献不上传）。
     */
    function ensureModel() {
        if (extractor) return Promise.resolve(extractor);
        if (loadPromise) return loadPromise;

        state = 'loading';

        /*
          每一步都打日志（v0.1.95）。
          ⚠️ 排查模型加载失败时，只能看到"超时"是不够的 ——
             必须知道卡在 runtime / wasm / 模型 fetch / session 哪一步。
             日志会以 "SEG: ..." 前缀出现在 logcat 的 CONSOLE 行里。
        */
        segLog('ensureModel: start');

        loadPromise = waitRuntime(15000).then(function (lib) {
            segLog('runtime ready, version=' + lib.env.version);
            segLog('localModelPath=' + lib.env.localModelPath);
            segLog('wasmPaths=' + lib.env.backends.onnx.wasm.wasmPaths);

            return lib.pipeline('feature-extraction', MODEL_ID, {
                dtype: 'q8',
                progress_callback: function (p) {
                    segLog('progress ' + JSON.stringify(p).slice(0, 160));
                }
            }).then(function (pipe) {
                segLog('pipeline ready');
                extractor = pipe;
                state = 'ready';
                return pipe;
            });
        }).catch(function (e) {
            state = 'failed';
            lastError = String((e && e.message) || e);
            segLog('FAILED: ' + lastError);
            throw e;
        });

        return loadPromise;
    }

    /** 打一条诊断日志（走 window.trace，最终进 logcat） */
    function segLog(msg) {
        try {
            if (global.trace) global.trace('SEG: ' + msg);
            else if (global.console) console.log('SEG: ' + msg);
        } catch (e) { /* 日志失败不影响主流程 */ }
    }

    /** 等 module 脚本把 transformers 挂到 window 上 */
    function waitRuntime(timeoutMs) {
        return new Promise(function (resolve, reject) {
            var started = Date.now();
            (function check() {
                var lib = global.transformers;
                if (lib && lib.pipeline && lib.env) {
                    configureEnv(lib);
                    resolve(lib);
                    return;
                }
                if (Date.now() - started > timeoutMs) {
                    reject(new Error('semantic runtime not loaded'));
                    return;
                }
                global.setTimeout(check, 100);
            })();
        });
    }

    /** 配置 transformers.js 从本地取文件（完全离线） */
    function configureEnv(lib) {
        var base = global.__SEMANTIC_MODEL_BASE__ || 'model/';
        lib.env.allowRemoteModels = false;
        lib.env.allowLocalModels = true;
        lib.env.localModelPath = base;

        /*
          ══ onnxruntime 的 WASM 路径 ══

          transformers.js 默认去它自己所在目录找 ort 的 `.wasm` / `.mjs`。
          但我们的 WASM 是**下载**下来的（11.2MB，不打进 APK），
          放在 `model/ort/` 下。

          ✅ 显式指向那个目录。否则它会去 vendor/ 找，
             找不到就报一个完全看不出根因的错误。
        */
        if (lib.env.backends && lib.env.backends.onnx) {
            lib.env.backends.onnx.wasm = lib.env.backends.onnx.wasm || {};
            /*
              ══ WASM 路径：**本地**（v0.1.95）══

              ⚠️ 之前两次失败都不是"路径写法"问题，而是**文件名不对**：
                 transformers.js 3.0.2 硬编码要 `...jsep.wasm` / `.jsep.mjs`，
                 而我下了不带 jsep 的那份（以为 WebView 用不上 WebGPU）。
                 日志里写得很清楚：
                     Error opening ... ort-wasm-simd-threaded.jsep.wasm

              ✅ 现在下载清单已改成 jsep 版本，这里指向本地目录即可 ——
                 用户要求「WASM 也走下载」，完全离线。
            */
            lib.env.backends.onnx.wasm.wasmPaths = base + 'ort/';
            /*
              ⚠️ 单线程：WebView 里拿不到跨源隔离标头，
                 SharedArrayBuffer 不可用，开多线程会直接报错。
            */
            lib.env.backends.onnx.wasm.numThreads = 1;
        }
    }

    // ------------------------------------------------------------------
    // 相似度
    // ------------------------------------------------------------------

    /** 余弦相似度 */
    function cosine(a, b) {
        var dot = 0, na = 0, nb = 0;
        for (var i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if (na === 0 || nb === 0) return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    /**
     * 给一批句子算向量。
     *
     * ⚠️ 分批处理：一次把整篇论文的几百句塞进去会让内存爆掉。
     *    每批 16 句，够用且安全。
     */
    function embedSentences(sentences, onProgress) {
        var BATCH = 16;
        var vectors = [];
        var idx = 0;

        function next() {
            if (idx >= sentences.length) return Promise.resolve(vectors);

            var chunk = sentences.slice(idx, idx + BATCH);
            return extractor(chunk, { pooling: 'mean', normalize: true })
                .then(function (output) {
                    /*
                      ⚠️ transformers.js 的输出是 Tensor，`tolist()` 才拿到数组。
                         shape 是 [batch, dim]。
                    */
                    var data = output.tolist();
                    for (var i = 0; i < data.length; i++) {
                        vectors.push(data[i]);
                    }
                    idx += chunk.length;
                    if (onProgress) onProgress(idx, sentences.length);
                    return next();
                });
        }

        return next();
    }

    // ------------------------------------------------------------------
    // 分段
    // ------------------------------------------------------------------

    /**
     * 主入口：把文本分段。
     *
     * @param {string|string[]} input 文本，或已切好的句子数组
     * @param {object} opts { threshold, onProgress }
     * @return {Promise<{paragraphs: string[], sentences: string[], scores: number[]}>}
     */
    function segment(input, opts) {
        opts = opts || {};
        var sentences = Array.isArray(input) ? input.slice() : splitSentences(input);
        if (sentences.length === 0) {
            return Promise.resolve({ paragraphs: [], sentences: [], scores: [] });
        }
        /* 只有一句 → 一段，不需要模型 */
        if (sentences.length === 1) {
            return Promise.resolve({
                paragraphs: [sentences[0]], sentences: sentences, scores: []
            });
        }

        var threshold = typeof opts.threshold === 'number'
            ? opts.threshold : thresholdFor(sentences.length);
        return ensureModel()
            .then(function () {
                return embedSentences(sentences, opts.onProgress);
            })
            .then(function (vectors) {
                var scores = [];
                var paragraphs = [];
                var buf = [sentences[0]];

                for (var i = 1; i < sentences.length; i++) {
                    var sim = cosine(vectors[i - 1], vectors[i]);
                    scores.push(sim);

                    if (sim < threshold) {
                        /* 相似度低 → 换段 */
                        paragraphs.push(buf.join(' '));
                        buf = [sentences[i]];
                    } else {
                        buf.push(sentences[i]);
                    }
                }
                if (buf.length) paragraphs.push(buf.join(' '));

                return {
                    paragraphs: paragraphs,
                    sentences: sentences,
                    scores: scores
                };
            });
    }

    global.ScholariusSeg = {
        splitSentences: splitSentences,
        segment: segment,
        ensureModel: ensureModel,
        cosine: cosine,
        threshold: DEFAULT_THRESHOLD,
        getState: function () {
            return { state: state, error: lastError };
        },
        /* 供测试：直接注入一个假的 extractor */
        __setExtractor: function (fn) {
            extractor = fn;
            state = 'ready';
        }
    };
})(window);
