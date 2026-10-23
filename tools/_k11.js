return (function () {
    var sh = document.getElementById('sheet-label');
    var r = sh.getBoundingClientRect();
    return JSON.stringify({
        open: sh.classList.contains('is-open'),
        y: Math.round(r.y), h: Math.round(r.height),
        vh: innerHeight,
        transform: getComputedStyle(sh).transform
    });
})()
