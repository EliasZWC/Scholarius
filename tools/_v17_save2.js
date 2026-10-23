return (function () {
    var det = window.ScholariusDetail;
    det.open({ id: 't', title: 'X', author: 'Alice Smith, Bob Jones', venueType: 'journal', year: '2015', fields: {} });
    var fields = document.getElementById('detail-fields');
    var rows = fields.querySelectorAll('.detail-field');
    var authorRow = null;
    for (var i = 0; i < rows.length; i++) {
        var l = rows[i].querySelector('.detail-field-label');
        if (l && l.textContent === 'Author') { authorRow = rows[i]; break; }
    }
    var btn = authorRow.querySelector('.detail-field-edit');
    btn.click();
    var editor = authorRow.querySelector('.detail-field-editor');
    editor.value = 'Alice Smith\nBob Jones\nCarol White';
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    var b = window.ScholariusNative;
    var captured = null;
    var orig = b.updateDoc;
    b.updateDoc = function (id, json) { captured = json; };
    document.getElementById('detail-save').click();
    b.updateDoc = orig;
    var out = captured ? JSON.parse(captured) : null;
    return JSON.stringify({ author: out ? out.author : null });
})()
