// The Queen of Spades turns her head on her real moments only: drawn (owner),
// discarded, taken from the pile (a ghost leaves it), melded, caught on my hand
// at round end - never on a reload, a deal, "Zurücklegen" or the face-down last card.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const SRC = ['i18n.js', 'client.js'].map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

/** The real client in jsdom; the clock behind performance.now() is the test's. */
function boot({ reduced = false, lang = '' } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  const clock = { t: 1000 };
  window.performance.now = () => clock.t;
  window.matchMedia = (q) => ({ matches: reduced && /prefers-reduced-motion: reduce/.test(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  let rafDepth = 0;
  window.requestAnimationFrame = (cb) => {
    if (rafDepth > 4) return 0;
    rafDepth += 1;
    try { cb(Date.now()); } finally { rafDepth -= 1; }
    return 0;
  };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  window.AudioContext = function () {
    return {
      createOscillator: () => ({ connect: (x) => x, start() {}, stop() {}, type: 'sine', frequency: { setValueAtTime() {}, value: 0 } }),
      createGain: () => ({ connect: (x) => x, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }),
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
  if (lang) window.localStorage.setItem('pikdame_lang', lang);
  for (const src of SRC) window.eval(src);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const send = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  const join = () => send({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'QUEEN1' });
  const state = (st) => send({ type: 'state', state: st });
  return { window, doc: window.document, errors, clock, join, state };
}
const ready = () => new Promise((r) => setTimeout(r, 10));

// --- states ---------------------------------------------------------------------
/** 'SQ-0' -> the Queen of Spades of deck 0 (engine ids: suit, rank, deck). */
const C = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
const HAND = ['H2-0', 'H5-0', 'C9-0', 'D10-0', 'SK-0'];
/** A playing state as p1 sees it; hand/pile (top first)/melds as card ids. */
function st({ hand = HAND, pile = ['D4-0', 'C7-1'], melds = [], turn = 8, cur = 'p1', phase = 'meld', draw = 40, faceDownTop = false, ...rest } = {}) {
  const cards = pile.map(C);
  const top = cards.length ? (faceDownTop ? { ...cards[0], faceDown: true } : cards[0]) : null;
  return {
    phase: 'playing', roundNumber: 2, turnIndexInRound: turn, currentPlayerId: cur, turnPhase: phase, dealerId: 'b1',
    drawPileCount: draw, discardTop: top, discardPileCount: cards.length,
    discardCards: cards.map((c, i) => (i === 0 && faceDownTop ? { faceDown: true } : c)),
    tableMelds: melds.map(([ownerId, ids], i) => ({ id: `m${i}`, ownerId, type: 'set', slots: ids.map((id) => ({ real: C(id) })) })),
    log: [], houseRules: {}, lobbyReady: [], nextRoundReady: [], totals: { p1: 120, b1: 80, b2: 60 }, scoreHistory: [],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hand.length, hand: hand.map(C) },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 12, botDifficulty: 'medium' },
      { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 9, botDifficulty: 'medium' },
    ],
    ...rest,
  };
}
const QUEENS = ['SQ-0', 'HQ-0', 'CQ-0'];

// --- what the table shows ------------------------------------------------------------
const handQueen = (doc) => doc.querySelector('#hand .card[data-card-id="SQ-0"]');
const meldQueen = (doc) => doc.querySelector('#melds .card[data-card-id="SQ-0"]');
const pileTop = (doc) => doc.getElementById('discardTopCard');
const turning = (doc) => [...doc.querySelectorAll('.qTurn')].map((n) => n.dataset.cardId || n.id || n.className.split(' ')[0]);

test('drawn: only the owner sees her turn, on the hand card, composed with the fan', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ phase: 'draw' }));
  assert.deepEqual(turning(c.doc), [], 'the first state is only a baseline');
  c.clock.t += 50;
  c.state(st({ hand: [...HAND, 'SQ-0'], draw: 39 }));
  const q = handQueen(c.doc);
  assert.ok(q.classList.contains('qTurn'), 'her hand card turns');
  assert.strictEqual(q.dataset.q, 'draw');
  assert.ok(q.classList.contains('just-drawn'), 'the draw marker stays (drawnGlow is composed in CSS)');
  assert.strictEqual(q.style.getPropertyValue('--fan'), q.style.transform, '--fan carries the fan transform into the keyframes');
  assert.match(q.style.transform, /^rotate\(/, 'the fan transform itself is untouched');
  assert.deepEqual(turning(c.doc), ['SQ-0'], 'nothing else turns: no pile, no meld');
  assert.ok(!c.doc.querySelector('.qGhost'));
  assert.deepEqual(c.errors, []);
});

