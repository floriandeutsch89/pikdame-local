// The admin role (PIKDAME_ADMINS + CLI), admin sessions and the audit log: the
// pure helpers, the store against PostgreSQL, the CLI and migration 009.
// The HTTP side (step-up, cookie, CSRF, limits) is test/admin-access.test.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Pool } = require('pg');
const A = require('../game/AdminAccess');
const { createAdminStore } = require('../game/AdminStore');
const { createPgAccountStore } = require('../game/PgAccountStore');
const { migrate, loadMigrations } = require('../game/Migrations');
const { testDatabaseUrl } = require('./helpers/test-db');
const { run: cli } = require('../scripts/admin-role');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test('PIKDAME_ADMINS: lower-cased addresses, any separator, bad entries by position', () => {
  const r = A.parseAdminEmails(' Chefin@Example.org, bob@example.org;nope  carl@example.org,,');
  assert.deepStrictEqual([...r.emails], ['chefin@example.org', 'bob@example.org', 'carl@example.org']);
  assert.deepStrictEqual(r.invalid, [3]);
  assert.deepStrictEqual([...A.parseAdminEmails(undefined).emails], []);
  assert.deepStrictEqual(A.parseAdminEmails('a@b.de, <x@y.de>').invalid, [2]);
});

test('step-up method: the passkey when there is one, else the password; passkey-only is one switch', () => {
  const m = (o) => A.stepUpMethod({ passkeysEnabled: true, ...o });
  assert.deepStrictEqual(m({ passkeys: 1, hasPassword: true }), { method: 'passkey' }, 'a passkey beats the password');
  assert.deepStrictEqual(m({ passkeys: 0, hasPassword: true }), { method: 'password' });
  assert.deepStrictEqual(m({ passkeys: 0, hasPassword: false }), { refused: 'no-method' }, 'password-less without passkey cannot enter');
  assert.deepStrictEqual(m({ passkeys: 0, hasPassword: true, passkeyOnly: true }), { refused: 'passkey-required' });
  assert.deepStrictEqual(m({ passkeys: 2, hasPassword: false, passkeyOnly: true }), { method: 'passkey' });
  assert.deepStrictEqual(A.stepUpMethod({ passkeys: 1, hasPassword: true, passkeysEnabled: false }), { method: 'password' },
    'without passkeys on this server the password is the way');
});

