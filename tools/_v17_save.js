return (function () {
    // 拦截 updateDoc，看提交的 patch
    var b = window.ScholariusNative;
    var captured = null;
    var orig = b.updateDoc;
    b.updateDoc = function (id, json) { captured = json; };
    var saveBtn = document.getElementById('detail-save');
    if (!saveBtn) {
        var btns = document.querySelectorAll('#detail-page button');
        for (var i = 0; i < btns.length; i++) {
            if (/save/i.test(btns[i].id || '') || /Save/.test(btns[i].textContent)) { saveBtn = btns[i]; break; }
        }
    }
    if (saveBtn) saveBtn.click();
    var out = captured ? JSON.parse(captured) : null;
    b.updateDoc = orig;
    return JSON.stringify({ author: out ? out.author : null, title: out ? out.title : null });
})()
