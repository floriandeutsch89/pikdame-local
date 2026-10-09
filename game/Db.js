// game/Db.js
// The server's single pg pool, shared by accounts and stats. null without
// PIKDAME_DATABASE_URL or without 'pg': the game then runs play-only.
const { readSecret } = require('./secretEnv');

/** A password from a secret file goes into the URL (pg ignores a separate option next to a connectionString). */
function connectionStringFor(databaseUrl, password) {
  if (!password) return databaseUrl;
  const u = new URL(databaseUrl);
  u.password = password;
  return u.toString();
}

function createPool(env = process.env, { max = 10 } = {}) {
  if (!env.PIKDAME_DATABASE_URL) return null;
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (e) {
    console.error("PIKDAME_DATABASE_URL is set but the 'pg' package is unavailable - running play-only.");
    return null;
  }
  const pool = new Pool({
    connectionString: connectionStringFor(env.PIKDAME_DATABASE_URL, readSecret(env, 'PIKDAME_DATABASE_PASSWORD')),
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  // A broken idle client must never crash the process.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  return pool;
}

module.exports = { createPool, connectionStringFor };
