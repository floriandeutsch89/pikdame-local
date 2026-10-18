/** Daily puzzle XP for the account and its season (like the bot tower's first
 *  star): the signed-in owner's first solve of the day books lifetime and season
 *  XP without a game; a guest keeps the profile XP, archive days pay nothing and
 *  a second solve books nothing twice. Real server, temp data dir. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { createAccountStore } = require('../game/AccountStore');
const { puzzleForDate, XP_FOR_SOLVED, PUZZLE_EPOCH } = require('../game/DailyPuzzle');
const { gameDay, addDays } = require('../game/GameDay');

const PORT = 8140;
const probe = createAccountStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-pxp-probe-')), 'probe.db'));
const HAS_SQLITE = probe !== null;
if (probe) probe.close();

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

function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(data)); } });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('puzzle XP: the owner\'s first solve counts for account and season, a guest, the archive and a repeat do not', { skip: !HAS_SQLITE }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-pxp-'));
  const accounts = createAccountStore(path.join(dataDir, 'users.db'));
  accounts.verifyEmail(accounts.register('Ada', 'ada@example.com', 'geheim123').verifyToken);
  accounts.verifyEmail(accounts.register('Cleo', 'cleo@example.com', 'geheim123').verifyToken);
  const token = accounts.login('Ada', 'geheim123').token;
  const cleoToken = accounts.login('Cleo', 'geheim123').token;
  accounts.close();
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_PUBLIC_MODE: '0', PIKDAME_ONNX: '0' },
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

  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://localhost:${PORT}`);
    s.inbox = [];
    s.on('message', (raw) => s.inbox.push(JSON.parse(raw)));
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  sockets.push(ws);
  /** Sends and waits for `type`; `after` lists what else came in shortly after. */
  const ask = async (msg, type) => {
    const before = ws.inbox.length;
    ws.send(JSON.stringify(msg));
    for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
      const hit = ws.inbox.slice(before).find((m) => m.type === type);
      if (hit) {
        await new Promise((r) => setTimeout(r, 300)); // room for the account booking
        return { hit, after: ws.inbox.slice(before).map((m) => m.type) };
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no ${type}`);
  };
  const ladderMe = async (tok = token) => (await postJson('/api/ladder', { token: tok })).me;
  const today = gameDay();
  const solution = (date) => puzzleForDate(date).best.melds;

  // The archive pays nothing, with or without an account.
  const past = addDays(today, -3) < PUZZLE_EPOCH ? PUZZLE_EPOCH : addDays(today, -3);
  if (past !== today) {
    const archive = await ask({ type: 'solvePuzzle', name: 'Ada', date: past, melds: solution(past), accountToken: token }, 'puzzleResult');
    assert.strictEqual(archive.hit.solved, true);
    assert.strictEqual(archive.hit.xp, 0, 'the archive earns no XP');
    assert.ok(!archive.after.includes('accountProgress'), 'nor books the account');
    assert.deepStrictEqual([(await ladderMe()).xp, (await ladderMe()).seasonXp], [0, 0]);
  }

  // The signed-in owner: profile, account and season, no game counted.
  const first = await ask({ type: 'solvePuzzle', name: 'Ada', melds: solution(today), accountToken: token }, 'puzzleResult');
  assert.strictEqual(first.hit.xp, XP_FOR_SOLVED);
  const booked = ws.inbox.find((m) => m.type === 'accountProgress');
  assert.ok(booked, 'the account progress follows the result');
  assert.deepStrictEqual([booked.progress.xp, booked.progress.seasonXp, booked.progress.games], [XP_FOR_SOLVED, XP_FOR_SOLVED, 0]);
  const me = await ladderMe();
  assert.deepStrictEqual([me.xp, me.seasonXp, me.games], [XP_FOR_SOLVED, XP_FOR_SOLVED, 0], 'stored: account and season XP, no game');

  // A second solve of the same day books nothing twice.
  const second = await ask({ type: 'solvePuzzle', name: 'Ada', melds: solution(today), accountToken: token }, 'puzzleResult');
  assert.strictEqual(second.hit.xp, 0);
  assert.ok(!second.after.includes('accountProgress'));
  assert.strictEqual((await ladderMe()).seasonXp, XP_FOR_SOLVED, 'still booked once');

  // A guest earns the profile XP only.
  const guest = await ask({ type: 'solvePuzzle', name: 'Ben', melds: solution(today) }, 'puzzleResult');
  assert.strictEqual(guest.hit.xp, XP_FOR_SOLVED, 'the profile gets it');
  assert.ok(!guest.after.includes('accountProgress'), 'no account to book');

  // A registered name without its owner's login token books no account: nobody writes to someone else's.
  const unsigned = await ask({ type: 'solvePuzzle', name: 'Cleo', melds: solution(today) }, 'puzzleResult');
  assert.strictEqual(unsigned.hit.xp, XP_FOR_SOLVED);
  assert.ok(!unsigned.after.includes('accountProgress'));
  assert.deepStrictEqual([(await ladderMe(cleoToken)).xp, (await ladderMe(cleoToken)).seasonXp], [0, 0]);
  const cleo = await ask({ type: 'getPuzzle', name: 'Cleo' }, 'puzzle');
  assert.strictEqual(cleo.hit.status.solved, true, 'the profile still remembers the solve');

  const players = (await ask({ type: 'listProfiles' }, 'profiles')).hit.players;
  assert.strictEqual(players.find((p) => p.name === 'Ben').xp, XP_FOR_SOLVED);
  assert.strictEqual(players.find((p) => p.name === 'Ada').xp, XP_FOR_SOLVED, 'the profile once, too');
});
