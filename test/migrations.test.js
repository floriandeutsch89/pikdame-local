// The migration runner (game/Migrations.js) against a real PostgreSQL schema.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { migrate, ensureMigrated, loadMigrations, MIGRATIONS_DIR } = require('../game/Migrations');
const { testDatabaseUrl } = require('./helpers/test-db');

function migrationsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-mig-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

async function withPool(t, url = testDatabaseUrl('mig')) {
  const pool = new Pool({ connectionString: url, max: 3 });
  t.after(() => pool.end());
  const rows = async (q) => (await pool.query(q)).rows;
  return { url, pool, rows };
}

test('migrations: the shipped files are numbered 001.. without gaps', () => {
  const all = loadMigrations();
  assert.ok(all.length >= 1);
  assert.strictEqual(all[0].name, 'baseline');
  assert.deepStrictEqual(all.map((m) => m.version), all.map((_, i) => i + 1));
});

test('migrations: a gap or a duplicate number refuses to run', () => {
  assert.throws(() => loadMigrations(migrationsDir({ '001_a.sql': '', '003_c.sql': '' })), /expected 002/);
  assert.throws(() => loadMigrations(migrationsDir({ '001_a.sql': '', '001_b.sql': '' })), /expected 002/);
});

test('migrations: a fresh database gets every file, a second run does nothing', async (t) => {
  const { pool, rows } = await withPool(t);
  const all = loadMigrations();
  assert.deepStrictEqual(await migrate(pool), all.map((m) => m.version));
  assert.deepStrictEqual((await rows('SELECT version, name FROM schema_migrations ORDER BY version')).map((r) => [r.version, r.name]),
    all.map((m) => [m.version, m.name]));
  assert.ok((await rows("SELECT to_regclass('users') AS t"))[0].t, 'the baseline created the account tables');
  assert.deepStrictEqual(await migrate(pool), []);
  assert.strictEqual(await ensureMigrated(pool), await ensureMigrated(pool), 'one run per pool');
});

test('migrations: an up-to-date database is checked without waiting for the lock', async (t) => {
  const { pool } = await withPool(t);
  await migrate(pool);
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(726813)');
    const res = await Promise.race([migrate(pool), new Promise((r) => setTimeout(() => r('blocked'), 3000))]);
    assert.deepStrictEqual(res, []);
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
});

test('migrations: a new file on an existing database is applied once, also by racing starts', async (t) => {
  const { url, pool, rows } = await withPool(t);
  const files = { '001_one.sql': 'CREATE TABLE one (id INT);' };
  assert.deepStrictEqual(await migrate(pool, { dir: migrationsDir(files) }), [1]);
  await pool.query('INSERT INTO one VALUES (7)');
  const dir = migrationsDir({ ...files, '002_two.sql': 'ALTER TABLE one ADD COLUMN two TEXT; INSERT INTO one VALUES (8, \'x\');' });
  const pools = Array.from({ length: 4 }, () => new Pool({ connectionString: url, max: 2 }));
  try {
    const applied = await Promise.all(pools.map((p) => migrate(p, { dir })));
    assert.deepStrictEqual(applied.flat(), [2], 'exactly one start applied it');
  } finally {
    await Promise.all(pools.map((p) => p.end()));
  }
  assert.deepStrictEqual((await rows('SELECT id, two FROM one ORDER BY id')).map((r) => [r.id, r.two]), [[7, null], [8, 'x']]);
});

test('migrations: a failing file rolls back completely and stays unrecorded', async (t) => {
  const { pool, rows } = await withPool(t);
  const ok = { '001_one.sql': 'CREATE TABLE one (id INT);' };
  await migrate(pool, { dir: migrationsDir(ok) });
  const bad = migrationsDir({ ...ok, '002_half.sql': 'CREATE TABLE half (id INT); SELECT no_such_function();' });
  await assert.rejects(migrate(pool, { dir: bad }), /no_such_function/);
  assert.deepStrictEqual((await rows('SELECT version FROM schema_migrations')).map((r) => r.version), [1]);
  assert.strictEqual((await rows("SELECT to_regclass('half') AS t"))[0].t, null, 'its first statement is undone too');
  const fixed = migrationsDir({ ...ok, '002_half.sql': 'CREATE TABLE half (id INT);' });
  assert.deepStrictEqual(await migrate(pool, { dir: fixed }), [2], 'the fixed file applies on the next start');
});

test('migrations: the directory ships next to game/', () => {
  assert.strictEqual(MIGRATIONS_DIR, path.join(__dirname, '..', 'migrations'));
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'docker', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY migrations \.\/migrations$/m, 'the image needs the files');
});

