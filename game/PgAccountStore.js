// game/PgAccountStore.js
// User accounts in PostgreSQL (the only backend; every method is async).
// Registration with e-mail confirmation, login, passkeys, progression and
// season ladder; passwords hashed with scrypt + salt, tokens 32 random bytes.
//
// Resilience: ensureReady() applies the migrations on first use and retries on
// connection errors - if Postgres is temporarily down, account API calls
// fail with a clear message and recover automatically once it is back.
// Instants are TIMESTAMPTZ in the tables (migrations/008) and ms in the API.
const crypto = require('crypto');
const { SEASON_ID_RE, seasonStandings } = require('./Progression');
const { createPool } = require('./Database');
const { ensureMigrated } = require('./Migrations');
const { upsertPlayerId, keyOf } = require('./PlayerStore');

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

/** A Date `ms` from now (the app clock decides expiry, as before the TIMESTAMPTZ move). */
const fromNow = (ms) => new Date(Date.now() + ms);
const msOf = (d) => (d ? d.getTime() : null);

/**
 * @param {string|import('pg').Pool} db connection string (own pool, ended by
 *   close()) or the server's shared pool (left open by close())
 * @returns {Object} async store API
 */
function createPgAccountStore(db) {
  const ownsPool = typeof db === 'string';
  const pool = ownsPool ? createPool(db) : db;

  // The schema lives in migrations/ (see Migrations.js); retried after a failure.
  let linking = null;
  const ensureReady = async () => {
    await ensureMigrated(pool);
    linking = linking || linkPlayers().catch((e) => {
      linking = null;
      console.error('Postgres linkPlayers failed:', e.message);
    });
    await linking;
  };

  const DB_DOWN = { error: 'Konto-Datenbank ist gerade nicht erreichbar - bitte später erneut versuchen.' };

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** The e-mail is confirmed: the account now owns its name, i.e. its player - unless another
   *  account holds that player (two names one lower-casing apart): then it stays unlinked.
   *  A player made here has no age: its first game is still to come (year review). */
  async function confirmAccount(q, userId, username) {
    const at = new Date();
    const playerId = await upsertPlayerId(q, username, at, null);
    await q.query(
      `UPDATE users SET email_verified = TRUE, verify_token = NULL, verify_expires_at = NULL,
         verify_code_hash = NULL, verify_code_expires_at = NULL, updated_at = $3,
         player_id = (SELECT $2::bigint WHERE NOT EXISTS (SELECT 1 FROM users o WHERE o.player_id = $2 AND o.id <> $1))
       WHERE id = $1`,
      [userId, playerId, at]
    );
  }

  /** Confirmed accounts without a player (from before 008), once per process. In JS
   *  because the key is keyOf(); SQL lower() depends on the database's locale. */
  async function linkPlayers() {
    const unlinked = 'SELECT id, username FROM users WHERE email_verified AND player_id IS NULL ORDER BY id';
    if (!(await pool.query(`${unlinked} LIMIT 1`)).rows.length) return;
    // Replicas start together: the second one waits here and finds nothing left.
    const [linked, found] = await withTransaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(726817)');
      const { rows } = await c.query(unlinked);
      const links = JSON.stringify(rows.map((r) => ({ user_id: Number(r.id), player_key: keyOf(r.username), player_name: r.username.trim() })));
      await c.query(
        `INSERT INTO players (player_key, player_name, created_at)
         SELECT DISTINCT ON (x.player_key) x.player_key, x.player_name, NULL
           FROM jsonb_to_recordset($1::jsonb) AS x(user_id BIGINT, player_key TEXT, player_name TEXT)
          ORDER BY x.player_key, x.user_id
         ON CONFLICT (player_key) DO NOTHING`, [links]
      );
      // The lowest id wins a key two accounts share; the other stays unlinked (logged).
      const r = await c.query(
        `UPDATE users u SET player_id = p.id, updated_at = now()
           FROM (SELECT DISTINCT ON (x.player_key) x.user_id, x.player_key
                   FROM jsonb_to_recordset($1::jsonb) AS x(user_id BIGINT, player_key TEXT)
                  ORDER BY x.player_key, x.user_id) x
           JOIN players p ON p.player_key = x.player_key
          WHERE u.id = x.user_id AND u.email_verified AND u.player_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM users o WHERE o.player_id = p.id)`, [links]
      );
      return [r.rowCount, rows.length];
    });
    if (!found) return;
    console.log(`[db] accounts: ${linked} confirmed account(s) linked to their player`
      + (found > linked ? `, ${found - linked} left unlinked (the player belongs to another account)` : ''));
  }

  /** Before a row moves on to a new season: keep the old one for its finale. */
  async function archiveSeason(client, row) {
    if (!row.season || !(Number(row.season_xp) > 0 || Number(row.season_games) > 0)) return;
    await client.query(
      `INSERT INTO season_archive (user_id, season, season_xp, season_games) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, season) DO NOTHING`,
      [row.id, row.season, Number(row.season_xp) || 0, Number(row.season_games) || 0]
    );
  }

  async function register(username, email, password) {
    // Unconfirmed accounts with an expired link would block name and e-mail
    // forever. Best effort: an unreachable DB is handled below (fails closed).
    try {
      await pool.query('DELETE FROM users WHERE email_verified = FALSE AND verify_expires_at < $1', [new Date()]);
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
        `INSERT INTO users (username, email, password_hash, password_salt, email_verified, verify_token, verify_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7, $7)`,
        [username, email, hashPassword(password, salt), salt, verifyToken, fromNow(VERIFY_TTL_MS), new Date()]
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
      const r = await pool.query('SELECT id, username, verify_expires_at FROM users WHERE verify_token = $1', [String(token || '')]);
      const row = r.rows[0];
      if (!row) return { error: 'Ungültiger oder bereits verwendeter Bestätigungslink.' };
      if (Date.now() > (msOf(row.verify_expires_at) || 0)) return { error: 'Der Bestätigungslink ist abgelaufen - bitte neu registrieren.' };
      await withTransaction((c) => confirmAccount(c, row.id, row.username));
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
        'SELECT id, username, password_hash, password_salt, email_verified FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)',
        [key]
      );
      const row = r.rows[0];
      // Hash even for unknown users (no observable timing difference)
      const candidate = hashPassword(String(password || ''), row ? row.password_salt : 'no-user-salt');
      const stored = row ? Buffer.from(row.password_hash) : Buffer.alloc(SCRYPT_KEYLEN);
      const match = stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
      if (!row || !match) return { error: 'Benutzername/E-Mail oder Passwort ist falsch.' };
      if (!row.email_verified) return { error: 'Bitte zuerst die E-Mail-Adresse bestätigen (Link in der Mail).' };
      const token = randomToken();
      // Prune expired sessions on login - failure-tolerant,
      // housekeeping must never block a login.
      await pool.query('DELETE FROM login_sessions WHERE created_at < $1', [fromNow(-SESSION_TTL_MS)]).catch(() => {});
      await pool.query('INSERT INTO login_sessions (session_token, user_id, created_at) VALUES ($1, $2, $3)', [token, row.id, new Date()]);
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
        'SELECT u.username, s.created_at FROM login_sessions s JOIN users u ON u.id = s.user_id WHERE s.session_token = $1',
        [String(token)]
      );
      const row = r.rows[0];
      if (!row) return null;
      if (Date.now() - row.created_at.getTime() > SESSION_TTL_MS) {
        await pool.query('DELETE FROM login_sessions WHERE session_token = $1', [String(token)]);
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
      await pool.query('DELETE FROM login_sessions WHERE session_token = $1', [String(token || '')]);
    } catch (e) {
      console.error('Postgres logout failed:', e.message);
    }
  }

  /** Is this name a VERIFIED account? Fails closed on DB errors: an
   *  unreachable database must not open the door to name theft. */
  async function isRegisteredName(name) {
    try {
      await ensureReady();
      const r = await pool.query('SELECT email_verified FROM users WHERE LOWER(username) = LOWER($1)', [String(name || '').trim()]);
      return !!(r.rows[0] && r.rows[0].email_verified);
    } catch (e) {
      console.error('Postgres isRegisteredName failed:', e.message);
      return false;
    }
  }

  // --- Progression: XP, level and the seasonal ladder ----------------------
  // Every path fails SOFT (null / empty list): a ladder that cannot be read
  // must never break a finished game.

  async function addGameResult(username, { xp = 0, won = false, season = null } = {}) {
    try {
      await ensureReady();
      const gain = Math.max(0, Math.round(Number(xp) || 0));
      // season_xp/season_games reset when the stored season differs from the
      // current one; lifetime xp keeps accumulating. The row lock serializes
      // two games finishing at once, the archive keeps the finished season.
      const booked = await withTransaction(async (c) => {
        const r = await c.query(
          `SELECT id, season, season_xp, season_games FROM users
            WHERE LOWER(username) = LOWER($1) AND email_verified = TRUE FOR UPDATE`,
          [String(username || '').trim()]
        );
        const row = r.rows[0];
        if (!row) return false;
        if (season && row.season !== season) await archiveSeason(c, row);
        await c.query(
          `UPDATE users
              SET xp = xp + $2,
                  games_played = games_played + 1,
                  games_won = games_won + $3,
                  season_xp = CASE WHEN season IS NOT DISTINCT FROM $4 THEN season_xp + $2 ELSE $2 END,
                  season_games = CASE WHEN season IS NOT DISTINCT FROM $4 THEN season_games + 1 ELSE 1 END,
                  season = $4,
                  updated_at = now()
            WHERE id = $1`,
          [row.id, gain, won ? 1 : 0, season]
        );
        return true;
      });
      return booked ? await progressFor(username) : null;
    } catch (e) {
      console.error('Postgres addGameResult failed:', e.message);
      return null;
    }
  }

  /** XP from outside a match (bot tower first star): lifetime and season XP, no game booked. */
  async function addXp(username, { xp = 0, season = null } = {}) {
    try {
      await ensureReady();
      const gain = Math.max(0, Math.round(Number(xp) || 0));
      let booked = false;
      await withTransaction(async (c) => {
        const r = await c.query(
          `SELECT id, season, season_xp, season_games FROM users
            WHERE LOWER(username) = LOWER($1) AND email_verified = TRUE FOR UPDATE`,
          [String(username || '').trim()]
        );
        const row = r.rows[0];
        if (!row) return;
        if (season && row.season !== season) await archiveSeason(c, row);
        await c.query(
          `UPDATE users
              SET xp = xp + $2,
                  season_xp = CASE WHEN season IS NOT DISTINCT FROM $3 THEN season_xp + $2 ELSE $2 END,
                  season_games = CASE WHEN season IS NOT DISTINCT FROM $3 THEN season_games ELSE 0 END,
                  season = $3,
                  updated_at = now()
            WHERE id = $1`,
          [row.id, gain, season]
        );
        booked = true;
      });
      return booked ? await progressFor(username) : null;
    } catch (e) {
      console.error('Postgres addXp failed:', e.message);
      return null;
    }
  }

  /**
   * The guest profile's progress (PlayerStore) once per account: lift the
   * account up TO its values (no double counting), season untouched - guest
   * XP never buys a podium. ONE statement: the profile_imported guard makes a concurrent
   * second call a no-op.
   */
  async function importProfile(username, { xp = 0, games = 0, wins = 0 } = {}) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    try {
      await ensureReady();
      const r = await pool.query(
        `UPDATE users
            SET xp = GREATEST(xp, $2),
                games_played = GREATEST(games_played, $3),
                games_won = GREATEST(games_won, $4),
                profile_imported = TRUE,
                updated_at = now()
          WHERE LOWER(username) = LOWER($1) AND email_verified = TRUE AND profile_imported = FALSE`,
        [String(username || '').trim(), n(xp), n(games), n(wins)]
      );
      return { imported: r.rowCount > 0, progress: await progressFor(username) };
    } catch (e) {
      console.error('Postgres importProfile failed:', e.message);
      return { imported: false, progress: null };
    }
  }

  /** For the admin page: newest first (id = sign-up order, read backwards on the primary key). Never returns password data. */
  async function listUsers(limit = 500) {
    try {
      await ensureReady();
      const lim = Math.max(1, Math.min(5000, Number(limit) || 500));
      const [rows, count] = await Promise.all([
        pool.query(
          `SELECT username, email, email_verified, created_at, verify_expires_at, xp, games_played, games_won, season, season_xp,
                  password_salt <> '' AS has_password,
                  (SELECT COUNT(*)::int FROM webauthn_credentials c WHERE c.user_id = users.id) AS passkeys
             FROM users ORDER BY id DESC LIMIT $1`,
          [lim]
        ),
        pool.query('SELECT COUNT(*)::int AS n FROM users'),
      ]);
      return {
        total: count.rows[0].n,
        users: rows.rows.map((r) => ({
          username: r.username,
          email: r.email,
          verified: !!r.email_verified,
          createdAt: msOf(r.created_at),
          verifyExpires: msOf(r.verify_expires_at),
          xp: Number(r.xp) || 0,
          games: r.games_played || 0,
          wins: r.games_won || 0,
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
        `UPDATE users SET verify_token = $2, verify_expires_at = $3, updated_at = now()
          WHERE LOWER(username) = LOWER($1) AND email_verified = FALSE
          RETURNING username, email, password_salt`,
        [String(username || '').trim(), verifyToken, fromNow(VERIFY_TTL_MS)]
      );
      if (r.rows.length) {
        const row = r.rows[0];
        return { ok: true, username: row.username, email: row.email, verifyToken, passwordless: !row.password_salt };
      }
      const exists = await pool.query('SELECT email_verified FROM users WHERE LOWER(username) = LOWER($1)', [String(username || '').trim()]);
      return { error: exists.rows.length ? 'Dieses Konto ist bereits bestätigt.' : 'Benutzer nicht gefunden.' };
    } catch (e) {
      console.error('Postgres renewVerification failed:', e.message);
      return { error: 'Datenbankfehler - bitte erneut versuchen.' };
    }
  }

  // --- Passkeys (WebAuthn) and e-mail login links ----------------------------
  // The WebAuthn ceremony lives in Passkeys.js; this store keeps the
  // credential's public key and signature counter.

  const credRow = (r) => ({
    id: r.credential_id,
    publicKey: Buffer.from(r.public_key),
    counter: Number(r.sign_count) || 0,
    transports: r.transports ? JSON.parse(r.transports) : undefined,
    deviceType: r.device_type || null,
    backedUp: !!r.backed_up,
    name: r.credential_name || null,
    createdAt: msOf(r.created_at),
    lastUsedAt: msOf(r.last_used_at),
  });

  const credValues = (userId, cred) => [cred.id, userId, Buffer.from(cred.publicKey), cred.counter || 0,
    cred.transports ? JSON.stringify(cred.transports) : null, cred.deviceType || null, !!cred.backedUp,
    String(cred.name || '').slice(0, 60) || null, new Date()];
  const INSERT_CRED = `INSERT INTO webauthn_credentials (credential_id, user_id, public_key, sign_count, transports, device_type,
      backed_up, credential_name, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`;

  async function validateNewAccount(username, email) {
    try {
      await ensureReady();
      await pool.query('DELETE FROM users WHERE email_verified = FALSE AND verify_expires_at < $1', [new Date()]).catch(() => {});
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
        `INSERT INTO users (username, email, password_hash, password_salt, email_verified, verify_token, verify_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, '', FALSE, $4, $5, $6, $6) RETURNING id`,
        [v.username, v.email, Buffer.alloc(0), verifyToken, fromNow(VERIFY_TTL_MS), new Date()]
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
      'UPDATE users SET verify_code_hash = $2, verify_code_expires_at = $3, verify_code_tries = 0, updated_at = now() WHERE id = $1',
      [userId, codeHash(userId, code), fromNow(SIGNUP_CODE_TTL_MS)]
    );
    return code;
  }

  async function renewSignupCode(email) {
    try {
      await ensureReady();
      const r = await pool.query('SELECT id, username, email, email_verified FROM users WHERE LOWER(email) = LOWER($1)', [String(email || '').trim()]);
      const u = r.rows[0];
      if (!u || u.email_verified) return null;
      const id = Number(u.id);
      const verifyToken = randomToken();
      await pool.query('UPDATE users SET verify_token = $2, verify_expires_at = $3, updated_at = now() WHERE id = $1', [id, verifyToken, fromNow(VERIFY_TTL_MS)]);
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
        `UPDATE users SET verify_code_tries = verify_code_tries + 1, updated_at = now()
          WHERE LOWER(email) = LOWER($1) AND email_verified = FALSE AND verify_code_hash IS NOT NULL
            AND verify_code_tries < $2 AND verify_code_expires_at >= $3
          RETURNING id, username, verify_code_hash`,
        [String(email || '').trim(), SIGNUP_CODE_TRIES, new Date()]
      );
      const u = r.rows[0];
      if (!u) {
        const q = await pool.query(
          'SELECT verify_code_hash FROM users WHERE LOWER(email) = LOWER($1) AND email_verified = FALSE', [String(email || '').trim()]
        );
        return q.rows[0] && q.rows[0].verify_code_hash ? { error: 'Der Code ist abgelaufen - bitte einen neuen anfordern.' } : bad;
      }
      const id = Number(u.id);
      if (!codeMatches(id, code, u.verify_code_hash)) return bad;
      await withTransaction((c) => confirmAccount(c, id, u.username));
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
      const u = await pool.query('SELECT id, username, email, password_salt, webauthn_user_id, review_mail FROM users WHERE LOWER(username) = LOWER($1)', [s.username]);
      const row = u.rows[0];
      if (!row) return null;
      const c = await pool.query('SELECT * FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at', [row.id]);
      return { id: Number(row.id), username: row.username, email: row.email, hasPassword: !!row.password_salt, webauthnUserId: row.webauthn_user_id || null, credentials: c.rows.map(credRow), reviewMail: !!row.review_mail };
    } catch (e) {
      console.error('Postgres accountForSession failed:', e.message);
      return null;
    }
  }

  // --- Year-review mail (opt-in, see game/YearReviewMail.js) ---------------
  /** `consent`: version of the consent text shown (kept on opt-out: what was agreed to last). */
  async function setReviewMail(userId, enabled, lang, consent = null) {
    const on = !!enabled;
    try {
      await ensureReady();
      await pool.query(
        `UPDATE users SET review_mail = $2, review_mail_changed_at = $3, review_mail_lang = $4,
         review_mail_consent = CASE WHEN $2 THEN $5 ELSE review_mail_consent END, updated_at = $3 WHERE id = $1`,
        [userId, on, new Date(), lang === 'en' ? 'en' : 'de', consent]
      );
      return { ok: true, enabled: on };
    } catch (e) {
      console.error('Postgres setReviewMail failed:', e.message);
      return DB_DOWN;
    }
  }

  /** Verified, opted-in accounts without this year's mail. */
  async function reviewMailRecipients(year) {
    try {
      await ensureReady();
      const r = await pool.query(
        `SELECT id, username, email, review_mail_lang FROM users
         WHERE email_verified AND review_mail AND (review_mail_year IS NULL OR review_mail_year <> $1) ORDER BY id`,
        [String(year)]
      );
      return r.rows.map((row) => ({ id: Number(row.id), username: row.username, email: row.email, lang: row.review_mail_lang === 'en' ? 'en' : 'de' }));
    } catch (e) {
      console.error('Postgres reviewMailRecipients failed:', e.message);
      return [];
    }
  }

  // Both writes throw on failure: the sender must not mail a dead link or
  // believe a year is done when the database never heard of it.
  async function setReviewUnsubHash(userId, hash) {
    await ensureReady();
    await pool.query('UPDATE users SET review_unsub_hash = $2, updated_at = now() WHERE id = $1', [userId, hash]);
  }

  async function markReviewMailSent(userId, year) {
    await ensureReady();
    await pool.query('UPDATE users SET review_mail_year = $2, updated_at = now() WHERE id = $1', [userId, String(year)]);
  }

  /** The link in the mail: idempotent, the token keeps answering after the opt-out. */
  /** Read only: whose link it is (the page asks before anything changes). */
  async function reviewUnsubInfo(token) {
    const t = String(token || '');
    if (!/^[a-f0-9]{64}$/.test(t)) return { error: 'invalid' };
    try {
      await ensureReady();
      const hash = crypto.createHash('sha256').update(t).digest('hex');
      const r = await pool.query('SELECT username, review_mail, review_mail_lang FROM users WHERE review_unsub_hash = $1', [hash]);
      const row = r.rows[0];
      if (!row) return { error: 'invalid' };
      return { ok: true, username: row.username, lang: row.review_mail_lang === 'en' ? 'en' : 'de', active: !!row.review_mail };
    } catch (e) {
      console.error('Postgres reviewUnsubInfo failed:', e.message);
      return { error: 'unavailable' };
    }
  }

  async function unsubscribeReviewMail(token) {
    const t = String(token || '');
    if (!/^[a-f0-9]{64}$/.test(t)) return { error: 'invalid' };
    try {
      await ensureReady();
      const hash = crypto.createHash('sha256').update(t).digest('hex');
      const r = await pool.query(
        'UPDATE users SET review_mail = FALSE, review_mail_changed_at = $2, updated_at = $2 WHERE review_unsub_hash = $1 RETURNING username, review_mail_lang',
        [hash, new Date()]
      );
      const row = r.rows[0];
      if (!row) return { error: 'invalid' };
      return { ok: true, username: row.username, lang: row.review_mail_lang === 'en' ? 'en' : 'de' };
    } catch (e) {
      console.error('Postgres unsubscribeReviewMail failed:', e.message);
      return { error: 'unavailable' };
    }
  }

  async function setWebauthnUserId(userId, handle) {
    await pool.query('UPDATE users SET webauthn_user_id = $2, updated_at = now() WHERE id = $1 AND webauthn_user_id IS NULL', [userId, handle]);
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
        `SELECT c.*, u.id AS uid, u.username, u.email, u.email_verified, u.webauthn_user_id
           FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE c.credential_id = $1`,
        [String(credId || '')]
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        credential: credRow(row),
        user: { id: Number(row.uid), username: row.username, email: row.email, verified: !!row.email_verified, webauthnUserId: row.webauthn_user_id || null },
      };
    } catch (e) {
      console.error('Postgres credentialById failed:', e.message);
      return null;
    }
  }

  async function touchCredential(credId, counter) {
    await pool.query('UPDATE webauthn_credentials SET sign_count = $2, last_used_at = $3, updated_at = $3 WHERE credential_id = $1', [String(credId), counter || 0, new Date()])
      .catch((e) => console.error('Postgres touchCredential failed:', e.message));
  }

  async function deleteCredential(userId, credId) {
    try {
      const u = await pool.query('SELECT password_salt FROM users WHERE id = $1', [userId]);
      const n = await pool.query('SELECT COUNT(*)::int AS n FROM webauthn_credentials WHERE user_id = $1', [userId]);
      if (!u.rows[0]) return { error: 'Benutzer nicht gefunden.' };
      if (!u.rows[0].password_salt && n.rows[0].n <= 1) return { error: 'Das ist dein letzter Anmeldeweg - lege zuerst ein Passwort oder einen weiteren Passkey an.' };
      const r = await pool.query('DELETE FROM webauthn_credentials WHERE credential_id = $1 AND user_id = $2', [String(credId), userId]);
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
      await pool.query('UPDATE users SET password_hash = $2, password_salt = $3, updated_at = now() WHERE id = $1', [userId, hashPassword(password, salt), salt]);
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
      await pool.query("UPDATE users SET password_hash = $2, password_salt = '', updated_at = now() WHERE id = $1", [userId, Buffer.alloc(0)]);
      return { ok: true };
    } catch (e) {
      console.error('Postgres removePassword failed:', e.message);
      return DB_DOWN;
    }
  }

  async function sessionForUser(userId) {
    try {
      await ensureReady();
      const r = await pool.query('SELECT id, username, email_verified FROM users WHERE id = $1', [userId]);
      const u = r.rows[0];
      if (!u) return { error: 'Benutzer nicht gefunden.' };
      if (!u.email_verified) return { error: 'Bitte zuerst die E-Mail-Adresse bestätigen (Link in der Mail).' };
      const token = randomToken();
      await pool.query('DELETE FROM login_sessions WHERE created_at < $1', [fromNow(-SESSION_TTL_MS)]).catch(() => {});
      await pool.query('INSERT INTO login_sessions (session_token, user_id, created_at) VALUES ($1, $2, $3)', [token, u.id, new Date()]);
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
        'SELECT id, username, email, email_verified FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)', [key]
      );
      const u = r.rows[0];
      if (!u || !u.email_verified) return null;
      const token = randomToken();
      await pool.query('UPDATE users SET login_token_hash = $2, login_expires_at = $3, updated_at = now() WHERE id = $1', [u.id, sha256hex(token), fromNow(ttlMs)]);
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
        `WITH hit AS (SELECT id, login_expires_at FROM users WHERE login_token_hash = $1 FOR UPDATE)
         UPDATE users u SET login_token_hash = NULL, login_expires_at = NULL, updated_at = now()
           FROM hit WHERE u.id = hit.id
         RETURNING u.id, hit.login_expires_at AS exp`,
        [sha256hex(token || '')]
      );
      const u = r.rows[0];
      if (!u) return { error: 'Dieser Anmelde-Link ist ungültig oder wurde schon benutzt.' };
      if (u.exp == null || Date.now() > u.exp.getTime()) return { error: 'Dieser Anmelde-Link ist abgelaufen - bitte einen neuen anfordern.' };
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
        'SELECT username, xp, games_played, games_won, season, season_xp FROM users WHERE LOWER(username) = LOWER($1)',
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
        games: row.games_played || 0,
        wins: row.games_won || 0,
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
        `SELECT username, season_xp, xp, games_played, games_won FROM users
          WHERE season = $1 AND email_verified = TRUE
          ORDER BY season_xp DESC, xp DESC LIMIT $2`,
        [String(season || ''), Math.max(1, Math.min(100, limit))]
      );
      return r.rows.map((row) => ({
        username: row.username,
        seasonXp: Number(row.season_xp) || 0,
        xp: Number(row.xp) || 0,
        games: row.games_played || 0,
        wins: row.games_won || 0,
      }));
    } catch (e) {
      console.error('Postgres ladder failed:', e.message);
      return [];
    }
  }

  /** Final standings of every ended season, once: places, awards; one
   *  finalizer at a time (advisory lock), the finals row is the idempotence
   *  key. `from` overrides the first season (tests). Fails soft:
   *  null = not done (the server asks again). */
  async function finalizeSeasons(currentSeason, { from = null } = {}) {
    const cur = String(currentSeason || '');
    if (!SEASON_ID_RE.test(cur)) return [];
    try {
      await ensureReady();
      return await withTransaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(7311001)');
        // Rollovers are archived since the season this code first ran in; older ones are never finalized.
        let since = from;
        if (!since) {
          await c.query(
            "INSERT INTO season_meta (meta_key, meta_value) VALUES ('archive_from', $1) ON CONFLICT (meta_key) DO NOTHING",
            [cur]
          );
          since = (await c.query("SELECT meta_value FROM season_meta WHERE meta_key = 'archive_from'")).rows[0].meta_value;
        }
        const pending = await c.query(
          `SELECT season FROM (
             SELECT season FROM users WHERE season IS NOT NULL
             UNION SELECT season FROM season_archive
           ) s WHERE season < $1 AND season >= $2 AND season NOT IN (SELECT season FROM season_finals)
           ORDER BY season`,
          [cur, since]
        );
        const done = [];
        for (const { season } of pending.rows) {
          // ONE statement: a rollover committing meanwhile shows the account
          // either in users or in the archive, never in both or neither.
          const e = await c.query(
            `SELECT id AS user_id, season_xp, season_games FROM users WHERE season = $1 AND email_verified = TRUE
             UNION ALL
             SELECT a.user_id, a.season_xp, a.season_games
               FROM season_archive a JOIN users u ON u.id = a.user_id
              WHERE a.season = $1 AND u.email_verified = TRUE`,
            [season]
          );
          const standings = seasonStandings(e.rows.map((r) => ({
            userId: Number(r.user_id), seasonXp: Number(r.season_xp) || 0, seasonGames: Number(r.season_games) || 0,
          })), { gamesCounted: season !== since });
          for (const s of standings) {
            await c.query(
              `INSERT INTO season_results (user_id, season, place, season_xp, season_games, award, seen)
               VALUES ($1, $2, $3, $4, $5, $6, FALSE) ON CONFLICT (user_id, season) DO NOTHING`,
              [s.userId, season, s.place, s.seasonXp, s.seasonGames, s.award]
            );
          }
          await c.query(
            'INSERT INTO season_finals (season, finalized_at, ranked) VALUES ($1, $2, $3) ON CONFLICT (season) DO NOTHING',
            [season, new Date(), standings.length]
          );
          done.push({ season, ranked: standings.length, awards: standings.filter((s) => s.award).length });
        }
        return done;
      });
    } catch (e) {
      console.error('Postgres finalizeSeasons failed:', e.message);
      return null;
    }
  }

  async function seasonResultsFor(username, limit = 24) {
    try {
      await ensureReady();
      const r = await pool.query(
        `SELECT r.season, r.place, r.award, r.season_xp, r.season_games, r.seen, f.ranked
           FROM season_results r
           JOIN users u ON u.id = r.user_id
           JOIN season_finals f ON f.season = r.season
          WHERE LOWER(u.username) = LOWER($1)
          ORDER BY r.season DESC LIMIT $2`,
        [String(username || '').trim(), Math.max(1, Math.min(120, Number(limit) || 24))]
      );
      return r.rows.map((row) => ({
        season: row.season,
        place: row.place,
        award: row.award || null,
        seasonXp: Number(row.season_xp) || 0,
        seasonGames: row.season_games || 0,
        ranked: row.ranked || 0,
        seen: !!row.seen,
      }));
    } catch (e) {
      console.error('Postgres seasonResultsFor failed:', e.message);
      return [];
    }
  }

  async function markSeasonResultSeen(username, season) {
    try {
      await ensureReady();
      const r = await pool.query(
        `UPDATE season_results SET seen = TRUE, updated_at = CASE WHEN seen THEN updated_at ELSE now() END
          WHERE season <= $2 AND user_id = (SELECT id FROM users WHERE LOWER(username) = LOWER($1))`,
        [String(username || '').trim(), String(season || '')]
      );
      return { ok: r.rowCount > 0 };
    } catch (e) {
      console.error('Postgres markSeasonResultSeen failed:', e.message);
      return { ok: false };
    }
  }

  async function close() {
    if (ownsPool) await pool.end().catch(() => {});
  }

  return {
    backend: 'postgres',
    register, verifyEmail, login, sessionUser, logout, isRegisteredName,
    addGameResult, addXp, progressFor, ladder, importProfile, listUsers, deleteUser, renewVerification,
    finalizeSeasons, seasonResultsFor, markSeasonResultSeen,
    validateNewAccount, registerWithoutPassword, verifyAndSignIn, renewSignupCode, verifyCodeAndSignIn, accountForSession, setWebauthnUserId, addCredential,
    credentialById, touchCredential, deleteCredential, setPassword, removePassword, sessionForUser,
    createLoginLink, consumeLoginLink,
    setReviewMail, reviewMailRecipients, setReviewUnsubHash, markReviewMailSent, reviewUnsubInfo, unsubscribeReviewMail,
    close,
  };
}

module.exports = { createPgAccountStore };
