// game/AdminAccess.js
// Admin access without I/O: who may hold the role (PIKDAME_ADMINS), how the step-up
// re-authenticates, the admin session cookie and its CSRF token. AdminStore.js keeps
// roles, sessions and the audit log; server.js wires both to /admin.
const crypto = require('crypto');
const net = require('net');

const IDLE_MS = 15 * 60 * 1000;
const MAX_AGE_MS = 8 * 60 * 60 * 1000;
const AUDIT_RETENTION_DAYS = 365;
const COOKIE = 'pikdame_admin';
// The token is 32 random bytes as base64url; anything else is never looked up.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
// The Argon2 admin token of older versions; still set means the operator has not migrated.
const LEGACY_VARS = ['PIKDAME_ADMIN_TOKEN', 'PIKDAME_ADMIN_TOKEN_FILE'];

/** The form addresses are compared in. */
const normEmail = (email) => String(email || '').trim().toLowerCase();

/** PIKDAME_ADMINS ("a@x.de, b@y.de") -> lower-cased addresses and the 1-based
 *  positions of entries that are no address (logged by position: they are personal). */
function parseAdminEmails(value) {
  const emails = new Set();
  const invalid = [];
  String(value || '').split(/[,;\s]+/).filter(Boolean).forEach((entry, i) => {
    if (EMAIL_RE.test(entry) && entry.length <= 254) emails.add(normEmail(entry));
    else invalid.push(i + 1);
  });
  return { emails, invalid };
}

/** Passkey when the account has one and passkeys work here, else its password -
 *  unless passkeyOnly. Returns { method } or { refused: 'passkey-required'|'no-method' }. */
function stepUpMethod({ passkeys = 0, hasPassword = false, passkeysEnabled = false, passkeyOnly = false } = {}) {
  if (passkeysEnabled && passkeys > 0) return { method: 'passkey' };
  if (passkeyOnly) return { refused: 'passkey-required' };
  if (hasPassword) return { method: 'password' };
  return { refused: 'no-method' };
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const validToken = (token) => typeof token === 'string' && TOKEN_RE.test(token);

// __Secure- makes the browser refuse the cookie from plain http (a forged or injected one).
const cookieName = (secure) => (secure ? `__Secure-${COOKIE}` : COOKIE);

function sessionCookie(token, { secure = false } = {}) {
  return `${cookieName(secure)}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_MS / 1000}${secure ? '; Secure' : ''}`;
}

function clearedCookie({ secure = false } = {}) {
  return `${cookieName(secure)}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** One cookie's value from a Cookie header, or null. */
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Per-session CSRF token: an HMAC keyed by the session token, unknown without the cookie. */
function csrfToken(sessionToken) {
  return crypto.createHmac('sha256', String(sessionToken)).update('pikdame-admin-csrf').digest('hex');
}

function csrfValid(given, sessionToken) {
  if (typeof given !== 'string' || !sessionToken) return false;
  // Byte lengths: 64 umlauts are 64 characters but 128 bytes, and timingSafeEqual would throw.
  const a = Buffer.from(given);
  const b = Buffer.from(csrfToken(sessionToken));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A client address PostgreSQL may cast to inet (it is cut to /24 or /48 there), or null. */
function auditableIp(ip) {
  let s = String(ip || '').trim().split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  return net.isIP(s) ? s : null;
}

/** Is the public base URL https? Then the cookie is Secure (behind the proxy the app sees http). */
function httpsBase(baseUrl) {
  try { return new URL(String(baseUrl)).protocol === 'https:'; } catch (e) { return false; }
}

/** Old admin-token variables that are still set (they are ignored now). */
const legacyAdminVars = (env) => LEGACY_VARS.filter((name) => env[name]);

module.exports = {
  IDLE_MS, MAX_AGE_MS, AUDIT_RETENTION_DAYS, LEGACY_VARS,
  normEmail, parseAdminEmails, stepUpMethod, newToken, tokenHash, validToken,
  cookieName, sessionCookie, clearedCookie, readCookie, csrfToken, csrfValid, auditableIp, legacyAdminVars, httpsBase,
};
