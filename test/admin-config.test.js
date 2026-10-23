// Config report (startup log + /admin) and the admin page's wiring.
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { buildConfigReport, formatConfigReport } = require('../game/ConfigReport');
const AdminPage = require('../game/AdminPage');
const { testDatabaseUrl } = require('./helpers/test-db');
const { createAdminAccount, adminLogin, ADMIN } = require('./helpers/admin-session');

const byId = (report, id) => report.find((i) => i.id === id);
const ADMIN_OK = { listed: 1, invalid: [], active: 1, passkeyOnly: false, passkeysEnabled: true };
const FACTS = { dataDir: '/data', dataDirWritable: true, accountsEnabled: true, onnxActive: false, admin: ADMIN_OK };

test('config report: accounts without SMTP warn that links only reach the log', () => {
  const r = buildConfigReport({}, FACTS);
  assert.equal(byId(r, 'mail').status, 'warn');
  assert.deepEqual(byId(r, 'mail').missing, ['PIKDAME_SMTP_HOST']);
  // Without accounts there is nothing to mail - not a problem.
  const off = buildConfigReport({ PIKDAME_ACCOUNTS: '0' }, { ...FACTS, accountsEnabled: false });
  assert.equal(byId(off, 'mail').status, 'off');
  assert.equal(byId(off, 'accounts').status, 'off');
});

test('config report: half-configured SMTP names every missing variable', () => {
  const r = buildConfigReport({ PIKDAME_SMTP_HOST: 'smtp.example.com' }, FACTS);
  const mail = byId(r, 'mail');
  assert.equal(mail.status, 'warn');
  assert.deepEqual(mail.missing, ['PIKDAME_SMTP_USER', 'PIKDAME_SMTP_PASS', 'PIKDAME_MAIL_FROM']);
  // A _FILE secret counts as set.
  const full = buildConfigReport({
    PIKDAME_SMTP_HOST: 'smtp.example.com', PIKDAME_SMTP_USER: 'u', PIKDAME_SMTP_PASS_FILE: '/run/secrets/x',
    PIKDAME_MAIL_FROM: 'Pik Dame <a@b.de>',
  }, FACTS);
  assert.equal(byId(full, 'mail').status, 'ok');
  assert.equal(byId(buildConfigReport({ PIKDAME_SMTP_HOST: 'h', PIKDAME_SMTP_SECURE: 'tls' }, FACTS), 'mail').status, 'error');
});

test('config report: base URL, database and data dir problems are flagged', () => {
  const proxied = buildConfigReport({ PIKDAME_TRUST_PROXY: '1' }, FACTS);
  assert.equal(byId(proxied, 'baseUrl').status, 'warn', 'host-header links behind a proxy');
  assert.equal(byId(buildConfigReport({ PIKDAME_BASE_URL: 'not a url' }, FACTS), 'baseUrl').status, 'error');
  assert.equal(byId(buildConfigReport({ PIKDAME_BASE_URL: 'http://play.example.com' }, FACTS), 'baseUrl').status, 'warn');
  assert.equal(byId(buildConfigReport({ PIKDAME_BASE_URL: 'https://play.example.com' }, FACTS), 'baseUrl').status, 'ok');
  assert.equal(byId(buildConfigReport({ PIKDAME_DATABASE_URL: 'postgres://u@db:5432/x' }, FACTS), 'database').status, 'warn');
  assert.equal(byId(buildConfigReport({ PIKDAME_DATABASE_URL: 'postgres://u:pw@db:5432/x' }, FACTS), 'database').status, 'ok');
  assert.equal(byId(buildConfigReport({}, { ...FACTS, dataDirWritable: false }), 'data').status, 'error');
  assert.equal(byId(buildConfigReport({}, FACTS), 'database').status, 'error', 'Postgres is mandatory');
  assert.equal(byId(buildConfigReport({ PIKDAME_ONNX: '1' }, FACTS), 'onnx').status, 'error');
});

test('config report: secret values never appear, problems are logged first', () => {
  const env = { PIKDAME_SMTP_HOST: 'h', PIKDAME_SMTP_USER: 'u', PIKDAME_SMTP_PASS: 'TOPSECRET', PIKDAME_DATABASE_URL: 'postgres://u:DBSECRET@db/x' };
  const text = JSON.stringify(buildConfigReport(env, FACTS)) + formatConfigReport(buildConfigReport(env, FACTS)).join('\n');
  assert.ok(!text.includes('TOPSECRET') && !text.includes('DBSECRET'));
  const lines = formatConfigReport(buildConfigReport({ PIKDAME_DATABASE_URL: 'postgres://u:pw@db/x' }, { ...FACTS, dataDirWritable: false }));
  assert.match(lines[1], /✗ Datenverzeichnis/, 'errors sort to the top');
});

