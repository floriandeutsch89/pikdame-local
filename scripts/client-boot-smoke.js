/** Boots the REAL client (index.html + i18n.js + client.js) inside jsdom,
 *  feeds it a lobby state and a playing state, and fails loudly on ANY
 *  uncaught error - the exact class of bug that bricks the PWA at
 *  "Connecting...". Run: node scripts/client-boot-smoke.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const errors = [];

const dom = new JSDOM(html, {
  url: 'https://play.example/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
window.navigator.vibrate = () => true;
window.scrollTo = () => {};
window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-smoke' }), text: () => Promise.resolve('') });
window.AudioContext = function () { return { createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: { setValueAtTime() {} } }), createGain: () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }), destination: {}, currentTime: 0, resume: () => Promise.resolve() }; };
window.webkitAudioContext = window.AudioContext;

let wsInstance = null;
window.WebSocket = class {
  constructor() {
    this._ls = {};
    wsInstance = this;
    this.readyState = 1;
    setTimeout(() => this._emit('open', {}), 0);
  }
  addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
  removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
  _emit(t, ev) {
    if (typeof this['on' + t] === 'function') this['on' + t](ev);
    for (const f of this._ls[t] || []) f(ev);
  }
  send() {}
  close() {}
};
window.onerror = (msg) => { errors.push(String(msg)); };
window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));

for (const src of ['i18n.js', 'client.js']) {
  const code = fs.readFileSync(path.join(pub, src), 'utf8');
  try {
    window.eval(code);
  } catch (e) {
    console.error(`FATAL while evaluating ${src}:`, e.message);
    process.exit(1);
  }
}
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

function feed(state) {
  wsInstance._emit('message', { data: JSON.stringify({ type: 'state', state }) });
}

setTimeout(() => {
  try {
    const base = {
      phase: 'lobby', players: [
        { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 0 },
        { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 0, botDifficulty: 'zen' },
      ],
      lobbyReady: [], log: [], tableMelds: [], discardCount: 0, drawCount: 0,
      roundNumber: 0, totals: { p1: 0, b1: 0 }, houseRules: {}, nextRoundReady: [],
    };
    wsInstance._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
    feed(base);
    feed({
      ...base, phase: 'playing', currentPlayerId: 'p1', turnPhase: 'draw', roundNumber: 1,
      dealerId: 'b1', turnDeadline: null, discardTop: null, drawCount: 60, discardCount: 1,
      hand: [
        { id: 'c1', suit: 'H', rank: '7' }, { id: 'c2', suit: 'S', rank: '9' },
        { id: 'c3', suit: 'C', rank: 'K' },
      ],
      players: base.players.map((p) => ({ ...p, handCount: 15 })),
    });
    setTimeout(() => {
      if (errors.length) {
        console.error('CLIENT BOOT SMOKE: FAILED');
        for (const e of errors) console.error('  -', e);
        process.exit(1);
      }
      console.log('CLIENT BOOT SMOKE: OK (lobby + playing state rendered without errors)');
      process.exit(0);
    }, 120);
  } catch (e) {
    console.error('CLIENT BOOT SMOKE: THREW:', e.stack || e.message);
    process.exit(1);
  }
}, 30);
