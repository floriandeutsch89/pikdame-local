// Going out gets a beat: a live round end holds the final table ~1.2 s with a stamp at the
// winner's seat ("Aus!", "Hand aus!" when out in one), a tap skips; restore, reduced motion and
// a hidden tab open the sheet at once. The headline names "Hand aus" but never a doubling
// without the house rule. Also: the lucky-cut headline shrinks instead of splitting a word.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const SRC = ['i18n.js', 'client.js'].map((f) => fs.readFileSync(path.join(pub, f), 'utf8'));

/** The real client in jsdom on a virtual clock; layout is stubbed where a test needs it. */
function boot({ reduced = false, lang = '' } = {}) {
  const { window } = new JSDOM(HTML, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  const env = { hidden: false };
  let clock = 1000;
  const queue = [];
  let seq = 0;
  window.setTimeout = (fn, ms = 0, ...args) => { queue.push({ id: ++seq, at: clock + Math.max(0, Number(ms) || 0), fn, args }); return seq; };
  window.setInterval = (fn, ms = 0, ...args) => { queue.push({ id: ++seq, at: clock + Math.max(1, Number(ms) || 0), fn, args, every: Math.max(1, Number(ms) || 0) }); return seq; };
  window.clearTimeout = window.clearInterval = (id) => { const i = queue.findIndex((t) => t.id === id); if (i >= 0) queue.splice(i, 1); };
  const run = (ms) => {
    const end = clock + ms;
    for (let n = 0; n < 5000; n++) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue[0];
      if (!next || next.at > end) break;
      queue.shift();
      clock = next.at;
      if (next.every) { next.at = clock + next.every; queue.push(next); }
      try { next.fn(...next.args); } catch (e) { errors.push(e); }
    }
    clock = end;
  };
  window.performance.now = () => clock;
  let rafDepth = 0;
  window.requestAnimationFrame = (cb) => {
    if (rafDepth > 4) return 0;
    rafDepth += 1;
    try { cb(clock); } finally { rafDepth -= 1; }
    return 0;
  };
  window.matchMedia = (q) => ({ matches: reduced && /prefers-reduced-motion: reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => env.hidden });
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => (env.hidden ? 'hidden' : 'visible') });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  window.AudioContext = function AudioContext() {
    const node = () => ({ connect: (x) => x, disconnect() {}, start() {}, stop() {}, type: 'sine', frequency: { setValueAtTime() {}, linearRampToValueAtTime() {}, value: 0 }, Q: { value: 0 }, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } });
    return { createOscillator: node, createGain: node, createBiquadFilter: node, destination: node(), currentTime: 0, state: 'running', resume: () => Promise.resolve(), suspend: () => Promise.resolve() };
  };
  window.webkitAudioContext = window.AudioContext;
  const sent = [];
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) { if (typeof this['on' + t] === 'function') this['on' + t](ev); for (const f of this._ls[t] || []) f(ev); }
    send(raw) { try { sent.push(JSON.parse(raw)); } catch (e) { /* not JSON */ } }
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  window.console.error = (...a) => errors.push(a.map(String).join(' '));
  window.localStorage.setItem('pikdame_tip_seen', '9');
  window.localStorage.setItem('pikdame_splash_device', '1'); // no studio intro
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Flo');
  if (lang) window.localStorage.setItem('pikdame_lang', lang);
  for (const src of SRC) window.eval(src);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  run(0);
  ws._emit('open', {});
  const send = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  const doc = window.document;
  return {
    window, doc, errors, env, run, sent, send,
    join: () => send({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'BEAT01' }),
    state: (st) => send({ type: 'state', state: st }),
    sheetOpen: () => !doc.getElementById('resultOverlay').classList.contains('hidden'),
    stamp: () => doc.querySelector('.outBeat .outStamp'),
    close: () => window.close(),
  };
}

