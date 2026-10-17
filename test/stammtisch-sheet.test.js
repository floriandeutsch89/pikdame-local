/** Start-screen Stammtisch chips: the chip names who leads the overall record
 *  (not the best-of-3 series), a tap opens the record sheet, "Platz nehmen"
 *  joins. Boots the REAL markup and client in jsdom with a scripted WebSocket. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

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
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
    fire(type, payload) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners[type] || []) fn(payload === undefined ? {} : { data: JSON.stringify(payload) });
    }
  }
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  window.WebSocket = FakeSocket;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Ben');
  window.localStorage.setItem('pikdame_stammtische', JSON.stringify([{ code: 'STHOME', name: 'Familie' }]));
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const ws = sockets[sockets.length - 1];
  ws.fire('open');
  const doc = window.document;
  const sent = (type) => ws.sent.filter((m) => m.type === type);
  const shown = (id) => !doc.getElementById(id).classList.contains('hidden');
  const chipText = () => doc.querySelector('#stammtischRecent button[data-code="STHOME"] .stChipInfo').textContent;
  const info = (over) => ws.fire('message', {
    type: 'stammtischInfo', exists: true, code: 'STHOME', name: 'Familie', gamesPlayed: 20,
    series: { no: 4, games: 1, wins: { flo: 1 }, bestOf: 3, needed: 2 }, pairwise: {},
    members: [{ name: 'Flo', wins: 12, games: 20, avg: 310 }, { name: 'Anna', wins: 8, games: 20, avg: 260 }],
    ...over,
  });
  return { window, doc, ws, sent, shown, chipText, info, errors };
}

test('the chip names who leads the record, never the series as "Serie 2:1"', () => {
  const t = boot();
  assert.strictEqual(t.sent('getStammtisch')[0].code, 'STHOME', 'asked for without a tap');
  t.info();
  assert.strictEqual(t.chipText(), 'Flo führt · 12 Siege');
  t.info({ members: [{ name: 'Flo', wins: 12, games: 20, avg: 310 }, { name: 'Anna', wins: 12, games: 20, avg: 300 }] });
  assert.strictEqual(t.chipText(), 'Gleichstand · je 12 Siege');
  t.info({ gamesPlayed: 0, members: [{ name: 'Flo', wins: 0, games: 0, avg: 0 }] });
  assert.strictEqual(t.chipText(), 'Noch keine Partie');
  t.info({ gamesPlayed: 1, members: [{ name: 'Flo', wins: 1, games: 1, avg: 900 }, { name: 'Anna', wins: 0, games: 0, avg: 0 }] });
  assert.strictEqual(t.chipText(), 'Flo · 1 Sieg', 'alone in the record: nobody to lead');
  t.info({ gamesPlayed: 3, members: [{ name: 'Flo', wins: 0, games: 3, avg: 200 }] });
  assert.strictEqual(t.chipText(), '3 Partien', 'only bots won so far');
  assert.doesNotMatch(t.doc.getElementById('stammtischRecent').textContent, /Serie/);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();

  const en = boot({ pikdame_lang: 'en' });
  en.info();
  assert.strictEqual(en.chipText(), 'Flo leads · 12 wins');
  en.window.close();
});

test('a tap opens the record sheet instead of joining; "Platz nehmen" joins', () => {
  const t = boot();
  t.info({
    members: [
      { name: 'Flo', wins: 12, games: 20, avg: 310 }, { name: 'Anna', wins: 8, games: 20, avg: 260 },
      { name: 'Uli', wins: 5, games: 15, avg: 240 }, { name: 'Bea', wins: 1, games: 9, avg: 180 },
    ],
    pairwise: {
      flo: { anna: { ahead: 11, behind: 9 }, uli: { ahead: 9, behind: 6 }, bea: { ahead: 8, behind: 1 } },
      anna: { flo: { ahead: 9, behind: 11 }, uli: { ahead: 7, behind: 7 }, bea: { ahead: 5, behind: 4 } },
      uli: { flo: { ahead: 6, behind: 9 }, anna: { ahead: 7, behind: 7 }, bea: { ahead: 3, behind: 6 } },
      bea: { flo: { ahead: 1, behind: 8 }, anna: { ahead: 4, behind: 5 }, uli: { ahead: 6, behind: 3 } },
    },
  });
  t.ws.sent.length = 0;
  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  assert.ok(t.shown('stammtischSheetOverlay'));
  assert.strictEqual(t.sent('joinSession').length, 0, 'no join behind the sheet');
  assert.strictEqual(t.sent('getStammtisch')[0].code, 'STHOME', 'fresh standings on open');
  assert.strictEqual(t.doc.getElementById('stammtischSheetName').textContent, 'Familie');
  assert.strictEqual(t.doc.getElementById('stammtischSheetMeta').textContent, 'Code STHOME · 20 Partien');
  const body = t.doc.getElementById('stammtischSheetBody');
  assert.deepStrictEqual([...body.querySelectorAll('.stTable tbody tr')].map((r) => r.firstChild.textContent), ['Flo', 'Anna', 'Uli', 'Bea']);
  assert.match(body.querySelector('.stSeries').textContent, /Serie 4 · Best of 3: Flo 1/);
  // Closest records first, at most three of the six pairs.
  assert.strictEqual(body.querySelector('.stPairs').textContent,
    'Direktvergleich: Anna 7:7 Uli · Anna 5:4 Bea · Flo 11:9 Anna');

  t.doc.getElementById('stammtischSheetJoinBtn').click();
  assert.ok(!t.shown('stammtischSheetOverlay'));
  const join = t.sent('joinSession')[0];
  assert.strictEqual(join.code, 'STHOME');
  assert.strictEqual(join.name, 'Ben');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('the sheet closes by button or a tap outside, waits for data, and goes when the table is gone', () => {
  const t = boot();
  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  assert.match(t.doc.getElementById('stammtischSheetBody').textContent, /Bilanz wird geladen/);
  t.info({ series: { no: 2, games: 3, wins: { anna: 2, flo: 1 }, bestOf: 3, needed: 2, winner: 'Anna' } });
  assert.ok(t.doc.querySelector('#stammtischSheetBody .stSeries svg use'), 'a sprite trophy, no emoji');
  assert.doesNotMatch(t.doc.getElementById('stammtischSheetBody').textContent, /🏆/);
  t.doc.getElementById('stammtischSheetCloseBtn').click();
  assert.ok(!t.shown('stammtischSheetOverlay'));

  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  const overlay = t.doc.getElementById('stammtischSheetOverlay');
  overlay.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.ok(!t.shown('stammtischSheetOverlay'), 'tap outside closes');

  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  t.ws.fire('message', { type: 'stammtischInfo', exists: false, code: 'STHOME' });
  assert.ok(!t.shown('stammtischSheetOverlay'), 'a deleted table closes its sheet');
  assert.strictEqual(t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]'), null);
  assert.strictEqual(t.sent('joinSession').length, 0);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});
