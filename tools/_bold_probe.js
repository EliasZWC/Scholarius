return new Promise(function (res) {
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;background:#fff;color:#000;' +
        'font-family:Georgia,"Times New Roman","Songti SC",SimSun,serif;z-index:99999;';
    host.innerHTML =
        '<span id="AAA" style="font-size:40px;font-weight:400">Hamburgefonstiv</span>' +
        '<br>' +
        '<span id="BBB" style="font-size:40px;font-weight:700">Hamburgefonstiv</span>' +
        '<br>' +
        '<span id="CCC" style="font-size:40px;font-weight:400;font-weight:900">Hamburgefonstiv</span>';
    document.body.appendChild(host);

    requestAnimationFrame(function () {
        var a = document.getElementById('AAA').getBoundingClientRect();
        var b = document.getElementById('BBB').getBoundingClientRect();
        var c = document.getElementById('CCC').getBoundingClientRect();
        host.remove();
        res(JSON.stringify({
            w400: Math.round(a.width),
            w700: Math.round(b.width),
            w900: Math.round(c.width),
            diff700: Math.round((b.width - a.width) * 100) / 100,
            diff900: Math.round((c.width - a.width) * 100) / 100
        }));
    });
});
