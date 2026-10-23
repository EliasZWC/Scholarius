return (function () {
    var list = document.getElementById('sheet-label-list');
    var rows = list.querySelectorAll('.sel-label-row');
    for (var i = 0; i < rows.length; i++) {
        var caret = rows[i].querySelector('.sel-label-caret');
        if (caret) continue;
        var btn = rows[i].querySelector('.sel-label-item');
        btn.click();
        var same = list.querySelectorAll('.sel-label-row')[i];
        var chk = same.querySelector('.sel-label-check');
        return JSON.stringify({
            rowName: same.querySelector('.sel-label-name').textContent,
            hasCheck: !!chk,
            tailText: same.querySelector('.sel-label-tail').textContent.trim()
        });
    }
    return JSON.stringify({ err: 'no plain row' });
})()