test('admin page helpers: recipient checks', () => {
  assert.equal(AdminPage.validRecipient('a@b.de'), true);
  assert.equal(AdminPage.validRecipient('a@b.de\r\nRCPT TO:<x@y.de>'), false, 'no SMTP injection');
  assert.equal(AdminPage.validRecipient('nope'), false);
});

test('config report: every entry names its variables, secrets by _FILE when used', () => {
  const r = buildConfigReport({ PIKDAME_SMTP_HOST: 'h', PIKDAME_SMTP_PASS_FILE: '/run/secrets/smtp', PIKDAME_BASE_URL: 'https://x.de' }, FACTS);
  const names = (id) => byId(r, id).vars.map((x) => `${x.name}:${x.set}`);
  assert.ok(names('mail').includes('PIKDAME_SMTP_PASS_FILE:true'));
  assert.ok(names('mail').includes('PIKDAME_SMTP_HOST:true'));
  assert.ok(names('mail').includes('PIKDAME_SMTP_PORT:false'));
  assert.deepEqual(names('baseUrl'), ['PIKDAME_BASE_URL:true']);
  assert.deepEqual(names('admin'), ['PIKDAME_ADMINS:false', 'PIKDAME_ADMIN_PASSKEY_ONLY:false']);
  for (const item of r) assert.ok(item.vars.length > 0, `${item.id} lists its variables`);
});

test('config report: no admin warns and says how to make one', () => {
  const none = byId(buildConfigReport({}, { ...FACTS, admin: { ...ADMIN_OK, listed: 0, active: 0 } }), 'admin');
  assert.equal(none.status, 'warn');
  assert.deepEqual(none.missing, ['PIKDAME_ADMINS']);
  assert.match(none.detail, /kein Admin/);
  assert.match(none.detail, /PIKDAME_ADMINS=<deine E-Mail>/);
  assert.match(none.detail, /node scripts\/admin-role\.js grant <E-Mail>/, 'the break-glass CLI is named');
  const waiting = byId(buildConfigReport({ PIKDAME_ADMINS: 'a@b.de' }, { ...FACTS, admin: { ...ADMIN_OK, active: 0 } }), 'admin');
  assert.equal(waiting.status, 'warn');
  assert.match(waiting.detail, /nennt 1 Adresse, aber noch kein bestätigtes Konto/);
  const unknown = byId(buildConfigReport({}, { ...FACTS, admin: { ...ADMIN_OK, active: null } }), 'admin');
  assert.equal(unknown.status, 'warn', 'the database could not be asked');
});

test('config report: admins, a bad entry, passkey-only without passkeys, accounts off', () => {
  const ok = byId(buildConfigReport({ PIKDAME_ADMINS: 'a@b.de' }, { ...FACTS, admin: { ...ADMIN_OK, active: 2 } }), 'admin');
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /2 Admin-Konten, Bestätigung per Passkey, sonst Passwort/);
  assert.match(byId(buildConfigReport({}, { ...FACTS, admin: { ...ADMIN_OK, passkeyOnly: true } }), 'admin').detail, /nur per Passkey/);
  const bad = byId(buildConfigReport({}, { ...FACTS, admin: { ...ADMIN_OK, invalid: [2] } }), 'admin');
  assert.equal(bad.status, 'warn');
  assert.match(bad.detail, /Eintrag 2 in PIKDAME_ADMINS ist keine E-Mail-Adresse/);
  const locked = byId(buildConfigReport({}, { ...FACTS, admin: { ...ADMIN_OK, passkeyOnly: true, passkeysEnabled: false } }), 'admin');
  assert.equal(locked.status, 'error', 'nobody could get in');
  assert.deepEqual(locked.missing, ['PIKDAME_BASE_URL']);
  assert.equal(byId(buildConfigReport({ PIKDAME_ACCOUNTS: '0' }, { ...FACTS, accountsEnabled: false }), 'admin').status, 'off');
});

