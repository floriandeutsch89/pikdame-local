// Play aids (v2.38.0): per-device switches for the discard hint (default OFF)
// and the lay-off hint (default ON); the tutorial always has both.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');

function boot(storage = {}) {
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

  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return { window, errors, scrolledInto, ws: () => ws };
}


const card = (id, suit, rank) => ({ id, suit, rank });
function state({ tutorial = false, takeable = false } = {}) {
  const hand = [card('h1', 'H', '7'), card('h2', 'S', '2'), card('h3', 'C', '9'), card('h4', 'D', 'K')];
  return {
    phase: 'playing', roundNumber: 1, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1',
    tutorialMode: tutorial, discardTakeable: takeable,
    turnDeadline: null, discardTop: { id: 'dt', suit: 'H', rank: 'Q' },
    drawPileCount: 40, discardPileCount: 4, log: [],
    tableMelds: [{ id: 'm1', ownerId: 'p1', type: 'set', rank: '7', slots: [{ real: card('t1', 'S', '7') }, { real: card('t2', 'C', '7') }, { real: card('t3', 'D', '7') }] }],
    lobbyReady: [], nextRoundReady: [], houseRules: {}, totals: { p1: 0, b1: 0 },
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hand.length, hand },
      { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 15, botDifficulty: 'zen' },
    ],
  };
}
async function setup(t, storage = {}) {
  const ctx = boot(storage);
  t.after(() => ctx.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ctx.ws();
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  const feed = (s) => sock._emit('message', { data: JSON.stringify({ type: 'state', state: s }) });
  return { ...ctx, feed, doc: ctx.window.document };
}

test('discard hint: default OFF = old behaviour (always glows); switch ON mutes a refused pile', async (t) => {
  const { doc, feed, window, errors } = await setup(t);
  const pile = doc.getElementById('discardPile');
  feed(state({ takeable: false }));
  assert.ok(pile.classList.contains('glow') && !pile.classList.contains('noTake'), 'off: glows regardless of legality');
  doc.getElementById('aidDiscardToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(pile.classList.contains('noTake') && !pile.classList.contains('glow'), 'on: not takeable -> muted, no glow');
  assert.equal(window.localStorage.getItem('pikdame_aid_discard'), 'on');
  feed(state({ takeable: true }));
  assert.ok(pile.classList.contains('glow') && !pile.classList.contains('noTake'), 'on + takeable -> glows');
  assert.deepEqual(errors, []);
});

test('discard hint: the tutorial forces it on even with the switch off', async (t) => {
  const { doc, feed } = await setup(t);
  feed(state({ tutorial: true, takeable: false }));
  assert.ok(doc.getElementById('discardPile').classList.contains('noTake'));
});

test('lay-off hint: default ON frames the meld; OFF removes the frame; tutorial forces ON', async (t) => {
  const { doc, feed, window } = await setup(t);
  const frame = () => doc.querySelectorAll('#melds .meldGroup.layOffTarget').length;
  const playing = (extra) => ({ ...state(extra), turnPhase: 'meld' });
  feed(playing());
  doc.querySelector('#hand .card[data-card-id="h1"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // the 7
  assert.equal(frame(), 1, 'default: the set of sevens is framed');
  doc.getElementById('aidLayOffToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(window.localStorage.getItem('pikdame_aid_layoff'), 'off');
  assert.equal(frame(), 0, 'off: no frame');
  feed(playing({ tutorial: true }));
  assert.equal(frame(), 1, 'tutorial: frame is back');
});

test('stored choices are read on start and mirrored by the lobby checkboxes and rows', async (t) => {
  const { doc, feed } = await setup(t, { pikdame_aid_layoff: 'off', pikdame_aid_discard: 'on', pikdame_tips: 'off' });
  assert.equal(doc.getElementById('aidLayOffCheckbox').checked, false);
  assert.equal(doc.getElementById('aidDiscardCheckbox').checked, true);
  assert.equal(doc.getElementById('aidTipsCheckbox').checked, false);
  feed(state({ takeable: false }));
  assert.ok(doc.getElementById('discardPile').classList.contains('noTake'), 'stored ON is honoured');
  // the lobby checkbox drives the same state as the in-game row
  const box = doc.getElementById('aidDiscardCheckbox');
  box.checked = false;
  box.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  assert.ok(!doc.getElementById('discardPile').classList.contains('noTake'));
  assert.equal(doc.querySelector('#aidDiscardToggle .sheetRowValue').textContent, 'Aus');
});
