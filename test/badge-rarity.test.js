/** Badge rarity (game/BadgeRarity.js): the share of players holding each badge, counted
 *  over confirmed accounts that played in any mode (a match, a daily puzzle, a Kartenhaus
 *  floor). Guests, accounts that never played and unconfirmed sign-ups are left out; under
 *  20 such accounts nothing is shown; a timer refreshes the cached shares, and a failed
 *  refresh never throws. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const WebSocket = require('ws');
const { BADGE_IDS } = require('../game/Badges');
const { createPlayerStore } = require('../game/PlayerStore');
const { createPgAccountStore } = require('../game/PgAccountStore');
const {
  createBadgeRarity, rarityFromRows, percentOf, RARITY_SQL, RARITY_MIN_PLAYERS, RARE_BELOW_PERCENT,
} = require('../game/BadgeRarity');
const { testPool, testDatabaseUrl } = require('./helpers/test-db');
const { freePort } = require('./helpers/free-port');

const ROOT = path.join(__dirname, '..');

// --- The numbers -----------------------------------------------------------------

test('percentOf: whole percent; under 1 % is 0 (never a plain zero on screen), 100 only for everyone', () => {
  assert.strictEqual(percentOf(0, 20), 0);
  assert.strictEqual(percentOf(1, 150), 0, '0.7 % reads "< 1 %"');
  assert.strictEqual(percentOf(1, 100), 1);
  assert.strictEqual(percentOf(1, 20), 5);
  assert.strictEqual(percentOf(18, 200), 9);
  assert.strictEqual(percentOf(19, 200), 10, '9.5 % shows as 10 %: the shown number decides, so not rare');
  assert.strictEqual(percentOf(199, 200), 99, '99.5 % is not everyone');
  assert.strictEqual(percentOf(200, 200), 100);
});

test('rarityFromRows: a share for every catalogue badge and the rare line; nothing below the guard', () => {
  assert.strictEqual(RARITY_MIN_PLAYERS, 20);
  assert.strictEqual(RARE_BELOW_PERCENT, 10);
  const rows = (total, held) => [{ badge_id: null, holders: total },
    ...Object.entries(held).map(([badge_id, holders]) => ({ badge_id, holders }))];
  assert.strictEqual(rarityFromRows(rows(19, { first_win: 19 })), null, '19 players: no shares');
  assert.strictEqual(rarityFromRows([]), null, 'no rows at all');
  const r = rarityFromRows(rows(20, { first_win: 5, pik_royal: 1, retired_badge: 3 }));
  assert.strictEqual(r.rareBelow, RARE_BELOW_PERCENT);
  assert.deepStrictEqual(Object.keys(r.percent).sort(), [...BADGE_IDS].sort(), 'every badge, a retired id none');
  assert.strictEqual(r.percent.first_win, 25);
  assert.strictEqual(r.percent.pik_royal, 5);
  assert.strictEqual(r.percent.run_13, 0, 'held by nobody: "< 1 %"');
  assert.strictEqual(rarityFromRows(rows(5, { first_win: 1 }), 5).percent.first_win, 20, 'the guard is a parameter');
});

// --- The query on PostgreSQL --------------------------------------------------------

/** Players with `games` finished matches, `puzzles` solved daily puzzles, `floors` starred
 *  Kartenhaus floors and `badges`; `account`: 'confirmed' (linked to the player like a
 *  confirmed sign-up) or 'unconfirmed' (no link yet). */
async function seed(pool, players, list) {
  for (const p of list) {
    await players.upsertPlayerProfile(p.name);
    for (let i = 0; i < (p.games || 0); i++) await players.recordGameResult([{ name: p.name, score: 120, won: false }]);
    for (let i = 0; i < (p.puzzles || 0); i++) await players.recordPuzzleAttempt(p.name, `2026-10-${10 + i}`, true);
    for (let i = 0; i < (p.floors || 0); i++) await players.recordTowerResult(p.name, '2026-10', i + 1, 1);
    if (p.badges && p.badges.length) await players.awardBadges(p.name, p.badges);
    if (p.account) {
      await pool.query(`INSERT INTO users (username, email, password_hash, password_salt, email_verified, player_id)
        SELECT $1, $2, '\\x00', 's', $3, CASE WHEN $3 THEN id END FROM players WHERE player_key = lower($1)`,
      [p.name, `${p.name.toLowerCase()}@example.org`, p.account === 'confirmed']);
    }
  }
}
const accounts = (n, badgesOf = () => [], prefix = 'Konto') => Array.from({ length: n }, (_, i) => ({
  name: `${prefix}${String(i + 1).padStart(2, '0')}`, games: 1, account: 'confirmed', badges: badgesOf(i),
}));