// --- states as p1 sees them ---------------------------------------------------------
const C = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
const PLAYERS = (hands) => [
  { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hands.p1.length, hand: hands.p1.map(C) },
  { id: 'b1', name: 'Dieter', isBot: true, connected: true, handCount: hands.b1, botDifficulty: 'medium' },
  { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: hands.b2, botDifficulty: 'medium' },
];
/** Dieter (b1) on turn, one card left. */
function playing(over = {}) {
  return {
    phase: 'playing', roundNumber: 2, turnIndexInRound: 9, currentPlayerId: 'b1', turnPhase: 'draw', dealerId: 'b2',
    drawPileCount: 40, discardTop: C('D4-0'), discardPileCount: 6, discardCards: [C('D4-0')], tableMelds: [],
    log: [], houseRules: {}, lobbyReady: [], nextRoundReady: [], totals: { p1: 120, b1: 80, b2: 60 }, scoreHistory: [],
    players: PLAYERS({ p1: ['H2-0', 'H5-0', 'C9-0'], b1: 1, b2: 7 }),
    ...over,
  };
}
/** The round end that follows: winner b1 (or p1) went out, the last card lies face down. */
function ended({ winner = 'b1', ...over } = {}) {
  const mk = (id, score) => ({ roundScore: score, breakdown: { isWinner: id === winner, multiplier: 1 } });
  return {
    ...playing(), phase: 'roundEnd', turnIndexInRound: 9, lastRoundWinnerId: winner, lastRoundWasHandAus: false,
    discardTop: { ...C('S7-1'), faceDown: true }, discardPileCount: 7, discardCards: [{ faceDown: true }, C('D4-0')],
    players: PLAYERS({ p1: winner === 'p1' ? [] : ['H2-0', 'H5-0', 'C9-0'], b1: 0, b2: 7 }),
    totals: { p1: winner === 'p1' ? 230 : 95, b1: winner === 'p1' ? 40 : 190, b2: 25 },
    lastRoundResult: { p1: mk('p1', winner === 'p1' ? 110 : -25), b1: mk('b1', winner === 'p1' ? -40 : 110), b2: mk('b2', -35) },
    lastRoundStats: [
      { id: 'p1', name: 'Flo', laidOutCount: 0, handCount: 3, laidLines: [], handLines: [{ kind: 'low', count: 3, points: 15 }] },
      { id: 'b1', name: 'Dieter', laidOutCount: 15, handCount: 0 },
      { id: 'b2', name: 'Horst', laidOutCount: 9, handCount: 7 },
    ],
    ...over,
  };
}

