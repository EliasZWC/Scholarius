/*
  验证 v0.2.4：编辑里敲空行 → 必须变成多个正文段（多个编号、多条提示条）

  用 __testApplyEdit 直接喂数据，绕开真实编辑表单。

  复现原始 bug：
    一个块文本里原本就有两段（用空行隔开），用户再编辑一次 ——
    旧代码只写 edits[line]，块数不变 → 编号仍是一个。
*/
(function () {
    var R = window.ScholariusReader;
    var out = [];
    function log(s) { out.push(String(s)); }

    function mkBlocks(texts) {
        var bs = [];
        for (var i = 0; i < texts.length; i++) {
            bs.push({ line: i, page: 1, text: texts[i], kind: '', level: 0 });
        }
        return bs;
    }

    function bodyNos() {
        var arr = [];
        var all = document.querySelectorAll('[data-body-no]');
        for (var i = 0; i < all.length; i++) {
            arr.push(all[i].getAttribute('data-body-no'));
        }
        return arr.length + ' [' + arr.join(',') + ']';
    }

    function blockCount() {
        var bs = R.getBlocks();
        return bs ? bs.length : -1;
    }

    // ── 场景 A：单块内容里含空行（三段）─────────────────────────
    R.setMd('v024-a', mkBlocks(['第一段甲。', '原有的一段。', '尾段丙。']));
    log('A.before blocks=' + blockCount() + ' bodyNos=' + bodyNos());

    R.__testApplyEdit(
        { single: true, line: 1, lines: [1], start: 0, end: 5 },
        '拆开来的甲段。\n\n拆开来的乙段。\n\n拆开来的丙段。'
    );
    log('A.after  blocks=' + blockCount() + ' bodyNos=' + bodyNos());

    // ── 场景 B：普通改几个字，不该触发重排 ──────────────────────
    R.setMd('v024-b', mkBlocks(['甲乙丙丁戊。', '后面一段。']));
    log('B.before blocks=' + blockCount() + ' bodyNos=' + bodyNos());
    R.__testApplyEdit(
        { single: true, line: 0, lines: [0], start: 0, end: 2 }, '改过');
    log('B.after  blocks=' + blockCount() + ' bodyNos=' + bodyNos());

    // ── 场景 C：把一个块整个删空，不该留空段落 ──────────────────
    R.setMd('v024-c', mkBlocks(['要删掉的。', '保留的。']));
    log('C.before blocks=' + blockCount() + ' bodyNos=' + bodyNos());
    R.__testApplyEdit(
        { single: true, line: 0, lines: [0], start: 0, end: 5 }, '');
    log('C.after  blocks=' + blockCount() + ' bodyNos=' + bodyNos());

    return out.join('\n');
})();
