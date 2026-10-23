return (function () {
    var p = document.querySelector('.reader-content > p[data-line="0"]');
    return JSON.stringify({ cls: p.className, len: (p.textContent || '').length, head: (p.textContent || '').slice(0, 60) });
})()
