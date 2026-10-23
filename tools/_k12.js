return (function () {
    var rows = document.querySelectorAll('.sel-label-row');
    for (var i = 0; i < rows.length; i++) {
        var n = rows[i].querySelector('.sel-label-name');
        if (n && n.textContent === 'Title') {
            var r = rows[i].getBoundingClientRect();
            return JSON.stringify({ y: Math.round(r.y + r.height / 2), x: Math.round(r.x + r.width / 2), vh: innerHeight });
        }
    }
    return JSON.stringify({ err: 'no title' });
})()
