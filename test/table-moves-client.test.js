// Other players' moves fly at the table (client.js + public/table-moves.js): ghosts
// between the stock, the pile, the player's chip and their melds, a new meld card hidden
// until its ghost lands, the piles never covered, quiet sounds, never queued behind the next state.
// My own meld cards glide the same way from their place in the hand into my melds.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const SRC = ['i18n.js', 'table-moves.js', 'client.js'].map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

// Boxes on screen [left, top, width, height]: the chips, their avatars, the two piles, my hand
// and a card in it. Portrait: chips at the top, the piles side by side far below, the hand
// under them. Landscape: the piles right of the chips at the same height, the stock between
// them and the discard pile; the hand below. Desktop: the piles in a column on the right.
const PORTRAIT = { chip: [10, 60, 110, 52], avatar: [16, 66, 40, 40], stock: [140, 520, 48, 66], discard: [196, 520, 48, 66], hand: [0, 700, 393, 120], handCard: [20, 720, 40, 56] };
const LANDSCAPE = { chip: [480, 60, 170, 52], avatar: [486, 66, 40, 40], stock: [755, 65, 48, 66], discard: [816, 65, 48, 66], hand: [220, 330, 434, 70], handCard: [230, 335, 40, 56] };
const DESKTOP = { chip: [480, 72, 230, 68], avatar: [488, 80, 40, 40], stock: [1310, 165, 90, 125], discard: [1310, 330, 90, 125], hand: [240, 740, 960, 150], handCard: [1100, 750, 80, 112] };

/** The real client in jsdom with layout, Web Animations and frames stubbed; the clock is the test's. */
function boot({ reduced = false, animate = true, stored = {}, layout = PORTRAIT, mouse = false } = {}) {
  const errors = [];
  // jsdom has no styles of pseudo-elements (the card back's medallion): that alone is no error.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(HTML, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const clock = { t: 1000 };
  window.performance.now = () => clock.t;
  // mouse: a fine pointer, so hand cards can be dragged onto a meld.
  window.matchMedia = (q) => ({ matches: (reduced && /prefers-reduced-motion: reduce/.test(q)) || (mouse && /pointer: fine/.test(q)), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const vibes = [];
  window.navigator.vibrate = (pattern) => { vibes.push(pattern); return true; };
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  // Every box on screen; the meld area takes the whole screen so no card counts as scrolled away.
  window.Element.prototype.getBoundingClientRect = function rect() {
    const pile = this.closest('.pile');
    let box = [300, 400, 40, 56]; // a meld card
    if (this.id === 'melds') box = layout.melds || [0, 0, 2000, 2000];
    else if (this.id === 'hand') box = layout.hand;
    else if (this.closest('#hand')) box = layout.handCard;
    else if (this.classList.contains('opponent')) box = layout.chip;
    else if (this.classList.contains('opAvatar')) box = layout.avatar;
    else if (this.classList.contains('hidden')) box = [0, 0, 0, 0];
    else if (pile) {
      const [x, y, w, h] = layout[pile.id === 'drawPile' ? 'stock' : 'discard'];
      if (this === pile) box = [x, y, w, h + 18];
      else if (this.classList.contains('pileLabel')) box = [x, y + h + 4, w, 14];
      else if (/Count$/.test(this.id)) box = [x + w - 12, y - 8, 20, 20]; // the badge on the corner
      else box = this.classList.contains('pile-card') ? [x, y, w, h] : [x + 4, y + h - 28, 24, 24];
    }
    const [left, top, width, height] = box;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  };
  const anims = [];
  if (animate) {
    window.Element.prototype.animate = function animateStub(frames, opts) {
      const a = { el: this, frames, opts: typeof opts === 'number' ? { duration: opts } : opts, cancelled: false, onfinish: null, cancel() { this.cancelled = true; } };
      anims.push(a);
      return a;
    };
  }
  // Frames run when the test says so, after the render - as in the browser.
  let frames = [];
  window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  const flush = () => {
    for (let i = 0; i < 3 && frames.length; i++) {
      const run = frames;
      frames = [];
      for (const cb of run) cb(clock.t);
    }
  };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  const tones = [];
  window.AudioContext = function () {
    return {
      createOscillator: () => ({ connect: (x) => x, start() {}, stop() {}, type: 'sine', frequency: { setValueAtTime() {}, value: 0 } }),
      createGain: () => ({ connect: (x) => x, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime(v) { tones.push(v); } } }),
      destination: { connect: (x) => x }, currentTime: 0, state: 'running',
      resume: () => Promise.resolve(), suspend: () => Promise.resolve(),
    };
  };
  window.webkitAudioContext = window.AudioContext;
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) {
      if (typeof this['on' + t] === 'function') this['on' + t](ev);
      for (const f of this._ls[t] || []) f(ev);
    }
    send() {} close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  window.console.error = (...a) => errors.push(a.map(String).join(' '));
  window.localStorage.setItem('pikdame_tip_seen', '9');
  for (const [k, v] of Object.entries(stored)) window.localStorage.setItem(k, v); // a reload: what this device kept
  for (const src of SRC) window.eval(src);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const send = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  const join = () => send({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOVES1' });
  const state = (st) => { send({ type: 'state', state: st }); flush(); };
  return { window, doc: window.document, errors, clock, join, state, send, anims, tones, vibes, flush };
}
const ready = () => new Promise((r) => setTimeout(r, 10));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- states ---------------------------------------------------------------------
const C = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
const HAND = ['H2-0', 'H5-0', 'C9-0', 'D10-0', 'SK-0'];
const SEVENS = ['H7-0', 'D7-0', 'C7-0'];
/** A playing state as p1 sees it; pile top first, melds as [ownerId, [ids]]. */
function st({ pile = ['D4-0', 'C3-1'], melds = [], turn = 8, cur = 'b1', phase = 'draw', draw = 40, faceDownTop = false, pace, ...rest } = {}) {
  const cards = pile.map(C);
  return {
    phase: 'playing', roundNumber: 2, turnIndexInRound: turn, currentPlayerId: cur, turnPhase: phase, dealerId: 'b2',
    drawPileCount: draw, discardTop: cards[0] ? (faceDownTop ? { faceDown: true } : cards[0]) : null, discardPileCount: cards.length,
    discardCards: cards.map((c, i) => (i === 0 && faceDownTop ? { faceDown: true } : c)),
    tableMelds: melds.map(([ownerId, ids], i) => ({ id: `m${i}`, ownerId, type: 'set', slots: ids.map((id) => ({ real: C(id) })) })),
    log: [], houseRules: pace ? { botPace: pace } : {}, lobbyReady: [], nextRoundReady: [], totals: { p1: 120, b1: 80, b2: 60 }, scoreHistory: [],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: HAND.length, hand: HAND.map(C) },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 12, botDifficulty: 'medium' },
      { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 9, botDifficulty: 'medium' },
    ],
    ...rest,
  };
}
/** Klaus (b1) plays a whole turn: draws, lays three sevens, throws the D9. */
const before = (o = {}) => st({ cur: 'b1', phase: 'draw', ...o });
const after = (o = {}) => st({ cur: 'b2', turn: 9, draw: 39, pile: ['D9-1', 'D4-0', 'C3-1'], melds: [['b1', SEVENS]], ...o });

const ghosts = (doc) => [...doc.querySelectorAll('body > .oppFly')];
const flightOf = (c, g) => c.anims.find((a) => a.el === g);
const holdsOn = (c, node) => c.anims.filter((a) => a.el === node && a.frames.every((f) => f.opacity === 0) && !a.cancelled);
const meldCard = (doc, id) => doc.querySelector(`#melds .card[data-card-id="${id}"]`);
const endOf = (a) => a.opts.delay + a.opts.duration;
const SLACK = 120; // = OPP_HOLD_SLACK_MS in client.js
const levels = (tones) => tones.map((v) => Math.round(v * 1000) / 1000);

