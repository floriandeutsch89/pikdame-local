// game/StatsImport.js
// One-time move of the JSON stats files into Postgres. Per file: only into an
// empty table, one transaction, verified row by row, then renamed *.imported.
const fs = require('fs');
const path = require('path');
const { globalStatsCodec } = require('./GlobalStatsStore');
const { playerCodec } = require('./PlayerStore');
const { challengeCodec } = require('./ChallengeStore');
const { stammtischCodec } = require('./StammtischStore');
const { gameHistoryCodec } = require('./GameHistoryStore');

const DEFAULT_IMPORTS = [
  { file: 'stats.json', codec: globalStatsCodec },
  { file: 'players.json', codec: playerCodec },
  { file: 'challenges.json', codec: challengeCodec },
  { file: 'stammtisch.json', codec: stammtischCodec },
  { file: 'games.json', codec: gameHistoryCodec },
];

// Only the file side passes a report: the database side must not count drops twice.
function rowMap(codec, doc, report) {
  const m = new Map();
  if (doc === undefined) return m;
  for (const [key, stmt] of codec.rows(doc, report)) if (!m.has(key)) m.set(key, stmt);
  return m;
}

function firstDifference(expected, actual) {
  if (expected.size !== actual.size) return `${expected.size} rows expected, ${actual.size} in the database`;
  for (const [key, stmt] of expected) {
    const got = actual.get(key);
    if (!got) return `row ${key} missing`;
    if (JSON.stringify(got.values) !== JSON.stringify(stmt.values)) return `row ${key} differs`;
  }
  return null;
}

function readJson(filePath, file) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${e.message}) - fix or move the file, then restart`);
  }
}

async function importStats({ pool, dataDir, log = console, imports = DEFAULT_IMPORTS }) {
  const done = [];
  for (const { file, codec } of imports) {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) continue;
    const parsed = readJson(filePath, file);
    let dropped = 0;
    // Every entry that is not carried over is logged in full, so nothing vanishes silently.
    const report = (reason, entry) => {
      dropped++;
      log.error(`[stats] ${file}: dropped ${reason}: ${JSON.stringify(entry)}`);
    };
    const doc = parsed === undefined ? undefined : codec.normalize(parsed, report);
    const expected = rowMap(codec, doc, report);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { n } = (await client.query(`SELECT count(*)::int AS n FROM ${codec.table}`)).rows[0];
      if (n > 0) {
        await client.query('ROLLBACK');
        log.log(`[stats] ${file}: ${codec.table} already has data - not imported, file left as is`);
        continue;
      }
      for (const stmt of expected.values()) await client.query(stmt.text, stmt.values);
      const problem = firstDifference(expected, rowMap(codec, await codec.load(client, { all: true })));
      if (problem) throw new Error(`${file}: verification failed - ${problem}`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    fs.renameSync(filePath, `${filePath}.imported`);
    log.log(`[stats] imported ${file}: ${expected.size} rows, ${dropped} dropped`);
    done.push({ file, rows: expected.size });
  }
  return done;
}

module.exports = { importStats, DEFAULT_IMPORTS };