test('a live going out holds the final table 1.2 s with "Aus!" at the winner, then the sheet; the ready check is untouched', () => {
  const c = boot();
  try {
    c.join();
    c.state(playing());
    const mark = c.sent.length;
    c.state(ended());
    assert.ok(!c.sheetOpen(), 'the final table first');
    assert.strictEqual(c.stamp().textContent, 'Aus!');
    assert.strictEqual(c.doc.querySelector('.outBeat').getAttribute('aria-hidden'), 'true', 'the sheet says it in full right after');
    assert.ok(c.doc.getElementById('discardTopCard').classList.contains('back'), 'the last card lies face down on the pile');
    assert.ok(c.doc.querySelector('#opponents .opponent.roundWinner[data-player-id="b1"]'), 'the seat that went out is ringed');
    // A state during the beat (another seat's emote, a ready tick) keeps it.
    c.run(600);
    c.state(ended({ log: [{ text: 'x' }] }));
    assert.ok(!c.sheetOpen() && c.stamp(), 'a re-render keeps the beat');
    c.run(599);
    assert.ok(!c.sheetOpen(), 'not before 1.2 s');
    c.run(1);
    assert.ok(c.sheetOpen(), 'the sheet opens on its own');
    assert.strictEqual(c.doc.querySelector('.outBeat'), null, 'the stamp goes with it');
    assert.match(c.doc.querySelector('#resultBody .resultWinnerSub').textContent, /^gewinnt die Runde$/);
    // Client only: nothing was sent meanwhile, and "Nächste Runde" asks the server as before.
    const moves = () => c.sent.slice(mark).map((m) => m.type).filter((type) => type !== 'ping');
    assert.deepStrictEqual(moves(), []);
    c.doc.getElementById('resultContinueBtn').dispatchEvent(new c.window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(moves(), ['nextRound']);
    assert.deepStrictEqual(c.errors, []);
  } finally {
    c.close();
  }
});

test('a tap anywhere skips straight to the sheet; the layer sits above the table, not in it', () => {
  const c = boot();
  try {
    c.join();
    c.state(playing());
    c.state(ended());
    const layer = c.doc.querySelector('.outBeat');
    assert.strictEqual(layer.parentElement, c.doc.body, 'a body layer: the tap never reaches a chip or the piles');
    c.run(200);
    layer.dispatchEvent(new c.window.MouseEvent('click', { bubbles: true }));
    assert.ok(c.sheetOpen(), 'open at once');
    assert.strictEqual(c.doc.querySelector('.outBeat'), null);
    assert.strictEqual(c.doc.querySelector('.meldFilterBar'), null, 'no meld filter toggled under the tap');
    c.run(2000);
    assert.ok(c.sheetOpen(), 'and the timer does not touch it later');
    assert.deepStrictEqual(c.errors, []);
  } finally {
    c.close();
  }
});

test('out in one: "Hand aus!" stamp, the headline names it, the doubling only with the house rule', () => {
  const c = boot();
  try {
    c.join();
    c.state(playing());
    c.state(ended({ lastRoundWasHandAus: true }));
    assert.strictEqual(c.stamp().textContent, 'Hand aus!');
    c.run(1200);
    const pane = c.doc.querySelector('#resultBody .resultPane');
    assert.strictEqual(pane.querySelector('.resultWinnerName').textContent.trim().replace(/\s.*$/, ''), 'Dieter');
    assert.strictEqual(pane.querySelector('.resultWinnerSub').textContent, 'macht Hand aus – alles in einem Zug');
    assert.doesNotMatch(c.doc.getElementById('resultBody').textContent, /doppelt/, 'no doubling without the house rule');
    assert.strictEqual(pane.querySelectorAll('.handAusNote').length, 0);

    // The house rule on: the doubling under the headline, "Hand aus" still said once.
    c.state(ended({ lastRoundWasHandAus: true, houseRules: { handAusDoubles: true } }));
    const notes = [...c.doc.querySelectorAll('#resultBody .resultPane .handAusNote')];
    assert.deepStrictEqual(notes.map((n) => n.textContent), ['Hausregel: Die komplette Rundenwertung zählt doppelt.']);
    assert.strictEqual(notes[0].previousElementSibling.className, 'resultWinner', 'right under the headline');
    const said = c.doc.querySelector('#resultBody .resultPane').textContent.match(/Hand aus/g) || [];
    assert.strictEqual(said.length, 1, 'said once per screen');
    assert.deepStrictEqual(c.errors, []);
  } finally {
    c.close();
  }
});

test('my own going out: the stamp over my hand, "Du machst Hand aus"; English wording', () => {
  const de = boot();
  try {
    de.join();
    de.state(playing({ currentPlayerId: 'p1', turnPhase: 'meld', players: PLAYERS({ p1: ['H2-0'], b1: 4, b2: 7 }) }));
    de.state(ended({ winner: 'p1', lastRoundWasHandAus: true }));
    assert.strictEqual(de.stamp().textContent, 'Hand aus!');
    de.run(1200);
    assert.strictEqual(de.doc.querySelector('#resultBody .resultWinnerSub').textContent, 'Du machst Hand aus – alles in einem Zug');
    assert.deepStrictEqual(de.errors, []);
  } finally {
    de.close();
  }
  const en = boot({ lang: 'en' });
  try {
    en.join();
    en.state(playing());
    en.state(ended());
    assert.strictEqual(en.stamp().textContent, 'Out!');
    en.state(playing({ roundNumber: 3 }));
    assert.strictEqual(en.doc.querySelector('.outBeat'), null, 'a new round ends the beat');
    assert.ok(!en.sheetOpen(), 'without opening the old sheet');
    en.state(ended({ roundNumber: 3, lastRoundWasHandAus: true }));
    assert.strictEqual(en.stamp().textContent, 'Out in one!');
    en.run(1200);
    assert.strictEqual(en.doc.querySelector('#resultBody .resultWinnerSub').textContent, 'goes out in one – all in a single turn');
    assert.doesNotMatch(en.doc.getElementById('resultBody').textContent, /double/i);
    assert.deepStrictEqual(en.errors, []);
  } finally {
    en.close();
  }
});

test('the stamp sits on the lower edge of the winner\'s chip (name readable), over my hand, and on screen', () => {
  const c = boot();
  try {
    const rects = {
      b1: { left: 140, top: 60, width: 120, height: 66 },
      b2: { left: 0, top: 60, width: 120, height: 66 },
      hand: { left: 0, top: 700, width: 393, height: 150 },
    };
    const rect = (r) => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
    const real = c.window.Element.prototype.getBoundingClientRect;
    c.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.id === 'handWrapper') return rect(rects.hand);
      if (this.classList.contains('opponent') && rects[this.dataset.playerId]) return rect(rects[this.dataset.playerId]);
      return real.call(this);
    };
    let stampW = 110;
    Object.defineProperty(c.window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.classList.contains('outStamp') ? stampW : 0; } });
    Object.defineProperty(c.window.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('outStamp') ? 46 : 0; } });
    Object.defineProperty(c.window, 'innerWidth', { configurable: true, value: 393 });
    Object.defineProperty(c.window, 'innerHeight', { configurable: true, value: 852 });
    const at = () => [c.stamp().style.left, c.stamp().style.top];
    c.join();
    c.state(playing());
    c.state(ended());
    assert.deepStrictEqual(at(), ['145px', '103px'], 'centred on the chip, its middle on the chip\'s bottom edge');
    c.run(1200);
    // My going out: the middle of my (now empty) hand.
    c.state(playing({ roundNumber: 3 }));
    c.state(ended({ roundNumber: 3, winner: 'p1' }));
    assert.deepStrictEqual(at(), ['142px', '752px']);
    c.run(1200);
    // A wide stamp at the left chip stays 12 px inside the screen.
    stampW = 220;
    c.state(playing({ roundNumber: 4 }));
    c.state(ended({ roundNumber: 4, winner: 'b2' }));
    assert.deepStrictEqual(at(), ['12px', '103px']);
    assert.deepStrictEqual(c.errors, []);
  } finally {
    c.close();
  }
});