test('discarded: her turn on the pile, the pop folded in; a re-render keeps it running', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ cur: 'b1', turn: 8 }));
  c.clock.t += 50;
  c.state(st({ cur: 'b2', turn: 9, pile: ['SQ-0', 'D4-0', 'C7-1'], phase: 'draw' }));
  const top = pileTop(c.doc);
  assert.ok(top.classList.contains('qTurn') && top.classList.contains('pop'), 'turn and pop together');
  assert.strictEqual(top.dataset.q, 'discard');
  assert.strictEqual(top.style.getPropertyValue('--q-delay'), '0ms');
  const at = top.dataset.qAt;
  // A state 200 ms later (another player's draw): the same node keeps its animation.
  c.clock.t += 200;
  c.state(st({ cur: 'b2', turn: 9, pile: ['SQ-0', 'D4-0', 'C7-1'], phase: 'meld', draw: 39 }));
  assert.ok(top.classList.contains('qTurn'), 'still turning after the re-render');
  assert.strictEqual(top.dataset.qAt, at, 'the same moment, not a new one');
  assert.strictEqual(top.style.getPropertyValue('--q-delay'), '0ms', 'the running animation is not shifted');
  assert.ok(!top.classList.contains('pop'), 'no second pop');
  // Past 580 ms the turn is over; no restart on later renders.
  c.clock.t += 400;
  c.state(st({ cur: 'b2', turn: 9, pile: ['SQ-0', 'D4-0', 'C7-1'], phase: 'meld', draw: 39, log: [{ text: 'x' }] }));
  assert.ok(!top.classList.contains('qTurn'), 'the turn ends with its 580 ms');
  assert.deepEqual(c.errors, []);
});

test('re-render mid-turn: a rebuilt hand card resumes at its age (negative delay)', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ phase: 'draw' }));
  c.clock.t += 50;
  c.state(st({ hand: [...HAND, 'SQ-0'], draw: 39 }));
  const first = handQueen(c.doc);
  assert.strictEqual(first.style.getPropertyValue('--q-delay'), '0ms');
  c.clock.t += 240;
  c.doc.getElementById('sortToggleBtn').click(); // any re-render: the hand is rebuilt
  const again = handQueen(c.doc);
  assert.notStrictEqual(again, first, 'a fresh node');
  assert.ok(again.classList.contains('qTurn'));
  assert.strictEqual(again.style.getPropertyValue('--q-delay'), '-240ms', 'continues 240 ms in, no restart');
  c.clock.t += 400;
  c.doc.getElementById('sortToggleBtn').click();
  assert.ok(!handQueen(c.doc).classList.contains('qTurn'), 'over after 580 ms');
  assert.deepEqual(c.errors, []);
});

test('picked up from the pile: a ghost leaves the pile, the picker sees her hand card turn', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ phase: 'draw', pile: ['SQ-0', 'D4-0'], hand: [...HAND, 'HQ-0', 'CQ-0'] }));
  assert.ok(!pileTop(c.doc).classList.contains('qTurn'), 'lying there since before: no moment');
  c.clock.t += 50;
  c.state(st({ phase: 'meld', pile: ['D4-0'], hand: [...HAND, 'HQ-0', 'CQ-0', 'SQ-0'], mustLayOffCardId: 'SQ-0', canUndoPileTake: true }));
  const ghost = c.doc.querySelector('#discardPile .qGhost');
  assert.ok(ghost, 'the ghost of her card');
  assert.strictEqual(ghost.textContent, 'Q♠');
  assert.strictEqual(ghost.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(handQueen(c.doc).dataset.q, 'pickup');
  assert.ok(handQueen(c.doc).classList.contains('qTurn'));
  // A re-render does not add a second ghost.
  c.clock.t += 100;
  c.doc.getElementById('sortToggleBtn').click();
  assert.strictEqual(c.doc.querySelectorAll('#discardPile .qGhost').length, 1);
  assert.deepEqual(c.errors, []);
});

test('picked up by someone else: everyone sees the ghost leave, no hand turn', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ cur: 'b1', phase: 'draw', pile: ['SQ-0', 'D4-0'] }));
  c.clock.t += 50;
  // A bot turn arrives coalesced: take, meld her, discard - one state.
  c.state(st({ cur: 'b2', turn: 9, phase: 'draw', pile: ['H9-1'], melds: [['b1', QUEENS]] }));
  assert.ok(c.doc.querySelector('#discardPile .qGhost'), 'the ghost leaves the pile');
  assert.ok(meldQueen(c.doc).classList.contains('qTurn'), 'and she turns on the table');
  assert.ok(!pileTop(c.doc).classList.contains('qTurn'), 'the new top card does not turn');
  assert.deepEqual(c.errors, []);
});

