/** Badge unlock cards, client side: a new badge slides in at the top edge,
 *  one card at a time, three per burst and then "+N", never at the same time as
 *  a priority toast, held during the tutorial and the intro. A tap opens the
 *  badge in the trophy cabinet off the table and only dismisses at it. Boots
 *  the REAL markup and client in jsdom on a virtual clock (timers fire only
 *  when a test advances it). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const GameManager = require('../game/GameManager');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const SHOW_MS = 4600; // = UNLOCK_SHOW_MS
const NEXT_MS = 260 + 320 + 10; // leaving + gap

function boot({ url = 'https://play.example/', storage = {}, still = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const RealDate = window.Date;
  let clock = new RealDate(2026, 9, 24, 15, 0, 0).getTime();
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  const queue = [];
  let seq = 0;
  window.setTimeout = (fn, ms = 0, ...args) => {
    queue.push({ id: ++seq, at: clock + Math.max(0, Number(ms) || 0), fn, args });
    return seq;
  };
  window.setInterval = (fn, ms = 0, ...args) => {
    const every = Math.max(1, Number(ms) || 0);
    queue.push({ id: ++seq, at: clock + every, fn, args, every });
    return seq;
  };
  window.clearTimeout = window.clearInterval = (id) => {
    const i = queue.findIndex((x) => x.id === id);
    if (i >= 0) queue.splice(i, 1);
  };
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
  const run = async (ms) => {
    const end = clock + ms;
    for (let fired = 0; ; fired++) {
      if (fired > 20000) throw new Error('timer loop');
      await settle();
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue[0];
      if (!next || next.at > end) break;
      queue.shift();
      clock = Math.max(clock, next.at);
      if (next.every) { next.at = clock + next.every; queue.push(next); }
      try { next.fn(...next.args); } catch (e) { errors.push(e); }
    }
    clock = Math.max(clock, end);
    await settle();
  };
  window.matchMedia = (q) => ({
    matches: still && q.includes('prefers-reduced-motion'), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('') });
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
  window.localStorage.setItem('pikdame_player_name', 'Flo');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  const ws = () => sockets[sockets.length - 1];
  const msg = (m) => ws().fire('message', m);
  const unlock = (...ids) => msg({ type: 'badgeUnlocks', name: 'Flo', badges: ids.map((id, i) => ({ id, earnedAt: clock - 1000 + i })) });
  const cards = () => [...doc.querySelectorAll('#unlockLayer .unlockCard:not(.leaving)')];
  const view = () => cards().map((c) => ['.unlockArt', '.unlockEyebrow', '.unlockName', '.unlockSub']
    .map((s) => (c.querySelector(s) ? c.querySelector(s).textContent.replace(/\u00ad/g, '') : null)));
  const names = () => cards().map((c) => c.querySelector('.unlockName').textContent.replace(/\u00ad/g, ''));
  const claims = () => ws().sent.filter((m) => m.type === 'claimBadges');
  const shown = (id) => !doc.getElementById(id).classList.contains('hidden');
  return { window, doc, ws, msg, unlock, cards, view, names, claims, shown, run, settle, errors };
}

/** A running table seen by Flo (p1); `tutorialMode` for a tutorial table. */
function tableState({ tutorialMode = false } = {}) {
  const g = new GameManager(() => {}, { deckSeed: 7, tutorialMode });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer('p1', 'Flo');
  g.fillWithBots();
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  const st = g.publicState('p1');
  g.destroy();
  return st;
}
const PROFILE = { name: 'Flo', gamesPlayed: 12, gamesWon: 9, totalQueensLaid: 3, badges: { marathon_10: Date.UTC(2026, 8, 1) } };

