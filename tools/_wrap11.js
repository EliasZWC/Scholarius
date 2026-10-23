return (function () {
    var r = window.ScholariusReader;
    var captured = null;
    // 劫持 renderBlocks 里的 blocks 查看
    var db = r.getBlocks();
    r.__testRender([
        { line: 0, page: 1, text: 'AAA BBB CCC', kind: '', lines: ['AAA BBB', 'CCC'] }
    ], {});
    var raw = r.getBlocks();
    return JSON.stringify({
        afterRenderBlocks: raw ? raw.map(function (b) {
            return { line: b.line, text: (b.text || '').slice(0, 20), lines: b.lines ? b.lines.length : 'none' };
        }) : null
    });
})()
