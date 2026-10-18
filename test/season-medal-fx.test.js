/** Season podium fireworks: the one-time season toast for places 1-3 plays the
 *  victory-celebration fireworks band once, behind the start screen's header.
 *  Boots the REAL markup and client in jsdom; the layering is a CSS contract. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');

const result = (place, award) => ({ season: '2026-10', place, award, seasonXp: 640, ranked: 14 });

function boot({ seasonResult, still = false, beforeAnswer } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({
    matches: still && q.includes('prefers-reduced-motion'), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  const answer = (url) => {
    if (url === '/statusz') return { accountsEnabled: true };
    if (url === '/api/me') return { ok: true, username: 'Testkonto', ...(seasonResult ? { seasonResult } : {}) };
    return { ok: true };
  };
  window.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(answer(url)), text: () => Promise.resolve('') });
  window.WebSocket = class {
    constructor() { this.readyState = 0; }
    addEventListener() {} removeEventListener() {} send() {} close() {}
  };
  window.WebSocket.OPEN = 1;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Testkonto');
  window.localStorage.setItem('pikdame_account_token', 'tok');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  if (beforeAnswer) beforeAnswer(doc); // runs before /api/me answers
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const bands = () => [...doc.querySelectorAll('.celebrationBand')];
  const toast = () => doc.getElementById('toastContainer').textContent;
  return { window, doc, settle, bands, toast, errors };
}

test('places 1-3: one fireworks band, first in the start screen header', async () => {
  for (const [place, award] of [[1, 'gold'], [2, 'silver'], [3, 'bronze']]) {
    const t = boot({ seasonResult: result(place, award) });
    await t.settle();
    const bands = t.bands();
    assert.strictEqual(bands.length, 1, `place ${place}: exactly one band`);
    const [band] = bands;
    const header = t.doc.querySelector('#lobby .lobbyHeader');
    assert.strictEqual(band.parentElement, header, 'on the start screen header');
    assert.strictEqual(header.firstElementChild, band, 'first child: painted behind the content');
    assert.ok(header.classList.contains('celebrating'));
    assert.ok(band.classList.contains('fx-fireworks') && !band.classList.contains('still'));
    assert.strictEqual(band.getAttribute('aria-hidden'), 'true');
    assert.match(t.toast(), /Saison Oktober 2026 beendet/);
    assert.deepStrictEqual(t.errors, []);
    t.window.close();
  }
});

test('place 4 and below: the toast only', async () => {
  for (const r of [result(4, 'top10'), result(12, 'participant'), result(30, null)]) {
    const t = boot({ seasonResult: r });
    await t.settle();
    assert.match(t.toast(), new RegExp(`Platz ${r.place} von 14`));
    assert.strictEqual(t.bands().length, 0, `place ${r.place}: no fireworks`);
    t.window.close();
  }
});

test('reduced motion: the still picture of the same band', async () => {
  const t = boot({ seasonResult: result(1, 'gold'), still: true });
  await t.settle();
  const [band] = t.bands();
  assert.ok(band && band.classList.contains('still'));
  t.window.close();
});

test('no fireworks when the start screen is not on show', async () => {
  for (const cls of ['hidden', 'inSession']) {
    const t = boot({ seasonResult: result(2, 'silver'), beforeAnswer: (doc) => doc.getElementById('lobby').classList.add(cls) });
    await t.settle();
    assert.match(t.toast(), /Platz 2 von 14/, 'the result is still told');
    assert.strictEqual(t.bands().length, 0, `#lobby.${cls}: no band`);
    t.window.close();
  }
});

test('CSS contract: the band sits behind the header content and ends with the header', () => {
  const rule = (sel) => {
    const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `rule ${sel} exists`);
    return m[1];
  };
  const band = rule('.celebrationBand');
  assert.match(band, /z-index:\s*-1/);
  assert.match(band, /pointer-events:\s*none/);
  const host = rule('.lobbyHeader.celebrating');
  assert.match(host, /isolation:\s*isolate/, 'own stacking context: -1 stays behind the header content');
  assert.match(host, /position:\s*relative/);
  const fill = rule('.lobbyHeader > .celebrationBand');
  assert.match(fill, /bottom:\s*0/, 'never reaches the buttons below the header');
  assert.match(fill, /height:\s*auto/);
});