test('a bot turn in one state: the stock card, three meld cards and the discard fly in turn order', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  assert.deepEqual(ghosts(c.doc), [], 'the first state is a baseline');
  c.clock.t += 50;
  c.state(after());
  const gs = ghosts(c.doc);
  assert.strictEqual(gs.length, 5, 'draw + three meld cards + discard');
  const [draw, ...rest] = gs;
  const discard = rest.pop();
  assert.ok(draw.classList.contains('back') && draw.classList.contains('pile-card'), 'a card back leaves the stock');
  assert.strictEqual(discard.textContent, '9♦', 'the discard shows its face');
  assert.ok(rest.every((g) => g.classList.contains('card-compact') && !g.dataset.cardId), 'meld ghosts copy the meld card, without its id');
  assert.deepEqual(rest.map((g) => g.querySelector('.corner').textContent), ['7♥', '7♦', '7♣']);
  assert.ok(gs.every((g) => g.getAttribute('aria-hidden') === 'true' && g.style.opacity === '0'), 'decoration, invisible until its turn');
  // Turn order with overlap, all within the 600 ms of a normal-pace turn.
  const [a0, ...am] = gs.map((g) => flightOf(c, g));
  const ad = am.pop();
  assert.strictEqual(a0.opts.delay, 0);
  assert.ok(am.every((a, i) => a.opts.delay > a0.opts.delay && (i === 0 || a.opts.delay > am[i - 1].opts.delay)), 'meld cards staggered after the draw');
  assert.ok(ad.opts.delay > am[0].opts.delay, 'the discard last');
  assert.ok(gs.every((g) => endOf(flightOf(c, g)) <= 600 + 1e-6), 'one turn is over in 600 ms');
  // Into the chip it fades, out of it it appears; a meld card lands as the real one.
  assert.strictEqual(a0.frames.at(-1).opacity, 0);
  assert.strictEqual(am[0].frames[0].opacity, 0);
  assert.strictEqual(am[0].frames.at(-1).opacity, 1);
  // At the piles a ghost is see-through: it rises from the stock and melts into the discard pile.
  assert.strictEqual(a0.frames[0].opacity, 0, 'never a second card on the stock');
  assert.strictEqual(ad.frames[0].opacity, 0);
  assert.strictEqual(ad.frames.at(-1).opacity, 0, 'never a second card on the pile');
  // The new meld cards wait invisible until their ghost lands (on their own a moment later, should it never land).
  for (const [i, id] of SEVENS.entries()) {
    const hold = holdsOn(c, meldCard(c.doc, id));
    assert.strictEqual(hold.length, 1, `${id} is hidden while it flies`);
    assert.ok(Math.abs(hold[0].opts.duration - endOf(am[i]) - SLACK) < 1e-6, `${id}: the hold outlasts the flight`);
  }
  // The pile shows the state's card at once: the D9, nothing held back, nothing in front of it.
  const top = c.doc.getElementById('discardTopCard');
  assert.strictEqual(top.textContent, '9♦');
  assert.deepEqual(c.anims.filter((a) => a.el === top), []);
  assert.strictEqual(c.doc.querySelectorAll('#discardPile .pile-card').length, 1, 'one card on the pile');
  // A meld card lands: in the same frame its ghost goes and the card shows.
  const meldHold = holdsOn(c, meldCard(c.doc, 'H7-0'))[0];
  am[0].onfinish();
  assert.ok(meldHold.cancelled && !rest[0].isConnected);
  // The discard has melted into its card: the ghost goes, the pile is not touched again.
  const popped = top.className;
  ad.onfinish();
  assert.ok(!discard.isConnected);
  assert.strictEqual(top.className, popped, 'no second pop after the flight');
  assert.deepEqual(c.errors, []);
});

test('quiet sounds: the draw, the melds and the discard, one each, softer than my own', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  c.tones.length = 0;
  c.vibes.length = 0;
  c.state(after());
  await wait(700);
  // draw (one tone), meld (three tones), discard (two tones) - all at the quiet level, no buzz.
  assert.deepEqual(levels(c.tones), [0.02, 0.024, 0.024, 0.024, 0.02, 0.02]);
  assert.deepEqual(c.vibes, []);
  // My own draw keeps its level and its buzz.
  c.state(after({ cur: 'p1', turn: 10 }));
  c.tones.length = 0;
  c.vibes.length = 0;
  c.doc.getElementById('drawPile').click();
  assert.deepEqual(levels(c.tones), [0.05]);
  assert.deepEqual(c.vibes, [8]);
  assert.deepEqual(c.errors, []);
});

test('"Schnell": the whole turn flies within 300 ms, before the next bot moves', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before({ pace: 'fast' }));
  c.clock.t += 50;
  c.state(after({ pace: 'fast' }));
  const gs = ghosts(c.doc);
  assert.strictEqual(gs.length, 5);
  assert.ok(gs.every((g) => endOf(flightOf(c, g)) <= 300 + 1e-6), 'never longer than the fast bot think time');
  assert.deepEqual(c.errors, []);
});

test('the next player\'s state ends the flight at once: nothing queues behind the table', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  c.state(after());
  const first = ghosts(c.doc).map((g) => flightOf(c, g));
  const holds = c.anims.filter((a) => a.frames.every((f) => f.opacity === 0));
  // Horst draws 200 ms later, while Klaus's cards are still in the air.
  c.clock.t += 200;
  c.state(after({ phase: 'meld', draw: 38 }));
  assert.ok(first.every((a) => a.cancelled), 'the old flights are cancelled');
  assert.ok(holds.every((a) => a.cancelled), 'every held card shows');
  const now = ghosts(c.doc);
  assert.strictEqual(now.length, 1, "only Horst's draw flies");
  assert.strictEqual(flightOf(c, now[0]).opts.delay, 0, 'and it starts right away');
  assert.deepEqual(c.errors, []);
});

test('my tap on the pile while the discard is still in the air: the pile already shows it, the flight lands', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  c.state(after({ cur: 'p1' })); // Klaus threw the D9 - and it is my turn
  const flights = ghosts(c.doc).map((g) => flightOf(c, g));
  assert.strictEqual(c.doc.getElementById('discardTopCard').textContent, '9♦', 'the card I would take is the one I see');
  c.clock.t += 120;
  c.doc.getElementById('discardPile').click();
  assert.ok(flights.every((a) => a.cancelled), 'the flight ends at once');
  assert.strictEqual(ghosts(c.doc).length, 0);
  assert.deepEqual(c.errors, []);
});

test('a Zen bot: its discard a moment after the melds joins the same flight, behind them', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  c.state(st({ cur: 'b1', phase: 'meld', draw: 39, melds: [['b1', SEVENS]] }));
  const head = ghosts(c.doc).map((g) => flightOf(c, g));
  assert.strictEqual(head.length, 4, 'draw + three meld cards');
  c.clock.t += 5;
  c.state(after());
  assert.ok(head.every((a) => !a.cancelled), 'the running flights go on');
  const all = ghosts(c.doc);
  assert.strictEqual(all.length, 5);
  const discard = flightOf(c, all.at(-1));
  assert.strictEqual(all.at(-1).textContent, '9♦');
  // Planned on the turn's clock (5 ms in): after the melds started, done within the turn.
  assert.ok(discard.opts.delay + 5 > Math.max(...head.map((a) => a.opts.delay)), 'behind the melds');
  assert.ok(endOf(discard) + 5 <= 600 + 1e-6);
  // The meld cards rebuilt by that render stay hidden until their own landing.
  for (const id of SEVENS) assert.strictEqual(holdsOn(c, meldCard(c.doc, id)).length, 1, `${id} still hidden`);
  assert.deepEqual(c.errors, []);
});

test('a re-render mid-flight hides the rebuilt meld cards again, without a second ghost', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  c.state(after());
  const old = meldCard(c.doc, 'H7-0');
  c.clock.t += 100;
  c.doc.getElementById('sortToggleBtn').click(); // any re-render rebuilds the melds
  c.flush();
  const fresh = meldCard(c.doc, 'H7-0');
  assert.notStrictEqual(fresh, old);
  const hold = holdsOn(c, fresh);
  assert.strictEqual(hold.length, 1, 'hidden again');
  const ghost = ghosts(c.doc)[1];
  assert.ok(Math.abs(hold[0].opts.duration - (endOf(flightOf(c, ghost)) - 100) - SLACK) < 1e-6, 'until the same landing');
  assert.strictEqual(ghosts(c.doc).length, 5, 'no new ghosts');
  flightOf(c, ghost).onfinish();
  assert.ok(hold[0].cancelled, 'and the landing shows the rebuilt card');
  assert.deepEqual(c.errors, []);
});

