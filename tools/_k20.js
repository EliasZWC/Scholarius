return (function () {
    var ps = document.querySelectorAll('.reader-content > p');
    for (var i = 0; i < ps.length; i++) {
        if ((ps[i].textContent || '').indexOf('Vaswani') === 0) {
            var n = ps[i].firstChild;
            var s = getSelection(); s.removeAllRanges();
            return JSON.stringify({ cls: ps[i].className, nodeType: n.nodeType, txt: n.nodeValue });
        }
    }
    return JSON.stringify({ err: 'none' });
})()
