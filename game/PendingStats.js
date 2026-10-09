// game/PendingStats.js
// Statements still unsaved at shutdown go to data/pending-stats.json and are
// replayed (upserts, idempotent) before anything else on the next start.
const fs = require('fs');
const path = require('path');
const { writeStatements } = require('./WriteBehind');
const { STATS_TABLES } = require('./StatsSchema');

// The file sits in a writable data dir: replay only what the stores can produce.
const ALLOWED = new RegExp(`^(?:INSERT INTO (?:${STATS_TABLES.join('|')}) |DELETE FROM stammtisch_tables )`);

function writePending(file, statements) {
  if (!statements.length) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, statements }), 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

// Bad rows are skipped and logged by writeStatements; a corrupt file is kept and reported by name.
async function replayPending(pool, file, log = console) {
  if (!fs.existsSync(file)) return 0;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`pending stats file ${file} is corrupt: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.statements)) {
    throw new Error(`pending stats file ${file} is corrupt: no statements array`);
  }
  const statements = [];
  for (const st of parsed.statements) {
    if (st && typeof st.text === 'string' && ALLOWED.test(st.text)) statements.push(st);
    else log.error(`[stats] pending-stats: rejected statement, not executed: ${JSON.stringify(st)}`);
  }
  await writeStatements(pool, statements, { name: 'pending-stats', log });
  fs.unlinkSync(file);
  return statements.length;
}

module.exports = { writePending, replayPending };
