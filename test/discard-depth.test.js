// The discard pile shows its thickness: card edges under the top card, one per two cards,
// seven at most. client.js sets --pd on the top card, style.css draws that many edges as box
// shadows. jsdom loads no style.css, so the drawing is checked as a source contract.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');
const JS = read('client.js');
const CSS = read('style.css');
const MAX = Number(/const PILE_DEPTH_MAX = (\d+);/.exec(JS)[1]);
const STEP = Number(/const PILE_DEPTH_STEP = (\d+);/.exec(JS)[1]);

/** The real client in jsdom, at a table; opponent flights off (they need a layout). */
function boot() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(read('index.html'), { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.requestAnimationFrame = () => 0;
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
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
  window.localStorage.setItem('pikdame_opp_moves', 'off');
  for (const f of ['i18n.js', 'table-moves.js', 'client.js']) window.eval(read(f));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const send = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  return { window, doc: window.document, errors, send };
}

const C = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
/** A playing state as p1 sees it, the discard pile `n` cards high. */
function st(n, { faceDownTop = false } = {}) {
  const cards = Array.from({ length: n }, (_, i) => C(`D${(i % 9) + 2}-${i}`));
  return {
    phase: 'playing', roundNumber: 2, turnIndexInRound: 8, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b2',
    drawPileCount: 40, discardTop: cards[0] ? (faceDownTop ? { faceDown: true } : cards[0]) : null, discardPileCount: n,
    discardCards: cards, tableMelds: [], log: [], houseRules: {}, lobbyReady: [], nextRoundReady: [],
    totals: { p1: 120, b1: 80 }, scoreHistory: [],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 2, hand: [C('H2-0'), C('H5-0')] },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 12, botDifficulty: 'medium' },
    ],
  };
}

test('the pile depth follows the count: one edge per two cards under the top card, capped', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await new Promise((r) => setTimeout(r, 10));
  c.send({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'DEPTH1' });
  const top = c.doc.getElementById('discardTopCard');
  const depthAt = (n, o) => {
    c.send({ type: 'state', state: st(n, o) });
    return top.style.getPropertyValue('--pd');
  };
  assert.strictEqual(MAX, 7);
  assert.strictEqual(STEP, 2);
  const want = { 0: 0, 1: 0, 2: 1, 3: 1, 4: 2, 5: 2, 6: 3, 7: 3, 13: 6, 14: 7, 15: 7, 16: 7, 40: 7 };
  for (const [n, depth] of Object.entries(want)) {
    assert.strictEqual(depthAt(Number(n)), String(depth), `${n} cards`);
    assert.strictEqual(depth, Math.max(0, Math.min(MAX, Math.ceil((n - 1) / STEP))));
  }
  // An opponent's discard lands in the same state as its card: the depth is never a render behind.
  assert.strictEqual(depthAt(3), '1');
  assert.strictEqual(depthAt(4), '2');
  assert.strictEqual(top.textContent, '2♦', 'the same render paints the top card');
  // Taken away: an empty pile has no edges; a face-down top card keeps its pile's edges.
  assert.strictEqual(depthAt(0), '0');
  assert.ok(top.classList.contains('empty'));
  assert.strictEqual(depthAt(9, { faceDownTop: true }), '4');
  assert.ok(top.classList.contains('back'));
  // Only the discard pile: the stock keeps its two steps and gets no depth.
  const stock = c.doc.querySelector('#drawPile .pile-card');
  assert.strictEqual(stock.style.getPropertyValue('--pd'), '');
  assert.ok(stock.classList.contains('stacked-2'));
  assert.ok(!/stacked/.test(top.className), 'the old two-step classes are gone from the discard pile');
  // One card on the pile and nothing new inside it: the edges are shadows, not elements.
  assert.strictEqual(c.doc.querySelectorAll('#discardPile .pile-card').length, 1);
  assert.deepEqual(c.errors, []);
});

/** The declarations of the first `selector { ... }` rule in style.css. */
function rule(selector) {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `style.css has a rule for ${selector}`);
  return CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
}