test('laid out: her meld card turns and the announcement still comes', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ hand: [...HAND, 'SQ-0', 'HQ-0', 'CQ-0'], melds: [['b1', ['D8-0', 'D9-0', 'D10-1']]] }));
  c.clock.t += 50;
  c.state(st({ hand: HAND, melds: [['b1', ['D8-0', 'D9-0', 'D10-1']], ['p1', QUEENS]] }));
  const q = meldQueen(c.doc);
  assert.ok(q.classList.contains('qTurn'));
  assert.strictEqual(q.dataset.q, 'meld');
  assert.ok(c.doc.querySelector('.raidWarning'), 'the existing announcement stays');
  assert.deepEqual(turning(c.doc), ['SQ-0']);
  assert.deepEqual(c.errors, []);
});

test('laid out by a bot: her turn plays out though the next states follow within milliseconds', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ cur: 'b1', turn: 8, phase: 'draw' }));
  // A Zen bot: the net picks the discard asynchronously, so meld and discard arrive as two states.
  c.clock.t += 50;
  c.state(st({ cur: 'b1', turn: 8, phase: 'meld', melds: [['b1', QUEENS]] }));
  assert.ok(meldQueen(c.doc).classList.contains('qTurn'), 'she starts turning');
  const at = meldQueen(c.doc).dataset.qAt;
  c.clock.t += 5;
  c.state(st({ cur: 'b2', turn: 9, phase: 'draw', pile: ['H9-1', 'D4-0', 'C7-1'], melds: [['b1', QUEENS]] }));
  let q = meldQueen(c.doc);
  assert.ok(q.classList.contains('qTurn'), 'the discard 5 ms later does not cut her turn');
  assert.strictEqual(q.dataset.qAt, at, 'the same moment, resumed');
  assert.strictEqual(q.style.getPropertyValue('--q-delay'), '-5ms');
  // A fast bot plays its whole turn 400 ms later: still her turn.
  c.clock.t += 400;
  c.state(st({ cur: 'p1', turn: 10, phase: 'draw', pile: ['S3-1', 'H9-1', 'D4-0', 'C7-1'], melds: [['b1', QUEENS]] }));
  q = meldQueen(c.doc);
  assert.ok(q.classList.contains('qTurn'));
  assert.strictEqual(q.style.getPropertyValue('--q-delay'), '-405ms');
  // Past 580 ms and in another turn the moment is over, with no restart.
  c.clock.t += 200;
  c.state(st({ cur: 'p1', turn: 10, phase: 'meld', draw: 39, pile: ['S3-1', 'H9-1', 'D4-0', 'C7-1'], melds: [['b1', QUEENS]] }));
  q = meldQueen(c.doc);
  assert.ok(!q.classList.contains('qTurn') && !q.classList.contains('qStill'), 'over');
  assert.deepEqual(turning(c.doc), []);
  assert.deepEqual(c.errors, []);
});

test('never on: reload, rejoin, a new deal, "Zurücklegen", an undone meld, the face-down last card', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  // Reload: the first state shows her everywhere - nothing turns.
  c.join();
  c.state(st({ hand: [...HAND, 'SQ-1'], pile: ['SQ-0', 'D4-0'], melds: [['b1', ['HQ-0', 'CQ-0', 'DQ-0']]] }));
  assert.deepEqual(turning(c.doc), [], 'reload');
  // Rejoin after a gap: the state jumped (she was discarded meanwhile) - still a baseline.
  c.clock.t += 2000;
  c.join();
  c.state(st({ hand: HAND, pile: ['SQ-1', 'SQ-0', 'D4-0'], turn: 9, cur: 'b1', phase: 'draw' }));
  assert.deepEqual(turning(c.doc), [], 'rejoin');
  // A new round deals her to me.
  c.clock.t += 2000;
  c.state(st({ roundNumber: 3, turn: 0, hand: [...HAND, 'SQ-0'], pile: ['C3-0'], phase: 'draw' }));
  assert.deepEqual(turning(c.doc), [], 'new deal');
  // "Zurücklegen": I take her and put her back within my turn.
  c.clock.t += 2000;
  c.state(st({ roundNumber: 3, turn: 4, phase: 'draw', pile: ['SQ-1', 'C3-0'], hand: [...HAND, 'HQ-1', 'CQ-1'] }));
  c.clock.t += 2000;
  c.state(st({ roundNumber: 3, turn: 4, phase: 'meld', pile: ['C3-0'], hand: [...HAND, 'HQ-1', 'CQ-1', 'SQ-1'], canUndoPileTake: true }));
  c.clock.t += 2000;
  c.state(st({ roundNumber: 3, turn: 4, phase: 'draw', pile: ['SQ-1', 'C3-0'], hand: [...HAND, 'HQ-1', 'CQ-1'] }));
  assert.deepEqual(turning(c.doc), [], 'her return to the pile is no discard');
  assert.ok(!c.doc.querySelector('.qStill'), 'and no still cue either');
  // An undone meld brings her back to my hand: no draw.
  c.clock.t += 2000;
  c.state(st({ roundNumber: 3, turn: 4, phase: 'meld', pile: ['C3-0'], hand: HAND, melds: [['p1', ['SQ-1', 'HQ-1', 'CQ-1']]] }));
  c.clock.t += 2000;
  c.state(st({ roundNumber: 3, turn: 4, phase: 'meld', pile: ['C3-0'], hand: [...HAND, 'SQ-1', 'HQ-1', 'CQ-1'], canUndoMeld: false }));
  assert.ok(!c.doc.querySelector('#hand .qTurn'), 'an undone meld is no draw');
  // The last card goes face down: she is never shown, nothing turns.
  c.clock.t += 2000;
  c.state(st({ roundNumber: 3, turn: 5, cur: 'b1', phase: 'draw', pile: ['SQ-0', 'C3-0'], faceDownTop: true, hand: HAND }));
  assert.ok(!pileTop(c.doc).classList.contains('qTurn'), 'face-down last discard');
  assert.ok(pileTop(c.doc).classList.contains('back'));
  assert.deepEqual(c.errors, []);
});

