const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasPg, freshSchema } = require('./helpers/pg');
const { ensureStatsSchema } = require('../game/StatsSchema');
const { importStats, DEFAULT_IMPORTS } = require('../game/StatsImport');
const { playerCodec } = require('../game/PlayerStore');

const PG = !hasPg && 'needs PIKDAME_TEST_PG_URL';
const quiet = { log() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pikimport-'));
const put = (dir, file, data) => fs.writeFileSync(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data));
const count = async (pool, table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

test('import: all five files, renamed to .imported, second run is a no-op', { skip: PG }, async () => {
  const s = await freshSchema();
  const dir = tmp();
  try {
    await ensureStatsSchema(s.pool);
    put(dir, 'players.json', { players: [
      { id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7, gamesWon: 3, totalScore: 900, xp: 420, teams: ['old'] },
      { id: 'profile-2', name: 'oma inge', gamesPlayed: 1 }, // unreachable duplicate
    ] });
    put(dir, 'stats.json', { games: 3, rounds: 20, pikDamesLaidOut: 1, pikDamesCaught: 2, handAusRounds: 0 });
    put(dir, 'challenges.json', { days: { '2026-10-01': [{ name: 'Anna', score: 50, at: 1 }] } });
    put(dir, 'stammtisch.json', { tables: { STAB12: { code: 'STAB12', name: 'Do', createdAt: 1, lastActivity: 2, members: {}, games: [{ at: 2, seriesNo: 1, players: [] }] } } });
    put(dir, 'games.json', { games: [{ id: 'game-1', finishedAt: 5, players: [{ id: 'p0', name: 'Anna', isBot: false }], rounds: [] }] });
    const done = await importStats({ pool: s.pool, dataDir: dir, log: quiet });
    assert.deepEqual(done.map((d) => d.file).sort(), ['challenges.json', 'games.json', 'players.json', 'stammtisch.json', 'stats.json']);
    for (const f of ['players', 'stats', 'challenges', 'stammtisch', 'games']) {
      assert.ok(fs.existsSync(path.join(dir, `${f}.json.imported`)), `${f} renamed`);
      assert.ok(!fs.existsSync(path.join(dir, `${f}.json`)));
    }
    assert.equal(await count(s.pool, 'player_profiles'), 1);
    assert.equal(await count(s.pool, 'stammtisch_games'), 1);
    assert.equal(await count(s.pool, 'game_record_players'), 1);
    assert.deepEqual(await importStats({ pool: s.pool, dataDir: dir, log: quiet }), []);
  } finally { await s.drop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import: a verification mismatch rolls back, keeps the file and throws', { skip: PG }, async () => {
  const s = await freshSchema();
  const dir = tmp();
  try {
    await ensureStatsSchema(s.pool);
    put(dir, 'players.json', { players: [{ name: 'A', gamesPlayed: 1 }, { name: 'B', gamesPlayed: 2 }] });
    const lossy = { ...playerCodec, async load(q) { const d = await playerCodec.load(q); d.players.pop(); return d; } };
    await assert.rejects(importStats({ pool: s.pool, dataDir: dir, log: quiet, imports: [{ file: 'players.json', codec: lossy }] }),
      /players\.json: verification failed/);
    assert.ok(fs.existsSync(path.join(dir, 'players.json')), 'file untouched');
    assert.equal(await count(s.pool, 'player_profiles'), 0, 'rolled back');
  } finally { await s.drop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import: dropped entries are logged in full and counted, an id-less game is kept', { skip: PG }, async () => {
  const s = await freshSchema();
  const dir = tmp();
  const errors = [];
  const logs = [];
  const capture = { log: (m) => logs.push(m), error: (m) => errors.push(m) };
  try {
    await ensureStatsSchema(s.pool);
    put(dir, 'players.json', { players: [
      { id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7 },
      { id: 'profile-2', gamesPlayed: 3 }, // nameless
      { id: 'profile-3', name: 'oma inge', gamesPlayed: 1 }, // duplicate
    ] });
    put(dir, 'challenges.json', { days: { '2026-10-01': [{ name: 'Anna', score: 50, at: 1 }, { score: 9, at: 2 }] } });
    put(dir, 'games.json', { games: [
      { id: 'game-1', finishedAt: 5, players: [{ id: 'p0', name: 'Anna', isBot: false }], rounds: [] },
      { finishedAt: 6, players: [{ id: 'p0', name: 'Bea', isBot: false }], rounds: [] }, // no id
      { id: 'game-1', finishedAt: 7, players: [], rounds: [] }, // duplicate id
    ] });
    const done = await importStats({ pool: s.pool, dataDir: dir, log: capture });
    assert.deepEqual(done.map((d) => d.file).sort(), ['challenges.json', 'games.json', 'players.json']);
    assert.equal(await count(s.pool, 'game_records'), 2, 'the id-less game is kept, the duplicate is not');
    assert.equal(await count(s.pool, 'player_profiles'), 1);
    assert.equal(await count(s.pool, 'challenge_scores'), 1);
    const dropped = errors.filter((e) => e.includes('dropped'));
    assert.equal(dropped.length, 4, dropped.join('\n'));
    assert.ok(dropped.some((e) => e.includes('players.json: dropped profile without a name') && e.includes('profile-2')));
    assert.ok(dropped.some((e) => e.includes('players.json: dropped duplicate profile name') && e.includes('oma inge')));
    assert.ok(dropped.some((e) => e.includes('challenges.json: dropped challenge entry without a name') && e.includes('2026-10-01')));
    assert.ok(dropped.some((e) => e.includes('games.json: dropped duplicate game id')));
    assert.ok(!dropped.some((e) => e.includes('games.json') && e.includes('without')), 'an id-less game is not a drop');
    assert.ok(logs.some((m) => m.includes('games.json') && m.includes('4 rows, 1 dropped')), logs.join('\n'));
  } finally { await s.drop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import: an empty file is renamed, a corrupt one refuses the start', { skip: PG }, async () => {
  const s = await freshSchema();
  const dir = tmp();
  try {
    await ensureStatsSchema(s.pool);
    // Relies on DEFAULT_IMPORTS handling stats.json before players.json.
    put(dir, 'stats.json', '');
    put(dir, 'players.json', '{"players": [');
    await assert.rejects(importStats({ pool: s.pool, dataDir: dir, log: quiet }), /players\.json/);
    assert.ok(fs.existsSync(path.join(dir, 'players.json')), 'corrupt file stays for a human to fix');
    assert.ok(fs.existsSync(path.join(dir, 'stats.json.imported')), 'empty file imported as nothing');
  } finally { await s.drop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import: a table that already has rows is left alone', { skip: PG }, async () => {
  const s = await freshSchema();
  const dir = tmp();
  try {
    await ensureStatsSchema(s.pool);
    await s.pool.query("INSERT INTO player_profiles (name_key, name) VALUES ('x', 'X')");
    put(dir, 'players.json', { players: [{ name: 'A' }] });
    assert.deepEqual(await importStats({ pool: s.pool, dataDir: dir, log: quiet, imports: DEFAULT_IMPORTS.filter((i) => i.file === 'players.json') }), []);
    assert.ok(fs.existsSync(path.join(dir, 'players.json')));
  } finally { await s.drop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