test('config report: an old admin token still set is a clear warning, never shown', () => {
  assert.equal(byId(buildConfigReport({}, FACTS), 'adminToken'), undefined, 'nothing to say without it');
  for (const env of [{ PIKDAME_ADMIN_TOKEN: '$argon2id$v=19$m=19456,t=2,p=1$SECRETSALT$SECRETHASH' }, { PIKDAME_ADMIN_TOKEN_FILE: '/run/secrets/admin_token' }]) {
    const r = buildConfigReport(env, FACTS);
    const item = byId(r, 'adminToken');
    assert.equal(item.status, 'warn');
    assert.match(item.detail, /wird nicht mehr gelesen/);
    assert.match(item.detail, /PIKDAME_ADMINS=<deine E-Mail>/);
    assert.ok(item.vars.every((x) => x.secret && x.value === undefined));
    const html = AdminPage.renderAdminPage({ report: r, csrf: 'c', mailConfigured: true });
    assert.ok(!html.includes('SECRETHASH') && !html.includes('/run/secrets/admin_token'), 'the old value stays hidden');
    assert.match(formatConfigReport(r).join('\n'), /⚠ Alter Admin-Token/);
  }
});

test('admin page escapes report text', () => {
  const html = AdminPage.renderAdminPage({
    report: [{ id: 'x', label: '<b>', status: 'warn', detail: '<script>alert(1)</script>', missing: ['A<'] }],
    runtime: { version: '1', uptimeSeconds: 5, sessions: 0, connectedPlayers: 0, rssMb: 1, node: 'v' },
    smtpProbe: null, notice: { ok: false, text: '<img>' }, csrf: 'c', mailConfigured: false,
    session: { username: '<i>x', method: 'passkey', createdAt: Date.now() },
  });
  assert.ok(!html.includes('<script>alert') && !html.includes('<img>') && !html.includes('A<<') && !html.includes('<i>x'));
  assert.match(html, /Angemeldet als <b>&lt;i&gt;x<\/b> \(Passkey\)/);
  assert.match(html, /<form method="post" action="\/admin\/logout"><input type="hidden" name="csrf" value="c">/, 'logout is a CSRF-protected POST');
});

