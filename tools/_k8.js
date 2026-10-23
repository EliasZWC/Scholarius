return (function () {
    var body = document.getElementById('reader-body');
    body.scrollTop = 0;
    var p = document.querySelector('.reader-content > p[data-line="0"]');
    var r = p.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: Math.round(r.y), bottom: Math.round(r.bottom) });
})()
