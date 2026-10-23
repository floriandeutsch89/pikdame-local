/** Kartenhaus at the table: the floor card beside the piles and its rules sheet,
 *  its fold (in full for the first own turn, then card + tokens; a tap is remembered),
 *  the start card before the first move (once per try, never after a resume),
 *  the locked discard pile of "Ohne Ablage" and the marked Queen of Spades.
 *  Real markup and client in jsdom, states from the real engine. Floors are
 *  looked up by their handicaps, head starts read from BotTower.js - new deals
 *  or calibrations never break these tests. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const GameManager = require('../game/GameManager');
const BotTower = require('../game/BotTower');

const opened = [];
test.after(() => { for (const w of opened) { try { w.close(); } catch (e) { /* closed */ } } });

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const MONTH = '2026-10';

function boot({ storage = {}, still = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => { if (!/navigation/.test(String(e.message))) errors.push(e); });
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  opened.push(window);
  const reduce = (q) => still && /prefers-reduced-motion: reduce/.test(q);
  window.matchMedia = (q) => ({ matches: reduce(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
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
  ws.fire('open');
  const doc = window.document;
  const $ = (sel) => doc.querySelector(sel);
  const shown = (id) => !doc.getElementById(id).classList.contains('hidden');
  const sent = (type) => ws.sent.filter((m) => m.type === type);
  const join = (code = 'TOWER1') => ws.fire('message', { type: 'joined', playerId: 'me', playerToken: 't', sessionCode: code });
  const feed = (state) => ws.fire('message', { type: 'state', state });
  const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const folded = () => doc.getElementById('towerBar').classList.contains('tbCompact');
  return { window, doc, ws, $, shown, sent, join, feed, click, folded, errors };
}

/** The floor whose handicaps are exactly `mods` (BotTower.js), so recalibrations never break a test. */
function floorWith(mods) {
  const s = BotTower.TOWER_STAGES.find((x) => (x.mods || []).length === mods.length && mods.every((m) => x.mods.includes(m)));
  assert.ok(s, `a floor with ${mods.join('+')}`);
  return s.stage;
}
/** The engine's state of a floor for the human seat 'me': at its start, or after `turns` of my turns (my draw again). */
function towerTable(stage, turns = 0) {
  const cfg = BotTower.stageConfig(stage, MONTH);
  const g = new GameManager(() => {}, { deckSeed: cfg.seed, towerStage: stage, towerMonth: MONTH });
  g.addOrReconnectPlayer('me', 'Ben');
  g.syncLobbyBots();
  g.startTowerRound();
  let state = g.publicState('me');
  for (let mine = 0, guard = 0; mine < turns && g.phase === 'playing' && guard < 600; guard++) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
    if (g.phase === 'playing' && g.currentPlayer().id === 'me' && g.turnPhase === 'draw') { mine += 1; state = g.publicState('me'); }
  }
  g.destroy();
  return state;
}
/** The first own turn after its start card was handled (a reload of that game): the floor card in full. */
const INTRO_SEEN = { pikdame_tower_intro: 'TOWER1' };
const botTurn = (st, t) => ({ ...st, turnIndexInRound: t, currentPlayerId: st.players.find((p) => p.isBot).id, turnPhase: 'draw' });
const towerInfo = (best) => ({
  type: 'towerInfo', month: MONTH, today: `${MONTH}-19`, stages: BotTower.publicStages(), clearMargin: BotTower.CLEAR_MARGIN,
  best, ...BotTower.summarize(best), totalStars: 0, archive: [],
});

test('floor card: the floor as a card beside the piles, head start, handicaps by name, best stars', () => {
  const stage = floorWith(['noDiscard', 'goOut']);
  const { handicap } = BotTower.stageConfig(stage, MONTH);
  const t = boot({ storage: INTRO_SEEN });
  t.join();
  t.feed(towerTable(stage, 0));
  assert.ok(t.doc.getElementById('table').classList.contains('towerGame'));
  assert.ok(t.shown('towerBar'), 'the floor card is on the table');
  assert.strictEqual(t.sent('getTower').length, 1, 'asks once for the best stars');
  t.ws.fire('message', towerInfo({ [stage]: 2 }));
  const bar = t.$('#towerBar');
  assert.strictEqual(bar.closest('#centerPiles'), t.$('#centerPiles'), 'with the piles, never over the table');
  assert.strictEqual(bar.querySelector('.tfRank b').textContent, String(stage), 'the floor number is the rank');
  assert.ok(bar.querySelector('.tfCard').classList.contains('mod'), 'a handicap floor has the red edge');
  assert.strictEqual(bar.querySelectorAll('.tfStars .icon').length, 3);
  assert.strictEqual(bar.querySelectorAll('.tfStars .icon.on').length, 2, 'best stars of this month, filled');
  assert.strictEqual(bar.querySelector('.tfCap').textContent, 'Kartenhaus');
  assert.strictEqual(bar.querySelector('.tfGoal').textContent, `Vorgabe ${handicap}`);
  assert.deepStrictEqual([...bar.querySelectorAll('.tfMod')].map((m) => m.textContent), ['Ohne Ablage', 'Selbst ausmachen']);
  assert.deepStrictEqual([...bar.querySelectorAll('.tfTok')].map((n) => n.classList.contains('handicap')), [true, true]);
  // Two targets: the card opens the rules, the rest folds.
  const card = bar.querySelector('.tbCard');
  assert.strictEqual(card.tagName, 'BUTTON');
  assert.ok(card.querySelector('.tfCard'), 'the card is the rules button');
  assert.strictEqual(card.getAttribute('aria-haspopup'), 'dialog');
  assert.strictEqual(card.getAttribute('aria-label'),
    `Kartenhaus, Etage ${stage}: Bestwert 2 von 3 Sternen, Vorgabe ${handicap}, Erschwernisse: Ohne Ablage, Selbst ausmachen. Regeln anzeigen`);
  const fold = bar.querySelector('.tbFold');
  assert.strictEqual(fold.tagName, 'BUTTON');
  assert.ok(!fold.contains(card) && !card.contains(fold), 'never nested');
  assert.strictEqual(fold.getAttribute('aria-expanded'), 'true', 'the first own turn shows it in full');
  assert.strictEqual(fold.getAttribute('title'), 'Einklappen');
  assert.ok(!t.folded());

  t.doc.getElementById('langBtn').click();
  assert.strictEqual(bar.querySelector('.tfGoal').textContent, `Head start ${handicap}`);
  assert.deepStrictEqual([...bar.querySelectorAll('.tfMod')].map((m) => m.textContent), ['No discard pile', 'Go out yourself']);
  assert.match(bar.querySelector('.tbCard').getAttribute('aria-label'), new RegExp(`^House of Cards, floor ${stage}: best 2 of 3 stars`));
  assert.strictEqual(bar.querySelector('.tbFold').getAttribute('title'), 'Collapse');
  assert.strictEqual(bar.querySelector('.tbFold').getAttribute('aria-expanded'), 'true');
  assert.deepStrictEqual(t.errors, []);
});

test('floor card: the queen is a risk (gold), not a handicap; a plain floor names no handicap', () => {
  const queen = floorWith(['queen']);
  let t = boot();
  t.join();
  t.feed(towerTable(queen, 1));
  const bar = t.$('#towerBar');
  assert.ok(bar.querySelector('.tfCard').classList.contains('risk') && !bar.querySelector('.tfCard').classList.contains('mod'), 'gold edge, not red');
  assert.ok(bar.querySelector('.tfTok').classList.contains('risk'));
  assert.deepStrictEqual([...bar.querySelectorAll('.tfMod')].map((m) => m.textContent), ['Pik Dame']);
  assert.match(bar.querySelector('.tbCard').getAttribute('aria-label'), /, Risiko: Pik Dame auf der Hand\. Regeln anzeigen$/);

  const plain = BotTower.TOWER_STAGES.find((s) => !s.mods && !s.handicap).stage;
  t = boot();
  t.join();
  t.feed(towerTable(plain, 1));
  assert.strictEqual(t.$('#towerBar .tfGoal').textContent, 'Ohne Vorgabe');
  assert.strictEqual(t.$('#towerBar .tfMods'), null);
  assert.strictEqual(t.$('#towerBar button.tbFold'), null, 'no tokens, nothing to fold: the words are no button');
  assert.ok(!t.folded(), 'stays as it is from the second own turn on');
  assert.ok(!t.$('#towerBar .tfCard').classList.contains('mod') && !t.$('#towerBar .tfCard').classList.contains('risk'));
  assert.ok(!t.$('#discardPile').classList.contains('towerLocked'));
});

test('no Kartenhaus, no floor card: a normal table keeps its piles as they are', () => {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('me', 'Ben');
  g.fillWithBots();
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 20);
  const t = boot();
  t.join('NORMAL1');
  t.feed(g.publicState('me'));
  g.destroy();
  assert.ok(!t.shown('towerBar'));
  assert.ok(!t.shown('towerStart'));
  assert.ok(!t.doc.getElementById('table').classList.contains('towerGame'));
  assert.strictEqual(t.sent('getTower').length, 0);
});

test('a tap on the floor card opens the floor\'s rules: stars, bots, head start, each handicap exactly', () => {
  const stage = floorWith(['noDiscard', 'goOut']);
  const { handicap, bots } = BotTower.stageConfig(stage, MONTH);
  const t = boot();
  t.join();
  t.feed(towerTable(stage, 1));
  t.ws.fire('message', towerInfo({ [stage]: 1 }));
  t.click(t.$('#towerBar .tbCard .tfRank'));
  assert.ok(t.shown('towerFloorOverlay'));
  assert.strictEqual(t.$('#towerFloorTitleText').textContent, `Kartenhaus · Etage ${stage}`);
  const body = t.$('#towerFloorBody');
  assert.match(body.textContent, /Dein Bestwert diesen Monat: 1 von 3 Sternen/);
  const stars = [...body.querySelectorAll('.khRuleList li')].map((li) => li.textContent);
  assert.deepStrictEqual(stars, [
    `1 Stern: selbst ausmachen und mehr Punkte als jeder Bot samt ${handicap} Vorgabe`,
    '2 Sterne: gibt es hier nicht – ohne Ausmachen kein Stern',
    `3 Sterne: selbst ausmachen und mindestens ${BotTower.CLEAR_MARGIN} Punkte vorn`,
  ], 'goOut leaves no 2-star outcome (BotTower.starsFor)');
  assert.ok(body.querySelectorAll('.khRuleList li')[1].classList.contains('off'));
  assert.match(body.textContent, new RegExp(`${bots.length} Bots: ${bots.map(() => '\\w+').join(', ')}`));
  assert.match(body.textContent, new RegExp(`Vorgabe ${handicap}: Für einen Stern brauchst du mehr Punkte als der beste Bot plus ${handicap}\\.`));
  assert.deepStrictEqual([...body.querySelectorAll('h3')].map((h) => h.textContent), ['So holst du Sterne', 'Gegner', 'Erschwernisse']);
  const rules = [...body.querySelectorAll('.tfsMods li')].map((li) => li.textContent);
  assert.match(rules[0], /^Ohne Ablage: Du darfst die Ablage nie aufnehmen und ziehst immer vom Stapel\./);
  assert.match(rules[1], /^Selbst ausmachen: Sterne gibt es nur, wenn du die Runde selbst beendest/);

  // The language switch redraws the open sheet.
  t.doc.getElementById('langBtn').click();
  assert.strictEqual(t.$('#towerFloorTitleText').textContent, `House of Cards · floor ${stage}`);
  assert.match(t.$('#towerFloorBody').textContent, /2 stars: not on this floor/);
  t.click(t.$('#towerFloorCloseBtn'));
  assert.ok(!t.shown('towerFloorOverlay'));
  assert.deepStrictEqual(t.errors, []);
});

test('a plain floor\'s rules: the help fold wording with its head start, no handicap section', () => {
  const stage = BotTower.TOWER_STAGES.find((s) => !s.mods && s.handicap).stage;
  const { handicap } = BotTower.stageConfig(stage, MONTH);
  const t = boot();
  t.join();
  t.feed(towerTable(stage, 1));
  t.click(t.$('#towerBar .tbCard'));
  const stars = [...t.$('#towerFloorBody').querySelectorAll('.khRuleList li')].map((li) => li.textContent);
  assert.deepStrictEqual(stars, [
    `1 Stern: mehr Punkte als jeder Bot samt ${handicap} Vorgabe`,
    `2 Sterne: mindestens ${BotTower.CLEAR_MARGIN} Punkte vorn`,
    '3 Sterne: dazu selbst ausmachen',
  ]);
  assert.match(t.$('#towerFloorBody').textContent, /noch keinen Stern/);
  assert.deepStrictEqual([...t.$('#towerFloorBody').querySelectorAll('h3')].map((h) => h.textContent), ['So holst du Sterne', 'Gegner']);
});

test('start card: once at the start of a try, "Los" or the first move closes it, never again for that game', () => {
  const stage = floorWith(['goOut']);
  const { handicap } = BotTower.stageConfig(stage, MONTH);
  const start = towerTable(stage, 0);
  assert.strictEqual(start.turnIndexInRound, 0);
  const t = boot();
  t.join('TRY1');
  t.feed(start);
  assert.ok(t.shown('towerStart'), 'shown before the first move');
  assert.ok(t.doc.getElementById('table').classList.contains('towerStartOpen'), 'the floor card waits meanwhile');
  assert.strictEqual(t.$('#towerStartTitle').textContent, `Etage ${stage}`);
  assert.strictEqual(t.$('#towerStartGoal').textContent, `Ziel: selbst ausmachen und mehr Punkte als jeder Bot samt ${handicap} Vorgabe.`);
  assert.deepStrictEqual([...t.$('#towerStartMods').querySelectorAll('.tsModsHead')].map((h) => h.textContent), ['Erschwernis']);
  assert.strictEqual(t.$('#towerStartMods .tfMod').textContent, 'Selbst ausmachen');
  assert.strictEqual(t.$('#towerStartCard .tfRank b').textContent, String(stage));
  assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_intro'), 'TRY1', 'remembered for this game');
  // Turn flow untouched: the piles still answer while it is open.
  t.click(t.$('#drawPile'));
  assert.strictEqual(t.sent('drawFromPile').length, 1);

  t.click(t.$('#towerStartBtn'));
  assert.ok(!t.shown('towerStart'));
  assert.ok(!t.doc.getElementById('table').classList.contains('towerStartOpen'));
  t.feed(start); // the same state again (a re-broadcast)
  assert.ok(!t.shown('towerStart'), 'once per try');

  // The first move closes it without "Los".
  const u = boot();
  u.join('TRY2');
  u.feed(start);
  assert.ok(u.shown('towerStart'));
  u.feed({ ...start, turnPhase: 'meld' });
  assert.ok(!u.shown('towerStart'), 'gone with the first move');
  assert.deepStrictEqual([...t.errors, ...u.errors], []);
});

test('start card: not after a reload of the same game, not on a resume mid-floor', () => {
  const stage = floorWith(['goOut']);
  const start = towerTable(stage, 0);
  const reload = boot({ storage: { pikdame_tower_intro: 'TRY1' } });
  reload.join('TRY1');
  reload.feed(start);
  assert.ok(!reload.shown('towerStart'), 'the same try after a reload');
  assert.ok(reload.shown('towerBar'), 'the floor card is there at once');

  const resume = boot();
  resume.join('TRY3');
  resume.feed(towerTable(stage, 2));
  assert.ok(!resume.shown('towerStart'), 'a resume mid-floor skips it');
  assert.strictEqual(resume.window.localStorage.getItem('pikdame_tower_intro'), 'TRY3', 'and marks the game handled');
  resume.feed(start);
  assert.ok(!resume.shown('towerStart'));
});

test('start card: the queen is a risk with her note, the dealt Q♠ is marked and the fan dims around it', () => {
  const stage = floorWith(['queen']);
  const start = towerTable(stage, 0);
  const me = start.players.find((p) => p.id === 'me');
  assert.ok(me.hand.some((c) => c.rank === 'Q' && c.suit === 'S'), 'the floor deals the Queen of Spades');
  const t = boot();
  t.join('QUEEN1');
  t.feed(start);
  assert.ok(t.shown('towerStart'));
  const group = t.$('#towerStartMods .tsGroup');
  assert.ok(group.classList.contains('risk'));
  assert.strictEqual(group.querySelector('.tsModsHead').textContent, 'Risiko');
  assert.strictEqual(group.querySelector('.tfMod').textContent, 'Pik Dame auf der Hand');
  assert.strictEqual(group.querySelector('.tsWhy').textContent, 'ausgelegt +100, auf der Hand −100');
  const marked = [...t.doc.querySelectorAll('#hand .card.towerSpot')];
  assert.ok(marked.length >= 1);
  assert.ok(marked.every((c) => c.classList.contains('pikdame-card')), 'only the Queen of Spades is marked');
  assert.ok(t.$('#hand').classList.contains('towerSpotOn'), 'the rest of the fan dims');

  // "Los" lets the mark linger a moment; the first move ends it at once.
  const m = boot();
  m.join('QUEEN2');
  m.feed(start);
  assert.ok(m.$('#hand').classList.contains('towerSpotOn'));
  m.feed({ ...start, turnPhase: 'meld' });
  assert.strictEqual(m.doc.querySelectorAll('#hand .card.towerSpot').length, 0, 'gone with the first move');
  assert.ok(!m.$('#hand').classList.contains('towerSpotOn'));

  // A resume of this game: no card, no mark.
  const r = boot({ storage: { pikdame_tower_intro: 'QUEEN1' } });
  r.join('QUEEN1');
  r.feed(start);
  assert.strictEqual(r.doc.querySelectorAll('#hand .card.towerSpot').length, 0);
  assert.ok(!r.$('#hand').classList.contains('towerSpotOn'));
  t.doc.getElementById('langBtn').click();
  assert.strictEqual(t.$('#towerStartMods .tsModsHead').textContent, 'Risk');
  assert.strictEqual(t.$('#towerStartMods .tsWhy').textContent, '+100 melded, −100 in hand');
  assert.strictEqual(t.$('#towerStartBtn span').textContent, 'Go');
  t.click(t.$('#towerStartBtn'));
  assert.ok(!t.shown('towerStart'));
  assert.ok(t.doc.querySelectorAll('#hand .card.towerSpot').length >= 1, 'still marked right after "Los"');
});

test('Ohne Ablage: the pile looks locked the whole floor, keeps its caption "Ablage"; a tap explains instead of a silent tap', () => {
  const stage = floorWith(['noDiscard']);
  const t = boot();
  t.join();
  const mine = towerTable(stage, 1);
  t.feed(mine);
  const pile = t.$('#discardPile');
  assert.ok(pile.classList.contains('towerLocked'));
  assert.ok(!pile.classList.contains('glow'), 'never glows');
  assert.deepStrictEqual([...pile.querySelectorAll('.pileLabel')].map((n) => n.textContent), ['Ablage'], 'the lock says the rest');
  assert.ok(pile.querySelector('#discardLock'), 'the lock token sits on the pile');
  t.click(t.$('#discardTopCard'));
  assert.strictEqual(t.sent('drawFromDiscard').length, 0, 'no refused request to the server');
  assert.match(t.$('#toastContainer').textContent, /^Erschwernis „Ohne Ablage“: Auf dieser Etage ziehst du immer vom Stapel/);
  assert.ok(t.$('#discardLock').classList.contains('nudge'));

  // Not my turn (the pile is disabled): the tap still explains.
  t.$('#toastContainer').textContent = '';
  t.feed({ ...mine, currentPlayerId: mine.players.find((p) => p.isBot).id });
  assert.ok(pile.classList.contains('disabled') && pile.classList.contains('towerLocked'));
  t.click(t.$('#discardTopCard'));
  assert.match(t.$('#toastContainer').textContent, /Ohne Ablage/);
  // Peeking at the pile still works.
  t.click(t.$('#discardPreviewBtn'));
  assert.ok(t.shown('discardPreviewOverlay'));
  assert.deepStrictEqual(t.errors, []);

  // Another floor keeps the normal pile.
  const u = boot();
  u.join();
  u.feed(towerTable(floorWith(['goOut']), 1));
  assert.ok(!u.$('#discardPile').classList.contains('towerLocked'));
});

test('fold: in full during the first own turn and the bot turns after it, card + tokens from the second; nothing stored', () => {
  const stage = floorWith(['queen', 'noDiscard', 'goOut']);
  const start = towerTable(stage, 0);
  const t = boot({ storage: INTRO_SEEN });
  t.join();
  t.feed(start);
  const fold = () => t.$('#towerBar .tbFold');
  assert.ok(!t.folded() && fold().getAttribute('aria-expanded') === 'true', 'my first turn: in full');
  t.feed({ ...start, turnPhase: 'meld' });
  t.feed(botTurn(start, 1));
  t.feed(botTurn(start, start.players.length - 1));
  assert.ok(!t.folded(), 'still in full while the bots play after it');
  t.feed(towerTable(stage, 1));
  assert.ok(t.folded(), 'my second turn: folded');
  assert.strictEqual(fold().getAttribute('aria-expanded'), 'false');
  assert.strictEqual(fold().getAttribute('title'), 'Ausklappen');
  assert.strictEqual(t.$('#towerBar .tbCard .tfRank b').textContent, String(stage), 'the card stays');
  assert.strictEqual(t.doc.querySelectorAll('#towerBar .tfTok').length, 3, 'and its tokens');
  assert.match(fold().textContent, /Pik Dame.*Ohne Ablage.*Selbst ausmachen/, 'the words stay for screen readers');
  t.feed(towerTable(stage, 2));
  assert.ok(t.folded());
  assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_fold'), null, 'the automatic fold is no choice of the player');

  // A resume mid-floor opens folded at once, without the words fading in.
  const r = boot({ storage: INTRO_SEEN });
  r.join();
  r.feed(towerTable(stage, 3));
  assert.ok(r.folded());
  assert.ok(!r.$('#towerBar').classList.contains('tbUnfold'));

  // The seat after the dealer opens the round: my turns count from my own first one.
  const late = { ...start, dealerId: 'me' }; // a bot opens, I am the last seat
  const u = boot({ storage: INTRO_SEEN });
  u.join();
  u.feed({ ...late, turnIndexInRound: late.players.length });
  assert.ok(!u.folded(), 'one bot round later it is only my first turn');
  u.feed({ ...late, turnIndexInRound: 2 * late.players.length - 1 });
  assert.ok(u.folded(), 'my second turn');
  assert.deepStrictEqual([...t.errors, ...r.errors, ...u.errors], []);
});

test('fold: a tap unfolds or folds and is remembered on every floor; the card still opens the rules', () => {
  const stage = floorWith(['noDiscard', 'goOut']);
  const t = boot({ storage: INTRO_SEEN });
  t.join();
  t.feed(towerTable(stage, 1));
  assert.ok(t.folded());
  // The card: its rules, never the fold.
  t.click(t.$('#towerBar .tbCard .tfRank b'));
  assert.ok(t.shown('towerFloorOverlay'));
  assert.ok(t.folded());
  t.click(t.$('#towerFloorCloseBtn'));
  // The tokens: the fold, never the rules.
  t.click(t.$('#towerBar .tfTok'));
  assert.ok(!t.shown('towerFloorOverlay'));
  assert.ok(!t.folded(), 'unfolded');
  assert.strictEqual(t.$('#towerBar .tbFold').getAttribute('aria-expanded'), 'true');
  assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_fold'), 'full', 'one key');
  assert.ok(t.$('#towerBar').classList.contains('tbUnfold'), 'the words fade back in');
  t.feed(towerTable(stage, 2));
  assert.ok(!t.folded(), 'the player\'s choice beats the automatic fold');
  t.doc.getElementById('langBtn').click();
  assert.ok(!t.folded(), 'a language switch keeps it');
  assert.strictEqual(t.$('#towerBar .tbFold').getAttribute('title'), 'Collapse');

  // Another floor, another game: still in full, until a tap folds it - then folded even in a first turn.
  const other = floorWith(['queen']);
  const u = boot({ storage: { ...INTRO_SEEN, pikdame_tower_fold: 'full' } });
  u.join();
  u.feed(towerTable(other, 2));
  assert.ok(!u.folded());
  u.click(u.$('#towerBar .tbFold'));
  assert.ok(u.folded());
  assert.strictEqual(u.window.localStorage.getItem('pikdame_tower_fold'), 'compact');
  const v = boot({ storage: { ...INTRO_SEEN, pikdame_tower_fold: 'compact' } });
  v.join();
  v.feed(towerTable(stage, 0));
  assert.ok(v.folded(), 'folded from the first own turn: the start card said it all');
  // A floor without tokens has nothing to fold, whatever was chosen.
  const plain = BotTower.TOWER_STAGES.find((s) => !s.mods && s.handicap).stage;
  v.feed(towerTable(plain, 2));
  assert.ok(!v.folded());
  assert.deepStrictEqual([...t.errors, ...u.errors, ...v.errors], []);
});

test('fold: card, tokens and ✕ glide to their new places, never with reduced motion', () => {
  const stage = floorWith(['queen', 'noDiscard', 'goOut']);
  const run = (still) => {
    const t = boot({ storage: INTRO_SEEN, still });
    const glides = [];
    // jsdom has no layout: folded, everything sits 40 px further left.
    t.window.HTMLElement.prototype.getBoundingClientRect = function () {
      const x = t.doc.getElementById('towerBar').classList.contains('tbCompact') ? 0 : 40;
      return { left: x, top: 0, right: x + 10, bottom: 10, width: 10, height: 10, x, y: 0 };
    };
    t.window.HTMLElement.prototype.animate = function (frames) { glides.push([this.className, frames[0].translate]); return { cancel() {} }; };
    t.join();
    t.feed(towerTable(stage, 0));
    t.feed(towerTable(stage, 1));
    assert.ok(t.folded());
    return { t, glides };
  };
  const moving = run(false);
  // The ✕ sits beside the tokens when folded: it moves with them instead of jumping.
  assert.deepStrictEqual(moving.glides.map((g) => g[0].split(' ')[0]).sort(), ['tbHide', 'tfCard', 'tfTok', 'tfTok', 'tfTok']);
  assert.ok(moving.glides.every((g) => g[1] === '40px 0px'), 'each starts where it was');
  const still = run(true);
  assert.deepStrictEqual(still.glides, [], 'prefers-reduced-motion: it simply folds');
  still.t.click(still.t.$('#towerBar .tbFold'));
  assert.ok(!still.t.folded());
  assert.ok(!still.t.$('#towerBar').classList.contains('tbUnfold'), 'and unfolds without the fade');
});

const HIDDEN = { pikdame_tower_hidden: '1' };
const withoutTower = (st) => Object.fromEntries(Object.entries(st).filter(([k]) => !k.startsWith('tower')));

test('hide: the ✕ takes the floor card off the table - the normal table\'s layout; the lock and its refusal stay', () => {
  const stage = floorWith(['queen', 'noDiscard', 'goOut']);
  const t = boot({ storage: INTRO_SEEN });
  t.join();
  const mine = towerTable(stage, 1);
  t.feed(mine);
  const hide = t.$('#towerBar .tbHide');
  assert.strictEqual(hide.tagName, 'BUTTON');
  assert.strictEqual(hide.getAttribute('aria-label'), 'Kartenhaus-Etage ausblenden');
  assert.ok(!hide.closest('.tbCard') && !hide.closest('.tbFold'), 'a target of its own, never inside the card or the fold');
  assert.ok(!t.shown('towerPanelBtn'), 'while the card is on the table the gear sheet needs no way back');
  hide.focus(); // as from the keyboard
  t.click(hide.querySelector('svg'));
  const table = t.doc.getElementById('table');
  assert.ok(!t.shown('towerBar'), 'off the table');
  assert.strictEqual(t.doc.activeElement, t.$('#settingsBtn'), 'the focus moves on to the way back, not to nowhere');
  // The same state without its Kartenhaus fields is a normal table: the layout classes match.
  const plain = boot();
  plain.join('NORMAL1');
  plain.feed(withoutTower(mine));
  assert.ok(!table.classList.contains('towerGame'));
  assert.strictEqual(table.className, plain.doc.getElementById('table').className, 'the normal table\'s layout');
  assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_hidden'), '1', 'remembered');
  assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_fold'), null, 'the fold choice is left alone');
  assert.strictEqual(t.$('#toastContainer').textContent, 'Etage ausgeblendet – zurück über das Zahnrad oben rechts.');
  assert.ok(t.shown('towerPanelBtn'), 'the gear sheet now has the way back');
  // Rule cues stay: the lock on the pile, and a tap on it explains instead of asking the server.
  const pile = t.$('#discardPile');
  assert.ok(pile.classList.contains('towerLocked'));
  assert.ok(pile.querySelector('#discardLock'), 'the lock token sits on the pile');
  t.click(t.$('#discardTopCard'));
  assert.strictEqual(t.sent('drawFromDiscard').length, 0);
  assert.match(t.$('#toastContainer').textContent, /^Erschwernis „Ohne Ablage“: Auf dieser Etage ziehst du immer vom Stapel/);
  // The next turns: still off the table.
  t.feed(towerTable(stage, 2));
  assert.ok(!t.shown('towerBar') && !table.classList.contains('towerGame'));

  // A reload or the next floor: hidden from the first paint; a noDiscard floor still shows its lock.
  const r = boot({ storage: { ...INTRO_SEEN, ...HIDDEN } });
  r.join();
  r.feed(towerTable(floorWith(['noDiscard']), 1));
  assert.ok(!r.shown('towerBar'));
  assert.ok(!r.doc.getElementById('table').classList.contains('towerGame'));
  assert.ok(r.$('#discardPile').classList.contains('towerLocked'), 'the lock never hides');
  assert.ok(r.shown('towerPanelBtn'));
  // The start card of a new try is untouched; after "Los" the card stays off the table.
  const s = boot({ storage: HIDDEN });
  s.join('TRYH');
  s.feed(towerTable(floorWith(['goOut']), 0));
  assert.ok(s.shown('towerStart'), 'the start card still explains the floor');
  s.click(s.$('#towerStartBtn'));
  assert.ok(!s.shown('towerStart') && !s.shown('towerBar'));
  // A normal table never offers the row, whatever is stored.
  const n = boot({ storage: HIDDEN });
  n.join('NORMAL2');
  n.feed(withoutTower(mine));
  assert.ok(!n.shown('towerPanelBtn'));

  t.doc.getElementById('langBtn').click();
  assert.deepStrictEqual([t.$('#towerPanelBtn .sheetRowLabel').textContent, t.$('#towerPanelBtn .sheetRowValue').textContent],
    ['House of Cards floor', 'Show']);
  assert.deepStrictEqual([...t.errors, ...plain.errors, ...r.errors, ...s.errors, ...n.errors], []);
});

test('hide: a fold choice from before stays valid - hiding keeps it, showing brings it back as it was', () => {
  const stage = floorWith(['queen', 'noDiscard', 'goOut']);
  for (const fold of ['compact', 'full']) {
    const t = boot({ storage: { ...INTRO_SEEN, pikdame_tower_fold: fold } });
    t.join();
    t.feed(towerTable(stage, 1));
    assert.ok(t.shown('towerBar'), `${fold}: an old fold value never hides the card`);
    assert.strictEqual(t.folded(), fold === 'compact');
    t.click(t.$('#towerBar .tbHide'));
    assert.ok(!t.shown('towerBar'));
    assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_fold'), fold, 'one key per concern');
    t.click(t.$('#towerPanelBtn'));
    t.click(t.$('#towerFloorShowBtn'));
    assert.ok(t.shown('towerBar'));
    assert.strictEqual(t.folded(), fold === 'compact', `${fold}: back as it was`);
    assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_hidden'), null);
    assert.deepStrictEqual(t.errors, []);
  }
  // Only '1' hides: any other value leaves the card on the table.
  const u = boot({ storage: { ...INTRO_SEEN, pikdame_tower_hidden: 'yes' } });
  u.join();
  u.feed(towerTable(stage, 1));
  assert.ok(u.shown('towerBar'));
  // Without storage (private mode) the choice holds for the session.
  const p = boot({ storage: INTRO_SEEN });
  p.join();
  p.feed(towerTable(stage, 1));
  for (const fn of ['getItem', 'setItem', 'removeItem']) p.window.Storage.prototype[fn] = () => { throw new Error('blocked'); };
  p.click(p.$('#towerBar .tbHide'));
  p.feed(towerTable(stage, 2));
  assert.ok(!p.shown('towerBar'), 'still off the table');
  p.click(p.$('#towerPanelBtn'));
  p.click(p.$('#towerFloorShowBtn'));
  assert.ok(p.shown('towerBar'));
  assert.deepStrictEqual([...u.errors, ...p.errors], []);
});

test('restore via the menu: the gear row opens the floor\'s rules - Pik Dame and Selbst ausmachen included - and "Am Tisch anzeigen"', () => {
  const stage = floorWith(['queen', 'noDiscard', 'goOut']);
  const { handicap } = BotTower.stageConfig(stage, MONTH);
  const t = boot({ storage: { ...INTRO_SEEN, ...HIDDEN } });
  t.join();
  t.feed(towerTable(stage, 2));
  assert.ok(!t.shown('towerBar'));
  t.click(t.$('#settingsBtn'));
  assert.ok(t.shown('gameSettingsOverlay'));
  const row = t.$('#towerPanelBtn');
  assert.ok(t.shown('towerPanelBtn'));
  assert.ok(row.classList.contains('sheetRow') && !row.closest('.overlay').classList.contains('hidden'), 'a row of the sheet the gear opens');
  assert.deepStrictEqual([row.querySelector('.sheetRowLabel').textContent, row.querySelector('.sheetRowValue').textContent],
    ['Kartenhaus-Etage', 'Anzeigen']);
  t.click(row);
  assert.ok(row.closest('.overlay').classList.contains('hidden'), 'the gear sheet makes way');
  assert.ok(t.shown('towerFloorOverlay'));
  const body = t.$('#towerFloorBody').textContent;
  assert.match(body, /Pik Dame auf der Hand: Du startest mit der Pik Dame auf der Hand\. Ausgelegt bringt sie \+100/);
  assert.match(body, /Selbst ausmachen: Sterne gibt es nur, wenn du die Runde selbst beendest/);
  assert.match(body, /Ohne Ablage: Du darfst die Ablage nie aufnehmen/);
  assert.match(body, new RegExp(`Vorgabe ${handicap}: Für einen Stern`));
  assert.match(body, /1 Stern: selbst ausmachen und mehr Punkte als jeder Bot/);
  assert.ok(t.shown('towerFloorShowBtn'));
  // "Weiterspielen" only closes: the card stays off the table.
  t.click(t.$('#towerFloorCloseBtn'));
  assert.ok(!t.shown('towerFloorOverlay') && !t.shown('towerBar'));
  // "Am Tisch anzeigen": back beside the piles, on every floor from now on.
  t.click(t.$('#settingsBtn'));
  t.click(t.$('#towerPanelBtn'));
  t.click(t.$('#towerFloorShowBtn span'));
  assert.ok(!t.shown('towerFloorOverlay'));
  assert.ok(t.shown('towerBar'));
  assert.ok(t.doc.getElementById('table').classList.contains('towerGame'));
  assert.strictEqual(t.window.localStorage.getItem('pikdame_tower_hidden'), null);
  assert.ok(!t.shown('towerPanelBtn'), 'the row goes with the need');
  // From the card the sheet has no "Am Tisch anzeigen": the card is on the table.
  t.click(t.$('#towerBar .tbCard'));
  assert.ok(t.shown('towerFloorOverlay'));
  assert.ok(!t.shown('towerFloorShowBtn'));
  t.click(t.$('#towerFloorCloseBtn'));

  // English: the ✕, the row and the sheet's button.
  const e = boot({ storage: { ...INTRO_SEEN, ...HIDDEN, pikdame_lang: 'en' } });
  e.join();
  e.feed(towerTable(stage, 2));
  assert.deepStrictEqual([e.$('#towerPanelBtn .sheetRowLabel').textContent, e.$('#towerPanelBtn .sheetRowValue').textContent],
    ['House of Cards floor', 'Show']);
  e.click(e.$('#towerPanelBtn'));
  assert.strictEqual(e.$('#towerFloorShowBtn span').textContent, 'Show at the table');
  assert.match(e.$('#towerFloorBody').textContent, /Go out yourself: Stars only if you end the round yourself/);
  e.click(e.$('#towerFloorShowBtn'));
  assert.strictEqual(e.$('#towerBar .tbHide').getAttribute('aria-label'), 'Hide the House of Cards floor');
  assert.deepStrictEqual([...t.errors, ...e.errors], []);
});

test('hide: a 120 ms fade, then the piles glide for 130 ms and the gear turns - all at once with reduced motion', () => {
  const stage = floorWith(['noDiscard']);
  const run = (still) => {
    const t = boot({ storage: INTRO_SEEN, still });
    const anims = [];
    t.window.HTMLElement.prototype.animate = function (frames, opts) {
      const a = { el: this, frames, opts, onfinish: null, cancelled: false, cancel() { this.cancelled = true; } };
      anims.push(a);
      return a;
    };
    // jsdom has no layout: with the floor card beside them, the piles sit 50 px further right.
    t.window.HTMLElement.prototype.getBoundingClientRect = function () {
      const x = this.closest('#centerPiles') && t.doc.getElementById('table').classList.contains('towerGame') ? 50 : 0;
      return { left: x, top: 0, right: x + 10, bottom: 10, width: 10, height: 10, x, y: 0 };
    };
    t.join();
    t.feed(towerTable(stage, 1));
    anims.length = 0; // only what the ✕ starts
    t.click(t.$('#towerBar .tbHide'));
    return { t, anims };
  };
  const { t, anims } = run(false);
  const table = t.doc.getElementById('table');
  const fade = anims.find((a) => a.el.id === 'towerBar');
  assert.ok(fade, 'the card fades');
  assert.deepStrictEqual([...fade.frames].map((f) => f.opacity), [1, 0]); // spread: the page's arrays are another realm
  assert.ok(t.$('#settingsBtn').classList.contains('towerNudge'), 'the gear turns: that is where it went');
  assert.ok(t.shown('towerBar') && table.classList.contains('towerGame'), 'the layout waits for the fade');
  t.feed(towerTable(stage, 1)); // a bot's state mid-fade does not cut it short
  assert.ok(t.shown('towerBar'));
  fade.onfinish();
  assert.ok(!t.shown('towerBar') && !table.classList.contains('towerGame'));
  assert.ok(fade.cancelled, 'no fill left behind for the way back');
  const glides = anims.filter((a) => a.el.id === 'drawPile' || a.el.id === 'discardPile');
  assert.deepStrictEqual(glides.map((a) => a.el.id).sort(), ['discardPile', 'drawPile']);
  assert.ok(glides.every((a) => a.frames[0].translate === '50px 0px'), 'each starts where it was');
  assert.ok(fade.opts.duration + Math.max(...glides.map((a) => a.opts.duration)) <= 250, 'the whole move within 250 ms');
  // The way back deals the card in again.
  t.click(t.$('#towerPanelBtn'));
  t.click(t.$('#towerFloorShowBtn'));
  assert.ok(t.$('#towerBar').classList.contains('tfEnter'));

  const still = run(true);
  const ours = (a) => ['towerBar', 'drawPile', 'discardPile'].includes(a.el.id) || !!a.el.closest('#opponents');
  assert.deepStrictEqual(still.anims.filter(ours), [], 'prefers-reduced-motion: gone at once');
  assert.ok(!still.t.shown('towerBar') && !still.t.doc.getElementById('table').classList.contains('towerGame'));
  assert.ok(!still.t.$('#settingsBtn').classList.contains('towerNudge'));
  still.t.click(still.t.$('#towerPanelBtn'));
  still.t.click(still.t.$('#towerFloorShowBtn'));
  assert.ok(still.t.shown('towerBar'));
  assert.ok(!still.t.$('#towerBar').classList.contains('tfEnter'), 'and back without the deal');
  assert.deepStrictEqual([...t.errors, ...still.t.errors], []);
});

// jsdom has no stylesheet: the CSS that carries these promises is checked at the source.
test('style contract: the floor card costs no meld or hand space, two targets of 44 px, the folded words stay readable', () => {
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // The rule whose whole selector is `sel` (not a selector list that ends with it).
  const rule = (sel, from = css) => {
    const m = new RegExp(`(?:^|[\\n}])\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`).exec(from);
    assert.ok(m, `rule ${sel}`);
    const i = m.index + m[0].length;
    return from.slice(i, from.indexOf('}', i));
  };
  const px = (s, name) => Number((s.match(new RegExp(`${name}: (\\d+)px`)) || [])[1]);
  // Portrait: beside the piles in their own row (no row of its own), hugging its content.
  assert.match(rule('.towerBar'), /order: -1; flex: 0 1 auto; min-width: 0/);
  // Landscape and desktop: its text never widens the pile column.
  const land = css.slice(css.lastIndexOf('@media (orientation: landscape) and (max-height: 540px)'));
  assert.match(land, /\.towerBar \{[^}]*contain: inline-size/);
  const desk = css.match(/@media \(min-width: 1100px\) and \(min-height: 541px\) \{[^@]*\.towerBar \{[^}]*\}/);
  assert.ok(desk, 'desktop block');
  assert.match(desk[0], /\.towerBar \{[^}]*contain: inline-size/);
  // Desktop: the card reaches over the opponents band by --tb-reach, and the chips keep clear of exactly that.
  assert.match(desk[0], /\.towerBar \{[^}]*margin: [^;]*calc\(-1 \* var\(--tb-reach\)\)/);
  assert.match(desk[0], /#table\.towerGame #opponents \{ padding-right: calc\(var\(--tb-reach\) \+ \d+px\); \}/);
  // Two targets on one spot: the card button lies on the fold button's slot of the same size.
  assert.match(rule('.tbCard, .tbFold'), /grid-area: 1 \/ 1/);
  assert.match(rule('.tbCard'), /z-index: 1;[^}]*width: var\(--tb-card-w\); height: var\(--tb-card-h\)/);
  assert.match(rule('.tbSlot'), /width: var\(--tb-card-w\); height: var\(--tb-card-h\)/);
  // ... each at least --tap-min: the card in every layout, the folded tokens' column beside it.
  for (const r of [rule('.towerBar'), rule('.towerBar', land)]) {
    assert.ok(px(r, '--tb-card-w') >= 44 && px(r, '--tb-card-h') >= 44, 'card target >= 44 px');
  }
  assert.match(rule('.tbFold'), /column-gap: 8px; min-height: var\(--tap-min\); padding-right: 6px/);
  assert.match(rule('.towerBar.tbCompact .tbFold'), /minmax\(calc\(var\(--tap-min\) - 14px\), auto\)/, 'gap 8 + padding 6 + column = 44');
  assert.match(rule('.towerBar.tbCompact .tbFold', land), /minmax\(calc\(var\(--tap-min\) - 5px\), auto\)/);
  assert.match(rule('.tbFold', land), /column-gap: 5px;[^}]*padding-right: 0/, 'gap 5 + column = 44');
  // Folded, the words leave the layout but not the accessibility tree; reduced motion: no fade.
  const hide = rule('.towerBar.tbCompact .tfCap, .towerBar.tbCompact .tfGoal, .towerBar.tbCompact .tfLbl');
  assert.match(hide, /position: absolute;[^}]*clip-path: inset\(50%\)/);
  assert.doesNotMatch(hide, /display: none/);
  const still = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .towerStart'));
  assert.match(still.slice(0, still.indexOf('}')), /\.towerBar\.tbUnfold \.tfLbl \{ animation: none;/);
  // "Ohne Ablage": the lock sits on the card, the caption stays "Ablage".
  assert.doesNotMatch(css, /#discardPile\.towerLocked \.pileLabel/);
  assert.match(rule('#discardPile.towerLocked .pileLock'), /position: absolute/);
  // Paper tokens: the red handicap edge and the gold risk, as in the Kartenhaus sheet.
  assert.match(rule('.tfTok'), /border: 1\.5px dashed var\(--paper-mod\)/);
  assert.match(rule('.tfTok.risk'), /border-color: var\(--star-edge\)/);
  assert.match(rule('.towerStart'), /--text-muted: rgba\(0, 0, 0, 0\.62\)/, 'the start card is paper: the paper muted ink');
  // The marked queen uses the coach spotlight, never the selection or draw colour.
  assert.match(rule('#hand .card.towerSpot'), /var\(--coach\)/);
});

test('style contract: the ✕ is a 44 px target in a corner of its own; hidden, nothing of the floor card shapes the table', () => {
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel, from = css) => {
    const m = new RegExp(`(?:^|[\\n}])\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`).exec(from);
    assert.ok(m, `rule ${sel}`);
    const i = m.index + m[0].length;
    return from.slice(i, from.indexOf('}', i));
  };
  const px = (s, name) => Number((s.match(new RegExp(`${name}: (\\d+)px`)) || [])[1]);
  const land = css.slice(css.lastIndexOf('@media (orientation: landscape) and (max-height: 540px)'));
  const desk = [...css.matchAll(/@media \(min-width: 1100px\) and \(min-height: 541px\) \{[^@]*/g)]
    .map((m) => m[0]).find((b) => b.includes('#table.towerGame {'));
  assert.ok(desk, 'the desktop Kartenhaus block');
  // Its own 44 px button in the bar's top right corner, above the card.
  assert.match(rule('.tbHide'), /grid-area: 1 \/ 1; justify-self: end; align-self: start; z-index: 2;/);
  assert.match(rule('.tbHide'), /width: var\(--tap-min\); height: var\(--tap-min\)/);
  // The corner stays free: folded, 44 px beside the tokens; in full, the lines it spans keep clear.
  assert.match(rule('.towerBar.tbCompact .tbFold'), /margin-right: var\(--tap-min\)/);
  assert.match(rule('.towerBar:not(.tbCompact) .tfCap, .towerBar:not(.tbCompact) .tfGoal'),
    /margin-right: calc\(var\(--tap-min\) - 6px\)/, 'the fold\'s 6 px padding + 38 = 44');
  assert.match(rule('.towerBar:not(.tbCompact) .tfGoal', land), /margin-right: var\(--tap-min\)/, 'no fold padding at ~400 px');
  // At ~400 px card, fold and ✕ sit side by side under the piles; on desktop the reach holds the ✕ too.
  assert.ok(px(rule('.towerBar', land), 'min-width') >= 3 * 44, 'three 44 px targets');
  assert.match(desk, /\n\s*\.tbFold \{ margin-right: var\(--tap-min\); \}/);
  assert.ok(px(desk.match(/#table\.towerGame \{[^}]*\}/)[0], '--tb-reach') >= 224 + 44, 'the words and the ✕');
  // Hidden drops .towerGame: every rule that reshapes the table's regions for the card hangs on it
  // (or on the start card, which hiding leaves alone). The lock on the pile is absolute: no layout.
  const regions = [...css.matchAll(/(?:^|[}\n])\s*([^{}@]+?)\s*\{/g)].map((m) => m[1].trim())
    .filter((s) => /#(table|centerPiles|opponents|melds)\b/.test(s) && /\.tower/.test(s));
  assert.ok(regions.length >= 6, `found ${regions.length} floor-card layout rules`);
  for (const s of regions) assert.match(s, /\.towerGame\b|\.towerStartOpen\b/, s);
  assert.match(rule('#discardPile.towerLocked .pileLock'), /position: absolute/);
  // Reduced motion: the gear does not turn (client.js skips the fade and the glides).
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*#settingsBtn\.towerNudge \.icon \{ animation: none; \}/);
});
