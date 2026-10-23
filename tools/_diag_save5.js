return (function () {
    var det = window.ScholariusDetail;
    det.open({ id: 't2', title: 'Y', author: 'A, B', venueType: 'journal', year: '2015', fields: {} });
    var btn = document.getElementById('detail-save');
    btn.disabled = false;
    var b = window.ScholariusNative;
    var called = false;
    var orig = b.updateDoc;
    b.updateDoc = function () { called = true; };
    btn.click();
    b.updateDoc = orig;
    return JSON.stringify({ called: called, disabled: btn.disabled });
})()
