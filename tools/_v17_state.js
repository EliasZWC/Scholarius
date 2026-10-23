return (function () {
    var det = window.ScholariusDetail;
    var btn = document.getElementById('reader-detail');
    var r = window.ScholariusReader;
    var fake = { id: 't', title: 'A Study of Things', author: 'Alice Smith, Bob Jones, Carol White', venueType: 'journal', year: '2015', fields: {} };
    det.open(fake);
    var afterOpen = btn.getAttribute('aria-expanded');
    det.close();
    var afterClose = btn.getAttribute('aria-expanded');
    var cs = getComputedStyle(btn).color;
    return JSON.stringify({ afterOpen: afterOpen, afterClose: afterClose, colorAfterClose: cs });
})()
