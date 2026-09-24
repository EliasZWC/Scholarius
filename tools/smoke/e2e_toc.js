/**
 * End-to-end check in a real browser against the real index.html.
 * Loads a fixture, calls ScholariusShell.readerText(id, text, outline, meta)
 * and inspects the rendered TOC entries + a jump.
 *
 * Usage: node tools/smoke/e2e_toc.js <fixture.json>
 */
const fs = require('fs');
const path = require('path');

const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const www = path.resolve('app/src/main/assets/www');

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  await page.goto('file:///' + path.join(www, 'index.html').replace(/\\/g, '/'));
  await page.waitForTimeout(600);

  const result = await page.evaluate((fx) => {
    const out = { steps: [] };

    // 打开阅读页
    window.ScholariusReader.open({
      id: 'test-doc',
      title: fx.source,
      author: '',
      venue: '',
      pages: 0
    });
    out.steps.push('open');

    const r = window.ScholariusShell.readerText('test-doc', fx.text, fx.outline, fx.meta);
    out.shellReturn = r;
    out.steps.push('readerText');

    const toc = window.ScholariusReader.getToc();
    out.tocCount = toc.length;
    out.toc = toc.map((e) => ({ level: e.level, title: e.title, line: e.line }));

    // 面板是隐藏的，先展开再开目录
    const panelBtn = document.getElementById('reader-bottom');
    out.tocSheetHidden = document.getElementById('toc-sheet').hidden;
    return out;
  }, fixture);

  // Open the TOC sheet through the real UI path
  const viaUi = await page.evaluate(() => {
    // reader.js exposes no openToc; click the real button
    const btns = Array.from(document.querySelectorAll('#reader-bottom button'));
    const target = btns.find((b) => /content|目录|Content/i.test(b.textContent || '')) || btns[0];
    if (!target) return { clicked: false };
    target.click();
    return { clicked: true, label: target.textContent.trim() };
  });
  await page.waitForTimeout(500);

  const afterOpen = await page.evaluate(() => {
    const sheet = document.getElementById('toc-sheet');
    const items = Array.from(document.querySelectorAll('#toc-list li'));
    return {
      sheetHidden: sheet ? sheet.hidden : null,
      itemCount: items.length,
      firstItems: items.slice(0, 12).map((li) => (li.textContent || '').trim())
    };
  });

  // Jump via the first item
  const jump = await page.evaluate(() => {
    const li = document.querySelector('#toc-list li');
    if (!li) return { ok: false };
    const before = document.getElementById('reader-body')?.scrollTop;
    const btn = li.querySelector('button') || li;
    btn.click();
    return { ok: true, before };
  });
  await page.waitForTimeout(900);

  const afterJump = await page.evaluate(() => ({
    scrollTop: document.getElementById('reader-body')?.scrollTop,
    sheetHidden: document.getElementById('toc-sheet')?.hidden
  }));

  await browser.close();

  console.log('='.repeat(78));
  console.log(fixture.source);
  console.log('='.repeat(78));
  console.log('shell return   :', result.shellReturn);
  console.log('toc entries    :', result.tocCount);
  console.log('toc sheet open :', viaUi);
  console.log('sheet hidden   :', afterOpen.sheetHidden, ' rendered items:', afterOpen.itemCount);
  console.log('first items    :');
  afterOpen.firstItems.forEach((s) => console.log('    -', s));
  console.log('jump           :', jump, '->', afterJump);
  console.log('page errors    :', errors.length ? errors : '(none)');
})();
