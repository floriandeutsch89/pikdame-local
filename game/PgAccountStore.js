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
const LOGIN_LINK_TTL_MS = 15 * 60 * 1000; // e-mail login link
// Sign-up without a password: the mail carries a 6-digit code (typed into the
// open dialog, so the passkey is created on THIS device) next to the link.
const SIGNUP_CODE_TTL_MS = 15 * 60 * 1000;
const SIGNUP_CODE_TRIES = 5;

function signupCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Bound to the account id, so equal codes of two accounts hash differently. */
function codeHash(userId, code) {
  return crypto.createHash('sha256').update(`${userId}:${String(code || '').trim()}`).digest('hex');
}

function codeMatches(userId, code, stored) {
  const a = Buffer.from(codeHash(userId, code));
  const b = Buffer.from(String(stored || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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
  -- Progression (XP, level, season ladder). Additive and idempotent so an
  -- existing database from an older version migrates on the next start.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS games INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS season TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS season_xp BIGINT NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS users_season_xp ON users (season, season_xp DESC);
  -- Set once the guest profile's progress was carried over (importProfile).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_imported BOOLEAN NOT NULL DEFAULT FALSE;
  -- Passkeys: per-account WebAuthn user handle, e-mail login link (only a
  -- SHA-256 of the token is stored), and the credentials themselves.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS webauthn_user_id TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS login_token_hash TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS login_expires BIGINT;
  -- Sign-up code (password-less registration): hash, expiry, attempts.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code_hash TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code_expires BIGINT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code_tries INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BYTEA NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    transports TEXT,
    device_type TEXT,
    backed_up BOOLEAN NOT NULL DEFAULT FALSE,
    name TEXT,
    created_at BIGINT NOT NULL,
    last_used_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS webauthn_credentials_user ON webauthn_credentials (user_id);
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
    // Opt-in-Hygiene (siehe AccountStore): abgelaufene Unbestätigte räumen.
    // Fehler-tolerant: Hygiene darf die Registrierung nie blockieren - und
    // bei unerreichbarer DB übernimmt die reguläre Fehlerbehandlung unten
    // (fails closed, wirft nicht - siehe Degradations-Test).
    try {
      await pool.query('DELETE FROM users WHERE verified = FALSE AND verify_expires < $1', [Date.now()]);
    } catch (e) { /* Cleanup ist Komfort */ }
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
      await pool.query(
        `UPDATE users SET verified = TRUE, verify_token = NULL, verify_expires = NULL,
           verify_code_hash = NULL, verify_code_expires = NULL WHERE id = $1`, [row.id]
      );
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
      // Prune expired sessions on login (see AccountStore) - failure-tolerant,
      // housekeeping must never block a login.
      await pool.query('DELETE FROM sessions WHERE created_at < $1', [Date.now() - SESSION_TTL_MS]).catch(() => {});
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

  // --- Progression: XP, level and the seasonal ladder ----------------------
  // Same contract as the SQLite store. Every path fails SOFT (null / empty
  // list): a ladder that cannot be read must never break a finished game.

  async function addGameResult(username, { xp = 0, won = false, season = null } = {}) {
    try {
      await ensureReady();
      const gain = Math.max(0, Math.round(Number(xp) || 0));
      // season_xp resets when the stored season differs from the current one;
      // lifetime xp keeps accumulating. Done in ONE statement so two games
      // finishing at the same moment cannot lose an update.
      await pool.query(
        `UPDATE users
            SET xp = xp + $2,
                games = games + 1,
                wins = wins + $3,
                season_xp = CASE WHEN season IS NOT DISTINCT FROM $4 THEN season_xp + $2 ELSE $2 END,
                season = $4
          WHERE LOWER(username) = LOWER($1) AND verified = TRUE`,
        [String(username || '').trim(), gain, won ? 1 : 0, season]
      );
      return await progressFor(username);
    } catch (e) {
      console.error('Postgres addGameResult failed:', e.message);
      return null;
    }
  }

  /**
   * Same contract as AccountStore.importProfile: once per account, lift the
   * account up TO the guest profile's values (no double counting), the XP
   * difference also into the given season. ONE statement: SET expressions
   * read the old row, and the profile_imported guard makes a concurrent
   * second call a no-op.
   */
  async function importProfile(username, { xp = 0, games = 0, wins = 0, season = null } = {}) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    try {
      await ensureReady();
      const r = await pool.query(
        `UPDATE users
            SET xp = GREATEST(xp, $2),
                games = GREATEST(games, $3),
                wins = GREATEST(wins, $4),
                season_xp = (CASE WHEN $5::text IS NULL OR season IS NOT DISTINCT FROM $5 THEN season_xp ELSE 0 END)
                            + GREATEST($2 - xp, 0),
                season = COALESCE($5, season),
                profile_imported = TRUE
          WHERE LOWER(username) = LOWER($1) AND verified = TRUE AND profile_imported = FALSE`,
        [String(username || '').trim(), n(xp), n(games), n(wins), season]
      );
      return { imported: r.rowCount > 0, progress: await progressFor(username) };
    } catch (e) {
      console.error('Postgres importProfile failed:', e.message);
      return { imported: false, progress: null };
    }
  }

  /** For the admin page: newest first. Never returns password data. */
  async function listUsers(limit = 500) {
    try {
      await ensureReady();
      const lim = Math.max(1, Math.min(5000, Number(limit) || 500));
      const [rows, count] = await Promise.all([
        pool.query(
          `SELECT username, email, verified, created_at, verify_expires, xp, games, wins, season, season_xp,
                  salt <> '' AS has_password,
                  (SELECT COUNT(*)::int FROM webauthn_credentials c WHERE c.user_id = users.id) AS passkeys
             FROM users ORDER BY created_at DESC LIMIT $1`,
          [lim]
        ),
        pool.query('SELECT COUNT(*)::int AS n FROM users'),
      ]);
      return {
        total: count.rows[0].n,
        users: rows.rows.map((r) => ({
          username: r.username,
          email: r.email,
          verified: !!r.verified,
          createdAt: Number(r.created_at),
          verifyExpires: r.verify_expires ? Number(r.verify_expires) : null,
          xp: Number(r.xp) || 0,
          games: r.games || 0,
          wins: r.wins || 0,
          season: r.season || null,
          seasonXp: Number(r.season_xp) || 0,
          hasPassword: !!r.has_password,
          passkeys: r.passkeys || 0,
        })),
      };
    } catch (e) {
      console.error('Postgres listUsers failed:', e.message);
      return { total: 0, users: [], error: e.message };
    }
  }

  /** Admin: remove an account; sessions go with it (ON DELETE CASCADE). */
  async function deleteUser(username) {
    try {
      await ensureReady();
      const r = await pool.query('DELETE FROM users WHERE LOWER(username) = LOWER($1) RETURNING username', [String(username || '').trim()]);
      return r.rows.length ? { ok: true, username: r.rows[0].username } : { error: 'Benutzer nicht gefunden.' };
    } catch (e) {
      console.error('Postgres deleteUser failed:', e.message);
      return { error: 'Datenbankfehler - bitte erneut versuchen.' };
    }
  }

  /** Admin: fresh confirmation link for an UNVERIFIED account. */
  async function renewVerification(username) {
    try {
      await ensureReady();
      const verifyToken = randomToken();
      const r = await pool.query(
        `UPDATE users SET verify_token = $2, verify_expires = $3
          WHERE LOWER(username) = LOWER($1) AND verified = FALSE
          RETURNING username, email, salt`,
        [String(username || '').trim(), verifyToken, Date.now() + VERIFY_TTL_MS]
      );
      if (r.rows.length) {
        const row = r.rows[0];
        return { ok: true, username: row.username, email: row.email, verifyToken, passwordless: !row.salt };
      }
      const exists = await pool.query('SELECT verified FROM users WHERE LOWER(username) = LOWER($1)', [String(username || '').trim()]);
      return { error: exists.rows.length ? 'Dieses Konto ist bereits bestätigt.' : 'Benutzer nicht gefunden.' };
    } catch (e) {
      console.error('Postgres renewVerification failed:', e.message);
      return { error: 'Datenbankfehler - bitte erneut versuchen.' };
    }
  }

  // --- Passkeys (WebAuthn) and e-mail login links ----------------------------
  // Same contract as AccountStore.js (SQLite); see the comments there.

  const credRow = (r) => ({
    id: r.id,
    publicKey: Buffer.from(r.public_key),
    counter: Number(r.counter) || 0,
    transports: r.transports ? JSON.parse(r.transports) : undefined,
    deviceType: r.device_type || null,
    backedUp: !!r.backed_up,
    name: r.name || null,
    createdAt: Number(r.created_at),
    lastUsedAt: r.last_used_at ? Number(r.last_used_at) : null,
  });

  const credValues = (userId, cred) => [cred.id, userId, Buffer.from(cred.publicKey), cred.counter || 0,
    cred.transports ? JSON.stringify(cred.transports) : null, cred.deviceType || null, !!cred.backedUp,
    String(cred.name || '').slice(0, 60) || null, Date.now()];
  const INSERT_CRED = `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

  async function validateNewAccount(username, email) {
    try {
      await ensureReady();
      await pool.query('DELETE FROM users WHERE verified = FALSE AND verify_expires < $1', [Date.now()]).catch(() => {});
      username = String(username || '').trim();
      email = String(email || '').trim();
      if (!/^[\p{L}\p{N} _.-]{2,24}$/u.test(username)) {
        return { error: 'Der Benutzername muss 2-24 Zeichen lang sein (Buchstaben, Zahlen, Leer-, Binde-, Unterstrich, Punkt).' };
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return { error: 'Bitte eine gültige E-Mail-Adresse angeben.' };
      }
      const r = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)', [username, email]);
      if (r.rows.length) return { error: 'Benutzername oder E-Mail ist bereits registriert.' };
      return { ok: true, username, email };
    } catch (e) {
      console.error('Postgres validateNewAccount failed:', e.message);
      return DB_DOWN;
    }
  }

  async function registerWithoutPassword(username, email) {
    const v = await validateNewAccount(username, email);
    if (v.error) return v;
    const verifyToken = randomToken();
    try {
      const r = await pool.query(
        `INSERT INTO users (username, email, password_hash, salt, verified, verify_token, verify_expires, created_at)
         VALUES ($1, $2, $3, '', FALSE, $4, $5, $6) RETURNING id`,
        [v.username, v.email, Buffer.alloc(0), verifyToken, Date.now() + VERIFY_TTL_MS, Date.now()]
      );
      const code = await setSignupCode(Number(r.rows[0].id));
      return { ok: true, verifyToken, code, username: v.username };
    } catch (e) {
      if (e.code === '23505') return { error: 'Benutzername oder E-Mail ist bereits registriert.' };
      console.error('Postgres registerWithoutPassword failed:', e.message);
      return DB_DOWN;
    }
  }

  async function setSignupCode(userId) {
    const code = signupCode();
    await pool.query(
      'UPDATE users SET verify_code_hash = $2, verify_code_expires = $3, verify_code_tries = 0 WHERE id = $1',
      [userId, codeHash(userId, code), Date.now() + SIGNUP_CODE_TTL_MS]
    );
    return code;
  }

  async function renewSignupCode(email) {
    try {
      await ensureReady();
      const r = await pool.query('SELECT id, username, email, verified FROM users WHERE LOWER(email) = LOWER($1)', [String(email || '').trim()]);
      const u = r.rows[0];
      if (!u || u.verified) return null;
      const id = Number(u.id);
      const verifyToken = randomToken();
      await pool.query('UPDATE users SET verify_token = $2, verify_expires = $3 WHERE id = $1', [id, verifyToken, Date.now() + VERIFY_TTL_MS]);
      return { username: u.username, email: u.email, verifyToken, code: await setSignupCode(id) };
    } catch (e) {
      console.error('Postgres renewSignupCode failed:', e.message);
      return null;
    }
  }

  async function verifyCodeAndSignIn(email, code) {
    const bad = { error: 'Der Code stimmt nicht.' };
    try {
      await ensureReady();
      // Count the attempt atomically BEFORE comparing: parallel guesses cannot
      // get past SIGNUP_CODE_TRIES.
      const r = await pool.query(
        `UPDATE users SET verify_code_tries = verify_code_tries + 1
          WHERE LOWER(email) = LOWER($1) AND verified = FALSE AND verify_code_hash IS NOT NULL
            AND verify_code_tries < $2 AND verify_code_expires >= $3
          RETURNING id, verify_code_hash`,
        [String(email || '').trim(), SIGNUP_CODE_TRIES, Date.now()]
      );
      const u = r.rows[0];
      if (!u) {
        const q = await pool.query(
          'SELECT verify_code_hash FROM users WHERE LOWER(email) = LOWER($1) AND verified = FALSE', [String(email || '').trim()]
        );
        return q.rows[0] && q.rows[0].verify_code_hash ? { error: 'Der Code ist abgelaufen - bitte einen neuen anfordern.' } : bad;
      }
      const id = Number(u.id);
      if (!codeMatches(id, code, u.verify_code_hash)) return bad;
      await pool.query(
        `UPDATE users SET verified = TRUE, verify_token = NULL, verify_expires = NULL,
           verify_code_hash = NULL, verify_code_expires = NULL WHERE id = $1`, [id]
      );
      return sessionForUser(id);
    } catch (e) {
      console.error('Postgres verifyCodeAndSignIn failed:', e.message);
      return DB_DOWN;
    }
  }

  async function verifyAndSignIn(token) {
    const v = await verifyEmail(token);
    if (v.error) return v;
    try {
      const r = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [v.username]);
      return r.rows[0] ? sessionForUser(Number(r.rows[0].id)) : { error: 'Benutzer nicht gefunden.' };
    } catch (e) {
      console.error('Postgres verifyAndSignIn failed:', e.message);
      return DB_DOWN;
    }
  }

  async function accountForSession(token) {
    const s = await sessionUser(token);
    if (!s) return null;
    try {
      const u = await pool.query('SELECT id, username, email, salt, webauthn_user_id FROM users WHERE LOWER(username) = LOWER($1)', [s.username]);
      const row = u.rows[0];
      if (!row) return null;
      const c = await pool.query('SELECT * FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at', [row.id]);
      return { id: Number(row.id), username: row.username, email: row.email, hasPassword: !!row.salt, webauthnUserId: row.webauthn_user_id || null, credentials: c.rows.map(credRow) };
    } catch (e) {
      console.error('Postgres accountForSession failed:', e.message);
      return null;
    }
  }

  async function setWebauthnUserId(userId, handle) {
    await pool.query('UPDATE users SET webauthn_user_id = $2 WHERE id = $1 AND webauthn_user_id IS NULL', [userId, handle]);
    const r = await pool.query('SELECT webauthn_user_id FROM users WHERE id = $1', [userId]);
    return r.rows[0] ? r.rows[0].webauthn_user_id : null;
  }

  async function addCredential(userId, cred) {
    try {
      await pool.query(INSERT_CRED, credValues(userId, cred));
      return { ok: true };
    } catch (e) {
      if (e.code === '23505') return { error: 'Dieser Passkey ist bereits gespeichert.' };
      console.error('Postgres addCredential failed:', e.message);
      return DB_DOWN;
    }
  }

  async function credentialById(credId) {
    try {
      await ensureReady();
      const r = await pool.query(
        `SELECT c.*, u.id AS uid, u.username, u.email, u.verified, u.webauthn_user_id
           FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
        [String(credId || '')]
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        credential: credRow(row),
        user: { id: Number(row.uid), username: row.username, email: row.email, verified: !!row.verified, webauthnUserId: row.webauthn_user_id || null },
      };
    } catch (e) {
      console.error('Postgres credentialById failed:', e.message);
      return null;
    }
  }

  async function touchCredential(credId, counter) {
    await pool.query('UPDATE webauthn_credentials SET counter = $2, last_used_at = $3 WHERE id = $1', [String(credId), counter || 0, Date.now()])
      .catch((e) => console.error('Postgres touchCredential failed:', e.message));
  }

  async function deleteCredential(userId, credId) {
    try {
      const u = await pool.query('SELECT salt FROM users WHERE id = $1', [userId]);
      const n = await pool.query('SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = $1', [userId]);
      if (!u.rows[0]) return { error: 'Benutzer nicht gefunden.' };
      if (!u.rows[0].salt && n.rows[0].n <= 1) return { error: 'Das ist dein letzter Anmeldeweg - lege zuerst ein Passwort oder einen weiteren Passkey an.' };
      const r = await pool.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [String(credId), userId]);
      return r.rowCount ? { ok: true } : { error: 'Passkey nicht gefunden.' };
    } catch (e) {
      console.error('Postgres deleteCredential failed:', e.message);
      return DB_DOWN;
    }
  }

  async function setPassword(userId, password) {
    password = String(password || '');
    if (password.length < 8 || password.length > 200) return { error: 'Das Passwort muss mindestens 8 Zeichen lang sein.' };
    try {
      const salt = randomToken();
      await pool.query('UPDATE users SET password_hash = $2, salt = $3 WHERE id = $1', [userId, hashPassword(password, salt), salt]);
      return { ok: true };
    } catch (e) {
      console.error('Postgres setPassword failed:', e.message);
      return DB_DOWN;
    }
  }

  async function removePassword(userId) {
    try {
      const n = await pool.query('SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = $1', [userId]);
      if (!n.rows[0].n) return { error: 'Ohne Passkey kann das Passwort nicht entfernt werden - es ist sonst dein letzter Anmeldeweg.' };
      await pool.query("UPDATE users SET password_hash = $2, salt = '' WHERE id = $1", [userId, Buffer.alloc(0)]);
      return { ok: true };
    } catch (e) {
      console.error('Postgres removePassword failed:', e.message);
      return DB_DOWN;
    }
  }

  async function sessionForUser(userId) {
    try {
      await ensureReady();
      const r = await pool.query('SELECT id, username, verified FROM users WHERE id = $1', [userId]);
      const u = r.rows[0];
      if (!u) return { error: 'Benutzer nicht gefunden.' };
      if (!u.verified) return { error: 'Bitte zuerst die E-Mail-Adresse bestätigen (Link in der Mail).' };
      const token = randomToken();
      await pool.query('DELETE FROM sessions WHERE created_at < $1', [Date.now() - SESSION_TTL_MS]).catch(() => {});
      await pool.query('INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)', [token, u.id, Date.now()]);
      return { ok: true, token, username: u.username };
    } catch (e) {
      console.error('Postgres sessionForUser failed:', e.message);
      return DB_DOWN;
    }
  }

  const sha256hex = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

  async function createLoginLink(usernameOrEmail, ttlMs = LOGIN_LINK_TTL_MS) {
    try {
      await ensureReady();
      const key = String(usernameOrEmail || '').trim();
      const r = await pool.query(
        'SELECT id, username, email, verified FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)', [key]
      );
      const u = r.rows[0];
      if (!u || !u.verified) return null;
      const token = randomToken();
      await pool.query('UPDATE users SET login_token_hash = $2, login_expires = $3 WHERE id = $1', [u.id, sha256hex(token), Date.now() + ttlMs]);
      return { username: u.username, email: u.email, token };
    } catch (e) {
      console.error('Postgres createLoginLink failed:', e.message);
      return null;
    }
  }

  async function consumeLoginLink(token) {
    try {
      await ensureReady();
      // Spend the link atomically: two clicks on the same link cannot both win.
      const r = await pool.query(
        `WITH hit AS (SELECT id, login_expires FROM users WHERE login_token_hash = $1 FOR UPDATE)
         UPDATE users u SET login_token_hash = NULL, login_expires = NULL
           FROM hit WHERE u.id = hit.id
         RETURNING u.id, hit.login_expires AS exp`,
        [sha256hex(token || '')]
      );
      const u = r.rows[0];
      if (!u) return { error: 'Dieser Anmelde-Link ist ungültig oder wurde schon benutzt.' };
      if (u.exp == null || Date.now() > Number(u.exp)) return { error: 'Dieser Anmelde-Link ist abgelaufen - bitte einen neuen anfordern.' };
      return sessionForUser(Number(u.id));
    } catch (e) {
      console.error('Postgres consumeLoginLink failed:', e.message);
      return DB_DOWN;
    }
  }

  async function progressFor(username) {
    try {
      await ensureReady();
      const r = await pool.query(
        'SELECT username, xp, games, wins, season, season_xp FROM users WHERE LOWER(username) = LOWER($1)',
        [String(username || '').trim()]
      );
      const row = r.rows[0];
      if (!row) return null;
      let rank = null;
      if (row.season) {
        const rr = await pool.query(
          'SELECT COUNT(*)::int AS n FROM users WHERE season = $1 AND season_xp > $2',
          [row.season, row.season_xp]
        );
        rank = (rr.rows[0] ? rr.rows[0].n : 0) + 1;
      }
      return {
        username: row.username,
        xp: Number(row.xp) || 0,
        seasonXp: Number(row.season_xp) || 0,
        season: row.season || null,
        games: row.games || 0,
        wins: row.wins || 0,
        rank,
      };
    } catch (e) {
      console.error('Postgres progressFor failed:', e.message);
      return null;
    }
  }

  async function ladder(season, limit = 20) {
    try {
      await ensureReady();
      const r = await pool.query(
        `SELECT username, season_xp, xp, games, wins FROM users
          WHERE season = $1 AND verified = TRUE
          ORDER BY season_xp DESC, xp DESC LIMIT $2`,
        [String(season || ''), Math.max(1, Math.min(100, limit))]
      );
      return r.rows.map((row) => ({
        username: row.username,
        seasonXp: Number(row.season_xp) || 0,
        xp: Number(row.xp) || 0,
        games: row.games || 0,
        wins: row.wins || 0,
      }));
    } catch (e) {
      console.error('Postgres ladder failed:', e.message);
      return [];
    }
  }

  async function close() {
    await pool.end().catch(() => {});
  }

  return {
    backend: 'postgres',
    register, verifyEmail, login, sessionUser, logout, isRegisteredName,
    addGameResult, progressFor, ladder, importProfile, listUsers, deleteUser, renewVerification,
    validateNewAccount, registerWithoutPassword, verifyAndSignIn, renewSignupCode, verifyCodeAndSignIn, accountForSession, setWebauthnUserId, addCredential,
    credentialById, touchCredential, deleteCredential, setPassword, removePassword, sessionForUser,
    createLoginLink, consumeLoginLink,
    close,
  };
}

module.exports = { createPgAccountStore };
