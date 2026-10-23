return (function () {
    var acts = document.querySelectorAll('.sel-actions button');
    if (acts.length < 3) return JSON.stringify({ err: 'no acts', n: acts.length });
    acts[2].click();
    var rows = document.querySelectorAll('.sel-label-row');
    var arr = [];
    for (var i = 0; i < rows.length; i++) {
        var n = rows[i].querySelector('.sel-label-name');
        var r = rows[i].getBoundingClientRect();
        arr.push({ t: n ? n.textContent : '', y: Math.round(r.y + r.height / 2) });
    }
    return JSON.stringify({ sel: getSelection().toString().slice(0, 30), rows: arr });
})()
