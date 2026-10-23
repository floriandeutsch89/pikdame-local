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
