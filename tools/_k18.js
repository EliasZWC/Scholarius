return (function () {
    var paras = document.querySelectorAll('.reader-content > p');
    var out = [];
    for (var i = 0; i < Math.min(paras.length, 6); i++) {
        out.push({ line: paras[i].getAttribute('data-line'), cls: paras[i].className, txt: (paras[i].textContent || '').slice(0, 40) });
    }
    return JSON.stringify({ total: paras.length, first: out });
})()
