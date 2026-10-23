return (function () {
    var list = document.getElementById('sheet-label-list');
    var rows = list.querySelectorAll('.sel-label-row');
    var ar = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].querySelector('.sel-label-caret')) { ar = rows[i]; break; }
    }
    var val = ar.querySelector('.sel-label-value');
    var caret = ar.querySelector('.sel-label-caret');
    var vs = getComputedStyle(val);
    var cs = getComputedStyle(caret);
    var svg = caret.querySelector('svg');
    var svgs = svg ? getComputedStyle(svg) : null;
    return JSON.stringify({
        defaultValue: val.textContent,
        valueColor: vs.color,
        valueFontSize: vs.fontSize,
        caretColor: cs.color,
        caretW: cs.width,
        caretH: cs.height,
        svgW: svgs ? svgs.width : null,
        svgH: svgs ? svgs.height : null,
        svgFill: svgs ? svgs.fill : null
    });
})()
