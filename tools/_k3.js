return (function () {
    var p = document.querySelector('.reader-content > p[data-line="0"]');
    return JSON.stringify({ html: p.innerHTML.slice(0, 320) });
})()
