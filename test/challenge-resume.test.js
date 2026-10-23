/** Daily challenge: a running attempt can always be continued, or the day is
 *  freed when the game is really gone (user report: minimised the app, came
 *  back, the tile said "schon gespielt" with no way back into the game). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { testDatabaseUrl, testPool } = require('./helpers/test-db');
const WebSocket = require('ws');
const { JSDOM, VirtualConsole } = require('jsdom');
const GameManager = require('../game/GameManager');
const { SessionRegistry } = require('../game/SessionRegistry');
const { createChallengeStore } = require('../game/ChallengeStore');
const { gameDay } = require('../game/GameDay');
const { freePort } = require('./helpers/free-port');

const ROOT = path.join(__dirname, '..');

// --- Cause 1: a restart lost the hold of a challenge whose player was online ---
test('a challenge restored from a snapshot taken while its player was online keeps waiting until midnight', () => {
  let fakeNow = Date.now();
  // A 1 s TTL stands in for the real 30 min: the hold must outlast it either way.
  const registry = new SessionRegistry(() => new GameManager(() => {}, {}), { now: () => fakeNow, emptySessionTtlMs: 1000 });
  const live = new GameManager(() => {}, { challengeDate: gameDay(), deckSeed: 7 });
  live.maybeRunBotTurn = () => {};
  live.addOrReconnectPlayer('me', 'Flo');
  live.fillWithBots();
  live.startNewRound();
  assert.strictEqual(live.players[0].connected, true, 'sanity: online when SIGTERM writes the snapshot');
  const snap = JSON.parse(JSON.stringify(live.serialize()));
  live.destroy();

  const session = registry.restore({ code: 'CHAL01', createdAt: fakeNow, lastActivity: fakeNow });
  session.game.maybeRunBotTurn = () => {};
  session.game.deserialize(snap);
  const me = session.game.players.find((p) => p.id === 'me');
  assert.strictEqual(me.connected, false);
  assert.ok(session.game.soloPausedUntil >= fakeNow + GameManager.SOLO_GRACE_MS - 1000,
    'the restored challenge announces its deadline (midnight, at least the solo grace)');
  fakeNow += 5000; // the player stays away longer than the empty-session TTL
  registry.cleanup();
  assert.strictEqual(registry.get('CHAL01'), session, 'cleanup must not reap a challenge that waits for its player');
  session.game.destroy();
});

test('a restored table re-arms the clock of every human, online at the snapshot or not', () => {
  const live = new GameManager(() => {}, { tutorialMode: true, deckSeed: 3 });
  live.maybeRunBotTurn = () => {};
  live.addOrReconnectPlayer('me', 'Flo');
  live.fillWithBots();
  live.startNewRound();
  const snap = JSON.parse(JSON.stringify(live.serialize()));
  live.destroy();
  const restored = new GameManager(() => {}, {});
  restored.maybeRunBotTurn = () => {};
  restored.deserialize(snap);
  assert.ok(restored._takeoverTimers && restored._takeoverTimers.has('me'), 'a takeover/abandon clock runs again');
  assert.ok(restored.soloPausedUntil > Date.now(), 'the solo pause deadline is announced');
  restored.destroy();
});

// --- Cause 2: a session removed while the server runs left the day "used" ---
test('a running attempt whose session is gone is freed at once, a live one stays', async (t) => {
  const cs = createChallengeStore(testPool(t, 'challenge_gone'), { legacyFile: null });
  const today = gameDay();
  await cs.beginAttempt(today, 'Gone', 'GONE01');
  await cs.beginAttempt(today, 'Live', 'LIVE01');
  assert.strictEqual(await cs.runningAttempt(today, 'gone'), 'GONE01');
  await cs.markLostAttempts({ has: (code) => code === 'LIVE01' }); // the registry, asked on demand
  assert.strictEqual(await cs.hasAttempted(today, 'Gone'), false, 'the game is gone: the day is free again');
  assert.strictEqual(await cs.runningAttempt(today, 'Gone'), null);
  assert.strictEqual(await cs.hasAttempted(today, 'Live'), true);
  assert.strictEqual(await cs.runningAttempt(today, 'Live'), 'LIVE01', 'a live game stays the attempt');
  await cs.submit(today, 'Live', 300);
  assert.strictEqual(await cs.runningAttempt(today, 'Live'), null, 'finished: no longer running');
});

// --- Real server: board says "running", a second start says so too ---------
async function startServer(dataDir, port, dbUrl) {
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: dbUrl, PORT: String(port), PIKDAME_PUBLIC_MODE: '0', PIKDAME_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.resume();
  server.stderr.resume();
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return server; } catch (e) { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${port} did not come up`);
}
async function stopServer(server) {
  if (server.exitCode !== null) return;
  const gone = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await gone;
}
const open = (port) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.inbox = [];
  ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw)));
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
});
async function waitFor(ws, pred, ms = 5000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const m = ws.inbox.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('message did not arrive');
}

test('server: a minimised challenge is reported as running, survives a restart with its hold, and is never "schon gespielt"', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-chres-'));
  const port = await freePort();
  const dbUrl = testDatabaseUrl('challenge_resume'); // one database across the restarts
  let server = await startServer(dataDir, port, dbUrl);
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const board = async () => (await fetch(`http://127.0.0.1:${port}/challengeboardz?name=Flo`)).json();

  const player = await open(port);
  player.send(JSON.stringify({ type: 'startChallenge', name: 'Flo' }));
  const code = (await waitFor(player, (m) => m.type === 'joined')).sessionCode;
  await waitFor(player, (m) => m.type === 'state' && m.state.players.length === 4);

  // Deploy while the player is online: SIGTERM snapshots, the app is killed before it reconnects.
  await stopServer(server);
  player.terminate();
  server = await startServer(dataDir, port, dbUrl);
  await stopServer(server); // the next snapshot shows what the restore kept
  const snap = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions-snapshot.json'), 'utf8'));
  const restored = snap.sessions.find((s) => s.code === code);
  assert.ok(restored, 'the challenge came back from the snapshot');
  assert.ok(restored.state.soloPausedUntil > Date.now(), 'and waits for its player (cleanup cannot reap it)');

  server = await startServer(dataDir, port, dbUrl);
  const b = await board();
  assert.strictEqual(b.attempted, true, 'the attempt counts (written to the database before the game started)');
  assert.strictEqual(b.running, true, 'the sheet learns the game is still open');
  const again = await open(port);
  again.send(JSON.stringify({ type: 'startChallenge', name: 'Flo' }));
  const err = await waitFor(again, (m) => m.type === 'error');
  assert.match(err.error, /läuft noch/, 'a second start points at the running game');
  again.close();
});

test('server: two racing starts for one name (double tap, two devices) give exactly one game', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-chrace-'));
  const port = await freePort();
  const server = await startServer(dataDir, port, testDatabaseUrl('challenge_race'));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const socks = await Promise.all([open(port), open(port), open(port)]);
  for (const s of socks) s.send(JSON.stringify({ type: 'startChallenge', name: 'Flo' }));
  const outcomes = await Promise.all(socks.map((s) => waitFor(s, (m) => m.type === 'error' || m.type === 'joined')));
  assert.strictEqual(outcomes.filter((m) => m.type === 'joined').length, 1, 'one ranked game');
  for (const m of outcomes.filter((x) => x.type === 'error')) assert.match(m.error, /läuft noch|schon gespielt/);
  for (const s of socks) s.close();
});

// --- Client: the tile finds the running challenge -----------------------------
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
function boot({ storage = {}, board = {} } = {}) {
  const errors = [];
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => (/navigation/.test(String(e.message)) ? navigations : errors).push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.fetch = (url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(String(url).includes('/challengeboardz') ? { date: '2026-10-23', players: 0, board: [], ...board } : {}),
    text: () => Promise.resolve(''),
  });
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
  window.localStorage.setItem('pikdame_player_name', 'Flo');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(ROOT, 'public', src), 'utf8'));
  const ws = sockets[sockets.length - 1];
  const doc = window.document;
  const shown = (id) => !doc.getElementById(id).classList.contains('hidden');
  const probes = () => ws.sent.filter((m) => m.type === 'checkSession').map((m) => m.code);
  return { window, doc, ws, shown, probes, errors, navigations };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const challengeStatus = (code) => ({ type: 'sessionStatus', code, exists: true, challenge: true, finished: false, seat: null });
const tableStatus = (code) => ({ type: 'sessionStatus', code, exists: true, challenge: false, finished: false, seat: null });

test('client: a later table took the last-game slot, the tile still resumes the challenge', async () => {
  const t = boot({ storage: { pikdame_last_session: 'TAB001', pikdame_challenge_session: 'CHA001' } });
  t.ws.fire('open');
  assert.deepStrictEqual(t.probes().sort(), ['CHA001', 'TAB001'], 'both games are probed');
  t.ws.fire('message', challengeStatus('CHA001'));
  t.ws.fire('message', tableStatus('TAB001'));
  assert.strictEqual(t.doc.getElementById('challengeTileStatus').textContent, 'Läuft · fortsetzen');
  assert.match(t.doc.getElementById('resumeBtn').textContent, /TAB001/, 'the other table keeps its own resume button');
  t.doc.getElementById('challengeBtn').click();
  await tick();
  assert.ok(!t.shown('challengeIntroOverlay'), 'no "schon gespielt" sheet');
  assert.strictEqual(t.navigations.length, 1, 'the tile goes straight back into the game');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('client: a tap before the probe answered waits for it instead of showing the sheet', async () => {
  const t = boot({ storage: { pikdame_last_session: 'CHA001', pikdame_challenge_session: 'CHA001' } });
  t.ws.fire('open');
  assert.deepStrictEqual(t.probes(), ['CHA001'], 'one probe for one code');
  t.doc.getElementById('challengeBtn').click();
  await tick();
  assert.ok(!t.shown('challengeIntroOverlay'), 'nothing decided before the answer');
  t.ws.fire('message', challengeStatus('CHA001'));
  await tick();
  assert.ok(!t.shown('challengeIntroOverlay'));
  assert.strictEqual(t.navigations.length, 1, 'resumed once the server confirmed the game');
  t.window.close();
});

test('client: a running attempt this device cannot reach says "läuft noch", not "schon gespielt"', async () => {
  const t = boot({ board: { attempted: true, running: true } });
  t.ws.fire('open');
  t.doc.getElementById('challengeBtn').click();
  await tick();
  await tick();
  assert.ok(t.shown('challengeIntroOverlay'));
  assert.ok(!t.shown('challengePlayedNote'), 'not "schon gespielt"');
  assert.ok(t.shown('challengeRunningNote'));
  assert.match(t.doc.getElementById('challengeRunningNote').textContent, /läuft noch/);
  assert.ok(!t.shown('challengeStartBtn'), 'no second start');
  assert.ok(!t.shown('challengeResumeBtn'), 'no resume without the game on this device');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('client: the challenge is remembered while it runs and forgotten when it is over', () => {
  const t = boot({ storage: { pikdame_player_CHA001: 'me' } });
  t.ws.fire('open');
  t.ws.fire('message', { type: 'joined', sessionCode: 'CHA001', playerId: 'me', playerToken: 'tok' });
  const gm = new GameManager(() => {}, { challengeDate: '2026-10-23', deckSeed: 5 });
  gm.maybeRunBotTurn = () => {};
  gm.addOrReconnectPlayer('me', 'Flo');
  gm.fillWithBots();
  gm.startNewRound();
  t.ws.fire('message', { type: 'state', state: gm.publicState('me') });
  assert.strictEqual(t.window.localStorage.getItem('pikdame_challenge_session'), 'CHA001');
  t.ws.fire('message', { type: 'joined', sessionCode: 'TAB001', playerId: 'me2', playerToken: 'tok2' });
  assert.strictEqual(t.window.localStorage.getItem('pikdame_challenge_session'), 'CHA001', 'another table does not overwrite it');
  t.ws.fire('message', { type: 'joined', sessionCode: 'CHA001', playerId: 'me', playerToken: 'tok' });
  t.ws.fire('message', { type: 'state', state: { ...gm.publicState('me'), phase: 'gameOver' } });
  assert.strictEqual(t.window.localStorage.getItem('pikdame_challenge_session'), null, 'over: nothing to resume');
  gm.destroy();
  t.window.close();
});
