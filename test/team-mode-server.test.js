/** "2 gegen 2" through the real server: creating a team table (and the start-screen
 *  tile's lobby), joining and switching teams, reconnecting, the host gate, the
 *  Stammtisch refusal, the solo modes that never become team tables, and a
 *  finished team match booked for both teammates. */
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const GameManager = require('../game/GameManager');
const { xpForGame } = require('../game/Progression');
const { testDatabaseUrl } = require('./helpers/test-db');

const ROOT = path.join(__dirname, '..');

// Ports are passed, never shared: the two top-level tests may run at once.
async function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 500 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${port} did not come up within ${timeoutMs}ms`);
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
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
  const port = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('team_mode'), PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ACCOUNTS: '0', PIKDAME_ONNX: '0' },
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
  await waitForServer(port);
  const sock = async () => { const s = await openSocket(port); sockets.push(s); return s; };

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
    assert.strictEqual(s.targetScore, 2000, 'a team plays to 2000');
    assert.deepStrictEqual(s.teamNames, [null, null]);
    assert.strictEqual(teamOf(s, anna), 0, 'the host sits in team A');
    assert.deepStrictEqual([...new Set(s.players.filter((p) => p.isBot).map((p) => p.botDifficulty))], ['hard'], 'one level for every bot');

    const guest = await sock();
    const guestJoined = next(guest, 'joined');
    // Listen before the join: the host's state can arrive before the guest's 'joined'.
    const hostSeesBen = stateWhere(host, (st) => st.players.some((p) => !p.isBot && p.name === 'Ben'));
    guest.send(JSON.stringify({ type: 'joinSession', code: sessionCode, name: 'Ben' }));
    const { playerId: ben, playerToken } = await guestJoined;
    const afterJoin = await hostSeesBen;
    assert.strictEqual(teamOf(afterJoin, ben), 1, 'auto-balance: Ben plays against Anna');

    const switched = stateWhere(host, (st) => teamOf(st, ben) === 0);
    guest.send(JSON.stringify({ type: 'switchTeam' }));
    const st = await switched;
    assert.strictEqual(teamOf(st, anna), 0);
    assert.strictEqual(st.players.findIndex((p) => p.id === anna), 0, 'the host keeps the seat');

    // Any human of a team names it; every seat gets the cleaned name.
    const named = stateWhere(host, (x) => Array.isArray(x.teamNames) && x.teamNames[0] !== null);
    guest.send(JSON.stringify({ type: 'setTeamName', teamName: '  Die   Löwen<b>' }));
    assert.deepStrictEqual((await named).teamNames, ['Die Löwenb', null], 'cleaned like a player name');
    const renamed = stateWhere(host, (x) => x.teamNames && x.teamNames[0] === 'Die Löwen');
    host.send(JSON.stringify({ type: 'setTeamName', teamName: 'Die Löwen' }));
    await renamed;

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
    const backState = await back;
    assert.strictEqual(teamOf(backState, ben), 0, 'same team after the reconnect');
    assert.deepStrictEqual(backState.teamNames, ['Die Löwen', null], 'and the team name');

    // The host can switch the mode off and on in the lobby.
    const off = stateWhere(host, (x) => x.teamMode === false);
    host.send(JSON.stringify({ type: 'setTeamMode', on: false }));
    assert.strictEqual((await off).teams, null);
    const on = stateWhere(host, (x) => x.teamMode === true);
    host.send(JSON.stringify({ type: 'setTeamMode', on: true }));
    const onState = await on;
    assert.strictEqual(onState.players.length, 4);
    assert.deepStrictEqual(onState.teamNames, [null, null], 'a new team table starts without names');
  });

  await t.test('the start-screen tile opens a team lobby first; starting there deals "2 gegen 2" with bots', async () => {
    const ws = await sock();
    let latest = null;
    ws.on('message', (raw) => { try { const m = JSON.parse(raw); if (m.type === 'state') latest = m.state; } catch (e) { /* not JSON */ } });
    const lobby = stateWhere(ws, (s) => s.phase === 'lobby');
    // An old client's quickStart is ignored: no table deals before the lobby any more.
    ws.send(JSON.stringify({ type: 'createSession', name: 'Cleo', teamMode: true, quickStart: true, tablePrefs: { botLevel: 'easy' } }));
    const s = await lobby;
    assert.strictEqual(s.teamMode, true, '"2 gegen 2" preselected');
    assert.strictEqual(s.players.filter((p) => !p.isBot).length, 1);
    assert.strictEqual(s.players.length, 4, 'bots on the free seats');
    assert.deepStrictEqual([...new Set(s.players.filter((p) => p.isBot).map((p) => p.botDifficulty))], ['easy'], 'the remembered level');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(latest.phase, 'lobby', 'it waits for the host');

    const dealt = stateWhere(ws, (st) => st.phase === 'playing' || st.phase === 'cutting');
    ws.send(JSON.stringify({ type: 'startGame' }));
    const d = await dealt;
    assert.strictEqual(d.teamMode, true);
    assert.deepStrictEqual([d.players.length, d.targetScore], [4, 2000]);
    assert.deepStrictEqual(d.teamTotals, [0, 0]);
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

  await t.test('the Kartenhaus never becomes a team table', async () => {
    const ws = await sock();
    const playing = stateWhere(ws, (s) => s.phase === 'playing');
    ws.send(JSON.stringify({ type: 'startTower', stage: 1, name: 'Hanna', teamMode: true }));
    const s = await playing;
    assert.strictEqual(s.towerStage, 1);
    assert.strictEqual(s.teamMode, false);
    assert.strictEqual(s.players.length, 3, 'the floor keeps its own seats');
    const refused = next(ws, 'error');
    ws.send(JSON.stringify({ type: 'setTeamMode', on: true }));
    assert.match((await refused).error, /Organisator|Spielbeginn|freien Tischen/);
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

/** A team match a few turns before its end: Anna and Ben (team A, far ahead)
 *  against Cleo and a bot. Built by the real engine, then snapshotted. */
function nearlyFinishedTeamMatch() {
  const g = new GameManager(() => {}, { teamMode: true, deckSeed: 4242 });
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer('pa', 'Anna');
  g.syncLobbyBots();
  g.addOrReconnectPlayer('pc', 'Cleo');
  g.addOrReconnectPlayer('pb', 'Ben');
  assert.deepStrictEqual(g.teams().map((ids) => ids.filter((id) => !id.startsWith('bot-'))), [['pa', 'pb'], ['pc']]);
  g.setAllBotsDifficulty('medium');
  g.setHouseRules({ botPace: 'fast' });
  g.setTeamName('pb', 'Die Löwen');
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  Object.assign(g.totals, { pa: 1800, pb: 1800, pc: 200 }); // no round can stop team A now
  const states = [];
  for (let i = 0; i < 4000 && g.phase === 'playing'; i++) {
    states.push(JSON.stringify(g.serialize()));
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !g.isBotControlled(cp) });
  }
  assert.strictEqual(g.phase, 'gameOver', 'precondition: this round ends the match');
  g.destroy();
  return JSON.parse(states[Math.max(0, states.length - 3)]);
}

test('server: a finished team match books a win for both teammates through the async booking', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-teams-book-'));
  const now = Date.now();
  // A restart restores the table; its humans are offline, so stand-ins finish the round.
  fs.writeFileSync(path.join(dataDir, 'sessions-snapshot.json'), JSON.stringify({
    savedAt: now,
    sessions: [{ code: 'TEAMAB', createdAt: now, lastActivity: now, playerTokens: { pa: 'tok-a', pb: 'tok-b', pc: 'tok-c' }, stammtisch: null, state: nearlyFinishedTeamMatch() }],
    puzzleAttempts: [],
  }));
  const port = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('team_book'), PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ACCOUNTS: '0', PIKDAME_PUBLIC_MODE: '0', PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.resume();
  server.stderr.resume();
  const sockets = [];
  const exited = new Promise((r) => server.once('exit', r));
  t.after(async () => {
    for (const s of sockets) { try { s.close(); } catch (e) { /* closing */ } }
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(port);
  const ws = await openSocket(port);
  sockets.push(ws);
  const profile = async (name) => {
    const reply = next(ws, 'profiles');
    ws.send(JSON.stringify({ type: 'listProfiles', name }));
    return (await reply).players.find((p) => p.name === name) || null;
  };
  // Booked: the badges, the chain's last step, are on the profile.
  let ben = null;
  for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
    ben = await profile('Ben');
    if (ben && ben.gamesPlayed === 1 && ben.badges && ben.badges.first_win) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ben && ben.gamesPlayed === 1, 'the match was booked');

  const history = next(ws, 'gameHistory');
  ws.send(JSON.stringify({ type: 'getGameHistory', name: 'Anna' }));
  const [game] = (await history).games;
  assert.strictEqual(game.teamMode, true);
  assert.deepStrictEqual(game.teamNames, ['Die Löwen', null], 'the team name lives on in "Meine Partien"');
  assert.strictEqual(game.targetScore, 2000);
  assert.deepStrictEqual(game.winnerIds.slice().sort(), ['pa', 'pb']);
  assert.strictEqual(game.won, true);
  for (const [name, id, won] of [['Anna', 'pa', true], ['Ben', 'pb', true], ['Cleo', 'pc', false]]) {
    const p = await profile(name);
    assert.strictEqual(p.gamesPlayed, 1, `${name}: one match`);
    assert.strictEqual(p.gamesWon, won ? 1 : 0, `${name}: ${won ? 'a team win counts for both' : 'the losing team lost'}`);
    assert.strictEqual(p.xp, xpForGame(game, id), `${name}: XP from the own total${won ? ' plus the win bonus' : ''}`);
    assert.strictEqual(!!(p.badges && p.badges.first_win), won, `${name}: first win badge`);
  }
});
