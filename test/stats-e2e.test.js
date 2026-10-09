// End to end: a real server process, real WebSocket clients, a game played to
// the end. With Postgres the finished game must land in the tables; without a
// database the same game finishes and no stats files appear.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { hasPg, freshSchema } = require('./helpers/pg');
const { enumerateMeldOptions } = require('../game/Rules');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function startServer(port, vars) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-e2e-'));
  const proc = spawn('node', [path.join('test', 'helpers', 'fast-server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ADMIN_TOKEN: '',
      PIKDAME_SMTP_HOST: '', PIKDAME_PUBLIC_MODE: '', ...vars },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (c) => { log += c; });
  proc.stderr.on('data', (c) => { log += c; });
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const gone = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await gone;
  };
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await get(port, '/healthz')).status === 200) break; } catch (e) { /* booting */ }
    if (proc.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`server did not come up: ${log}`);
    }
    await sleep(100);
  }
  return { dataDir, stop, log: () => log };
}

function open(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.inbox = [];
    ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw)));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitFor(ws, type, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const m = ws.inbox.find((x) => x.type === type);
    if (m) return m;
    if (Date.now() - started > timeoutMs) throw new Error(`no ${type} message`);
    await sleep(25);
  }
}

const reachedGameOver = (ws) => ws.inbox.some((m) => m.type === 'state' && m.state.phase === 'gameOver');
async function waitForGameOver(ws, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (!reachedGameOver(ws) && Date.now() < deadline) await sleep(100);
  assert.ok(reachedGameOver(ws), 'the game reached gameOver');
}

// Melds with the picked-up discard card, smallest first (they spare a hand card).
function meldsWith(hand, mustId) {
  const must = hand.find((c) => c.id === mustId);
  const others = hand.filter((c) => c.id !== mustId);
  const out = [];
  const pick = (from, size, chosen) => {
    if (chosen.length === size) {
      const opts = enumerateMeldOptions([must, ...chosen]);
      if (opts.length) out.push({ cardIds: [mustId, ...chosen.map((c) => c.id)], jokerAssignments: opts[0].jokerAssignments || {} });
      return;
    }
    for (let i = from; i < others.length; i++) pick(i + 1, size, [...chosen, others[i]]);
  };
  if (must) for (let size = 2; size <= 3; size++) pick(0, size, []);
  return out;
}

// A passive player: draws, throws away a card, confirms every round. Enough for
// the bots to finish the game around it. Two ways it used to stall the table:
// an empty draw pile (the discard top must be taken and laid, family rule) and
// the server's flood guard (>25 messages/s per socket are dropped).
function autoPlay(ws, playerId) {
  let seen = 0;
  let tries = 0;
  let turnKey = '';
  let actedKey = '';
  let last = null;
  let holdUntil = 0;
  const sentAt = [];
  const myTurn = (s) => s.phase === 'playing' && s.currentPlayerId === playerId;
  const send = (o) => { sentAt.push(Date.now()); ws.send(JSON.stringify(o)); };
  // One move per (turn, attempt): repeated broadcasts of the same state must not repeat it.
  const act = (s) => {
    const turn = `${s.roundNumber}/${s.turnIndexInRound}/${s.turnPhase}/${s.mustLayOffCardId || ''}`;
    if (turn !== turnKey) { turnKey = turn; tries = 0; }
    let key = `${s.phase}/${s.roundNumber}#${tries}`;
    let move = null;
    if (s.phase === 'cutting' && s.cutterId === playerId) move = { type: 'performCut', position: 0.5 };
    else if (s.phase === 'roundEnd' && !(s.nextRoundReady || []).includes(playerId)) move = { type: 'nextRound' };
    else if (myTurn(s)) {
      key = `${turn}#${tries}`;
      const me = s.players.find((p) => p.id === playerId);
      const hand = (me && me.hand) || [];
      if (s.turnPhase === 'draw') {
        // An empty pile with an untakeable top ends the round via drawFromPile.
        move = { type: s.drawPileCount === 0 && s.discardTakeable ? 'drawFromDiscard' : 'drawFromPile' };
      } else if (s.mustLayOffCardId) {
        const meld = meldsWith(hand, s.mustLayOffCardId)[tries];
        if (meld) move = { type: 'layoutMeld', ...meld };
      } else if (hand.length && tries <= hand.length) {
        move = { type: 'discard', cardId: hand[Math.max(0, hand.length - 1 - tries)].id };
      }
    }
    if (!move || key === actedKey) return;
    actedKey = key;
    send(move);
  };
  let dirty = false;
  const timer = setInterval(() => {
    for (; seen < ws.inbox.length; seen++) {
      const m = ws.inbox[seen];
      if (m.type === 'state') { last = m.state; dirty = true; }
      // Dropped by the flood guard: resend the same move once the window has passed.
      else if (m.type === 'error' && /Zu viele Aktionen/.test(m.error)) { actedKey = ''; holdUntil = Date.now() + 1100; dirty = true; }
      // A refused move brings no new state: try the next option.
      else if (m.type === 'error') { tries++; dirty = true; }
    }
    while (sentAt.length && Date.now() - sentAt[0] >= 1000) sentAt.shift();
    if (!dirty || !last || sentAt.length >= 20 || Date.now() < holdUntil) return;
    dirty = false;
    act(last);
  }, 5);
  return () => clearInterval(timer);
}