test('admin cookie: HttpOnly, SameSite=Strict, Path=/admin, 8 h; Secure and __Secure- only over https', () => {
  assert.strictEqual(A.sessionCookie('tok'), 'pikdame_admin=tok; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800');
  assert.strictEqual(A.sessionCookie('tok', { secure: true }), '__Secure-pikdame_admin=tok; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800; Secure');
  assert.strictEqual(A.clearedCookie({ secure: true }), '__Secure-pikdame_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
  assert.strictEqual(A.readCookie('a=1; pikdame_admin=xyz; b=2', 'pikdame_admin'), 'xyz');
  assert.strictEqual(A.readCookie('pikdame_admin_x=1', 'pikdame_admin'), null);
  assert.strictEqual(A.readCookie(undefined, 'pikdame_admin'), null);
  assert.strictEqual(A.httpsBase('https://play.pikdame.online'), true);
  assert.strictEqual(A.httpsBase('http://localhost:8080'), false);
  assert.strictEqual(A.httpsBase(undefined), false);
  const token = A.newToken();
  assert.ok(A.validToken(token) && token.length === 43);
  assert.ok(!A.validToken('x'.repeat(42)) && !A.validToken(`${token.slice(1)}=`) && !A.validToken(null));
  assert.strictEqual(A.tokenHash(token), crypto.createHash('sha256').update(token).digest('hex'));
});

test('CSRF token: one per session, unknown without the cookie', () => {
  const [a, b] = [A.newToken(), A.newToken()];
  assert.match(A.csrfToken(a), /^[a-f0-9]{64}$/);
  assert.notStrictEqual(A.csrfToken(a), A.csrfToken(b));
  assert.ok(A.csrfValid(A.csrfToken(a), a));
  assert.ok(!A.csrfValid(A.csrfToken(b), a), 'another session\'s token');
  assert.ok(!A.csrfValid(undefined, a) && !A.csrfValid('', a) && !A.csrfValid(A.csrfToken(a), ''));
  assert.strictEqual(A.csrfValid('ä'.repeat(64), a), false, 'same length in characters, not in bytes: refused, no throw');
});

test('audit addresses: only real IPs reach the database; mapped IPv4 is IPv4', () => {
  assert.strictEqual(A.auditableIp('203.0.113.45'), '203.0.113.45');
  assert.strictEqual(A.auditableIp('::ffff:198.51.100.7'), '198.51.100.7');
  assert.strictEqual(A.auditableIp('fe80::1%eth0'), 'fe80::1');
  assert.strictEqual(A.auditableIp('unknown'), null);
  assert.strictEqual(A.auditableIp("1.2.3.4'; DROP TABLE x"), null);
  assert.deepStrictEqual(A.legacyAdminVars({ PIKDAME_ADMIN_TOKEN: 'x', PIKDAME_ADMIN_TOKEN_FILE: '' }), ['PIKDAME_ADMIN_TOKEN']);
  assert.deepStrictEqual(A.legacyAdminVars({ PIKDAME_ADMINS: 'a@b.de', PIKDAME_ADMIN_PASSKEY_ONLY: '1' }), [], 'the new variables are no legacy');
});

// --- The store against PostgreSQL ---------------------------------------------
async function setup(t, tag) {
  const url = testDatabaseUrl(tag);
  const accounts = createPgAccountStore(url);
  const pool = new Pool({ connectionString: url, max: 3 });
  t.after(async () => { await accounts.close(); await pool.end(); });
  let clock = Date.now();
  const store = createAdminStore(pool, { now: () => clock });
  const rows = async (q, params) => (await pool.query(q, params)).rows;
  /** A confirmed (or not) account with a password; returns its id and a game sign-in token. */
  const account = async (name, email, { confirm = true } = {}) => {
    const r = await accounts.register(name, email, 'long-password-1');
    assert.ok(r.ok, r.error);
    if (confirm) await accounts.verifyEmail(r.verifyToken);
    const id = Number((await rows('SELECT id FROM users WHERE username = $1', [name]))[0].id);
    const login = confirm ? await accounts.login(email, 'long-password-1') : {};
    return { id, name, email, token: login.token };
  };
  return { url, pool, accounts, store, rows, account, tick: (ms) => { clock += ms; }, now: () => clock };
}

test('roles: PIKDAME_ADMINS grants confirmed accounts and revokes on removal; CLI grants persist', async (t) => {
  const { store, rows, account } = await setup(t, 'adm_roles');
  const ada = await account('Ada', 'Ada@Example.org');
  const ben = await account('Ben', 'ben@example.org');
  const cleo = await account('Cleo', 'cleo@example.org', { confirm: false });

  let r = await store.syncEnvAdmins(new Set(['ada@example.org', 'cleo@example.org', 'nobody@example.org']));
  assert.deepStrictEqual(r, { granted: ['Ada'], revoked: [], waiting: 2, admins: 1 }, 'case-insensitive; unconfirmed and unknown wait');
  assert.strictEqual(await store.isAdmin(ada.id), true);
  assert.strictEqual(await store.isAdmin(cleo.id), false, 'an unconfirmed address never holds the role');
  assert.deepStrictEqual(await store.syncEnvAdmins(new Set(['ada@example.org'])), { granted: [], revoked: [], waiting: 0, admins: 1 }, 'idempotent');

  assert.deepStrictEqual(await store.grantCli('BEN@example.org'), { ok: true, added: true, username: 'Ben', sources: ['cli'] });
  assert.strictEqual((await store.grantCli('ben@example.org')).added, false);
  assert.deepStrictEqual(await store.grantCli('cleo@example.org'), { error: 'unconfirmed', username: 'Cleo' });
  assert.deepStrictEqual(await store.grantCli('nobody@example.org'), { error: 'unknown' });

  // Env listed too: both sources; CLI revoke refused while the env lists it (in the DB or in the CLI's own env).
  r = await store.syncEnvAdmins(new Set(['ben@example.org']));
  assert.deepStrictEqual([r.granted, r.revoked], [['Ben'], ['Ada']], 'Ada left the list');
  assert.strictEqual(await store.isAdmin(ada.id), false);
  assert.deepStrictEqual((await store.listAdmins()).map((a) => [a.username, a.sources]), [['Ben', ['cli', 'env']]]);
  assert.deepStrictEqual(await store.revokeCli('ben@example.org'), { error: 'env', username: 'Ben' });
  r = await store.syncEnvAdmins(new Set());
  assert.deepStrictEqual(r.revoked, ['Ben']);
  assert.strictEqual(await store.isAdmin(ben.id), true, 'the CLI grant outlives the env list');
  assert.deepStrictEqual(await store.revokeCli('ben@example.org', { envEmails: new Set(['ben@example.org']) }), { error: 'env', username: 'Ben' },
    'an address in the CLI\'s PIKDAME_ADMINS is refused even before the next sync');
  assert.deepStrictEqual(await store.revokeCli('ben@example.org'), { ok: true, removed: true, username: 'Ben', sessions: 0 });
  assert.deepStrictEqual(await store.revokeCli('ben@example.org'), { ok: true, removed: false, username: 'Ben', sessions: 0 });
  assert.strictEqual(await store.adminCount(), 0);

  // A listed address confirmed after the start: its grant comes with the next check.
  await store.syncEnvAdmins(new Set(['cleo@example.org']));
  assert.strictEqual(await store.ensureEnvGrant(cleo.id), null, 'still unconfirmed');
  await rows('UPDATE users SET email_verified = TRUE WHERE id = $1', [cleo.id]);
  assert.strictEqual(await store.ensureEnvGrant(cleo.id), 'Cleo');
  assert.strictEqual(await store.ensureEnvGrant(cleo.id), null, 'once');

  const audit = await rows("SELECT action, action_target, details->>'source' AS source, user_id FROM admin_audit_events ORDER BY id");
  assert.deepStrictEqual(audit.map((e) => `${e.action} ${e.action_target} ${e.source}`), [
    'role.grant Ada env', 'role.grant Ben cli', 'role.grant Ben env', 'role.revoke Ada env', 'role.revoke Ben env',
    'role.revoke Ben cli', 'role.grant Cleo env',
  ]);
  assert.ok(audit.every((e) => e.user_id === null), 'role changes come from the operator, not an account');
});

test('sessions: idle 15 min, absolute 8 h, polls do not count, role re-checked on every lookup', async (t) => {
  const { store, rows, account, tick } = await setup(t, 'adm_sessions');
  const ada = await account('Ada', 'ada@example.org');
  await store.syncEnvAdmins(new Set(['ada@example.org']));
  const open = () => store.createSession({ userId: ada.id, loginToken: ada.token, method: 'passkey' });

  let token = await open();
  const stored = await rows('SELECT * FROM admin_sessions');
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].session_token_hash, A.tokenHash(token), 'only a SHA-256 is stored');
  assert.strictEqual(stored[0].login_session_hash, A.tokenHash(ada.token));
  assert.ok(!JSON.stringify(stored).includes(token) && !JSON.stringify(stored).includes(ada.token), 'no raw token in the table');
  const s = await store.sessionFor(token);
  assert.deepStrictEqual([s.userId, s.username, s.method], [ada.id, 'Ada', 'passkey']);
  assert.strictEqual(await store.sessionFor('not-a-token'), null);
  assert.strictEqual(await store.sessionFor(A.newToken()), null, 'unknown');

  // Sliding idle window: activity every 14 minutes keeps it; a poll does not.
  tick(14 * MIN);
  assert.ok(await store.sessionFor(token));
  tick(14 * MIN);
  assert.ok(await store.sessionFor(token, { touch: false }), 'a poll may read');
  tick(2 * MIN);
  assert.strictEqual(await store.sessionFor(token), null, 'the poll did not extend it: 16 minutes idle');
  assert.strictEqual((await rows('SELECT count(*)::int AS n FROM admin_sessions'))[0].n, 0, 'an expired session goes');

  // Absolute: active all the time, still over after 8 hours.
  token = await open();
  for (let i = 0; i < 47; i++) { tick(10 * MIN); assert.ok(await store.sessionFor(token), `minute ${(i + 1) * 10}`); }
  tick(10 * MIN + 1);
  assert.strictEqual(await store.sessionFor(token), null, 'past 8 hours');

  // The role is checked on every lookup, also when only the role row went.
  token = await open();
  await rows('DELETE FROM user_roles WHERE user_id = $1', [ada.id]);
  assert.strictEqual(await store.sessionFor(token), null);
  await store.syncEnvAdmins(new Set(['ada@example.org']));

  // Removing the role ends the sessions (env sync), and so does signing out of the game.
  token = await open();
  const r = await store.syncEnvAdmins(new Set());
  assert.deepStrictEqual(r.revoked, ['Ada']);
  assert.strictEqual(await store.sessionFor(token), null);
  assert.strictEqual((await rows("SELECT details->>'sessions' AS n FROM admin_audit_events WHERE action = 'role.revoke'"))[0].n, '1');
  await store.syncEnvAdmins(new Set(['ada@example.org']));
  token = await open();
  const other = await store.createSession({ userId: ada.id, loginToken: 'another-device-token', method: 'password' });
  assert.strictEqual(await store.endSessionsForLogin(ada.token), 1);
  assert.strictEqual(await store.sessionFor(token), null);
  assert.ok(await store.sessionFor(other), 'the session from another sign-in stays');
  assert.strictEqual(await store.endSession(other), true);
  assert.strictEqual(await store.sessionFor(other), null);
});

