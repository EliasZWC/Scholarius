return (function () {
    var r = window.ScholariusReader;
    r.open({ id: 't3', title: 'T3' });
    r.__testRender([
        { line: 0, page: 1, text: 'Ashish Vaswani, Google Brain Niki Parmar', kind: '', lines: ['Ashish Vaswani, Google Brain', 'Niki Parmar'] }
    ], { 0: [{ start: 0, end: 14, label: 'author', field: 'name' }] });
    var e = r.dumpEdits ? r.dumpEdits() : null;
    return JSON.stringify({ edits: e });
})()
