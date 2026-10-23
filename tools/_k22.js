return (function () {
    var p = document.querySelector('.reader-content > p[data-line="0"]');
    var n = p.firstChild;
    var s = getSelection();
    var r = document.createRange();
    r.setStart(n, 0);
    r.setEnd(n, n.nodeValue.length);
    s.removeAllRanges(); s.addRange(r);
    return JSON.stringify({ sel: s.toString() });
})()