async function finishChallenge(port, name) {
  const ws = await open(port);
  ws.send(JSON.stringify({ type: 'startChallenge', name }));
  const joined = await waitFor(ws, 'joined');
  const stop = autoPlay(ws, joined.playerId);
  try {
    await waitForGameOver(ws);
  } finally { stop(); }
  return ws;
}

test('e2e without a database: a game finishes, no stats files are written', { timeout: 150000 }, async () => {
  const srv = await startServer(18941, { PIKDAME_DATABASE_URL: '' });
  let ws = null;
  try {
    ws = await finishChallenge(18941, 'Anna');
    assert.match(srv.log(), /play-only/);
  } finally {
    if (ws) ws.close();
    await srv.stop();
  }
  const files = fs.readdirSync(srv.dataDir).filter((f) => /^(players|games|stats|challenges|stammtisch)\.json|pending-stats/.test(f));
  assert.deepEqual(files, []);
  fs.rmSync(srv.dataDir, { recursive: true, force: true });
});

test('e2e with Postgres: a finished challenge game lands in every table and in the history',
  { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL', timeout: 150000 }, async () => {
    const s = await freshSchema();
    let srv = null;
    let ws = null;
    try {
      srv = await startServer(18942, { PIKDAME_DATABASE_URL: s.url });
      ws = await finishChallenge(18942, 'Anna');
      const count = async (t) => (await s.pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      // Rows are written behind the game: poll instead of sleeping a fixed time.
      for (let i = 0; i < 100 && (await count('game_records')) === 0; i++) await sleep(100);
      assert.equal(await count('game_records'), 1);
      assert.ok((await count('game_record_players')) >= 4, 'one row per seat');
      assert.equal(await count('player_profiles'), 1);
      assert.equal((await s.pool.query('SELECT games_played FROM player_profiles')).rows[0].games_played, 1);
      assert.ok((await count('global_stats')) >= 1);
      assert.equal(await count('challenge_scores'), 1);

      ws.inbox.length = 0;
      ws.send(JSON.stringify({ type: 'getGameHistory', name: 'Anna' }));
      const history = await waitFor(ws, 'gameHistory');
      assert.equal(history.games.length, 1, 'the game comes back through getGameHistory');
    } finally {
      if (ws) ws.close();
      if (srv) { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); }
      await s.drop();
    }
  });

test('e2e with Postgres: a Stammtisch game is booked in stammtisch_games',
  { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL', timeout: 150000 }, async () => {
    const s = await freshSchema();
    let srv = null;
    const sockets = [];
    try {
      srv = await startServer(18943, { PIKDAME_DATABASE_URL: s.url });
      assert.equal((await post(18943, '/api/register-passwordless', { username: 'Flo', email: 'flo@example.org' })).status, 200);
      let code = null;
      for (let i = 0; i < 60 && !code; i++) {
        const m = srv.log().match(/Bestätigungscode (\d{6})/);
        if (m) code = m[1]; else await sleep(50);
      }
      const verified = await post(18943, '/api/verify-code', { email: 'flo@example.org', code });
      assert.equal(verified.status, 200);

      const flo = await open(18943); sockets.push(flo);
      flo.send(JSON.stringify({ type: 'createStammtisch', stammtischName: 'Familie', name: 'Flo', accountToken: verified.json.token }));
      const joinedFlo = await waitFor(flo, 'joined');
      const anna = await open(18943); sockets.push(anna);
      anna.send(JSON.stringify({ type: 'joinSession', code: joinedFlo.stammtisch.code, name: 'Anna' }));
      const joinedAnna = await waitFor(anna, 'joined');
      flo.send(JSON.stringify({ type: 'lobbyReady' }));
      anna.send(JSON.stringify({ type: 'lobbyReady' }));
      await sleep(150);
      flo.send(JSON.stringify({ type: 'startGame' }));
      const stops = [autoPlay(flo, joinedFlo.playerId), autoPlay(anna, joinedAnna.playerId)];
      try {
        await waitForGameOver(flo);
      } finally { stops.forEach((f) => f()); }
      const count = async (t) => (await s.pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      for (let i = 0; i < 100 && (await count('stammtisch_games')) === 0; i++) await sleep(100);
      assert.equal(await count('stammtisch_games'), 1);
      assert.equal(await count('stammtisch_tables'), 1);
      assert.equal(await count('game_records'), 1);
    } finally {
      for (const w of sockets) w.close();
      if (srv) { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); }
      await s.drop();
    }
  });
