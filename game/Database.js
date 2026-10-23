// game/Database.js
// The one PostgreSQL connection of the server. Postgres is mandatory: the
// server refuses to start without PIKDAME_DATABASE_URL.
const { Pool, types } = require('pg');
const { readSecret } = require('./secretEnv');

// DATE as its 'YYYY-MM-DD' string: pg's default makes a Date at local midnight,
// which shifts the game day (game/GameDay.js) with the server's time zone.
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (value) => value);

/** PIKDAME_DATABASE_URL with PIKDAME_DATABASE_PASSWORD(_FILE) injected, or
 *  null when unset. A separate pool password option is unreliable next to a
 *  connectionString (pg 8), hence the URL. */
function connectionStringFromEnv(env = process.env) {
  const url = env.PIKDAME_DATABASE_URL;
  if (!url) return null;
  const password = readSecret(env, 'PIKDAME_DATABASE_PASSWORD');
  if (!password) return url;
  const u = new URL(url);
  u.password = password; // URL handles the encoding
  return u.toString();
}

function createPool(connectionString) {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  // A broken idle client must never crash the process.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  return pool;
}

/** fn(client) inside BEGIN/COMMIT on one pooled client; any error rolls back and rethrows. */
async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { connectionStringFromEnv, createPool, inTransaction };
