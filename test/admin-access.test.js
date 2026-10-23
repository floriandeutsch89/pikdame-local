// The admin area over HTTP against PostgreSQL: the step-up (a passkey with user
// verification, else the password), the admin cookie, CSRF, the failure locks,
// revocation, the audit log - and that no token ever lands in a URL or the log.
// Store-level rules (sync, CLI precedence, clocks): admin-role.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { freePort } = require('./helpers/free-port');
const { testDatabaseUrl } = require('./helpers/test-db');
const { softAuthenticator } = require('./helpers/soft-authenticator');
const { call } = require('./helpers/admin-session');
const { createPgAccountStore } = require('../game/PgAccountStore');
const { run: adminRoleCli } = require('../scripts/admin-role');

let HAS_LIB = true;
try { require('@simplewebauthn/server'); } catch (e) { HAS_LIB = false; }

async function waitFor(fn, what, timeoutMs = 10000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
}

/** Accounts made in the database before the server starts: { name: { email, password, token } }.
 *  `password: null` = signed up without one; `confirm: false` = address not confirmed. */
async function makeAccounts(url, list) {
  const store = createPgAccountStore(url);
  const out = {};
  try {
    for (const { name, email, password = 'long-password-1', confirm = true } of list) {
      if (password === null) {
        const r = await store.registerWithoutPassword(name, email);
        assert.ok(r.ok, r.error);
        const s = await store.verifyCodeAndSignIn(email, r.code);
        out[name] = { name, email, password: null, token: s.token };
      } else {
        const r = await store.register(name, email, password);
        assert.ok(r.ok, r.error);
        if (confirm) await store.verifyEmail(r.verifyToken);
        out[name] = { name, email, password, verifyToken: r.verifyToken, token: confirm ? (await store.login(email, password)).token : null };
      }
    }
  } finally {
    await store.close();
  }
  return out;
}

async function startServer(t, databaseUrl, env = {}) {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-admin-access-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_DATABASE_URL: databaseUrl, PIKDAME_BASE_URL: origin,
      PIKDAME_SMTP_HOST: '', PIKDAME_TRUST_PROXY: '1', PIKDAME_ONNX: '0', PIKDAME_ADMIN_PASSKEY_ONLY: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { log: '' };
  server.stdout.on('data', (c) => { out.log += c; });
  server.stderr.on('data', (c) => { out.log += c; });
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitFor(async () => { try { return (await call(port, 'GET', '/healthz')).status === 200; } catch (e) { return false; } }, 'server up', 15000);
  // PIKDAME_ADMINS is applied right after the start, the report follows it.
  await waitFor(() => /\[config\] Konfiguration:/.test(out.log), 'config report');
  // Each phase acts from its own address (the server trusts X-Forwarded-For here).
  const client = { ip: '198.51.100.1' };
  const responses = [];
  const req = async (method, urlPath, opts = {}) => {
    const r = await call(port, method, urlPath, { ...opts, headers: { 'X-Forwarded-For': client.ip, ...(opts.headers || {}) } });
    responses.push(r);
    return r;
  };
  return { port, origin, out, req, client, responses };
}

const cookieOf = (res) => (res.headers['set-cookie'] || [])[0] || '';
const csrfOf = (html) => (html.match(/name="csrf" value="([a-f0-9]{64})"/) || [])[1];
const isStepUp = (res) => /Bestätige, dass du es bist/.test(res.body) && !/Angemeldet als/.test(res.body);

/** The game client's passkey sign-up through the API (the account's sign-in token). */
async function addPasskey(srv, token, auth) {
  const ao = await srv.req('POST', '/api/passkey/add/options', { json: { token } });
  assert.strictEqual(ao.status, 200, ao.body);
  const done = await srv.req('POST', '/api/passkey/add/verify', { json: { token, flowId: ao.json.flowId, response: auth.create(ao.json.options) } });
  assert.strictEqual(done.status, 200, done.body);
}

/** Password step-up -> { cookie, csrf }. */
async function passwordStepUp(srv, account) {
  const v = await srv.req('POST', '/admin/step-up/verify', { json: { token: account.token, password: account.password } });
  assert.strictEqual(v.status, 200, v.body);
  const cookie = cookieOf(v).split(';')[0];
  const page = await srv.req('GET', '/admin', { headers: { Cookie: cookie } });
  assert.match(page.body, /Angemeldet als/);
  return { cookie, csrf: csrfOf(page.body) };
}

