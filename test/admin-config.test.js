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

const byId = (report, id) => report.find((i) => i.id === id);
const FACTS = { dataDir: '/data', dataDirWritable: true, accountsEnabled: true, accountsBackend: 'sqlite', onnxActive: false, adminEnabled: false };

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

test('admin page helpers: basic auth, CSRF and recipient checks', () => {
  const b64 = (s) => 'Basic ' + Buffer.from(s).toString('base64');
  assert.equal(AdminPage.checkBasicAuth(b64('admin:tok'), 'tok'), true);
  assert.equal(AdminPage.checkBasicAuth(b64('anyone:tok'), 'tok'), true, 'user name is ignored');
  assert.equal(AdminPage.checkBasicAuth(b64('admin:wrong'), 'tok'), false);
  assert.equal(AdminPage.checkBasicAuth(undefined, 'tok'), false);
  assert.equal(AdminPage.checkBasicAuth(b64('admin:'), ''), false, 'no token = no login');
  const csrf = AdminPage.csrfToken('tok');
  assert.equal(AdminPage.csrfValid(csrf, 'tok'), true);
  assert.equal(AdminPage.csrfValid(csrf, 'other'), false);
  assert.equal(AdminPage.csrfValid(null, 'tok'), false);
  assert.equal(AdminPage.validRecipient('a@b.de'), true);
  assert.equal(AdminPage.validRecipient('a@b.de\r\nRCPT TO:<x@y.de>'), false, 'no SMTP injection');
  assert.equal(AdminPage.validRecipient('nope'), false);
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
  t.after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return out;
}

test('/admin without a token answers 404 like any unknown path', async (t) => {
  startServer(t, 8096, {});
  await waitForServer();
  assert.equal((await request('GET', '/admin', { auth: 'admin:' })).status, 404);
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
