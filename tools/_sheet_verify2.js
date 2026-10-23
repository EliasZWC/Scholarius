return (function () {
    var r = window.ScholariusReader;
    var text = 'Some body text here';
    r.__testRender([{ line: 1, page: 1, text: text, kind: '', lines: null }], {});
    var p = document.querySelector('.reader-para');
    var sel = window.getSelection();
    var rg = document.createRange();
    rg.selectNodeContents(p);
    sel.removeAllRanges();
    sel.addRange(rg);
    var acts = document.querySelectorAll('.sel-actions button');
    if (acts.length < 3) return JSON.stringify({ err: 'no actions', n: acts.length });
    acts[2].click();
    var list = document.getElementById('sheet-label-list');
    var item = list.querySelector('.sel-label-item');
    var ics = item ? getComputedStyle(item) : null;
    var rows = list.querySelectorAll('.sel-label-row');
    var check = list.querySelector('.sel-label-check');
    return JSON.stringify({
        rows: rows.length,
        itemMinH: ics ? ics.minHeight : null,
        itemRadius: ics ? ics.borderRadius : null,
        itemPad: ics ? ics.padding : null,
        itemFontSize: ics ? ics.fontSize : null,
        hasCheck: !!check,
        activeWeight: (function () {
            var a = list.querySelector('.sel-label-item.is-active');
            return a ? getComputedStyle(a).fontWeight : null;
        })(),
        activeBg: (function () {
            var a = list.querySelector('.sel-label-item.is-active');
            return a ? getComputedStyle(a).backgroundColor : null;
        })()
    });
})()