test('account deletion takes role and sessions; the audit keeps the name', async (t) => {
  const { store, rows, account, accounts } = await setup(t, 'adm_delete');
  const ada = await account('Ada', 'ada@example.org');
  await store.grantCli('ada@example.org');
  const token = await store.createSession({ userId: ada.id, loginToken: ada.token, method: 'password' });
  await store.audit({ userId: ada.id, userName: 'Ada', action: 'view', target: 'users', ip: '203.0.113.9' });
  assert.ok((await accounts.deleteUser('Ada')).ok);
  assert.strictEqual(await store.sessionFor(token), null);
  assert.deepStrictEqual(await rows('SELECT * FROM user_roles'), []);
  assert.deepStrictEqual(await rows('SELECT * FROM admin_sessions'), []);
  const [view] = await rows("SELECT user_id, user_name FROM admin_audit_events WHERE action = 'view'");
  assert.deepStrictEqual([view.user_id, view.user_name], [null, 'Ada']);
});

test('audit: newest first in pages of 50, networks cut to /24 and /48, 365 days kept', async (t) => {
  const { store, rows, tick } = await setup(t, 'adm_audit');
  for (let i = 1; i <= 120; i++) {
    tick(MIN);
    await store.audit({ userName: 'Ada', action: 'view', target: `t${i}` });
  }
  const p1 = await store.auditPage({ page: 1 });
  assert.strictEqual(p1.events.length, 50);
  assert.ok(p1.hasMore);
  assert.strictEqual(p1.events[0].target, 't120', 'newest first');
  const p3 = await store.auditPage({ page: 3 });
  assert.deepStrictEqual([p3.events.length, p3.hasMore, p3.events[19].target], [20, false, 't1']);
  assert.strictEqual((await store.auditPage({ page: 'x' })).page, 1);
  const far = await store.auditPage({ page: '1e400' });
  assert.deepStrictEqual([far.page, far.events.length, far.hasMore], [1e6, 0, false], 'Infinity is clamped, not an error');

  for (const [ip, net] of [['203.0.113.45', '203.0.113.0/24'], ['2001:db8:1234:5678::1', '2001:db8:1234::/48'],
    ['::ffff:198.51.100.7', '198.51.100.0/24'], ['unknown', null]]) {
    await store.audit({ action: 'step_up.ok', target: ip, ip });
    const [row] = await rows('SELECT client_network::text AS n FROM admin_audit_events ORDER BY id DESC LIMIT 1');
    assert.strictEqual(row.n, net, ip);
  }
  assert.ok(await store.audit({ action: 'logout', target: 'x'.repeat(500), details: { long: true } }), 'a long target is cut, not refused');

  // Retention: 365 days. The audit prunes by itself at most once an hour.
  await rows("UPDATE admin_audit_events SET occurred_at = occurred_at - interval '366 days' WHERE action_target IN ('t1', 't2')");
  await rows("UPDATE admin_audit_events SET occurred_at = occurred_at - interval '364 days' WHERE action_target = 't3'");
  assert.strictEqual(await store.pruneAudit(), 2);
  assert.deepStrictEqual((await rows("SELECT action_target FROM admin_audit_events WHERE action_target IN ('t1', 't2', 't3')")).map((r) => r.action_target), ['t3']);
  await rows("UPDATE admin_audit_events SET occurred_at = occurred_at - interval '400 days' WHERE action_target = 't4'");
  tick(2 * HOUR);
  await store.audit({ action: 'view', target: 'later' });
  assert.deepStrictEqual(await rows("SELECT 1 FROM admin_audit_events WHERE action_target = 't4'"), [], 'pruned on the next write after an hour');
});

