return (function () {
    var b = window.ScholariusNative;
    var called = false;
    var orig = b.updateDoc;
    b.updateDoc = function () { called = true; };
    document.getElementById('detail-save').click();
    b.updateDoc = orig;
    return JSON.stringify({ called: called, disabled: document.getElementById('detail-save').disabled });
})()
