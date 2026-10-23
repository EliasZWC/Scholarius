return (function () {
    var dd = document.querySelector('.sel-sub-dropdown');
    if (!dd) return JSON.stringify({ err: 'no dd' });
    var opts = dd.querySelectorAll('.sel-sub-option');
    var nameOpt = null;
    for (var i = 0; i < opts.length; i++) {
        if (opts[i].textContent === 'Name') { nameOpt = opts[i]; break; }
    }
    var rc = nameOpt.getBoundingClientRect();
    var cx = Math.round(rc.x + rc.width / 2), cy = Math.round(rc.y + rc.height / 2);
    window.__log = [];
    var mk = function (type) {
        return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'touch', isPrimary: true });
    };
    nameOpt.dispatchEvent(mk('pointerdown'));
    var afterPD = {
        dropdownStillOpen: !!document.querySelector('.sel-sub-dropdown'),
        authorValue: (function () {
            var rows = document.querySelectorAll('.sel-label-row');
            for (var i = 0; i < rows.length; i++) {
                var v = rows[i].querySelector('.sel-label-value');
                if (v) return v.textContent;
            }
            return null;
        })()
    };
    var hitAfter = document.elementFromPoint(cx, cy);
    return JSON.stringify({
        afterPointerDown: afterPD,
        hitAtSamePoint: hitAfter ? hitAfter.tagName + '.' + hitAfter.className : null,
        log: window.__log
    });
})()
