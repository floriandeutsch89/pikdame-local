// Game over leads with my own result (one-line winner, gold banner for my win,
// pinned result strip); the statistics sheet says every number once.
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
    send(m) { (window.__sent = window.__sent || []).push(JSON.parse(m)); } close() {}
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


const mk = (score, win) => ({ roundScore: score, breakdown: { isWinner: !!win, multiplier: 1 } });
function gameOverState(winnerId, extra = {}) {
  const totals = winnerId === 'p1' ? { p1: 1045, b1: 880, b2: 610, b3: 320 } : { p1: 880, b1: 1045, b2: 610, b3: 320 };
  return {
    phase: 'gameOver', roundNumber: 6, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1',
    discardTop: null, drawPileCount: 30, discardPileCount: 3, log: [], tableMelds: [], lobbyReady: [],
    nextRoundReady: [], houseRules: {}, totals, lastRoundWinnerId: winnerId,
    lastRoundResult: { p1: mk(180, winnerId === 'p1'), b1: mk(225, winnerId === 'b1'), b2: mk(110), b3: mk(60) },
    lastRoundStats: [],
    scoreHistory: [{ round: 1, totals: { p1: 100, b1: 80, b2: 0, b3: 40 } }, { round: 2, totals }],
    gameOverInfo: { winnerId, totalTurns: 90, totalRounds: 2, highlights: [], funTitle: null },
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 0, hand: [] },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 0, botDifficulty: 'zen' },
      { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 4, botDifficulty: 'zen' },
      { id: 'b3', name: 'Maria', isBot: true, connected: true, handCount: 6, botDifficulty: 'zen' },
    ],
    ...extra,
  };
}
async function atGameOver(state, { me = 'p1', progress = true } = {}) {
  const app = boot({ pikdame_player_name: 'Flo' });
  await new Promise((r) => setTimeout(r, 10));
  const emit = (m) => app.ws()._emit('message', { data: JSON.stringify(m) });
  emit({ type: 'joined', playerId: me, playerToken: 't', sessionCode: 'ABCD' });
  emit({ type: 'state', state });
  if (progress) emit({ type: 'progress', gainedXp: 120, xp: 5440, level: { level: 14 }, record: { played: 43, won: 17 } });
  return { ...app, emit, doc: app.window.document };
}
const text = (node) => node.textContent.replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
// Visual reading of a flex row: its children with a space between.
const parts = (node) => [...node.children].map(text).filter(Boolean).join(' ');

test('game over, someone else wins: one-line winner without score, my strip above the rematch', async (t) => {
  const { window, errors, doc } = await atGameOver(gameOverState('b1'));
  t.after(() => window.close());
  const head = doc.querySelector('#resultBody .resultWinnerGame');
  assert.ok(!head.classList.contains('isMe'));
  assert.match(text(head), /^Klaus.*gewinnt die Partie$/);
  assert.equal(head.querySelector('.resultWinnerScore'), null, 'no score in the headline');
  assert.equal(doc.querySelector('#resultBody .resultMine'), null, 'the old body line is gone');
  const strip = doc.getElementById('resultMe');
  assert.ok(!strip.classList.contains('hidden'));
  assert.ok(strip.closest('.resultFooter'), 'pinned in the footer');
  assert.ok(strip.compareDocumentPosition(doc.getElementById('resultContinueBtn')) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'above the rematch');
  assert.equal(parts(strip.querySelector('.rmTop')), 'Platz 2 von 4 · 165 hinter Klaus +120 EP');
  // 5440 XP = level 14 with 240 of 750; the game brought 120 of them.
  assert.equal(parts(strip.querySelector('.rmLevel')), 'Stufe 14 noch 510 EP');
  assert.equal(strip.querySelector('.rmOld').style.width, '16%');
  assert.equal(strip.querySelector('.rmGain').style.width, '16%');
  assert.deepEqual([...strip.querySelectorAll('.rmChip')].map(text), ['Bilanz 17/43']);
  assert.ok(doc.getElementById('resultOverlay').classList.contains('isFinal'));
  assert.deepEqual(errors, []);
});

