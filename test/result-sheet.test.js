// Round-end sheet (v2.37.0): the scores must be scannable on a phone.
//   - rows are best-first (by the round's delta) and one line each,
//   - only MY row has a breakdown and it starts folded (the summary shows
//     the two sums),
//   - the 15-emote bar is behind a button instead of taking three rows.
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


function roundEndState() {
  const mk = (id, name, score, extra = {}) => ({ roundScore: score, breakdown: { isWinner: !!extra.win, multiplier: 1 } });
  return {
    phase: 'roundEnd', roundNumber: 1, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1',
    discardTop: null, drawPileCount: 30, discardPileCount: 3, log: [], tableMelds: [], lobbyReady: [],
    nextRoundReady: [], houseRules: {}, totals: { p1: -45, b1: 270, b2: 110, b3: -35 },
    lastRoundWinnerId: 'b1',
    lastRoundResult: { p1: mk('p1', 'Flo', -45), b1: mk('b1', 'Klaus', 270, { win: true }), b2: mk('b2', 'Horst', 110), b3: mk('b3', 'Maria', -35) },
    lastRoundStats: [
      { id: 'p1', name: 'Flo', laidOutCount: 3, handCount: 9, laidLines: [{ kind: 'low', count: 3, points: 15 }], handLines: [{ kind: 'low', count: 9, points: 45 }] },
      { id: 'b1', name: 'Klaus', laidOutCount: 15, handCount: 0 },
    ],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 9, hand: [] },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 0, botDifficulty: 'zen' },
      { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 4, botDifficulty: 'zen' },
      { id: 'b3', name: 'Maria', isBot: true, connected: true, handCount: 6, botDifficulty: 'zen' },
    ],
  };
}

test('result sheet: best-first one-line rows, folded own breakdown, emotes behind a button', async (t) => {
  const { window, errors, ws } = boot();
  t.after(() => window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ws();
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  sock._emit('message', { data: JSON.stringify({ type: 'state', state: roundEndState() }) });
  const doc = window.document;

  const names = [...doc.querySelectorAll('#resultBody .resultRow .resultName')].map((n) => n.textContent.trim());
  assert.deepEqual(names.map((n) => n.replace(/\s.*$/, '')), ['Klaus', 'Horst', 'Maria', 'Flo'], 'sorted by round delta, best first');
  assert.equal(doc.querySelectorAll('#resultBody .resultRowFoot').length, 0, 'no second text line per row any more');
  assert.ok(doc.querySelector('#resultBody .resultRow .resultTotal'), 'running total sits on the same line');

  const details = doc.querySelectorAll('#resultBody details.resultBreakdown');
  assert.equal(details.length, 1, 'breakdown only for my own row');
  assert.equal(details[0].open, false, 'folded by default');
  assert.match(details[0].querySelector('summary').textContent, /\+15.*[−-]45/, 'summary carries both sums');

  const bar = doc.getElementById('resultEmoteBar');
  const toggle = doc.getElementById('resultEmoteToggle');
  assert.ok(bar.classList.contains('hidden'), 'emote bar starts collapsed');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(!bar.classList.contains('hidden'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(bar.classList.contains('hidden'));
  assert.deepEqual(errors, [], `Client-Fehler: ${errors.join(' | ')}`);
});

test('game over sheet: ranking leads, home next to rematch, personal line, chart on the result pane', async (t) => {
  const { window, errors, ws } = boot();
  t.after(() => window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = ws();
  const st = roundEndState();
  Object.assign(st, {
    phase: 'gameOver',
    totals: { p1: 880, b1: 1045, b2: 610, b3: 320 },
    scoreHistory: [{ round: 1, totals: { p1: 100, b1: 80, b2: 0, b3: 40 } }, { round: 2, totals: st.totals }],
    gameOverInfo: { winnerId: 'b1', totalTurns: 90, totalRounds: 2, highlights: [], funTitle: { type: 'queenMagnet', name: 'Horst', count: 2 } },
  });
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  sock._emit('message', { data: JSON.stringify({ type: 'state', state: st }) });
  sock._emit('message', { data: JSON.stringify({ type: 'progress', gainedXp: 120, xp: 500, level: { level: 4 }, record: { played: 43, won: 17 } }) });
  const doc = window.document;

  const ranks = [...doc.querySelectorAll('#resultBody .resultRank')].map((n) => n.textContent);
  assert.deepEqual(ranks, ['1.', '2.', '3.', '4.'], 'ranked by total');
  assert.equal(doc.querySelector('#resultBody .resultTotalBig').textContent, '1045', 'total leads at game over');
  assert.equal(doc.querySelectorAll('#resultBody details.resultBreakdown').length, 0, 'no last-round breakdown at game over');
  assert.match(doc.querySelector('#resultBody .resultMine').textContent, /Platz 2 von 4.*\+120.*17\/43/);
  const panes = doc.querySelectorAll('#resultBody .resultPane');
  assert.ok(panes[0].querySelector('.scoreChart'), 'chart sits on the result pane');
  assert.ok(doc.querySelector('#resultBody .matchFacts'), 'facts as chips');
  assert.equal(doc.getElementById('resultMore').open, false, '"Mehr" stays folded');
  assert.ok(!doc.getElementById('resultHomeQuickBtn').classList.contains('hidden'), 'home button next to rematch');
  assert.ok(doc.getElementById('resultHomeBtn').classList.contains('hidden'), 'no duplicate in "Mehr"');
  assert.deepEqual(errors, [], `Client-Fehler: ${errors.join(' | ')}`);
});
