return (function () {
    var el = document.getElementById('sheet-label');
    el.hidden = false;
    el.classList.add('is-open');
    var list = document.getElementById('sheet-label-list');
    var cs = getComputedStyle(list);
    var row = list.querySelector('.sel-label-row');
    var item = list.querySelector('.sel-label-item');
    var ics = item ? getComputedStyle(item) : null;
    return JSON.stringify({
        listBg: cs.backgroundColor,
        listRadius: cs.borderRadius,
        listPad: cs.padding,
        listShadow: cs.boxShadow.slice(0, 40),
        rows: list.querySelectorAll('.sel-label-row').length,
        itemMinH: ics ? ics.minHeight : null,
        itemRadius: ics ? ics.borderRadius : null,
        itemPad: ics ? ics.padding : null
    });
})()
