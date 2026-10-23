/** A new table starts with the host's remembered lobby choices: the client
 *  sends them as tablePrefs, the server applies them only when it opens a
 *  table and only through the lobby controls' validation. Real server. */
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { testDatabaseUrl } = require('./helpers/test-db');

const ROOT = path.join(__dirname, '..');
let PORT = 0;

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

/** Sends msg and returns the first state after it that matches pred. */
function stateAfter(ws, msg, pred = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`no matching state after ${msg.type}`)); }, timeoutMs);
    function onMsg(raw) {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type !== 'state' || !pred(m.state)) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(m.state);
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify(msg));
  });
}

const botLevels = (state) => [...new Set(state.players.filter((p) => p.isBot).map((p) => p.botDifficulty))];
const PREFS = { botLevel: 'hard', houseRules: { handAusDoubles: true, strictThreshold: true, turnTimerSeconds: 60, botPace: 'slow' } };

test('tablePrefs: a new table starts with them, nothing else does', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-prefs-'));
  PORT = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('table_prefs'), PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_PUBLIC_MODE: '1', PIKDAME_ACCOUNTS: '0', PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  const exited = new Promise((r) => server.once('exit', r));
  t.after(async () => {
    for (const s of sockets) { try { s.close(); } catch (e) { /* closing */ } }
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer();
  const sock = async () => { const s = await openSocket(); sockets.push(s); return s; };

  await t.test('createSession applies them to the rules and the lobby bots', async () => {
    const s = await stateAfter(await sock(), { type: 'createSession', name: 'Anna', tablePrefs: PREFS });
    assert.deepStrictEqual(
      { handAusDoubles: s.houseRules.handAusDoubles, strictThreshold: s.houseRules.strictThreshold, turnTimerSeconds: s.houseRules.turnTimerSeconds, botPace: s.houseRules.botPace },
      PREFS.houseRules
    );
    assert.strictEqual(s.botLevel, 'hard');
    assert.deepStrictEqual(botLevels(s), ['hard'], 'the lobby bots take the remembered level');
  });

  await t.test('without prefs a table starts as before (Mittel, no timer)', async () => {
    const s = await stateAfter(await sock(), { type: 'createSession', name: 'Ben' });
    assert.strictEqual(s.botLevel, 'medium');
    assert.deepStrictEqual(botLevels(s), ['medium']);
    assert.strictEqual(s.houseRules.handAusDoubles, false);
    assert.ok(!s.houseRules.turnTimerSeconds, 'no turn timer by default');
  });

  await t.test('junk is dropped by the same validation as the lobby controls', async () => {
    const s = await stateAfter(await sock(), {
      type: 'createSession', name: 'Cleo',
      tablePrefs: { botLevel: 'godmode', houseRules: { handAusDoubles: 'yes', turnTimerSeconds: 45, botPace: 'warp', evil: 1 } },
    });
    assert.strictEqual(s.botLevel, 'medium');
    assert.deepStrictEqual(botLevels(s), ['medium']);
    assert.strictEqual(s.houseRules.handAusDoubles, false);
    assert.ok(!s.houseRules.turnTimerSeconds);
    assert.ok(!('evil' in s.houseRules), 'unknown keys never reach the rules');
    assert.notStrictEqual(s.houseRules.botPace, 'warp');
    // Not even an object: ignored, the table still opens.
    const t2 = await stateAfter(await sock(), { type: 'createSession', name: 'Dora', tablePrefs: 'hard' });
    assert.strictEqual(t2.botLevel, 'medium');
  });

  await t.test('joining an existing table never changes its rules', async () => {
    const host = await sock();
    const joined = next(host, 'joined');
    const hostState = await stateAfter(host, { type: 'createSession', name: 'Emil' });
    const { sessionCode } = await joined;
    assert.strictEqual(hostState.botLevel, 'medium');
    const s = await stateAfter(await sock(), { type: 'joinSession', code: sessionCode, name: 'Fritz', tablePrefs: PREFS });
    assert.strictEqual(s.botLevel, 'medium');
    assert.strictEqual(s.houseRules.handAusDoubles, false);
  });

  await t.test('a new Stammtisch table starts with them too', async () => {
    const s = await stateAfter(await sock(), { type: 'createStammtisch', stammtischName: 'Familie', name: 'Gerda', tablePrefs: PREFS });
    assert.strictEqual(s.botLevel, 'hard');
    assert.strictEqual(s.houseRules.turnTimerSeconds, 60);
  });

  await t.test('the daily challenge ignores them (comparable leaderboard)', async () => {
    // The first state is the bare lobby; the dealt game follows right after.
    const s = await stateAfter(await sock(), { type: 'startChallenge', name: 'Hans', tablePrefs: PREFS }, (st) => st.phase !== 'lobby');
    assert.ok(s.challengeDate, 'precondition: a challenge game');
    assert.strictEqual(s.houseRules.turnTimerSeconds, 0);
    assert.strictEqual(s.houseRules.handAusDoubles, false);
    assert.deepStrictEqual(botLevels(s), ['medium']);
  });
});

test('setHouseRules: botPace takes only its own keys, never inherited ones', () => {
  const GameManager = require('../game/GameManager');
  const game = new GameManager(() => {});
  const before = game.houseRules.botPace;
  for (const pace of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    game.setHouseRules({ botPace: pace });
    assert.strictEqual(game.houseRules.botPace, before, pace);
  }
  game.setHouseRules({ botPace: 'slow' });
  assert.strictEqual(game.houseRules.botPace, 'slow');
});
