// Behaviour of the scrollable hand fan (>= 16 cards). Two rules that are
// easy to break and impossible to see in a unit test of the game logic:
//   1. Only a PILE TAKE (Ablagestapel) pulls the fan to the new cards.
//      A single card off the draw pile must leave the scroll position alone.
//   2. The pull happens exactly ONCE. It used to run on every render, so
//      scrolling left or right snapped straight back to the drawn card.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');

function boot() {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  const scrolledInto = [];

  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() { scrolledInto.push(this); };
  let rafDepth = 0;
  window.requestAnimationFrame = (cb) => {
    if (rafDepth > 4) return 0;
    rafDepth += 1;
    try { cb(Date.now()); } finally { rafDepth -= 1; }
    return 0;
  };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-test' }), text: () => Promise.resolve('') });
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
  window.onerror = (msg) => errors.push(String(msg));
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));

  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return { window, errors, scrolledInto, ws: () => ws };
}

const SUITS = ['H', 'S', 'C', 'D'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
function makeHand(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`, suit: SUITS[i % SUITS.length], rank: RANKS[i % RANKS.length],
  }));
}
function playingState(hand, turnPhase) {
  return {
    phase: 'playing', roundNumber: 1, currentPlayerId: 'p1', turnPhase, dealerId: 'b1',
    turnDeadline: null, discardTop: { id: 'dt', suit: 'H', rank: '7' },
    drawCount: 40, drawPileCount: 40, discardCount: 4, discardPileCount: 4,
    log: [], tableMelds: [], lobbyReady: [], nextRoundReady: [],
    houseRules: {}, totals: { p1: 0, b1: 0 },
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hand.length, hand },
      { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 15, botDifficulty: 'zen' },
    ],
  };
}

test('hand fan: only a pile take scrolls to the fresh cards, and only once', async () => {
  const { window, errors, scrolledInto, ws } = boot();
  await new Promise((r) => setTimeout(r, 10));
  const sock = ws();
  const feed = (state) => sock._emit('message', { data: JSON.stringify({ type: 'state', state }) });
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });

  const doc = window.document;
  const hand = doc.getElementById('hand');
  const click = (id) => doc.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 16 cards -> the fan is in scroll mode (that is what makes it possible
  // to scroll away from a card in the first place).
  const base = makeHand(16);
  feed(playingState(base, 'draw'));
  assert.ok(hand.classList.contains('handScroll'), 'Testaufbau: die Hand muss scrollbar sein');
  assert.equal(scrolledInto.length, 0, 'Erstanzeige scrollt nirgendwohin');

  // --- draw pile: new card is marked, but the fan stays put ---------------
  click('drawPile');
  const afterDraw = [...base, { id: 'drawn', suit: 'S', rank: 'Q' }];
  feed(playingState(afterDraw, 'meld'));
  assert.ok(
    [...hand.children].some((c) => c.classList.contains('just-drawn')),
    'die gezogene Karte muss den Glow behalten'
  );
  assert.equal(scrolledInto.length, 0, 'Ziehstapel darf den Fächer NICHT verschieben');

  // Re-render while the card is still fresh (any state update does this):
  // this is where the old code yanked the fan back.
  feed(playingState(afterDraw, 'meld'));
  assert.equal(scrolledInto.length, 0, 'auch spätere Renders dürfen nicht nachscrollen');

  // --- discard pile: a take DOES pull the fan to the new cards -----------
  feed(playingState(base, 'draw')); // next turn, fresh start
  click('discardPile');
  const afterTake = [...base, { id: 't1', suit: 'H', rank: '5' }, { id: 't2', suit: 'D', rank: '6' }];
  feed(playingState(afterTake, 'meld'));
  assert.equal(scrolledInto.length, 1, 'Stapelaufnahme holt die neuen Karten ins Bild');

  // ... but exactly once, not on every following render.
  feed(playingState(afterTake, 'meld'));
  feed(playingState(afterTake, 'meld'));
  assert.equal(scrolledInto.length, 1, 'die Aufnahme scrollt genau einmal');

  assert.deepEqual(errors, [], `Client-Fehler: ${errors.join(' | ')}`);
});
