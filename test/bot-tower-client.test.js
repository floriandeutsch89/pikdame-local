/** Kartenhaus, client side: the start-screen tile in "Aufgaben", the entry on
 *  the progress sheet, the floor sheet, starting a floor through the one-game
 *  guard, the verdict on the result sheet and the way back via the reload
 *  intent. Boots the REAL markup and client in jsdom. */
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

const PROFILE = { name: 'Ben', gamesPlayed: 3, gamesWon: 1, towerStars: 4, towerCleared: 2, towers: { '2026-10': { 1: 3, 2: 1 } } };
const towerInfo = (over = {}) => ({
  type: 'towerInfo', month: '2026-10', today: '2026-10-19', stages: BotTower.publicStages(), clearMargin: BotTower.CLEAR_MARGIN,
  best: { 1: 3, 2: 1 }, stars: 4, cleared: 2, unlocked: 3, crowned: false, totalStars: 4, archive: [], ...over,
});

/** Start screen with a profile, today's quests and the tower data. */
function startScreen(storage) {
  const t = boot({ storage });
  t.ws.fire('open');
  t.ws.fire('message', { type: 'profiles', players: [PROFILE], publicMode: false, quests: { date: '2026-10-17', ids: ['finish_game'] } });
  return t;
}

test('progress sheet: the Kartenhaus entry leads to the floor sheet, top floor first', () => {
  const t = startScreen();
  const ask = t.sent('getTower');
  assert.strictEqual(ask.length, 1, 'asked once, with the profiles');
  assert.strictEqual(ask[0].name, 'Ben');
  t.ws.fire('message', towerInfo());

  t.doc.getElementById('identityAvatarBtn').click();
  assert.ok(t.shown('progressOverlay'));
  const entry = t.doc.querySelector('#progressContent .pgTower');
  assert.ok(entry, 'Kartenhaus entry on the progress sheet');
  assert.match(entry.textContent, /Oktober: 4\/60 Sterne/);
  assert.match(entry.textContent, /2 von 20 Etagen · insgesamt 4 Sterne/);
  entry.click();
  assert.ok(t.shown('towerOverlay'));
  assert.ok(!t.shown('progressOverlay'), 'one sheet at a time');

  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, 'Oktober: 4/60 Sterne · 2 von 20 Etagen geschafft');
  const rows = [...t.doc.querySelectorAll('#towerList .twStage')];
  assert.deepStrictEqual(rows.map((r) => Number(r.dataset.stage)), Array.from({ length: 20 }, (_, i) => 20 - i));
  const row = (n) => rows.find((r) => Number(r.dataset.stage) === n);
  assert.strictEqual(row(1).querySelectorAll('.twStars .icon.on').length, 3);
  assert.strictEqual(row(2).querySelectorAll('.twStars .icon.on').length, 1);
  assert.ok(row(3).classList.contains('next'), 'the stage to climb stands out');
  assert.strictEqual(t.doc.querySelectorAll('#towerList .twStage.next').length, 1);
  for (const n of [4, 5, 10, 20]) {
    assert.ok(row(n).classList.contains('locked'), `floor ${n} locked`);
    assert.strictEqual(row(n).getAttribute('aria-disabled'), 'true');
  }
  assert.strictEqual(row(2).getAttribute('aria-label'), 'Etage 2: gegen Leicht, Mittel - 1 von 3 Sternen');
  assert.match(row(10).getAttribute('aria-label'), /^Etage 10: gegen Zen, Zen, Zen, die Bots bekommen 100 Punkte Vorgabe - gesperrt$/);
  assert.match(row(20).getAttribute('aria-label'), /^Etage 20: gegen Zen, Zen, Zen, die Bots bekommen 160 Punkte Vorgabe, Pik Dame auf der Hand · Ohne Ablage · Selbst ausmachen - gesperrt$/);
  assert.strictEqual(row(10).querySelector('.twHandicap').textContent, 'Bots +100');
  assert.ok(row(10).querySelectorAll('.twBots .lvlIcon').length === 3, 'one level icon per bot');
  assert.match(t.doc.getElementById('towerRules').textContent, /mindestens 100 Punkte vorn/);
  assert.match(t.doc.getElementById('towerRules').textContent, /erste Stern jeder Etage bringt pro Monat einmal 10 EP/);
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
  assert.match(t.doc.getElementById('toastContainer').textContent, /schaff erst Etage 3/);
  t.doc.querySelector('#towerList .twStage[data-stage="2"]').click();
  const start = t.sent('startTower');
  assert.strictEqual(start.length, 1);
  assert.deepStrictEqual({ stage: start[0].stage, name: start[0].name }, { stage: 2, name: 'Ben' });
  assert.ok(!t.shown('towerOverlay'));
  t.window.close();
});

