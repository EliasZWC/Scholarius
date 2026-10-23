(function () {
    var p = document.querySelector('[data-line="1"]');
    if (!p) return JSON.stringify({ err: 'no el' });
    var box = p.querySelector('.reader-author-box');
    var lines = box ? box.querySelectorAll('.reader-author-line') : [];
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var f = lines[i].querySelector('.reader-author-field');
        var v = lines[i].querySelector('.reader-author-value');
        out.push({
            field: f ? f.textContent : null,
            value: v ? v.textContent.slice(0, 70) : null,
            cls: lines[i].className
        });
    }
    return JSON.stringify({ count: out.length, lines: out });
})()
