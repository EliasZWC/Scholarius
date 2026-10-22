return (function(){
  var R = window.ScholariusReader;
  var d = R.dumpEdits();
  function esc(s){ return String(s).replace(/\r/g,'<CR>').replace(/\n/g,'<LF>'); }
  var labels = d.labels || {};
  var lines = Object.keys(labels);
  var src = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = Number(lines[i]);
    src.push({ line: ln, spans: labels[lines[i]] });
  }
  var dom = [];
  var nodes = document.querySelectorAll('.reader-para');
  for (var j = 0; j < nodes.length; j++) {
    var n = nodes[j];
    var cls = n.className;
    if (cls.indexOf('is-author-body') < 0 && n.getAttribute('data-label') !== 'author') continue;
    var cs = getComputedStyle(n);
    var kids = [];
    for (var q = 0; q < n.children.length; q++) {
      var c = n.children[q];
      kids.push(c.className + '=' + c.textContent.slice(0, 18));
    }
    dom.push({
      line: n.getAttribute('data-line'),
      no: n.getAttribute('data-body-no'),
      cls: cls.replace('reader-para ',''),
      color: cs.color,
      display: cs.display,
      left: Math.round(n.getBoundingClientRect().left),
      width: Math.round(n.getBoundingClientRect().width),
      kids: kids,
      text: esc(n.textContent.slice(0, 40))
    });
  }
  // 该块在 docModel 里的真实文本
  var raw = {};
  for (var s = 0; s < src.length; s++) {
    var bl = null;
    var lnum = src[s].line;
    var els = document.querySelectorAll('[data-line="' + lnum + '"]');
    raw[lnum] = { domParts: els.length };
  }
  return JSON.stringify({ key: d.docStoreKey, src: src, dom: dom, raw: raw, err: d.lastError }, null, 1);
})()