test('a pile take: its top card flies face up from the pile to the chip, the pile shows the state', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before({ pile: ['H7-0', 'S2-0', 'S3-0', 'S4-0', 'S5-0'] }));
  c.clock.t += 50;
  // Took the pile, laid the seven with two from the hand, threw the D9: one state.
  c.state(after({ draw: 40, pile: ['D9-1'], melds: [['b1', SEVENS]] }));
  const gs = ghosts(c.doc);
  const taken = gs.filter((g) => g.classList.contains('pile-card') && g !== gs.at(-1));
  assert.deepEqual(taken.map((g) => g.textContent), ['7♥'], 'one card, face up: no stack popping up over the pile');
  const fl = flightOf(c, taken[0]);
  assert.strictEqual(fl.frames[0].opacity, 0, 'it rises from the pile, never covers it');
  assert.strictEqual(fl.frames.at(-1).opacity, 0, 'and melts into the chip');
  assert.ok(!gs.some((g) => g.classList.contains('back')), 'no card back: nothing came from the stock');
  assert.strictEqual(c.doc.getElementById('discardTopCard').textContent, '9♦', 'the pile shows the state at once');
  assert.deepEqual(c.errors, []);
});

test('never: my own moves, reduced motion, a hidden page, an open sheet, no Web Animations', async (t) => {
  // My own turn: my taps fly my cards.
  {
    const c = boot();
    t.after(() => c.window.close());
    await ready();
    c.join();
    c.state(before({ cur: 'p1' }));
    c.clock.t += 50;
    c.state(after({ cur: 'b1' }));
    assert.deepEqual(ghosts(c.doc), []);
    assert.deepEqual(c.anims.filter((a) => a.frames.every((f) => f.opacity === 0)), [], 'nothing hidden');
  }
  // Reduced motion: no ghosts, nothing hidden - the quiet sounds stay.
  {
    const c = boot({ reduced: true });
    t.after(() => c.window.close());
    await ready();
    c.join();
    c.state(before());
    c.clock.t += 50;
    c.tones.length = 0;
    c.state(after());
    assert.deepEqual(ghosts(c.doc), []);
    assert.deepEqual(c.anims, []);
    await wait(700);
    assert.deepEqual(levels(c.tones), [0.02, 0.024, 0.024, 0.024, 0.02, 0.02]);
  }
  // A page in the background: neither flights nor sounds.
  {
    const c = boot();
    t.after(() => c.window.close());
    await ready();
    c.join();
    c.state(before());
    Object.defineProperty(c.doc, 'hidden', { configurable: true, get: () => true });
    c.clock.t += 50;
    c.tones.length = 0;
    c.state(after());
    assert.deepEqual(ghosts(c.doc), []);
    await wait(700);
    assert.deepEqual(c.tones, []);
  }
  // A sheet over the table: the cards simply show.
  {
    const c = boot();
    t.after(() => c.window.close());
    await ready();
    c.join();
    c.state(before());
    c.doc.getElementById('settingsOverlay').classList.remove('hidden');
    c.clock.t += 50;
    c.state(after());
    assert.deepEqual(ghosts(c.doc), []);
    assert.ok(c.anims.filter((a) => a.frames.every((f) => f.opacity === 0)).every((a) => a.cancelled), 'no card stays hidden');
  }
  // An old browser without element.animate: the table works as before.
  {
    const c = boot({ animate: false });
    t.after(() => c.window.close());
    await ready();
    c.join();
    c.state(before());
    c.clock.t += 50;
    c.state(after());
    assert.deepEqual(ghosts(c.doc), []);
    assert.deepEqual(c.errors, []);
  }
});

test('going out: the last card flies face down while the table shows; under an open result sheet nothing flies', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  const mk = (score, win) => ({ roundScore: score, breakdown: { isWinner: !!win, multiplier: 1 } });
  // The engine's round end keeps the table as it was: the face-down card on top, the turn unchanged.
  c.state({
    ...st({ cur: 'b1', draw: 39, pile: ['X1-0', 'D4-0', 'C3-1'], faceDownTop: true, melds: [['b1', SEVENS]] }),
    phase: 'roundEnd', lastRoundWinnerId: 'b1',
    lastRoundResult: { p1: mk(-60), b1: mk(120, true), b2: mk(-20) },
    lastRoundStats: [{ id: 'p1', name: 'Flo', laidOutCount: 0, handCount: 5 }, { id: 'b1', name: 'Klaus', laidOutCount: 15, handCount: 0 }, { id: 'b2', name: 'Horst', laidOutCount: 3, handCount: 9 }],
  });
  const gs = ghosts(c.doc);
  if (!c.doc.getElementById('resultOverlay').classList.contains('hidden')) {
    // The sheet opens with the round's end: nothing flies under it, no card stays hidden.
    assert.deepEqual(gs, []);
    assert.ok(c.anims.filter((a) => a.frames.every((f) => f.opacity === 0)).every((a) => a.cancelled));
  } else {
    // A beat on the final table before the sheet: the winner's last card settles face down.
    const last = gs.at(-1);
    assert.ok(last.classList.contains('back'), 'face down');
    assert.ok(c.doc.getElementById('discardTopCard').classList.contains('back'), 'the pile shows it at once');
  }
  assert.deepEqual(c.errors, []);
});

test('going out with a beat before the sheet: the winner\'s face-down card settles onto the pile', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  // A beat on the final table: the sheet stays hidden for a moment after the round's end.
  const sheet = c.doc.getElementById('resultOverlay');
  new c.window.MutationObserver(() => { if (!sheet.classList.contains('hidden')) sheet.classList.add('hidden'); })
    .observe(sheet, { attributes: true, attributeFilter: ['class'] });
  const mk = (score, win) => ({ roundScore: score, breakdown: { isWinner: !!win, multiplier: 1 } });
  c.send({
    type: 'state',
    state: {
      ...st({ cur: 'b1', draw: 39, pile: ['X1-0', 'D4-0', 'C3-1'], faceDownTop: true, melds: [['b1', SEVENS]] }),
      phase: 'roundEnd', lastRoundWinnerId: 'b1',
      lastRoundResult: { p1: mk(-60), b1: mk(120, true), b2: mk(-20) },
      lastRoundStats: [{ id: 'p1', name: 'Flo', laidOutCount: 0, handCount: 5 }, { id: 'b1', name: 'Klaus', laidOutCount: 15, handCount: 0 }, { id: 'b2', name: 'Horst', laidOutCount: 3, handCount: 9 }],
    },
  });
  await Promise.resolve(); // the observer runs before the next frame
  c.flush();
  const gs = ghosts(c.doc);
  assert.strictEqual(gs.length, 5, 'draw, three meld cards and the last card');
  const last = gs.at(-1);
  assert.ok(last.classList.contains('back'), 'face down');
  assert.strictEqual(flightOf(c, last).frames.at(-1).opacity, 0, 'it melts into the pile');
  assert.ok(c.doc.getElementById('discardTopCard').classList.contains('back'), 'which shows the face-down card at once');
  assert.deepEqual(c.errors, []);
});

test('her own moment on the pile: a thrown Pik Dame turns there at once, no ghost over her', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  c.state(after({ pile: ['SQ-0', 'D4-0', 'C3-1'] }));
  const top = c.doc.getElementById('discardTopCard');
  assert.ok(top.classList.contains('qTurn') && top.textContent.startsWith('Q♠'), 'her head turn on the pile');
  assert.strictEqual(top.style.getPropertyValue('--q-delay'), '0ms', 'right away, as before');
  assert.ok(!ghosts(c.doc).some((g) => g.classList.contains('pile-card') && /^Q♠/.test(g.textContent)), 'no flat copy over her face');
  assert.strictEqual(ghosts(c.doc).length, 4, 'the draw and the meld still fly');
  assert.deepEqual(c.errors, []);
});

