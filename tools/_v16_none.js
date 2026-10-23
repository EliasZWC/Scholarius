return (function () {
    var list = document.getElementById('sheet-label-list');
    var rows = list.querySelectorAll('.sel-label-row');
    var ar = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].querySelector('.sel-label-caret')) { ar = rows[i]; break; }
    }
    // 展开下拉，点 “Not set”
    ar.querySelector('.sel-label-item').click();
    var dd = document.querySelector('.sel-sub-dropdown');
    var opts = dd.querySelectorAll('.sel-sub-option');
    var noneOpt = opts[0];
    var label = noneOpt.textContent;
    var rc = noneOpt.getBoundingClientRect();
    var cx = Math.round(rc.x + rc.width / 2), cy = Math.round(rc.y + rc.height / 2);
    noneOpt.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'touch', isPrimary: true }));
    var rows2 = list.querySelectorAll('.sel-label-row');
    var ar2 = null;
    for (var j = 0; j < rows2.length; j++) {
        if (rows2[j].querySelector('.sel-label-caret')) { ar2 = rows2[j]; break; }
    }
    var v = ar2.querySelector('.sel-label-value');
    return JSON.stringify({
        noneOptionLabel: label,
        shownAfterPick: v ? v.textContent : null,
        closed: !document.querySelector('.sel-sub-dropdown')
    });
})()
