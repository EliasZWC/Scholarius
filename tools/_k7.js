return (function () {
    var r = window.ScholariusReader;
    var d = r.dumpEdits ? r.dumpEdits() : null;
    return JSON.stringify({ labels: d ? d.labels : null });
})()
