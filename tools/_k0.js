return (function () {
    var t = window.ScholariusReader.getBlocks()[0].text;
    var keys = ['Attention Is All You Need', 'Ashish Vaswani', 'Abstract', 'The dominant sequence'];
    var arr = [];
    for (var i = 0; i < keys.length; i++) {
        arr.push(keys[i] + ' @ ' + t.indexOf(keys[i]));
    }
    arr.push('len=' + t.length);
    arr.push('autoEnd=' + t.indexOf('Abstract'));
    return arr.join('\n');
})()
