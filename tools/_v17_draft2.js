return (function () {
    var det = window.ScholariusDetail;
    det.open({ id: 't5', title: 'X', author: 'A, B', venueType: 'journal', year: '2015', fields: {} });
    var fields = document.getElementById('detail-fields');
    var findRow = function () {
        var rs = fields.querySelectorAll('.detail-field');
        for (var i = 0; i < rs.length; i++) {
            var l = rs[i].querySelector('.detail-field-label');
            if (l && l.textContent === 'Author') return rs[i];
        }
        return null;
    };
    var row = findRow();
    row.querySelector('.detail-field-edit').click();      // 展开
    var ed = row.querySelector('.detail-field-editor');
    ed.value = 'Alice Smith\nBob Jones\nCarol White';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    findRow().querySelector('.detail-field-edit').click(); // 收起 -> refresh()
    var after = findRow().querySelector('.detail-field-value').textContent;
    return JSON.stringify({ after: after, lines: after.split('\n').length });
})()
