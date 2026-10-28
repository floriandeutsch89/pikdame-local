// Other players' moves fly at the table (client.js + public/table-moves.js): ghosts
// between the stock, the pile, the player's chip and their melds, the real card hidden
// until its ghost lands, quiet sounds, never queued behind the next state.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const SRC = ['i18n.js', 'table-moves.js', 'client.js'].map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

/** The real client in jsdom with layout, Web Animations and frames stubbed; the clock is the test's. */
function boot({ reduced = false, animate = true } = {}) {
  const errors = [];
  // jsdom has no styles of pseudo-elements (the card back's medallion): that alone is no error.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(HTML, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const clock = { t: 1000 };
  window.performance.now = () => clock.t;
  window.matchMedia = (q) => ({ matches: reduced && /prefers-reduced-motion: reduce/.test(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const vibes = [];
  window.navigator.vibrate = (pattern) => { vibes.push(pattern); return true; };
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  // Every box on screen; the meld area takes the whole screen so no card counts as scrolled away.
  window.Element.prototype.getBoundingClientRect = function rect() {
    const big = this.id === 'melds';
    const [left, top, width, height] = big ? [0, 0, 2000, 2000] : this.classList.contains('opponent') ? [10, 60, 110, 52] : [300, 400, 40, 56];
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
  // Into the chip it fades, out of it it appears; the far end is the real card.
  assert.strictEqual(a0.frames.at(-1).opacity, 0);
  assert.strictEqual(ad.frames[0].opacity, 0);
  assert.strictEqual(ad.frames.at(-1).opacity, 1);
  // The real cards wait invisible until their ghost lands (on their own a moment later, should it never land).
  for (const [i, id] of SEVENS.entries()) {
    const hold = holdsOn(c, meldCard(c.doc, id));
    assert.strictEqual(hold.length, 1, `${id} is hidden while it flies`);
    assert.ok(Math.abs(hold[0].opts.duration - endOf(am[i]) - SLACK) < 1e-6, `${id}: the hold outlasts the flight`);
  }
  const top = c.doc.getElementById('discardTopCard');
  const topHold = holdsOn(c, top)[0];
  assert.ok(Math.abs(topHold.opts.duration - endOf(ad) - SLACK) < 1e-6, 'the new top card waits for the discard');
  // Meanwhile the pile shows what lay there before.
  const under = c.doc.querySelector('#discardPile .oppUnder');
  assert.ok(under && under.textContent === '4♦' && under.getAttribute('aria-hidden') === 'true');
  assert.ok(c.anims.some((a) => a.el === under && a.frames.every((f) => f.visibility === 'visible')), 'shown for the flight');
  // A meld card lands: in the same frame its ghost goes and the card shows.
  const meldHold = holdsOn(c, meldCard(c.doc, 'H7-0'))[0];
  am[0].onfinish();
  assert.ok(meldHold.cancelled && !rest[0].isConnected);
  // The discard lands: ghost gone, its card on the pile with the pop, the stand-in gone.
  ad.onfinish();
  assert.ok(topHold.cancelled && !discard.isConnected && !under.isConnected);
  assert.ok(top.classList.contains('pop'));
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
  assert.ok(!c.doc.querySelector('#discardPile .oppUnder'), 'the stand-in is gone');
  const now = ghosts(c.doc);
  assert.strictEqual(now.length, 1, "only Horst's draw flies");
  assert.strictEqual(flightOf(c, now[0]).opts.delay, 0, 'and it starts right away');
  assert.deepEqual(c.errors, []);
});

test('my tap on the pile while the discard is still in the air shows the card I really take', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(before());
  c.clock.t += 50;
  c.state(after({ cur: 'p1' })); // Klaus threw the D9 - and it is my turn
  const flights = ghosts(c.doc).map((g) => flightOf(c, g));
  assert.ok(c.doc.querySelector('#discardPile .oppUnder'), 'the pile still shows the card below');
  c.clock.t += 120;
  c.doc.getElementById('discardPile').click();
  assert.ok(flights.every((a) => a.cancelled), 'the flight ends at once');
  assert.ok(!c.doc.querySelector('#discardPile .oppUnder') && ghosts(c.doc).length === 0);
  assert.ok(holdsOn(c, c.doc.getElementById('discardTopCard')).length === 0, 'the D9 shows');
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
  assert.strictEqual(c.doc.querySelectorAll('#discardPile .oppUnder').length, 1, 'one stand-in');
  flightOf(c, ghost).onfinish();
  assert.ok(hold[0].cancelled, 'and the landing shows the rebuilt card');
  assert.deepEqual(c.errors, []);
});

test('a pile take: the face-up cards fly from the pile to the chip, a big pile its top three', async (t) => {
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
  assert.deepEqual(taken.map((g) => g.textContent), ['7♥', '2♠', '3♠'], 'the top three, face up');
  assert.ok(taken.every((g) => flightOf(c, g).frames.at(-1).opacity === 0), 'into the chip');
  assert.ok(!gs.some((g) => g.classList.contains('back')), 'no card back: nothing came from the stock');
  assert.strictEqual(c.doc.querySelector('#discardPile .oppUnder').textContent, 'leer', 'the pile was swallowed: empty until the discard lands');
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
    assert.ok(!c.doc.querySelector('#discardPile .oppUnder'));
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
    // A beat on the final table before the sheet: the winner's last card lands face down.
    const last = gs.at(-1);
    assert.ok(last.classList.contains('back'), 'face down');
    assert.strictEqual(flightOf(c, last).frames.at(-1).opacity, 1, 'onto the pile, not into the chip');
  }
  assert.deepEqual(c.errors, []);
});

test('going out with a beat before the sheet: the winner\'s face-down card lands on the pile', async (t) => {
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
  assert.strictEqual(flightOf(c, last).frames.at(-1).opacity, 1, 'onto the pile');
  assert.strictEqual(c.doc.querySelector('#discardPile .oppUnder').textContent, '4♦', 'the pile shows its old top until then');
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

// --- CSS contract -------------------------------------------------------------------------
test('CSS contract: the ghosts are fixed, click-through, on the fly layer, and gone with reduced motion', () => {
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`)) || [])[1] || '';
  // Two classes each: .pile-card.back (position: relative) once kept the card back in the page flow.
  const fly = rule('.pile-card.oppFly, .card.oppFly');
  for (const decl of ['position: fixed', 'pointer-events: none', 'z-index: var(--z-fly)', 'transition: none']) assert.ok(fly.includes(decl), `.oppFly: ${decl}`);
  assert.ok(css.indexOf('.pile-card.oppFly, .card.oppFly {') > css.indexOf('.pile-card.back {'), 'after the card back, which it overrides');
  assert.match(rule('.pile-card.oppUnder'), /position: absolute;.*visibility: hidden/, 'the stand-in shows only while its animation runs');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.oppFly, \.oppUnder \{ display: none; \} \}/);
  assert.doesNotMatch(fly, /var\(--accent/, 'no selection colour on a card in the air');
  assert.match(SRC[2], new RegExp(`const OPP_HOLD_SLACK_MS = ${SLACK};`), 'the test and the client agree on the hold');
});
