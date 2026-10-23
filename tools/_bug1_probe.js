return (function () {
    if (!window.ScholariusReader) return JSON.stringify({ err: 'not ready' });
    var r = window.ScholariusReader;
    r.__testRender([{ line: 1, page: 1, text: 'Some body text here for testing', kind: '', lines: null }], {});
    var p = document.querySelector('.reader-para');
    var sel = window.getSelection();
    var rg = document.createRange();
    rg.selectNodeContents(p);
    sel.removeAllRanges();
    sel.addRange(rg);
    var acts = document.querySelectorAll('.sel-actions button');
    acts[2].click();
    var list = document.getElementById('sheet-label-list');
    var rows = list.querySelectorAll('.sel-label-row');
    var authorRow = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].querySelector('.sel-label-caret')) { authorRow = rows[i]; break; }
    }
    authorRow.querySelector('.sel-label-item').click();
    var dd = document.querySelector('.sel-sub-dropdown');
    if (!dd) return JSON.stringify({ err: 'no dropdown' });
    var opts = dd.querySelectorAll('.sel-sub-option');
    var out = [];
    for (var k = 0; k < opts.length; k++) {
        var rc = opts[k].getBoundingClientRect();
        var cx = Math.round(rc.x + rc.width / 2);
        var cy = Math.round(rc.y + rc.height / 2);
        var hit = document.elementFromPoint(cx, cy);
        out.push({
            text: opts[k].textContent,
            y: Math.round(rc.y),
            hitTag: hit ? hit.tagName : null,
            hitCls: hit ? hit.className : null,
            hitIsOption: hit ? !!hit.closest('.sel-sub-option') : false
        });
    }
    return JSON.stringify({ listOverflow: getComputedStyle(list).overflowY, opts: out });
})()
