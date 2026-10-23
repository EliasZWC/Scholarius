return (function () {
    var p = document.querySelector('.reader-content > p[data-line="0"]');
    var s = getSelection();
    var rg = document.createRange();
    rg.selectNodeContents(p);
    s.removeAllRanges(); s.addRange(rg);
    var acts = document.querySelectorAll('.sel-actions button');
    if (acts.length < 3) return JSON.stringify({ err: 'no acts', n: acts.length, sel: s.toString().slice(0, 30) });
    acts[2].click();
    return JSON.stringify({ opened: true, sel: s.toString().slice(0, 40) });
})()
