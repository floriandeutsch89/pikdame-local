// game/Database.js
// The one PostgreSQL connection of the server. Postgres is mandatory: the
// server refuses to start without PIKDAME_DATABASE_URL.
const { Pool } = require('pg');
const { readSecret } = require('./secretEnv');

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

module.exports = { connectionStringFromEnv, createPool };
