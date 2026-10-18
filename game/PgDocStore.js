// game/PgDocStore.js
// Write-behind PostgreSQL persistence with the read/write contract of the old
// AtomicJsonFile: the whole store lives in RAM (synchronous API for the game
// code), one table row (key, jsonb) per record, changed rows flushed in
// batches. Docs: docs/developer/architecture.md (Persistence).
const fs = require('fs');
const { createPool } = require('./Database');

const IMPORTS_TABLE = 'pikdame_imports';
const RETRY_MS = 5000;

/**
 * @param {string|import('pg').Pool} db connection string (own pool) or the shared pool
 * @param {object} o
 * @param {string} o.table SQL identifier of the store's table
 * @param {(store: object) => Array<[string, object]>} o.toRows records of the in-memory store
 * @param {(rows: Array<{key: string, doc: object}>) => object} o.fromRows store from the rows
 * @param {string} [o.legacyFile] JSON file of the old file store, imported once
 */
function createPgDocStore(db, { table, toRows, fromRows, legacyFile = null, flushDelayMs = 800, log = console }) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`bad table name ${table}`);
  const ownsPool = typeof db === 'string';
  const pool = ownsPool ? createPool(db) : db;
  let cache;
  let loaded = false;
  const written = new Map(); // key -> JSON as stored, the baseline for change detection
  let dirty = false;
  let timer = null;
  let flushing = null; // promise of the running flush

  async function ensureSchema(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
      key TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at BIGINT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${IMPORTS_TABLE} (
      name TEXT PRIMARY KEY, imported_at BIGINT NOT NULL, rows INTEGER NOT NULL)`);
  }

  function readLegacy() {
    try {
      return JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      // Throw instead of marking the import done: a broken file would otherwise be skipped forever.
      throw new Error(`[store] ${table}: ${legacyFile} is unreadable, fix or remove it before starting: ${e.message}`);
    }
  }

  /** Once per table: the legacy file's records, in the same transaction as the marker. */
  async function importLegacy(client) {
    const done = await client.query(`SELECT 1 FROM ${IMPORTS_TABLE} WHERE name = $1`, [table]);
    if (done.rowCount) return null;
    const parsed = legacyFile ? readLegacy() : null;
    // A Map: a key twice in an old file (the last one wins) would fail the batch upsert.
    const rows = new Map(parsed ? toRows(parsed).map(([key, doc]) => [String(key), JSON.stringify(doc)]) : []);
    await upsert(client, [...rows]);
    await client.query(`INSERT INTO ${IMPORTS_TABLE} (name, imported_at, rows) VALUES ($1, $2, $3)`, [table, Date.now(), rows.size]);
    return parsed ? rows.size : null;
  }

  function retireLegacy() {
    try {
      fs.renameSync(legacyFile, `${legacyFile}.migrated`);
    } catch (e) {
      log.error(`[store] ${table}: could not rename ${legacyFile}: ${e.message}`);
    }
  }

  /** Must finish before the first read or write: schema, one-time import, rows into RAM. */
  async function load() {
    const client = await pool.connect();
    let imported = null;
    try {
      await client.query('BEGIN');
      // One lock for all stores: parallel CREATE TABLE IF NOT EXISTS of the shared
      // imports table races otherwise, and an instance must not import twice.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pikdame-store-load'))");
      await ensureSchema(client);
      imported = await importLegacy(client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // Renamed only after the commit: a crash before leaves the file for the next import.
    if (imported !== null) {
      log.log(`[store] ${table}: imported ${imported} records from ${legacyFile}`);
      retireLegacy();
    } else if (legacyFile && fs.existsSync(legacyFile)) {
      log.error(`[store] ${table}: ${legacyFile} is ignored, the table was imported before`);
    }
    const { rows } = await pool.query(`SELECT key, doc FROM ${table} ORDER BY key`);
    written.clear();
    for (const r of rows) written.set(r.key, JSON.stringify(r.doc));
    cache = fromRows(rows);
    loaded = true;
  }

  function assertLoaded() {
    if (!loaded) throw new Error(`store ${table} used before load()`);
  }

  function read() {
    assertLoaded();
    return cache;
  }

  function write(data) {
    assertLoaded();
    cache = data;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { flush(); }, flushDelayMs);
    if (timer.unref) timer.unref();
  }

  async function upsert(client, changed) {
    if (!changed.length) return;
    await client.query(
      `INSERT INTO ${table} (key, doc, updated_at)
         SELECT k, d::jsonb, $3 FROM unnest($1::text[], $2::text[]) AS x(k, d)
       ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
      [changed.map((c) => c[0]), changed.map((c) => c[1]), Date.now()]
    );
  }

  async function flushOnce() {
    dirty = false;
    const now = new Map();
    for (const [key, doc] of toRows(cache)) now.set(String(key), JSON.stringify(doc));
    const changed = [...now].filter(([k, json]) => written.get(k) !== json);
    const gone = [...written.keys()].filter((k) => !now.has(k));
    if (!changed.length && !gone.length) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsert(client, changed);
      if (gone.length) await client.query(`DELETE FROM ${table} WHERE key = ANY($1::text[])`, [gone]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    for (const [k, json] of changed) written.set(k, json);
    for (const k of gone) written.delete(k);
  }

  /** Writes every pending change; never rejects. A failure keeps the change
   *  pending and retries after RETRY_MS. */
  function flush() {
    clearTimeout(timer);
    if (!loaded) return Promise.resolve();
    if (flushing) return flushing.then(flush);
    if (!dirty) return Promise.resolve();
    flushing = flushOnce().then(() => true, (e) => {
      dirty = true;
      log.error(`[store] ${table}: write failed, retrying in ${RETRY_MS / 1000} s: ${e.message}`);
      return false;
    }).finally(() => { flushing = null; });
    return flushing.then((ok) => {
      if (!ok) {
        timer = setTimeout(() => { flush(); }, RETRY_MS);
        if (timer.unref) timer.unref();
      } else if (dirty) {
        return flush();
      }
      return undefined;
    });
  }

  async function close() {
    await flush();
    if (ownsPool) await pool.end().catch(() => {});
  }

  return { load, read, write, flush, close };
}

module.exports = { createPgDocStore };
