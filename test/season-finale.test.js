/** Season finale: an ended season's standings are written down exactly once
 *  (places, ties, awards), survive a restart and are announced once. Pure
 *  standings, the SQLite store and - with PIKDAME_TEST_PG_URL - Postgres. */
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { seasonStandings, SEASON_PARTICIPATION_GAMES, SEASON_TOP } = require('../game/Progression');
const { createAccountStore } = require('../game/AccountStore');
const { createPgAccountStore } = require('../game/PgAccountStore');

const probe = createAccountStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikseason-')), 'probe.db'));
const HAS_SQLITE = probe !== null;
if (probe) probe.close();
const PG_URL = process.env.PIKDAME_TEST_PG_URL || '';

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

// --- SQLite store ----------------------------------------------------------------

function sqliteFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikseason-')), 'users.db');
}
async function signUp(store, name) {
  const r = await store.register(name, `${name.toLowerCase()}@example.com`, 'geheim123');
  assert.ok(r.ok, JSON.stringify(r));
  await store.verifyEmail(r.verifyToken);
}
const play = (store, name, season, ...xps) => { for (const xp of xps) store.addGameResult(name, { xp, season }); };
const brief = (store, name) => store.seasonResultsFor(name).map((r) => `${r.season} ${r.place}/${r.ranked} ${r.award} ${r.seasonXp}xp ${r.seasonGames}g${r.seen ? ' seen' : ''}`);

test('SQLite: the rollover archives the season, the finale ranks archived and idle accounts once', { skip: !HAS_SQLITE }, async () => {
  const store = createAccountStore(sqliteFile());
  assert.deepStrictEqual(store.finalizeSeasons('2026-10'), [], 'first run: notes the archive start, nothing ended yet');
  for (const n of ['Anna', 'Ben', 'Cleo', 'Dora']) await signUp(store, n);
  await store.register('Gast', 'gast@example.com', 'geheim123'); // never verified

  play(store, 'Anna', '2026-10', 100, 100, 100);
  play(store, 'Ben', '2026-10', 120, 80);
  play(store, 'Cleo', '2026-10', 200);
  play(store, 'Dora', '2026-10', 20, 20, 10);
  assert.strictEqual(store.addGameResult('Gast', { xp: 999, season: '2026-10' }), null);
  play(store, 'Anna', '2026-11', 30); // Anna rolls over; the others stay idle

  assert.deepStrictEqual(store.finalizeSeasons('2026-10'), [], 'a running season is never final');
  assert.deepStrictEqual(store.finalizeSeasons('2026-11'), [{ season: '2026-10', ranked: 4, awards: 4 }]);
  assert.deepStrictEqual(brief(store, 'Anna'), ['2026-10 1/4 gold 300xp 3g']);
  assert.deepStrictEqual(brief(store, 'ben'), ['2026-10 2/4 silver 200xp 2g'], 'a tie shares silver');
  assert.deepStrictEqual(brief(store, 'Cleo'), ['2026-10 2/4 silver 200xp 1g']);
  assert.deepStrictEqual(brief(store, 'Dora'), ['2026-10 4/4 top10 50xp 3g'], 'place 3 is skipped after a tie');
  assert.deepStrictEqual(store.seasonResultsFor('Gast'), []);

  // Idempotent: again, and after a late rollover of an idle account.
  assert.deepStrictEqual(store.finalizeSeasons('2026-11'), []);
  play(store, 'Ben', '2026-12', 10);
  assert.deepStrictEqual(store.finalizeSeasons('2026-12'), [{ season: '2026-11', ranked: 1, awards: 1 }]);
  assert.deepStrictEqual(brief(store, 'Ben'), ['2026-10 2/4 silver 200xp 2g'], 'the archived copy changes nothing');
  assert.deepStrictEqual(brief(store, 'Anna'), ['2026-11 1/1 gold 30xp 1g', '2026-10 1/4 gold 300xp 3g'], 'newest first');
  assert.strictEqual(store._db.prepare('SELECT COUNT(*) AS n FROM season_results').get().n, 5);

  // Account deletion takes its seasons along.
  assert.ok(store.deleteUser('Anna').ok);
  assert.strictEqual(store._db.prepare('SELECT COUNT(*) AS n FROM season_results').get().n, 3);
  assert.strictEqual(store._db.prepare('SELECT COUNT(*) AS n FROM season_archive WHERE user_id NOT IN (SELECT id FROM users)').get().n, 0);
  store.close();
});