test('CLI: grant, revoke (refused for PIKDAME_ADMINS) and list, with clear exit codes', async (t) => {
  const { url, account, store } = await setup(t, 'adm_cli');
  await account('Ada', 'ada@example.org');
  await account('Ben', 'ben@example.org');
  await account('Cleo', 'cleo@example.org', { confirm: false });
  await store.syncEnvAdmins(new Set(['ben@example.org']));
  const env = { PIKDAME_DATABASE_URL: url, PIKDAME_ADMINS: 'ben@example.org, waiting@example.org' };
  const go = async (...argv) => {
    const lines = [];
    const out = { log: (l) => lines.push(l), error: (l) => lines.push(`! ${l}`) };
    const code = await cli(argv, env, out);
    return { code, text: lines.join('\n') };
  };
  let r = await go('grant', 'ADA@example.org');
  assert.deepStrictEqual([r.code, r.text], [0, '✓ Ada ist jetzt Admin (CLI).']);
  r = await go('grant', 'cleo@example.org');
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /noch nicht bestätigt/);
  assert.strictEqual((await go('grant', 'nobody@example.org')).code, 1);
  r = await go('revoke', 'ben@example.org');
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /über PIKDAME_ADMINS Admin/);
  assert.match(r.text, /aus PIKDAME_ADMINS entfernen und den Container neu erstellen/);
  r = await go('list');
  assert.strictEqual(r.code, 0);
  assert.match(r.text, /^Ada <ada@example\.org> {2}Quelle: CLI {2}seit .* {2}Step-up: Passwort$/m);
  assert.match(r.text, /^Ben <ben@example\.org> {2}Quelle: PIKDAME_ADMINS/m);
  assert.match(r.text, /PIKDAME_ADMINS ohne bestätigtes Konto \(noch kein Admin\): waiting@example\.org/);
  r = await go('revoke', 'ada@example.org');
  assert.deepStrictEqual([r.code, r.text], [0, '✓ Ada ist kein Admin mehr.']);
  assert.strictEqual((await go('frobnicate')).code, 2);
  assert.strictEqual((await go('grant')).code, 2);
  assert.strictEqual(await cli(['list'], {}, { log() {}, error() {} }), 2, 'no database configured');

  // As a process, the way the operator runs it in the container.
  const res = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'admin-role.js'), 'list'], { env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  assert.strictEqual(res.code, 0, res.stderr);
  assert.match(res.stdout, /^Ben <ben@example\.org>/m);
});

