/** Bot tower, client side: the entry on the progress sheet, the stage sheet
 *  (top of the tower first, locks, the next stage), starting a stage through
 *  the one-game guard, the verdict on the result sheet and the way back via
 *  the reload intent. Boots the REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const GameManager = require('../game/GameManager');
const BotTower = require('../game/BotTower');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot({ storage = {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  // jsdom cannot navigate: leaving via location.href is asserted through storage instead.
  virtualConsole.on('jsdomError', (e) => { if (!/navigation/.test(String(e.message))) errors.push(e); });
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  const scrolled = [];
  window.Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
    fire(type, payload) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners[type] || []) fn(payload === undefined ? {} : { data: JSON.stringify(payload) });
    }
  }
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  window.WebSocket = FakeSocket;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Ben');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const ws = sockets[sockets.length - 1];
  const doc = window.document;
  const sent = (type) => ws.sent.filter((m) => m.type === type);
  const shown = (id) => !doc.getElementById(id).classList.contains('hidden');
  return { window, doc, ws, sent, shown, errors, scrolled };
}

const PROFILE = { name: 'Ben', gamesPlayed: 3, gamesWon: 1, towerStars: 4, towerCleared: 2, tower: { 1: 3, 2: 1 } };
const towerInfo = (over = {}) => ({
  type: 'towerInfo', stages: BotTower.publicStages(), clearMargin: BotTower.CLEAR_MARGIN,
  best: { 1: 3, 2: 1 }, stars: 4, cleared: 2, unlocked: 3, ...over,
});

/** Start screen with a profile, today's quests and the tower data. */
function startScreen(storage) {
  const t = boot({ storage });
  t.ws.fire('open');
  t.ws.fire('message', { type: 'profiles', players: [PROFILE], publicMode: false, quests: { date: '2026-10-17', ids: ['finish_game'] } });
  return t;
}

test('progress sheet: the tower entry leads to the stage sheet, top of the tower first', () => {
  const t = startScreen();
  const ask = t.sent('getTower');
  assert.strictEqual(ask.length, 1, 'asked once, with the profiles');
  assert.strictEqual(ask[0].name, 'Ben');
  t.ws.fire('message', towerInfo());

  t.doc.getElementById('identityAvatarBtn').click();
  assert.ok(t.shown('progressOverlay'));
  const entry = t.doc.querySelector('#progressContent .pgTower');
  assert.ok(entry, 'tower entry on the progress sheet');
  assert.match(entry.textContent, /4\/30 Sterne/);
  assert.match(entry.textContent, /2 von 10 Stufen geschafft/);
  entry.click();
  assert.ok(t.shown('towerOverlay'));
  assert.ok(!t.shown('progressOverlay'), 'one sheet at a time');

  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, '4/30 Sterne · 2 von 10 Stufen geschafft');
  const rows = [...t.doc.querySelectorAll('#towerList .twStage')];
  assert.deepStrictEqual(rows.map((r) => Number(r.dataset.stage)), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const row = (n) => rows.find((r) => Number(r.dataset.stage) === n);
  assert.strictEqual(row(1).querySelectorAll('.twStars .icon.on').length, 3);
  assert.strictEqual(row(2).querySelectorAll('.twStars .icon.on').length, 1);
  assert.ok(row(3).classList.contains('next'), 'the stage to climb stands out');
  assert.strictEqual(t.doc.querySelectorAll('#towerList .twStage.next').length, 1);
  for (const n of [4, 5, 10]) {
    assert.ok(row(n).classList.contains('locked'), `stage ${n} locked`);
    assert.strictEqual(row(n).getAttribute('aria-disabled'), 'true');
  }
  assert.strictEqual(row(2).getAttribute('aria-label'), 'Stufe 2: gegen Leicht, Mittel - 1 von 3 Sternen');
  assert.match(row(10).getAttribute('aria-label'), /^Stufe 10: gegen Zen, Zen, Zen, die Bots bekommen 100 Punkte Vorgabe - gesperrt$/);
  assert.strictEqual(row(10).querySelector('.twHandicap').textContent, 'Bots +100');
  assert.ok(row(10).querySelectorAll('.twBots .lvlIcon').length === 3, 'one level icon per bot');
  assert.match(t.doc.getElementById('towerRules').textContent, /mindestens 100 Punkte vorn/);
  assert.match(t.doc.getElementById('towerRules').textContent, /erste Stern jeder Stufe bringt einmal 25 EP/);
  assert.ok(t.scrolled.includes(row(3)), 'the next stage scrolled into view');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a tap starts the stage, a locked one only explains', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo());
  t.doc.getElementById('identityAvatarBtn').click();
  t.doc.querySelector('#progressContent .pgTower').click();
  t.doc.querySelector('#towerList .twStage[data-stage="7"]').click();
  assert.strictEqual(t.sent('startTower').length, 0, 'locked');
  assert.match(t.doc.getElementById('toastContainer').textContent, /schaff erst Stufe 3/);
  t.doc.querySelector('#towerList .twStage[data-stage="2"]').click();
  const start = t.sent('startTower');
  assert.strictEqual(start.length, 1);
  assert.deepStrictEqual({ stage: start[0].stage, name: start[0].name }, { stage: 2, name: 'Ben' });
  assert.ok(!t.shown('towerOverlay'));
  t.window.close();
});

