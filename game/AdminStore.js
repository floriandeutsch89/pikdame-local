// game/AdminStore.js
// The admin role, admin sessions and the audit log in PostgreSQL (migrations/009).
// Like PgAccountStore, the app clock decides expiry and the API speaks milliseconds.
// Checks that guard access fail closed (null/false); the audit never blocks an action.
const { ensureMigrated } = require('./Migrations');
const { inTransaction } = require('./Database');
const A = require('./AdminAccess');

const SYNC_LOCK = 726819;
const AUDIT_PAGE = 50;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
// Touching last_seen_at on every request would write per page load; a few seconds do not matter.
const TOUCH_AFTER_MS = 15 * 1000;

// The cut-down client network, computed by PostgreSQL from a validated address.
const NETWORK_SQL = (p) => `CASE WHEN ${p}::inet IS NULL THEN NULL
  ELSE network(set_masklen(${p}::inet, CASE WHEN family(${p}::inet) = 4 THEN 24 ELSE 48 END)) END`;

/**
 * @param {import('pg').Pool} pool  the server's shared pool
 * @param {{ now?: () => number }} [opts]  clock (tests)
 */
function createAdminStore(pool, { now = Date.now } = {}) {
  let prunedAt = 0;

  async function insertAudit(q, { userId = null, userName = null, action, target = null, details = {}, ip = null }) {
    await q.query(
      `INSERT INTO admin_audit_events (occurred_at, user_id, user_name, action, action_target, details, client_network)
       VALUES ($1, $2, $3, $4, $5, $6, ${NETWORK_SQL('$7')})`,
      [new Date(now()), userId, userName, String(action), target == null ? null : String(target).slice(0, 200),
        JSON.stringify(details || {}), A.auditableIp(ip)]
    );
  }

  /** One audit row. Never throws: a failing log must not undo or block the action. */
  async function audit(event) {
    try {
      await ensureMigrated(pool);
      await insertAudit(pool, event);
      if (now() - prunedAt > PRUNE_EVERY_MS) await pruneAudit();
      return true;
    } catch (e) {
      console.error(`[admin] audit not stored (${event && event.action}): ${e.message}`);
      return false;
    }
  }

  /** Deletes audit rows older than the retention (365 days); returns how many. */
  async function pruneAudit() {
    prunedAt = now();
    await ensureMigrated(pool);
    const cutoff = new Date(now() - A.AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    return (await pool.query('DELETE FROM admin_audit_events WHERE occurred_at < $1', [cutoff])).rowCount;
  }

  /** Newest first, `perPage` rows of page `page` (1-based) and whether older ones exist. */
  async function auditPage({ page = 1, perPage = AUDIT_PAGE } = {}) {
    await ensureMigrated(pool);
    const p = Math.max(1, Math.floor(Number(page)) || 1);
    const r = await pool.query(
      `SELECT id, occurred_at, user_name, action, action_target, details, client_network::text AS client_network
         FROM admin_audit_events ORDER BY occurred_at DESC, id DESC LIMIT $1 OFFSET $2`,
      [perPage + 1, (p - 1) * perPage]
    );
    return {
      page: p,
      hasMore: r.rows.length > perPage,
      events: r.rows.slice(0, perPage).map((row) => ({
        id: Number(row.id), at: row.occurred_at.getTime(), userName: row.user_name, action: row.action,
        target: row.action_target, details: row.details || {}, network: row.client_network,
      })),
    };
  }

  /** Applies PIKDAME_ADMINS: grants the listed confirmed accounts, revokes env grants of
   *  everyone else and ends the sessions of accounts left without the role. */
  async function syncEnvAdmins(emails) {
    await ensureMigrated(pool);
    const list = [...emails].map(A.normEmail);
    return inTransaction(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK]);
      const at = new Date(now());
      const listed = 'u.email_verified AND LOWER(u.email) IN (SELECT LOWER(x) FROM unnest($1::text[]) AS x)';
      const granted = (await c.query(
        `INSERT INTO user_roles (user_id, role_name, grant_source, granted_at)
         SELECT u.id, 'admin', 'env', $2 FROM users u WHERE ${listed}
         ON CONFLICT DO NOTHING RETURNING user_id`, [list, at]
      )).rows.map((r) => Number(r.user_id));
      const revoked = (await c.query(
        `DELETE FROM user_roles r USING users u
          WHERE r.user_id = u.id AND r.grant_source = 'env' AND NOT (${listed})
         RETURNING r.user_id`, [list]
      )).rows.map((r) => Number(r.user_id));
      const ended = (await c.query(
        `DELETE FROM admin_sessions s WHERE s.user_id = ANY($1::bigint[])
            AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = s.user_id AND r.role_name = 'admin')
         RETURNING s.user_id`, [revoked]
      )).rows.map((r) => Number(r.user_id));
      const names = new Map((await c.query('SELECT id, username FROM users WHERE id = ANY($1::bigint[])', [[...granted, ...revoked]]))
        .rows.map((r) => [Number(r.id), r.username]));
      for (const id of granted) await insertAudit(c, { action: 'role.grant', target: names.get(id), details: { source: 'env' } });
      for (const id of revoked) {
        await insertAudit(c, { action: 'role.revoke', target: names.get(id), details: { source: 'env', sessions: ended.filter((x) => x === id).length } });
      }
      const waiting = Number((await c.query(
        `SELECT count(*)::int AS n FROM unnest($1::text[]) AS x
          WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.email_verified AND LOWER(u.email) = LOWER(x))`, [list]
      )).rows[0].n);
      const admins = Number((await c.query("SELECT count(DISTINCT user_id)::int AS n FROM user_roles WHERE role_name = 'admin'")).rows[0].n);
      return { granted: granted.map((id) => names.get(id)), revoked: revoked.map((id) => names.get(id)), waiting, admins };
    });
  }

  /** An env-listed account confirmed after the last start: its grant now (the caller checked
   *  the list). Returns the account name when the grant is new, else null. */
  async function ensureEnvGrant(userId) {
    await ensureMigrated(pool);
    const r = await pool.query(
      `INSERT INTO user_roles (user_id, role_name, grant_source, granted_at)
       SELECT id, 'admin', 'env', $2 FROM users WHERE id = $1 AND email_verified
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [userId, new Date(now())]
    );
    if (!r.rows.length) return null;
    const name = (await pool.query('SELECT username FROM users WHERE id = $1', [userId])).rows[0].username;
    await audit({ action: 'role.grant', target: name, details: { source: 'env' } });
    return name;
  }

  async function isAdmin(userId) {
    try {
      await ensureMigrated(pool);
      const r = await pool.query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role_name = 'admin' LIMIT 1", [userId]);
      return r.rows.length > 0;
    } catch (e) {
      console.error('[admin] role check failed:', e.message);
      return false;
    }
  }

  async function adminCount() {
    await ensureMigrated(pool);
    return Number((await pool.query("SELECT count(DISTINCT user_id)::int AS n FROM user_roles WHERE role_name = 'admin'")).rows[0].n);
  }

  /** Every admin account with its grant sources, for the CLI and the Benutzer tab. */
  async function listAdmins() {
    await ensureMigrated(pool);
    const r = await pool.query(
      `SELECT u.id, u.username, u.email, array_agg(r.grant_source ORDER BY r.grant_source) AS sources, min(r.granted_at) AS granted_at,
              (SELECT count(*)::int FROM webauthn_credentials c WHERE c.user_id = u.id) AS passkeys,
              u.password_salt <> '' AS has_password
         FROM user_roles r JOIN users u ON u.id = r.user_id
        WHERE r.role_name = 'admin'
        GROUP BY u.id ORDER BY LOWER(u.username)`
    );
    return r.rows.map((row) => ({
      userId: Number(row.id), username: row.username, email: row.email, sources: row.sources,
      grantedAt: row.granted_at.getTime(), passkeys: row.passkeys, hasPassword: !!row.has_password,
    }));
  }

  async function accountByEmail(q, email) {
    const r = await q.query('SELECT id, username, email, email_verified FROM users WHERE LOWER(email) = LOWER($1)', [String(email || '').trim()]);
    return r.rows[0] ? { id: Number(r.rows[0].id), username: r.rows[0].username, email: r.rows[0].email, verified: !!r.rows[0].email_verified } : null;
  }

  /** CLI grant: persists until the CLI revokes it. { ok, added, username, sources } | { error } */
  async function grantCli(email) {
    await ensureMigrated(pool);
    return inTransaction(pool, async (c) => {
      const u = await accountByEmail(c, email);
      if (!u) return { error: 'unknown' };
      if (!u.verified) return { error: 'unconfirmed', username: u.username };
      const added = (await c.query(
        `INSERT INTO user_roles (user_id, role_name, grant_source, granted_at) VALUES ($1, 'admin', 'cli', $2)
         ON CONFLICT DO NOTHING RETURNING user_id`, [u.id, new Date(now())]
      )).rows.length > 0;
      if (added) await insertAudit(c, { action: 'role.grant', target: u.username, details: { source: 'cli' } });
      const sources = (await c.query('SELECT grant_source FROM user_roles WHERE user_id = $1 ORDER BY 1', [u.id])).rows.map((r) => r.grant_source);
      return { ok: true, added, username: u.username, sources };
    });
  }

  /** CLI revoke. An env grant (or an address in `envEmails`) is refused: PIKDAME_ADMINS wins.
   *  { ok, removed, username, sessions } | { error: 'unknown'|'env' } */
  async function revokeCli(email, { envEmails = new Set() } = {}) {
    await ensureMigrated(pool);
    return inTransaction(pool, async (c) => {
      const u = await accountByEmail(c, email);
      if (!u) return { error: 'unknown' };
      const sources = (await c.query('SELECT grant_source FROM user_roles WHERE user_id = $1', [u.id])).rows.map((r) => r.grant_source);
      if (sources.includes('env') || envEmails.has(A.normEmail(u.email))) return { error: 'env', username: u.username };
      const removed = (await c.query("DELETE FROM user_roles WHERE user_id = $1 AND grant_source = 'cli' RETURNING user_id", [u.id])).rows.length > 0;
      let sessions = 0;
      if (removed) {
        sessions = (await c.query('DELETE FROM admin_sessions WHERE user_id = $1', [u.id])).rowCount;
        await insertAudit(c, { action: 'role.revoke', target: u.username, details: { source: 'cli', sessions } });
      }
      return { ok: true, removed, username: u.username, sessions };
    });
  }

  /** A new admin session after a passed step-up; returns the raw token (the cookie value). */
  async function createSession({ userId, loginToken, method }) {
    await ensureMigrated(pool);
    const t = now();
    // Housekeeping: expired sessions of anyone.
    await pool.query('DELETE FROM admin_sessions WHERE last_seen_at < $1 OR created_at < $2',
      [new Date(t - A.IDLE_MS), new Date(t - A.MAX_AGE_MS)]);
    const token = A.newToken();
    await pool.query(
      `INSERT INTO admin_sessions (session_token_hash, user_id, login_session_hash, step_up_method, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [A.tokenHash(token), userId, A.tokenHash(loginToken), method, new Date(t)]
    );
    return token;
  }

  /** The live session behind a cookie value, or null: unknown, idle past 15 minutes, older
   *  than 8 hours or its account no longer admin (then the row goes). `touch` = a person acted. */
  async function sessionFor(token, { touch = true } = {}) {
    if (!A.validToken(token)) return null;
    const hash = A.tokenHash(token);
    try {
      await ensureMigrated(pool);
      const r = await pool.query(
        `SELECT s.user_id, s.step_up_method, s.created_at, s.last_seen_at, u.username, u.email,
                EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = s.user_id AND r.role_name = 'admin') AS is_admin
           FROM admin_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.session_token_hash = $1`, [hash]
      );
      const row = r.rows[0];
      if (!row) return null;
      const t = now();
      const created = row.created_at.getTime();
      let seen = row.last_seen_at.getTime();
      if (t - seen > A.IDLE_MS || t - created > A.MAX_AGE_MS || !row.is_admin) {
        await pool.query('DELETE FROM admin_sessions WHERE session_token_hash = $1', [hash]);
        return null;
      }
      if (touch && t - seen > TOUCH_AFTER_MS) {
        await pool.query('UPDATE admin_sessions SET last_seen_at = $2 WHERE session_token_hash = $1', [hash, new Date(t)]);
        seen = t;
      }
      return {
        userId: Number(row.user_id), username: row.username, email: row.email, method: row.step_up_method,
        createdAt: created, lastSeenAt: seen, expiresAt: Math.min(created + A.MAX_AGE_MS, seen + A.IDLE_MS), tokenHash: hash,
      };
    } catch (e) {
      console.error('[admin] session lookup failed:', e.message);
      return null;
    }
  }

  async function endSession(token) {
    if (!A.validToken(token)) return false;
    await ensureMigrated(pool);
    return (await pool.query('DELETE FROM admin_sessions WHERE session_token_hash = $1', [A.tokenHash(token)])).rowCount > 0;
  }

  /** Signing out of the game ends the admin sessions stepped up from that sign-in. */
  async function endSessionsForLogin(loginToken) {
    if (!loginToken) return 0;
    await ensureMigrated(pool);
    return (await pool.query('DELETE FROM admin_sessions WHERE login_session_hash = $1', [A.tokenHash(loginToken)])).rowCount;
  }

  return {
    audit, auditPage, pruneAudit, syncEnvAdmins, ensureEnvGrant, isAdmin, adminCount, listAdmins,
    grantCli, revokeCli, createSession, sessionFor, endSession, endSessionsForLogin,
  };
}

module.exports = { createAdminStore, AUDIT_PAGE };