test('one card per badge: its emoji, "Abzeichen freigeschaltet", the name, its tier and what it was for; English too', async () => {
  const t = boot();
  t.ws().fire('open');
  const layer = t.doc.getElementById('unlockLayer');
  assert.strictEqual(layer.getAttribute('role'), 'status');
  assert.strictEqual(layer.getAttribute('aria-live'), 'polite', 'read out without interrupting');
  t.unlock('first_win');
  assert.deepStrictEqual(t.view(), [['🏆', 'Abzeichen freigeschaltet', 'Erster Sieg', 'Stufe 1 von 3 · Erste gewonnene Partie']]);
  const close = t.cards()[0].querySelector('.unlockClose');
  assert.strictEqual(close.getAttribute('aria-label'), 'Schließen');
  assert.ok(close.querySelector('svg use[href="#i-close"]'), 'an icon from the sprite, not a glyph');
  assert.strictEqual(t.cards()[0].querySelector('.unlockArt').getAttribute('aria-hidden'), 'true');
  await t.run(SHOW_MS + NEXT_MS);
  t.unlock('pd_caught'); // a single badge: no tier
  assert.deepStrictEqual(t.view(), [['😱', 'Abzeichen freigeschaltet', 'Autsch!', 'Pik Dame am Rundenende auf der Hand erwischt (\u2212100)']]);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();

  const en = boot({ storage: { pikdame_lang: 'en' } });
  en.ws().fire('open');
  en.unlock('wins_10');
  assert.deepStrictEqual(en.view(), [['🏆', 'Badge unlocked', 'Serial winner', 'Tier 2 of 3 · Won 10 games']]);
  assert.strictEqual(en.cards()[0].querySelector('.unlockClose').getAttribute('aria-label'), 'Close');
  en.window.close();
});

test('the language switch rewrites the visible card', async () => {
  const t = boot();
  t.ws().fire('open');
  t.unlock('first_win');
  t.doc.getElementById('langBtn').click();
  assert.deepStrictEqual(t.view(), [['🏆', 'Badge unlocked', 'First win', 'Tier 1 of 3 · Won your first game']]);
  t.window.close();
});

test('whatever the server sends is shown as text, never as markup', () => {
  const t = boot();
  t.ws().fire('open');
  t.unlock('<img src=x onerror=alert(1)>');
  const layer = t.doc.getElementById('unlockLayer');
  assert.strictEqual(layer.querySelector('img'), null);
  assert.strictEqual(t.names()[0], '<img src=x onerror=alert(1)>');
  t.msg({ type: 'badgeUnlocks', name: 'Flo', badges: [null, { id: 7 }, 'x'] });
  t.msg({ type: 'badgeUnlocks', name: 'Flo' });
  assert.strictEqual(t.cards().length, 1, 'junk entries make no card');
  t.window.close();
});

test('one card at a time: three, then the rest folded into "+N"; the same badge never twice', async () => {
  const t = boot();
  t.ws().fire('open');
  t.unlock('first_win', 'pd_laid', 'ring_run', 'run_13', 'pile_glutton');
  assert.deepStrictEqual(t.names(), ['Erster Sieg']);
  await t.run(SHOW_MS - 100);
  assert.deepStrictEqual(t.names(), ['Erster Sieg'], 'it stays its full time');
  await t.run(100 + NEXT_MS);
  assert.deepStrictEqual(t.names(), ['Damensammler']);
  await t.run(SHOW_MS + NEXT_MS);
  assert.deepStrictEqual(t.names(), ['Ringschluss']);
  await t.run(SHOW_MS + NEXT_MS);
  assert.deepStrictEqual(t.view(), [['+2', 'Abzeichen freigeschaltet', '2 weitere Abzeichen', 'Die ganze Farbe · Stapelfresser']]);
  assert.ok(t.cards()[0].querySelector('.unlockArt.isCount'));
  await t.run(SHOW_MS + NEXT_MS);
  assert.deepStrictEqual(t.cards(), [], 'the queue is empty');
  t.unlock('first_win', 'pd_laid');
  assert.deepStrictEqual(t.cards(), [], 'never twice on this page');

  // A new burst starts counting again; a single leftover gets its own card.
  t.unlock('streak_3', 'red_lantern', 'night_owl', 'landslide');
  for (const name of ['Siegesserie', 'Rote Laterne', 'Nachteule', 'Erdrutschsieg']) {
    assert.deepStrictEqual(t.names(), [name]);
    await t.run(SHOW_MS + NEXT_MS);
  }
  t.window.close();

  const en = boot({ storage: { pikdame_lang: 'en' } });
  en.ws().fire('open');
  en.unlock('first_win', 'pd_laid', 'ring_run', 'run_13', 'pile_glutton', 'joker_king');
  await en.run(3 * (SHOW_MS + NEXT_MS));
  assert.deepStrictEqual(en.view(), [['+3', 'Badges unlocked', '3 more badges', 'The whole suit · Pile glutton · Joker king']]);
  en.window.close();
});