test('her head turn on the table waits for her glide to land', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  c.state(after({ melds: [['b1', ['SQ-0', 'HQ-0', 'CQ-0']]] }));
  const q = meldCard(c.doc, 'SQ-0');
  assert.ok(q.classList.contains('qTurn'), 'her turn is armed');
  const ghost = ghosts(c.doc).find((g) => g.querySelector('.corner') && g.querySelector('.corner').textContent === 'Q♠');
  const land = endOf(flightOf(c, ghost));
  assert.strictEqual(q.style.getPropertyValue('--q-delay'), `${Math.round(land)}ms`, 'it starts when she lands');
  assert.ok(!ghost.classList.contains('qTurn') && !ghost.querySelector('.qProfile'), 'the ghost is a plain card');
  // Ended early by the next state: she turns at once.
  c.clock.t += 100;
  c.state(after({ melds: [['b1', ['SQ-0', 'HQ-0', 'CQ-0']]], phase: 'meld', draw: 38 }));
  assert.strictEqual(meldCard(c.doc, 'SQ-0').style.getPropertyValue('--q-delay'), '0ms');
  assert.deepEqual(c.errors, []);
});

// --- Regression: the piles flickered after a flight and showed two candidate top cards ----
// (the draw ghost lit up the dimmed stock, the old top stood in while the new one flew, then
// a bright ghost gave way to the dimmed real card with a second pop). Now the piles show the
// state at all times and no pile card in the air is ever opaque at either end.
test('the piles never flash: they show the state at once, every pile card in the air is see-through at both ends', async (t) => {
  const label = (stCard) => (stCard ? (stCard.faceDown ? 'back' : `${stCard.rank}${{ S: '♠', H: '♥', D: '♦', C: '♣' }[stCard.suit]}`) : 'leer');
  const check = (c, s, what) => {
    const piles = c.doc.getElementById('centerPiles');
    assert.deepEqual(c.anims.filter((a) => piles.contains(a.el)).map((a) => a.el.id || a.el.className), [], `${what}: nothing animated on a pile`);
    assert.strictEqual(c.doc.querySelectorAll('#discardPile .pile-card').length, 1, `${what}: one card on the discard pile`);
    assert.strictEqual(c.doc.querySelectorAll('#drawPile .pile-card').length, 1, `${what}: one card on the stock`);
    const top = c.doc.getElementById('discardTopCard');
    const shown = top.classList.contains('back') ? 'back' : top.classList.contains('empty') ? 'leer' : top.textContent;
    assert.strictEqual(shown, label(s.discardTop), `${what}: the pile shows the state's top`);
    for (const g of ghosts(c.doc).filter((n) => n.classList.contains('pile-card'))) {
      const { frames } = flightOf(c, g);
      assert.ok(frames[0].opacity === 0 && frames.at(-1).opacity === 0, `${what}: ${g.textContent || 'a back'} is see-through where it meets a pile`);
    }
  };
  const play = async (states, what) => {
    const c = boot();
    t.after(() => c.window.close());
    await ready();
    c.join();
    c.state(states[0]);
    for (const [i, s] of states.slice(1).entries()) {
      c.clock.t += 5;
      c.state(s);
      check(c, s, `${what} #${i + 1}`);
    }
    assert.ok(c.anims.length > 0, `${what}: something flew at all`);
    assert.deepEqual(c.errors, []);
  };
  await play([before(), after()], 'stock draw, meld, discard (piles dimmed)');
  await play([before(), after({ cur: 'p1' })], 'the same, then my turn (piles lit)');
  await play([before({ pile: ['H7-0', 'S2-0', 'S3-0'] }), after({ draw: 40, pile: ['D9-1'], melds: [['b1', SEVENS]] })], 'pile take in one state');
  await play([
    before({ pile: ['H7-0', 'S2-0', 'S3-0'] }),
    st({ cur: 'b1', phase: 'meld', pile: ['S2-0', 'S3-0'], mustLayOffCardId: 'H7-0' }),
    st({ cur: 'b1', phase: 'meld', pile: [], melds: [['b1', SEVENS]] }),
    after({ draw: 40, pile: ['S3-0'], melds: [['b1', SEVENS]] }),
  ], 'a remote human: top card, rest with the meld, a card of it thrown again');
  await play([before(), st({ cur: 'b1', phase: 'meld', draw: 39, melds: [['b1', SEVENS]] }), after()], 'Zen: melds, then the discard');
});

/** A ghost at share p of its way as the browser draws it (offsets and transforms as the client writes them). */
function ghostAt(g, frames, p) {
  const offs = frames.map((f, i) => (f.offset !== undefined ? f.offset : i === 0 ? 0 : 1));
  const i = Math.max(1, offs.findIndex((o) => o >= p));
  const k = (p - offs[i - 1]) / (offs[i] - offs[i - 1] || 1);
  const opacity = frames[i - 1].opacity + (frames[i].opacity - frames[i - 1].opacity) * k;
  const nums = (tf) => tf.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi).map(Number); // translate x, y, rotate, scale
  const [x0, y0, , s0] = nums(frames[0].transform);
  const [x1, y1, , s1] = nums(frames.at(-1).transform);
  // A .flyCard (my own move) takes its size from style.css and starts where it is laid out.
  const [w, h] = [parseFloat(g.style.width) || 52, parseFloat(g.style.height) || 73];
  const [ox, oy] = [parseFloat(g.style.left) || 0, parseFloat(g.style.top) || 0];
  const lerp = (a, b) => a + (b - a) * p;
  const [cx, cy, s] = [ox + lerp(x0, x1) + w / 2, oy + lerp(y0, y1) + h / 2, lerp(s0, s1)];
  return { opacity, left: cx - (w * s) / 2, right: cx + (w * s) / 2, top: cy - (h * s) / 2, bottom: cy + (h * s) / 2 };
}

/** A pile as the eye sees it: card, count and buttons, not the caption. */
const pileBox = (doc, id) => [...doc.getElementById(id).children]
  .filter((n) => !n.classList.contains('pileLabel'))
  .map((n) => n.getBoundingClientRect())
  .filter((r) => r.width && r.height)
  .reduce((b, r) => ({ left: Math.min(b.left, r.left), top: Math.min(b.top, r.top), right: Math.max(b.right, r.right), bottom: Math.max(b.bottom, r.bottom) }));
const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// --- Regression: in landscape every card thrown to or taken from the pile crossed the stock ---
// (and a card melted into the pile it landed on): over a dimmed pile any card in the air reads
// as a flicker. Now no ghost is ever visible over a pile, whatever the layout.
test('no card in the air is ever visible over a pile: portrait and landscape, every kind of turn', async (t) => {
  const flown = { PORTRAIT: [], LANDSCAPE: [] };
  for (const [name, layout] of Object.entries({ PORTRAIT, LANDSCAPE })) {
    const play = async (states, what) => {
      const c = boot({ layout });
      t.after(() => c.window.close());
      await ready();
      c.join();
      c.state(states[0]);
      for (const s of states.slice(1)) {
        c.clock.t += 5;
        c.state(s);
      }
      const piles = ['drawPile', 'discardPile'].map((id) => pileBox(c.doc, id));
      for (const g of ghosts(c.doc).filter((n) => n.classList.contains('pile-card'))) {
        flown[name].push(g.textContent || 'back');
        const { frames } = flightOf(c, g);
        for (let i = 0; i <= 100; i++) {
          const q = ghostAt(g, frames, i / 100);
          const over = piles.find((b) => meets(q, b));
          assert.ok(!over || q.opacity < 1e-6, `${name}, ${what}: ${g.textContent || 'a back'} shows over a pile at ${i}% (opacity ${q.opacity.toFixed(2)})`);
        }
      }
      assert.deepEqual(c.errors, []);
    };
    await play([before(), after()], 'stock draw, meld, discard');
    await play([before(), after({ cur: 'p1' })], 'then my turn');
    await play([before({ pile: ['H7-0', 'S2-0', 'S3-0'] }), after({ draw: 40, pile: ['D9-1'], melds: [['b1', SEVENS]] })], 'pile take in one state');
    await play([
      before({ pile: ['H7-0', 'S2-0', 'S3-0'] }),
      st({ cur: 'b1', phase: 'meld', pile: ['S2-0', 'S3-0'], mustLayOffCardId: 'H7-0' }),
      st({ cur: 'b1', phase: 'meld', pile: [], melds: [['b1', SEVENS]] }),
      after({ draw: 40, pile: ['S3-0'], melds: [['b1', SEVENS]] }),
    ], 'a remote human takes the pile and throws a card of it again');
    await play([before(), st({ cur: 'b1', phase: 'meld', draw: 39, melds: [['b1', SEVENS]] }), after()], 'Zen: melds, then the discard');
  }
  // Not vacuous: in both layouts the stock card, the taken and the thrown card still fly.
  for (const name of Object.keys(flown)) {
    for (const card of ['back', '7♥', '9♦', '3♠']) assert.ok(flown[name].includes(card), `${name}: ${card} flew (${flown[name]})`);
  }
});