test('migration 009: the tables, keys and checks named by the conventions, on a database with accounts', async (t) => {
  const url = testDatabaseUrl('mig_admin');
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());
  const rows = async (q) => (await pool.query(q)).rows;
  const version = loadMigrations().find((m) => m.name === 'admin_role').version;
  assert.strictEqual(version, 9);
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-mig-admin-'));
  for (const m of loadMigrations().filter((x) => x.version < version)) fs.copyFileSync(m.file, path.join(dir, path.basename(m.file)));
  await migrate(pool, { dir });
  await pool.query(`INSERT INTO users (username, email, password_hash, password_salt, email_verified)
    VALUES ('Ada', 'ada@example.org', '\\x00', 's', TRUE)`);
  assert.deepStrictEqual(await migrate(pool), [version]);
  const named = await rows(`SELECT tablename || ':' || indexname AS i FROM pg_indexes WHERE schemaname = current_schema()
    AND tablename IN ('user_roles', 'admin_sessions', 'admin_audit_events') ORDER BY 1`);
  assert.deepStrictEqual(named.map((r) => r.i), [
    'admin_audit_events:admin_audit_events_occurred_at_idx', 'admin_audit_events:admin_audit_events_pkey',
    'admin_sessions:admin_sessions_pkey', 'user_roles:user_roles_pkey',
  ]);
  const constraints = await rows(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = current_schema() AND contype IN ('c', 'f')
      AND conrelid::regclass::text IN ('user_roles', 'admin_sessions', 'admin_audit_events') ORDER BY 1`);
  assert.deepStrictEqual(constraints.map((r) => r.conname), [
    'admin_audit_events_user_id_fkey', 'admin_sessions_step_up_method_check', 'admin_sessions_user_id_fkey',
    'user_roles_grant_source_check', 'user_roles_role_name_check', 'user_roles_user_id_fkey',
  ]);
  const [ada] = await rows('SELECT id FROM users');
  await assert.rejects(pool.query("INSERT INTO user_roles (user_id, role_name, grant_source) VALUES ($1, 'root', 'env')", [ada.id]), /user_roles_role_name_check/);
  await assert.rejects(pool.query("INSERT INTO user_roles (user_id, role_name, grant_source) VALUES ($1, 'admin', 'web')", [ada.id]), /user_roles_grant_source_check/,
    'no source for a role granted on the web');
  const types = await rows(`SELECT table_name || '.' || column_name || ':' || data_type AS col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name IN ('user_roles', 'admin_sessions', 'admin_audit_events')
      AND column_name ~ '_at$' ORDER BY 1`);
  assert.ok(types.every((r) => r.col.endsWith(':timestamp with time zone')), JSON.stringify(types));
});
