return (function () {
    var det = window.ScholariusDetail;
    det.open({ id: 't2', title: 'X', author: 'A, B', venueType: 'journal', year: '2015', fields: {} });
    var fields = document.getElementById('detail-fields');
    var rs = fields.querySelectorAll('.detail-field');
    var btn = null;
    for (var i = 0; i < rs.length; i++) {
        var l = rs[i].querySelector('.detail-field-label');
        if (l && l.textContent === 'Author') { btn = rs[i].querySelector('.detail-field-edit'); break; }
    }
    btn.click();
    var s = document.querySelector('.import-sheet');
    var cs = getComputedStyle(s);
    return JSON.stringify({
        sheetCls: s.className,
        transform: cs.transform,
        pointerEvents: cs.pointerEvents,
        isOpen: window.ScholariusImport.isOpen(),
        detailPageZ: getComputedStyle(document.getElementById('detail-page')).zIndex
    });
})()
