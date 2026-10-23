return (function () {
    var s = getSelection();
    if (!s.rangeCount) return JSON.stringify({ err: 'no range' });
    var r = s.getRangeAt(0);
    /* 尝试直接扩展选区到整个标题 */
    var node = r.startContainer;
    var txt = node.nodeValue || '';
    var start = txt.indexOf('Attention Is All You Need');
    if (start >= 0) {
        var nr = document.createRange();
        nr.setStart(node, start);
        nr.setEnd(node, start + 25);
        s.removeAllRanges();
        s.addRange(nr);
        return JSON.stringify({ sel: s.toString(), len: s.toString().length });
    }
    return JSON.stringify({ txt: txt.slice(0, 60), start: start });
})()