// --- Regression: my own discard crossed the stock in landscape, my draw left from on top of it --
// My own moves keep their way, speed and fade, but their card in the air (.flyCard) shows only
// where it covers no pile, in any layout.
test('my own draw, pile take and discard never show over a pile either: portrait, landscape, desktop', async (t) => {
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  assert.match(css, /\n\.flyCard \{[^}]*width: 52px; height: 73px;/, 'the size the client falls back to');
  for (const [name, layout] of Object.entries({ PORTRAIT, LANDSCAPE, DESKTOP })) {
    const fly = async (what, phase, act) => {
      const c = boot({ layout });
      t.after(() => c.window.close());
      await ready();
      c.join();
      c.state(st({ cur: 'p1', phase }));
      act(c);
      const g = c.doc.querySelector('body > .flyCard');
      assert.ok(g, `${name}, ${what}: a card flies`);
      const a = c.anims.find((x) => x.el === g);
      assert.ok(a, `${name}, ${what}: its way and its fade are planned (Web Animations)`);
      assert.deepEqual([a.opts.duration, a.opts.easing], [420, 'cubic-bezier(0.3, 0.7, 0.3, 1)'], 'as fast as ever, on its old curve');
      const piles = ['drawPile', 'discardPile'].map((id) => pileBox(c.doc, id));
      let seen = 0;
      for (let i = 0; i <= 100; i++) {
        const q = ghostAt(g, a.frames, i / 100);
        if (q.opacity > 1e-6) seen += 1;
        assert.ok(q.opacity < 1e-6 || !piles.some((b) => meets(q, b)), `${name}, ${what}: shows over a pile at ${i}% of its way (opacity ${q.opacity.toFixed(2)})`);
      }
      assert.ok(seen >= 30, `${name}, ${what}: seen on a good part of its way (${seen}%)`);
      assert.deepEqual(c.errors, []);
    };
    await fly('draw from the stock', 'draw', (c) => c.doc.getElementById('drawPile').click());
    await fly('take the pile', 'draw', (c) => c.doc.getElementById('discardPile').click());
    await fly('discard', 'meld', (c) => {
      c.doc.querySelector('#hand .card[data-card-id="H5-0"]').click();
      c.doc.getElementById('discardBtn').click();
    });
  }
});

// --- "Züge der Mitspieler" in "Optionen" ------------------------------------------------
const box = (c) => c.doc.getElementById('oppMovesCheckbox');
const toggle = (c, on) => {
  box(c).checked = on;
  box(c).dispatchEvent(new c.window.Event('change', { bubbles: true }));
};

test('"Züge der Mitspieler" is on by default, in the play aids, in both languages', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  assert.strictEqual(box(c).checked, true, 'new players see the moves');
  assert.strictEqual(c.window.localStorage.getItem('pikdame_opp_moves'), null, 'nothing stored until a choice');
  const row = box(c).closest('label.prefRow');
  assert.ok(row && row.closest('.prefGroup').querySelector('.prefGroupTitle').textContent === 'Spielhilfen');
  assert.strictEqual(row.querySelector('.prefLabel').textContent, 'Züge der Mitspieler');
  assert.strictEqual(c.window.I18N_STATIC['Züge der Mitspieler'], "Other players' moves");
  assert.ok(c.window.I18N_STATIC[row.querySelector('.prefSub').textContent], 'the sub line is translated too');
  assert.deepEqual(c.errors, []);
});

test('switched off: the table shows the move at once and silently - exactly as before', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  toggle(c, false);
  assert.strictEqual(c.window.localStorage.getItem('pikdame_opp_moves'), 'off', 'kept on this device');
  c.state(before());
  c.clock.t += 50;
  c.tones.length = 0;
  c.state(after());
  assert.deepEqual(ghosts(c.doc), [], 'no flights');
  assert.deepEqual(c.anims, [], 'no card held back');
  assert.strictEqual(c.doc.getElementById('discardTopCard').textContent, '9♦', 'the discard lies there at once');
  assert.ok(SEVENS.every((id) => meldCard(c.doc, id)), 'the meld is there at once');
  await wait(700);
  assert.deepEqual(c.tones, [], 'and no sounds for it');
  assert.deepEqual(c.errors, []);
});

test('switched off mid-flight: every card lands at once; on again, the next move flies', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  c.state(after());
  const flights = ghosts(c.doc).map((g) => flightOf(c, g));
  assert.strictEqual(flights.length, 5);
  toggle(c, false);
  assert.ok(flights.every((a) => a.cancelled) && ghosts(c.doc).length === 0, 'the flight ends');
  assert.ok(c.anims.filter((a) => a.frames.every((f) => f.opacity === 0)).every((a) => a.cancelled), 'no card stays hidden');
  // Horst's turn while off: nothing. On again: what happened meanwhile is not replayed.
  c.clock.t += 400;
  c.state(after({ cur: 'p1', turn: 10, draw: 38, pile: ['S8-0', 'D9-1', 'D4-0', 'C3-1'] }));
  assert.deepEqual(ghosts(c.doc), []);
  toggle(c, true);
  assert.strictEqual(c.window.localStorage.getItem('pikdame_opp_moves'), 'on');
  c.clock.t += 100;
  c.state(after({ cur: 'p1', turn: 10, draw: 38, pile: ['S8-0', 'D9-1', 'D4-0', 'C3-1'], log: [{ text: 'x' }] }));
  assert.deepEqual(ghosts(c.doc), [], 'a state that moved nothing after switching on: no stale replay');
  assert.deepEqual(c.errors, []);
});

test('the choice survives a reload: off stays off, on flies again', async (t) => {
  const off = boot({ stored: { pikdame_opp_moves: 'off' } });
  t.after(() => off.window.close());
  await ready();
  assert.strictEqual(box(off).checked, false, 'the switch shows the kept choice');
  off.join();
  off.state(before());
  off.clock.t += 50;
  off.state(after());
  assert.deepEqual(ghosts(off.doc), []);
  const on = boot({ stored: { pikdame_opp_moves: 'on' } });
  t.after(() => on.window.close());
  await ready();
  assert.strictEqual(box(on).checked, true);
  on.join();
  on.state(before());
  on.clock.t += 50;
  on.state(after());
  assert.strictEqual(ghosts(on.doc).length, 5);
  assert.deepEqual([...off.errors, ...on.errors], []);
});

// --- My own melds fly ----------------------------------------------------------------------
const MINE = [...SEVENS, 'S7-1', 'C9-0', 'SK-0'];
/** My turn in its meld phase: my hand, the table's melds ('J…' = a joker standing in for the 7 of spades). */
function myTurn({ hand = MINE, melds = [], ...o } = {}) {
  const s = st({ cur: 'p1', phase: 'meld', melds: melds.map(([owner, ids]) => [owner, ids.filter((id) => !id.startsWith('J'))]), ...o });
  melds.forEach(([, ids], i) => {
    s.tableMelds[i].slots = ids.map((id) => (id.startsWith('J') ? { joker: { id, isJoker: true }, representsRank: '7', representsSuit: 'S' } : { real: C(id) }));
  });
  Object.assign(s.players[0], { hand: hand.map(C), handCount: hand.length });
  return s;
}
const laidSevens = (o = {}) => myTurn({ hand: ['S7-1', 'C9-0', 'SK-0'], melds: [['p1', SEVENS]], ...o });
const ownGhosts = (doc) => [...doc.querySelectorAll('body > .ownFly')];
const hidden = (c) => c.anims.filter((a) => a.frames.every((f) => f.opacity === 0) && !a.cancelled);
const handIds = (doc) => [...doc.querySelectorAll('#hand .card')].map((n) => n.dataset.cardId).sort();
const ownBox = (c) => c.doc.getElementById('ownMovesCheckbox');
const toggleOwn = (c, on) => {
  ownBox(c).checked = on;
  ownBox(c).dispatchEvent(new c.window.Event('change', { bubbles: true }));
};
/** A table where I just laid the three sevens: the state before, then the one with them in my meld. */
/** A booted client at the table (joined), closed with the test. */
async function seated(t, opts) {
  const c = boot(opts);
  t.after(() => c.window.close());
  await ready();
  c.join();
  return c;
}
async function laid(t, opts) {
  const c = await seated(t, opts);
  c.state(myTurn());
  c.clock.t += 50;
  c.state(laidSevens());
  return c;
}

