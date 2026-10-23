return (function () {
    var blk = document.querySelector('.reader-block[data-block="0"]') || document.querySelector('.reader-content > p[data-line="0"]').parentElement;
    var kids = blk.children;
    var out = [];
    for (var i = 0; i < kids.length; i++) {
        out.push({ tag: kids[i].tagName, cls: kids[i].className, txt: (kids[i].textContent || '').slice(0, 35) });
    }
    return JSON.stringify({ n: kids.length, kids: out });
})()
