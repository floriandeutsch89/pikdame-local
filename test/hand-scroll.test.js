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
  // Real browsers expose the readyState constants; without them send()
  // would treat the open stub as dead and reconnect.
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
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

test('hand fan: only a pile take scrolls to the fresh cards, and only once', async (t) => {
  const { window, errors, scrolledInto, ws } = boot();
  // The client's connection watchdog ticks while the (stub) socket is open;
  // closing the window clears jsdom's timers so the test process can exit.
  t.after(() => window.close());
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

// v2.37.0: on a narrow screen a dense hand goes into two rows instead of one
// 19-26 px strip per card (and nothing scrolls); wide screens keep the fan.
function feedHandWithWidth(n, parentWidth) {
  const ctx = boot();
  const { window } = ctx;
  // jsdom has no layout: give the hand's parent a width and the cards a size.
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.id === 'handWrapper' ? parentWidth : 0; },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true, get() { return this.classList && this.classList.contains('card') ? 66 : 0; },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true, get() { return this.classList && this.classList.contains('card') ? 92 : 0; },
  });
  return ctx;
}

async function renderHand(ctx, n) {
  await new Promise((r) => setTimeout(r, 10));
  const sock = ctx.ws();
  const feed = (state) => sock._emit('message', { data: JSON.stringify({ type: 'state', state }) });
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  feed(playingState(makeHand(n), 'meld'));
  return ctx.window.document.getElementById('hand');
}

test('hand fan: 16 cards on a phone-width screen -> two rows, no scrolling', async (t) => {
  const ctx = feedHandWithWidth(16, 393);
  t.after(() => ctx.window.close());
  const hand = await renderHand(ctx, 16);
  assert.ok(hand.classList.contains('handRows'), 'dense hand uses the two-row layout');
  assert.ok(!hand.classList.contains('handScroll'), 'two rows replace the scroll mode');
  const rows = hand.querySelectorAll('.handRow');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children.length + rows[1].children.length, 16, 'no card lost');
  assert.equal(hand.querySelectorAll('.card').length, 16);
  // every card kept a tap strip well above the old 19-26 px
  const strip = 66 + parseFloat(rows[0].children[1].style.marginLeft);
  assert.ok(strip >= 30, `strip ${strip}px`);
  assert.deepEqual(ctx.errors, []);
});

test('hand fan: wide screens and small hands keep the single fan', async (t) => {
  const wide = feedHandWithWidth(16, 874);
  t.after(() => wide.window.close());
  const handW = await renderHand(wide, 16);
  assert.ok(!handW.classList.contains('handRows'), 'landscape/desktop: no rows');

  const small = feedHandWithWidth(8, 393);
  t.after(() => small.window.close());
  const handS = await renderHand(small, 8);
  assert.ok(!handS.classList.contains('handRows'), '8 cards fit one row');
});

test('CSS contract: scroll-mode hand keeps room for the selection lift', () => {
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  const m = css.match(/\n#hand\.handScroll\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '#hand.handScroll rule exists');
  const pad = m[1].replace(/\/\*[\s\S]*?\*\//g, '').match(/padding-top\s*:\s*(\d+)px/);
  assert.ok(pad && Number(pad[1]) >= 14, 'padding-top >= 14px (.card.selected lifts by 14px; overflow-x:auto would clip it)');
});

// Main menu: a finished match (winner decided) is not offered for resuming.
test('main menu: resume button hidden when the probed game is finished', async (t) => {
  const { window, errors, ws } = boot();
  t.after(() => window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ws();
  window.localStorage.setItem('pikdame_last_session', 'ABCD');
  const btn = window.document.getElementById('resumeBtn');
  const status = (extra) => sock._emit('message', { data: JSON.stringify({ type: 'sessionStatus', code: 'ABCD', exists: true, challenge: false, ...extra }) });
  status({ finished: false });
  assert.ok(!btn.classList.contains('hidden'), 'live game: resume offered');
  status({ finished: true });
  assert.ok(btn.classList.contains('hidden'), 'finished game: no resume button');
  status({});
  assert.ok(!btn.classList.contains('hidden'), 'older server without the field: unchanged behaviour');
  assert.deepEqual(errors, []);
});