test('SQLite: a restart neither loses the archive nor finalizes twice', { skip: !HAS_SQLITE }, async () => {
  const file = sqliteFile();
  const before = createAccountStore(file);
  before.finalizeSeasons('2026-10');
  await signUp(before, 'Anna');
  await signUp(before, 'Ben');
  play(before, 'Anna', '2026-10', 50);
  play(before, 'Ben', '2026-10', 70);
  play(before, 'Anna', '2026-11', 5);
  before.close();

  const after = createAccountStore(file);
  assert.deepStrictEqual(after.finalizeSeasons('2026-11'), [{ season: '2026-10', ranked: 2, awards: 2 }]);
  after.close();
  const again = createAccountStore(file);
  assert.deepStrictEqual(again.finalizeSeasons('2026-11'), [], 'the finals row survives the restart');
  assert.deepStrictEqual(brief(again, 'Anna'), ['2026-10 2/2 silver 50xp 1g']);
  again.close();
});

test('SQLite: seasons that ended before the finale existed are never finalized', { skip: !HAS_SQLITE }, async () => {
  const store = createAccountStore(sqliteFile());
  await signUp(store, 'Anna');
  play(store, 'Anna', '2026-09', 80); // booked by the old code, no archive behind it
  assert.deepStrictEqual(store.finalizeSeasons('2026-10'), [], 'the first run starts with the running season');
  assert.deepStrictEqual(store.finalizeSeasons('2026-12'), []);
  assert.deepStrictEqual(store.seasonResultsFor('Anna'), []);
  store.close();
});

test('SQLite: the participation memento needs 3 games - except in the first season', { skip: !HAS_SQLITE }, async () => {
  const store = createAccountStore(sqliteFile());
  store.finalizeSeasons('2026-10');
  const names = Array.from({ length: 12 }, (_, i) => `Spieler${i + 1}`);
  for (const n of names) await signUp(store, n);
  // October (first season): everyone one game, XP falling with the name.
  names.forEach((n, i) => play(store, n, '2026-10', 200 - i * 10));
  // November: places 11 and 12 differ only in games played.
  names.forEach((n, i) => play(store, n, '2026-11', 200 - i * 10));
  play(store, 'Spieler11', '2026-11', 0, 0);
  play(store, 'Spieler12', '2026-11', 0);
  play(store, 'Spieler1', '2026-12', 1);
  assert.deepStrictEqual(store.finalizeSeasons('2026-12').map((d) => d.season), ['2026-10', '2026-11']);
  assert.deepStrictEqual(brief(store, 'Spieler11'), ['2026-11 11/12 participant 100xp 3g', '2026-10 11/12 participant 100xp 1g']);
  assert.deepStrictEqual(brief(store, 'Spieler12'), ['2026-11 12/12 null 90xp 2g', '2026-10 12/12 participant 90xp 1g']);
  store.close();
});

test('SQLite: seen - the newest result marks the older ones too', { skip: !HAS_SQLITE }, async () => {
  const store = createAccountStore(sqliteFile());
  store.finalizeSeasons('2026-10');
  await signUp(store, 'Anna');
  play(store, 'Anna', '2026-10', 10);
  play(store, 'Anna', '2026-11', 10);
  play(store, 'Anna', '2026-12', 10);
  store.finalizeSeasons('2026-12');
  assert.deepStrictEqual(store.seasonResultsFor('Anna').map((r) => r.seen), [false, false]);
  assert.deepStrictEqual(store.markSeasonResultSeen('anna', '2026-11'), { ok: true });
  assert.deepStrictEqual(store.seasonResultsFor('Anna').map((r) => r.seen), [true, true]);
  assert.deepStrictEqual(store.markSeasonResultSeen('Niemand', '2026-11'), { ok: false });
  store.close();
});