test('no beat: a reload or rejoin into an ended round, reduced motion, a hidden tab, no one out, a forfeit', () => {
  const noBeat = (c, label) => {
    assert.ok(c.sheetOpen(), `${label}: the sheet at once`);
    assert.strictEqual(c.doc.querySelector('.outBeat'), null, `${label}: no stamp`);
  };
  let c = boot();
  try {
    c.join();
    c.state(ended()); // a reload straight into the round end
    noBeat(c, 'reload');
    c.state(playing({ roundNumber: 3 }));
    c.join(); // the socket came back: the round ended meanwhile
    c.state(ended({ roundNumber: 3 }));
    noBeat(c, 'rejoin');
    // Stalemate (empty stock): nobody went out, the top card lies open.
    c.state(playing({ roundNumber: 4 }));
    c.state(ended({ roundNumber: 4, winner: null, lastRoundWinnerId: null, discardTop: C('D4-0') }));
    noBeat(c, 'stalemate');
    // The game given up by vote.
    c.state(playing({ roundNumber: 5 }));
    c.state(ended({ roundNumber: 5, phase: 'gameOver', winner: null, lastRoundWinnerId: null, gameOverInfo: { forfeited: true, winnerId: null, finalTotals: {} } }));
    noBeat(c, 'forfeit');
    // In the background: nobody would see the beat.
    c.env.hidden = true;
    c.state(playing({ roundNumber: 6 }));
    c.state(ended({ roundNumber: 6 }));
    noBeat(c, 'hidden tab');
    assert.deepStrictEqual(c.errors, []);
  } finally {
    c.close();
  }
  c = boot({ reduced: true });
  try {
    c.join();
    c.state(playing());
    c.state(ended());
    noBeat(c, 'reduced motion');
    assert.deepStrictEqual(c.errors, []);
  } finally {
    c.close();
  }
});

