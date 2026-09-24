/**
 * Check tocFromFonts (and the outline / heuristic fallbacks) against
 * fixtures produced by tools/make_font_fixture.py.
 *
 * Usage: node tools/smoke/font_check.js <fixture.json>
 * ASCII-only source on purpose (see toc_check.js).
 */
const fs = require('fs');
const vm = require('vm');

const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fixturePath = process.argv[2];

const noop = () => {};
const elStub = () => ({
  hidden: true, textContent: '', innerHTML: '', className: '',
  style: {}, dataset: {}, children: [], parentNode: null,
  classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
  addEventListener: noop, removeEventListener: noop,
  setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  appendChild: noop, insertBefore: noop, removeChild: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  scrollTo: noop, focus: noop, blur: noop, matches: () => false, closest: () => null,
  contains: () => false, scrollIntoView: noop, cloneNode() { return elStub(); }
});

const sandbox = {
  document: {
    body: elStub(), documentElement: elStub(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => elStub(), createElementNS: () => elStub(), createTextNode: () => elStub(),
    addEventListener: noop, removeEventListener: noop, activeElement: null
  },
  console, setTimeout, clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  getComputedStyle: () => ({ color: 'rgb(0,0,0)', getPropertyValue: () => '' }),
  location: { href: 'file:///', hash: '', search: '' },
  navigator: { userAgent: 'node' },
  localStorage: (() => { const m = {}; return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; } }; })(),
  trace: noop
};
sandbox.window = sandbox; sandbox.global = sandbox; sandbox.self = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(
  'var MAX_TITLE_CHARS = 80;' +
  'function t(k) { return k; }' +
  'function trace() {}', ctx, { filename: 'shims.js' });

const src = fs.readFileSync('app/src/main/assets/www/reader.js', 'utf8');
vm.runInContext(src, ctx, { filename: 'reader.js' });

function grab(name) {
  const re = new RegExp('function ' + name + '[\\s\\S]*?\\n    \\}\\n');
  const m = src.match(re);
  if (!m) throw new Error('cannot extract ' + name);
  return m[0];
}

function grabVar(name) {
  const re = new RegExp('^[ \\t]*var ' + name + '[^\\n]*$', 'm');
  const m = src.match(re);
  if (!m) throw new Error('cannot extract var ' + name);
  return m[0];
}

vm.runInContext(
  grab('tocFromFonts') + '\n' + grab('levelFromNumber') + '\n' +
  grab('tocFromOutline') + '\n' + grab('normaliseTitle') + '\n' +
  grabVar('DOT_SENTENCE_RE') + '\n' + grabVar('NOT_HEAD_RE') + '\n',
  ctx, { filename: 'fns.js' });

const tocFromFonts = vm.runInContext('tocFromFonts', ctx);
const tocFromOutline = vm.runInContext('tocFromOutline', ctx);

const lines = fixture.text.split('\n');
const meta = fixture.meta;
const outline = fixture.outline;

console.log('='.repeat(78));
console.log(fixture.source);
console.log('='.repeat(78));
console.log('merged lines :', lines.length, ' fonts:', meta.fonts.length,
  ' outline:', outline.length);

// Which path wins?
let picked = null;
const o = tocFromOutline(outline, lines);
if (o && o.length) { picked = 'outline'; }
else {
  const f = tocFromFonts(meta, lines);
  if (f && f.length) { picked = 'font'; }
  else { picked = 'heuristic'; }
}
console.log('WINNER       :', picked);

if (o && o.length) {
  console.log();
  console.log('--- outline path ---');
  o.forEach((e) => console.log('   ' + '  '.repeat(e.level - 1) + '[L' + e.level + '] ' + e.title + '  (line ' + e.line + ')'));
}

const f = tocFromFonts(meta, lines);
console.log();
console.log('--- font path ---');
if (!f) {
  console.log('   (null -> would fall back to heuristic)');
} else {
  console.log('   ' + f.length + ' entries');
  f.slice(0, 40).forEach((e) => console.log('   ' + '  '.repeat(e.level - 1) + '[L' + e.level + '] ' + e.title + '  (line ' + e.line + ')'));
}

// Show the size histogram that drove the decision
const sizeChars = {};
for (let i = 0; i < meta.lines.length && i < lines.length; i++) {
  const sz = meta.lines[i][1];
  const n = (lines[i] || '').length;
  if (!n) continue;
  sizeChars[sz] = (sizeChars[sz] || 0) + n;
}
console.log();
console.log('--- size histogram (sizeX10: chars) ---');
Object.keys(sizeChars).sort((a, b) => sizeChars[b] - sizeChars[a]).slice(0, 8)
  .forEach((k) => console.log('   ' + (k / 10).toFixed(1) + 'pt: ' + sizeChars[k]));
