return (function () {
    var r = window.ScholariusReader;
    r.__testRender([{ line: 1, page: 1, text: 'Third body text sample', kind: '', lines: null }], {});
    var p = document.querySelector('.reader-para');
    var sel = window.getSelection();
    var rg = document.createRange();
    rg.selectNodeContents(p);
    sel.removeAllRanges();
    sel.addRange(rg);
    document.querySelectorAll('.sel-actions button')[2].click();

    var list = document.getElementById('sheet-label-list');
    var findAuthor = function () {
        var rs = list.querySelectorAll('.sel-label-row');
        for (var i = 0; i < rs.length; i++) {
            if (rs[i].querySelector('.sel-label-caret')) return rs[i];
        }
        return null;
    };
    findAuthor().querySelector('.sel-label-item').click();
    var dd = document.querySelector('.sel-sub-dropdown');
    if (!dd) return JSON.stringify({ err: 'dropdown did not open' });
    var opts = dd.querySelectorAll('.sel-sub-option');
    var noneOpt = opts[0];
    var noneLabel = noneOpt.textContent;
    var rc = noneOpt.getBoundingClientRect();
    var cx = Math.round(rc.x + rc.width / 2), cy = Math.round(rc.y + rc.height / 2);
    noneOpt.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'touch', isPrimary: true }));

    var ar2 = findAuthor();
    var v = ar2.querySelector('.sel-label-value');
    return JSON.stringify({
        noneOptionLabel: noneLabel,
        shownAfterPick: v ? v.textContent : null,
        closed: !document.querySelector('.sel-sub-dropdown'),
        match: noneLabel === (v ? v.textContent : null)
    });
})()
