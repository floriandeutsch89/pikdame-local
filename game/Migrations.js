// game/Migrations.js
// Forward-only schema migrations: migrations/NNN_name.sql, applied in order,
// each recorded in schema_migrations. See docs/developer/migrations.md.
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
// Same key as the pre-migration schema setup, so old and new starts serialise.
const LOCK_KEY = 726813;
const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

/** The migration files, sorted; numbers must run 1, 2, 3 ... without gaps. */
function loadMigrations(dir = MIGRATIONS_DIR) {
  const list = fs.readdirSync(dir)
    .map((file) => FILE_RE.exec(file))
    .filter(Boolean)
    .map((m) => ({ version: Number(m[1]), name: m[2], file: path.join(dir, m[0]) }))
    .sort((a, b) => a.version - b.version);
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations: expected ${String(i + 1).padStart(3, '0')}_*.sql, found ${path.basename(m.file)}`);
  });
  return list;
}

// to_regclass first: a failing SELECT would abort the surrounding transaction.
async function appliedVersion(q) {
  const t = await q.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok");
  if (!t.rows[0].ok) return 0;
  return Number((await q.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')).rows[0].v);
}

/**
 * Applies every missing migration in ONE transaction (all or nothing).
 * An up-to-date database is detected without any lock: DDL on a live table
 * (even ADD COLUMN IF NOT EXISTS) wants an exclusive lock and deadlocked
 * running transactions (v2.102.1).
 * @returns {Promise<number[]>} the versions applied by this call
 */
async function migrate(pool, { dir = MIGRATIONS_DIR } = {}) {
  const all = loadMigrations(dir);
  const latest = all.length ? all[all.length - 1].version : 0;
  if (await appliedVersion(pool) >= latest) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const applied = [];
    for (const m of all) {
      if (done.has(m.version)) continue;
      await client.query(fs.readFileSync(m.file, 'utf8'));
      await client.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
        [m.version, m.name, Date.now()]);
      applied.push(m.version);
    }
    await client.query('COMMIT');
    if (applied.length) console.log(`[db] migrations applied: ${applied.join(', ')}`);
    return applied;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Every store on a pool awaits the same run; a failure is retried on the next call.
const runs = new WeakMap();
function ensureMigrated(pool) {
  if (!runs.has(pool)) {
    runs.set(pool, migrate(pool).catch((err) => {
      runs.delete(pool);
      throw err;
    }));
  }
  return runs.get(pool);
}

module.exports = { migrate, ensureMigrated, loadMigrations, MIGRATIONS_DIR };
