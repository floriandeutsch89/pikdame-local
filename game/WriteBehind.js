// game/WriteBehind.js
// Shared flush loop of the Postgres stats backends: batch, one transaction,
// retry with backoff. Only rows Postgres rejects for their DATA are skipped.
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

async function runInTransaction(pool, statements) {
  if (statements.length === 0) return;
  const client = await pool.connect();
  let failure = null;
  try {
    await client.query('BEGIN');
    for (const s of statements) await client.query(s.text, s.values);
    await client.query('COMMIT');
  } catch (e) {
    failure = e;
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    // A client whose transaction failed is destroyed by pg, not reused.
    if (failure) client.release(failure); else client.release();
  }
}

// SQLSTATE class 22 (data exception) / 23 (constraint): a retry cannot help.
function isDataError(err) {
  return !!(err && typeof err.code === 'string' && /^2[23]/.test(err.code));
}

// One batch in one transaction. If Postgres rejects the data, each statement
// is retried alone so one bad row cannot block the rest. Connection errors throw.
async function writeStatements(pool, statements, { name = 'stats', log = console } = {}) {
  try {
    await runInTransaction(pool, statements);
    return;
  } catch (e) {
    if (!isDataError(e)) throw e;
  }
  for (const s of statements) {
    try {
      await runInTransaction(pool, [s]);
    } catch (e) {
      if (!isDataError(e)) throw e;
      log.error(`[stats] ${name}: Postgres rejected a statement, skipped: ${e.message} ${JSON.stringify(s)}`);
    }
  }
}

function createWriteBehind({ pool, name, collect, commit, flushDelayMs = 800, backoffMs = BACKOFF_MS, log = console }) {
  let dirty = false;
  let timer = null;
  let running = null;
  let failures = 0;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(ms) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {}); // logged in flush; retried by its backoff
    }, ms);
    if (timer.unref) timer.unref();
  }

  function markDirty() {
    dirty = true;
    // During an outage the backoff timer is the only retry; a shorter timer would defeat it.
    if (failures === 0) schedule(flushDelayMs);
  }

  async function writeOnce() {
    dirty = false;
    const { statements, token } = collect(); // synchronous snapshot
    await writeStatements(pool, statements, { name, log });
    commit(token);
  }

  async function flush() {
    while (running) await running.catch(() => {});
    if (!dirty) return;
    running = writeOnce();
    try {
      await running;
      if (failures > 0) log.log(`[stats] ${name}: database reachable again`);
      failures = 0;
      clearTimer(); // a pending backoff timer is obsolete now
      if (dirty) schedule(flushDelayMs); // written while we were flushing
    } catch (e) {
      dirty = true;
      failures += 1;
      if (failures === 1) log.error(`[stats] ${name}: write failed, will retry: ${e.message}`);
      clearTimer();
      schedule(backoffMs[Math.min(failures, backoffMs.length) - 1]);
      throw e;
    } finally {
      running = null;
    }
  }

  return {
    markDirty,
    flush,
    status: () => (failures > 0 ? 'degraded' : 'ok'),
    isDirty: () => dirty || !!running,
  };
}

module.exports = { createWriteBehind, runInTransaction, isDataError, writeStatements, BACKOFF_MS };
