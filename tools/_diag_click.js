return (function () {
    var r = window.ScholariusReader;
    if (!r) return JSON.stringify({ err: 'not ready' });
    r.__testRender([{ line: 1, page: 1, text: 'Timing probe body', kind: '', lines: null }], {});
    var p = document.querySelector('.reader-para');
    var sel = window.getSelection();
    var rg = document.createRange();
    rg.selectNodeContents(p);
    sel.removeAllRanges();
    sel.addRange(rg);
    document.querySelectorAll('.sel-actions button')[2].click();

    var list = document.getElementById('sheet-label-list');
    var findAuthor = function () {
        var rs = list.querySelectorAll('.sel-label-row');
        for (var i = 0; i < rs.length; i++) if (rs[i].querySelector('.sel-label-caret')) return rs[i];
        return null;
    };
    findAuthor().querySelector('.sel-label-item').click();
    var dd = document.querySelector('.sel-sub-dropdown');
    if (!dd) return JSON.stringify({ err: 'no dd' });
    var opts = dd.querySelectorAll('.sel-sub-option');
    var nameOpt = null;
    for (var k = 0; k < opts.length; k++) {
        if (opts[k].textContent === 'Name') { nameOpt = opts[k]; break; }
    }
    var rc = nameOpt.getBoundingClientRect();
    var cx = Math.round(rc.x + rc.width / 2), cy = Math.round(rc.y + rc.height / 2);

    // 记录真实冒泡阶段的 click 是否到达标签行
    window.__clicks = [];
    document.addEventListener('click', function (e) {
        window.__clicks.push((e.target.className || e.target.tagName) + '@bubble');
    }, false);

    var mkP = function (t) { return new PointerEvent(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'touch', isPrimary: true }); };
    var mkM = function (t) { return new MouseEvent(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy }); };

    nameOpt.dispatchEvent(mkP('pointerdown'));
    var hitAfter = document.elementFromPoint(cx, cy);
    if (hitAfter) {
        hitAfter.dispatchEvent(mkP('pointerup'));
        hitAfter.dispatchEvent(mkM('mouseup'));
        hitAfter.dispatchEvent(mkM('click'));
    }

    var rows = list.querySelectorAll('.sel-label-row');
    var act = null, val = null;
    for (var m = 0; m < rows.length; m++) {
        var it = rows[m].querySelector('.sel-label-item');
        if (it && it.classList.contains('is-active')) act = rows[m].querySelector('.sel-label-name').textContent;
        var v = rows[m].querySelector('.sel-label-value');
        if (v) val = v.textContent;
    }
    return JSON.stringify({ hitAfterClose: hitAfter ? hitAfter.className : null, clicks: window.__clicks, active: act, value: val });
})()