test('the query: confirmed accounts that played in any mode; guests, accounts that never played and unconfirmed sign-ups are left out', async (t) => {
  const pool = testPool(t, 'rarity');
  const players = createPlayerStore(pool, { legacyFile: null });
  await players.ready();
  // 17 accounts with a match plus one through the real sign-up: confirming links the account to its player.
  const signups = createPgAccountStore(pool);
  const signup = await signups.registerWithoutPassword('Echt', 'echt@example.org');
  assert.ok((await signups.verifyEmail(signup.verifyToken)).ok);
  await seed(pool, players, [{ name: 'Echt', games: 1, badges: ['pd_laid', 'first_win', 'pik_royal'] }]);
  await seed(pool, players, accounts(17, (i) => ['pd_laid', ...(i < 4 ? ['first_win'] : [])]));
  await seed(pool, players, [
    // No match, but playing: a daily-puzzle solver and a Kartenhaus builder count.
    { name: 'Raetsler', puzzles: 1, account: 'confirmed', badges: ['pd_laid', 'puzzle_7'] },
    { name: 'Baumeisterin', floors: 1, account: 'confirmed', badges: ['pd_laid', 'tower_3'] },
    // Guests (typed names): their badges never count.
    ...Array.from({ length: 10 }, (_, i) => ({ name: `Gast${i}`, games: 3, puzzles: 1, badges: ['pik_royal', 'run_13', 'first_win'] })),
    // Signed up, never played anything: neither counted nor holding.
    { name: 'Schlaefer', account: 'confirmed', badges: ['run_13'] },
    // A sign-up never confirmed: no player link.
    { name: 'Neuling', games: 2, account: 'unconfirmed', badges: ['run_13'] },
  ]);

  const rarity = createBadgeRarity(pool);
  assert.strictEqual(rarity.get(), null, 'nothing before the first refresh');
  const r = await rarity.refresh();
  assert.strictEqual(r, rarity.get());
  assert.strictEqual(r.rareBelow, 10);
  assert.strictEqual(r.percent.first_win, 25, '5 of 20: the guests and the account that never played are not counted');
  assert.strictEqual(r.percent.pd_laid, 100, 'every counted account, the solver and the builder included');
  assert.strictEqual(r.percent.puzzle_7, 5, 'the puzzle-only account counts');
  assert.strictEqual(r.percent.tower_3, 5, 'the Kartenhaus-only account counts');
  assert.strictEqual(r.percent.pik_royal, 5, '1 of 20 (rare); ten guests hold it as well');
  assert.strictEqual(r.percent.run_13, 0, 'guests, an account that never played and an unconfirmed sign-up only');

  // One counted account goes: 19 left, below the guard.
  await pool.query("DELETE FROM users WHERE username = 'Konto17'");
  assert.strictEqual(await rarity.refresh(), null, '19 players: no shares');
});

/** The test pool with the rarity query counted and switchable to fail. */
function flakyPool(pool) {
  return {
    fail: false,
    calls: 0,
    query(sql, params) {
      if (sql === RARITY_SQL) {
        this.calls += 1;
        if (this.fail) return Promise.reject(new Error('connection terminated'));
      }
      return pool.query(sql, params);
    },
    connect: () => pool.connect(),
  };
}

test('the cache: a failed refresh never throws and keeps the last shares; one query at a time', async (t) => {
  const pool = testPool(t, 'rarity_cache');
  const players = createPlayerStore(pool, { legacyFile: null });
  await players.ready();
  await seed(pool, players, accounts(20, (i) => (i < 2 ? ['first_win'] : [])));
  const db = flakyPool(pool);
  const errors = [];
  const rarity = createBadgeRarity(db, { logError: (m) => errors.push(m) });

  db.fail = true;
  assert.strictEqual(await rarity.refresh(), null, 'resolves, never rejects');
  assert.strictEqual(rarity.get(), null, 'nothing loaded yet: no shares shown');
  assert.match(errors[0], /rarity not refreshed: connection terminated/);

  db.fail = false;
  const [a, b] = await Promise.all([rarity.refresh(), rarity.refresh()]);
  assert.strictEqual(a, b);
  assert.strictEqual(db.calls, 2, 'the second call joined the running one');
  assert.strictEqual(rarity.get().percent.first_win, 10);

  db.fail = true;
  await rarity.refresh();
  assert.strictEqual(rarity.get().percent.first_win, 10, 'a failed refresh keeps the last shares');
  assert.strictEqual(errors.length, 2);
});