test('the language switch redraws the tower sheet', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo());
  t.doc.getElementById('identityAvatarBtn').click();
  t.doc.querySelector('#progressContent .pgTower').click();
  t.doc.getElementById('langBtn').click();
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, '4/30 stars · 2 of 10 stages cleared');
  assert.match(t.doc.getElementById('towerRules').textContent, /first star of each stage pays 25 XP once/);
  assert.strictEqual(t.doc.querySelector('#towerTitle span').textContent, 'Bot tower');
  t.window.close();
});

const OPEN_TOWER = { pikdame_last_session: 'ABC123', pikdame_player_ABC123: 'p-ben', pikdame_token_ABC123: 'tok-ben' };

test('one game at a time: an open stage resumes as such and is given up only after asking', () => {
  const t = startScreen(OPEN_TOWER);
  t.ws.fire('message', {
    type: 'sessionStatus', code: 'ABC123', exists: true, challenge: false, finished: false,
    seat: { phase: 'playing', round: 1, score: 0, left: false, alone: true, tutorial: false, tower: 4, stammtisch: null },
  });
  assert.strictEqual(t.doc.getElementById('resumeBtn').textContent.trim(), 'Bot-Turm fortsetzen (Stufe 4)');
  t.ws.fire('message', towerInfo({ best: { 1: 3, 2: 1, 3: 1, 4: 0 }, unlocked: 4 }));
  t.doc.getElementById('identityAvatarBtn').click();
  t.doc.querySelector('#progressContent .pgTower').click();
  t.doc.querySelector('#towerList .twStage[data-stage="1"]').click();
  assert.strictEqual(t.sent('startTower').length, 0, 'nothing starts behind the sheet');
  assert.ok(t.shown('openGameOverlay'));
  assert.strictEqual(t.doc.getElementById('openGameSummary').textContent, 'Bot-Turm · Stufe 4');
  assert.match(t.doc.getElementById('openGameConsequence').textContent, /ohne Sterne/);
  assert.strictEqual(t.doc.getElementById('openGameGiveUpBtn').textContent.trim(), 'Aufgeben & Bot-Turm');
  t.window.close();
});

/** A finished stage 2 as the server would show it, plus the verdict message. */
function finishedStage() {
  let record = null;
  const g = new GameManager(() => {}, { deckSeed: BotTower.stageConfig(2).seed, towerStage: 2, onGameOver: (r, rec) => { record = rec; } });
  g.addOrReconnectPlayer('me', 'Ben');
  g.syncLobbyBots();
  g.startTowerRound();
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 3000) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
  }
  const state = g.publicState('me');
  const outcome = BotTower.outcomeFromRecord(record, 'me');
  g.destroy();
  return { state, outcome };
}

