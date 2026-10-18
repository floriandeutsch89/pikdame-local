/** One game at a time, server side: the start screen learns about its seat
 *  via checkSession and gives the game up via abandonSession. A stale code
 *  or a wrong token gets the same quiet answer and never counts as a failed
 *  join (that would block the IP like code guessing does). Real server. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { testDatabaseUrl } = require('./helpers/test-db');

const ROOT = path.join(__dirname, '..');
const PORT = 8099;

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 500 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${PORT} did not come up within ${timeoutMs}ms`);
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => reject(new Error('socket did not open')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function next(ws, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`no ${type}`)); }, timeoutMs);
    function onMsg(raw) {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(m);
    }
    ws.on('message', onMsg);
  });
}

async function ask(ws, msg, replyType) {
  const reply = next(ws, replyType);
  ws.send(JSON.stringify(msg));
  return reply;
}

test('abandonSession: seat status, quiet stale codes, a given-up seat stays a bot', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-abandon-'));
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('abandon_session'), PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_PUBLIC_MODE: '1', PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) { try { s.close(); } catch (e) { /* closing */ } }
    // SIGTERM still writes the snapshot: removing the dir before exit raced (ENOTEMPTY).
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer();

  const anna = await openSocket();
  const ben = await openSocket();
  sockets.push(anna, ben);
  const a = await ask(anna, { type: 'createSession', name: 'Anna' }, 'joined');
  const b = await ask(ben, { type: 'joinSession', code: a.sessionCode, name: 'Ben' }, 'joined');
  for (const ws of [anna, ben]) ws.send(JSON.stringify({ type: 'lobbyReady' }));
  await new Promise((r) => setTimeout(r, 150));
  anna.send(JSON.stringify({ type: 'startGame' }));
  await new Promise((r) => setTimeout(r, 300));

  // The start screen (a fresh socket) asks about Ben's seat with his token.
  const home = await openSocket();
  sockets.push(home);
  const status = await ask(home, { type: 'checkSession', code: a.sessionCode, playerId: b.playerId, playerToken: b.playerToken }, 'sessionStatus');
  assert.strictEqual(status.exists, true);
  assert.ok(['cutting', 'playing'].includes(status.seat.phase), `running: ${status.seat.phase}`);
  assert.strictEqual(status.seat.alone, false);
  assert.strictEqual(status.seat.left, false);
  const noToken = await ask(home, { type: 'checkSession', code: a.sessionCode, playerId: b.playerId }, 'sessionStatus');
  assert.strictEqual(noToken.seat, null, 'no seat details without the token');

  // More stale codes than the failed-join limit: same quiet answer, no block.
  // Paced below the per-socket flood limit (25 messages a second).
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 60));
    const r = await ask(home, { type: 'abandonSession', code: `ZZ${String(i).padStart(4, '0')}`, playerId: 'p-x', playerToken: 'nope', name: 'Ben' }, 'sessionAbandoned');
    assert.strictEqual(r.outcome, 'none');
  }
  const wrong = await ask(home, { type: 'abandonSession', code: a.sessionCode, playerId: b.playerId, playerToken: 'wrong', name: 'Ben' }, 'sessionAbandoned');
  assert.strictEqual(wrong.outcome, 'none', 'a wrong token looks exactly like a stale code');
  assert.strictEqual(home.readyState, WebSocket.OPEN, 'not blocked like a code guesser');

  // The real thing: Ben's other tab (still seated) is told, the seat goes to a bot.
  const toldBen = next(ben, 'sessionAbandoned');
  const done = await ask(home, { type: 'abandonSession', code: a.sessionCode, playerId: b.playerId, playerToken: b.playerToken, name: 'Ben' }, 'sessionAbandoned');
  assert.strictEqual(done.outcome, 'left');
  assert.strictEqual((await toldBen).outcome, 'left');
  const err = next(ben, 'error');
  ben.send(JSON.stringify({ type: 'togglePause' }));
  assert.match((await err).error, /aufgegeben/, 'the old tab may not act for the bot');

  // No way back in, not even with the right token.
  const again = await openSocket();
  sockets.push(again);
  const refused = await ask(again, { type: 'joinSession', code: a.sessionCode, playerId: b.playerId, playerToken: b.playerToken, name: 'Ben' }, 'error');
  assert.match(refused.error, /aufgegeben/);
  const after = await ask(home, { type: 'checkSession', code: a.sessionCode, playerId: b.playerId, playerToken: b.playerToken }, 'sessionStatus');
  assert.strictEqual(after.seat.left, true);
  const twice = await ask(home, { type: 'abandonSession', code: a.sessionCode, playerId: b.playerId, playerToken: b.playerToken, name: 'Ben' }, 'sessionAbandoned');
  assert.strictEqual(twice.outcome, 'none', 'idempotent');

  // Anna, now alone with bots, ends the match by giving up.
  const annaStatus = await ask(home, { type: 'checkSession', code: a.sessionCode, playerId: a.playerId, playerToken: a.playerToken }, 'sessionStatus');
  assert.strictEqual(annaStatus.seat.alone, true);
  const ended = await ask(home, { type: 'abandonSession', code: a.sessionCode, playerId: a.playerId, playerToken: a.playerToken, name: 'Anna' }, 'sessionAbandoned');
  assert.strictEqual(ended.outcome, 'ended');
  const finished = await ask(home, { type: 'checkSession', code: a.sessionCode }, 'sessionStatus');
  assert.strictEqual(finished.finished, true);
});