test('my meld: the cards glide from their place in the hand into my meld, one after another', async (t) => {
  const c = await seated(t);
  c.state(myTurn());
  assert.deepEqual(handIds(c.doc), MINE.slice().sort());
  c.clock.t += 50;
  c.state(laidSevens());
  // The state shows at once: the hand closed up, the meld is on the table, I may go on.
  assert.deepEqual(handIds(c.doc), ['C9-0', 'S7-1', 'SK-0']);
  assert.ok(SEVENS.every((id) => meldCard(c.doc, id)), 'the meld is there with the state');
  const gs = ownGhosts(c.doc);
  assert.strictEqual(gs.length, 3, 'one ghost a card');
  assert.deepEqual(gs.map((g) => g.querySelector('.corner').textContent), ['7♥', '7♦', '7♣']);
  assert.ok(gs.every((g) => g.classList.contains('card-compact') && g.classList.contains('oppFly') && !g.dataset.cardId), 'a copy of the meld card, without its id');
  assert.ok(gs.every((g) => g.getAttribute('aria-hidden') === 'true'), 'decoration');
  const fl = gs.map((g) => flightOf(c, g));
  // From the hand card's box to the slot, opaque all the way: it never fades, it was in my hand.
  const [hx, hy] = PORTRAIT.handCard;
  for (const a of fl) {
    assert.match(a.frames[0].transform, new RegExp(`^translate\\(${hx}px, ${hy}px\\)`), 'it leaves where the hand card lay');
    assert.match(a.frames.at(-1).transform, /^translate\(300px, 400px\) rotate\(0deg\) scale\(1\)$/, 'and lands on its slot, upright, at the slot\'s size');
    assert.ok(a.frames.every((f) => f.opacity === 1));
    assert.strictEqual(a.opts.fill, 'both', 'waiting for its turn it stays where the hand card was');
    assert.ok(a.frames.every((f) => Object.keys(f).every((k) => k === 'transform' || k === 'opacity')), 'only transform and opacity move');
  }
  assert.strictEqual(fl[0].opts.delay, 0, 'the first leaves at once');
  assert.ok(fl[1].opts.delay > 0 && fl[2].opts.delay > fl[1].opts.delay && fl[2].opts.delay - fl[1].opts.delay <= 60, 'a short stagger');
  assert.ok(fl.every((a) => endOf(a) <= 450), 'all landed well within half a second');
  // The real cards wait invisible until their ghost lands.
  for (const [i, id] of SEVENS.entries()) {
    const hold = holdsOn(c, meldCard(c.doc, id));
    assert.strictEqual(hold.length, 1, `${id} is hidden while it flies`);
    assert.ok(Math.abs(hold[0].opts.duration - endOf(fl[i]) - SLACK) < 1e-6);
  }
  const hold = holdsOn(c, meldCard(c.doc, 'H7-0'))[0];
  fl[0].onfinish();
  assert.ok(hold.cancelled && !gs[0].isConnected, 'it lands: the ghost goes, the card shows in the same frame');
  assert.deepEqual(ghosts(c.doc).filter((g) => !g.classList.contains('ownFly')), [], 'nothing else flies for my move');
  // Landed, the flight is over on its own: no ghost left, nothing hidden.
  await wait(600);
  assert.deepEqual(ownGhosts(c.doc), []);
  assert.deepEqual(hidden(c), []);
  assert.deepEqual(c.errors, []);
});

test('my lay-off flies; a swapped-out joker stays on its slot and fades as my card arrives', async (t) => {
  const c = await laid(t);
  await wait(600);
  // A lay-off: the fourth seven joins the meld.
  c.clock.t += 2000;
  c.state(myTurn({ hand: ['C9-0', 'SK-0'], melds: [['p1', [...SEVENS, 'S7-1']]] }));
  let gs = ownGhosts(c.doc);
  assert.deepEqual(gs.map((g) => g.querySelector('.corner').textContent), ['7♠'], 'only the new card');
  assert.strictEqual(holdsOn(c, meldCard(c.doc, 'S7-1')).length, 1);
  assert.deepEqual(holdsOn(c, meldCard(c.doc, 'H7-0')), [], 'the cards that lay there are never hidden');
  // A joker swap: the joker never comes back to the hand, it leaves the game.
  const d = await seated(t);
  d.state(myTurn({ hand: ['S7-0', 'C9-0', 'SK-0'], melds: [['p1', ['H7-0', 'D7-0', 'J1']]] }));
  d.clock.t += 50;
  d.state(myTurn({ hand: ['C9-0', 'SK-0'], melds: [['p1', ['H7-0', 'D7-0', 'S7-0']]] }));
  gs = ownGhosts(d.doc);
  assert.strictEqual(gs.length, 2, 'my card and the joker it replaces');
  const [card, joker] = gs.map((g) => flightOf(d, g));
  assert.ok(gs[1].classList.contains('joker') && !gs[0].classList.contains('joker'));
  assert.strictEqual(joker.frames[0].opacity, 1, 'the joker lies on its slot');
  assert.strictEqual(joker.frames.at(-1).opacity, 0, 'and is gone when my card lands');
  assert.ok(joker.frames.slice(0, 2).every((f) => f.transform === joker.frames[0].transform) && joker.frames[1].offset >= 0.6, 'it stays put until the card is close');
  assert.strictEqual(endOf(joker), endOf(card), 'one moment');
  assert.deepEqual(handIds(d.doc), ['C9-0', 'SK-0'], 'no joker in my hand');
  assert.strictEqual(holdsOn(d, meldCard(d.doc, 'S7-0')).length, 1);
  assert.deepEqual([...c.errors, ...d.errors], []);
});

test('my flight ends at once with the next move: my discard, an undo, a rejoin - never a ghost or a hidden card left', async (t) => {
  const over = (c, why) => {
    assert.deepEqual(ownGhosts(c.doc), [], `${why}: no ghost`);
    assert.deepEqual(hidden(c), [], `${why}: no card hidden`);
    assert.ok(c.anims.filter((a) => a.el.classList.contains('ownFly')).every((a) => a.cancelled), `${why}: every flight cancelled`);
    assert.deepEqual(c.errors, []);
  };
  // I discard right away: the turn passes, the table shows the state.
  let c = await laid(t);
  assert.strictEqual(ownGhosts(c.doc).length, 3);
  c.clock.t += 120;
  c.state(laidSevens({ hand: ['C9-0', 'SK-0'], cur: 'b1', phase: 'draw', turn: 9, pile: ['S7-1', 'D4-0', 'C3-1'] }));
  over(c, 'discard');
  assert.ok(SEVENS.every((id) => meldCard(c.doc, id)));
  // "Rückgängig": the cards are back in my hand.
  c = await laid(t);
  c.clock.t += 120;
  c.state(myTurn());
  over(c, 'undo');
  assert.deepEqual(handIds(c.doc), MINE.slice().sort());
  // A reconnect: whatever happened meanwhile is not replayed.
  c = await laid(t);
  c.clock.t += 120;
  c.join();
  over(c, 'rejoin');
  c.state(laidSevens());
  over(c, 'the state after a rejoin is a baseline');
  // The page goes to the background.
  c = await laid(t);
  Object.defineProperty(c.doc, 'hidden', { configurable: true, get: () => true });
  c.doc.dispatchEvent(new c.window.Event('visibilitychange'));
  over(c, 'hidden');
  // The round ends in the same state (a whole turn played for me): the sheet covers the table.
  c = await seated(t);
  c.state(myTurn({ hand: [...SEVENS, 'C9-0'] }));
  c.clock.t += 50;
  const mk = (score, win) => ({ roundScore: score, breakdown: { isWinner: !!win, multiplier: 1 } });
  c.state({
    ...myTurn({ hand: [], melds: [['p1', SEVENS]], pile: ['X1-0', 'D4-0'], faceDownTop: true }),
    phase: 'roundEnd', lastRoundWinnerId: 'p1',
    lastRoundResult: { p1: mk(120, true), b1: mk(-60), b2: mk(-20) },
    lastRoundStats: [{ id: 'p1', name: 'Flo', laidOutCount: 3, handCount: 0 }, { id: 'b1', name: 'Klaus', laidOutCount: 0, handCount: 12 }, { id: 'b2', name: 'Horst', laidOutCount: 0, handCount: 9 }],
  });
  assert.ok(!c.doc.getElementById('resultOverlay').classList.contains('hidden'), 'the result sheet is open');
  over(c, 'round end');
});

