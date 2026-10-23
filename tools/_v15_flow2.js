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
    acts[2].click();
    var list = document.getElementById('sheet-label-list');
    var rows = list.querySelectorAll('.sel-label-row');
    var authorRow = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].querySelector('.sel-label-caret')) { authorRow = rows[i]; break; }
    }
    authorRow.querySelector('.sel-label-item').click();
    var dd = document.querySelector('.sel-sub-dropdown');
    var opts = dd.querySelectorAll('.sel-sub-option');
    var target = null;
    for (var k = 0; k < opts.length; k++) {
        if (opts[k].textContent === 'Affiliation') { target = opts[k]; break; }
    }
    var ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    var rows2 = list.querySelectorAll('.sel-label-row');
    var ar2 = null;
    for (var m = 0; m < rows2.length; m++) {
        if (rows2[m].querySelector('.sel-label-caret')) { ar2 = rows2[m]; break; }
    }
    var val = ar2 ? ar2.querySelector('.sel-label-value') : null;
    return JSON.stringify({
        closed: !document.querySelector('.sel-sub-dropdown'),
        shownValue: val ? val.textContent : null,
        isSet: val ? val.classList.contains('is-set') : null,
        fullRowText: ar2 ? ar2.textContent.trim() : null
    });
})()
