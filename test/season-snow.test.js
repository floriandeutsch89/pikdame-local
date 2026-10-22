// December snow falls on the start screen only. At the table, over its sheets,
// in a hidden tab and with reduced motion the flakes leave the DOM, so their
// animation stops too. Real markup + client in jsdom on a fixed clock; jsdom has
// no getAnimations() and loads no style.css, so the CSS side is a source contract.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const clientJs = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
const DECEMBER = Date.parse('2026-12-28T10:00:00Z'); // no occasion day: plain December

function boot({ now = DECEMBER, still = false } = {}) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  const RealDate = window.Date;
  window.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  };
  let hidden = false;
  Object.defineProperty(window.document, 'hidden', { get: () => hidden, configurable: true });
  // A live reduced-motion setting: the test flips it and fires 'change' like the OS.
  const motion = { matches: still, listeners: [] };
  window.matchMedia = (q) => {
    const live = q.includes('prefers-reduced-motion');
    const add = (f) => { if (live) motion.listeners.push(f); };
    return { get matches() { return live && motion.matches; }, media: q,
      addEventListener: (type, f) => add(f), removeEventListener() {}, addListener: add, removeListener() {} };
  };
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  let rafDepth = 0;
  window.requestAnimationFrame = (cb) => {
    if (rafDepth > 4) return 0;
    rafDepth += 1;
    try { cb(Date.now()); } finally { rafDepth -= 1; }
    return 0;
  };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-test' }), text: () => Promise.resolve('') });
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) {
      if (typeof this['on' + t] === 'function') this['on' + t](ev);
      for (const f of this._ls[t] || []) f(ev);
    }
    send() {}
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  const setHidden = (h) => { hidden = h; doc.dispatchEvent(new window.Event('visibilitychange')); };
  const setStill = (s) => { motion.matches = s; for (const f of motion.listeners) f({ matches: s }); };
  const flakes = () => doc.querySelectorAll('.seasonFlake').length;
  const shown = (id) => !doc.getElementById(id).classList.contains('hidden');
  return { window, doc, errors, setHidden, setStill, flakes, shown, ws: () => ws };
}

async function setup(t, opts) {
  const ctx = boot(opts);
  t.after(() => ctx.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ctx.ws();
  const feed = (s) => sock._emit('message', { data: JSON.stringify({ type: 'state', state: s }) });
  const join = () => sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  const click = (node) => node.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
  return { ...ctx, feed, join, click };
}

const hand = [{ id: 'h1', suit: 'H', rank: '7' }, { id: 'h2', suit: 'S', rank: '2' }];
function table(extra = {}) {
  return {
    phase: 'playing', roundNumber: 2, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1',
    turnDeadline: null, discardTop: { id: 'dt', suit: 'H', rank: 'Q' }, drawPileCount: 40, discardPileCount: 4,
    log: [], tableMelds: [], lobbyReady: [], nextRoundReady: [], houseRules: {}, totals: { p1: 120, b1: 640 },
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hand.length, hand },
      { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 5, botDifficulty: 'medium' },
    ],
    ...extra,
  };
}

test('December: twelve flakes on the start screen, none at the table or over its sheets', async (t) => {
  const s = await setup(t);
  assert.ok(s.shown('lobby'));
  assert.strictEqual(s.flakes(), 12, 'the start screen snows as before');
  const before = [...s.doc.querySelectorAll('.seasonFlake')];
  assert.ok(before.every((f) => f.parentElement === s.doc.body && f.textContent === '❄'), 'on the body, above the start screen');

  s.join();
  s.feed(table());
  assert.ok(s.shown('table') && !s.shown('lobby'));
  assert.strictEqual(s.flakes(), 0, 'gone from the DOM at the table, not just hidden');
  s.click(s.doc.getElementById('settingsBtn'));
  assert.ok(s.shown('gameSettingsOverlay'));
  assert.strictEqual(s.flakes(), 0, 'no snow over a sheet opened at the table');
  const result = (score, win) => ({ roundScore: score, breakdown: { isWinner: !!win, multiplier: 1 } });
  s.feed(table({ phase: 'roundEnd', lastRoundWinnerId: 'b1', lastRoundResult: { p1: result(-45), b1: result(270, true) } }));
  assert.ok(s.shown('resultOverlay'));
  assert.strictEqual(s.flakes(), 0, 'nor over the result');

  s.feed(table({ phase: 'lobby' }));
  assert.ok(s.shown('lobby'));
  assert.strictEqual(s.flakes(), 12, 'back on the start screen it snows again');
  s.feed(table({ phase: 'lobby' }));
  assert.strictEqual(s.flakes(), 12, 'one set of flakes, however often it renders');
  assert.ok(before.every((f) => !f.isConnected), 'fresh flakes, the old ones stay removed');
  assert.deepStrictEqual(s.errors, []);
});