test('my flight goes on: a state that moves nothing, a re-render, and my next meld joins it', async (t) => {
  const c = await laid(t);
  const first = ownGhosts(c.doc);
  // A vote or an emote: a new state, the same table.
  c.clock.t += 60;
  c.state(laidSevens({ log: [{ text: 'x' }] }));
  assert.deepEqual(ownGhosts(c.doc), first, 'the same ghosts, no second set');
  assert.ok(first.every((g) => !flightOf(c, g).cancelled));
  for (const id of SEVENS) assert.strictEqual(holdsOn(c, meldCard(c.doc, id)).length, 1, `${id}: rebuilt, hidden again until it lands`);
  // The next card right behind: its own flight, the first three still in the air.
  c.clock.t += 60;
  c.state(myTurn({ hand: ['C9-0', 'SK-0'], melds: [['p1', [...SEVENS, 'S7-1']]] }));
  const all = ownGhosts(c.doc);
  assert.strictEqual(all.length, 4);
  assert.ok(first.every((g) => g.isConnected && !flightOf(c, g).cancelled), 'the first flight is not cut');
  const late = flightOf(c, all[3]);
  assert.ok(late.opts.delay >= 0 && late.opts.duration >= 250, 'the new card takes its full time, from now');
  assert.deepEqual(c.errors, []);
});

test('my cards never fly: reduced motion, a hidden page, an open sheet, no Web Animations, dropped by hand, another seat', async (t) => {
  const still = (c, why) => {
    assert.deepEqual(ownGhosts(c.doc), [], `${why}: no ghost`);
    assert.deepEqual(hidden(c), [], `${why}: nothing hidden`);
    assert.ok(SEVENS.every((id) => meldCard(c.doc, id)), `${why}: the meld is there`);
    assert.deepEqual(c.errors, []);
  };
  let c = await laid(t, { reduced: true });
  still(c, 'reduced motion');
  assert.deepEqual(c.anims, [], 'reduced motion: not one animation');
  c = await laid(t, { animate: false });
  still(c, 'no Web Animations');
  // A page in the background.
  c = await seated(t);
  c.state(myTurn());
  Object.defineProperty(c.doc, 'hidden', { configurable: true, get: () => true });
  c.state(laidSevens());
  still(c, 'hidden page');
  // A sheet over the table.
  c = await seated(t);
  c.state(myTurn());
  c.doc.getElementById('settingsOverlay').classList.remove('hidden');
  c.state(laidSevens());
  still(c, 'open sheet');
  // Cards I dragged onto my meld with the mouse are there already: no second way from the hand.
  c = await seated(t, { mouse: true });
  c.state(myTurn({ hand: ['S7-1', 'C9-0', 'SK-0'], melds: [['p1', SEVENS]] }));
  const card = c.doc.querySelector('#hand .card[data-card-id="S7-1"]');
  card.dispatchEvent(new c.window.Event('dragstart', { bubbles: true }));
  c.doc.querySelector('#melds .meldGroup').dispatchEvent(new c.window.Event('drop', { bubbles: true }));
  c.clock.t += 50;
  c.state(myTurn({ hand: ['C9-0', 'SK-0'], melds: [['p1', [...SEVENS, 'S7-1']]] }));
  assert.deepEqual(ownGhosts(c.doc), [], 'dropped: no ghost');
  assert.deepEqual(hidden(c), []);
  // ... and the next card, laid by a tap, flies again.
  c.doc.querySelector('#hand .card[data-card-id="C9-0"]').click();
  c.doc.querySelector('#melds .card').click();
  c.clock.t += 50;
  c.state(myTurn({ hand: ['SK-0'], melds: [['p1', [...SEVENS, 'S7-1', 'C9-0']]] }));
  assert.strictEqual(ownGhosts(c.doc).length, 1, 'tapped: it flies');
  // Another player's meld is theirs to fly (from their chip), never from my hand.
  c = await seated(t);
  c.state(before());
  c.clock.t += 50;
  c.state(after());
  assert.deepEqual(ownGhosts(c.doc), []);
  assert.strictEqual(ghosts(c.doc).length, 5);
  assert.deepEqual(c.errors, []);
});

test('a landing row cut by the meld area: the ghost melts into the cut card; hardly in view: no flight', async (t) => {
  // The meld card's box is [300, 400, 40, 56]: the area ends 26 px above the card's bottom edge.
  const c = await laid(t, { layout: { ...PORTRAIT, melds: [0, 0, 393, 430] } });
  const gs = ownGhosts(c.doc);
  assert.strictEqual(gs.length, 3);
  for (const [i, g] of gs.entries()) {
    const a = flightOf(c, g);
    // Only transform and opacity ever move: the ghost is never clipped.
    assert.ok(a.frames.every((f) => Object.keys(f).every((k) => ['transform', 'opacity', 'offset'].includes(k))));
    assert.deepEqual(a.frames.map((f) => f.opacity), [1, 1, 0], 'whole on its way, gone when it arrives');
    assert.ok(a.frames[1].offset >= 0.7 && !('transform' in a.frames[1]), 'only close to the card it fades');
    // The cut card fades in under it, in the same time: never a card at both places.
    const shows = c.anims.filter((x) => x.el === meldCard(c.doc, SEVENS[i]) && !x.cancelled);
    assert.strictEqual(shows.length, 1);
    assert.deepEqual(shows[0].frames.map((f) => f.opacity), [0, 0, 1]);
    assert.strictEqual(shows[0].frames[1].offset, a.frames[1].offset);
    assert.deepEqual([shows[0].opts.delay, shows[0].opts.duration, shows[0].opts.easing], [a.opts.delay, a.opts.duration, a.opts.easing]);
    assert.strictEqual(shows[0].opts.fill, 'backwards', 'hidden while its ghost waits, itself afterwards');
  }
  // Scrolled above the area's top edge: the same.
  const up = await laid(t, { layout: { ...PORTRAIT, melds: [0, 420, 393, 300] } });
  assert.deepEqual(flightOf(up, ownGhosts(up.doc)[0]).frames.map((f) => f.opacity), [1, 1, 0]);
  // Only a sliver of it in view, or none: the card simply is there.
  for (const melds of [[0, 0, 393, 404], [0, 0, 393, 300], [0, 600, 393, 100]]) {
    const out = await laid(t, { layout: { ...PORTRAIT, melds } });
    assert.deepEqual(ownGhosts(out.doc), [], `${melds}: no ghost`);
    assert.deepEqual(out.anims.filter((x) => !x.cancelled), [], `${melds}: nothing hidden, nothing animated`);
    assert.deepEqual(out.errors, []);
  }
  assert.deepEqual([...c.errors, ...up.errors], []);
});

