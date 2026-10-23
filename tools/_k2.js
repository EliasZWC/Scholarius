return (function () {
    var body = document.getElementById('reader-body');
    body.scrollTop = 0;
    var p = document.querySelector('.reader-content > p[data-line="0"]');
    var w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = w.nextNode())) {
        var i = n.nodeValue.indexOf('Attention Is All You Need');
        if (i >= 0) {
            var r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 25);
            var rc = r.getBoundingClientRect();
            return JSON.stringify({
                x: Math.round(rc.x + rc.width / 2),
                y: Math.round(rc.y + rc.height / 2),
                w: Math.round(rc.width), h: Math.round(rc.height)
            });
        }
    }
    return JSON.stringify({ err: 'not found' });
})()
