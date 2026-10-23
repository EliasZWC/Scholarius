return (function () {
    var fields = document.getElementById('detail-fields');
    var rows = fields.querySelectorAll('.detail-field');
    var authorRow = null;
    for (var i = 0; i < rows.length; i++) {
        var l = rows[i].querySelector('.detail-field-label');
        if (l && l.textContent === 'Author') { authorRow = rows[i]; break; }
    }
    var btn = authorRow.querySelector('.detail-field-edit');
    btn.click();
    // 打开编辑块后，值应该仍是换行形式
    var editor = authorRow.querySelector('.detail-field-editor');
    var editorText = editor.value;
    btn.click();
    return JSON.stringify({ editorText: editorText });
})()
