// game/PgAccountStore.js
// PostgreSQL backend for user accounts - same API surface as the SQLite
// store in AccountStore.js, but async (every method returns a promise).
//
// Why Postgres for larger deployments: a NETWORKED shared database is the
// prerequisite for ever running more than one server instance - a local
// SQLite file on a volume structurally rules that out. For a single
// container SQLite remains a perfectly fine zero-config fallback.
//
// The 'pg' package is pure JavaScript (no native module) and is required
// LAZILY: environments without it (or without PIKDAME_DATABASE_URL, e.g.
// iOS CodeApp) never touch this file's fast path.
//
// Resilience: ensureReady() creates the schema on first use and retries on
// connection errors - if Postgres is temporarily down, account API calls
// fail with a clear message and recover automatically once it is back.
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash BYTEA NOT NULL,
    salt TEXT NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    verify_token TEXT,
    verify_expires BIGINT,
    created_at BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (LOWER(username));
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (LOWER(email));
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL
  );
`;

/**
 * @param {string} databaseUrl postgres://user:pass@host:5432/db
 * @returns {Object|null} async store API, or null when 'pg' is unavailable
 */
function createPgAccountStore(databaseUrl, options = {}) {
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (e) {
    return null; // pg not installed (e.g. stripped-down environment)
  }

  // An explicit password (e.g. from a Docker secret file) is injected into
  // the connection URL - the compose file can then carry a secret-free URL.
  // (Passing it as a separate pool option is unreliable when a
  // connectionString is present, verified empirically against pg 8.)
  let connectionString = databaseUrl;
  if (options.password) {
    const u = new URL(databaseUrl);
    u.password = options.password; // URL handles the encoding
    connectionString = u.toString();
  }

  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  // A broken idle client must never crash the process.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));

  let readyPromise = null;
  function ensureReady() {
    if (!readyPromise) {
      readyPromise = pool.query(SCHEMA).catch((err) => {
        readyPromise = null; // retry on the next call
        throw err;
      });
    }
    return readyPromise;
  }

  const DB_DOWN = { error: 'Konto-Datenbank ist gerade nicht erreichbar - bitte später erneut versuchen.' };

  async function register(username, email, password) {
    username = String(username || '').trim();
    email = String(email || '').trim();
    password = String(password || '');
    if (!/^[\p{L}\p{N} _.-]{2,24}$/u.test(username)) {
      return { error: 'Der Benutzername muss 2-24 Zeichen lang sein (Buchstaben, Zahlen, Leer-, Binde-, Unterstrich, Punkt).' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return { error: 'Bitte eine gültige E-Mail-Adresse angeben.' };
    }
    if (password.length < 8 || password.length > 200) {
      return { error: 'Das Passwort muss mindestens 8 Zeichen lang sein.' };
    }
    try {
      await ensureReady();
      const existing = await pool.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
        [username, email]
      );
      if (existing.rows.length > 0) {
        return { error: 'Benutzername oder E-Mail ist bereits registriert.' };
      }
      const salt = randomToken();
      const verifyToken = randomToken();
      await pool.query(
        `INSERT INTO users (username, email, password_hash, salt, verified, verify_token, verify_expires, created_at)
         VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7)`,
        [username, email, hashPassword(password, salt), salt, verifyToken, Date.now() + VERIFY_TTL_MS, Date.now()]
      );
      return { ok: true, verifyToken };
    } catch (e) {
      if (e.code === '23505') return { error: 'Benutzername oder E-Mail ist bereits registriert.' }; // unique race
      console.error('Postgres register failed:', e.message);
      return DB_DOWN;
    }
  }

  async function verifyEmail(token) {
    try {
      await ensureReady();
      const r = await pool.query('SELECT id, username, verify_expires FROM users WHERE verify_token = $1', [String(token || '')]);
      const row = r.rows[0];
      if (!row) return { error: 'Ungültiger oder bereits verwendeter Bestätigungslink.' };
      if (Date.now() > Number(row.verify_expires)) return { error: 'Der Bestätigungslink ist abgelaufen - bitte neu registrieren.' };
      await pool.query('UPDATE users SET verified = TRUE, verify_token = NULL, verify_expires = NULL WHERE id = $1', [row.id]);
      return { ok: true, username: row.username };
    } catch (e) {
      console.error('Postgres verifyEmail failed:', e.message);
      return DB_DOWN;
    }
  }

  async function login(usernameOrEmail, password) {
    const key = String(usernameOrEmail || '').trim();
    try {
      await ensureReady();
      const r = await pool.query(
        'SELECT id, username, password_hash, salt, verified FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)',
        [key]
      );
      const row = r.rows[0];
      // Hash even for unknown users (no observable timing difference)
      const candidate = hashPassword(String(password || ''), row ? row.salt : 'no-user-salt');
      const stored = row ? Buffer.from(row.password_hash) : Buffer.alloc(SCRYPT_KEYLEN);
      const match = stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
      if (!row || !match) return { error: 'Benutzername/E-Mail oder Passwort ist falsch.' };
      if (!row.verified) return { error: 'Bitte zuerst die E-Mail-Adresse bestätigen (Link in der Mail).' };
      const token = randomToken();
      await pool.query('INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)', [token, row.id, Date.now()]);
      return { ok: true, token, username: row.username };
    } catch (e) {
      console.error('Postgres login failed:', e.message);
      return DB_DOWN;
    }
  }

  async function sessionUser(token) {
    if (!token) return null;
    try {
      await ensureReady();
      const r = await pool.query(
        'SELECT u.username, s.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1',
        [String(token)]
      );
      const row = r.rows[0];
      if (!row) return null;
      if (Date.now() - Number(row.created_at) > SESSION_TTL_MS) {
        await pool.query('DELETE FROM sessions WHERE token = $1', [String(token)]);
        return null;
      }
      return { username: row.username };
    } catch (e) {
      console.error('Postgres sessionUser failed:', e.message);
      return null; // fail closed: treat as "not signed in"
    }
  }

  async function logout(token) {
    try {
      await ensureReady();
      await pool.query('DELETE FROM sessions WHERE token = $1', [String(token || '')]);
    } catch (e) {
      console.error('Postgres logout failed:', e.message);
    }
  }

  /** Is this name a VERIFIED account? Fails closed on DB errors: an
   *  unreachable database must not open the door to name theft. */
  async function isRegisteredName(name) {
    try {
      await ensureReady();
      const r = await pool.query('SELECT verified FROM users WHERE LOWER(username) = LOWER($1)', [String(name || '').trim()]);
      return !!(r.rows[0] && r.rows[0].verified);
    } catch (e) {
      console.error('Postgres isRegisteredName failed:', e.message);
      return false;
    }
  }

  async function close() {
    await pool.end().catch(() => {});
  }

  return { backend: 'postgres', register, verifyEmail, login, sessionUser, logout, isRegisteredName, close };
}

module.exports = { createPgAccountStore };
