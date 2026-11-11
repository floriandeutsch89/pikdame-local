// game/TowerMonthStore.js - where TowerMonths.js keeps the deals it picked: one row per
// floor in PostgreSQL (migrations/014). data/tower-months.json of older versions is imported once.
// The pick is deterministic, so replicas write the same rows; a lost write is picked again.
'use strict';
const fs = require('fs');
const path = require('path');
const { ensureMigrated } = require('./Migrations');

const FLOORS = 20;
const IMPORT_NAME = 'tower-months.json';
const IMPORT_LOCK_KEY = 726820;
const IMPORT_RETRY_MS = 10 * 60 * 1000;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UPSERT = `INSERT INTO tower_floors (tower_month, stage, gen_version, floor_entry) VALUES ($1, $2, $3, $4)
  ON CONFLICT (tower_month, stage) DO UPDATE SET gen_version = EXCLUDED.gen_version, floor_entry = EXCLUDED.floor_entry, updated_at = now()`;

const emptyMonth = (version) => ({ version, floors: Array(FLOORS).fill(null) });

/** In memory (tests): the same contract as the PostgreSQL store. */
function memoryTowerStore(initial = { months: {} }) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    load: async () => JSON.parse(JSON.stringify(data)),
    saveFloor(month, stage, entry, version) {
      if (!data.months[month]) data.months[month] = emptyMonth(version);
      data.months[month].floors[stage - 1] = entry == null ? null : JSON.parse(JSON.stringify(entry));
      if (entry != null) data.months[month].version = version;
    },
    flush: async () => {},
    snapshot: () => JSON.parse(JSON.stringify(data)),
    set(next) { data = JSON.parse(JSON.stringify(next)); },
  };
}

/** One-time move of tower-months.json: one transaction plus a marker, the file is renamed after the commit. */
async function importLegacyFile(pool, file) {
  if (!file || !fs.existsSync(file)) return false;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed.months !== 'object' || !parsed.months) throw new Error(`${file}: not a tower months file`);
  const rows = [];
  for (const [month, m] of Object.entries(parsed.months)) {
    if (!MONTH_RE.test(month) || !m || !Array.isArray(m.floors)) continue;
    m.floors.slice(0, FLOORS).forEach((f, i) => { if (f && typeof f === 'object') rows.push([month, i + 1, Number(m.version) || 1, JSON.stringify(f)]); });
  }
  const client = await pool.connect();
  let imported = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK_KEY]);
    const marked = await client.query('INSERT INTO legacy_imports (source, imported_at) VALUES ($1, now()) ON CONFLICT DO NOTHING RETURNING source', [IMPORT_NAME]);
    imported = marked.rows.length === 1;
    // Floors a newer start already picked stay: the file is older.
    if (imported) for (const r of rows) await client.query(`${UPSERT.split('ON CONFLICT')[0]} ON CONFLICT DO NOTHING`, r);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  fs.renameSync(file, `${file}.migrated`);
  console.log(imported
    ? `[db] ${IMPORT_NAME}: imported ${rows.length} floors, file renamed to ${path.basename(file)}.migrated`
    : `[db] ${IMPORT_NAME}: already imported earlier, file renamed to ${path.basename(file)}.migrated without importing it again`);
  return imported;
}

/**
 * @param {import('pg').Pool} pool the shared pool (game/Database.js)
 * @param {{legacyFile?: string|null, logError?: (line: string) => void}} [opts]
 */
function createPgTowerStore(pool, { legacyFile = null, logError = (line) => console.error(line) } = {}) {
  const pending = new Set();
  let importRun = null;
  let importRetryAt = 0;

  function maybeImport() {
    if (importRun) return importRun;
    if (!legacyFile || Date.now() < importRetryAt) return Promise.resolve();
    importRun = importLegacyFile(pool, legacyFile).then(() => {}, (err) => {
      logError(`[db] ${IMPORT_NAME} import failed, retrying in 10 min: ${err.message}`);
      importRun = null;
      importRetryAt = Date.now() + IMPORT_RETRY_MS;
    });
    return importRun;
  }
  const ready = () => ensureMigrated(pool).then(maybeImport);

  /** Every stored month as { months: { 'YYYY-MM': { version, floors[20] } } }. Throws when the database is away. */
  async function load() {
    await ready();
    const { rows } = await pool.query('SELECT tower_month, stage, gen_version, floor_entry FROM tower_floors');
    const months = {};
    for (const r of rows) {
      const m = months[r.tower_month] || (months[r.tower_month] = emptyMonth(r.gen_version));
      m.floors[r.stage - 1] = r.floor_entry;
      m.version = Math.max(m.version, r.gen_version);
    }
    return { months };
  }

  /** Writes one floor in the background (entry null: the floor is open again). Never throws. */
  function saveFloor(month, stage, entry, version) {
    const job = ready().then(() => (entry == null
      ? pool.query('DELETE FROM tower_floors WHERE tower_month = $1 AND stage = $2', [month, stage])
      : pool.query(UPSERT, [month, stage, version, JSON.stringify(entry)])))
      .catch((e) => logError(`[tower] ${month} floor ${stage} not stored: ${e.message}`));
    pending.add(job);
    job.then(() => pending.delete(job));
  }

  /** Waits for every write still on its way (shutdown, tests). */
  async function flush() {
    while (pending.size) await Promise.all([...pending]);
  }

  return { load, saveFloor, flush };
}

module.exports = { createPgTowerStore, memoryTowerStore, importLegacyFile };
