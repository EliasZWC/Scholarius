// 在真实页面里跑 md.js 的规则，与 tools/check_markdown.py 逐条对照。
// 用法：python tools/emu_js.py "$(Get-Content tools/_md_check.js -Raw)"
return (function () {
    var M = window.ScholariusMarkdown;
    if (!M) return 'FAIL: ScholariusMarkdown 未加载（md.js 是否在 index.html 里？）';

    var cases = [];

    function c(name, blocks, expect) { cases.push({ n: name, b: blocks, e: expect }); }

    c('文章标题 → #', [{ kind: 'heading', level: 1, text: 'Attention Is All You Need' }],
        '# Attention Is All You Need\n');
    c('一级标题 → ##', [
        { kind: 'heading', level: 1, text: 'Title' },
        { kind: 'heading', level: 1, text: '1 Introduction' }
    ], '# Title\n\n## 1 Introduction\n');
    c('二级标题 → ###', [
        { kind: 'heading', level: 1, text: 'T' },
        { kind: 'heading', level: 2, text: '1.1 Goals' }
    ], '# T\n\n### 1.1 Goals\n');
    c('三级标题 → ####', [
        { kind: 'heading', level: 1, text: 'T' },
        { kind: 'heading', level: 3, text: '1.1.1 Detail' }
    ], '# T\n\n#### 1.1.1 Detail\n');
    c('作者信息 → 无序列表', [{
        kind: 'author',
        text: 'Jacob Devlin, Ming-Wei Chang\nGoogle AI Language',
        lines: ['Jacob Devlin, Ming-Wei Chang', 'Google AI Language']
    }], '- Jacob Devlin, Ming-Wei Chang\n\n- Google AI Language\n');
    c('文献 → 有序列表（跨块连续）', [
        { kind: 'reference', text: 'A. Author. Paper one. 2015.' },
        { kind: 'reference', text: 'B. Author. Paper two. 2016.' }
    ], '1. A. Author. Paper one. 2015.\n\n2. B. Author. Paper two. 2016.\n');
    c('文献折行合并为一条', [
        {
            kind: 'reference',
            text: '[3] T. Brants, A.C. Popat. Large language models in machine translation. In Proceedings, 2007.',
            lines: ['[3] T. Brants, A.C. Popat. Large language models in machine',
                    'translation. In Proceedings, 2007.']
        },
        { kind: 'reference', text: '[4] R. Collobert. A Unified Architecture. 2008.' }
    ], '1. [3] T. Brants, A.C. Popat. Large language models in machine translation. In Proceedings, 2007.\n\n2. [4] R. Collobert. A Unified Architecture. 2008.\n');
    c('正文不使用列表', [
        { kind: 'heading', level: 1, text: 'T' },
        { kind: 'paragraph', text: 'Body text without any list marker.' }
    ], '# T\n\nBody text without any list marker.\n');
    c('正文忽略 lines（排版折行不成硬换行）', [
        { kind: 'paragraph', text: 'line one line two', lines: ['line one', 'line two'] }
    ], 'line one line two\n');
    c('空块跳过', [
        { kind: 'heading', level: 1, text: 'T' },
        { kind: 'paragraph', text: '   ' },
        { kind: 'paragraph', text: 'X' }
    ], '# T\n\nX\n');
    c('首块非标题时第二块才是 ##', [
        { kind: 'paragraph', text: 'preamble' },
        { kind: 'heading', level: 1, text: 'Chapter' }
    ], 'preamble\n\n## Chapter\n');

    var fail = 0;
    var lines = [];
    for (var i = 0; i < cases.length; i++) {
        var got = M.toMarkdown(cases[i].b, { listKinds: { author: true, reference: true } });
        if (got === cases[i].e) {
            lines.push('OK   ' + cases[i].n);
        } else {
            fail++;
            lines.push('FAIL ' + cases[i].n +
                '\n  期望=' + JSON.stringify(cases[i].e) +
                '\n  实际=' + JSON.stringify(got));
        }
    }
    lines.push('');
    lines.push('合计: ' + (cases.length - fail) + ' 通过 / ' + fail + ' 失败');
    return lines.join('\n');
})()
