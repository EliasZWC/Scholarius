return (function () {
    var b = window.ScholariusNative;
    var called = false;
    var orig = b.updateDoc;
    b.updateDoc = function () { called = true; };
    var btn = document.getElementById('detail-save');
    btn.click();
    b.updateDoc = orig;
    return JSON.stringify({ called: called, disabledAfter: btn.disabled });
})()
