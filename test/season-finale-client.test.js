/** Season finale, client side: the result is announced once (toast, then
 *  "seen" to the server), the ladder names last season's place and the trophy
 *  cabinet shows the season badges. Boots the REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

const SILVER = { season: '2026-10', place: 2, award: 'silver', seasonXp: 640, ranked: 14 };
const MEMENTO = { season: '2026-09', place: 12, award: 'participant', seasonXp: 90, ranked: 14 };

function boot({ me = {}, ladder = {}, storage = {} } = {}) {
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
  const calls = [];
  const answer = (url) => {
    if (url === '/statusz') return { accountsEnabled: true };
    if (url === '/api/me') return { ok: true, username: 'Testkonto', ...me };
    if (url === '/api/ladder') {
      return { ok: true, season: '2026-11', board: [{ username: 'Testkonto', seasonXp: 40 }], me: { username: 'Testkonto', xp: 900, seasonXp: 40, rank: 1 }, ...ladder };
    }
    return { ok: true };
  };
  window.fetch = (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer(url)), text: () => Promise.resolve('') });
  };
  const sockets = [];
  window.WebSocket = class {
    constructor() { this.readyState = 0; this.listeners = {}; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    send() {}
    close() {}
    fire(type, payload) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners[type] || []) fn(payload === undefined ? {} : { data: JSON.stringify(payload) });
    }
  };
  window.WebSocket.OPEN = 1;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Testkonto');
  window.localStorage.setItem('pikdame_account_token', 'tok');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const toast = () => doc.getElementById('toastContainer').textContent;
  const seen = () => calls.filter((c) => c.url === '/api/season-result/seen');
  return { window, doc, ws: sockets[sockets.length - 1], calls, settle, toast, seen, errors };
}

test('an unseen result is announced once and reported as seen', async () => {
  const t = boot({ me: { seasonResult: SILVER, lastSeason: SILVER, seasonAwards: [SILVER] } });
  await t.settle();
  assert.strictEqual(t.toast(), 'Saison Oktober 2026 beendet: Platz 2 von 14 – 🥈 Silber!');
  assert.deepStrictEqual(t.seen().map((c) => c.body), [{ token: 'tok', season: '2026-10' }]);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();

  // The server answers without seasonResult once it is seen: nothing again.
  const later = boot({ me: { lastSeason: SILVER, seasonAwards: [SILVER] } });
  await later.settle();
  assert.doesNotMatch(later.toast(), /Saison/);
  assert.strictEqual(later.seen().length, 0);
  later.window.close();
});

test('a place without a badge still gets its line; English reads naturally', async () => {
  const plain = boot({ me: { seasonResult: { season: '2026-10', place: 31, award: null, seasonXp: 20, ranked: 40 } } });
  await plain.settle();
  assert.strictEqual(plain.toast(), 'Saison Oktober 2026 beendet: Platz 31 von 40.');
  plain.window.close();

  const en = boot({ me: { seasonResult: SILVER }, storage: { pikdame_lang: 'en' } });
  await en.settle();
  assert.strictEqual(en.toast(), 'Season October 2026 is over: place 2 of 14 – 🥈 silver!');
  en.window.close();
});

test('the ladder names last season and the podium badges; the trophy cabinet shows all season badges', async () => {
  const t = boot({ me: { lastSeason: SILVER, seasonAwards: [SILVER, MEMENTO] }, ladder: { lastSeason: SILVER, seasonAwards: [SILVER, MEMENTO] } });
  await t.settle();
  t.doc.getElementById('accountBtn').click();
  await t.settle();
  const box = t.doc.getElementById('ladderBox');
  assert.match(box.querySelector('h3').textContent, /November 2026/, 'the season by its month, not "2026-11"');
  assert.strictEqual(box.querySelector('.ladderLast').textContent, 'Letzte Saison (Oktober 2026): Platz 2 von 14');
  assert.deepStrictEqual([...box.querySelectorAll('.seasonAward')].map((c) => c.textContent), ['🥈Oktober 2026 · Platz 2'],
    'mementos stay in the trophy cabinet');

  t.ws.fire('open');
  t.ws.fire('message', { type: 'profiles', players: [{ name: 'Testkonto', gamesPlayed: 30, gamesWon: 9, badges: {} }] });
  t.doc.getElementById('statsBtn').click();
  const tiles = [...t.doc.querySelectorAll('#achievementsBox .achSeason')].map((n) => n.textContent);
  assert.deepStrictEqual(tiles, ['🥈Oktober 2026Platz 2 von 14', '🎟️September 2026Platz 12 von 14']);
  assert.match(t.doc.getElementById('achievementsBox').textContent, /Saison-Abzeichen \(2\)/);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});
