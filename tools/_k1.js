return (function () {
    var blocks = window.ScholariusReader.getBlocks();
    var t = blocks[0].text;
    var keys = ['Attention Is All You Need', 'Ashish Vaswani', 'Google Brain', 'Abstract', 'The dominant sequence'];
    var arr = [];
    for (var i = 0; i < keys.length; i++) {
        arr.push(keys[i] + ' @ ' + t.indexOf(keys[i]));
    }
    arr.push('total len = ' + t.length);
    arr.push('');
    arr.push('--- 全文 ---');
    arr.push(t);
    return arr.join('\n');
})()
