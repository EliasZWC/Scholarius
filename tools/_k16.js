return (function () {
    var p = document.querySelector('.reader-content > p[data-line="0"]');
    var out = [];
    var w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = w.nextNode())) out.push(n.nodeValue.slice(0, 40));
    return JSON.stringify({ count: out.length, nodes: out });
})()