test('result sheet: stars, the sum behind them and the way on', () => {
  const { state, outcome } = finishedStage();
  const t = boot();
  t.ws.fire('open');
  t.ws.fire('message', { type: 'joined', playerId: 'me', playerToken: 't', sessionCode: 'TOWER1' });
  t.ws.fire('message', { type: 'state', state });
  const verdict = { ...outcome, stars: 1, margin: 25, myScore: 140, bestBot: 115, handicap: 0, wentOut: true };
  t.ws.fire('message', {
    type: 'towerResult', ...verdict, clearMargin: 100, xp: 25, level: { level: 1, into: 25, need: 100, total: 25 },
    progress: { best: { 1: 3, 2: 1 }, improved: true, stars: 4, cleared: 2, unlocked: 3 },
  });
  assert.ok(t.shown('resultOverlay'));
  assert.strictEqual(t.doc.getElementById('resultTitle').textContent, 'Bot-Turm · Stufe 2');
  assert.strictEqual(t.doc.querySelector('#resultBody .twResultXp').textContent, '+25 EP · erster Stern');
  const box = t.doc.querySelector('#resultBody .towerResultBox');
  assert.ok(box, 'verdict box');
  assert.strictEqual(box.querySelectorAll('.twResultStars .icon.on').length, 1);
  assert.match(box.textContent, /Du 140 · bester Bot 115/);
  assert.match(box.textContent, /25 Punkte vorn/);
  assert.match(box.textContent, /Neuer Bestwert/);
  assert.match(box.textContent, /mindestens 100 Punkte vorn/, 'what the next star needs');
  assert.strictEqual(t.doc.getElementById('resultContinueBtn').textContent, 'Zum Bot-Turm');
  assert.strictEqual(box.querySelector('.twNext').textContent.trim(), 'Stufe 3');

  // A state re-render keeps the box (the result sheet is rebuilt from scratch).
  t.ws.fire('message', { type: 'state', state });
  assert.strictEqual(t.doc.querySelectorAll('#resultBody .towerResultBox').length, 1);

  box.querySelector('.twNext').click();
  assert.strictEqual(t.window.localStorage.getItem('pikdame_after_tower'), '3', 'the next stage after the reload');
  t.doc.querySelector('#resultBody .twRetry').click();
  assert.strictEqual(t.window.localStorage.getItem('pikdame_after_tower'), '2');
  t.doc.getElementById('resultContinueBtn').click();
  assert.strictEqual(t.window.localStorage.getItem('pikdame_after_tower'), 'open');
  assert.strictEqual(t.sent('rematch').length, 0, 'never a rematch of a stage');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a missed stage says by how much, with the handicap in the sum', () => {
  const { state, outcome } = finishedStage();
  const t = boot();
  t.ws.fire('open');
  t.ws.fire('message', { type: 'joined', playerId: 'me', playerToken: 't', sessionCode: 'TOWER1' });
  t.ws.fire('message', { type: 'towerResult', ...outcome, stars: 0, myScore: 145, bestBot: 140, handicap: 20, margin: -15, clearMargin: 100, progress: { best: {}, improved: false, stars: 0, cleared: 0, unlocked: 2 } });
  t.ws.fire('message', { type: 'state', state });
  const box = t.doc.querySelector('#resultBody .towerResultBox');
  assert.ok(box, 'the verdict that came first is drawn with the sheet');
  assert.match(box.textContent, /bester Bot 140 \+ 20 Vorgabe = 160/);
  assert.match(box.textContent, /15 Punkte hinten/);
  assert.strictEqual(box.querySelectorAll('.twResultStars .icon.on').length, 0);
  assert.ok(!box.querySelector('.twNext'), 'stage 3 is not open yet');
  assert.ok(!box.querySelector('.twResultXp'), 'no star, no XP line');
  t.window.close();
});

test('after the reload: the intent opens the tower or starts the stage', () => {
  const open = startScreen({ pikdame_after_tower: 'open' });
  assert.ok(open.shown('towerOverlay'));
  assert.strictEqual(open.window.localStorage.getItem('pikdame_after_tower'), null, 'used once');
  assert.match(open.doc.getElementById('towerSummary').textContent, /Lädt/);
  open.ws.fire('message', towerInfo());
  assert.strictEqual(open.doc.querySelectorAll('#towerList .twStage').length, 10);
  open.window.close();

  const retry = startScreen({ pikdame_after_tower: '3' });
  const start = retry.sent('startTower');
  assert.strictEqual(start.length, 1);
  assert.strictEqual(start[0].stage, 3);
  retry.window.close();
});

test('public servers keep no profiles: no tower request, no tower sheet', () => {
  const t = boot();
  t.ws.fire('open');
  t.ws.fire('message', { type: 'profiles', players: [], publicMode: true, quests: { date: '2026-10-17', ids: ['finish_game'] } });
  assert.strictEqual(t.sent('getTower').length, 0);
  t.window.close();
});

