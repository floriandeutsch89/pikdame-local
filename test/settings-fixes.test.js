/** Settings fixes: sheets open at the top, the debug switch shows its state,
 *  a close button in the card-back gallery. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');

function boot() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  window.WebSocket = class {
    constructor() { this.readyState = 1; }
    addEventListener() {} removeEventListener() {} send() {} close() {}
  };
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  return { window, doc: window.document, errors };
}
const tick = () => new Promise((r) => setTimeout(r, 20)); // MutationObserver callbacks

test('sheets reopen scrolled to the top', async () => {
  const { window, doc, errors } = boot();
  try {
    for (const id of ['settingsOverlay', 'rulesOverlay']) {
      const overlay = doc.getElementById(id);
      const card = overlay.querySelector('.overlay-card');
      overlay.classList.remove('hidden');
      await tick();
      card.scrollTop = 400;
      overlay.scrollTop = 50;
      overlay.classList.add('hidden');
      await tick();
      overlay.classList.remove('hidden');
      await tick();
      assert.strictEqual(card.scrollTop, 0, `#${id} card back at the top`);
      assert.strictEqual(overlay.scrollTop, 0, `#${id} back at the top`);
    }
    assert.deepStrictEqual(errors, []);
  } finally { window.close(); }
});

test('debug view: one switch turns it on and off and shows its state', () => {
  const { window, doc, errors } = boot();
  try {
    const box = doc.getElementById('debugCheckbox');
    const on = () => doc.documentElement.classList.contains('debugMode');
    assert.strictEqual(box.checked, false);
    assert.strictEqual(on(), false);
    box.click();
    assert.strictEqual(box.checked, true);
    assert.strictEqual(on(), true, 'the switch turns the view on');
    assert.ok(!doc.getElementById('debugGrid').classList.contains('hidden'));
    box.click();
    assert.strictEqual(on(), false);
    assert.strictEqual(doc.querySelectorAll('[id^="debugBtn"]').length, 0, 'no second control mirrors it');
    assert.deepStrictEqual(errors, []);
  } finally { window.close(); }
});

test('card-back gallery has a 44 px close button', () => {
  const { window, doc, errors } = boot();
  try {
    doc.getElementById('cardbackBtn').click();
    const close = doc.querySelector('.cardbackGallery .cardbackClose');
    assert.ok(close, 'close button exists');
    assert.ok(close.getAttribute('aria-label'), 'has a name');
    assert.ok(close.querySelector('use[href="#i-close"]'), 'uses the shared close icon');
    assert.match(css, /\.btn-icon\s*\{[^}]*width: var\(--tap-min\); height: var\(--tap-min\)/, '.btn-icon is tap-min sized');
    close.click();
    assert.strictEqual(doc.querySelector('.cardbackGallery'), null, 'gallery closed');
    assert.deepStrictEqual(errors, []);
  } finally { window.close(); }
});

