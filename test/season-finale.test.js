/** Season finale: an ended season's standings are written down exactly once
 *  (places, ties, awards), survive a restart and are announced once. Pure
 *  standings, the store and the server. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { seasonStandings, SEASON_PARTICIPATION_GAMES, SEASON_TOP } = require('../game/Progression');
const { Pool } = require('pg');
const { createPgAccountStore } = require('../game/PgAccountStore');
const { testDatabaseUrl } = require('./helpers/test-db');

const places = (rows) => rows.map((r) => [r.userId, r.place, r.award]);

// --- Pure standings ------------------------------------------------------------

test('standings: ties share the place and the medal, the next place skips', () => {
  const rows = seasonStandings([
    { userId: 'c', seasonXp: 80, seasonGames: 5 },
    { userId: 'a', seasonXp: 100, seasonGames: 5 },
    { userId: 'b', seasonXp: 100, seasonGames: 5 },
    { userId: 'd', seasonXp: 50, seasonGames: 5 },
  ]);
  assert.deepStrictEqual(places(rows), [
    ['a', 1, 'gold'], ['b', 1, 'gold'], ['c', 3, 'bronze'], ['d', 4, 'top10'],
  ]);
});

test('standings: top 10 and participation boundaries', () => {
  assert.strictEqual(SEASON_TOP, 10);
  assert.strictEqual(SEASON_PARTICIPATION_GAMES, 3);
  // 13 players, 200 XP down to 80; the last three differ only in games played.
  const entries = Array.from({ length: 13 }, (_, i) => ({ userId: `p${i + 1}`, seasonXp: 200 - i * 10, seasonGames: 3 }));
  entries[11].seasonGames = 2;
  entries[12].seasonGames = 0;
  const rows = seasonStandings(entries);
  assert.deepStrictEqual(rows.slice(2, 13).map((r) => r.award), [
    'bronze', 'top10', 'top10', 'top10', 'top10', 'top10', 'top10', 'top10', 'participant', null, null,
  ]);
  assert.deepStrictEqual([rows[9].place, rows[10].place], [10, 11]);

  // A tie across the cut: both share place 10 and both are top 10.
  entries[10].seasonXp = entries[9].seasonXp;
  const tied = seasonStandings(entries);
  assert.deepStrictEqual(tied.slice(9, 12).map((r) => [r.place, r.award]), [[10, 'top10'], [10, 'top10'], [12, null]]);
});

test('standings: zero XP is unranked, duplicates keep the better entry, the first season counts everyone', () => {
  const rows = seasonStandings([
    { userId: 1, seasonXp: 0, seasonGames: 9 },
    { userId: 2, seasonXp: 40, seasonGames: 1 },
    { userId: 2, seasonXp: 60, seasonGames: 2 },
    null,
  ]);
  assert.deepStrictEqual(rows.map((r) => [r.userId, r.place, r.seasonXp, r.seasonGames]), [[2, 1, 60, 2]]);
  assert.deepStrictEqual(seasonStandings([]), []);

  const many = Array.from({ length: 12 }, (_, i) => ({ userId: i, seasonXp: 100 - i, seasonGames: 0 }));
  assert.strictEqual(seasonStandings(many)[11].award, null, 'no games counted: no memento');
  assert.strictEqual(seasonStandings(many, { gamesCounted: false })[11].award, 'participant',
    'the first season started counting late: every ranked account takes part');
});

// --- Store (a fresh schema per test) -------------------------------------------

/** A store on its own schema; sql() counts rows directly, reopen() is a restart. */
function freshStore() {
  const url = testDatabaseUrl('season');
  const store = createPgAccountStore(url);
  const pool = new Pool({ connectionString: url, max: 1 });
  store.count = async (q) => (await pool.query(q)).rows[0].n;
  store.reopen = () => createPgAccountStore(url);
  const close = store.close;
  store.close = async () => { await pool.end(); await close(); };
  return store;
}
async function signUp(store, name) {
  const r = await store.register(name, `${name.toLowerCase()}@example.com`, 'geheim123');
  assert.ok(r.ok, JSON.stringify(r));
  await store.verifyEmail(r.verifyToken);
}
const play = async (store, name, season, ...xps) => { for (const xp of xps) await store.addGameResult(name, { xp, season }); };
const brief = async (store, name) => (await store.seasonResultsFor(name)).map((r) => `${r.season} ${r.place}/${r.ranked} ${r.award} ${r.seasonXp}xp ${r.seasonGames}g${r.seen ? ' seen' : ''}`);