test('SQLite: a guest import at the end of the month buys no podium', { skip: !HAS_SQLITE }, async () => {
  const store = createAccountStore(sqliteFile());
  store.finalizeSeasons('2026-10');
  await signUp(store, 'Anna');
  await signUp(store, 'Ben');
  play(store, 'Anna', '2026-10', 120, 80);
  play(store, 'Ben', '2026-10', 30);
  // Ben played for a year as a guest and registers on the 31st.
  assert.ok(store.importProfile('Ben', { xp: 9000, games: 300, wins: 120 }).imported);
  const ben = store.progressFor('Ben');
  assert.deepStrictEqual([ben.xp, ben.seasonXp, ben.season, ben.rank], [9000, 30, '2026-10', 2]);
  store.finalizeSeasons('2026-11');
  assert.deepStrictEqual(brief(store, 'Anna'), ['2026-10 1/2 gold 200xp 2g']);
  assert.deepStrictEqual(brief(store, 'Ben'), ['2026-10 2/2 silver 30xp 1g']);
  store.close();
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

test('server: the unseen result rides on /api/me until it is reported seen', { skip: !HAS_SQLITE }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-season-'));
  const seed = createAccountStore(path.join(dataDir, 'users.db'));
  await signUp(seed, 'Anna');
  await signUp(seed, 'Ben');
  play(seed, 'Anna', '2025-01', 90);
  play(seed, 'Ben', '2025-01', 40);
  play(seed, 'Anna', '2025-02', 5);
  seed.finalizeSeasons('2025-02', { from: '2025-01' });
  const { token } = seed.login('Anna', 'geheim123');
  seed.close();

  const port = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_SMTP_HOST: '', PIKDAME_DATABASE_URL: '', PIKDAME_ADMIN_TOKEN: '', PIKDAME_ONNX: '0' },
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

// --- Postgres (CI service container) ------------------------------------------------

test('Postgres down: the finale reports "not done" so the server asks again', async () => {
  const store = createPgAccountStore('postgres://nouser:nopass@127.0.0.1:59999/nodb');
  assert.strictEqual(await store.finalizeSeasons('2026-11'), null);
  assert.deepStrictEqual(await store.seasonResultsFor('Anna'), []);
  assert.deepStrictEqual(await store.markSeasonResultSeen('Anna', '2026-10'), { ok: false });
  await store.close();
});

// Shared database: far-future seasons of a random year plus `from` keep this
// run apart from other tests and from the real archive start.

test('Postgres: rollover archive, ties, idempotence, restart and seen like SQLite', { skip: !PG_URL }, async () => {
  const year = 2100 + Math.floor(Math.random() * 7000);
  const S = (m) => `${year}-${String(m).padStart(2, '0')}`;
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const names = ['A', 'B', 'C'].map((x) => `S${x}_${tag}`);
  const store = createPgAccountStore(PG_URL);
  for (const n of names) {
    const r = await store.register(n, `${n.toLowerCase()}@example.com`, 'geheim123');
    assert.ok(r.ok, JSON.stringify(r));
    await store.verifyEmail(r.verifyToken);
  }
  const [a, b, c] = names;
  for (const xp of [60, 40]) await store.addGameResult(a, { xp, season: S(3) });
  await store.addGameResult(b, { xp: 100, season: S(3) });
  await store.addGameResult(c, { xp: 30, season: S(3) });
  await store.addGameResult(a, { xp: 5, season: S(4) }); // rollover -> archive

  assert.deepStrictEqual(await store.finalizeSeasons(S(4), { from: S(3) }), [{ season: S(3), ranked: 3, awards: 3 }]);
  const res = async (n) => (await store.seasonResultsFor(n)).map((r) => `${r.season} ${r.place}/${r.ranked} ${r.award} ${r.seasonXp}xp ${r.seasonGames}g`);
  assert.deepStrictEqual(await res(a), [`${S(3)} 1/3 gold 100xp 2g`]);
  assert.deepStrictEqual(await res(b), [`${S(3)} 1/3 gold 100xp 1g`]);
  assert.deepStrictEqual(await res(c), [`${S(3)} 3/3 bronze 30xp 1g`]);
  assert.deepStrictEqual(await store.finalizeSeasons(S(4), { from: S(3) }), []);
  await store.close();

  const restarted = createPgAccountStore(PG_URL);
  assert.deepStrictEqual(await restarted.finalizeSeasons(S(4), { from: S(3) }), [], 'finals survive a restart');
  await restarted.addGameResult(b, { xp: 1, season: S(5) });
  assert.deepStrictEqual(await restarted.finalizeSeasons(S(5), { from: S(3) }), [{ season: S(4), ranked: 1, awards: 1 }]);
  assert.deepStrictEqual(await restarted.markSeasonResultSeen(a.toLowerCase(), S(4)), { ok: true });
  assert.deepStrictEqual((await restarted.seasonResultsFor(a)).map((r) => [r.season, r.seen]), [[S(4), true], [S(3), true]]);
  for (const n of names) await restarted.deleteUser(n);
  await restarted.close();
});
