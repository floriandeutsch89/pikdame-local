// game/WriteBehind.js
// Shared flush loop of the Postgres stats backends: batch, one transaction,
// retry with backoff. Only rows Postgres rejects for their DATA are skipped.
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

async function runInTransaction(pool, statements) {
  if (statements.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of statements) await client.query(s.text, s.values);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// SQLSTATE class 22 (data exception) / 23 (constraint): a retry cannot help.
function isDataError(err) {
  return !!(err && typeof err.code === 'string' && /^2[23]/.test(err.code));
}

function createWriteBehind({ pool, name, collect, commit, flushDelayMs = 800, log = console }) {
  let dirty = false;
  let timer = null;
  let running = null;
  let failures = 0;

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
    schedule(flushDelayMs);
  }

  async function writeOnce() {
    dirty = false;
    const { statements, token } = collect(); // synchronous snapshot
    try {
      await runInTransaction(pool, statements);
    } catch (e) {
      if (!isDataError(e)) throw e;
      // One bad row must not block every other stat forever.
      for (const s of statements) {
        try {
          await runInTransaction(pool, [s]);
        } catch (e2) {
          if (!isDataError(e2)) throw e2;
          log.error(`[stats] ${name}: Postgres rejected a statement, skipped: ${e2.message} ${JSON.stringify(s)}`);
        }
      }
    }
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
    } catch (e) {
      dirty = true;
      failures += 1;
      if (failures === 1) log.error(`[stats] ${name}: write failed, will retry: ${e.message}`);
      schedule(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]);
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

module.exports = { createWriteBehind, runInTransaction, isDataError };
