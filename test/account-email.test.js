// The account's own e-mail address: /api/me gives it (and whether it is confirmed) to
// that account alone; the account sheet shows it under the name, always as text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const WebSocket = require('ws');
const { JSDOM, VirtualConsole } = require('jsdom');
const { freePort } = require('./helpers/free-port');
const { testDatabaseUrl } = require('./helpers/test-db');
const { call } = require('./helpers/admin-session');
const { createPgAccountStore } = require('../game/PgAccountStore');

// --- Server: /api/me -----------------------------------------------------------

async function startServer(t, databaseUrl) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-account-email-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_DATABASE_URL: databaseUrl,
      PIKDAME_SMTP_HOST: '', PIKDAME_ADMINS: '', PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c; });
  server.stderr.on('data', (c) => { log += c; });
  const closed = new Promise((r) => server.once('close', r)); // after the last log line
  const stop = async () => { if (server.exitCode === null) server.kill(); await closed; };
  t.after(async () => { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (let i = 0; ; i++) {
    try { if ((await call(port, 'GET', '/healthz')).status === 200) break; } catch (e) { /* booting */ }
    if (i > 150) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, stop, log: () => log };
}

/** Every raw message the server sends until `done(parsed)` holds. */
function wsUntil(t, port, messages, done) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const raw = [];
    t.after(() => ws.close());
    const timer = setTimeout(() => reject(new Error(`timed out; got ${raw.map((m) => JSON.parse(m).type)}`)), 8000);
    ws.on('message', (m) => {
      raw.push(String(m));
      if (done(JSON.parse(m), raw)) { clearTimeout(timer); resolve(raw); }
    });
    ws.once('open', () => messages.forEach((m) => ws.send(JSON.stringify(m))));
    ws.once('error', reject);
  });
}

test('/api/me gives the own address and its state to that account only; without a sign-in 401 as before', async (t) => {
  const url = testDatabaseUrl('acc_email');
  const store = createPgAccountStore(url);
  let flo;
  let anna;
  try {
    const r = await store.register('Florian', 'Flo.Mail@Example.org', 'geheim123');
    assert.ok(r.ok, r.error);
    await store.verifyEmail(r.verifyToken);
    flo = (await store.login('Florian', 'geheim123')).token;
    const p = await store.registerWithoutPassword('Anna', 'anna@example.org');
    anna = (await store.verifyCodeAndSignIn('anna@example.org', p.code)).token;
    assert.ok(flo && anna, 'both signed in');
  } finally {
    await store.close();
  }
  const srv = await startServer(t, url);
  const me = (body) => call(srv.port, 'POST', '/api/me', { json: body });

  const mine = await me({ token: flo });
  assert.strictEqual(mine.status, 200);
  assert.strictEqual(mine.json.username, 'Florian');
  assert.strictEqual(mine.json.email, 'Flo.Mail@Example.org', 'as typed at sign-up');
  assert.strictEqual(mine.json.emailVerified, true);
  const hers = await me({ token: anna });
  assert.deepStrictEqual([hers.json.username, hers.json.email, hers.json.emailVerified], ['Anna', 'anna@example.org', true],
    "each sign-in gets its own address, never another account's");

  // The database's word, not a constant: an address that is no longer confirmed says so.
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("UPDATE users SET email_verified = FALSE WHERE username = 'Anna'");
  } finally {
    await pool.end();
  }
  assert.strictEqual((await me({ token: anna })).json.emailVerified, false);

  for (const body of [{}, { token: '' }, { token: 'not-a-session' }]) {
    const r = await me(body);
    assert.strictEqual(r.status, 401, JSON.stringify(body));
    assert.deepStrictEqual(r.json, { error: 'Nicht angemeldet.' }, 'unchanged, and no address');
  }

  // Nowhere else: the season ladder (its "me" part too), the profiles, the own seat at a table.
  const ladder = await call(srv.port, 'POST', '/api/ladder', { json: { token: flo } });
  assert.strictEqual(ladder.status, 200);
  const frames = await wsUntil(t, srv.port, [
    { type: 'listProfiles', name: 'Florian' },
    { type: 'createSession', name: 'Florian', accountToken: flo },
  ], (m, raw) => m.type === 'state' && raw.some((x) => JSON.parse(x).type === 'profiles'));
  for (const text of [ladder.body, ...frames]) assert.ok(!text.includes('@'), text.slice(0, 300));

  await srv.stop();
  assert.ok(!/flo\.mail@example\.org|anna@example\.org/i.test(srv.log()), 'never in the log');
});

// --- Client: the line under the name (the real markup and client in jsdom) -------

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot({ me = {}, signedIn = true, lang = null, api = {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  const answer = (url) => {
    if (url === '/statusz') return { accountsEnabled: true };
    if (url === '/api/me') return { ok: true, username: 'Flo', ...me };
    return api[url] || { ok: true };
  };
  window.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(answer(url)), text: () => Promise.resolve('') });
  window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };
  window.WebSocket.OPEN = 1;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Flo');
  if (signedIn) window.localStorage.setItem('pikdame_account_token', 'tok');
  if (lang) window.localStorage.setItem('pikdame_lang', lang);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  return {
    window, doc, settle, errors,
    line: () => doc.getElementById('accountEmail'),
    addr: () => doc.getElementById('accEmailAddr'),
    status: () => doc.querySelector('#accEmailState > span').textContent,
    icon: () => doc.querySelector('#accEmailState use').getAttribute('href'),
  };
}

