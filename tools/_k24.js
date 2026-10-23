return (function () {
    // 把块0 从"碎片渲染"退回整体：先看有没有可用的重渲染入口
    var api = window.ScholariusReader;
    return JSON.stringify(Object.keys(api));
})()
