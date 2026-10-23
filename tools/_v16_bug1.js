return (function () {
    if (!window.ScholariusReader) return JSON.stringify({ err: 'not ready' });
    var r = window.ScholariusReader;
    r.__testRender([{ line: 1, page: 1, text: 'Some body text here for testing', kind: '', lines: null }], {});
    var p = document.querySelector('.reader-para');
    var sel = window.getSelection();
    var rg = document.createRange();
    rg.selectNodeContents(p);
    sel.removeAllRanges();
    sel.addRange(rg);
    document.querySelectorAll('.sel-actions button')[2].click();

    var list = document.getElementById('sheet-label-list');
    var rows = list.querySelectorAll('.sel-label-row');
    var authorRow = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].querySelector('.sel-label-caret')) { authorRow = rows[i]; break; }
    }
    authorRow.querySelector('.sel-label-item').click();

    var dd = document.querySelector('.sel-sub-dropdown');
    var opts = dd.querySelectorAll('.sel-sub-option');
    var nameOpt = null;
    for (var k = 0; k < opts.length; k++) {
        if (/Name/.test(opts[k].textContent) && !/Not/.test(opts[k].textContent)) { nameOpt = opts[k]; break; }
    }
    if (!nameOpt) return JSON.stringify({ err: 'no name opt', all: Array.prototype.map.call(opts, function(o){return o.textContent;}) });

    var rc = nameOpt.getBoundingClientRect();
    var cx = Math.round(rc.x + rc.width / 2), cy = Math.round(rc.y + rc.height / 2);
    var mk = function (t) { return new PointerEvent(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'touch', isPrimary: true }); };

    nameOpt.dispatchEvent(mk('pointerdown'));

    // 模拟浏览器后续派发到“同一坐标下的新元素”
    var hit = document.elementFromPoint(cx, cy);
    if (hit) {
        hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    }

    var rows2 = list.querySelectorAll('.sel-label-row');
    var activeName = null, authorVal = null;
    for (var m = 0; m < rows2.length; m++) {
        var it = rows2[m].querySelector('.sel-label-item');
        if (it && it.classList.contains('is-active')) activeName = rows2[m].querySelector('.sel-label-name').textContent;
        var v = rows2[m].querySelector('.sel-label-value');
        if (v) authorVal = v.textContent;
    }
    return JSON.stringify({
        hitAfterClose: hit ? hit.tagName + '.' + hit.className : null,
        activeLabel: activeName,
        authorValue: authorVal,
        passed: activeName === 'Author' && authorVal === 'Name'
    });
})()
