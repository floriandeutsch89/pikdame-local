/** Dialog text from the contrast review: "Was ist neu?" names the CHANGELOG
 *  sections in the player's language, and every account field carries a
 *  visible label. Boots the REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const CHANGELOG = [
  '# Changelog', '', '## [2.80.0] - 2026-10-18', '', '### Added', '- Etwas Neues,', '  über zwei Zeilen',
  '### Fixed', '- Ein Fehler, siehe https://example.org/x', '### constructor', '- kein Abschnitt', '',
].join('\n');

function boot(storage = {}) {
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
  window.fetch = (url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(url === '/statusz' ? { accountsEnabled: true } : { ok: true }),
    text: () => Promise.resolve(url === '/changelogz' ? CHANGELOG : ''),
  });
  window.WebSocket = class {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Testkonto');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  return { window, doc: window.document, settle, errors };
}

const sections = (doc) => [...doc.querySelectorAll('#changelogContent h4')].map((h) => h.textContent);

test('"Was ist neu?" names the sections in German and English; unknown headings stay as written', async () => {
  const de = boot();
  de.doc.getElementById('versionBtn').click();
  await de.settle();
  assert.deepStrictEqual(sections(de.doc), ['Neu', 'Behoben', 'constructor']);
  assert.strictEqual(de.doc.querySelector('#changelogContent li').textContent, 'Etwas Neues, über zwei Zeilen',
    'an indented line continues its bullet instead of a stray paragraph');
  assert.strictEqual(de.doc.querySelector('#changelogContent a').getAttribute('href'), 'https://example.org/x');
  assert.deepStrictEqual(de.errors, []);
  de.window.close();

  const en = boot({ pikdame_lang: 'en' });
  en.doc.getElementById('versionBtn').click();
  await en.settle();
  assert.deepStrictEqual(sections(en.doc), ['Added', 'Fixed', 'constructor']);
  en.window.close();
});

test('every visible account field has its own label, also in English', () => {
  const { doc, window } = boot({ pikdame_lang: 'en' });
  const fields = [...doc.querySelectorAll('#accountOverlay input:not(.visuallyHidden):not([type="checkbox"])')];
  assert.ok(fields.length >= 6, 'login, sign-up, code and new password');
  for (const input of fields) {
    const label = doc.querySelector(`label.fieldLabel[for="${input.id}"]`);
    assert.ok(label, `#${input.id} has a visible label`);
    assert.ok(!input.hasAttribute('placeholder'), `#${input.id}: the label replaces the placeholder`);
  }
  assert.strictEqual(doc.querySelector('label[for="accLoginUser"]').textContent, 'Username or e-mail');
  assert.strictEqual(doc.querySelector('label[for="accRegCode"]').textContent, '6-digit code');
  window.close();
});
