return (function () {
    var p = document.querySelector('.reader-content > p[data-line="0"]');
    var w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = w.nextNode())) {
        if (n.nodeValue.indexOf('Ashish Vaswani') >= 0) {
            var s = getSelection();
            var r = document.createRange();
            r.setStart(n, 0);
            r.setEnd(n, n.nodeValue.length);
            s.removeAllRanges(); s.addRange(r);
            return JSON.stringify({ selLen: s.toString().length, sel: s.toString().slice(0, 50) });
        }
    }
    return JSON.stringify({ err: 'no node' });
})()
