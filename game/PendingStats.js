// game/PendingStats.js
// Statements still unsaved at shutdown go to data/pending-stats.json and are
// replayed (upserts, idempotent) before anything else on the next start.
const fs = require('fs');
const path = require('path');
const { runInTransaction } = require('./WriteBehind');

function writePending(file, statements) {
  if (!statements.length) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, statements }), 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

async function replayPending(pool, file) {
  if (!fs.existsSync(file)) return 0;
  const { statements } = JSON.parse(fs.readFileSync(file, 'utf8'));
  await runInTransaction(pool, statements);
  fs.unlinkSync(file);
  return statements.length;
}

module.exports = { writePending, replayPending };
