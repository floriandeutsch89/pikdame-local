/** "Dein Pik-Dame-Jahr" in the client: the December chip in "Heute", the story
 *  cards (only facts with data), navigation, the mail deep link and the
 *  opt-in switch in the account. Boots the REAL markup and client in jsdom on
 *  a fixed clock: 31 December, when the start screen's cat wears its top hat. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const NOW = Date.parse('2026-12-31T11:00:00Z');

const FULL = {
  year: '2026', name: 'Ben',
  totals: { games: 87, wins: 34, queensLaid: 21, queensCaught: 6, bestRound: 285, bestGame: 1385, handAus: 2, jokers: 64, bestStreak: 11 },
  totalsSince: null, breakdownSince: '2026-10-17', activeDays: 41,
  favorite: { name: 'Oma Gerda', games: 37, wins: 15 },
  bots: [{ level: 'easy', games: 9, wins: 7 }, { level: 'zen', games: 12, wins: 3 }],
  table: { name: 'Donnerstagsrunde', games: 23, wins: 9 },
};
const SMALL = {
  year: '2026', name: 'Ben',
  totals: { games: 3, wins: 0, queensLaid: 0, queensCaught: 0, bestRound: 0, bestGame: 120, handAus: 0, jokers: 0, bestStreak: 1 },
  totalsSince: null, breakdownSince: null, activeDays: 1, favorite: null, bots: [], table: null,
};

function boot(t, { storage = {}, url = 'https://play.example/', api = {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  t.after(() => window.close()); // also after a failed assertion: open timers would hang the file
  // The fixed clock: every `new Date()` and `Date.now()` in the client.
  const RealDate = window.Date;
  window.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  };
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  const calls = [];
  const replies = {
    '/statusz': { accountsEnabled: true, occasions: { windows: [{ id: 'silvester', from: NOW - 3600e3, until: NOW + 12 * 3600e3 }] } },
    ...api,
  };
  window.fetch = (u, opts = {}) => {
    const p = String(u).replace(/^https:\/\/play\.example/, '').split('?')[0];
    calls.push({ path: p, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = typeof replies[p] === 'function' ? replies[p]() : replies[p] || {};
    return Promise.resolve({ ok: true, json: () => Promise.resolve(reply), text: () => Promise.resolve('') });
  };
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
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const ws = sockets[sockets.length - 1];
  ws.fire('open');
  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  const shown = (id) => !$(id).classList.contains('hidden');
  const asked = () => ws.sent.filter((m) => m.type === 'getYearReview');
  const profiles = (games = 87) => ws.fire('message', { type: 'profiles', players: [{ name: 'Ben', gamesPlayed: games, gamesWon: 3 }] });
  const review = (r, extra = {}) => ws.fire('message', { type: 'yearReview', available: !!r, season: true, review: r, ...extra });
  const slide = () => ({
    kicker: doc.querySelector('#yearReviewStage .yrKicker').textContent,
    big: (doc.querySelector('#yearReviewStage .yrBig') || { textContent: '' }).textContent,
    text: [...doc.querySelectorAll('#yearReviewStage .yrSlide p')].map((n) => n.textContent.trim()).join(' '),
  });
  const kickers = () => {
    const out = [];
    for (let i = 0; i < 20; i++) {
      out.push(slide().kicker);
      if ($('yearReviewNextBtn').disabled) break;
      $('yearReviewNextBtn').click();
    }
    return out;
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { window, doc, ws, $, shown, asked, profiles, review, slide, kickers, calls, flush, errors };
}

test('the chip appears only when the server offers a review; one request per name and game count', async (tc) => {
  const t = boot(tc);
  assert.ok(!t.shown('yearReviewBtn'), 'nothing before the server answers');
  t.profiles();
  assert.deepStrictEqual(t.asked(), [{ type: 'getYearReview', name: 'Ben' }]);
  t.profiles();
  assert.strictEqual(t.asked().length, 1, 'another broadcast, same count: no new request');
  t.profiles(88);
  assert.strictEqual(t.asked().length, 2, 'after an own game: ask again');

  t.review(null, { season: false });
  assert.ok(!t.shown('yearReviewBtn'), 'outside December the chip stays away');
  t.review(FULL);
  assert.ok(t.shown('yearReviewBtn'));
  assert.strictEqual(t.$('yearReviewBtn').textContent.trim(), 'Dein Jahr 2026');
  assert.strictEqual(t.$('yearReviewBtn').dataset.state, 'new');
  await t.flush();
  assert.deepStrictEqual(t.errors, []);
});

test('the story tells every fact with data, in order, and nothing more', async (tc) => {
  const t = boot(tc);
  t.profiles();
  t.review(FULL);
  t.$('yearReviewBtn').click();
  assert.ok(t.shown('yearReviewOverlay'));
  assert.deepStrictEqual(t.slide(), {
    kicker: 'Dein Pik-Dame-Jahr', big: '2026',
    text: 'Dein Pik-Dame-Jahr 2026 Die Katze hat nachgezählt. Tippen oder wischen zum Blättern.',
  });
  assert.strictEqual(t.$('yearReviewCount').textContent, '1 / 9');
  assert.ok(t.$('yearReviewPrevBtn').disabled);
  assert.strictEqual(t.window.localStorage.getItem('pikdame_year_seen'), '2026', 'seen: the chip calms down');
  assert.strictEqual(t.$('yearReviewBtn').dataset.state, 'seen');

  t.$('yearReviewNextBtn').click();
  assert.match(t.slide().text, /^Partien 87 34 davon gewonnen – 39 %\. Solide\. Die Katze schnurrt\.$/,
    'active days are left out while the day count is incomplete (breakdownSince)');
  t.$('yearReviewNextBtn').click();
  assert.match(t.slide().text, /^Lieblingsgegner Oma Gerda 37 Partien zusammen – 15 davon gingen an dich\. Revanche\?.*Gezählt seit dem 17\. Oktober\.$/);
  t.$('yearReviewPrevBtn').click();
  t.$('yearReviewPrevBtn').click();
  assert.strictEqual(t.slide().big, '2026');
  assert.deepStrictEqual(t.kickers(), [
    'Dein Pik-Dame-Jahr', 'Partien', 'Lieblingsgegner', 'Pik Damen gerettet', 'Beste Runde', 'Gegen die Bots',
    'Längste Serie', 'Dein Stammtisch', 'Gut Blatt für 2027!',
  ]);
  assert.ok(t.$('yearReviewNextBtn').disabled, 'the last card ends the story');
  const summary = [...t.doc.querySelectorAll('.yrSummary > div')].map((d) => d.textContent);
  assert.deepStrictEqual(summary, ['87Partien', '34Siege · 39 %', '21×Pik Dame gerettet', '+285Beste Runde']);
  await t.flush();
  assert.deepStrictEqual(t.errors, []);

  const s = boot(tc);
  s.profiles();
  s.review(SMALL);
  s.$('yearReviewBtn').click();
  assert.deepStrictEqual(s.kickers(), ['Dein Pik-Dame-Jahr', 'Partien', 'Gut Blatt für 2027!'], 'no queens, round, bots, streak, opponent or table made up');
  s.$('yearReviewPrevBtn').click();
  assert.match(s.slide().text, /Dabei sein ist alles/);
  await s.flush();
  assert.deepStrictEqual(s.errors, []);
});

test('keys, the left third of the card and the bot rows; the cat keeps its costume for the end', async (tc) => {
  const t = boot(tc);
  t.profiles();
  t.review(FULL);
  await t.flush();
  // Today the start screen's cat wears the New Year's top hat (fixed clock).
  assert.ok(t.doc.querySelector('.heroCat .heroCostume.on[data-for~="silvester"]'), 'the occasion is on');
  t.$('yearReviewBtn').click();
  assert.ok(t.doc.querySelector('#yearReviewStage .yrCat'), 'the cat is on the card');
  assert.strictEqual(t.doc.querySelectorAll('#yearReviewStage .heroCostume').length, 0, 'no costume on the first card');

  const key = (k) => t.doc.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  for (let i = 0; i < 5; i++) key('ArrowRight');
  assert.strictEqual(t.slide().kicker, 'Gegen die Bots');
  const rows = [...t.doc.querySelectorAll('.yrBotRow')].map((r) => r.textContent);
  assert.deepStrictEqual(rows, ['Leicht7 von 9', 'Zen3 von 12']);
  assert.strictEqual(t.doc.querySelector('.yrBotBar > i').style.width, '78%');
  key('ArrowLeft');
  assert.strictEqual(t.slide().kicker, 'Beste Runde');
  // A tap on the left third goes back, anywhere else forward.
  const stage = t.$('yearReviewStage');
  stage.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 400, right: 300, bottom: 400 });
  stage.dispatchEvent(new t.window.MouseEvent('click', { clientX: 50, bubbles: true }));
  assert.strictEqual(t.slide().kicker, 'Pik Damen gerettet');
  stage.dispatchEvent(new t.window.MouseEvent('click', { clientX: 200, bubbles: true }));
  assert.strictEqual(t.slide().kicker, 'Beste Runde');
  for (let i = 0; i < 9; i++) key('ArrowRight');
  assert.ok(t.doc.querySelector('#yearReviewStage .heroCostume.on[data-for~="silvester"]'), 'the last card: top hat on');
  await t.flush(); // the share picture is drawn in the background
  assert.ok(!t.shown('yearReviewShareBtn'), 'no canvas here: no share button instead of a broken one');
  key('Escape');
  assert.ok(!t.shown('yearReviewOverlay'));
  await t.flush();
  assert.deepStrictEqual(t.errors, []);
});

test('English, and the mail link: ?jahr= opens the review once it arrives, then leaves the address bar', async (tc) => {
  const t = boot(tc, { storage: { pikdame_lang: 'en' }, url: 'https://play.example/?jahr=2026' });
  assert.strictEqual(t.window.location.search, '', 'the parameter is gone at once');
  t.profiles();
  t.review(FULL);
  assert.ok(t.shown('yearReviewOverlay'), 'opened without a tap');
  assert.strictEqual(t.$('yearReviewBtn').textContent.trim(), 'Your 2026');
  assert.strictEqual(t.slide().kicker, 'Your Pik Dame year');
  t.$('yearReviewNextBtn').click();
  assert.match(t.slide().text, /^Games 87 34 of them won – 39 %\. Solid\. The cat purrs\.$/);
  await t.flush();
  assert.deepStrictEqual(t.errors, []);

  const late = boot(tc, { url: 'https://play.example/?jahr=2026' });
  late.profiles();
  late.review(null, { season: false });
  assert.ok(!late.shown('yearReviewOverlay'));
  assert.match(late.$('toastContainer').textContent, /nur im Dezember/, 'a link from January says why nothing opens');
});

test('account: the review mail is off until switched on, and a failed save switches back', async (tc) => {
  let answer = { ok: true, enabled: true };
  const t = boot(tc, {
    storage: { pikdame_account_token: 'tok' },
    api: {
      '/api/me': { ok: true, username: 'Ben' },
      '/api/account/methods': { ok: true, hasPassword: true, passkeysAvailable: false, passkeys: [], reviewMail: false },
      '/api/account/review-mail': () => answer,
    },
  });
  await t.flush();
  t.$('accountBtn').click();
  await t.flush();
  assert.ok(t.shown('accountMailPrefs'));
  const box = t.$('accReviewMailCheckbox');
  assert.strictEqual(box.checked, false, 'never pre-ticked');
  box.click();
  await t.flush();
  const sent = t.calls.filter((c) => c.path === '/api/account/review-mail');
  assert.deepStrictEqual(sent.map((c) => c.body), [{ token: 'tok', enabled: true, lang: 'de' }]);
  assert.strictEqual(box.checked, true);
  assert.match(t.$('accountStatus').textContent, /Ende Dezember/);

  answer = { error: 'Konto-Datenbank ist gerade nicht erreichbar - bitte später erneut versuchen.' };
  box.click();
  await t.flush();
  assert.strictEqual(box.checked, true, 'not saved: the switch shows the stored state again');
  assert.match(t.$('accountStatus').textContent, /Konnte nicht gespeichert werden/);
  await t.flush();
  assert.deepStrictEqual(t.errors, []);
});