test('store: the rollover archives the season, the finale ranks archived and idle accounts once', async () => {
  const store = freshStore();
  assert.deepStrictEqual(await store.finalizeSeasons('2026-10'), [], 'first run: notes the archive start, nothing ended yet');
  for (const n of ['Anna', 'Ben', 'Cleo', 'Dora']) await signUp(store, n);
  await store.register('Gast', 'gast@example.com', 'geheim123'); // never verified

  await play(store, 'Anna', '2026-10', 100, 100, 100);
  await play(store, 'Ben', '2026-10', 120, 80);
  await play(store, 'Cleo', '2026-10', 200);
  await play(store, 'Dora', '2026-10', 20, 20, 10);
  assert.strictEqual(await store.addGameResult('Gast', { xp: 999, season: '2026-10' }), null);
  await play(store, 'Anna', '2026-11', 30); // Anna rolls over; the others stay idle

  assert.deepStrictEqual(await store.finalizeSeasons('2026-10'), [], 'a running season is never final');
  assert.deepStrictEqual(await store.finalizeSeasons('2026-11'), [{ season: '2026-10', ranked: 4, awards: 4 }]);
  assert.deepStrictEqual(await brief(store, 'Anna'), ['2026-10 1/4 gold 300xp 3g']);
  assert.deepStrictEqual(await brief(store, 'ben'), ['2026-10 2/4 silver 200xp 2g'], 'a tie shares silver');
  assert.deepStrictEqual(await brief(store, 'Cleo'), ['2026-10 2/4 silver 200xp 1g']);
  assert.deepStrictEqual(await brief(store, 'Dora'), ['2026-10 4/4 top10 50xp 3g'], 'place 3 is skipped after a tie');
  assert.deepStrictEqual(await store.seasonResultsFor('Gast'), []);

  // Idempotent: again, and after a late rollover of an idle account.
  assert.deepStrictEqual(await store.finalizeSeasons('2026-11'), []);
  await play(store, 'Ben', '2026-12', 10);
  assert.deepStrictEqual(await store.finalizeSeasons('2026-12'), [{ season: '2026-11', ranked: 1, awards: 1 }]);
  assert.deepStrictEqual(await brief(store, 'Ben'), ['2026-10 2/4 silver 200xp 2g'], 'the archived copy changes nothing');
  assert.deepStrictEqual(await brief(store, 'Anna'), ['2026-11 1/1 gold 30xp 1g', '2026-10 1/4 gold 300xp 3g'], 'newest first');
  assert.strictEqual(await store.count('SELECT COUNT(*)::int AS n FROM season_results'), 5);

  // Account deletion takes its seasons along.
  assert.ok((await store.deleteUser('Anna')).ok);
  assert.strictEqual(await store.count('SELECT COUNT(*)::int AS n FROM season_results'), 3);
  assert.strictEqual(await store.count('SELECT COUNT(*)::int AS n FROM season_archive WHERE user_id NOT IN (SELECT id FROM users)'), 0);
  await store.close();
});

test('store: a restart neither loses the archive nor finalizes twice', async () => {
  const before = freshStore();
  await before.finalizeSeasons('2026-10');
  await signUp(before, 'Anna');
  await signUp(before, 'Ben');
  await play(before, 'Anna', '2026-10', 50);
  await play(before, 'Ben', '2026-10', 70);
  await play(before, 'Anna', '2026-11', 5);

  const after = before.reopen();
  assert.deepStrictEqual(await after.finalizeSeasons('2026-11'), [{ season: '2026-10', ranked: 2, awards: 2 }]);
  await after.close();
  const again = before.reopen();
  assert.deepStrictEqual(await again.finalizeSeasons('2026-11'), [], 'the finals row survives the restart');
  assert.deepStrictEqual(await brief(again, 'Anna'), ['2026-10 2/2 silver 50xp 1g']);
  await again.close();
  await before.close();
});

test('store: seasons that ended before the finale existed are never finalized', async () => {
  const store = freshStore();
  await signUp(store, 'Anna');
  await play(store, 'Anna', '2026-09', 80); // booked by the old code, no archive behind it
  assert.deepStrictEqual(await store.finalizeSeasons('2026-10'), [], 'the first run starts with the running season');
  assert.deepStrictEqual(await store.finalizeSeasons('2026-12'), []);
  assert.deepStrictEqual(await store.seasonResultsFor('Anna'), []);
  await store.close();
});

test('store: the participation memento needs 3 games - except in the first season', async () => {
  const store = freshStore();
  await store.finalizeSeasons('2026-10');
  const names = Array.from({ length: 12 }, (_, i) => `Spieler${i + 1}`);
  for (const n of names) await signUp(store, n);
  // October (first season): everyone one game, XP falling with the name.
  for (const [i, n] of names.entries()) await play(store, n, '2026-10', 200 - i * 10);
  // November: places 11 and 12 differ only in games played.
  for (const [i, n] of names.entries()) await play(store, n, '2026-11', 200 - i * 10);
  await play(store, 'Spieler11', '2026-11', 0, 0);
  await play(store, 'Spieler12', '2026-11', 0);
  await play(store, 'Spieler1', '2026-12', 1);
  assert.deepStrictEqual((await store.finalizeSeasons('2026-12')).map((d) => d.season), ['2026-10', '2026-11']);
  assert.deepStrictEqual(await brief(store, 'Spieler11'), ['2026-11 11/12 participant 100xp 3g', '2026-10 11/12 participant 100xp 1g']);
  assert.deepStrictEqual(await brief(store, 'Spieler12'), ['2026-11 12/12 null 90xp 2g', '2026-10 12/12 participant 90xp 1g']);
  await store.close();
});

