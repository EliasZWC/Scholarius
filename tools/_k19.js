return (function () {
    var api = window.ScholariusReader;
    return JSON.stringify({ keys: Object.keys(api).filter(function (k) { return /label|clear|reset/i.test(k); }) });
})()