test('×, a swipe and Escape close it; hovering or focusing it stops its clock', async () => {
  const t = boot();
  t.ws().fire('open');
  t.unlock('first_win', 'pd_laid', 'ring_run', 'run_13');
  t.cards()[0].querySelector('.unlockClose').click();
  assert.deepStrictEqual(t.cards(), [], 'gone at once');
  await t.run(NEXT_MS);
  assert.deepStrictEqual(t.names(), ['Damensammler']);

  // A finger drags it up and lets go: away. A short drag snaps back.
  const layer = t.doc.getElementById('unlockLayer');
  const touch = (type, x, y) => {
    const ev = new t.window.Event(type, { bubbles: true });
    ev.touches = type === 'touchend' ? [] : [{ clientX: x, clientY: y }];
    t.cards()[0].querySelector('.unlockName').dispatchEvent(ev);
  };
  touch('touchstart', 100, 100);
  touch('touchmove', 104, 92);
  touch('touchend');
  assert.deepStrictEqual(t.names(), ['Damensammler'], 'a short drag snaps back');
  assert.strictEqual(t.cards()[0].style.transform, '');
  touch('touchstart', 100, 100);
  touch('touchmove', 100, 50);
  touch('touchend');
  assert.deepStrictEqual(t.cards(), [], 'swiped up');
  await t.run(NEXT_MS);
  touch('touchstart', 100, 100);
  touch('touchmove', 190, 104);
  touch('touchend');
  const gone = layer.querySelector('.unlockCard.leaving');
  assert.ok(gone && gone.style.getPropertyValue('--leave-x') === '120%', 'swiped to the right, it leaves to the right');
  await t.run(NEXT_MS);

  assert.deepStrictEqual(t.names(), ['Die ganze Farbe']);
  layer.dispatchEvent(new t.window.MouseEvent('mouseover', { bubbles: true }));
  await t.run(3 * SHOW_MS);
  assert.deepStrictEqual(t.names(), ['Die ganze Farbe'], 'held while the pointer rests on it');
  layer.dispatchEvent(new t.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: t.doc.body }));
  await t.run(1400);
  assert.deepStrictEqual(t.names(), ['Die ganze Farbe'], 'some time left to read after the pointer goes');
  await t.run(SHOW_MS);
  assert.deepStrictEqual(t.cards(), []);
  t.unlock('night_owl');
  t.cards()[0].querySelector('.unlockMain').focus();
  layer.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepStrictEqual(t.cards(), [], 'Escape');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a tap on the start screen opens the badge in the trophy cabinet; at the table it only dismisses', async () => {
  const t = boot({ storage: { pikdame_account_token: 'tok' } });
  t.ws().fire('open');
  t.msg({ type: 'profiles', players: [PROFILE] });
  t.unlock('wins_10');
  t.cards()[0].querySelector('.unlockMain').click();
  assert.ok(t.shown('statsOverlay'), 'the statistics open');
  const tile = t.doc.querySelector('#achievementsBox .achTile[data-ach="wins"]');
  assert.ok(tile, 'the whole cabinet is unfolded');
  assert.strictEqual(tile.getAttribute('aria-expanded'), 'true', 'on the badge, its detail open');
  assert.ok(tile.classList.contains('earned'), 'and it counts as earned before the profile list catches up');
  assert.ok(t.ws().sent.some((m) => m.type === 'listProfiles'), 'fresh data on the way');
  await t.run(NEXT_MS);
  t.doc.getElementById('statsCloseBtn').click();

  // A sheet above the statistics (DOM order) would hide it: then the tap just closes the card.
  t.unlock('first_win');
  t.doc.getElementById('progressOverlay').classList.remove('hidden');
  t.cards()[0].querySelector('.unlockMain').click();
  assert.ok(!t.shown('statsOverlay'));
  assert.deepStrictEqual(t.cards(), []);
  t.doc.getElementById('progressOverlay').classList.add('hidden');
  t.window.close();

  const table = boot();
  table.ws().fire('open');
  table.msg({ type: 'joined', playerId: 'p1', playerToken: 'tok-flo', sessionCode: 'ABC123' });
  table.msg({ type: 'state', state: tableState() });
  assert.ok(table.shown('table'));
  table.unlock('pd_laid');
  assert.deepStrictEqual(table.cards(), [], 'the round\'s opening line (a priority toast) has its turn first');
  await table.run(5200);
  table.cards()[0].querySelector('.unlockMain').click();
  assert.deepStrictEqual(table.cards(), [], 'dismissed');
  assert.ok(!table.shown('statsOverlay'), 'nothing opens over the running game');
  table.window.close();
});

