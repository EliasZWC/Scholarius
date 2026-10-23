return (function () {
    var det = window.ScholariusDetail;
    det.open({ id: 't4', title: 'X', author: 'A, B', venueType: 'journal', year: '2015', fields: {} });
    var fields = document.getElementById('detail-fields');
    var rows = fields.querySelectorAll('.detail-field');
    for (var i = 0; i < rows.length; i++) {
        var l = rows[i].querySelector('.detail-field-label');
        if (l && l.textContent === 'Author') {
            rows[i].querySelector('.detail-field-edit').click();
            var ed = rows[i].querySelector('.detail-field-editor');
            ed.value = 'Alice Smith\nBob Jones\nCarol White';
            ed.dispatchEvent(new Event('input', { bubbles: true }));
            break;
        }
    }
    // 直接用 toMarkdown 之外的路径读 draft：通过再次打开编辑块观察
    var rows2 = fields.querySelectorAll('.detail-field');
    var ar2 = null;
    for (var j = 0; j < rows2.length; j++) {
        var l2 = rows2[j].querySelector('.detail-field-label');
        if (l2 && l2.textContent === 'Author') { ar2 = rows2[j]; break; }
    }
    var valEl = ar2.querySelector('.detail-field-value');
    return JSON.stringify({ displayed: valEl.textContent });
})()