test('game over, I win: gold banner without my name, strip says the lead, my badge as a chip', async (t) => {
  const { window, errors, doc, emit } = await atGameOver(gameOverState('p1'));
  t.after(() => window.close());
  emit({ type: 'badges', earned: [{ name: 'Flo', badges: ['score_500'] }] });
  const head = doc.querySelector('#resultBody .resultWinnerGame');
  assert.ok(head.classList.contains('isMe'));
  assert.equal(text(head), 'Du gewinnst die Partie!');
  const strip = doc.getElementById('resultMe');
  assert.match(parts(strip.querySelector('.rmTop')), /^Platz 1 von 4 · 165 vor Klaus/);
  const chips = [...strip.querySelectorAll('.rmChip')];
  assert.equal(text(chips[0].lastElementChild), 'Neu: Punktekönig');
  assert.equal(chips[0].querySelector('.rmChipEmoji').getAttribute('aria-hidden'), 'true');
  assert.ok(chips[0].classList.contains('isNew'));
  assert.equal(doc.querySelector('#resultBody .badgeBox'), null, 'my own badge is not repeated in the body');
  // A table mate's badge still gets the box.
  emit({ type: 'badges', earned: [{ name: 'Flo', badges: ['score_500'] }, { name: 'Gerda', badges: ['first_win'] }] });
  const box = doc.querySelector('#resultBody .badgeBox');
  assert.ok(box);
  assert.doesNotMatch(box.textContent, /Flo/);
  assert.deepEqual(errors, []);
});

test('game over extras: challenge rank, streak and season place as chips; tie reads "gleichauf"', async (t) => {
  const st = gameOverState('b1', { challengeDate: '2026-10-19', totals: { p1: 1045, b1: 1045, b2: 610, b3: 320 } });
  const { window, errors, doc, emit } = await atGameOver(st, { progress: false });
  t.after(() => window.close());
  emit({ type: 'progress', gainedXp: 60, welcomeBack: true, xp: 300, level: { level: 3 }, record: { played: 4, won: 1 },
    streak: { event: 'extended', streak: 6 } });
  emit({ type: 'challengeBoard', date: '2026-10-19', yourScore: 1045, yourRank: 2, players: 9, board: [], history: [], weekly: null });
  emit({ type: 'accountProgress', progress: { xp: 300, seasonXp: 90, season: '2026-10', games: 4, wins: 1, rank: 7 } });
  const strip = doc.getElementById('resultMe');
  assert.match(parts(strip.querySelector('.rmTop')), /^Platz 1 von 4 · gleichauf mit Klaus \+60 EP \(×2\)$/);
  assert.deepEqual([...strip.querySelectorAll('.rmChip')].map(text),
    ['Tages-Challenge: Platz 2', '6 Tage in Folge', 'Saison: Platz 7', 'Bilanz 1/4']);
  assert.ok(strip.querySelector('.rmChip .icon use'), 'sprite icons, not emoji');
  assert.equal(doc.getElementById('resultContinueBtn').textContent, 'Zum Hauptmenü');
  assert.deepEqual(errors, []);
});

test('game over without a strip: spectator, bot tower, round end; no account = no XP line', async (t) => {
  const spect = await atGameOver(gameOverState('b1'), { me: 'x9' });
  t.after(() => spect.window.close());
  assert.ok(spect.doc.getElementById('resultMe').classList.contains('hidden'), 'not seated: nothing of mine');

  const tower = await atGameOver(gameOverState('p1', { towerStage: 6 }));
  t.after(() => tower.window.close());
  assert.ok(tower.doc.getElementById('resultMe').classList.contains('hidden'), 'the tower verdict carries the result');
  assert.equal(text(tower.doc.querySelector('#resultBody .resultWinnerGame')), 'Du schaffst die Etage!');

  const pub = await atGameOver(gameOverState('b1'), { progress: false });
  t.after(() => pub.window.close());
  const strip = pub.doc.getElementById('resultMe');
  assert.equal(parts(strip.querySelector('.rmTop')), 'Platz 2 von 4 · 165 hinter Klaus', 'no progress message: place and gap only');
  assert.equal(strip.querySelector('.rmChips'), null);
  assert.equal(strip.querySelector('.rmLevel'), null);

  // The next round end hides the strip again.
  const st = gameOverState('b1');
  pub.emit({ type: 'state', state: { ...st, phase: 'roundEnd', gameOverInfo: null } });
  assert.ok(strip.classList.contains('hidden'));
  assert.ok(!pub.doc.getElementById('resultOverlay').classList.contains('isFinal'));
  assert.deepEqual([...spect.errors, ...tower.errors, ...pub.errors], []);
});

