return (function () {
    var dd = document.querySelector('.sel-sub-dropdown');
    var list = document.getElementById('sheet-label-list');
    if (!dd) return JSON.stringify({ err: 'no dd' });
    var dr = dd.getBoundingClientRect();
    var lr = list.getBoundingClientRect();
    var rows = list.querySelectorAll('.sel-label-row');
    var names = [];
    for (var i = 0; i < rows.length; i++) {
        var n = rows[i].querySelector('.sel-label-name');
        var rr = rows[i].getBoundingClientRect();
        names.push({ name: n ? n.textContent : '', y: Math.round(rr.y), h: Math.round(rr.height) });
    }
    return JSON.stringify({
        dropRect: { y: Math.round(dr.y), h: Math.round(dr.height), bottom: Math.round(dr.bottom) },
        listRect: { y: Math.round(lr.y), h: Math.round(lr.height), bottom: Math.round(lr.bottom) },
        dropInsideList: dr.bottom <= lr.bottom,
        rows: names
    });
})()
