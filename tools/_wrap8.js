return (function () {
    var r = window.ScholariusReader;
    r.__testRender([
        { line: 1, page: 1, text: 'AAA BBB CCC DDD', kind: '', lines: ['AAA BBB', 'CCC DDD'] }
    ], {});
    // 检查渲染后的块是否带 data-line 且有 lines
    var p = document.querySelector('[data-line="1"]');
    return JSON.stringify({
        found: !!p,
        cls: p ? p.className : null
    });
})()