test('game over in English: the strip speaks English', async (t) => {
  const app = boot({ pikdame_player_name: 'Flo', pikdame_lang: 'en' });
  t.after(() => app.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const emit = (m) => app.ws()._emit('message', { data: JSON.stringify(m) });
  emit({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' });
  emit({ type: 'state', state: gameOverState('b1') });
  emit({ type: 'progress', gainedXp: 1200, xp: 5440, level: { level: 14 }, record: { played: 43, won: 17 } });
  const strip = app.window.document.getElementById('resultMe');
  assert.equal(parts(strip.querySelector('.rmTop')), 'Place 2 of 4 · 165 behind Klaus +1,200 XP');
  assert.match(text(strip), /Record 17\/43/);
  assert.match(text(app.window.document.querySelector('#resultBody .resultWinnerGame')), /^Klaus.*wins the match$/);
  assert.deepEqual(app.errors, []);
});

const PROFILE = { name: 'Flo', gamesPlayed: 43, gamesWon: 17, totalScore: 31000, bestGameScore: 1385, xp: 5320, badges: {} };
async function openStats(players, games) {
  const app = boot({ pikdame_player_name: 'Flo' });
  await new Promise((r) => setTimeout(r, 10));
  const emit = (m) => app.ws()._emit('message', { data: JSON.stringify(m) });
  emit({ type: 'profiles', publicMode: false, globalStats: null, players, quests: { date: '2026-10-19', ids: ['finish_game'] } });
  const doc = app.window.document;
  doc.getElementById('statsBtn').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  emit({ type: 'gameHistory', games });
  return { ...app, doc, emit };
}

test('statistics: level as a link, three tiles once, recent games as S/N boxes, my row by its edge', async (t) => {
  const games = [[true, 1040], [false, 880], [true, 1120], [false, -45]].map(([won, myScore], i) => ({ id: `g${i}`, won, myScore, players: [] }));
  const { window, errors, doc } = await openStats([PROFILE, { name: 'Oma Gerda', gamesPlayed: 120, gamesWon: 61, xp: 18000 }], games);
  t.after(() => window.close());
  const box = doc.getElementById('statsMeBox');
  assert.ok(!box.classList.contains('hidden'));
  const link = box.querySelector('.meLevelLink');
  assert.equal(text(link), 'Rommé-Fuchs · Stufe 14');
  assert.equal(box.querySelector('.kpiLink'), null, 'no ringed level tile');
  assert.deepEqual([...box.querySelectorAll('.kpiTile')].map(parts), ['43 Partien', '17 Siege · 40 %', '1.385 Bestwert']);
  const boxes = [...box.querySelectorAll('.meFormRow .formBox')];
  assert.deepEqual(boxes.map((b) => b.querySelector('b').textContent), ['S', 'N', 'S', 'N'], 'newest first, letter carries win/loss');
  assert.deepEqual(boxes.map((b) => b.querySelector('small').textContent), ['1040', '880', '1120', '-45']);
  assert.ok(boxes[0].classList.contains('won') && boxes[1].classList.contains('lost'));
  assert.match(boxes[1].textContent, /Niederlage/, 'screen readers hear the word');
  assert.equal(box.querySelector('svg.meSpark, .meSpark'), null, 'the two-point line chart is gone');
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(!doc.getElementById('progressOverlay').classList.contains('hidden'), 'link opens the progress sheet');
  const mine = doc.querySelector('#statsContent .boardRow.isMe');
  assert.match(mine.textContent, /Flo/);
  assert.deepEqual(errors, []);
});

test('statistics, new name: empty state explains and starts a bot game', async (t) => {
  const { window, errors, doc } = await openStats([{ name: 'Oma Gerda', gamesPlayed: 120, gamesWon: 61, xp: 18000 }], []);
  t.after(() => window.close());
  const box = doc.getElementById('statsMeBox');
  assert.ok(!box.classList.contains('hidden'));
  assert.match(text(box.querySelector('.meEmpty')), /Deine Zahlen starten mit der ersten Partie/);
  const btn = box.querySelector('[data-start="bots"]');
  assert.equal(text(btn), 'Gegen Bots spielen');
  window.__sent = [];
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.getElementById('statsOverlay').classList.contains('hidden'), 'the sheet closes');
  assert.ok(window.__sent.some((m) => m.type === 'createSession'), 'a new game is created (then started with bots)');
  assert.deepEqual(errors, []);
});