test('style.css draws the depth as shadows of the top card: no box, no layout, theme colours', () => {
  const body = rule('#discardTopCard');
  const props = [...body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)].map((m) => m[1]);
  for (const p of props) assert.ok(p.startsWith('--') || p === 'box-shadow', `${p}: the depth may only be custom properties and box-shadow`);
  // One paper layer and one parting line per edge, each clamped to the pile's depth.
  assert.strictEqual((body.match(/var\(--card-bg\)/g) || []).length, MAX, 'a paper layer per edge');
  assert.strictEqual((body.match(/0 0 var\(--pile-line\)/g) || []).length, MAX, 'a line per edge');
  for (let i = 1; i <= MAX; i++) {
    assert.ok(body.includes(`--d${i}: calc(min(var(--pd), ${i}) * var(--pile-edge));`), `edge ${i} hides under the last one the pile has`);
  }
  assert.ok(!body.includes(`--d${MAX + 1}`));
  // No edge and no line on a single card: every paper offset is clamped at the card itself.
  assert.strictEqual((body.match(/max\(0px, var\(--d\d\) - var\(--pl\)\)/g) || []).length, MAX * 2);
  // The lines take the theme's card colours (kitchen included), with a fallback without color-mix.
  assert.match(body, /--pile-line: var\(--card-border\);/);
  assert.match(CSS, /@supports \(color: color-mix\(in srgb, red, blue\)\) \{\s*#discardTopCard \{ --pile-line: color-mix\(in srgb, var\(--card-ink\) \d+%, var\(--card-bg\)\); \}/);
  // The pile's own shadows stay, so the card casts as before.
  assert.match(body, /var\(--shadow-2\), var\(--cast-far\), inset 0 1px 0 rgba\(255,255,255,0\.7\);/);
  // An empty pile has no shadow (the id rule would beat .pile-card.empty); reduced motion: no slide.
  assert.match(CSS, /\n#discardTopCard\.empty \{ box-shadow: none; \}/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{ #discardTopCard \{ transition: none; \} \}/);
});

test('the edges stay off the caption and inside what a flying card keeps clear of, in every layout', () => {
  // table-moves.js clearFlight: a ghost stops `pad` px before a pile's box (card, count, buttons).
  const pad = Number(/\{ pad = (\d+), steps/.exec(read('table-moves.js'))[1]);
  // The count plaque hangs over the card's right edge whenever the pile has cards: part of that box.
  const plaque = Number(/\.pile > span \{\s*position: absolute; top: -\d+px; right: -(\d+)px;/.exec(CSS)[1]);
  // The caption sits one flex gap under the card: the edges end above it.
  const gap = Number(/\n\.pile \{ position: relative; display: flex; flex-direction: column; align-items: center; gap: (\d+)px; \}/.exec(CSS)[1]);
  // The edges step further to the right than down (the factor on every vertical offset).
  const body = rule('#discardTopCard');
  const rises = new Set([...body.matchAll(/\) \* ([\d.]+)\) 0 0 var\(--/g)].map((m) => m[1]));
  assert.strictEqual(rises.size, 1, 'one slope for all edges');
  const rise = Number([...rises][0]);
  assert.strictEqual((body.match(new RegExp(`\\) \\* ${rise}\\) 0 0 var\\(--`, 'g')) || []).length, MAX * 2);
  const steps = [...CSS.matchAll(/--pile-edge: ([\d.]+)px;/g)].map((m) => Number(m[1]));
  assert.ok(steps.length >= 3, 'portrait, desktop and landscape set their own step');
  for (const s of steps) {
    assert.ok(s >= 1, `${s}px: an edge thinner than a pixel is no edge`);
    assert.ok(MAX * s * rise <= Math.min(gap, pad), `${s}px: ${MAX} edges reach ${MAX * s * rise}px down, the caption starts after ${gap}px`);
    assert.ok(MAX * s <= pad + plaque, `${s}px: ${MAX} edges reach ${MAX * s}px to the right`);
  }
  // Landscape (~400 px high, 40 px cards) takes the smallest step; it is set in a landscape block.
  const land = CSS.slice(CSS.indexOf('@media (orientation: landscape) and (max-height: 540px) {'));
  assert.match(land, /\.pile \{ --pile-cap: 16px; --pile-edge: 1px; \}/);
  assert.strictEqual(Math.min(...steps), 1);
});
