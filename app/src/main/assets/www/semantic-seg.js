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

    /*
      ══ 连续失败计数 → 自动降级（v0.1.96）══

      为什么需要：模型能加载 ≠ 能推理。
      实测可能的失败点：
        · 文本超长 → 张量分配失败（OOM）
        · 某些字符让 tokenizer 抛异常
        · wasm 内存碎片导致 session.run 崩溃

      这些都不是"模型坏了"，但**每篇文献都要重试一遍**会让打开
      任何一篇都卡十几秒，然后才能退化成纯文本。

      ✅ 连续失败 3 次就把 state 置为 'failed' 并停止尝试。
         用户重新打开设置里的开关会调用 retry()（见下）重置计数。
      ⚠️ 判据是**连续**失败：中间成功一次就清零。
    */
    var failStreak = 0;
    var MAX_FAIL_STREAK = 3;

    /**
     * 取消请求（用户点「跳过」）。
     *
     * ⚠️ 这是**协作式**取消：置标志后，正在跑的批处理在下一个
     *    批次边界退出。不能强行中断 `session.run()` ——
     *    那会让 wasm 处于不一致状态，后续推理全部出错。
     * ⚠️ 取消**不算失败**，不增加 failStreak。
     *    用户主动跳过不该让功能被熔断。
     */
    var cancelRequested = false;

    /**
     * 正在等待模型加载的回调列表（v0.2.1）。
     *
     * ⚠️ 用列表而不是单个回调：模型加载是全局的、只做一次，
     *    但可能有多处同时在等（用户连点两次，或将来有两个文档同时开）。
     *    只存一个的话，后者的回调会覆盖前者 → 前一个永远收不到进度。
     */
    var loadWaiters = [];

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
        /*
          ══ ⚠️ 换行也是合法分隔（v0.2.32 修）══

          旧写法只认 `[ \t\u00a0]+`，**不认换行** ——
          于是这种情况切不开：

              这些模型由多层组成.
              摘要 主流的序列转换模型基于 RNN.

          块与块之间用 `\n` 连接（`semanticReflow` 就是这么拼的），
          如果换行不算分隔，整段会粘成一个"句子"，
          模型只能对它算一次相似度 —— 分段能力直接失效。

          ✅ `\s` 包含 `\n` / `\r` / 全角空格。
          ⚠️ 但**不能把换行后面紧跟小写的情况也当句子边界** ——
             那是排版折行（`... the dominant\nsequence transduction ...`），
             下面「必须大写或数字开头」的判据仍然拦得住。
        */
        var m = after.match(/^\s+(\S)/);
        if (!m) return false;
        var next = m[1];
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
     * 切句（保留原文偏移版，v0.2.32）。
     *
     * ══ ⚠️⚠️ 为什么必须带偏移 ══
     *
     * 用户反馈：
     *
     *   「模型切分前后怎么文本内容还变了？按理来说不应该仅切分吗
     *     不更改内容吗？」
     *
     * 他是对的。切分只该决定**在哪里断开**，绝不该重写文本。
     * 旧实现只返回 `string[]`，调用方拿不到位置，只能用
     * `buf.join(' ')` 重新拼 —— 于是原文里的换行、多空格、
     * 制表符全部被规范化成一个空格，文本**确实变了**。
     *
     * ✅ 现在返回 `{text, start, end}`：
     *    · `text`  用于喂模型（trim 过的干净句子）
     *    · `start` / `end` 是在**原文**中的精确区间
     *
     *    调用方据此从原文 `slice()` 切段落，一个字符都不会改。
     *
     * ⚠️ `start`/`end` 指向**未 trim 的原始区间**，
     *    这样相邻句子首尾相接，拼起来正好还原原文。
     *
     * @param {string} text
     * @return {Array<{text:string, start:number, end:number}>}
     */
    function splitSentencesWithOffsets(text) {
        var s = String(text == null ? '' : text);
        if (!s) return [];

        var raw = [];   /* {start, end} —— 未 trim */

        var push = function (a, b) {
            /* 去掉首尾空白，但**保留区间在原文里的位置** */
            var x = a, y = b;
            while (x < y && /\s/.test(s.charAt(x))) x++;
            while (y > x && /\s/.test(s.charAt(y - 1))) y--;
            if (y > x) raw.push({ start: x, end: y });
        };

        var cur = 0;

        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);

            if (c === '\u3002' || c === '\uff01' || c === '\uff1f') {
                push(cur, i + 1);
                cur = i + 1;
                continue;
            }

            if (c !== '.' && c !== '!' && c !== '?' && c !== '\uff0e') continue;
            if (c === '.' && isAbbreviation(s, i)) continue;
            if (!startsSentenceAfter(s, i)) continue;

            push(cur, i + 1);
            cur = i + 1;
        }
        push(cur, s.length);

        /*
          ⚠️ 合并极短碎片（`1.` `[12]`），门槛按文字类型分开 ——
             理由见 `splitSentences` 里的长注释，两边必须一致，
             否则模型输入的句子集合会不同。
        */
        var merged = [];
        for (var k = 0; k < raw.length; k++) {
            var it = raw[k];
            var t = s.slice(it.start, it.end);
            var minLen = /[\u4e00-\u9fff]/.test(t) ? 3 : 12;
            if (t.length < minLen && k + 1 < raw.length) {
                /* 合并区间：从本句起点到下一句终点（中间空白一并包含） */
                raw[k + 1] = { start: it.start, end: raw[k + 1].end };
                continue;
            }
            merged.push(it);
        }

        return merged.map(function (r) {
            return { text: s.slice(r.start, r.end), start: r.start, end: r.end };
        });
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
    function ensureModel(onProgress) {
        if (extractor) return Promise.resolve(extractor);
        /*
          ⚠️ 已经有人在加载 → 把新调用方的进度回调也挂上（v0.2.1）。

          原来直接 `return loadPromise`，于是**第二个**调用方收不到
          任何进度 —— 界面上表现为进度条停在 0，然后突然跳到 100。
          这正是用户看到的「加载直接从 0 跳到 100」的一半原因。
        */
        if (loadPromise) {
            if (typeof onProgress === 'function') {
                loadWaiters.push(onProgress);
            }
            return loadPromise;
        }

        state = 'loading';
        loadWaiters = [];
        if (typeof onProgress === 'function') loadWaiters.push(onProgress);

        /* 统一往所有等待方广播（加载阶段用，非句子级进度） */
        function emitLoad(stage, frac) {
            for (var i = 0; i < loadWaiters.length; i++) {
                try {
                    loadWaiters[i](stage, frac);
                } catch (e) { /* 单个回调出错不影响加载 */ }
            }
        }

        emitLoad('runtime', 0.05);

        /*
          每一步都打日志（v0.1.95）。
          ⚠️ 排查模型加载失败时，只能看到"超时"是不够的 ——
             必须知道卡在 runtime / wasm / 模型 fetch / session 哪一步。
             日志会以 "SEG: ..." 前缀出现在 logcat 的 CONSOLE 行里。
        */
        segLog('ensureModel: start');

        loadPromise = waitRuntime(15000)
            .then(function (lib) {
                /*
                  ══ ⚠️⚠️ 先让出一帧，再开始编译（v0.2.0）══

                  用户反馈：「加载模型直接 app 卡住了」。

                  实测（模拟器，比真机强）：加载期间主线程最大停顿 **460ms**。
                  真机上 wasm 编译更慢，几秒的卡死完全可能。

                  真因：`onnxruntime` 创建 session 时，WASM 编译是
                  **同步**占着主线程的（`numThreads = 1`，没有 worker）。
                  期间 WebView 无法重绘、无法响应触摸 → 用户看到"卡住"。

                  ⚠️ 不能真的把编译搬到 worker：WebView 没有跨源隔离标头，
                     `SharedArrayBuffer` 不可用，多线程 ort 会直接报错
                     （见下面 numThreads 的说明）。所以只能"让用户看见"。

                  ✅ 做法：编译前先 yield 两帧 ——
                     ① 让调用方刚设的进度条（"正在加载模型…"）先画出来；
                     ② 让浏览器处理完积压的输入事件（用户点的"切分"按钮）。
                     这样"卡"变成"有明确提示的等待"，而不是无响应。

                  ⚠️ 用 `requestAnimationFrame` 两次而不是一次：
                     一次 rAF 只保证"下一帧之前"，样式可能还没应用；
                     两次能确保那一帧已经**绘制完成**。
                */
                return nextFrame().then(nextFrame).then(function () {
                    segLog('yielded, starting pipeline');
                    emitLoad('load', 0.1);

                    return lib.pipeline('feature-extraction', MODEL_ID, {
                        dtype: 'q8',
                        progress_callback: function (p) {
                            segLog('progress ' + JSON.stringify(p).slice(0, 160));
                            /*
                              ══ 把加载进度喂给进度条（v0.2.1）══

                              用户反馈：「加载直接从 0 跳到 100」。

                              真因：原来这里只打日志，不报进度。
                              加载阶段占用了大约一半时间，进度条却
                              一动不动停在 0；等推理开始时直接跳到
                              句子级进度 → 看起来像"0 直接跳 100"。

                              ⚠️ 模型只有 3 个文件，`progress` 事件是
                                 **逐文件**的，每个文件从 0 到 100。
                                 要换成整体进度：已完成的文件数 / 总数
                                 + 当前文件的比例 × 单文件份额。
                              ⚠️ 加载只占总进度的 0~40%：后面还要推理，
                                 如果这里走到 100，用户会以为快好了，
                                 然后卡在 100 等推理，反而更糟。
                            */
                            if (p && p.status === 'progress' &&
                                typeof p.progress === 'number') {
                                var frac = Math.min(1, p.progress / 100);
                                emitLoad('load', 0.1 + frac * 0.25);
                            }
                        }
                    });
                }).then(function (pipe) {
                    segLog('pipeline ready');
                    /*
                      ══ ⚠️ session 编译是**第二段**大头（v0.2.1）══

                      `pipeline()` 返回之前还有一段：把 onnx 模型装配成
                      推理 session（wasm 编译）。这一段**没有** progress
                      事件，而且是最慢的（实测本地 17MB 约 1~3 秒）。

                      所以文件下载完（约 35%）之后要**主动**推到 38%，
                      并在编译结束后才回到正常流程 ——
                      否则进度条会卡在 35% 好几秒，用户以为死了。
                    */
                    emitLoad('compile', 0.95);
                    extractor = pipe;
                    state = 'ready';
                    emitLoad('ready', 1);
                    return pipe;
                });
            }).catch(function (e) {
                state = 'failed';
                lastError = String((e && e.message) || e);
                segLog('FAILED: ' + lastError);
            /*
              ══ ⚠️⚠️ 失败后必须清掉 loadPromise（v0.1.96）══

              原来这里只设置 state 就 rethrow，`loadPromise` 仍然是
              那个**已 reject** 的 Promise。后果：

                · 之后每次 `ensureModel()` 都 `return loadPromise`
                  → 立刻 reject，永不重试；
                · 用户即使重新下载了模型、或内存缓过来了，
                  也必须**重启应用**才能恢复；
                · 更糟的是 `state` 一直是 'failed'，
                  设置页显示"开启"（因为文件在），但实际每次分段都失败 ——
                  这就是"加了模型反而无法提取"那个现象的来源之一。

              ✅ 清掉之后，下一次调用会重新尝试加载。
                 失败重试有代价（重新加载 17MB），但比"永远坏掉"好。
            */
            loadPromise = null;
            throw e;
        });

        return loadPromise;
    }

    /**
     * 等下一帧绘制完成（v0.2.0）。
     *
     * ⚠️ 用于在长时间同步任务（wasm 编译）之前**让出主线程**，
     *    保证进度提示已经画到屏幕上、用户点击也已被处理。
     *
     * ⚠️ 没有 requestAnimationFrame 时退回 setTimeout(0)：
     *    功能不能因为环境差异而挂住（老 WebView / 测试环境）。
     */
    function nextFrame() {
        return new Promise(function (resolve) {
            if (typeof global.requestAnimationFrame === 'function') {
                global.requestAnimationFrame(function () {
                    /* ⚠️ rAF 回调在"重绘前"执行，再套一层宏任务才是"重绘后" */
                    global.setTimeout(resolve, 0);
                });
            } else {
                global.setTimeout(resolve, 16);
            }
        });
    }

    /** 打一条诊断日志（走 window.trace，最终进 logcat） */
    function segLog(msg) {        try {
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
            /*
              ⚠️ 在每个批次边界检查取消 —— 这是唯一安全的时机。
                 强制中断 `session.run()` 会破坏 wasm 内部状态。
                 最坏延迟 = 一批（16 句）的处理时间，通常 <100ms。
            */
            if (cancelRequested) {
                return Promise.reject(new Error('cancelled'));
            }
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

        /*
          ⚠️ 熔断：连续失败太多次就不再尝试 —— 直接 reject，
             调用方（reader.js）会退回原始块，正文照常渲染。
             不熔断的话每篇文献都要重试一遍加载，打开很慢。
        */
        if (failStreak >= MAX_FAIL_STREAK) {
            return Promise.reject(new Error(
                'semantic disabled after ' + failStreak + ' failures: ' + lastError));
        }

        return ensureModel(opts.onLoad)
            .then(function () {
                /* ⚠️ 加载完就检查一次 —— 用户可能已经点了「跳过」 */
                if (cancelRequested) throw new Error('cancelled');
                return embedSentences(sentences, opts.onProgress);
            })
            .then(function (vectors) {
                /* 成功 → 清零 */
                failStreak = 0;
                var scores = [];
                var paragraphs = [];
                /*
                  ⚠️ 同时记下每段由**哪些句子下标**组成（v0.2.32）。
                     调用方要用它从**原文**精确切片，
                     而不是用 `paragraphs` 里那个被 join 过的字符串。
                */
                var paragraphRanges = [];
                var buf = [0];
                var bufStart = 0;

                for (var i = 1; i < sentences.length; i++) {
                    var sim = cosine(vectors[i - 1], vectors[i]);
                    scores.push(sim);

                    if (sim < threshold) {
                        /* 相似度低 → 换段 */
                        paragraphs.push(buf.join(' '));
                        paragraphRanges.push({ from: bufStart, to: i - 1 });
                        buf = [sentences[i]];
                        bufStart = i;
                    } else {
                        buf.push(sentences[i]);
                    }
                }
                if (buf.length) {
                    paragraphs.push(buf.join(' '));
                    paragraphRanges.push({ from: bufStart, to: sentences.length - 1 });
                }

                return {
                    paragraphs: paragraphs,
                    sentences: sentences,
                    scores: scores,
                    paragraphRanges: paragraphRanges
                };
            })
            .catch(function (e) {
                /*
                  ⚠️ 计数 + 记录，然后**继续向上抛** ——
                     调用方需要知道这一步失败了（它要退回原始块）。
                     吞掉异常会让 reader.js 以为"分出来一段"，结果更糟。

                  ⚠️ 用户主动取消**不算失败**，不计入熔断。
                     否则点几次「跳过」功能就被禁用了 —— 那是荒谬的。
                */
                var msg = String((e && e.message) || e);
                if (msg === 'cancelled') {
                    /* 重置标志，否则下一批永远立即取消 */
                    cancelRequested = false;
                    segLog('segment cancelled by user');
                    throw e;
                }
                failStreak++;
                lastError = msg;
                segLog('segment failed (' + failStreak + '/' + MAX_FAIL_STREAK +
                       '): ' + lastError);
                throw e;
            });
    }

    global.ScholariusSeg = {
        splitSentences: splitSentences,
        /* v0.2.32：带原文偏移的切句，供"只切不改"的段落重建使用 */
        splitSentencesWithOffsets: splitSentencesWithOffsets,
        segment: segment,
        ensureModel: ensureModel,
        /**
         * 让出主线程直到下一帧绘制完成（v0.2.0）。
         *
         * ⚠️ 对外暴露是必需的：调用方（reader.js）要在**自己的**
         *    提示设好之后、进模型之前让出。放在内部就不够 ——
         *    内部的 yield 发生在 `pipeline()` 之前，但那时调用方
         *    已经同步跑了一串代码，提示可能仍未被绘制。
         */
        nextFrame: nextFrame,
        cosine: cosine,
        threshold: DEFAULT_THRESHOLD,
        getState: function () {
            return {
                state: state,
                error: lastError,
                failStreak: failStreak
            };
        },
        /**
         * 请求取消当前分段（用户在进度条上点「跳过」）。
         *
         * ⚠️ 协作式：在下一个批次边界生效，不会强杀 wasm 推理。
         * ⚠️ 取消后必须在**下一次开始前**调 resetCancel() 清标志，
         *    否则下次一分段就立刻被取消。
         */
        cancel: function () {
            cancelRequested = true;
            segLog('cancel requested');
            return true;
        },
        resetCancel: function () {
            cancelRequested = false;
            return true;
        },
        /**
         * 重置失败计数并清掉已加载的 pipeline。
         *
         * ⚠️ 用户在设置里**重新打开开关**时必须调用它 ——
         *    否则熔断之后的开关是"看得见、点不动"，会让人以为功能坏了。
         *    代价是一次重新加载（17MB 从本地读，约 1 秒）。
         */
        retry: function () {
            failStreak = 0;
            lastError = '';
            loadPromise = null;
            extractor = null;
            state = 'idle';
            cancelRequested = false;
            segLog('retry: reset');
            return true;
        },
        /* 供测试：直接注入一个假的 extractor */
        __setExtractor: function (fn) {
            extractor = fn;
            state = 'ready';
        }
    };
})(window);
