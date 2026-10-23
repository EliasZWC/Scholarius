return (function () {
    var det = window.ScholariusDetail;
    det.open({ id: 't', title: 'X', author: 'A, B', venueType: 'journal', year: '2015', fields: {} });
    var saveBtn = document.getElementById('detail-save');
    var before = saveBtn.disabled;
    saveBtn.click();
    var after = saveBtn.disabled;
    return JSON.stringify({ before: before, after: after, wentThrough: after === true });
})()