test('the still cue lives for her turn only; the ghost and the turn need motion', async (t) => {
  const c = boot({ reduced: true });
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ phase: 'draw', pile: ['SQ-1', 'D4-0'], hand: [...HAND, 'HQ-1', 'CQ-1'] }));
  c.clock.t += 50;
  c.state(st({ hand: [...HAND, 'HQ-1', 'CQ-1', 'SQ-0'], pile: ['SQ-1', 'D4-0'], draw: 39 }));
  const q = handQueen(c.doc);
  assert.ok(q.classList.contains('qStill'), 'reduced motion: the still cue on her hand card');
  assert.ok(q.querySelector('.corner .qProfile'), 'her profile sits in the index corner');
  assert.strictEqual(q.querySelector('.qProfile').getAttribute('aria-hidden'), 'true');
  // She is taken... by me, from the pile: no ghost without motion.
  c.clock.t += 50;
  c.state(st({ hand: [...HAND, 'HQ-1', 'CQ-1', 'SQ-0', 'SQ-1'], pile: ['D4-0'], draw: 39, mustLayOffCardId: 'SQ-1' }));
  assert.ok(!c.doc.querySelector('.qGhost'), 'no ghost with reduced motion');
  assert.ok(c.doc.querySelector('#hand .card[data-card-id="SQ-1"]').classList.contains('qStill'));
  // Long after the 580 ms the cue is still there: it lasts the turn, not the animation.
  c.clock.t += 5000;
  c.doc.getElementById('sortToggleBtn').click();
  assert.ok(handQueen(c.doc).classList.contains('qStill'));
  assert.ok(!handQueen(c.doc).classList.contains('qTurn'));
  // My turn ends: the cue goes.
  c.clock.t += 50;
  c.state(st({ hand: [...HAND, 'HQ-1', 'CQ-1', 'SQ-0', 'SQ-1'], pile: ['H2-1', 'D4-0'], turn: 9, cur: 'b1', phase: 'draw' }));
  assert.ok(!c.doc.querySelector('.qStill'), 'gone with the turn');
  // Pile and meld get the same cue; the profile also on the pile card.
  c.clock.t += 50;
  c.state(st({ hand: HAND, pile: ['SQ-0', 'H2-1', 'D4-0'], turn: 10, cur: 'b2', phase: 'draw', melds: [['b1', ['SQ-1', 'HQ-1', 'CQ-1']]] }));
  assert.ok(pileTop(c.doc).classList.contains('qStill'));
  assert.ok(pileTop(c.doc).querySelector('.qProfile'));
  assert.ok(c.doc.querySelector('#melds .card[data-card-id="SQ-1"]').classList.contains('qStill'));
  assert.ok(c.doc.querySelector('#melds .card[data-card-id="SQ-1"] .corner .qProfile'));
  assert.deepEqual(c.errors, []);
});

function roundEnd(over = {}) {
  const mk = (score, win) => ({ roundScore: score, breakdown: { isWinner: !!win, multiplier: 1 } });
  return {
    ...st({ cur: 'b1', phase: 'draw' }), phase: 'roundEnd', lastRoundWinnerId: 'b1',
    totals: { p1: 15, b1: 300, b2: 90 },
    lastRoundResult: { p1: mk(-105), b1: mk(180, true), b2: mk(30) },
    lastRoundStats: [
      { id: 'p1', name: 'Flo', laidOutCount: 3, handCount: 4, pikDameCount: 1, laidLines: [{ kind: 'low', count: 3, points: 15 }],
        handLines: [{ kind: 'pikdame', count: 1, points: 100 }, { kind: 'low', count: 3, points: 15 }] },
      { id: 'b1', name: 'Klaus', laidOutCount: 15, handCount: 0 },
      { id: 'b2', name: 'Horst', laidOutCount: 9, handCount: 4 },
    ],
    ...over,
  };
}

