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

// Every booted client is closed after the file, also when a test failed half-way
// (its timers would keep the run alive).
const opened = [];
test.after(() => { for (const w of opened) { try { w.close(); } catch (e) { /* closed */ } } });

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot({ storage = {}, reduceMotion = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  // jsdom cannot navigate: leaving via location.href is asserted through storage instead.
  virtualConsole.on('jsdomError', (e) => { if (!/navigation/.test(String(e.message))) errors.push(e); });
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  opened.push(window);
  window.matchMedia = (q) => ({ matches: reduceMotion && /reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
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

/** The Kartenhaus sheet opened from the progress sheet (data already there). */
function openSheet(t) {
  t.doc.getElementById('identityAvatarBtn').click();
  t.doc.querySelector('#progressContent .pgTower').click();
}
const floorEl = (t, n) => t.doc.querySelector(`#towerHouse [data-stage="${n}"]`);

test('progress sheet: the Kartenhaus entry opens the house - 20 floors and the top', () => {
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
  assert.strictEqual(t.sent('getTower').length, 2, 'opening asks for fresh stars');

  assert.strictEqual(t.doc.getElementById('towerMonth').textContent, 'Oktober 2026');
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, '4 / 60 Sterne diesen Monat · noch 12 Tage');
  const svg = t.doc.querySelector('#towerHouse svg');
  assert.ok(svg, 'the house is an inline SVG');
  assert.strictEqual(svg.getAttribute('viewBox'), '-172 -282 344 290');
  const floors = [...t.doc.querySelectorAll('#towerHouse [data-stage]')];
  assert.deepStrictEqual(floors.map((g) => Number(g.dataset.stage)), Array.from({ length: 21 }, (_, i) => i + 1), '20 floors bottom-up, then the top');
  const cls = (n) => floorEl(t, n).classList;
  assert.ok(cls(1).contains('built') && cls(2).contains('built'), 'starred floors are built');
  assert.ok(cls(3).contains('next'), 'the next floor stands out');
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse .khFloor.next').length, 1);
  for (const n of [4, 10, 11, 20]) assert.ok(cls(n).contains('locked'), `floor ${n}: blueprint`);
  for (let n = 1; n <= 20; n++) assert.strictEqual(cls(n).contains('mod'), n > 10, `floor ${n}: red edge exactly from 11`);
  assert.ok(cls(21).contains('khApex') && cls(21).contains('locked'), 'the top waits for the crown');
  assert.strictEqual(floorEl(t, 1).querySelectorAll('.khStar.on').length, 3);
  assert.strictEqual(floorEl(t, 2).querySelectorAll('.khStar.on').length, 1);
  assert.strictEqual(floorEl(t, 2).querySelector('.khNum').textContent, '2', 'the number on the front card');
  assert.strictEqual(floorEl(t, 4).querySelectorAll('.khStar').length, 0, 'no stars on the blueprint');
  // Tap targets: every floor carries a hit area of a full slot.
  for (const g of floors) {
    const hit = g.querySelector('.khHit');
    assert.ok(hit, `floor ${g.dataset.stage}: hit area`);
    assert.ok(Number(hit.getAttribute('width')) >= 56 && Number(hit.getAttribute('height')) >= 46, `floor ${g.dataset.stage}: a whole slot`);
    assert.strictEqual(g.getAttribute('role'), 'button');
    assert.strictEqual(g.getAttribute('tabindex'), '0');
  }
  assert.strictEqual(floorEl(t, 2).getAttribute('aria-label'), 'Etage 2: gegen Leicht, Mittel - 1 von 3 Sternen');
  assert.strictEqual(floorEl(t, 3).getAttribute('aria-label'), 'Etage 3: gegen Mittel, Mittel - noch kein Stern');
  assert.strictEqual(floorEl(t, 20).getAttribute('aria-label'),
    'Etage 20: gegen Zen, Zen, Zen, die Bots bekommen 160 Punkte Vorgabe, Pik Dame auf der Hand · Ohne Ablage · Selbst ausmachen - gesperrt');
  assert.strictEqual(floorEl(t, 3).getAttribute('aria-pressed'), 'true', 'the detail shows the next floor');

  // The detail of the next floor, with the way in.
  const detail = t.doc.getElementById('towerDetail');
  assert.strictEqual(detail.querySelector('.khDTitle').textContent, 'Etage 3');
  assert.match(detail.textContent, /2 Bots: Mittel, Mittel/);
  assert.match(detail.textContent, /als Nächstes/);
  assert.strictEqual(detail.querySelector('.khPlay').textContent.trim(), 'Etage 3 spielen');
  assert.match(t.doc.getElementById('towerRules').textContent, /mindestens 100 Punkte vorn/);
  assert.match(t.doc.getElementById('towerRules').textContent, /erste Stern jeder Etage bringt pro Monat einmal 10 EP/);
  assert.match(t.doc.getElementById('towerRules').textContent, /krönen dein Kartenhaus \(\+50 EP\)/);
  assert.ok(!t.shown('towerArchiveBox'), 'no earlier month, no archive');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('a tap shows the floor, the button starts it; a locked floor only explains', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo());
  openSheet(t);
  const detail = t.doc.getElementById('towerDetail');
  floorEl(t, 14).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(t.sent('startTower').length, 0, 'a tap never starts');
  assert.strictEqual(detail.querySelector('.khDTitle').textContent, 'Etage 14');
  assert.match(detail.textContent, /gesperrt/);
  assert.match(detail.textContent, /3 Bots: Zen, Zen, Zen · 140 Punkte Vorgabe/);
  assert.deepStrictEqual([...detail.querySelectorAll('.khMod')].map((m) => m.textContent), ['Pik Dame auf der Hand']);
  assert.match(detail.textContent, /Schaff erst Etage 3\./);
  assert.strictEqual(detail.querySelector('.khPlay'), null, 'no way into a locked floor');
  assert.ok(floorEl(t, 14).classList.contains('sel'), 'the picked floor is ringed');
  assert.strictEqual(floorEl(t, 14).getAttribute('aria-pressed'), 'true');
  assert.strictEqual(floorEl(t, 3).getAttribute('aria-pressed'), 'false');

  // Keyboard: Enter on a floor picks it too.
  floorEl(t, 2).dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.strictEqual(detail.querySelector('.khDTitle').textContent, 'Etage 2');
  assert.ok(detail.querySelector('.khDStars'), 'its best stars');
  assert.strictEqual(detail.querySelectorAll('.khDStars .icon.on').length, 1);
  const again = detail.querySelector('.khPlay');
  assert.strictEqual(again.textContent.trim(), 'Etage 2 nochmal');
  again.click();
  const start = t.sent('startTower');
  assert.strictEqual(start.length, 1);
  assert.deepStrictEqual({ stage: start[0].stage, name: start[0].name }, { stage: 2, name: 'Ben' });
  assert.ok(!t.shown('towerOverlay'));
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('crowned: the Queen of Spades on top, the detail names the next stars to collect', () => {
  const t = startScreen();
  const best = Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, st.stage === 20 ? 1 : 3]));
  t.ws.fire('message', towerInfo({ best, stars: 58, cleared: 20, unlocked: 20, crowned: true, totalStars: 58 }));
  openSheet(t);
  const apex = floorEl(t, 21);
  assert.ok(apex.classList.contains('built'));
  assert.ok(apex.querySelector('.khQueen'), 'the Queen of Spades card');
  assert.match(apex.querySelector('.khQueen').textContent, /Q♠/);
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse .khFloor.next').length, 0, 'nothing left to unlock');
  const detail = t.doc.getElementById('towerDetail');
  assert.strictEqual(detail.querySelector('.khDTitle').textContent, 'Gekrönt!');
  assert.match(detail.textContent, /Alle 20 Etagen im Oktober geschafft\. Auf Etage 20 fehlen noch 2 Sterne\./);
  assert.strictEqual(detail.querySelector('.khPlay').textContent.trim(), 'Etage 20 nochmal');
  t.ws.fire('message', towerInfo({ best: Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, 3])), stars: 60, cleared: 20, unlocked: 20, crowned: true }));
  assert.match(detail.textContent, /Alle 60 Sterne/);
  assert.strictEqual(detail.querySelector('.khPlay'), null);
  t.window.close();
});

