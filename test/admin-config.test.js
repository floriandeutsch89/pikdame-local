// Config report (startup log + /admin) and the read-only admin page.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { buildConfigReport, formatConfigReport } = require('../game/ConfigReport');
const AdminPage = require('../game/AdminPage');
const { createAdminTokenVerifier, hashAdminToken, parsePhc, hasArgon2 } = require('../game/AdminToken');

const byId = (report, id) => report.find((i) => i.id === id);
const FACTS = { dataDir: '/data', dataDirWritable: true, accountsEnabled: true, accountsBackend: 'sqlite', onnxActive: false, adminMode: 'off' };

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
  assert.equal(byId(buildConfigReport({ PIKDAME_ONNX: '1' }, FACTS), 'onnx').status, 'error');
});

test('config report: secret values never appear, problems are logged first', () => {
  const env = { PIKDAME_SMTP_HOST: 'h', PIKDAME_SMTP_USER: 'u', PIKDAME_SMTP_PASS: 'TOPSECRET', PIKDAME_DATABASE_URL: 'postgres://u:DBSECRET@db/x' };
  const text = JSON.stringify(buildConfigReport(env, FACTS)) + formatConfigReport(buildConfigReport(env, FACTS)).join('\n');
  assert.ok(!text.includes('TOPSECRET') && !text.includes('DBSECRET'));
  const lines = formatConfigReport(buildConfigReport({}, { ...FACTS, dataDirWritable: false }));
  assert.match(lines[1], /✗ Datenverzeichnis/, 'errors sort to the top');
});

test('admin page helpers: basic auth parsing, CSRF and recipient checks', () => {
  const b64 = (x) => 'Basic ' + Buffer.from(x).toString('base64');
  assert.equal(AdminPage.basicPassword(b64('admin:tok:with:colons')), 'tok:with:colons');
  assert.equal(AdminPage.basicPassword(b64('nocolon')), null);
  assert.equal(AdminPage.basicPassword('Bearer x'), null);
  assert.equal(AdminPage.basicPassword(undefined), null);
  const csrf = AdminPage.csrfToken('tok');
  assert.equal(AdminPage.csrfValid(csrf, 'tok'), true);
  assert.equal(AdminPage.csrfValid(csrf, 'other'), false);
  assert.equal(AdminPage.csrfValid(null, 'tok'), false);
  assert.equal(AdminPage.validRecipient('a@b.de'), true);
  assert.equal(AdminPage.validRecipient('a@b.de\r\nRCPT TO:<x@y.de>'), false, 'no SMTP injection');
  assert.equal(AdminPage.validRecipient('nope'), false);
});

test('admin token: Argon2id hash round trip, plain token, invalid hash', { skip: !hasArgon2() && 'Node without crypto.argon2' }, async () => {
  const hash = await hashAdminToken('a-long-admin-password');
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.ok(parsePhc(hash));
  const argon = createAdminTokenVerifier(hash);
  assert.equal(argon.mode, 'argon2');
  assert.equal(await argon.verify('wrong-password'), 'fail');
  assert.equal(await argon.verify('a-long-admin-password'), 'ok');
  assert.equal(await argon.verify('a-long-admin-password'), 'ok', 'cached fast path');
  assert.equal(await argon.verify('wrong-password'), 'fail', 'cache does not widen access');

  const plain = createAdminTokenVerifier('plain-token');
  assert.equal(plain.mode, 'plain');
  assert.equal(await plain.verify('plain-token'), 'ok');
  assert.equal(await plain.verify('x'), 'fail');

  assert.equal(createAdminTokenVerifier('').mode, 'off');
  assert.equal(createAdminTokenVerifier('$argon2id$v=19$m=19456,t=2,p=1$cut').mode, 'invalid', 'truncated by $-interpolation');
  assert.equal(createAdminTokenVerifier(hash.replace('m=19456', 'm=99999999')).mode, 'invalid', 'absurd memory cost refused');
});

test('admin token: at most two Argon2 checks at once', { skip: !hasArgon2() && 'Node without crypto.argon2' }, async () => {
  const verifier = createAdminTokenVerifier(await hashAdminToken('a-long-admin-password'));
  const results = await Promise.all([1, 2, 3, 4].map((n) => verifier.verify(`wrong-${n}`)));
  assert.ok(results.includes('busy'), 'excess checks are turned away, not queued');
  assert.equal(results.filter((r) => r === 'fail').length, 2);
});

test('config report: every entry names its variables, secrets by _FILE when used', () => {
  const r = buildConfigReport({ PIKDAME_SMTP_HOST: 'h', PIKDAME_SMTP_PASS_FILE: '/run/secrets/smtp', PIKDAME_BASE_URL: 'https://x.de' }, FACTS);
  const names = (id) => byId(r, id).vars.map((x) => `${x.name}:${x.set}`);
  assert.ok(names('mail').includes('PIKDAME_SMTP_PASS_FILE:true'));
  assert.ok(names('mail').includes('PIKDAME_SMTP_HOST:true'));
  assert.ok(names('mail').includes('PIKDAME_SMTP_PORT:false'));
  assert.deepEqual(names('baseUrl'), ['PIKDAME_BASE_URL:true']);
  for (const item of r) assert.ok(item.vars.length > 0, `${item.id} lists its variables`);
});

