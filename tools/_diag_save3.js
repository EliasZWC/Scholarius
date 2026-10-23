return (function () {
    var det = window.ScholariusDetail;
    det.open({ id: 't', title: 'X', author: 'A, B', venueType: 'journal', year: '2015', fields: {} });
    // 用一个确实不存在的 bridge 触发分支观察
    var b = window.ScholariusNative;
    var orig = b.updateDoc;
    var called = false;
    b.updateDoc = function () { called = true; };
    document.getElementById('detail-save').click();
    b.updateDoc = orig;
    return JSON.stringify({ called: called, draftNull: det.__draftNull, saveDisabled: document.getElementById('detail-save').disabled });
})()