test('earlier months stay as a read-only archive', () => {
  const t = startScreen();
  const full = Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, 2]));
  t.ws.fire('message', towerInfo({
    month: '2026-11', today: '2026-11-30',
    archive: [{ month: '2026-10', best: full, stars: 40, cleared: 20, unlocked: 20, crowned: true },
      { month: '2026-09', best: { 1: 1 }, stars: 1, cleared: 1, unlocked: 2, crowned: false }],
  }));
  openSheet(t);
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, '4 / 60 Sterne diesen Monat · noch 0 Tage'.replace('noch 0 Tage', 'heute letzter Tag'));
  assert.ok(t.shown('towerArchiveBox'));
  const rows = [...t.doc.querySelectorAll('#towerArchive .khArchRow')];
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].getAttribute('aria-label'), 'Oktober 2026: 20 von 20 Etagen, 40 von 60 Sternen, gekrönt');
  assert.ok(rows[0].classList.contains('crowned') && rows[0].querySelector('.khArchCrown'));
  assert.strictEqual(rows[1].getAttribute('aria-label'), 'September 2026: 1 von 20 Etagen, 1 von 60 Sternen');
  assert.strictEqual(rows[1].querySelector('.khArchCrown'), null);
  assert.strictEqual(t.doc.querySelectorAll('#towerArchive button, #towerArchive [data-play]').length, 0, 'nothing to start there');
  t.window.close();
});