test('round end, caught on my hand: a chip next to my name, first her, then the price', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ cur: 'b1', phase: 'meld', hand: ['SQ-0', 'H2-0', 'H5-0', 'C9-0'] }));
  c.clock.t += 50;
  c.state(roundEnd());
  const chips = c.doc.querySelectorAll('#resultBody .qChip');
  assert.strictEqual(chips.length, 1, 'only my row');
  const chip = chips[0];
  const row = chip.closest('.resultRow');
  assert.ok(row.classList.contains('isMe') && row.classList.contains('hasQueenChip'));
  assert.strictEqual(chip.previousElementSibling.className, 'resultName', 'right after my name');
  assert.strictEqual(chip.getAttribute('role'), 'img');
  assert.strictEqual(chip.getAttribute('aria-label'), 'Pik Dame auf der Hand: −100');
  assert.strictEqual(chip.title, chip.getAttribute('aria-label'));
  assert.strictEqual(chip.querySelector('.qPrice').textContent, '−100');
  assert.ok(chip.classList.contains('qTurn'), 'she turns in (after the sheet lands: --q-lead in CSS)');
  // Re-renders of the sheet (progress, stammtisch ...) continue it.
  c.clock.t += 300;
  c.state(roundEnd({ log: [{ text: 'x' }] }));
  const again = c.doc.querySelector('#resultBody .qChip');
  assert.strictEqual(again.style.getPropertyValue('--q-delay'), '-300ms');
  assert.deepEqual(c.errors, []);
});

test('round end chip: English, both queens, doubled round, and static after a reload', async (t) => {
  const c = boot({ lang: 'en' });
  t.after(() => c.window.close());
  await ready();
  c.join();
  const both = roundEnd({
    lastRoundResult: { p1: { roundScore: -420, breakdown: { isWinner: false, multiplier: 2 } }, b1: { roundScore: 360, breakdown: { isWinner: true, multiplier: 2 } }, b2: { roundScore: -40, breakdown: { isWinner: false, multiplier: 2 } } },
  });
  both.lastRoundStats[0] = { ...both.lastRoundStats[0], pikDameCount: 2, handLines: [{ kind: 'pikdame', count: 2, points: 200 }] };
  c.state(both); // a reload straight into the result sheet
  const chip = c.doc.querySelector('#resultBody .qChip');
  assert.ok(chip, 'the chip is part of the result');
  assert.ok(!chip.classList.contains('qTurn') && !chip.classList.contains('qStill'), 'no moment after a reload: static');
  assert.strictEqual(chip.getAttribute('aria-label'), 'Both Queens of Spades left in hand: −400');
  // Nobody caught her: no chip.
  c.state(roundEnd({ lastRoundStats: roundEnd().lastRoundStats.map((s) => ({ ...s, pikDameCount: 0 })) }));
  assert.strictEqual(c.doc.querySelectorAll('#resultBody .qChip').length, 0);
  assert.deepEqual(c.errors, []);
});

test('reduced motion: the chip holds her pose (still cue), no ghost anywhere', async (t) => {
  const c = boot({ reduced: true });
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ cur: 'b1', phase: 'meld', hand: ['SQ-0', 'H2-0'] }));
  c.clock.t += 50;
  c.state(roundEnd());
  const chip = c.doc.querySelector('#resultBody .qChip');
  assert.ok(chip.classList.contains('qStill'));
  assert.ok(!c.doc.querySelector('.qGhost'));
  assert.deepEqual(c.errors, []);
});

// --- Engine fuzz: the client's moments against the engine's own action log ------------
const GameManager = require('../game/GameManager');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const QS = ['SQ-0', 'SQ-1'];
const inHand = (g, pid, id) => g.players.find((p) => p.id === pid).hand.some((c) => c.id === id);
const onTable = (g, id) => g.tableMelds.some((m) => m.slots.some((s) => s.real && s.real.id === id));

