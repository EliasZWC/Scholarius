return (function () {
    var fields = document.getElementById('detail-fields');
    var rows = fields.querySelectorAll('.detail-field');
    var authorRow = null;
    for (var i = 0; i < rows.length; i++) {
        var l = rows[i].querySelector('.detail-field-label');
        if (l && l.textContent === 'Author') { authorRow = rows[i]; break; }
    }
    if (!authorRow) return JSON.stringify({ err: 'no author row' });
    var btn = authorRow.querySelector('.detail-field-edit');
    var editor = authorRow.querySelector('.detail-field-editor');
    var valEl = authorRow.querySelector('.detail-field-value');
    var before = { hidden: editor.hidden, value: editor.value, expanded: btn.getAttribute('aria-expanded') };
    btn.click();
    var afterOpen = {
        hidden: editor.hidden,
        value: editor.value,
        expanded: btn.getAttribute('aria-expanded'),
        isEditing: authorRow.classList.contains('is-editing'),
        height: editor.style.height
    };
    // 模拟编辑：加一个作者
    editor.value = 'Alice Smith\nBob Jones\nCarol White\nDave Brown';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    var afterClose = { hidden: editor.hidden, display: valEl.textContent };
    return JSON.stringify({ before: before, afterOpen: afterOpen, afterClose: afterClose });
})()
