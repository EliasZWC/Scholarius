(function () {
    var r = window.ScholariusReader;
    var text = '1 arXiv:1301.3781v3 [cs.CL] 7 Sep 2013 than a few hundred of millions of words';
    r.__testRender(
        [{ line: 1, page: 1, text: text, kind: '', lines: null }],
        { 1: [{ start: 0, end: 10, label: 'author', field: 'affiliation' }] }
    );
    var p = document.querySelector('.is-author-body');
    if (!p) return JSON.stringify({ err: 'no author body' });
    var lines = p.querySelectorAll('.reader-author-line');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var f = lines[i].querySelector('.reader-author-field');
        var v = lines[i].querySelector('.reader-author-value');
        out.push({
            field: f ? f.textContent : '',
            value: v ? v.textContent.slice(0, 55) : '',
            term: lines[i].classList.contains('is-author-term')
        });
    }
    return JSON.stringify({ count: out.length, lines: out });
})()