/** What p1 must see after one engine tick, from the engine's action log alone. */
function truth(g, before, log) {
  const out = [];
  if (before.round !== g.roundNumber || before.phase !== 'playing') return out;
  if (g.phase === 'roundEnd' || g.phase === 'gameOver') {
    const me = (g.lastRoundStats || []).find((s) => s.id === 'p1');
    return me && me.pikDameCount > 0 ? ['caught'] : out;
  }
  for (const a of log) {
    const [pid] = a.args;
    if (a.name === 'drawFromPile' && pid === 'p1' && QS.includes(a.card) && inHand(g, 'p1', a.card)) out.push(`draw:${a.card}`);
    if (a.name === 'drawFromDiscard' && QS.includes(a.top)) {
      out.push(`leave:${a.top}`);
      if (pid === 'p1' && inHand(g, 'p1', a.top)) out.push(`pickup:${a.top}`);
    }
    if (a.name === 'rest' && pid === 'p1') for (const q of a.cards.filter((id) => QS.includes(id) && inHand(g, 'p1', id))) out.push(`pickup:${q}`);
    if (a.name === 'discard' && QS.includes(a.args[1])) out.push(`discard:${a.args[1]}`);
    const laid = { layoutMeld: a.args[1], layOffCards: a.args[2], layOffCard: [a.args[2]], swapJoker: [a.args[2]] }[a.name];
    for (const q of (laid || []).filter((id) => QS.includes(id) && onTable(g, id))) out.push(`meld:${q}`);
  }
  return [...new Set(out)].sort();
}
/** What the client turned for the state it just rendered (the clock moved on: only new moments). */
function seen(doc, stNow) {
  const out = [];
  for (const n of doc.querySelectorAll('#hand .card.qTurn')) out.push(`${n.dataset.q}:${n.dataset.cardId}`);
  for (const n of doc.querySelectorAll('#melds .card.qTurn')) out.push(`meld:${n.dataset.cardId}`);
  if (pileTop(doc).classList.contains('qTurn')) out.push(`discard:${stNow.discardTop.id}`);
  for (const n of doc.querySelectorAll('#discardPile .qGhost')) { out.push(`leave:${n.dataset.cardId}`); n.remove(); }
  const sheetOpen = !doc.getElementById('resultOverlay').classList.contains('hidden'); // a closed sheet keeps its old rows
  if (sheetOpen && doc.querySelector('#resultBody .qChip.qTurn')) out.push('caught');
  return out.sort();
}

test('fuzz: real games - she turns exactly when the engine says she moved, never otherwise', async (t) => {
  const realRandom = Math.random;
  Math.random = mulberry32(20261022); // the engine's bots: a fixed game, every run
  t.after(() => { Math.random = realRandom; });
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  const rnd = mulberry32(7);
  const mismatches = [];
  const counts = {};
  for (const seed of [11, 23, 47, 58]) {
    const inbox = [];
    const g = new GameManager((pid, msg) => { if (pid === 'p1' && msg.type === 'state') inbox.push(msg.state); }, { deckSeed: seed });
    t.after(() => g.destroy());
    g.maybeRunBotTurn = () => {}; // the test plays every seat itself
    g.addOrReconnectPlayer('p1', 'Flo');
    g.syncLobbyBots();
    for (const p of g.players) if (p.isBot) p.botDifficulty = 'easy'; // easy bots throw her carelessly
    let log = [];
    for (const name of ['drawFromPile', 'drawFromDiscard', 'discard', 'undoPileTake', 'layoutMeld', 'layOffCards', 'layOffCard', 'swapJoker']) {
      const orig = g[name].bind(g);
      g[name] = (...args) => {
        const top = g.discardPile[0];
        const card = g.drawPile[0] && g.drawPile[0].id;
        const r = orig(...args);
        if (r && r.ok) log.push({ name, args, card, top: top && !top.faceDown ? top.id : null });
        return r;
      };
    }
    const resolve = g.resolvePendingDiscardPickup.bind(g);
    g.resolvePendingDiscardPickup = (player) => {
      const cards = g.discardPile.map((cd) => cd.id);
      const r = resolve(player);
      log.push({ name: 'rest', args: [player.id], cards });
      return r;
    };
    const tick = async (fn) => {
      const before = { round: g.roundNumber, phase: g.phase };
      log = [];
      fn();
      await new Promise((r) => setImmediate(r)); // the server's one coalesced broadcast per tick
      const want = truth(g, before, log);
      c.clock.t += 5000;
      let got = [];
      for (const s of inbox.splice(0)) {
        c.state(s);
        // Going out holds the final table for a beat: a tap opens the sheet, as for a player.
        const beat = c.doc.querySelector('.outBeat');
        if (beat) beat.dispatchEvent(new c.window.MouseEvent('click', { bubbles: true }));
        got = got.concat(seen(c.doc, s));
      }
      got.sort();
      for (const m of want) counts[m.split(':')[0]] = (counts[m.split(':')[0]] || 0) + 1;
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`seed ${seed} R${g.roundNumber} T${g.turnIndexInRound}: engine ${want.join(',') || '-'} / client ${got.join(',') || '-'} after ${log.map((a) => a.name).join(',') || 'deal'}`);
    };
    // p1 plays like a human (one state per action, pile takes undone) or times out (one coalesced state).
    const myTurn = async () => {
      if (rnd() < 0.3) return tick(() => g.runBotTurn('p1', { forced: true }));
      if (rnd() < 0.5) {
        await tick(() => g.drawFromDiscard('p1'));
        if (g.pendingDiscardRest) await tick(() => g.undoPileTake('p1'));
      }
      if (g.turnPhase === 'draw') await tick(() => g.drawFromPile('p1'));
      if (g.phase !== 'playing' || g.currentPlayer().id !== 'p1') return;
      const hand = g.players[0].hand;
      const queen = hand.find((cd) => QS.includes(cd.id));
      const card = queen && rnd() < 0.5 ? queen : hand.find((cd) => !cd.isJoker && cd !== queen) || hand[0];
      await tick(() => g.discard('p1', card.id));
    };
    c.join();
    await tick(() => g.startNewRound());
    for (let guard = 0; guard < 3000 && g.roundNumber <= 3 && g.phase !== 'gameOver'; guard++) {
      if (g.phase === 'roundEnd') { await tick(() => g.startNewRound()); continue; }
      if (g.phase !== 'playing') break;
      if (g.currentPlayer().id === 'p1') await myTurn();
      else await tick(() => g.runBotTurn(g.currentPlayer().id));
    }
  }
  assert.deepEqual(mismatches, [], `client and engine disagree:\n  ${mismatches.slice(0, 12).join('\n  ')}`);
  // Not vacuous: every moment came up in these games.
  for (const kind of ['draw', 'pickup', 'discard', 'leave', 'meld', 'caught']) assert.ok(counts[kind] > 0, `no ${kind} in the fuzz games: ${JSON.stringify(counts)}`);
  assert.deepEqual(c.errors, []);
});

