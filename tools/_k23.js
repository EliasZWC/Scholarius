return (function () {
    var ps = document.querySelectorAll('.reader-content > p');
    var out = [];
    for (var i = 0; i < ps.length; i++) {
        var t = ps[i].textContent || '';
        if (/Vaswani|Shazeer|Google Brain|Abstract|The dominant/.test(t)) {
            var r = ps[i].getBoundingClientRect();
            out.push({ line: ps[i].getAttribute('data-line'), y: Math.round(r.y), h: Math.round(r.height), txt: t.slice(0, 30) });
        }
    }
    return JSON.stringify(out);
})()