test('priority toasts go first: a card waits for their lock and steps back when one starts', async () => {
  const t = boot();
  t.ws().fire('open');
  // A server error is a priority toast (5 s).
  t.msg({ type: 'error', error: 'Du bist nicht am Zug.' });
  t.unlock('first_win');
  assert.deepStrictEqual(t.cards(), [], 'never both at once');
  await t.run(4900);
  assert.deepStrictEqual(t.cards(), []);
  await t.run(300);
  assert.deepStrictEqual(t.names(), ['Erster Sieg'], 'right after the lock');

  await t.run(2000);
  t.msg({ type: 'error', error: 'Du bist nicht am Zug.' });
  assert.deepStrictEqual(t.cards(), [], 'it steps back for a toast that starts');
  await t.run(5200);
  assert.deepStrictEqual(t.names(), ['Erster Sieg'], 'and comes back afterwards, with its full time');
  await t.run(SHOW_MS - 200);
  assert.deepStrictEqual(t.names(), ['Erster Sieg']);
  // An ordinary toast (no lock) never waits for a card, nor holds one back.
  t.msg({ type: 'badgeUnlocks', name: 'Flo', badges: [{ id: 'pd_laid', earnedAt: 1 }] });
  await t.run(400 + NEXT_MS);
  assert.deepStrictEqual(t.names(), ['Damensammler']);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('the claim: on the start screen at once, at a rejoined table after its state, never at the tutorial table', async () => {
  const start = boot({ storage: { pikdame_account_token: 'tok' } });
  start.ws().fire('open');
  assert.deepStrictEqual(start.claims(), [{ type: 'claimBadges', name: 'Flo', accountToken: 'tok' }]);
  start.msg({ type: 'profiles', players: [PROFILE] });
  assert.strictEqual(start.claims().length, 1, 'once per connection');
  const first = start.ws();
  first.fire('close');
  await start.run(10000); // reconnects
  assert.notStrictEqual(start.ws(), first, 'a new socket');
  start.ws().fire('open');
  assert.strictEqual(start.claims().length, 1, 'the new socket asks again');
  start.window.close();

  const rejoin = { url: 'https://play.example/?session=ABC123', storage: { pikdame_player_ABC123: 'p1', pikdame_token_ABC123: 'tok-flo' } };
  const table = boot(rejoin);
  table.ws().fire('open');
  assert.deepStrictEqual(table.claims(), [], 'not before the table says what it is');
  table.msg({ type: 'joined', playerId: 'p1', playerToken: 'tok-flo', sessionCode: 'ABC123' });
  table.msg({ type: 'state', state: tableState() });
  assert.deepStrictEqual(table.claims().map((m) => m.name), ['Flo']);
  table.window.close();

  const tutorial = boot(rejoin);
  tutorial.ws().fire('open');
  tutorial.msg({ type: 'joined', playerId: 'p1', playerToken: 'tok-flo', sessionCode: 'ABC123' });
  tutorial.msg({ type: 'state', state: tableState({ tutorialMode: true }) });
  assert.deepStrictEqual(tutorial.claims(), [], 'no claim at the tutorial table');
  tutorial.unlock('first_win');
  await tutorial.run(3 * SHOW_MS);
  assert.deepStrictEqual(tutorial.cards(), [], 'and no card over the coach');
  tutorial.window.close();
});

test('the intro and a hidden page hold the cards back; a card never runs out unseen', async () => {
  const t = boot();
  t.ws().fire('open');
  const splash = t.doc.createElement('div');
  splash.id = 'studioSplash';
  t.doc.body.appendChild(splash);
  t.unlock('first_win');
  await t.run(3000);
  assert.deepStrictEqual(t.cards(), [], 'not under the intro');
  splash.remove();
  await t.run(600);
  assert.deepStrictEqual(t.names(), ['Erster Sieg']);

  let state = 'visible';
  Object.defineProperty(t.doc, 'visibilityState', { configurable: true, get: () => state });
  state = 'hidden';
  t.doc.dispatchEvent(new t.window.Event('visibilitychange'));
  await t.run(60000);
  assert.deepStrictEqual(t.names(), ['Erster Sieg'], 'its clock stops while the app is in the background');
  state = 'visible';
  t.doc.dispatchEvent(new t.window.Event('visibilitychange'));
  await t.run(1400);
  assert.deepStrictEqual(t.names(), ['Erster Sieg']);
  await t.run(SHOW_MS);
  assert.deepStrictEqual(t.cards(), []);
  t.window.close();
});

test('a solved puzzle no longer says it in a text toast (the cards do)', () => {
  const t = boot();
  t.ws().fire('open');
  t.msg({ type: 'puzzle', date: '2026-10-24', today: '2026-10-24', epoch: '2026-01-01', kind: 'meld', hand: [], targetPoints: 50, status: { tries: 0, solved: false, revealed: false } });
  t.msg({ type: 'puzzleResult', valid: true, solved: true, points: 60, xp: 20, badges: ['puzzle_7'], status: { tries: 1, solved: true, revealed: false } });
  assert.doesNotMatch(t.doc.getElementById('toastContainer').textContent, /Neuer Erfolg/);
  t.window.close();
});

test('CSS: the card has its own layer in the scale, room to tap, and only fades with reduced motion', () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => {
    const m = plain.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
    assert.ok(m, `${sel} is styled`);
    return m[1];
  };
  assert.match(rule('.unlockLayer'), /z-index:\s*var\(--z-unlock\)/);
  assert.match(rule('.unlockLayer'), /pointer-events:\s*none/, 'the empty layer never takes a tap');
  assert.match(rule('.unlockLayer'), /var\(--safe-top\)/, 'below the notch');
  assert.match(rule('.unlockClose'), /width:\s*var\(--tap-min\)/);
  assert.match(rule('.unlockClose'), /height:\s*var\(--tap-min\)/);
  const z = (n) => Number(plain.match(new RegExp(`--z-${n}:\\s*(\\d+)`))[1]);
  assert.ok(z('unlock') > z('overlay') && z('unlock') < z('critical'), 'over the sheets, under pause and forfeit');
  const still = plain.slice(plain.indexOf('@media (prefers-reduced-motion: reduce) {\n  .unlockLayer'));
  const block = still.slice(0, still.indexOf('\n}\n'));
  assert.match(block, /\.unlockLayer \{ transition: none; \}/, 'no glide when a sheet moves it');
  assert.match(block, /\.unlockCard \{ animation: unlockFadeIn/);
  assert.match(block, /\.unlockCard\.leaving \{ animation: unlockFadeOut/);
  assert.match(block, /\.unlockCard::after, \.unlockArt \{ animation: none; \}/);
  for (const name of ['unlockFadeIn', 'unlockFadeOut']) {
    const frames = plain.match(new RegExp(`@keyframes ${name} \\{([^\\n]*)\\}`))[1];
    assert.doesNotMatch(frames, /transform/, `${name}: no slide`);
    assert.match(frames, /opacity/);
  }
});