test('fuzz: every queen meld by any seat turns exactly once, for its full 580 ms, at bot speed', async (t) => {
  const realRandom = Math.random;
  Math.random = mulberry32(20261025);
  t.after(() => { Math.random = realRandom; });
  // The Zen path as in production: the net answers on a later tick, so meld and discard are two states.
  const OnnxPolicy = require('../game/OnnxPolicy');
  const real = { draw: OnnxPolicy.chooseDrawSource, discard: OnnxPolicy.chooseDiscardCard };
  const later = () => new Promise((r) => setImmediate(() => r(null))); // null = the heuristic decides
  OnnxPolicy.chooseDrawSource = later;
  OnnxPolicy.chooseDiscardCard = later;
  t.after(() => { OnnxPolicy.chooseDrawSource = real.draw; OnnxPolicy.chooseDiscardCard = real.discard; });
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  const rnd = mulberry32(5);
  const problems = [];
  let melds = 0;
  for (const seed of [11, 23, 47, 58, 61]) {
    const inbox = [];
    const g = new GameManager((pid, msg) => { if (pid === 'p1' && msg.type === 'state') inbox.push(msg.state); }, { deckSeed: seed });
    t.after(() => g.destroy());
    g.maybeRunBotTurn = () => {};
    g.addOrReconnectPlayer('p1', 'Flo');
    g.syncLobbyBots();
    for (const p of g.players) if (p.isBot) p.botDifficulty = 'easy';
    let laid = [];
    for (const name of ['layoutMeld', 'layOffCards', 'layOffCard', 'swapJoker']) {
      const orig = g[name].bind(g);
      g[name] = (...args) => {
        const r = orig(...args);
        const ids = { layoutMeld: args[1], layOffCards: args[2], layOffCard: [args[2]], swapJoker: [args[2]] }[name] || [];
        if (r && r.ok) laid.push(...ids.filter((id) => QS.includes(id) && onTable(g, id)));
        return r;
      };
    }
    const live = new Map(); // cardId -> { at, t0 } of the client's running meld moment
    const flush = () => {
      for (const s of inbox.splice(0)) {
        const roundOver = s.phase !== 'playing';
        c.state(s);
        const want = new Set(laid.splice(0));
        for (const n of c.doc.querySelectorAll('#melds .card')) {
          const id = n.dataset.cardId;
          if (!QS.includes(id)) continue;
          const on = n.classList.contains('qTurn');
          const m = live.get(id);
          if (on && (!m || m.at !== n.dataset.qAt)) {
            if (!want.delete(id)) problems.push(`seed ${seed}: ${id} turned on the table without a meld`);
            else melds += 1;
            live.set(id, { at: n.dataset.qAt, t0: c.clock.t });
          } else if (!on && m && c.clock.t - m.t0 < 580) {
            problems.push(`seed ${seed}: ${id} stopped after ${c.clock.t - m.t0} ms`);
          }
          if (!on) live.delete(id);
        }
        if (!roundOver) for (const id of want) problems.push(`seed ${seed}: ${id} melded without her turn`);
      }
    };
    // Bot pace: the next state 0-450 ms later (fast pace starts at 350 ms, the net in a few ms).
    const tick = async (fn) => {
      await fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      c.clock.t += Math.floor(rnd() * 450);
      flush();
    };
    c.join();
    await tick(() => g.startNewRound());
    for (let guard = 0; guard < 3000 && g.roundNumber <= 3 && g.phase !== 'gameOver'; guard++) {
      if (g.phase === 'roundEnd') { live.clear(); await tick(() => g.startNewRound()); continue; }
      if (g.phase !== 'playing') break;
      const id = g.currentPlayer().id;
      // Any seat: the Zen path (meld state, its discard a tick later) or one coalesced heuristic turn.
      const forced = id === 'p1';
      await tick(() => (rnd() < 0.6 ? g._runBotTurnWithOnnx(id, { forced }) : g.runBotTurn(id, { forced })));
    }
  }
  assert.deepEqual(problems, [], problems.slice(0, 12).join('\n'));
  assert.ok(melds >= 3, `the games melded her too rarely to prove anything: ${melds}`);
  assert.deepEqual(c.errors, []);
});