test('the language switch redraws the sheet and the tile', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo());
  t.doc.getElementById('identityAvatarBtn').click();
  t.doc.querySelector('#progressContent .pgTower').click();
  t.doc.getElementById('langBtn').click();
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, 'October: 4/60 stars · 2 of 20 floors cleared');
  assert.match(t.doc.getElementById('towerRules').textContent, /first star of each floor pays 10 XP once a month/);
  assert.strictEqual(t.doc.querySelector('#towerTitle span').textContent, 'House of Cards');
  assert.strictEqual(t.doc.querySelector('#towerTile .ttTitle').textContent, 'House of Cards');
  assert.strictEqual(t.doc.getElementById('towerTileStatus').textContent, 'Floor 3 · 4/60');
  t.window.close();
});

const OPEN_TOWER = { pikdame_last_session: 'ABC123', pikdame_player_ABC123: 'p-ben', pikdame_token_ABC123: 'tok-ben' };

test('one game at a time: an open stage resumes as such and is given up only after asking', () => {
  const t = startScreen(OPEN_TOWER);
  t.ws.fire('message', {
    type: 'sessionStatus', code: 'ABC123', exists: true, challenge: false, finished: false,
    seat: { phase: 'playing', round: 1, score: 0, left: false, alone: true, tutorial: false, tower: 4, stammtisch: null },
  });
  assert.strictEqual(t.doc.getElementById('resumeBtn').textContent.trim(), 'Kartenhaus fortsetzen (Etage 4)');
  t.ws.fire('message', towerInfo({ best: { 1: 3, 2: 1, 3: 1, 4: 0 }, unlocked: 4 }));
  t.doc.getElementById('identityAvatarBtn').click();
  t.doc.querySelector('#progressContent .pgTower').click();
  t.doc.querySelector('#towerList .twStage[data-stage="1"]').click();
  assert.strictEqual(t.sent('startTower').length, 0, 'nothing starts behind the sheet');
  assert.ok(t.shown('openGameOverlay'));
  assert.strictEqual(t.doc.getElementById('openGameSummary').textContent, 'Kartenhaus · Etage 4');
  assert.match(t.doc.getElementById('openGameConsequence').textContent, /ohne Sterne/);
  assert.strictEqual(t.doc.getElementById('openGameGiveUpBtn').textContent.trim(), 'Aufgeben & Kartenhaus');
  t.window.close();
});

/** A finished floor 2 as the server would show it, plus the verdict message. */
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
    type: 'towerResult', ...verdict, clearMargin: 100, xp: 10, level: { level: 1, into: 10, need: 100, total: 10 },
    progress: { best: { 1: 3, 2: 1 }, improved: true, stars: 4, cleared: 2, unlocked: 3, crowned: false, crownedNow: false },
  });
  assert.ok(t.shown('resultOverlay'));
  assert.strictEqual(t.doc.getElementById('resultTitle').textContent, 'Kartenhaus · Etage 2');
  assert.strictEqual(t.doc.querySelector('#resultBody .twResultXp').textContent, '+10 EP · erster Stern');
  const box = t.doc.querySelector('#resultBody .towerResultBox');
  assert.ok(box, 'verdict box');
  assert.strictEqual(box.querySelectorAll('.twResultStars .icon.on').length, 1);
  assert.match(box.textContent, /Du 140 · bester Bot 115/);
  assert.match(box.textContent, /25 Punkte vorn/);
  assert.match(box.textContent, /Neuer Bestwert/);
  assert.match(box.textContent, /mindestens 100 Punkte vorn/, 'what the next star needs');
  assert.strictEqual(t.doc.getElementById('resultContinueBtn').textContent, 'Zum Kartenhaus');
  assert.strictEqual(box.querySelector('.twNext').textContent.trim(), 'Etage 3');

  // A state re-render keeps the box (the result sheet is rebuilt from scratch).
  t.ws.fire('message', { type: 'state', state });
  assert.strictEqual(t.doc.querySelectorAll('#resultBody .towerResultBox').length, 1);

  box.querySelector('.twNext').click();
  assert.strictEqual(t.window.localStorage.getItem('pikdame_after_tower'), '3', 'the next floor after the reload');
  t.doc.querySelector('#resultBody .twRetry').click();
  assert.strictEqual(t.window.localStorage.getItem('pikdame_after_tower'), '2');
  t.doc.getElementById('resultContinueBtn').click();
  assert.strictEqual(t.window.localStorage.getItem('pikdame_after_tower'), 'open');
  assert.strictEqual(t.sent('rematch').length, 0, 'never a rematch of a floor');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a missed floor says by how much, with the handicap in the sum', () => {
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
  assert.ok(!box.querySelector('.twNext'), 'floor 3 is not open yet');
  assert.ok(!box.querySelector('.twResultXp'), 'no star, no XP line');
  t.window.close();
});

