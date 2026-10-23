return (function () {
    var list = document.getElementById('sheet-label-list');
    var rows = list.querySelectorAll('.sel-label-row');
    var tg = null;
    for (var i = 0; i < rows.length; i++) {
        var t = rows[i].querySelector('.sel-label-sub-toggle');
        if (t) { tg = t; break; }
    }
    if (!tg) return JSON.stringify({ err: 'no toggle' });
    tg.click();
    var dd = document.querySelector('.sel-sub-dropdown');
    var rr = tg.closest('.sel-label-row').getBoundingClientRect();
    var dr = dd ? dd.getBoundingClientRect() : null;
    var opts = dd ? dd.querySelectorAll('.sel-sub-option') : [];
    return JSON.stringify({
        opened: !!dd,
        gap: dr ? Math.round(dr.y - rr.bottom) : null,
        opts: opts.length,
        inRow: dd ? dd.parentNode.classList.contains('sel-label-row') : null
    });
})()
