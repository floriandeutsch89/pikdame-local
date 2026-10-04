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

const DEFAULT_DB_FILE = path.join(process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data'), 'users.db');
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 Tage
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000; // 48 Stunden
const LOGIN_LINK_TTL_MS = 15 * 60 * 1000; // e-mail login link

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
  // Progression columns, added in place: an existing users.db from an older
  // version must keep working (the data volume survives updates), so this is
  // an additive migration guarded by the actual table layout - CREATE TABLE
  // IF NOT EXISTS alone would silently skip them on every existing install.
  {
    const have = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
    const add = (name, ddl) => {
      if (!have.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`);
    };
    add('xp', 'INTEGER NOT NULL DEFAULT 0');
    add('games', 'INTEGER NOT NULL DEFAULT 0');
    add('wins', 'INTEGER NOT NULL DEFAULT 0');
    add('season', 'TEXT');
    add('season_xp', 'INTEGER NOT NULL DEFAULT 0');
    // Set once the name-based profile's progress was carried over (see
    // importProfile) - a second import would count the same games twice.
    add('profile_imported', 'INTEGER NOT NULL DEFAULT 0');
    // Passkeys: one random WebAuthn user handle per account (authenticators
    // group an account's passkeys by it), and the e-mail login link. Only a
    // SHA-256 of the link token is stored.
    add('webauthn_user_id', 'TEXT');
    add('login_token_hash', 'TEXT');
    add('login_expires', 'INTEGER');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS webauthn_credentials_user ON webauthn_credentials (user_id);
  `);

  /** Name/e-mail checks shared by password and passkey registration. */
  function validateNewAccount(username, email) {
    db.prepare('DELETE FROM users WHERE verified = 0 AND verify_expires < ?').run(Date.now());
    username = String(username || '').trim();
    email = String(email || '').trim();
    if (!/^[\p{L}\p{N} _.-]{2,24}$/u.test(username)) {
      return { error: 'Der Benutzername muss 2-24 Zeichen lang sein (Buchstaben, Zahlen, Leer-, Binde-, Unterstrich, Punkt).' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return { error: 'Bitte eine gültige E-Mail-Adresse angeben.' };
    }
    if (db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email)) {
      return { error: 'Benutzername oder E-Mail ist bereits registriert.' };
    }
    return { ok: true, username, email };
  }

  /** @returns {{ok:true, verifyToken:string}|{error:string}} */
  function register(username, email, password) {
    // Opt-in-Hygiene: Nie bestätigte Konten mit abgelaufenem Link blockieren
    // sonst Benutzername UND E-Mail für immer - und der Hinweis 'bitte neu
    // registrieren' (abgelaufener Link) liefe gegen 'bereits vergeben'.
    db.prepare('DELETE FROM users WHERE verified = 0 AND verify_expires < ?').run(Date.now());
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
    try {
      db.prepare(
        `INSERT INTO users (username, email, password_hash, salt, verified, verify_token, verify_expires, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(username, email, hashPassword(password, salt), salt, verifyToken, Date.now() + VERIFY_TTL_MS, Date.now());
    } catch (e) {
      // Two registrations racing for the same name/mail: the UNIQUE index
      // catches what the SELECT above missed - answer like a duplicate, not
      // with a 500 (the Postgres store handles 23505 the same way).
      if (/UNIQUE/i.test(e.message)) return { error: 'Benutzername oder E-Mail ist bereits registriert.' };
      throw e;
    }
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
    // Every login adds a row and only logout removed one - expired sessions
    // (90 days) used to pile up forever. Prune them on the way in.
    db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL_MS);
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

  // --- Progression: XP, level and the seasonal ladder ----------------------
  // Account-bound so it follows the player across devices; the name-based
  // profile in PlayerStore keeps its own copy for account-less play.

  /**
   * Books one finished game onto an account. A new season resets the
   * seasonal counter but never the lifetime XP.
   * @returns {{xp:number, seasonXp:number, games:number, wins:number}|null}
   */
  function addGameResult(username, { xp = 0, won = false, season = null } = {}) {
    const name = String(username || '').trim();
    const row = db.prepare('SELECT id, xp, season, season_xp FROM users WHERE username = ? AND verified = 1').get(name);
    if (!row) return null;
    const gain = Math.max(0, Math.round(Number(xp) || 0));
    const sameSeason = season && row.season === season;
    db.prepare(
      `UPDATE users SET xp = xp + ?, games = games + 1, wins = wins + ?, season = ?, season_xp = ?
       WHERE id = ?`
    ).run(gain, won ? 1 : 0, season, (sameSeason ? row.season_xp : 0) + gain, row.id);
    return progressFor(name);
  }

  /** @returns {{username, xp, seasonXp, season, games, wins, rank}|null} */
  function progressFor(username) {
    const name = String(username || '').trim();
    const row = db
      .prepare('SELECT username, xp, games, wins, season, season_xp FROM users WHERE username = ?')
      .get(name);
    if (!row) return null;
    const rank = row.season
      ? db
          .prepare('SELECT COUNT(*) AS n FROM users WHERE season = ? AND season_xp > ?')
          .get(row.season, row.season_xp).n + 1
      : null;
    return {
      username: row.username,
      xp: row.xp || 0,
      seasonXp: row.season_xp || 0,
      season: row.season || null,
      games: row.games || 0,
      wins: row.wins || 0,
      rank,
    };
  }

  /** Top of the current season, highest seasonal XP first. */
  function ladder(season, limit = 20) {
    const rows = db
      .prepare(
        `SELECT username, season_xp, xp, games, wins FROM users
         WHERE season = ? AND verified = 1
         ORDER BY season_xp DESC, xp DESC LIMIT ?`
      )
      .all(String(season || ''), Math.max(1, Math.min(100, limit)));
    return rows.map((r) => ({
      username: r.username,
      seasonXp: r.season_xp || 0,
      xp: r.xp || 0,
      games: r.games || 0,
      wins: r.wins || 0,
    }));
  }

  /**
   * Carries the name-based profile's progress (PlayerStore) over to the
   * account, ONCE: players who registered after playing as guests keep their
   * level and their place in the current season. Lifts the account up TO the
   * profile's values instead of adding them, so games already booked on the
   * account since verification are not counted twice; the XP difference also
   * goes into the given (current) season.
   * @returns {{imported:boolean, progress:object|null}}
   */
  function importProfile(username, { xp = 0, games = 0, wins = 0, season = null } = {}) {
    const name = String(username || '').trim();
    const row = db
      .prepare('SELECT id, xp, games, wins, season, season_xp, profile_imported FROM users WHERE username = ? AND verified = 1')
      .get(name);
    if (!row || row.profile_imported) return { imported: false, progress: row ? progressFor(name) : null };
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    const newXp = Math.max(row.xp || 0, n(xp));
    const delta = newXp - (row.xp || 0);
    const sameSeason = season && row.season === season;
    db.prepare(
      `UPDATE users SET xp = ?, games = ?, wins = ?, season = ?, season_xp = ?, profile_imported = 1
       WHERE id = ?`
    ).run(
      newXp,
      Math.max(row.games || 0, n(games)),
      Math.max(row.wins || 0, n(wins)),
      season || row.season,
      (sameSeason || !season ? row.season_xp || 0 : 0) + delta,
      row.id
    );
    return { imported: true, progress: progressFor(name) };
  }

  /** For the admin page: newest first. Never returns password data. */
  function listUsers(limit = 500) {
    const rows = db
      .prepare(
        `SELECT username, email, verified, created_at, verify_expires, xp, games, wins, season, season_xp,
                salt != '' AS has_password,
                (SELECT COUNT(*) FROM webauthn_credentials c WHERE c.user_id = users.id) AS passkeys
         FROM users ORDER BY created_at DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(5000, limit)));
    const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    return {
      total,
      users: rows.map((r) => ({
        username: r.username,
        email: r.email,
        verified: !!r.verified,
        createdAt: r.created_at,
        verifyExpires: r.verify_expires || null,
        xp: r.xp || 0,
        games: r.games || 0,
        wins: r.wins || 0,
        season: r.season || null,
        seasonXp: r.season_xp || 0,
        hasPassword: !!r.has_password,
        passkeys: r.passkeys || 0,
      })),
    };
  }

  /** Admin: remove an account and its login sessions. The name is free again. */
  function deleteUser(username) {
    const row = db.prepare('SELECT id, username FROM users WHERE username = ?').get(String(username || '').trim());
    if (!row) return { error: 'Benutzer nicht gefunden.' };
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(row.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
    return { ok: true, username: row.username };
  }

  /** Admin: fresh confirmation link for an UNVERIFIED account (the old one
   *  stops working). @returns {{ok, username, email, verifyToken}|{error}} */
  function renewVerification(username) {
    const row = db.prepare('SELECT id, username, email, verified FROM users WHERE username = ?').get(String(username || '').trim());
    if (!row) return { error: 'Benutzer nicht gefunden.' };
    if (row.verified) return { error: 'Dieses Konto ist bereits bestätigt.' };
    const verifyToken = randomToken();
    db.prepare('UPDATE users SET verify_token = ?, verify_expires = ? WHERE id = ?').run(verifyToken, Date.now() + VERIFY_TTL_MS, row.id);
    return { ok: true, username: row.username, email: row.email, verifyToken };
  }

  // --- Passkeys (WebAuthn) and e-mail login links ----------------------------
  // The WebAuthn ceremony itself lives in Passkeys.js; this store only keeps
  // what it needs: the credential's public key and signature counter.

  const credRow = (r) => ({
    id: r.id,
    publicKey: Buffer.from(r.public_key),
    counter: r.counter || 0,
    transports: r.transports ? JSON.parse(r.transports) : undefined,
    deviceType: r.device_type || null,
    backedUp: !!r.backed_up,
    name: r.name || null,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at || null,
  });

  function insertCredential(userId, cred) {
    db.prepare(
      `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(cred.id, userId, Buffer.from(cred.publicKey), cred.counter || 0,
      cred.transports ? JSON.stringify(cred.transports) : null, cred.deviceType || null, cred.backedUp ? 1 : 0,
      String(cred.name || '').slice(0, 60) || null, Date.now());
  }

  /** New account WITHOUT a password, created together with its first passkey
   *  (one transaction - a cancelled ceremony leaves nothing behind). */
  function registerWithPasskey(username, email, webauthnUserId, cred) {
    const v = validateNewAccount(username, email);
    if (v.error) return v;
    const verifyToken = randomToken();
    try {
      db.exec('BEGIN');
      const info = db.prepare(
        `INSERT INTO users (username, email, password_hash, salt, verified, verify_token, verify_expires, created_at, webauthn_user_id)
         VALUES (?, ?, ?, '', 0, ?, ?, ?, ?)`
      ).run(v.username, v.email, Buffer.alloc(0), verifyToken, Date.now() + VERIFY_TTL_MS, Date.now(), webauthnUserId);
      insertCredential(Number(info.lastInsertRowid), cred);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* nothing open */ }
      if (/UNIQUE/i.test(e.message)) return { error: 'Benutzername oder E-Mail ist bereits registriert.' };
      throw e;
    }
    return { ok: true, verifyToken, username: v.username };
  }

  /** The signed-in account behind a session token, with its login methods. */
  function accountForSession(token) {
    const s = sessionUser(token);
    if (!s) return null;
    const row = db.prepare('SELECT id, username, salt, webauthn_user_id FROM users WHERE username = ?').get(s.username);
    if (!row) return null;
    const creds = db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at').all(row.id).map(credRow);
    return { id: row.id, username: row.username, hasPassword: !!row.salt, webauthnUserId: row.webauthn_user_id || null, credentials: creds };
  }

  function setWebauthnUserId(userId, handle) {
    db.prepare('UPDATE users SET webauthn_user_id = ? WHERE id = ? AND webauthn_user_id IS NULL').run(handle, userId);
    return db.prepare('SELECT webauthn_user_id FROM users WHERE id = ?').get(userId).webauthn_user_id;
  }

  function addCredential(userId, cred) {
    try { insertCredential(userId, cred); } catch (e) {
      if (/UNIQUE/i.test(e.message)) return { error: 'Dieser Passkey ist bereits gespeichert.' };
      throw e;
    }
    return { ok: true };
  }

  /** Credential + owner for a login attempt. */
  function credentialById(credId) {
    const r = db.prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(String(credId || ''));
    if (!r) return null;
    const u = db.prepare('SELECT id, username, verified FROM users WHERE id = ?').get(r.user_id);
    if (!u) return null;
    return { credential: credRow(r), user: { id: u.id, username: u.username, verified: !!u.verified } };
  }

  function touchCredential(credId, counter) {
    db.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(counter || 0, Date.now(), String(credId));
  }

  /** Never removes the last way to sign in. */
  function deleteCredential(userId, credId) {
    const u = db.prepare('SELECT salt FROM users WHERE id = ?').get(userId);
    const n = db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?').get(userId).n;
    if (!u) return { error: 'Benutzer nicht gefunden.' };
    if (!u.salt && n <= 1) return { error: 'Das ist dein letzter Anmeldeweg - lege zuerst ein Passwort oder einen weiteren Passkey an.' };
    const r = db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(String(credId), userId);
    return r.changes ? { ok: true } : { error: 'Passkey nicht gefunden.' };
  }

  function setPassword(userId, password) {
    password = String(password || '');
    if (password.length < 8 || password.length > 200) return { error: 'Das Passwort muss mindestens 8 Zeichen lang sein.' };
    const salt = randomToken();
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hashPassword(password, salt), salt, userId);
    return { ok: true };
  }

  function removePassword(userId) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?').get(userId).n;
    if (!n) return { error: 'Ohne Passkey kann das Passwort nicht entfernt werden - es ist sonst dein letzter Anmeldeweg.' };
    db.prepare("UPDATE users SET password_hash = ?, salt = '' WHERE id = ?").run(Buffer.alloc(0), userId);
    return { ok: true };
  }

  /** A session for an account that proved itself another way (passkey,
   *  login link). Same rules as a password login: confirmed accounts only. */
  function sessionForUser(userId) {
    const u = db.prepare('SELECT id, username, verified FROM users WHERE id = ?').get(userId);
    if (!u) return { error: 'Benutzer nicht gefunden.' };
    if (!u.verified) return { error: 'Bitte zuerst die E-Mail-Adresse bestätigen (Link in der Mail).' };
    const token = randomToken();
    db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL_MS);
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, u.id, Date.now());
    return { ok: true, token, username: u.username };
  }

  const sha256hex = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

  /** E-mail login link for a CONFIRMED account (null otherwise - the caller
   *  answers the same either way, so the link form reveals no accounts). */
  function createLoginLink(usernameOrEmail, ttlMs = LOGIN_LINK_TTL_MS) {
    const key = String(usernameOrEmail || '').trim();
    const u = db.prepare('SELECT id, username, email, verified FROM users WHERE username = ? OR email = ?').get(key, key);
    if (!u || !u.verified) return null;
    const token = randomToken();
    db.prepare('UPDATE users SET login_token_hash = ?, login_expires = ? WHERE id = ?').run(sha256hex(token), Date.now() + ttlMs, u.id);
    return { username: u.username, email: u.email, token };
  }

  /** Single use: the link is spent even if the session cannot be created. */
  function consumeLoginLink(token) {
    const u = db.prepare('SELECT id, login_expires FROM users WHERE login_token_hash = ?').get(sha256hex(token || ''));
    if (!u) return { error: 'Dieser Anmelde-Link ist ungültig oder wurde schon benutzt.' };
    db.prepare('UPDATE users SET login_token_hash = NULL, login_expires = NULL WHERE id = ?').run(u.id);
    if (Date.now() > u.login_expires) return { error: 'Dieser Anmelde-Link ist abgelaufen - bitte einen neuen anfordern.' };
    return sessionForUser(u.id);
  }

  function close() {
    db.close();
  }

  return {
    register, verifyEmail, login, sessionUser, logout, isRegisteredName,
    addGameResult, progressFor, ladder, importProfile, listUsers, deleteUser, renewVerification,
    validateNewAccount, registerWithPasskey, accountForSession, setWebauthnUserId, addCredential,
    credentialById, touchCredential, deleteCredential, setPassword, removePassword, sessionForUser,
    createLoginLink, consumeLoginLink,
    close, _db: db, // _db: Test-Seam (Ablauf-Simulation)
  };
}

/**
 * Backend auto-selection for the server:
 * 1. PIKDAME_DATABASE_URL set (postgres://...) -> PostgreSQL (shared,
 *    networked - the right choice for the Docker/K8s stack and the
 *    prerequisite for ever running more than one instance)
 * 2. otherwise node:sqlite available (Node >= 22) -> SQLite (zero-config
 *    fallback for a single container)
 * 3. otherwise (e.g. iOS CodeApp) -> null, accounts disabled
 */
function createAccountStoreAuto(env = process.env) {
  if (env.PIKDAME_DATABASE_URL) {
    const { createPgAccountStore } = require('./PgAccountStore');
    const { readSecret } = require('./secretEnv');
    const store = createPgAccountStore(env.PIKDAME_DATABASE_URL, {
      password: readSecret(env, 'PIKDAME_DATABASE_PASSWORD'),
    });
    if (store) return store;
    console.error("PIKDAME_DATABASE_URL is set but the 'pg' package is unavailable - falling back to SQLite.");
  }
  const sqliteStore = createAccountStore();
  if (sqliteStore) sqliteStore.backend = 'sqlite';
  return sqliteStore;
}

module.exports = { createAccountStore, createAccountStoreAuto };
