return (function () {
    var list = document.getElementById('sheet-label-list');
    var dd = document.querySelector('.sel-sub-dropdown');
    if (!dd) return JSON.stringify({ err: 'no dd' });
    window.__log = [];
    var origRender = null;
    // 在 document 上记录事件序列
    ['pointerdown', 'pointerup', 'click'].forEach(function (type) {
        document.addEventListener(type, function (e) {
            var t = e.target;
            window.__log.push(type + ' -> ' + (t.tagName || '') + '.' + (t.className || ''));
        }, false);
    });
    var opts = dd.querySelectorAll('.sel-sub-option');
    var nameOpt = null;
    for (var i = 0; i < opts.length; i++) {
        if (opts[i].textContent === 'Name') { nameOpt = opts[i]; break; }
    }
    var rc = nameOpt.getBoundingClientRect();
    return JSON.stringify({
        nameOptY: Math.round(rc.y),
        beforeRows: Array.prototype.map.call(list.querySelectorAll('.sel-label-name'), function (n) { return n.textContent; })
    });
})()
