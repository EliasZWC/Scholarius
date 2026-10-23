return (function () {
    var list = document.getElementById('sheet-label-list');
    var rows = list.querySelectorAll('.sel-label-row');
    var authorRow = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].querySelector('.sel-label-caret')) { authorRow = rows[i]; break; }
    }
    if (!authorRow) return JSON.stringify({ err: 'no author row' });
    // 点整行（不是点箭头）
    authorRow.querySelector('.sel-label-item').click();
    var dd = document.querySelector('.sel-sub-dropdown');
    var opened = !!dd;
    var opts = dd ? dd.querySelectorAll('.sel-sub-option') : [];
    var optTexts = [];
    for (var j = 0; j < opts.length; j++) optTexts.push(opts[j].textContent);
    // 选“单位”
    var target = null;
    for (var k = 0; k < opts.length; k++) {
        if (opts[k].textContent === '单位') { target = opts[k]; break; }
    }
    if (target) target.click();
    var rows2 = list.querySelectorAll('.sel-label-row');
    var ar2 = null;
    for (var m = 0; m < rows2.length; m++) {
        if (rows2[m].querySelector('.sel-label-caret')) { ar2 = rows2[m]; break; }
    }
    var val = ar2 ? ar2.querySelector('.sel-label-value') : null;
    return JSON.stringify({
        openedByRowClick: opened,
        options: optTexts,
        closedAfterPick: !document.querySelector('.sel-sub-dropdown'),
        shownValue: val ? val.textContent : null,
        valueIsSet: val ? val.classList.contains('is-set') : null
    });
})()