test('store: seen - the newest result marks the older ones too', async () => {
  const store = freshStore();
  await store.finalizeSeasons('2026-10');
  await signUp(store, 'Anna');
  await play(store, 'Anna', '2026-10', 10);
  await play(store, 'Anna', '2026-11', 10);
  await play(store, 'Anna', '2026-12', 10);
  await store.finalizeSeasons('2026-12');
  assert.deepStrictEqual((await store.seasonResultsFor('Anna')).map((r) => r.seen), [false, false]);
  assert.deepStrictEqual(await store.markSeasonResultSeen('anna', '2026-11'), { ok: true });
  assert.deepStrictEqual((await store.seasonResultsFor('Anna')).map((r) => r.seen), [true, true]);
  assert.deepStrictEqual(await store.markSeasonResultSeen('Niemand', '2026-11'), { ok: false });
  await store.close();
});

test('store: a guest import at the end of the month buys no podium', async () => {
  const store = freshStore();
  await store.finalizeSeasons('2026-10');
  await signUp(store, 'Anna');
  await signUp(store, 'Ben');
  await play(store, 'Anna', '2026-10', 120, 80);
  await play(store, 'Ben', '2026-10', 30);
  // Ben played for a year as a guest and registers on the 31st.
  assert.ok((await store.importProfile('Ben', { xp: 9000, games: 300, wins: 120 })).imported);
  const ben = await store.progressFor('Ben');
  assert.deepStrictEqual([ben.xp, ben.seasonXp, ben.season, ben.rank], [9000, 30, '2026-10', 2]);
  await store.finalizeSeasons('2026-11');
  assert.deepStrictEqual(await brief(store, 'Anna'), ['2026-10 1/2 gold 200xp 2g']);
  assert.deepStrictEqual(await brief(store, 'Ben'), ['2026-10 2/2 silver 30xp 1g']);
  await store.close();
});

// --- Server: /api/me carries the result until the client reports it seen ------------

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* html */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('server: the unseen result rides on /api/me until it is reported seen', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-season-'));
  const databaseUrl = testDatabaseUrl('season');
  const seed = createPgAccountStore(databaseUrl);
  await signUp(seed, 'Anna');
  await signUp(seed, 'Ben');
  await play(seed, 'Anna', '2025-01', 90);
  await play(seed, 'Ben', '2025-01', 40);
  await play(seed, 'Anna', '2025-02', 5);
  await seed.finalizeSeasons('2025-02', { from: '2025-01' });
  const { token } = await seed.login('Anna', 'geheim123');
  await seed.close();

  const port = 8137;
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_SMTP_HOST: '', PIKDAME_DATABASE_URL: databaseUrl, PIKDAME_ADMIN_TOKEN: '', PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; ; i++) {
    try { if ((await post(port, '/api/ladder', {})).status === 200) break; } catch (e) { /* booting */ }
    if (i > 150) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }

  const gold = { season: '2025-01', place: 1, award: 'gold', seasonXp: 90, ranked: 2 };
  const me = (await post(port, '/api/me', { token })).json;
  assert.deepStrictEqual([me.seasonResult, me.lastSeason, me.seasonAwards], [gold, gold, [gold]]);
  assert.strictEqual((await post(port, '/api/season-result/seen', { token, season: '25-1' })).status, 400);
  assert.strictEqual((await post(port, '/api/season-result/seen', { season: '2025-01' })).status, 401);
  assert.strictEqual((await post(port, '/api/season-result/seen', { token, season: '2025-01' })).status, 200);
  const again = (await post(port, '/api/me', { token })).json;
  assert.strictEqual(again.seasonResult, undefined, 'announced once');
  assert.deepStrictEqual(again.lastSeason, gold, 'the place itself stays');
  const ladder = (await post(port, '/api/ladder', { token })).json;
  assert.deepStrictEqual([ladder.lastSeason, ladder.seasonAwards], [gold, [gold]]);
  assert.strictEqual((await post(port, '/api/ladder', {})).json.lastSeason, undefined, 'anonymous: board only');
});

// --- Postgres down -----------------------------------------------------------------

test('Postgres down: the finale reports "not done" so the server asks again', async () => {
  const store = createPgAccountStore('postgres://nouser:nopass@127.0.0.1:59999/nodb');
  assert.strictEqual(await store.finalizeSeasons('2026-11'), null);
  assert.deepStrictEqual(await store.seasonResultsFor('Anna'), []);
  assert.deepStrictEqual(await store.markSeasonResultSeen('Anna', '2026-10'), { ok: false });
  await store.close();
});