test('a tab hidden during the beat opens the sheet at once; the last going out of a match gets the beat too', () => {
  const c = boot();
  try {
    c.join();
    c.state(playing());
    c.state(ended());
    assert.ok(c.stamp());
    c.env.hidden = true;
    c.doc.dispatchEvent(new c.window.Event('visibilitychange'));
    assert.ok(c.sheetOpen(), 'waiting there on return');
    assert.strictEqual(c.doc.querySelector('.outBeat'), null);
    c.env.hidden = false;
    c.state(playing({ roundNumber: 3, totals: { p1: 900, b1: 980, b2: 400 } }));
    c.state(ended({ roundNumber: 3, phase: 'gameOver', totals: { p1: 875, b1: 1090, b2: 365 },
      gameOverInfo: { winnerId: 'b1', finalTotals: {}, totalTurns: 120, totalRounds: 3, highlights: [] } }));
    assert.ok(!c.sheetOpen() && c.stamp(), 'game over: the final table first');
    c.run(1200);
    assert.ok(c.sheetOpen());
    assert.strictEqual(c.doc.getElementById('resultTitle').textContent, 'Spielende!');
    assert.deepStrictEqual(c.errors, []);
  } finally {
    c.close();
  }
});

test('what shows outside the sheet waits for it: XP and goal toasts, the level-up and unlock cards come after the beat', () => {
  const c = boot();
  try {
    const toast = () => (c.doc.getElementById('toastContainer').classList.contains('visible') ? c.doc.getElementById('toastContainer').textContent : '');
    c.join();
    c.state(playing({ roundNumber: 3, totals: { p1: 900, b1: 980, b2: 400 } }));
    c.state(ended({ roundNumber: 3, phase: 'gameOver', winner: 'p1', totals: { p1: 1110, b1: 940, b2: 365 },
      gameOverInfo: { winnerId: 'p1', finalTotals: {}, totalTurns: 120, totalRounds: 3, highlights: [] } }));
    assert.ok(c.stamp(), 'the beat holds');
    c.send({ type: 'progress', xp: 5440, gainedXp: 5000, level: { level: 14 }, record: { played: 44, won: 18 },
      quests: { date: '2026-10-28', ids: ['finish_game'], progress: {}, completed: ['finish_game'] } });
    c.send({ type: 'badgeUnlocks', name: 'Flo', badges: [{ id: 'wins_10', earnedAt: 1000 }] });
    c.run(1000);
    assert.strictEqual(toast(), '', 'no toast over the final table');
    assert.ok(c.doc.getElementById('levelUpOverlay').classList.contains('hidden'), 'no level-up over the final table');
    assert.strictEqual(c.doc.querySelector('#unlockLayer .unlockCard'), null, 'no unlock card over the final table');
    c.run(200);
    assert.ok(c.sheetOpen(), 'the sheet first');
    assert.match(c.doc.getElementById('resultMe').textContent, /\+5\.000/, 'its own line has the XP: the progress landed on the open sheet');
    assert.match(toast(), /Tagesziel erreicht/, 'the goal toast over the open sheet, as before');
    assert.ok(c.doc.querySelector('#unlockLayer .unlockCard'), 'the unlock card over the open sheet');
    assert.ok(c.doc.getElementById('levelUpOverlay').classList.contains('hidden'), 'the level-up a moment after the sheet ...');
    c.run(1200);
    assert.ok(!c.doc.getElementById('levelUpOverlay').classList.contains('hidden'), '... as before');
    assert.deepStrictEqual(c.errors, []);
  } finally {
    c.close();
  }
});