test('the timer: loads at the start, then on every interval, never holds the process open', async (t) => {
  const pool = testPool(t, 'rarity_timer');
  const players = createPlayerStore(pool, { legacyFile: null });
  await players.ready();
  await seed(pool, players, accounts(20));
  const db = flakyPool(pool);
  const rarity = createBadgeRarity(db);
  t.after(() => rarity.stop());
  const timer = rarity.start({ everyMs: 30 });
  assert.strictEqual(timer.hasRef(), false, 'unref()ed');
  for (const deadline = Date.now() + 10000; db.calls < 3 && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 10));
  assert.ok(db.calls >= 3, `loaded at the start and refreshed again (${db.calls} queries)`);
  assert.ok(rarity.get(), 'the shares are in');
  rarity.stop();
  await rarity.refresh(); // a refresh still running when it stopped has ended
  const after = db.calls;
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(db.calls, after, 'no refresh after stop()');
});

// --- The real server ----------------------------------------------------------------

async function waitForServer(port, timeoutMs = 15000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
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

/** A server on `dbUrl` with its own data dir, stopped with test `t`; resolves to a socket factory. */
async function bootServer(t, dbUrl, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-rarity-'));
  const port = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: dbUrl, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_PUBLIC_MODE: '0', PIKDAME_ONNX: '0', ...env },
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
  return () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.inbox = [];
    ws.on('message', (raw) => { try { ws.inbox.push(JSON.parse(raw)); } catch (e) { /* not ours */ } });
    const timer = setTimeout(() => reject(new Error('socket did not open')), 5000);
    ws.once('open', () => { clearTimeout(timer); sockets.push(ws); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** The answer to `listProfiles` before joining a table (msg.name, as the start screen sends it). */
async function listProfiles(ws, name) {
  const from = ws.inbox.length;
  ws.send(JSON.stringify({ type: 'listProfiles', name }));
  for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
    const m = ws.inbox.slice(from).find((x) => x.type === 'profiles');
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no profiles message');
}

test('server: the profiles message carries the shares before any table; none in the public mode', async (t) => {
  const dbUrl = testDatabaseUrl('rarity_srv');
  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  t.after(() => pool.end());
  const players = createPlayerStore(pool, { legacyFile: null });
  await players.ready();
  await seed(pool, players, [...accounts(20, (i) => (i < 3 ? ['zen_trio'] : ['first_win']), 'Spieler'),
    { name: 'Gast', games: 5, badges: ['zen_trio', 'run_13'] }]);

  const sock = await bootServer(t, dbUrl);
  const ws = await sock();
  // The server loads the shares right after its start; until then the message carries null.
  let msg = await listProfiles(ws, 'Spieler01');
  for (const deadline = Date.now() + 10000; !msg.badgeRarity && Date.now() < deadline;) {
    await new Promise((r) => setTimeout(r, 100));
    msg = await listProfiles(ws, 'Spieler01');
  }
  assert.ok(msg.badgeRarity, 'the shares arrive with the profiles');
  assert.strictEqual(msg.badgeRarity.rareBelow, 10);
  assert.strictEqual(msg.badgeRarity.percent.zen_trio, 15, '3 of 20 accounts; the guest does not count');
  assert.strictEqual(msg.badgeRarity.percent.first_win, 85);
  assert.strictEqual(msg.badgeRarity.percent.run_13, 0, 'the guest only');
  assert.ok(!JSON.stringify(msg.badgeRarity).includes('Spieler'), 'shares only, never who holds a badge');

  // The public mode keeps profiles and statistics to itself: no shares either.
  const pubSock = await bootServer(t, dbUrl, { PIKDAME_PUBLIC_MODE: '1' });
  const pub = await listProfiles(await pubSock(), 'Spieler01');
  assert.strictEqual(pub.publicMode, true);
  assert.strictEqual(pub.badgeRarity, null);
});