test('start screen: tower chip under the Stammtische, at most three rows in all', () => {
  const tables = [{ code: 'ST1', name: 'Eins' }, { code: 'ST2', name: 'Zwei' }, { code: 'ST3', name: 'Drei' }];
  const t = startScreen({ pikdame_stammtische: JSON.stringify(tables) });
  const box = t.doc.getElementById('stammtischRecent');
  const visible = () => [...box.querySelectorAll('.stRecentRow:not(.hidden)')];
  assert.strictEqual(box.querySelector('.stTowerRow'), null, 'no chip without tower data');
  assert.strictEqual(visible().length, 3);

  t.ws.fire('message', towerInfo());
  const chip = box.querySelector('.stTowerRow');
  assert.ok(chip, 'chip once the data is there');
  assert.strictEqual(box.lastElementChild, chip, 'below the Stammtische');
  assert.strictEqual(chip.querySelector('.stChipInfo').textContent, 'Stufe 3 · 4/30');
  assert.strictEqual(chip.getAttribute('aria-label'), 'Bot-Turm: Stufe 3, 4 von 30 Sternen');
  assert.ok(chip.querySelector('.stTowerStar'));
  assert.deepStrictEqual(visible().map((b) => b.dataset.code || 'tower'), ['ST1', 'ST2', 'tower'], 'the oldest table yields');
  assert.strictEqual(JSON.parse(t.window.localStorage.getItem('pikdame_stammtische')).length, 3, 'but stays stored');

  chip.click();
  assert.ok(t.shown('towerOverlay'), 'a tap opens the tower sheet');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('start screen: invitation without stars, nothing in public mode', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo({ best: {}, stars: 0, cleared: 0, unlocked: 1 }));
  const box = t.doc.getElementById('stammtischRecent');
  const chip = box.querySelector('.stTowerRow');
  assert.ok(!box.classList.contains('hidden'), 'shown even without a Stammtisch');
  assert.strictEqual(chip.textContent, 'Bot-Turm10 Stufen');
  assert.strictEqual(chip.querySelector('.stTowerStar'), null);
  t.window.close();

  const p = boot();
  p.ws.fire('open');
  p.ws.fire('message', { type: 'profiles', players: [], publicMode: true });
  p.ws.fire('message', towerInfo());
  assert.strictEqual(p.doc.querySelector('#stammtischRecent .stTowerRow'), null);
  assert.ok(!p.shown('stammtischRecent'));
  assert.deepStrictEqual(p.errors, []);
  p.window.close();
});

// --- Monthly Babel tower ---------------------------------------------------------
const BABEL = { month: '2026-10', best: { 1: 2 }, stars: 2, cleared: 1, unlocked: 2, totalStars: 14 };

test('Babel: the sheet switches to this month\'s tower, a tap starts its stage', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo({ babel: BABEL }));
  t.doc.getElementById('identityAvatarBtn').click();
  const entries = [...t.doc.querySelectorAll('#progressContent .pgTower')];
  assert.strictEqual(entries.length, 2, 'fixed tower and Babel on the progress sheet');
  assert.match(entries[1].textContent, /Turmbau zu Babel/);
  assert.match(entries[1].textContent, /Oktober: 2\/30 Sterne · insgesamt 14/);
  entries[1].click();
  assert.ok(t.shown('towerOverlay'));
  const tab = (v) => t.doc.querySelector(`#towerTabs [data-tower="${v}"]`);
  assert.ok(tab('babel').classList.contains('active'));
  assert.strictEqual(tab('babel').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, 'Oktober: 2/30 Sterne · 1 von 10 Stufen · insgesamt 14');
  assert.match(t.doc.getElementById('towerRules').textContent, /Jeden Monat bauen die Bots neu/);
  assert.match(t.doc.getElementById('towerRules').textContent, /einmal 10 EP/);
  assert.ok(t.doc.querySelector('#towerList .twStage[data-stage="3"]').classList.contains('locked'));
  t.doc.querySelector('#towerList .twStage[data-stage="2"]').click();
  const start = t.sent('startTower');
  assert.deepStrictEqual({ stage: start[0].stage, babel: start[0].babel }, { stage: 2, babel: true });

  // The tab back shows the fixed tower; its stages start without the flag.
  t.doc.getElementById('identityAvatarBtn').click();
  t.doc.querySelector('#progressContent .pgTower').click();
  assert.ok(tab('fixed').classList.contains('active'));
  tab('babel').click();
  assert.match(t.doc.getElementById('towerSummary').textContent, /^Oktober/);
  tab('fixed').click();
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, '4/30 Sterne · 2 von 10 Stufen geschafft');
  t.doc.querySelector('#towerList .twStage[data-stage="1"]').click();
  assert.strictEqual(t.sent('startTower')[1].babel, undefined);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('Babel: the start chip shows the monthly tower once the fixed one is complete', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo({ babel: BABEL }));
  const chip = () => t.doc.querySelector('#stammtischRecent .stTowerRow');
  assert.match(chip().textContent, /Bot-Turm/, 'fixed tower not complete yet');
  const all = Object.fromEntries(BotTower.TOWER_STAGES.map((s) => [s.stage, 1]));
  t.ws.fire('message', towerInfo({ best: all, stars: 10, cleared: 10, unlocked: 10, babel: BABEL }));
  assert.ok(chip().classList.contains('babel'));
  assert.match(chip().textContent, /Babel/);
  assert.match(chip().textContent, /Stufe 2 · 2\/30/);
  assert.match(chip().getAttribute('aria-label'), /^Turmbau zu Babel im Oktober: Stufe 2, 2 von 30 Sternen$/);
  chip().click();
  assert.ok(t.shown('towerOverlay'));
  assert.ok(t.doc.querySelector('#towerTabs [data-tower="babel"]').classList.contains('active'));
  t.window.close();
});
