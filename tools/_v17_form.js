return (function () {
    var det = window.ScholariusDetail;
    var fake = { id: 't', title: 'Efficient Estimation of Word Representations', author: 'Alice Smith, Bob Jones, Carol White', venueType: 'journal', year: '2015', fields: {} };
    det.open(fake);
    var title = document.getElementById('detail-title');
    var fields = document.getElementById('detail-fields');
    var rows = fields.querySelectorAll('.detail-field');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
        var lbl = rows[i].querySelector('.detail-field-label');
        var editBtn = rows[i].querySelector('.detail-field-edit');
        var valEl = rows[i].querySelector('.detail-field-value');
        var editor = rows[i].querySelector('.detail-field-editor');
        var inp = rows[i].querySelector('.detail-input');
        out.push({
            label: lbl ? lbl.textContent : '',
            hasEditIcon: !!editBtn,
            hasValueText: !!valEl,
            valuePreview: valEl ? valEl.textContent.slice(0, 40) : null,
            hasEditor: !!editor,
            editorHidden: editor ? editor.hidden : null,
            hasLegacyInput: !!inp
        });
    }
    return JSON.stringify({ title: title.textContent.trim(), rows: out });
})()