test('the language switch redraws the sheet and the tile', () => {
  const t = startScreen();
  t.ws.fire('message', towerInfo());
  openSheet(t);
  t.doc.getElementById('langBtn').click();
  assert.strictEqual(t.doc.getElementById('towerSummary').textContent, '4 / 60 stars this month · 12 days left');
  assert.strictEqual(t.doc.getElementById('towerMonth').textContent, 'October 2026');
  assert.match(t.doc.getElementById('towerRules').textContent, /first star of each floor pays 10 XP once a month/);
  assert.strictEqual(t.doc.querySelector('#towerTitle span').textContent, 'House of Cards');
  assert.strictEqual(t.doc.getElementById('towerDetail').querySelector('.khPlay').textContent.trim(), 'Play floor 3');
  assert.strictEqual(floorEl(t, 2).getAttribute('aria-label'), 'Floor 2: against Easy, Medium - 1 of 3 stars');
  assert.strictEqual(t.doc.querySelector('.khLegend span').textContent, 'Red edge: a handicap from floor 11');
  assert.strictEqual(t.doc.querySelector('#towerTile .ttTitle').textContent, 'House of Cards');
  assert.strictEqual(t.doc.getElementById('towerTileStatus').textContent, 'Floor 3 · 4/60');
  t.window.close();
});

