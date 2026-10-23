return (function () {
    var b = window.ScholariusNative;
    var det = window.ScholariusDetail;
    det.open({ id: 't', title: 'X', author: 'A, B', venueType: 'journal', year: '2015', fields: {} });
    var saveBtn = document.getElementById('detail-save');
    var out = { disabledBefore: saveBtn.disabled, onclickPresent: !!saveBtn.onclick };
    var listeners = getEventListeners ? 'n/a' : 'n/a';
    // 直接看按钮是否绑定
    saveBtn.click();
    out.disabledAfter = saveBtn.disabled;
    return JSON.stringify(out);
})()
