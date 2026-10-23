return (function () {
    if (!window.ScholariusReader) return JSON.stringify({ err: 'not ready' });
    var r = window.ScholariusReader;
    r.__testRender([{ line: 1, page: 1, text: 'Some body text here for testing labels', kind: '', lines: null }], {});
    var p = document.querySelector('.reader-para');
    var sel = window.getSelection();
    var rg = document.createRange();
    rg.selectNodeContents(p);
    sel.removeAllRanges();
    sel.addRange(rg);
    var acts = document.querySelectorAll('.sel-actions button');
    if (acts.length < 3) return JSON.stringify({ err: 'no actions' });
    acts[2].click();
    var list = document.getElementById('sheet-label-list');
    var cs = getComputedStyle(list);
    var item = list.querySelector('.sel-label-item');
    var ics = getComputedStyle(item);
    var rows = list.querySelectorAll('.sel-label-row');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
        var n = rows[i].querySelector('.sel-label-name');
        var tail = rows[i].querySelector('.sel-label-tail');
        out.push({ name: n ? n.textContent : '', tail: tail ? tail.textContent.trim() : '' });
    }
    return JSON.stringify({
        listBg: cs.backgroundColor,
        listBorder: cs.borderTopWidth,
        listShadow: cs.boxShadow,
        listRadius: cs.borderRadius,
        itemMinH: ics.minHeight,
        itemPad: ics.padding,
        itemRadius: ics.borderRadius,
        itemFontSize: ics.fontSize,
        rows: out
    });
})()
