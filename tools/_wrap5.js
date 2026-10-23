return (function () {
    var r = window.ScholariusReader;
    // 真实形态：多行块带 b.lines（PdfText 会给）
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
    return JSON.stringify({ count: out.length, lines: out });
})()
