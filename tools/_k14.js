return (function () {
    var t = window.ScholariusReader.getBlocks()[0].text;
    var authorStart = 26;
    var abstractAt = t.indexOf('Abstract');
    return JSON.stringify({
        authorStart: authorStart,
        authorEnd: abstractAt,
        authorText: t.slice(authorStart, abstractAt),
        abstractAt: abstractAt
    });
})()