test('lucky cut headline: a word never splits - one line shrunk a little, else words wrap and a long one shrinks', () => {
  const c = boot();
  try {
    // Layout stub for the panel title: the box, its width on one line, its widest word.
    const layout = { box: 294, line: 310, word: 200 };
    const isTitle = (n) => n.classList && n.classList.contains('rwTitle');
    Object.defineProperty(c.window.Element.prototype, 'clientWidth', { configurable: true, get() { return isTitle(this) ? layout.box : 0; } });
    Object.defineProperty(c.window.Element.prototype, 'scrollWidth', { configurable: true, get() { return isTitle(this) ? (this.classList.contains('oneLine') ? layout.line : layout.word) : 0; } });
    c.join();
    let round = 1;
    const cut = () => {
      round += 1;
      c.state(playing({ roundNumber: round, lastCutReveal: { round, cutterId: 'b2', luckyCount: 1, cards: [{ ...C(`SQ-${round}`) }] } }));
      const t = c.doc.querySelector('.raidWarning.lucky .rwTitle');
      return { title: t.textContent, oneLine: t.classList.contains('oneLine'), fit: t.style.getPropertyValue('--fit') };
    };
    assert.deepStrictEqual(cut(), { title: '🍀 GLÜCKSGRIFF! 🍀', oneLine: true, fit: '0.920' }, '310 px in 294: one line, 3 % to spare');
    layout.line = 280;
    assert.deepStrictEqual(cut().fit, '', 'fits as it is');
    layout.line = 450;
    assert.deepStrictEqual(cut(), { title: '🍀 GLÜCKSGRIFF! 🍀', oneLine: false, fit: '' }, 'far too long for one line: words wrap, none is too wide');
    layout.word = 320;
    assert.deepStrictEqual(cut(), { title: '🍀 GLÜCKSGRIFF! 🍀', oneLine: false, fit: '0.891' }, 'a word wider than the box shrinks');
    assert.deepStrictEqual(c.errors, []);
  } finally {
    c.close();
  }
});

// --- CSS contract ------------------------------------------------------------------------
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel) => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
  assert.ok(m, `rule ${sel}`);
  return m[1];
};

test('CSS contract: the stamp is Rubik from the type scale on its own layer; the lucky title never breaks a word', () => {
  const stamp = rule('.outStamp');
  assert.match(stamp, /font-family: var\(--font-display\)/);
  assert.match(stamp, /font-size: var\(--fs-display\)/);
  assert.match(stamp, /text-transform: uppercase/);
  assert.match(rule('.outBeat'), /position: fixed; inset: 0; z-index: var\(--z-overlay-ui\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.outStamp \{ animation: none; \}/);
  // left:50% gave the fixed panel only half the screen to shrink-fit in: "GLÜCKSGR|IFF!".
  assert.match(rule('.raidWarning'), /width: max-content;\s*max-width: min\(86vw, 400px\)/);
  const title = rule('.raidWarning .rwTitle');
  assert.doesNotMatch(title, /overflow-wrap|word-break/, 'no break inside a word');
  assert.match(title, /font-size: calc\(clamp\(var\(--fs-title\), 6\.5vw, calc\(var\(--fs-title\) \* 1\.55\)\) \* var\(--fit, 1\)\)/);
  assert.match(rule('.raidWarning .rwTitle.oneLine'), /white-space: nowrap/);
});
