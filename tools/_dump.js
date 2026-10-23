return (function () {
    var b = window.ScholariusReader.getBlocks();
    var arr = [];
    for (var i = 0; i < b.length; i++) {
        var t = (b[i].text || '').replace(/\n/g, '\\n');
        arr.push(i + '|' + (b[i].lines ? b[i].lines.length : 0) + '|' + t.length + '|' + t.slice(0, 100));
    }
    return arr.join('\n');
})()