test('config report: admin token modes', () => {
  const mode = (m) => byId(buildConfigReport({}, { ...FACTS, adminMode: m }), 'admin').status;
  assert.equal(mode('argon2'), 'ok');
  assert.equal(mode('plain'), 'warn');
  assert.equal(mode('invalid'), 'error');
  assert.equal(mode('unsupported'), 'error');
  assert.equal(mode('off'), 'off');
});

test('admin page escapes report text', () => {
  const html = AdminPage.renderAdminPage({
    report: [{ id: 'x', label: '<b>', status: 'warn', detail: '<script>alert(1)</script>', missing: ['A<'] }],
    runtime: { version: '1', uptimeSeconds: 5, sessions: 0, connectedPlayers: 0, rssMb: 1, node: 'v' },
    smtpProbe: null, notice: { ok: false, text: '<img>' }, csrf: 'c', mailConfigured: false,
  });
  assert.ok(!html.includes('<script>alert') && !html.includes('<img>') && !html.includes('A<<'));
});

// --- Real server: the wiring between HTTP and the helpers -------------------
let PORT = 8095;
function request(method, urlPath, { auth, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (auth) h.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');
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

function startServer(t, port, extraEnv) {
  PORT = port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-admin-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ADMIN_TOKEN: '', PIKDAME_SMTP_HOST: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { log: '' };
  server.stdout.on('data', (c) => { out.log += c; });
  // Wait for exit: the server writes its snapshot into dataDir on SIGTERM (ENOTEMPTY race).
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return out;
}

test('/admin without a token answers 404 like any unknown path', async (t) => {
  startServer(t, 8096, {});
  await waitForServer();
  assert.equal((await request('GET', '/admin', { auth: 'admin:' })).status, 404);
  assert.equal((await request('GET', '/admin/', { auth: 'admin:' })).status, 404, 'disabled: no redirect that would reveal the page');
});

test('/admin with a token: Basic auth, CSRF, mail check', async (t) => {
  const out = startServer(t, 8095, { PIKDAME_ADMIN_TOKEN: 'test-token' });
  await waitForServer();

  assert.equal((await request('GET', '/admin')).status, 401);
  assert.equal((await request('GET', '/admin', { auth: 'admin:wrong' })).status, 401);
  const page = await request('GET', '/admin', { auth: 'admin:test-token' });
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.body, /Konfiguration/);
  const csrf = (page.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf);

  assert.equal((await request('POST', '/admin/mail', { auth: 'admin:test-token', body: 'action=probe' })).status, 403, 'no CSRF token');
  assert.equal((await request('POST', '/admin/mail', {
    auth: 'admin:test-token', body: `action=probe&csrf=${csrf}`, headers: { 'Sec-Fetch-Site': 'cross-site' },
  })).status, 403, 'cross-site form');
  const probe = await request('POST', '/admin/mail', { auth: 'admin:test-token', body: `action=probe&csrf=${csrf}` });
  assert.equal(probe.status, 200);
  assert.match(probe.body, /Kein SMTP-Server konfiguriert/);

  assert.match(out.log, /\[config\] Konfiguration:/, 'startup report is logged');
});

test('config report: values on hover for plain settings, never for secrets', () => {
  const env = {
    PIKDAME_SMTP_HOST: 'smtp.example.com', PIKDAME_SMTP_PORT: '587', PIKDAME_SMTP_USER: 'postmaster@example.org',
    PIKDAME_SMTP_PASS: 'TOPSECRET', PIKDAME_ADMIN_TOKEN: 'ADMINSECRET', PIKDAME_DATABASE_PASSWORD_FILE: '/run/secrets/db',
    PIKDAME_DATABASE_URL: 'postgres://pikdame:DBSECRET@postgres:5432/pikdame', PIKDAME_BASE_URL: 'https://play.example.com',
  };
  const r = buildConfigReport(env, { ...FACTS, adminMode: 'plain' });
  const varOf = (id, name) => byId(r, id).vars.find((x) => x.name === name);
  assert.equal(varOf('mail', 'PIKDAME_SMTP_HOST').value, 'smtp.example.com');
  assert.equal(varOf('mail', 'PIKDAME_SMTP_USER').value, 'postmaster@example.org');
  assert.equal(varOf('mail', 'PIKDAME_SMTP_PASS').value, undefined);
  assert.equal(varOf('mail', 'PIKDAME_SMTP_PASS').secret, true);
  assert.equal(varOf('admin', 'PIKDAME_ADMIN_TOKEN').value, undefined);
  assert.equal(varOf('database', 'PIKDAME_DATABASE_PASSWORD_FILE').value, '/run/secrets/db', 'the path is shown, not the file');
  assert.equal(varOf('database', 'PIKDAME_DATABASE_URL').value, 'postgres://pikdame:***@postgres:5432/pikdame');
  const html = AdminPage.renderAdminPage({ report: r, csrf: 'c', mailConfigured: true });
  assert.match(html, /data-tip="smtp\.example\.com"/);
  assert.match(html, /data-tip="geheim - Wert wird nicht angezeigt"/);
  for (const secret of ['TOPSECRET', 'ADMINSECRET', 'DBSECRET']) assert.ok(!html.includes(secret), `${secret} leaked into the page`);
});
