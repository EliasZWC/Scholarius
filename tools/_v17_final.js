return (function () {
    var b = window.ScholariusNative;
    if (b && b.finishSplash) b.finishSplash();
    var det = window.ScholariusDetail;
    det.open({ id: 't', title: 'X', author: 'A, B', venueType: 'journal', year: '2015', fields: {} });
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
    var captured = null;
    var orig = b.updateDoc;
    b.updateDoc = function (id, json) { captured = json; };
    var btn = document.getElementById('detail-save');
    var disabledBefore = btn.disabled;
    btn.click();
    b.updateDoc = orig;
    return JSON.stringify({
        disabledBefore: disabledBefore,
        captured: !!captured,
        author: captured ? JSON.parse(captured).author : null
    });
})()
