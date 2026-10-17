/** One game at a time, client side: with an open game on this device every way
 *  into ANOTHER table asks first (sheet + two taps), the same table resumes,
 *  the challenge stays separate and an open tutorial never blocks. Boots the
 *  REAL markup and client in jsdom with a scripted WebSocket. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const GameManager = require('../game/GameManager');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot({ storage = {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
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
  return { window, doc, ws, sent, shown, errors };
}

const OPEN_GAME = {
  pikdame_last_session: 'ABC123',
  pikdame_player_ABC123: 'p-ben',
  pikdame_token_ABC123: 'tok-ben',
};
const seat = (over = {}) => ({ phase: 'playing', round: 3, score: 420, left: false, alone: false, tutorial: false, stammtisch: null, ...over });

/** Start screen with the open game ABC123 confirmed by the server. */
function withOpenGame(seatOver, storage = {}) {
  const t = boot({ storage: { ...OPEN_GAME, ...storage } });
  t.ws.fire('open');
  t.ws.fire('message', { type: 'sessionStatus', code: 'ABC123', exists: true, challenge: false, finished: false, seat: seat(seatOver) });
  return t;
}

test('the start screen asks the server about its seat and puts "back to the game" first', () => {
  const t = boot({ storage: OPEN_GAME });
  t.ws.fire('open');
  const probe = t.sent('checkSession')[0];
  assert.deepStrictEqual({ code: probe.code, playerId: probe.playerId, playerToken: probe.playerToken },
    { code: 'ABC123', playerId: 'p-ben', playerToken: 'tok-ben' });
  t.ws.fire('message', { type: 'sessionStatus', code: 'ABC123', exists: true, challenge: false, finished: false, seat: seat() });
  assert.ok(t.doc.getElementById('sessionSetup').classList.contains('hasOpenGame'));
  assert.ok(t.doc.getElementById('resumeBtn').classList.contains('btn-primary'));
  assert.ok(t.doc.getElementById('createGameBtn').classList.contains('btn-secondary'));
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('new game: the sheet asks, two taps give the old game up, then the new one starts', () => {
  const t = withOpenGame();
  t.doc.getElementById('createGameBtn').click();
  assert.strictEqual(t.sent('createSession').length, 0, 'nothing starts behind the sheet');
  assert.ok(t.shown('openGameOverlay'));
  assert.match(t.doc.getElementById('openGameSummary').textContent, /ABC123 · Runde 3 · 420 Punkte/);
  assert.match(t.doc.getElementById('openGameConsequence').textContent, /Ein Bot übernimmt deinen Platz bis zum Ende/);
  const giveUp = t.doc.getElementById('openGameGiveUpBtn');
  assert.strictEqual(giveUp.textContent.trim(), 'Aufgeben & neues Spiel');
  giveUp.click();
  assert.strictEqual(t.sent('abandonSession').length, 0, 'the first tap only arms');
  assert.strictEqual(giveUp.textContent.trim(), 'Wirklich?');
  giveUp.click();
  const abandon = t.sent('abandonSession')[0];
  assert.deepStrictEqual({ code: abandon.code, playerId: abandon.playerId, playerToken: abandon.playerToken },
    { code: 'ABC123', playerId: 'p-ben', playerToken: 'tok-ben' });
  t.ws.fire('message', { type: 'sessionAbandoned', code: 'ABC123', outcome: 'left' });
  assert.ok(!t.shown('openGameOverlay'));
  assert.strictEqual(t.sent('createSession').length, 1, 'the original action runs');
  for (const key of Object.keys(OPEN_GAME)) assert.strictEqual(t.window.localStorage.getItem(key), null, `${key} forgotten`);
  assert.ok(!t.doc.getElementById('sessionSetup').classList.contains('hasOpenGame'));
  t.window.close();
});

test('the sheet names the consequence: alone, in the lobby, cancel keeps everything', () => {
  const alone = withOpenGame({ alone: true });
  alone.doc.getElementById('createGameBtn').click();
  assert.strictEqual(alone.doc.getElementById('openGameConsequence').textContent, 'Die Partie endet und wird nicht gewertet.');
  alone.doc.getElementById('openGameCancelBtn').click();
  assert.ok(!alone.shown('openGameOverlay'));
  assert.strictEqual(alone.sent('createSession').length + alone.sent('abandonSession').length, 0);
  assert.strictEqual(alone.window.localStorage.getItem('pikdame_last_session'), 'ABC123', 'cancel forgets nothing');
  alone.window.close();

  const lobby = withOpenGame({ phase: 'lobby', round: 0 });
  lobby.doc.getElementById('createGameBtn').click();
  assert.strictEqual(lobby.doc.getElementById('openGameGiveUpBtn').textContent.trim(), 'Lobby verlassen & neues Spiel');
  assert.match(lobby.doc.getElementById('openGameSummary').textContent, /noch in der Lobby/);
  lobby.window.close();
});

test('joining: the same code resumes, another code asks first', () => {
  const t = withOpenGame();
  t.doc.getElementById('codeInput').value = 'abc123';
  t.doc.getElementById('joinGameBtn').click();
  const rejoin = t.sent('joinSession')[0];
  assert.strictEqual(rejoin.code, 'ABC123');
  assert.strictEqual(rejoin.playerId, 'p-ben', 'own seat, own token');
  assert.ok(!t.shown('openGameOverlay'));

  t.doc.getElementById('codeInput').value = 'XYZ789';
  t.doc.getElementById('joinGameBtn').click();
  assert.strictEqual(t.sent('joinSession').length, 1, 'no second join behind the sheet');
  assert.ok(t.shown('openGameOverlay'));
  assert.strictEqual(t.doc.getElementById('openGameGiveUpBtn').textContent.trim(), 'Aufgeben & beitreten');
  t.window.close();
});

test('Stammtisch: its own table resumes, another one asks first', () => {
  const recent = JSON.stringify([{ code: 'STHOME', name: 'Familie' }, { code: 'STOTHR', name: 'Kegelclub' }]);
  const t = withOpenGame({ stammtisch: 'STHOME' }, { pikdame_stammtische: recent });
  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  assert.strictEqual(t.sent('joinSession').length, 1, 'the open game IS this Stammtisch table');
  t.doc.querySelector('#stammtischRecent button[data-code="STOTHR"]').click();
  assert.strictEqual(t.sent('joinSession').length, 1);
  assert.ok(t.shown('openGameOverlay'));
  t.window.close();
});

test('the tutorial is gated, the daily challenge stays separate', () => {
  const t = withOpenGame();
  t.doc.getElementById('tutorialBtn').click();
  assert.strictEqual(t.sent('startTutorial').length, 0);
  assert.strictEqual(t.doc.getElementById('openGameGiveUpBtn').textContent.trim(), 'Aufgeben & Tutorial');
  t.doc.getElementById('openGameCancelBtn').click();

  t.doc.getElementById('challengeBtn').click();
  assert.ok(t.shown('challengeIntroOverlay'));
  assert.ok(!t.shown('openGameOverlay'));
  t.doc.getElementById('challengeStartBtn').click();
  assert.strictEqual(t.sent('startChallenge').length, 1, 'no question for the challenge');
  t.window.close();
});

test('an open tutorial never blocks: it is ended quietly, then the new game starts', () => {
  const t = withOpenGame({ tutorial: true });
  assert.ok(!t.doc.getElementById('sessionSetup').classList.contains('hasOpenGame'), 'practice is not "the" open game');
  t.doc.getElementById('createGameBtn').click();
  assert.ok(!t.shown('openGameOverlay'), 'no question');
  assert.strictEqual(t.sent('abandonSession').length, 1);
  assert.strictEqual(t.sent('createSession').length, 0, 'waits for the server');
  t.ws.fire('message', { type: 'sessionAbandoned', code: 'ABC123', outcome: 'ended' });
  assert.strictEqual(t.sent('createSession').length, 1);
  t.window.close();
});

test('a tap before the server answered waits for it; no seat means no question', async () => {
  const t = boot({ storage: OPEN_GAME });
  t.ws.fire('open');
  t.doc.getElementById('createGameBtn').click();
  assert.strictEqual(t.sent('createSession').length, 0, 'held back while the probe runs');
  t.ws.fire('message', { type: 'sessionStatus', code: 'ABC123', exists: true, challenge: false, finished: false, seat: seat() });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(t.shown('openGameOverlay'), 'the held tap asks now');
  t.window.close();

  const free = boot({ storage: OPEN_GAME });
  free.ws.fire('open');
  free.ws.fire('message', { type: 'sessionStatus', code: 'ABC123', exists: true, challenge: false, finished: false, seat: null });
  free.doc.getElementById('createGameBtn').click();
  assert.strictEqual(free.sent('createSession').length, 1, 'a seat this device does not hold blocks nothing');
  free.window.close();
});

test('a seat given up elsewhere is forgotten; the table shows who left', () => {
  const t = boot({ storage: OPEN_GAME });
  t.ws.fire('open');
  t.ws.fire('message', { type: 'sessionStatus', code: 'ABC123', exists: true, challenge: false, finished: false, seat: seat({ left: true }) });
  assert.strictEqual(t.window.localStorage.getItem('pikdame_last_session'), null);
  t.doc.getElementById('createGameBtn').click();
  assert.strictEqual(t.sent('createSession').length, 1);

  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Kai');
  g.fillWithBots();
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  g.abandonSeat('p2');
  t.ws.fire('message', { type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
  t.ws.fire('message', { type: 'state', state: g.publicState('p1') });
  const chip = [...t.doc.querySelectorAll('.opponent')].find((d) => /Kai/.test(d.textContent));
  assert.ok(chip, 'Kai has a chip');
  assert.match(chip.textContent, /hat verlassen/);
  assert.doesNotMatch(chip.textContent, /getrennt/);
  g.destroy();
  t.window.close();
});

test('solo tables are honest: the tutorial resumes as such, the home dialog says what happens', () => {
  const t = withOpenGame({ tutorial: true });
  assert.strictEqual(t.doc.getElementById('resumeBtn').textContent.trim(), 'Tutorial fortsetzen');
  t.window.close();

  const visibleHomeText = (opts) => {
    const v = boot();
    v.ws.fire('open');
    const g = new GameManager(() => {}, opts);
    g.addOrReconnectPlayer('p1', 'Ben');
    g.fillWithBots();
    g.startNewRound();
    if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
    v.ws.fire('message', { type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
    v.ws.fire('message', { type: 'state', state: g.publicState('p1') });
    v.doc.getElementById('homeBtn').click();
    const text = [...v.doc.querySelectorAll('#homeOverlay p')].filter((n) => !n.classList.contains('hidden')).map((n) => n.textContent).join(' ');
    g.destroy();
    v.window.close();
    return text;
  };
  assert.match(visibleHomeText({}), /Ein neues kannst du erst starten, wenn du dieses aufgibst/);
  const tutorial = visibleHomeText({ tutorialMode: true });
  assert.match(tutorial, /Das Tutorial wartet kurz auf dich/);
  assert.doesNotMatch(tutorial, /übernimmt ein Bot/, 'no bot takes over a solo table');
  assert.match(visibleHomeText({ challengeDate: '2026-03-09' }), /Die Challenge wartet bis Mitternacht/);
});
