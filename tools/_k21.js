return (function () {
    var ab = document.querySelector('.sel-actions');
    if (!ab) return JSON.stringify({ err: 'no action bar' });
    var btns = ab.querySelectorAll('button');
    var out = [];
    for (var i = 0; i < btns.length; i++) out.push({ i: i, title: btns[i].getAttribute('title') || btns[i].getAttribute('aria-label') || '', html: btns[i].innerHTML.slice(0, 40) });
    return JSON.stringify(out);
})()
