return (function () {
    var flat = 'Ashish Vaswani, Google Brain Niki Parmar, Google Research';
    var lines = ['Ashish Vaswani, Google Brain', 'Niki Parmar, Google Research'];
    var scan = 0, arr = [];
    for (var i = 0; i < lines.length; i++) {
        var row = String(lines[i] || '').replace(/^\s+|\s+$/g, '');
        if (!row) continue;
        var at = flat.indexOf(row, scan);
        arr.push({ row: row.slice(0, 20), at: at, end: at + row.length });
        scan = at + row.length;
    }
    return JSON.stringify({ flatLen: flat.length, bounds: arr });
})()