test('after the reload: the intent opens the Kartenhaus or starts the floor', () => {
  const open = startScreen({ pikdame_after_tower: 'open' });
  assert.ok(open.shown('towerOverlay'));
  assert.strictEqual(open.window.localStorage.getItem('pikdame_after_tower'), null, 'used once');
  assert.match(open.doc.getElementById('towerSummary').textContent, /Lädt/);
  open.ws.fire('message', towerInfo());
  assert.strictEqual(open.doc.querySelectorAll('#towerList .twStage').length, 20);
  open.window.close();

  const retry = startScreen({ pikdame_after_tower: '3' });
  const start = retry.sent('startTower');
  assert.strictEqual(start.length, 1);
  assert.strictEqual(start[0].stage, 3);
  retry.window.close();
});

test('public servers keep no profiles: no Kartenhaus request, no tile', () => {
  const t = boot();
  t.ws.fire('open');
  t.ws.fire('message', { type: 'profiles', players: [], publicMode: true, quests: { date: '2026-10-17', ids: ['finish_game'] } });
  assert.strictEqual(t.sent('getTower').length, 0);
  t.window.close();
});

test('start screen: the Kartenhaus tile in "Aufgaben" shows this month\'s floor and stars', () => {
  const tables = [{ code: 'ST1', name: 'Eins' }, { code: 'ST2', name: 'Zwei' }, { code: 'ST3', name: 'Drei' }];
  const t = startScreen({ pikdame_stammtische: JSON.stringify(tables) });
  const tile = t.doc.getElementById('towerTile');
  assert.ok(t.doc.getElementById('todayTiles').contains(tile), 'in "Aufgaben", below puzzle and challenge');
  assert.strictEqual(t.doc.getElementById('todayTiles').lastElementChild, tile);
  assert.ok(tile.classList.contains('hidden'), 'hidden until the data is there');
  // The Stammtische show all three again: no tower chip takes a row.
  const rows = [...t.doc.querySelectorAll('#stammtischRecent .stRecentRow')];
  assert.deepStrictEqual(rows.map((b) => b.dataset.code), ['ST1', 'ST2', 'ST3']);
  assert.ok(rows.every((r) => !r.classList.contains('hidden')));

  t.ws.fire('message', towerInfo());
  assert.ok(!tile.classList.contains('hidden'));
  assert.strictEqual(tile.querySelector('.ttTitle').textContent, 'Kartenhaus');
  assert.strictEqual(t.doc.getElementById('towerTileStatus').textContent, 'Etage 3 · 4/60');
  assert.ok(t.doc.querySelector('#towerTileStatus .ttStar'), 'a star after the numbers');
  assert.strictEqual(tile.getAttribute('aria-label'), 'Kartenhaus im Oktober: Etage 3, 4 von 60 Sternen');
  assert.strictEqual(tile.dataset.state, '', 'mid-month: calm');
  assert.strictEqual(t.doc.querySelectorAll('#stammtischRecent .stRecentRow:not(.hidden)').length, 3);
  tile.click();
  assert.ok(t.shown('towerOverlay'), 'a tap opens the Kartenhaus');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('start screen: a fresh month calls, a crowned one rests, public mode shows nothing', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo({ best: {}, stars: 0, cleared: 0, unlocked: 1, totalStars: 0 }));
  assert.strictEqual(t.doc.getElementById('towerTileStatus').textContent, 'Etage 1 · 0/60');
  assert.strictEqual(t.doc.getElementById('towerTile').dataset.state, 'new');
  const all = Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, 2]));
  t.ws.fire('message', towerInfo({ best: all, stars: 40, cleared: 20, unlocked: 20, crowned: true, totalStars: 40 }));
  assert.strictEqual(t.doc.getElementById('towerTileStatus').textContent, 'Gekrönt · 40/60');
  assert.strictEqual(t.doc.getElementById('towerTile').dataset.state, 'done');
  assert.match(t.doc.getElementById('towerTile').getAttribute('aria-label'), /^Kartenhaus im Oktober: gekrönt, 40 von 60 Sternen$/);
  t.window.close();

  const p = boot();
  p.ws.fire('open');
  p.ws.fire('message', { type: 'profiles', players: [], publicMode: true });
  p.ws.fire('message', towerInfo());
  assert.ok(!p.shown('towerTile'));
  assert.deepStrictEqual(p.errors, []);
  p.window.close();
});