// --- Real server: the wiring between HTTP and the helpers -------------------
let PORT = 0;
function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(body); }
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await request('GET', '/healthz')).status === 200) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
}
async function waitForLog(out, re, timeoutMs = 10000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (re.test(out.log)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no ${re} in the log`);
}

async function startServer(t, extraEnv, databaseUrl = testDatabaseUrl('admin_config')) {
  PORT = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-admin-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PIKDAME_DATABASE_URL: databaseUrl, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_ADMINS: '', PIKDAME_SMTP_HOST: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { log: '' };
  server.stdout.on('data', (c) => { out.log += c; });
  server.stderr.on('data', (c) => { out.log += c; });
  // Wait for exit: the server writes its snapshot into dataDir on SIGTERM (ENOTEMPTY race).
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return out;
}

test('/admin without accounts answers 404 like any unknown path', async (t) => {
  await startServer(t, { PIKDAME_ACCOUNTS: '0' });
  await waitForServer();
  assert.equal((await request('GET', '/admin')).status, 404);
  assert.equal((await request('GET', '/admin/')).status, 404, 'disabled: no redirect that would reveal the page');
});

test('/admin: the step-up page in front, then the session cookie, CSRF, mail check', async (t) => {
  const databaseUrl = testDatabaseUrl('admin_config');
  await createAdminAccount(databaseUrl);
  const out = await startServer(t, { PIKDAME_ADMINS: ADMIN.email, PIKDAME_ADMIN_TOKEN: 'old-plain-token' }, databaseUrl);
  await waitForServer();

  const gate = await request('GET', '/admin');
  assert.equal(gate.status, 200);
  assert.equal(gate.headers['cache-control'], 'no-store');
  assert.match(gate.body, /Bestätige, dass du es bist/);
  assert.match(gate.body, /<script src="\/admin-stepup\.js" defer><\/script>/);
  assert.doesNotMatch(gate.body, /<script>/, 'no inline script - the CSP only allows same-origin files');
  assert.doesNotMatch(gate.body, /Konfiguration/, 'nothing of the admin area before the step-up');
  assert.equal((await request('GET', '/admin', { headers: { Authorization: `Basic ${Buffer.from('admin:old-plain-token').toString('base64')}` } })).body, gate.body,
    'the old token opens nothing');

  const { cookie, csrf } = await adminLogin(PORT);
  const page = await request('GET', '/admin', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.body, /Konfiguration/);
  assert.match(page.body, /Angemeldet als <b>Chefin<\/b> \(Passwort\)/);
  assert.match(page.body, /⚠<\/td><th>Alter Admin-Token<\/th>/);

  const post = (body, headers = {}) => request('POST', '/admin/mail', { body, headers: { Cookie: cookie, ...headers } });
  assert.equal((await post('action=probe')).status, 403, 'no CSRF token');
  assert.equal((await post(`action=probe&csrf=${'0'.repeat(64)}`)).status, 403, 'a wrong CSRF token');
  assert.equal((await post(`action=probe&csrf=${csrf}`, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'cross-site form');
  const probe = await post(`action=probe&csrf=${csrf}`);
  assert.equal(probe.status, 200);
  assert.match(probe.body, /Kein SMTP-Server konfiguriert/);

  await waitForLog(out, /\[config\] Konfiguration:/);
  assert.match(out.log, /\[admin\] WARNUNG: PIKDAME_ADMIN_TOKEN wird ignoriert/, 'the old token is a clear warning, not a crash');
  assert.match(out.log, /⚠ Alter Admin-Token/);
  assert.match(out.log, /✓ Admin-Bereich +\/admin für 1 Admin-Konto/);
  assert.ok(!out.log.includes('old-plain-token'), 'the old value is never logged');
});

test('config report: values on hover for plain settings, never for secrets', () => {
  const env = {
    PIKDAME_SMTP_HOST: 'smtp.example.com', PIKDAME_SMTP_PORT: '587', PIKDAME_SMTP_USER: 'postmaster@example.org',
    PIKDAME_SMTP_PASS: 'TOPSECRET', PIKDAME_ADMIN_TOKEN: 'ADMINSECRET', PIKDAME_DATABASE_PASSWORD_FILE: '/run/secrets/db',
    PIKDAME_DATABASE_URL: 'postgres://pikdame:DBSECRET@postgres:5432/pikdame', PIKDAME_BASE_URL: 'https://play.example.com',
    PIKDAME_ADMINS: 'chefin@example.org',
  };
  const r = buildConfigReport(env, FACTS);
  const varOf = (id, name) => byId(r, id).vars.find((x) => x.name === name);
  assert.equal(varOf('mail', 'PIKDAME_SMTP_HOST').value, 'smtp.example.com');
  assert.equal(varOf('mail', 'PIKDAME_SMTP_USER').value, 'postmaster@example.org');
  assert.equal(varOf('mail', 'PIKDAME_SMTP_PASS').value, undefined);
  assert.equal(varOf('mail', 'PIKDAME_SMTP_PASS').secret, true);
  assert.equal(varOf('adminToken', 'PIKDAME_ADMIN_TOKEN').value, undefined);
  assert.equal(varOf('admin', 'PIKDAME_ADMINS').value, 'chefin@example.org');
  assert.equal(varOf('database', 'PIKDAME_DATABASE_PASSWORD_FILE').value, '/run/secrets/db', 'the path is shown, not the file');
  assert.equal(varOf('database', 'PIKDAME_DATABASE_URL').value, 'postgres://pikdame:***@postgres:5432/pikdame');
  const html = AdminPage.renderAdminPage({ report: r, csrf: 'c', mailConfigured: true });
  assert.match(html, /data-tip="smtp\.example\.com"/);
  assert.match(html, /data-tip="geheim - Wert wird nicht angezeigt"/);
  for (const secret of ['TOPSECRET', 'ADMINSECRET', 'DBSECRET']) assert.ok(!html.includes(secret), `${secret} leaked into the page`);
});

const IMPRINT_ENV = {
  PIKDAME_IMPRINT_NAME: 'Max Muster', PIKDAME_IMPRINT_STREET: 'Musterstraße 1',
  PIKDAME_IMPRINT_CITY: '12345 Musterstadt', PIKDAME_IMPRINT_EMAIL: 'impressum@example.org',
};

test('config report: a missing imprint variable warns and is named', () => {
  assert.equal(byId(buildConfigReport(IMPRINT_ENV, FACTS), 'imprint').status, 'ok');
  const r = byId(buildConfigReport({ ...IMPRINT_ENV, PIKDAME_IMPRINT_CITY: '' }, FACTS), 'imprint');
  assert.equal(r.status, 'warn');
  assert.deepEqual(r.missing, ['PIKDAME_IMPRINT_CITY']);
});

test('/impressum.html is rendered from the environment and revalidates by content', async (t) => {
  await startServer(t, IMPRINT_ENV);
  await waitForServer();
  const page = await request('GET', '/impressum.html');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-cache');
  assert.ok(!page.body.includes('{{IMPRINT_'), 'placeholders filled');
  assert.ok(!page.body.includes('Musterstraße') && !page.body.includes('impressum@example.org'), 'no plain text');
  assert.match(page.body, /id="providerBlock" data-imprint="[A-Za-z0-9+/=]+"/);
  const again = await request('GET', '/impressum.html', { headers: { 'If-None-Match': page.headers.etag } });
  assert.equal(again.status, 304);
});