test('migration 005: rows of 003/004 keep their data in DATE/TIMESTAMPTZ columns, target split', async (t) => {
  require('../game/Database'); // the DATE parser: game days come back as strings
  const { pool, rows } = await withPool(t);
  const upTo4 = migrationsDir(Object.fromEntries(loadMigrations().filter((m) => m.version <= 4)
    .map((m) => [path.basename(m.file), fs.readFileSync(m.file, 'utf8')])));
  await migrate(pool, { dir: upTo4 });
  const at = Date.UTC(2026, 9, 22, 18, 30, 0, 123);
  await pool.query(`INSERT INTO challenge_results (day, name_key, name, score, queens, at) VALUES
    ('2026-10-22', 'ada', 'Ada', 480, 2, ${at}), ('2026-13-45', 'bad', 'Bad', 1, 0, ${at})`);
  await pool.query(`INSERT INTO challenge_attempts (day, name_key, name, code, at, state) VALUES
    ('2026-10-22', 'ada', 'Ada', 'ABC123', ${at - 60000}, 'done'), ('2026-10-23', 'ben', 'Ben', 'XYZ789', ${at}, 'running')`);
  await pool.query(`INSERT INTO legacy_imports (name, imported_at) VALUES ('challenges.json', ${at})`);
  await pool.query(`INSERT INTO play_events (at, day, name_key, name, area, target, outcome, turns, duration_ms, attempt_id, facts) VALUES
    (${at}, '2026-10-22', 'ada', 'Ada', 'tower', '2026-11/7', 'lost', 41, 600000, 'a1', '{"cause":"queen"}'),
    (${at}, '2026-10-22', 'ben', 'Ben', 'tower', '2026-10/12', 'won', 30, NULL, 'a2', '{}'),
    (${at}, '2026-10-22', 'cy', 'Cy', 'daily', '2026-10-22', 'abandoned', NULL, NULL, NULL, '{}')`);

  assert.deepStrictEqual(await migrate(pool), [5]);
  const types = await rows(`SELECT table_name || '.' || column_name AS col, data_type FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name IN ('challenge_results', 'challenge_attempts', 'legacy_imports', 'play_attempts')
      AND data_type IN ('date', 'timestamp with time zone', 'bigint') ORDER BY 1`);
  assert.deepStrictEqual(types.map((r) => `${r.col}:${r.data_type}`), [
    'challenge_attempts.game_day:date', 'challenge_attempts.started_at:timestamp with time zone',
    'challenge_attempts.updated_at:timestamp with time zone',
    'challenge_results.finished_at:timestamp with time zone', 'challenge_results.game_day:date',
    'legacy_imports.imported_at:timestamp with time zone',
    'play_attempts.ended_at:timestamp with time zone', 'play_attempts.game_day:date', 'play_attempts.id:bigint',
    'play_attempts.started_at:timestamp with time zone',
  ], 'no epoch integers left (the id is the only bigint)');

  const results = await rows('SELECT * FROM challenge_results');
  assert.deepStrictEqual(results.map((r) => [r.game_day, r.player_key, r.player_name, r.score, r.queens_caught, r.finished_at.getTime()]),
    [['2026-10-22', 'ada', 'Ada', 480, 2, at]], 'ms kept exactly; the impossible day is dropped');
  const attempts = await rows('SELECT * FROM challenge_attempts ORDER BY player_key');
  assert.deepStrictEqual(attempts.map((r) => [r.game_day, r.player_key, r.session_code, r.status, r.started_at.getTime(), r.updated_at.getTime()]),
    [['2026-10-22', 'ada', 'ABC123', 'done', at - 60000, at - 60000], ['2026-10-23', 'ben', 'XYZ789', 'running', at, at]]);
  await assert.rejects(pool.query("UPDATE challenge_attempts SET status = 'odd'"), /challenge_attempts_status_check/);
  assert.deepStrictEqual((await rows('SELECT source, imported_at FROM legacy_imports')).map((r) => [r.source, r.imported_at.getTime()]),
    [['challenges.json', at]]);

  const plays = await rows('SELECT * FROM play_attempts ORDER BY id');
  assert.deepStrictEqual(plays.map((r) => [r.id, r.attempt_id, r.player_key, r.mode, r.period, r.stage, r.game_day, r.turns,
    r.ended_at.getTime() - r.started_at.getTime(), r.ended_at.getTime(), r.facts]), [
    ['1', 'a1', 'ada', 'tower', '2026-11', 7, '2026-10-22', 41, 600000, at, { cause: 'queen' }],
    ['2', 'a2', 'ben', 'tower', '2026-10', 12, '2026-10-22', 30, 0, at, {}],
    ['3', null, 'cy', 'daily', '2026-10-22', null, '2026-10-22', null, 0, at, {}],
  ], 'started_at = end - duration, else the end');
  const next = await rows(`INSERT INTO play_attempts (player_key, player_name, mode, period, outcome, game_day, started_at, ended_at)
    VALUES ('dee', 'Dee', 'tower', '2026-11', 'won', '2026-11-01', now(), now()) RETURNING id`);
  assert.strictEqual(next[0].id, '4', 'the identity continues after the copied ids');
  assert.strictEqual((await rows("SELECT to_regclass('play_events') AS t"))[0].t, null);
  const indexes = await rows(`SELECT tablename || ':' || indexname AS i FROM pg_indexes WHERE schemaname = current_schema()
    AND tablename IN ('challenge_results', 'challenge_attempts', 'legacy_imports', 'play_attempts') ORDER BY 1`);
  assert.deepStrictEqual(indexes.map((r) => r.i), [
    'challenge_attempts:challenge_attempts_pkey', 'challenge_attempts:challenge_attempts_session_code_idx',
    'challenge_results:challenge_results_pkey', 'legacy_imports:legacy_imports_pkey',
    'play_attempts:play_attempts_attempt_id_key', 'play_attempts:play_attempts_ended_at_idx',
    'play_attempts:play_attempts_mode_period_stage_idx', 'play_attempts:play_attempts_pkey',
    'play_attempts:play_attempts_player_key_mode_ended_at_idx',
  ]);
});
