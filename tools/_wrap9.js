return (function () {
    var r = window.ScholariusReader;
    r.__testRender([
        { line: 1, page: 1, text: 'Ashish Vaswani, Google Brain Niki Parmar, Google Research', kind: '', lines: ['Ashish Vaswani, Google Brain', 'Niki Parmar, Google Research'] }
    ], { 1: [{ start: 0, end: 14, label: 'author', field: 'name' }] });
    var p = document.querySelector('.is-author-body');
    var lines = p.querySelectorAll('.reader-author-line');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var f = lines[i].querySelector('.reader-author-field');
        var v = lines[i].querySelector('.reader-author-value');
        out.push({ field: f ? f.textContent : '', value: v ? v.textContent : '' });
    }
    // 同时看 getBlocks 里 line 1 的 lines
    var blocks = r.getBlocks();
    return JSON.stringify({ lines: out, blockLines: blocks && blocks[1] ? blocks[1].lines : 'n/a' });
})()
