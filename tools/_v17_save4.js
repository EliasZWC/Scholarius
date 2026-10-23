return (function () {
    var b = window.ScholariusNative;
    var captured = null;
    var orig = b.updateDoc;
    b.updateDoc = function (id, json) { captured = { id: id, json: json }; };
    document.getElementById('detail-save').click();
    b.updateDoc = orig;
    return JSON.stringify({ captured: captured, toastErr: null });
})()