test('motion: the first visit builds the house, new stars land, a lost try wobbles, a crown lands', () => {
  const seen = (best, extra = {}) => JSON.stringify({ name: 'Ben', month: '2026-10', best, crowned: false, ...extra });
  const animated = (t) => [...t.doc.querySelectorAll('#towerHouse .khLanding')].map((g) => Number(g.dataset.stage));

  // First visit on this device: the built floors land one after the other.
  let t = startScreen();
  t.ws.fire('message', towerInfo());
  openSheet(t);
  assert.deepStrictEqual(animated(t), [1, 2]);
  assert.match(floorEl(t, 2).getAttribute('style'), /--kh-delay:0\.14s/, 'staggered');
  assert.deepStrictEqual(JSON.parse(t.window.localStorage.getItem('pikdame_tower_seen')), { name: 'Ben', month: '2026-10', best: { 1: 3, 2: 1 }, crowned: false });
  // A second reply with the same stars keeps the drawing (the animation runs on).
  t.ws.fire('message', towerInfo());
  assert.deepStrictEqual(animated(t), [1, 2]);
  t.window.close();

  // Seen before: nothing moves; a new star since then lands, a better floor pops its stars.
  t = startScreen({ pikdame_tower_seen: seen({ 1: 2 }) });
  t.ws.fire('message', towerInfo());
  openSheet(t);
  assert.deepStrictEqual(animated(t), [2]);
  assert.strictEqual(floorEl(t, 1).querySelectorAll('.khStar.khPop').length, 1, 'the third star of floor 1 pops');
  t.window.close();

  // A lost try (verdict stored before the reload) wobbles that floor once.
  t = startScreen({ pikdame_tower_seen: seen({ 1: 3, 2: 1 }), pikdame_tower_last: JSON.stringify({ name: 'Ben', month: '2026-10', stage: 3, stars: 0 }) });
  t.ws.fire('message', towerInfo());
  openSheet(t);
  assert.deepStrictEqual(animated(t), []);
  assert.ok(floorEl(t, 3).classList.contains('khWobble'));
  assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_last'), null, 'once');
  t.window.close();

  // The crown: all twenty starred since the last visit.
  const all = Object.fromEntries(BotTower.TOWER_STAGES.map((st) => [st.stage, 1]));
  t = startScreen({ pikdame_tower_seen: seen({ ...all, 20: 0 }) });
  t.ws.fire('message', towerInfo({ best: all, stars: 20, cleared: 20, unlocked: 20, crowned: true }));
  openSheet(t);
  assert.deepStrictEqual(animated(t), [20]);
  assert.ok(floorEl(t, 21).classList.contains('khCrowning'), 'the Queen of Spades lands on top');
  t.window.close();

  // prefers-reduced-motion: the house stands still.
  t = boot({ reduceMotion: true });
  t.ws.fire('open');
  t.ws.fire('message', { type: 'profiles', players: [PROFILE], publicMode: false, quests: { date: '2026-10-17', ids: ['finish_game'] } });
  t.ws.fire('message', towerInfo());
  openSheet(t);
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse .khLanding, #towerHouse .khWobble, #towerHouse .khFall').length, 0);
  t.window.close();
});

test('motion: a new month - the last house collapses once, the new one rises', async () => {
  const t = startScreen({ pikdame_tower_seen: JSON.stringify({ name: 'Ben', month: '2026-09', best: { 1: 3, 2: 2, 3: 1 }, crowned: false }) });
  t.ws.fire('message', towerInfo({ best: {}, stars: 0, cleared: 0, unlocked: 1, totalStars: 6 }));
  openSheet(t);
  const svg = () => t.doc.querySelector('#towerHouse svg');
  assert.ok(svg().classList.contains('kh-collapse'), 'September falls first');
  assert.deepStrictEqual([...t.doc.querySelectorAll('#towerHouse .khFall')].map((g) => Number(g.dataset.stage)), [1, 2, 3]);
  assert.strictEqual(JSON.parse(t.window.localStorage.getItem('pikdame_tower_seen')).month, '2026-10', 'once: October is seen now');
  assert.strictEqual(t.doc.getElementById('towerDetail').querySelector('.khDTitle').textContent, 'Etage 1', 'the detail is October already');
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(svg().classList.contains('kh-rebuild'), 'then October rises as a blueprint');
  assert.strictEqual(t.doc.querySelectorAll('#towerHouse .khFloor.built').length, 0);
  assert.ok(floorEl(t, 1).classList.contains('next'));
  assert.deepStrictEqual(t.errors, []);
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
  openSheet(t);
  floorEl(t, 1).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  t.doc.querySelector('#towerDetail .khPlay').click();
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
  assert.strictEqual(open.doc.querySelector('#towerHouse svg'), null, 'the box keeps its place while it loads');
  open.ws.fire('message', towerInfo());
  assert.strictEqual(open.doc.querySelectorAll('#towerHouse [data-stage]').length, 21);
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