test('"Eigene Auslage" in "Optionen": on by default, off shows my cards at once, the choice survives a reload', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  assert.strictEqual(ownBox(c).checked, true, 'new players see their cards glide');
  assert.strictEqual(c.window.localStorage.getItem('pikdame_own_moves'), null, 'nothing stored until a choice');
  const row = ownBox(c).closest('label.prefRow');
  assert.ok(row && row.closest('.prefGroup').querySelector('.prefGroupTitle').textContent === 'Spielhilfen');
  assert.strictEqual(row.previousElementSibling.getAttribute('for'), 'oppMovesCheckbox', 'right below the others\' moves');
  assert.strictEqual(row.querySelector('.prefLabel').textContent, 'Eigene Auslage');
  assert.strictEqual(c.window.I18N_STATIC['Eigene Auslage'], 'Your own melds');
  assert.ok(c.window.I18N_STATIC[row.querySelector('.prefSub').textContent], 'the sub line is translated too');
  // Off mid-flight: every card lands at once; then nothing flies, nothing is hidden.
  c.join();
  c.state(myTurn());
  c.clock.t += 50;
  c.state(laidSevens());
  const flights = ownGhosts(c.doc).map((g) => flightOf(c, g));
  assert.strictEqual(flights.length, 3);
  toggleOwn(c, false);
  assert.strictEqual(c.window.localStorage.getItem('pikdame_own_moves'), 'off', 'kept on this device');
  assert.ok(flights.every((a) => a.cancelled) && ownGhosts(c.doc).length === 0 && hidden(c).length === 0);
  c.anims.length = 0;
  c.clock.t += 500;
  c.state(myTurn({ hand: ['C9-0', 'SK-0'], melds: [['p1', [...SEVENS, 'S7-1']]] }));
  assert.deepEqual(ownGhosts(c.doc), []);
  assert.deepEqual(c.anims, [], 'off: no animation at all for my move');
  assert.ok(meldCard(c.doc, 'S7-1'), 'the card lies there at once');
  // The others' moves keep their own switch.
  assert.strictEqual(box(c).checked, true);
  // On again: the next card flies; what was laid meanwhile is not replayed.
  toggleOwn(c, true);
  assert.strictEqual(c.window.localStorage.getItem('pikdame_own_moves'), 'on');
  c.clock.t += 500;
  c.state(myTurn({ hand: ['C9-0', 'SK-0'], melds: [['p1', [...SEVENS, 'S7-1']]], log: [{ text: 'x' }] }));
  assert.deepEqual(ownGhosts(c.doc), [], 'no stale replay');
  // A reload keeps the choice; with the others' moves off, mine still fly.
  const off = await laid(t, { stored: { pikdame_own_moves: 'off' } });
  assert.strictEqual(ownBox(off).checked, false);
  assert.deepEqual(ownGhosts(off.doc), []);
  const mine = await laid(t, { stored: { pikdame_opp_moves: 'off' } });
  assert.strictEqual(ownGhosts(mine.doc).length, 3);
  assert.deepEqual([...c.errors, ...off.errors, ...mine.errors], []);
});

// --- CSS contract -------------------------------------------------------------------------
test('CSS contract: the ghosts are fixed, click-through, on the fly layer, and gone with reduced motion', () => {
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`)) || [])[1] || '';
  // Two classes each: .pile-card.back (position: relative) once kept the card back in the page flow.
  const fly = rule('.pile-card.oppFly, .card.oppFly');
  for (const decl of ['position: fixed', 'pointer-events: none', 'z-index: var(--z-fly)', 'transition: none']) assert.ok(fly.includes(decl), `.oppFly: ${decl}`);
  assert.ok(css.indexOf('.pile-card.oppFly, .card.oppFly {') > css.indexOf('.pile-card.back {'), 'after the card back, which it overrides');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.oppFly \{ display: none; \} \}/);
  assert.doesNotMatch(css, /oppUnder/, 'no stand-in card on the pile: it always shows the state');
  assert.doesNotMatch(fly, /var\(--accent/, 'no selection colour on a card in the air');
  assert.match(SRC[2], new RegExp(`const OPP_HOLD_SLACK_MS = ${SLACK};`), 'the test and the client agree on the hold');
  // My own cards: the same ghost on the table-effects layer, so no dialog is ever flown over.
  assert.strictEqual(rule('.card.ownFly').trim(), 'z-index: var(--z-table-fx);');
  assert.ok(css.indexOf('.card.ownFly {') > css.indexOf('.pile-card.oppFly, .card.oppFly {'), 'after the ghost it refines');
  const mark = rule('.card.ownFly .ownFlyMark');
  for (const decl of ['position: absolute', 'display: flex', 'margin: 0']) assert.ok(mark.includes(decl), `.ownFlyMark: ${decl}`);
  assert.ok(css.indexOf('.card.ownFly .ownFlyMark {') > css.indexOf('.card-compact .suitMark { display: none; }'), 'it shows where a compact card hides its mark');
});

test('the turn marker waits for the cards: while Klaus\'s cards fly he stays marked, then Horst', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before({ pace: 'fast' }));
  const marked = () => [...c.doc.querySelectorAll('#opponents .opponent.active')].map((n) => n.dataset.playerId);
  assert.deepStrictEqual(marked(), ['b1']);
  c.clock.t += 50;
  c.state(after({ pace: 'fast' }));
  assert.ok(ghosts(c.doc).length > 0, 'his cards are in the air');
  assert.deepStrictEqual(marked(), ['b1'], 'the ring stays with the player whose cards still fly');
  assert.match(c.doc.getElementById('turnStatus').textContent, /Klaus/);
  // They land (the flights' own end timer): the marker moves on, nothing else re-renders for it.
  await wait(420);
  assert.deepStrictEqual(marked(), ['b2']);
  assert.match(c.doc.getElementById('turnStatus').textContent, /Horst/);
  assert.deepEqual(c.errors, []);
});

test('the marker never holds my turn back when nothing flies: switched off, it moves with the state', async (t) => {
  const c = boot({ stored: { pikdame_opp_moves: 'off' } });
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.state(after());
  assert.deepStrictEqual([...c.doc.querySelectorAll('#opponents .opponent.active')].map((n) => n.dataset.playerId), ['b2']);
  assert.deepEqual(c.errors, []);
});

// --- back at the table: the recap of what was missed ------------------------------------
function away(c, ms) {
  const real = c.window.Date.now;
  let hidden = true;
  Object.defineProperty(c.doc, 'hidden', { configurable: true, get: () => hidden });
  c.doc.dispatchEvent(new c.window.Event('visibilitychange'));
  return {
    back() {
      c.window.Date.now = () => real() + ms;
      hidden = false;
      c.doc.dispatchEvent(new c.window.Event('visibilitychange'));
    },
  };
}
const LOG = [
  { t: 100, text: 'Klaus wirft Herz-3 ab.' },
  { t: 150, text: 'Klaus zieht eine Karte vom Stapel.' },
  { t: 200, text: 'Klaus legt eine neue Satz-Auslage aus.' },
  { t: 300, text: 'Klaus wirft Karo-9 ab.' },
  { t: 400, text: 'Horst ist getrennt - kehrt Horst nicht zurück, übernimmt gleich ein Bot.' },
];

test('back after looking away: the lines since I left become one recap, chip statuses stay out', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before({ log: LOG.slice(0, 1) }));
  const gone = away(c, 20000);
  c.state(after({ log: LOG })); // arrives while the page is hidden
  gone.back();
  const toast = c.doc.getElementById('toastContainer');
  assert.ok(toast.classList.contains('recap') && toast.classList.contains('visible'));
  assert.match(toast.querySelector('.recapHead').textContent, /Seit du weg warst/);
  assert.deepStrictEqual([...toast.querySelectorAll('.recapLine')].map((n) => n.textContent),
    ['Klaus legt eine neue Satz-Auslage aus.', 'Klaus wirft Karo-9 ab.'], 'only what came after I left, without the plain draw and the disconnect line');
  assert.deepEqual(c.errors, []);
});

test('no recap for a glance away, for a single line, or away from a running table', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  const toast = c.doc.getElementById('toastContainer');
  c.state(before({ log: LOG.slice(0, 1) }));
  let gone = away(c, 2000);
  c.state(after({ log: LOG }));
  gone.back();
  assert.ok(!toast.classList.contains('recap'), 'two seconds are no absence');
  c.state(before({ log: LOG.slice(0, 2) }));
  gone = away(c, 20000);
  c.state(after({ log: LOG.slice(0, 3) }));
  gone.back();
  assert.ok(!toast.classList.contains('recap'), 'one new line: the ordinary toast says it');
  // The round ended while I was away: its result sheet tells the story.
  c.state(before({ log: LOG.slice(0, 1) }));
  gone = away(c, 20000);
  c.state({ ...after({ log: LOG }), phase: 'roundEnd' });
  gone.back();
  assert.ok(!toast.classList.contains('recap'), 'no recap over a result sheet');
  assert.deepEqual(c.errors, []);
});