const shown = (c) => !c.line().classList.contains('hidden');

test('account sheet: the own address under the name, confirmed, in both languages; gone on sign-out', async () => {
  const c = boot({ me: { email: 'flo@example.org', emailVerified: true } });
  await c.settle();
  assert.ok(shown(c));
  assert.strictEqual(c.doc.getElementById('accountWhoami').nextElementSibling, c.line(), 'right under "Angemeldet als …"');
  assert.strictEqual(c.addr().textContent, 'flo@example.org');
  assert.strictEqual(c.addr().title, 'flo@example.org', 'the whole address where "…" cuts it off');
  assert.strictEqual(c.status(), 'bestätigt');
  assert.strictEqual(c.icon(), '#i-check', 'a sprite icon, the label in its own span');
  assert.strictEqual(c.line().classList.contains('unconfirmed'), false);
  c.doc.getElementById('langBtn').click();
  assert.strictEqual(c.status(), 'confirmed');
  assert.strictEqual(c.addr().textContent, 'flo@example.org');
  for (const s of [c.window.localStorage, c.window.sessionStorage]) {
    for (let i = 0; i < s.length; i++) assert.ok(!String(s.getItem(s.key(i))).includes('flo@example.org'), `never stored (${s.key(i)})`);
  }
  c.doc.getElementById('accLogoutBtn').click();
  await c.settle();
  assert.strictEqual(shown(c), false);
  assert.strictEqual(c.addr().textContent, '', 'not left in the page either');
  assert.strictEqual(c.addr().hasAttribute('title'), false);
  assert.deepStrictEqual(c.errors, []);
  c.window.close();
});

test('account sheet: a not confirmed address says so (DE/EN)', async () => {
  for (const [lang, text] of [[null, 'nicht bestätigt'], ['en', 'not confirmed']]) {
    const c = boot({ lang, me: { email: 'anna@example.org', emailVerified: false } });
    await c.settle();
    assert.ok(shown(c));
    assert.strictEqual(c.status(), text);
    assert.strictEqual(c.icon(), '#i-alert', 'meaning by shape and word, not colour alone');
    assert.ok(c.line().classList.contains('unconfirmed'));
    c.window.close();
  }
});

test('account sheet: the address is text, never markup', async () => {
  const evil = '"><img src=x onerror="window.pwned=1"><b>x</b>@example.org';
  const c = boot({ me: { email: evil, emailVerified: true } });
  await c.settle();
  assert.strictEqual(c.addr().textContent, evil);
  assert.strictEqual(c.addr().title, evil);
  assert.strictEqual(c.line().querySelector('img, b'), null);
  assert.strictEqual(c.window.pwned, undefined);
  c.window.close();
});

test('account sheet: no line for guests or without an address; after a sign-in it follows /api/me', async () => {
  for (const c of [boot({ me: {} }), boot({ signedIn: false, me: { email: 'flo@example.org', emailVerified: true } })]) {
    await c.settle();
    assert.strictEqual(shown(c), false);
    c.window.close();
  }
  // Sign-in answers carry no address; the /api/me right after does.
  const c = boot({ signedIn: false, me: { email: 'flo@example.org', emailVerified: true }, api: { '/api/login': { ok: true, token: 't2', username: 'Flo' } } });
  await c.settle();
  c.doc.getElementById('accLoginUser').value = 'Flo';
  c.doc.getElementById('accLoginPass').value = 'geheim123';
  c.doc.getElementById('accountLoginForm').dispatchEvent(new c.window.Event('submit', { cancelable: true }));
  await c.settle();
  assert.ok(shown(c));
  assert.strictEqual(c.addr().textContent, 'flo@example.org');
  assert.deepStrictEqual(c.errors, []);
  c.window.close();
});

test('account sheet: source contract of the line (jsdom has no style.css)', () => {
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  const rule = (cls) => (css.match(new RegExp(`\\n\\.${cls} \\{([^}]*)\\}`)) || [])[1] || '';
  for (const decl of ['min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap']) {
    assert.ok(rule('accEmailAddr').includes(decl), `.accEmailAddr: ${decl} (one line, a long address ends in "…")`);
  }
  assert.match(rule('accEmailState'), /flex: none/, 'the status never shrinks away');
  // Right after confirming, the setup block's "E-Mail bestätigt" would repeat the line.
  assert.match(css, /\.accountEmail:not\(\.hidden\) ~ \.accountSetup \.setupDone \{ display: none; \}/);
  const doc = new JSDOM(html).window.document;
  assert.ok(doc.querySelector('#accountEmail ~ #accountSetup .setupDone'), 'the sibling order that rule needs');
});
