return (function () {
    var s = 'Ashish Vaswani, Google Brain Niki Parmar, Google Research';
    var termB = 14;
    var lineBoundaries = [28, 57];
    var lineStop = -1;
    for (var i = 0; i < lineBoundaries.length; i++) {
        if (lineBoundaries[i] > termB) { lineStop = lineBoundaries[i]; break; }
    }
    var joinEnd = lineStop < 0 ? termB : Math.min(lineStop, s.length);
    return JSON.stringify({
        lineStop: lineStop,
        joinEnd: joinEnd,
        joined: s.slice(termB, joinEnd),
        rest: s.slice(joinEnd)
    });
})()
