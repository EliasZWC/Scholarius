return (function () {
    var dd = document.querySelector('.sel-sub-dropdown');
    var cs = getComputedStyle(dd);
    var opts = dd.querySelectorAll('.sel-sub-option');
    var o0 = getComputedStyle(opts[0]);
    var parentStack = [];
    var el = dd.parentElement;
    while (el && el.id !== 'reader') {
        parentStack.push({
            tag: el.tagName, id: el.id, cls: el.className,
            overflow: getComputedStyle(el).overflow,
            zIndex: getComputedStyle(el).zIndex,
            pos: getComputedStyle(el).position
        });
        el = el.parentElement;
    }
    return JSON.stringify({
        dd: { pos: cs.position, z: cs.zIndex, bg: cs.backgroundColor, opacity: cs.opacity, vis: cs.visibility, display: cs.display },
        opt: { color: o0.color, bg: o0.backgroundColor, opacity: o0.opacity, vis: o0.visibility },
        parents: parentStack
    });
})()