// --- CSS contract ------------------------------------------------------------------------
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const client = SRC[1];
/** The body of @keyframes <name>, braces balanced (one-line blocks too). */
function keyframes(name) {
  const at = css.indexOf(`@keyframes ${name} {`);
  assert.ok(at > -1, `@keyframes ${name} exists`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', at) + 1, i);
  }
  throw new Error(`unbalanced @keyframes ${name}`);
}
/** "a 1s cubic-bezier(.3, 0, .2, 1), b 2s" -> the two entries (commas inside () stay). */
const entries = (value) => value.split(/,(?![^(]*\))/).map((e) => e.trim());

test('CSS contract: the turn is 0 -> -32 -> +9 -> 0 degrees in 580 ms, the exit 84 degrees in 420 ms', () => {
  const turn = keyframes('qTurn');
  assert.match(turn, /36% \{[^}]*rotateY\(-32deg\)/);
  assert.match(turn, /70% \{[^}]*rotateY\(9deg\)/);
  assert.match(turn, /0%, 100% \{[^}]*rotateY\(0deg\)/);
  assert.match(keyframes('qTurnAway'), /to \{[^}]*rotateY\(84deg\)/);
  assert.match(css, /\.card\.qTurn \{ animation: qTurn 580ms cubic-bezier\(\.33, 0, \.2, 1\)/);
  assert.match(css, /\.qGhost \{ animation: qTurnAway 420ms /);
  assert.match(client, /const QUEEN_TURN_MS = 580;/, 'JS and CSS agree on the turn');
  assert.match(client, /const QUEEN_EXIT_MS = 420;/, 'and on the exit');
});

test('CSS contract: her turn animates only transform and opacity (plus the transient z-index)', () => {
  for (const name of ['qTurn', 'qTurnPile', 'qShade', 'qTurnAway', 'qShadeIn', 'qTurnIn', 'qPriceIn']) {
    const frames = keyframes(name);
    const props = [...frames.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(props.length, `${name} animates something`);
    assert.deepEqual(props.filter((p) => !['transform', 'opacity', 'z-index'].includes(p)), [], `${name}: only transform/opacity`);
  }
});

test('CSS contract: the lift above the neighbours never outlives the turn', () => {
  // z-index lives in the keyframes only, with fill-mode backwards: at rest no card
  // covers the tap strips of its neighbours (see "nothing in the hand fan raises z-index").
  assert.match(keyframes('qTurn'), /z-index: 3/);
  let seen = 0;
  for (const m of css.matchAll(/([^{}]*\.(?:qTurn|qStill)[^{}]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(m[2], /z-index\s*:/, `${m[1].trim()} must not raise z-index`);
    const anim = (m[2].match(/animation:([^;]*)/) || [])[1] || '';
    for (const entry of entries(anim).filter((e) => /^qTurn\s/.test(e))) {
      seen += 1;
      assert.match(entry, /\bbackwards\b/, `${m[1].trim()}: the turn must not stay filled`);
    }
  }
  assert.ok(seen >= 3, 'the turn rules were found');
});

test('CSS contract: a shade on the paper in --suit-black, never a ring or the gold/accent colours', () => {
  const ours = [...css.matchAll(/([^{}]*\.(?:qTurn|qStill|qGhost|qChip|qProfile|qMini)[^{}]*)\{([^}]*)\}/g)].map((m) => m[2]).join('\n');
  assert.match(css, /--q-shade: color-mix\(in srgb, var\(--suit-black\)/);
  assert.match(css, /\.qProfile \{[^}]*fill: var\(--suit-black\)/);
  assert.doesNotMatch(ours, /var\(--(?:accent|drawn|gold)[\w-]*\)/, 'no selection, draw or gold colours');
  assert.doesNotMatch(ours, /box-shadow:\s*0 0 0 /, 'no ring around her card');
  // Reduced motion: no animation at all, the still cue instead.
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.card\.qTurn \{ animation/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.card\.qStill \{ transform: var\(--fan, rotate\(0deg\)\)[^}]*rotateY\(-24deg\)/);
  assert.match(css, /\.qStill \.qProfile \{ display: block; \}/);
});