test('a hidden tab and reduced motion remove the flakes; back on the start screen they return', async (t) => {
  const s = await setup(t);
  assert.strictEqual(s.flakes(), 12);
  s.setHidden(true);
  assert.strictEqual(s.flakes(), 0, 'hidden tab: nothing falls');
  s.setHidden(false);
  assert.strictEqual(s.flakes(), 12);
  s.setStill(true);
  assert.strictEqual(s.flakes(), 0, 'reduced motion switched on: removed at once');
  s.setStill(false);
  assert.strictEqual(s.flakes(), 12);

  s.join();
  s.feed(table());
  s.setHidden(true);
  s.setHidden(false);
  s.setStill(true);
  s.setStill(false);
  assert.strictEqual(s.flakes(), 0, 'coming back to the table brings no snow');
  assert.deepStrictEqual(s.errors, []);
});

test('reduced motion from the start and every other month: no flakes; the season emotes stay', async (t) => {
  const still = await setup(t, { still: true });
  assert.strictEqual(still.flakes(), 0);
  // Split from the snow code, unchanged: the fireworks emote in December, the pumpkin in October.
  const offered = (ctx, emoji) => [...ctx.doc.querySelectorAll('#emoteBar button')].filter((b) => b.dataset.emote === emoji).length;
  assert.strictEqual(offered(still, '🎆'), 1);

  const november = await setup(t, { now: Date.parse('2026-11-30T12:00:00Z') });
  assert.strictEqual(november.flakes(), 0);
  november.setHidden(true);
  november.setHidden(false);
  assert.strictEqual(november.flakes(), 0, 'no snow outside December');
  assert.strictEqual(offered(november, '🎆'), 0);

  const october = await setup(t, { now: Date.parse('2026-10-15T12:00:00Z') });
  assert.strictEqual(october.flakes(), 0);
  assert.strictEqual(offered(october, '🎃'), 1);
  assert.deepStrictEqual([...still.errors, ...november.errors, ...october.errors], []);
});

test('contract: the snow animation lives on .seasonFlake alone, and only syncSeasonSnow makes flakes', () => {
  // No flake nodes at the table therefore means no snow animation at the table.
  const uses = [...css.matchAll(/animation(?:-name)?\s*:[^;}]*\bflakeFall\b/g)];
  assert.strictEqual(uses.length, 1, 'flakeFall is animated in one rule');
  const rule = css.slice(css.lastIndexOf('}', uses[0].index) + 1, uses[0].index).trim();
  assert.match(rule, /^(\/\*[^]*?\*\/\s*)?\.seasonFlake \{/, 'and that rule is .seasonFlake');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.seasonFlake \{ display: none; \} \}/, 'the CSS guard stays');

  const made = [...clientJs.matchAll(/seasonFlake/g)].map((m) => m.index);
  const fn = clientJs.indexOf('function syncSeasonSnow(');
  const fnEnd = clientJs.indexOf('\n  }\n', fn);
  assert.ok(fn > 0 && made.length >= 2 && made.every((i) => i > fn && i < fnEnd), 'every .seasonFlake in client.js is inside syncSeasonSnow');
});
