return (function () {
    var r = window.ScholariusReader;
    r.open({ id: 't2', title: 'T2' });
    r.__testRender([
        { line: 0, page: 1, text: 'Ashish Vaswani, Google Brain Niki Parmar, Google Research', kind: '', lines: ['Ashish Vaswani, Google Brain', 'Niki Parmar, Google Research'] }
    ], { 0: [{ start: 0, end: 14, label: 'author', field: 'name' }] });
    var p = document.querySelector('.is-author-body');
    var arr = [];
    for (var i = 0; i < p.children.length; i++) {
        var c = p.children[i];
        arr.push({ tag: c.tagName, cls: c.className, txt: (c.textContent || '').slice(0, 60) });
    }
    return JSON.stringify({ arr: arr });
})()
