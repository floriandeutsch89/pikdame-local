/** "2 gegen 2" through the real server: creating a team table (and the one-tap
 *  start), joining and switching teams, reconnecting, the host gate, the
 *  Stammtisch refusal and the solo modes that never become team tables. */
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

/** The next message of `type` that passes `pred`. */
function next(ws, type, pred = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`no ${type}`)); }, timeoutMs);
    function onMsg(raw) {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type !== type || !pred(m)) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(m);
    }
    ws.on('message', onMsg);
  });
}

const stateWhere = (ws, pred) => next(ws, 'state', (m) => pred(m.state)).then((m) => m.state);
const teamOf = (state, id) => state.teams.findIndex((ids) => ids.includes(id));

test('server: team tables', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-teams-'));
  PORT = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('team_mode'), PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_ACCOUNTS: '0', PIKDAME_ONNX: '0' },
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

  await t.test('createSession with teamMode opens a four-seat team lobby; joiners land on the other team', async () => {
    const host = await sock();
    const joined = next(host, 'joined');
    const lobby = stateWhere(host, (s) => s.phase === 'lobby');
    host.send(JSON.stringify({ type: 'createSession', name: 'Anna', teamMode: true, tablePrefs: { botLevel: 'hard' } }));
    const { sessionCode, playerId: anna } = await joined;
    const s = await lobby;
    assert.strictEqual(s.teamMode, true);
    assert.strictEqual(s.maxSeats, 4);
    assert.strictEqual(s.players.length, 4);
    assert.strictEqual(teamOf(s, anna), 0, 'the host sits in team A');
    assert.deepStrictEqual([...new Set(s.players.filter((p) => p.isBot).map((p) => p.botDifficulty))], ['hard'], 'one level for every bot');

    const guest = await sock();
    const guestJoined = next(guest, 'joined');
    guest.send(JSON.stringify({ type: 'joinSession', code: sessionCode, name: 'Ben' }));
    const { playerId: ben, playerToken } = await guestJoined;
    const afterJoin = await stateWhere(host, (st) => st.players.some((p) => p.id === ben));
    assert.strictEqual(teamOf(afterJoin, ben), 1, 'auto-balance: Ben plays against Anna');

    const switched = stateWhere(host, (st) => teamOf(st, ben) === 0);
    guest.send(JSON.stringify({ type: 'switchTeam' }));
    const st = await switched;
    assert.strictEqual(teamOf(st, anna), 0);
    assert.strictEqual(st.players.findIndex((p) => p.id === anna), 0, 'the host keeps the seat');

    // Only the host changes the mode.
    const refused = next(guest, 'error');
    guest.send(JSON.stringify({ type: 'setTeamMode', on: false }));
    assert.match((await refused).error, /Organisator/);

    // A reconnect comes back to the very seat and team.
    guest.close();
    const again = await sock();
    const rejoined = next(again, 'joined');
    const back = stateWhere(again, () => true);
    again.send(JSON.stringify({ type: 'joinSession', code: sessionCode, name: 'Ben', playerId: ben, playerToken }));
    assert.strictEqual((await rejoined).playerId, ben);
    assert.strictEqual(teamOf(await back, ben), 0, 'same team after the reconnect');

    // The host can switch the mode off and on in the lobby.
    const off = stateWhere(host, (x) => x.teamMode === false);
    host.send(JSON.stringify({ type: 'setTeamMode', on: false }));
    assert.strictEqual((await off).teams, null);
    const on = stateWhere(host, (x) => x.teamMode === true);
    host.send(JSON.stringify({ type: 'setTeamMode', on: true }));
    assert.strictEqual((await on).players.length, 4);
  });

  await t.test('the one-tap start deals "Du + Bot gegen 2 Bots" right away', async () => {
    const ws = await sock();
    const dealt = stateWhere(ws, (s) => s.phase === 'playing' || s.phase === 'cutting');
    ws.send(JSON.stringify({ type: 'createSession', name: 'Cleo', teamMode: true, quickStart: true, tablePrefs: { botLevel: 'easy' } }));
    const s = await dealt;
    assert.strictEqual(s.teamMode, true);
    assert.strictEqual(s.players.filter((p) => !p.isBot).length, 1);
    assert.strictEqual(s.players.length, 4);
    assert.deepStrictEqual(s.teamTotals, [0, 0]);
    assert.deepStrictEqual([...new Set(s.players.filter((p) => p.isBot).map((p) => p.botDifficulty))], ['easy']);
    // quickStart alone (without teamMode) opens a plain lobby as before.
    const other = await sock();
    const lobby = stateWhere(other, () => true);
    other.send(JSON.stringify({ type: 'createSession', name: 'Dora', quickStart: true }));
    const plain = await lobby;
    assert.strictEqual(plain.phase, 'lobby');
    assert.strictEqual(plain.teamMode, false);
  });

  await t.test('a Stammtisch table refuses the team mode (its record counts every player alone)', async () => {
    const ws = await sock();
    const lobby = stateWhere(ws, (s) => s.phase === 'lobby');
    ws.send(JSON.stringify({ type: 'createStammtisch', stammtischName: 'Familie', name: 'Emil', teamMode: true }));
    assert.strictEqual((await lobby).teamMode, false, 'a new Stammtisch table is never a team table');
    const refused = next(ws, 'error');
    ws.send(JSON.stringify({ type: 'setTeamMode', on: true }));
    assert.match((await refused).error, /Stammtisch/);
  });

  await t.test('tutorial and daily challenge never become team tables', async () => {
    const tut = await sock();
    const tutState = stateWhere(tut, (s) => s.phase !== 'lobby');
    tut.send(JSON.stringify({ type: 'startTutorial', name: 'Fritz', teamMode: true }));
    const a = await tutState;
    assert.ok(a.tutorialMode);
    assert.strictEqual(a.teamMode, false);
    const refusedTut = next(tut, 'error');
    tut.send(JSON.stringify({ type: 'setTeamMode', on: true }));
    assert.match((await refusedTut).error, /Spielbeginn|freien Tischen/);

    const ch = await sock();
    const chState = stateWhere(ch, (s) => s.phase !== 'lobby');
    ch.send(JSON.stringify({ type: 'startChallenge', name: 'Gerd', teamMode: true }));
    const b = await chState;
    assert.ok(b.challengeDate);
    assert.strictEqual(b.teamMode, false);
  });
});