test('step-up: passkey with user verification, else the password; guests, non-admins and accounts without a way in get 403',
  { skip: !HAS_LIB && 'needs @simplewebauthn/server' }, async (t) => {
    const url = testDatabaseUrl('adm_stepup');
    const acc = await makeAccounts(url, [
      { name: 'Pia', email: 'pia@example.org', password: null },
      { name: 'Paul', email: 'paul@example.org' },
      { name: 'Nora', email: 'nora@example.org', password: null },
      { name: 'Gast', email: 'gast@example.org' },
      { name: 'Wanda', email: 'wanda@example.org', confirm: false },
    ]);
    const srv = await startServer(t, url, { PIKDAME_ADMINS: 'pia@example.org, Paul@Example.org, nora@example.org, wanda@example.org' });
    const { req } = srv;
    assert.match(srv.out.log, /\[admin\] Rolle aus PIKDAME_ADMINS vergeben: (?=.*Pia)(?=.*Paul)(?=.*Nora)/);
    assert.match(srv.out.log, /PIKDAME_ADMINS: 1 Adresse\(n\) noch ohne bestätigtes Konto/, 'Wanda waits for her confirmation');

    // The game client only learns whether to show the link.
    const me = async (a) => (await req('POST', '/api/me', { json: { token: a.token } })).json;
    assert.deepStrictEqual([(await me(acc.Pia)).isAdmin, (await me(acc.Paul)).isAdmin, (await me(acc.Nora)).isAdmin, (await me(acc.Gast)).isAdmin],
      [true, true, true, false]);

    const piaKey = softAuthenticator(srv.origin, 'localhost');
    const gastKey = softAuthenticator(srv.origin, 'localhost');
    await addPasskey(srv, acc.Pia.token, piaKey);
    await addPasskey(srv, acc.Gast.token, gastKey);

    // In front of /admin: the step-up page, without any token in it.
    const gate = await req('GET', '/admin/users');
    assert.strictEqual(gate.status, 200);
    assert.ok(isStepUp(gate));
    assert.match(gate.body, /<script src="\/vendor-simplewebauthn\.js" defer><\/script>\n<script src="\/admin-stepup\.js" defer><\/script>/);
    assert.strictEqual((await req('GET', '/admin-stepup.js')).status, 200, 'the step-up script is a file (CSP)');

    // Who may not: a guest, an unknown sign-in, a player without the role, an admin without a way in.
    const start = (token) => req('POST', '/admin/step-up/start', { json: { token } });
    assert.deepStrictEqual([(await start(undefined)).status, (await start(undefined)).json.reason], [403, 'signin']);
    assert.strictEqual((await start('f'.repeat(64))).json.reason, 'signin');
    const gast = await start(acc.Gast.token);
    assert.deepStrictEqual([gast.status, gast.json.reason], [403, 'forbidden']);
    const gastTry = await req('POST', '/admin/step-up/verify', { json: { token: acc.Gast.token, password: acc.Gast.password } });
    assert.strictEqual(gastTry.status, 403, 'the right password does not make a player an admin');
    assert.strictEqual(gastTry.headers['set-cookie'], undefined);
    const nora = await start(acc.Nora.token);
    assert.deepStrictEqual([nora.status, nora.json.reason], [403, 'no-method']);
    assert.match(nora.json.error, /Passkey an/);
    assert.strictEqual((await req('POST', '/admin/step-up/start', { json: { token: acc.Pia.token }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);

    // Pia: her own passkey, user verification required. (Phases use their own address:
    // the strict account limit allows 20 such calls per address.)
    srv.client.ip = '198.51.100.2';
    let s = await start(acc.Pia.token);
    assert.strictEqual(s.status, 200, s.body);
    assert.strictEqual(s.json.method, 'passkey');
    assert.strictEqual(s.json.options.userVerification, 'required');
    assert.strictEqual(s.json.options.rpId, 'localhost');
    assert.deepStrictEqual(s.json.options.allowCredentials.map((c) => c.id), [piaKey.id], 'only her own passkeys');
    const verify = (body) => req('POST', '/admin/step-up/verify', { json: { token: acc.Pia.token, ...body } });
    let v = await verify({ flowId: s.json.flowId, response: piaKey.get(s.json.options, { userVerified: false }) });
    assert.strictEqual(v.status, 401, 'a tap without Face ID / PIN is not enough');
    s = await start(acc.Pia.token);
    v = await verify({ flowId: s.json.flowId, response: gastKey.get(s.json.options) });
    assert.deepStrictEqual([v.status, v.json.error], [401, 'Dieser Passkey gehört nicht zu deinem Konto.']);
    v = await verify({ password: 'long-password-1' });
    assert.strictEqual(v.status, 401, 'an account with a passkey cannot fall back to a password');
    s = await start(acc.Pia.token);
    v = await verify({ flowId: s.json.flowId, response: piaKey.get(s.json.options) });
    assert.strictEqual(v.status, 200, v.body);
    assert.match(cookieOf(v), /^pikdame_admin=[A-Za-z0-9_-]{43}; Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=28800$/, 'no Secure over plain http');
    assert.strictEqual(v.headers['cache-control'], 'no-store');
    const piaCookie = cookieOf(v).split(';')[0];
    assert.strictEqual((await verify({ flowId: s.json.flowId, response: piaKey.get(s.json.options) })).status, 401, 'a flow is single use');
    const page = await req('GET', '/admin', { headers: { Cookie: piaCookie } });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /Angemeldet als <b>Pia<\/b> \(Passkey\)/);
    assert.strictEqual(page.headers['x-frame-options'], 'DENY');

    // Paul has no passkey: his password.
    srv.client.ip = '198.51.100.3';
    s = await start(acc.Paul.token);
    assert.deepStrictEqual([s.json.method, s.json.username, s.json.email], ['password', 'Paul', 'paul@example.org']);
    const wrong = await req('POST', '/admin/step-up/verify', { json: { token: acc.Paul.token, password: 'nope' } });
    assert.deepStrictEqual([wrong.status, wrong.json.error], [401, 'Das Passwort stimmt nicht.']);
    const paul = await passwordStepUp(srv, acc.Paul);
    assert.ok(paul.cookie && paul.csrf);

    // Wanda is listed but unconfirmed: no sign-in - and even a forged one gets no role.
    srv.client.ip = '198.51.100.4';
    assert.strictEqual((await req('POST', '/api/login', { json: { username: 'wanda@example.org', password: 'long-password-1' } })).status, 401);
    const db = new Pool({ connectionString: url, max: 2 });
    t.after(() => db.end());
    await db.query("INSERT INTO login_sessions (session_token, user_id) SELECT 'forged-wanda', id FROM users WHERE username = 'Wanda'");
    assert.strictEqual((await me({ token: 'forged-wanda' })).isAdmin, false);
    assert.strictEqual((await start('forged-wanda')).json.reason, 'forbidden');
    assert.deepStrictEqual((await db.query("SELECT * FROM user_roles r JOIN users u ON u.id = r.user_id WHERE u.username = 'Wanda'")).rows, []);
    await db.query("DELETE FROM login_sessions WHERE session_token = 'forged-wanda'");

    // Wanda confirms while the server runs: the role follows without a restart.
    const accounts = createPgAccountStore(url);
    t.after(() => accounts.close());
    assert.ok((await accounts.verifyEmail(acc.Wanda.verifyToken)).ok);
    const login = await req('POST', '/api/login', { json: { username: 'wanda@example.org', password: 'long-password-1' } });
    acc.Wanda.token = login.json.token;
    assert.strictEqual((await me(acc.Wanda)).isAdmin, true);
    assert.match(srv.out.log, /\[admin\] Rolle aus PIKDAME_ADMINS vergeben: Wanda/);
    await passwordStepUp(srv, acc.Wanda);

    // The audit: who came in how, who failed, who was turned away.
    const audit = (await db.query(`SELECT user_name, action, details->>'method' AS method, details->>'reason' AS reason, client_network::text AS net
      FROM admin_audit_events WHERE action LIKE 'step_up.%' ORDER BY id`)).rows;
    assert.deepStrictEqual(audit.map((e) => `${e.user_name} ${e.action} ${e.method || e.reason || ''}`.trim()), [
      'Gast step_up.denied', 'Gast step_up.denied', 'Pia step_up.failed passkey', 'Pia step_up.failed passkey', 'Pia step_up.failed passkey',
      'Pia step_up.ok passkey', 'Pia step_up.failed passkey', 'Paul step_up.failed password', 'Paul step_up.ok password',
      'Wanda step_up.denied', 'Wanda step_up.ok password',
    ]);
    assert.ok(audit.every((e) => e.net === '198.51.100.0/24'), 'the address is kept cut to /24');

    // Tokens travel in bodies and the cookie only: never in a URL, never in the log.
    const secrets = [acc.Pia.token, acc.Paul.token, acc.Wanda.token, piaCookie.split('=')[1], paul.cookie.split('=')[1], 'long-password-1'];
    for (const r of srv.responses) {
      for (const secret of secrets) assert.ok(!String(r.headers.location || '').includes(secret), 'a token in a Location header');
    }
    for (const secret of secrets) assert.ok(!srv.out.log.includes(secret), 'a token or password in the server log');
  });

test('admin session: CSRF, logout, game sign-out, role removal, account deletion, idle and absolute expiry, audit page', async (t) => {
  const url = testDatabaseUrl('adm_session');
  const acc = await makeAccounts(url, [
    { name: 'Ada', email: 'ada@example.org' },
    { name: 'Bert', email: 'bert@example.org' },
    { name: 'Dora', email: 'dora@example.org' },
    { name: 'Del', email: 'del@example.org' },
  ]);
  const srv = await startServer(t, url, { PIKDAME_ADMINS: 'ada@example.org, dora@example.org' });
  const { req } = srv;
  const db = new Pool({ connectionString: url, max: 2 });
  t.after(() => db.end());
  const cli = (...argv) => adminRoleCli(argv, { PIKDAME_DATABASE_URL: url, PIKDAME_ADMINS: 'ada@example.org, dora@example.org' }, { log() {}, error() {} });
  const get = (urlPath, cookie) => req('GET', urlPath, { headers: { Cookie: cookie } });
  const signIn = async (a) => { a.token = (await req('POST', '/api/login', { json: { username: a.email, password: a.password } })).json.token; };

  let ada = await passwordStepUp(srv, acc.Ada);
  assert.strictEqual(await cli('grant', 'bert@example.org'), 0, 'break-glass grant');
  const bert = await passwordStepUp(srv, acc.Bert);

  // CSRF: every state-changing request needs this session's token, from this site.
  const postUsers = (cookie, form, headers = {}) => req('POST', '/admin/users', { form, headers: { Cookie: cookie, ...headers } });
  assert.strictEqual((await postUsers(ada.cookie, 'username=Del&action=delete')).status, 403, 'no token');
  assert.strictEqual((await postUsers(ada.cookie, `csrf=${bert.csrf}&username=Del&action=delete`)).status, 403, 'another session\'s token');
  assert.strictEqual((await postUsers(ada.cookie, `csrf=${encodeURIComponent('ä'.repeat(64))}&username=Del&action=delete`)).status, 403, 'multibyte junk: 403, not 500');
  assert.strictEqual((await postUsers(ada.cookie, `csrf=${ada.csrf}&username=Del&action=delete`, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await req('POST', '/admin/users', { form: `csrf=${ada.csrf}&username=Del&action=delete` })).status, 403, 'no session');
  assert.strictEqual((await db.query("SELECT count(*)::int AS n FROM users WHERE username = 'Del'")).rows[0].n, 1, 'nothing happened');
  const del = await postUsers(ada.cookie, `csrf=${ada.csrf}&username=Del&action=delete`);
  assert.match(del.body, /Benutzer „Del“ wurde gelöscht/);
  // Admin accounts are marked and cannot be deleted here.
  const users = await get('/admin/users', ada.cookie);
  assert.match(users.body, /<b>Dora<\/b> <span class="badge role">Admin<\/span>/);
  assert.doesNotMatch(users.body, /name="username" value="Dora"><button type="submit" name="action" value="ask-delete"/);
  const refused = await postUsers(ada.cookie, `csrf=${ada.csrf}&username=Dora&action=delete`);
  assert.match(refused.body, /„Dora“ ist ein Admin-Konto und lässt sich hier nicht löschen/);

  // Logout: the session ends, the cookie is cleared, the game is next.
  const out = await req('POST', '/admin/logout', { form: `csrf=${ada.csrf}`, headers: { Cookie: ada.cookie } });
  assert.strictEqual(out.status, 303);
  assert.strictEqual(out.headers.location, '/');
  assert.match(cookieOf(out), /^pikdame_admin=; Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=0$/);
  const after = await get('/admin', ada.cookie);
  assert.ok(isStepUp(after));
  assert.match(cookieOf(after), /Max-Age=0/, 'a dead cookie is cleared');

  // Signing out of the game ends the admin session stepped up from that sign-in.
  ada = await passwordStepUp(srv, acc.Ada);
  assert.strictEqual((await req('POST', '/api/logout', { json: { token: acc.Ada.token } })).status, 200);
  assert.ok(isStepUp(await get('/admin', ada.cookie)));
  await signIn(acc.Ada);

  // Role removal (CLI) ends Bert's session at once; account deletion ends Dora's.
  assert.ok(!isStepUp(await get('/admin', bert.cookie)));
  assert.strictEqual(await cli('revoke', 'bert@example.org'), 0);
  assert.ok(isStepUp(await get('/admin', bert.cookie)));
  assert.strictEqual((await req('POST', '/admin/step-up/start', { json: { token: acc.Bert.token } })).json.reason, 'forbidden');
  assert.strictEqual(await cli('revoke', 'dora@example.org'), 1, 'PIKDAME_ADMINS wins over the CLI');
  const dora = await passwordStepUp(srv, acc.Dora);
  const accounts = createPgAccountStore(url);
  t.after(() => accounts.close());
  assert.ok((await accounts.deleteUser('Dora')).ok);
  assert.ok(isStepUp(await get('/admin', dora.cookie)));

  // Idle: 15 minutes without a request. The charts' refresh is no activity.
  const lastSeen = async () => Number((await db.query('SELECT EXTRACT(EPOCH FROM now() - max(last_seen_at)) AS s FROM admin_sessions')).rows[0].s);
  ada = await passwordStepUp(srv, acc.Ada);
  await db.query("UPDATE admin_sessions SET last_seen_at = now() - interval '14 minutes'");
  assert.strictEqual((await get('/admin/monitor/data?range=1h', ada.cookie)).status, 200);
  assert.ok(await lastSeen() > 13 * 60, 'the poll did not extend the session');
  await db.query("UPDATE admin_sessions SET last_seen_at = now() - interval '16 minutes'");
  assert.strictEqual((await get('/admin/monitor/data?range=1h', ada.cookie)).status, 403);
  assert.ok(isStepUp(await get('/admin', ada.cookie)));
  ada = await passwordStepUp(srv, acc.Ada);
  await db.query("UPDATE admin_sessions SET last_seen_at = now() - interval '14 minutes'");
  assert.ok(!isStepUp(await get('/admin/monitor', ada.cookie)), 'a page view is activity');
  assert.ok(await lastSeen() < 60);
  // Absolute: 8 hours, however active.
  await db.query("UPDATE admin_sessions SET created_at = now() - interval '8 hours 1 minute'");
  assert.ok(isStepUp(await get('/admin', ada.cookie)));

  // A read-only view is audited once per tab and session.
  ada = await passwordStepUp(srv, acc.Ada);
  const views = async () => (await db.query("SELECT count(*)::int AS n FROM admin_audit_events WHERE action = 'view' AND action_target = 'stuck'")).rows[0].n;
  const before = await views();
  await get('/admin/stuck', ada.cookie);
  await get('/admin/stuck?month=2026-01', ada.cookie);
  assert.strictEqual(await views(), before + 1);

  const actions = (await db.query('SELECT user_name, action, action_target FROM admin_audit_events ORDER BY id')).rows.map((e) => `${e.user_name || '-'} ${e.action} ${e.action_target || ''}`.trim());
  for (const line of ['- role.grant Ada', '- role.grant Dora', '- role.grant Bert', 'Ada step_up.ok', 'Ada user.delete Del', 'Ada logout', '- role.revoke Bert', 'Ada view users']) {
    assert.ok(actions.includes(line), `audit has "${line}": ${actions.join(' | ')}`);
  }
  assert.ok(!actions.some((a) => / user\.delete Dora/.test(a)), 'the refused delete did nothing');

  // The "Protokoll" tab shows it, newest first.
  const log = await get('/admin/audit', ada.cookie);
  assert.strictEqual(log.status, 200);
  assert.match(log.body, /class="active" aria-current="page">Protokoll</);
  assert.match(log.body, /Konto gelöscht: Del/);
  assert.match(log.body, /<td class="actor"><b>Betreiber \(CLI\)<\/b><\/td>\n<td class="what">Admin-Rolle entzogen: Bert<span class="sub">1 Sitzung beendet<\/span>/);
  assert.match(log.body, /<td class="actor"><b>Betreiber \(PIKDAME_ADMINS\)<\/b><\/td>\n<td class="what">Admin-Rolle vergeben: Ada<\/td>/);
  assert.match(log.body, /198\.51\.100\.0\/24/);
  assert.ok(log.body.indexOf('Angesehen: Festhänger') < log.body.indexOf('Konto gelöscht: Del'), 'newest first');
  assert.doesNotMatch(log.body, /<script>/);
});

test('step-up limits: 5 failures lock the account, 10 the address, from anywhere resp. for anyone', async (t) => {
  const url = testDatabaseUrl('adm_limits');
  const acc = await makeAccounts(url, [
    { name: 'Lea', email: 'lea@example.org' }, { name: 'Leo', email: 'leo@example.org' }, { name: 'Lou', email: 'lou@example.org' },
  ]);
  const srv = await startServer(t, url, { PIKDAME_ADMINS: 'lea@example.org, leo@example.org, lou@example.org' });
  const tryPw = (a, password) => srv.req('POST', '/admin/step-up/verify', { json: { token: a.token, password } });

  srv.client.ip = '203.0.113.7';
  for (let i = 0; i < 5; i++) assert.strictEqual((await tryPw(acc.Lea, `wrong-${i}`)).status, 401);
  let r = await tryPw(acc.Lea, acc.Lea.password);
  assert.deepStrictEqual([r.status, r.json.reason, r.headers['retry-after']], [429, 'locked', '900'], 'the account is locked, even with the right password');
  srv.client.ip = '203.0.113.200';
  assert.strictEqual((await tryPw(acc.Lea, acc.Lea.password)).status, 429, 'from another address too');

  srv.client.ip = '203.0.113.7';
  for (let i = 0; i < 5; i++) assert.strictEqual((await tryPw(acc.Leo, `wrong-${i}`)).status, 401);
  r = await tryPw(acc.Lou, acc.Lou.password);
  assert.strictEqual(r.status, 429, 'ten failures lock the address for every account');
  assert.strictEqual((await srv.req('POST', '/admin/step-up/start', { json: { token: acc.Lou.token } })).status, 429);
  srv.client.ip = '203.0.113.99';
  assert.strictEqual((await tryPw(acc.Lou, acc.Lou.password)).status, 200, 'Lou from home is fine');

  const db = new Pool({ connectionString: url, max: 1 });
  t.after(() => db.end());
  const failed = (await db.query("SELECT count(*)::int AS n FROM admin_audit_events WHERE action = 'step_up.failed'")).rows[0].n;
  assert.strictEqual(failed, 10, 'every failure is in the audit, the locked tries are not');
});

test('PIKDAME_ADMIN_PASSKEY_ONLY=1: no password fallback; the passkey still opens /admin', { skip: !HAS_LIB && 'needs @simplewebauthn/server' }, async (t) => {
  const url = testDatabaseUrl('adm_pkonly');
  const acc = await makeAccounts(url, [{ name: 'Pia', email: 'pia@example.org', password: null }, { name: 'Paul', email: 'paul@example.org' }]);
  const srv = await startServer(t, url, { PIKDAME_ADMINS: 'pia@example.org, paul@example.org', PIKDAME_ADMIN_PASSKEY_ONLY: '1' });
  assert.match(srv.out.log, /✓ Admin-Bereich +\/admin für 2 Admin-Konten, Bestätigung nur per Passkey/);
  const paul = await srv.req('POST', '/admin/step-up/start', { json: { token: acc.Paul.token } });
  assert.deepStrictEqual([paul.status, paul.json.reason], [403, 'passkey-required']);
  const pw = await srv.req('POST', '/admin/step-up/verify', { json: { token: acc.Paul.token, password: acc.Paul.password } });
  assert.strictEqual(pw.status, 403);
  assert.strictEqual(pw.headers['set-cookie'], undefined);
  const key = softAuthenticator(srv.origin, 'localhost');
  await addPasskey(srv, acc.Pia.token, key);
  const s = await srv.req('POST', '/admin/step-up/start', { json: { token: acc.Pia.token } });
  assert.strictEqual(s.json.method, 'passkey');
  const v = await srv.req('POST', '/admin/step-up/verify', { json: { token: acc.Pia.token, flowId: s.json.flowId, response: key.get(s.json.options) } });
  assert.strictEqual(v.status, 200, v.body);
});
