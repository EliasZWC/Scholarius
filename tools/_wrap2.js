return (function () {
    var r = window.ScholariusReader;
    r.__testRender([
        { line: 1, page: 1, text: 'Ashish Vaswani, Google Brain, Niki Parmar', kind: '', lines: null }
    ], { 1: [{ start: 0, end: 14, label: 'author', field: 'name' }] });
    var p = document.querySelector('.is-author-body');
    if (!p) return JSON.stringify({ err: 'no body' });
    var lines = p.querySelectorAll('.reader-author-line');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var f = lines[i].querySelector('.reader-author-field');
        var v = lines[i].querySelector('.reader-author-value');
        out.push({ field: f ? f.textContent : '', value: v ? v.textContent : '' });
    }
    return JSON.stringify({ hasLines: false, count: out.length, lines: out });
})()
