return (function () {
    var r = window.ScholariusReader;
    r.__testRender([{ line: 1, page: 1, text: 'Another body text', kind: '', lines: null }], {});
    var p = document.querySelector('.reader-para');
    var sel = window.getSelection();
    var rg = document.createRange();
    rg.selectNodeContents(p);
    sel.removeAllRanges();
    sel.addRange(rg);
    document.querySelectorAll('.sel-actions button')[2].click();

    var list = document.getElementById('sheet-label-list');
    var rows = list.querySelectorAll('.sel-label-row');
    var authorRow = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].querySelector('.sel-label-caret')) { authorRow = rows[i]; break; }
    }
    var val = authorRow.querySelector('.sel-label-value');
    var cs = getComputedStyle(val);
    var caret = authorRow.querySelector('.sel-label-caret');
    var svg = caret.querySelector('svg');
    var ccs = getComputedStyle(caret);

    // 展开看图标是否换成 up
    authorRow.querySelector('.sel-label-item').click();
    var rows2 = list.querySelectorAll('.sel-label-row');
    var ar2 = null;
    for (var j = 0; j < rows2.length; j++) {
        if (rows2[j].querySelector('.sel-label-caret')) { ar2 = rows2[j]; break; }
    }
    var caret2 = ar2.querySelector('.sel-label-caret');
    var svg2 = caret2.querySelector('svg');

    return JSON.stringify({
        defaultValue: val.textContent,
        valueColor: cs.color,
        valueFontSize: cs.fontSize,
        caretHasSvg: !!svg,
        caretViewBox: svg ? svg.getAttribute('viewBox') : null,
        caretSize: ccs.width + 'x' + ccs.height,
        caretColor: ccs.color,
        caretTransformWhenOpen: getComputedStyle(caret2).transform,
        expandedPath: svg2 ? svg2.querySelector('path').getAttribute('d').slice(0, 22) : null
    });
})()
