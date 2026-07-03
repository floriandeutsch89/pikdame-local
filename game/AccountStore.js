// game/AccountStore.js
// User accounts (registration with e-mail confirmation + login) so that
// progress/statistics are permanently bound to an account.
//
// IMPORTANT - two operating worlds:
// - Docker stack: accounts ACTIVE. Persistence in SQLite via Node's
//   BUILT-IN node:sqlite (Node >= 22) - not a single new dependency,
//   one file inside the data/ volume (data/users.db).
// - iOS CodeApp / hotspot (family mode): node:sqlite may be missing or
//   accounts are unwanted -> createAccountStore() returns null, the
//   server keeps running exactly as before and the client hides the
//   account UI entirely.
//
// Security: passwords hashed with scrypt (node:crypto) + random salt,
// comparisons via timingSafeEqual. Tokens are 32-byte random values.
const crypto = require('crypto');
const path = require('path');

const DEFAULT_DB_FILE = path.join(__dirname, '..', 'data', 'users.db');
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 Tage
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000; // 48 Stunden

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * @returns {Object|null} Store API, or null when node:sqlite is missing
 *   (older Node version, e.g. CodeApp) - the caller treats null as
 *   "accounts disabled".
 */
function createAccountStore(dbFile = DEFAULT_DB_FILE) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    return null; // Node < 22: accounts silently disabled
  }

  const fs = require('fs');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  // WAL allows concurrent reads during writes and is the recommended mode
  // for servers; busy_timeout waits briefly instead of failing immediately
  // with SQLITE_BUSY. For this workload (rare account operations, game
  // traffic lives entirely in memory/WS) SQLite is oversized by orders of
  // magnitude - perfectly fine.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash BLOB NOT NULL,
      salt TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      verify_token TEXT,
      verify_expires INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );
  `);

  /** @returns {{ok:true, verifyToken:string}|{error:string}} */
  function register(username, email, password) {
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
    const existing = db
      .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
      .get(username, email);
    if (existing) {
      return { error: 'Benutzername oder E-Mail ist bereits registriert.' };
    }
    const salt = randomToken();
    const verifyToken = randomToken();
    db.prepare(
      `INSERT INTO users (username, email, password_hash, salt, verified, verify_token, verify_expires, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(username, email, hashPassword(password, salt), salt, verifyToken, Date.now() + VERIFY_TTL_MS, Date.now());
    return { ok: true, verifyToken };
  }

  /** @returns {{ok:true, username:string}|{error:string}} */
  function verifyEmail(token) {
    const row = db.prepare('SELECT id, username, verify_expires FROM users WHERE verify_token = ?').get(String(token || ''));
    if (!row) return { error: 'Ungültiger oder bereits verwendeter Bestätigungslink.' };
    if (Date.now() > row.verify_expires) return { error: 'Der Bestätigungslink ist abgelaufen - bitte neu registrieren.' };
    db.prepare('UPDATE users SET verified = 1, verify_token = NULL, verify_expires = NULL WHERE id = ?').run(row.id);
    return { ok: true, username: row.username };
  }

  /** @returns {{ok:true, token:string, username:string}|{error:string}} */
  function login(usernameOrEmail, password) {
    const key = String(usernameOrEmail || '').trim();
    const row = db
      .prepare('SELECT id, username, password_hash, salt, verified FROM users WHERE username = ? OR email = ?')
      .get(key, key);
    // Hash even for unknown users (no observable timing difference)
    const candidate = hashPassword(String(password || ''), row ? row.salt : 'no-user-salt');
    const stored = row ? Buffer.from(row.password_hash) : Buffer.alloc(SCRYPT_KEYLEN);
    const match = stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
    if (!row || !match) return { error: 'Benutzername/E-Mail oder Passwort ist falsch.' };
    if (!row.verified) return { error: 'Bitte zuerst die E-Mail-Adresse bestätigen (Link in der Mail).' };
    const token = randomToken();
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, row.id, Date.now());
    return { ok: true, token, username: row.username };
  }

  /** @returns {{username:string}|null} */
  function sessionUser(token) {
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT u.username, s.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
      )
      .get(String(token));
    if (!row) return null;
    if (Date.now() - row.created_at > SESSION_TTL_MS) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
      return null;
    }
    return { username: row.username };
  }

  function logout(token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token || ''));
  }

  /** Is this name a VERIFIED account? (protects against name theft) */
  function isRegisteredName(name) {
    const row = db.prepare('SELECT verified FROM users WHERE username = ?').get(String(name || '').trim());
    return !!(row && row.verified);
  }

  function close() {
    db.close();
  }

  return { register, verifyEmail, login, sessionUser, logout, isRegisteredName, close };
}

module.exports = { createAccountStore };
