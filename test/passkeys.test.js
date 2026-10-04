// Passkeys end to end against a real server, with a software authenticator:
// real P-256 keys and signatures, encoded as the WebAuthn spec says - the
// same bytes a phone or a password manager would send. Plus the e-mail
// login link and the split account rate limit.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { relyingParty, deviceName, createPasskeyService } = require('../game/Passkeys');

let HAS_LIB = true;
try { require('@simplewebauthn/server'); } catch (e) { HAS_LIB = false; }
let HAS_SQLITE = true;
try { require('node:sqlite'); } catch (e) { HAS_SQLITE = false; }

test('relying party: https or localhost only, never a bare IP', () => {
  assert.deepEqual(relyingParty('https://play.pikdame.online'), { rpID: 'play.pikdame.online', origin: 'https://play.pikdame.online' });
  assert.deepEqual(relyingParty('http://localhost:8080'), { rpID: 'localhost', origin: 'http://localhost:8080' });
  assert.equal(relyingParty('http://play.pikdame.online'), null, 'plain http on a real domain');
  assert.equal(relyingParty('https://192.168.1.5'), null, 'IP addresses are no RP ID');
  assert.equal(relyingParty(''), null);
  assert.equal(relyingParty('not a url'), null);
});

test('passkey service switches itself off without library or origin', () => {
  assert.equal(createPasskeyService({ baseUrl: 'https://x.de', lib: null }), null);
  assert.equal(createPasskeyService({ baseUrl: '', lib: {} }), null);
});

test('device name for a new passkey', () => {
  const d = new Date(Date.UTC(2026, 9, 5, 12));
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', d), 'iPhone · 05.10.2026');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', d), 'Windows · 05.10.2026');
  assert.equal(deviceName('', d), 'Gerät · 05.10.2026');
});

// --- A minimal CBOR encoder (maps, ints, byte and text strings) -------------
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
  if (v instanceof Map) {
    const parts = [cborHead(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  throw new Error('unsupported');
}

/** One authenticator holding one P-256 passkey. */
function softAuthenticator(origin, rpID) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  let signCount = 0;
  let userHandle = null;
  const rpIdHash = crypto.createHash('sha256').update(rpID).digest();
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const clientData = (type, challenge, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
  return {
    id: b64u(credId),
    create(options, { origin: o } = {}) {
      userHandle = options.user.id;
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cose]);
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData('webauthn.create', options.challenge, o)), attestationObject: b64u(attestationObject), transports: ['internal'] },
      };
    },
    get(options, { origin: o } = {}) {
      signCount += 1;
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(signCount);
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), cnt]);
      const cd = clientData('webauthn.get', options.challenge, o);
      const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(cd).digest()]), privateKey);
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature), userHandle },
      };
    },
  };
}

let PORT = 8098;
let ORIGIN = `http://localhost:${PORT}`;
const PG_URL = process.env.PIKDAME_TEST_PG_URL || '';
// The server trusts X-Forwarded-For here, so each phase of the journey can
// act as its own client and the strict per-IP limit (20 per 10 min) only
// bites where the test means it to.
let CLIENT_IP = '10.0.0.1';
function post(urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Forwarded-For': CLIENT_IP, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* html */ } resolve({ status: res.statusCode, json, body: data }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const get = (urlPath) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: urlPath }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

test('AccountStore (SQLite): sign-up code renews, admin resend knows password-less accounts', { skip: !HAS_SQLITE }, () => {
  const { createAccountStore } = require('../game/AccountStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-code-'));
  const store = createAccountStore(path.join(dir, 'users.db'));
  try {
    const r = store.registerWithoutPassword('Oma Inge', 'inge@example.org');
    assert.match(r.code, /^\d{6}$/);
    assert.equal(store.renewVerification('Oma Inge').passwordless, true, 'admin resend sends code + link');
    const fresh = store.renewSignupCode('INGE@example.org');
    assert.match(fresh.code, /^\d{6}$/);
    if (fresh.code !== r.code) assert.match(store.verifyCodeAndSignIn('inge@example.org', r.code).error, /stimmt nicht/, 'old code is gone');
    const ok = store.verifyCodeAndSignIn('inge@example.org', fresh.code);
    assert.equal(ok.username, 'Oma Inge');
    assert.ok(store.sessionUser(ok.token));
    assert.equal(store.renewSignupCode('inge@example.org'), null, 'no codes for a confirmed account');
    assert.match(store.verifyCodeAndSignIn('inge@example.org', fresh.code).error, /stimmt nicht/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The same journey on both account backends: SQLite (fallback) and
// PostgreSQL (the production stack; CI provides it).
test('server (SQLite): e-mail-first sign-up (code + link), passkey, sign-in, manage, login link', { skip: (!HAS_LIB || !HAS_SQLITE) && 'needs @simplewebauthn/server and node:sqlite' },
  (t) => journey(t, 8098, '', 'Oma Inge', 'inge@example.org'));
test('server (PostgreSQL): e-mail-first sign-up (code + link), passkey, sign-in, manage, login link', { skip: (!HAS_LIB || !PG_URL) && 'needs @simplewebauthn/server and PIKDAME_TEST_PG_URL' },
  (t) => journey(t, 8099, PG_URL, `Opa ${Date.now() % 100000}`, `opa${Date.now() % 100000}@example.org`));

async function journey(t, port, databaseUrl, NAME, MAIL) {
  PORT = port;
  ORIGIN = `http://localhost:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-passkeys-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_BASE_URL: ORIGIN, PIKDAME_SMTP_HOST: '', PIKDAME_DATABASE_URL: databaseUrl, PIKDAME_ADMIN_TOKEN: '', PIKDAME_TRUST_PROXY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c; });
  // Wait for exit: the server writes its snapshot into dataDir on SIGTERM (ENOTEMPTY race).
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; ; i++) {
    try { if ((await get('/healthz')) === 200) break; } catch (e) { /* booting */ }
    if (i > 150) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }
  const lastFromLog = async (re) => {
    for (let i = 0; i < 50; i++) {
      const all = [...log.matchAll(re)];
      if (all.length) return all[all.length - 1][1];
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`nothing in the log for ${re}`);
  };
  const auth = softAuthenticator(ORIGIN, 'localhost');
  const ua = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' };

  // Sign up, e-mail first: name + address only - no password, no passkey.
  CLIENT_IP = '10.0.0.1';
  const reg = await post('/api/register-passwordless', { username: NAME, email: MAIL });
  assert.equal(reg.status, 200, reg.body);
  assert.match(log, new RegExp(`Registrierung: ${NAME}`));
  // The name is taken now, by name and by e-mail.
  assert.equal((await post('/api/register-passwordless', { username: NAME.toLowerCase(), email: 'x@example.org' })).status, 400);
  assert.equal((await post('/api/register-passwordless', { username: 'Someone Else', email: MAIL.toUpperCase() })).status, 400);
  // A password-less account has no password to guess.
  assert.equal((await post('/api/login', { username: NAME, password: '' })).status, 401);

  // The code from the mail: every attempt counts, five per code.
  const code1 = await lastFromLog(/Bestätigungscode (\d{6})/g);
  const wrong = (c) => (c === '000000' ? '111111' : '000000');
  let v = await post('/api/verify-code', { email: MAIL, code: wrong(code1) });
  assert.equal(v.status, 400);
  assert.match(v.json.error, /stimmt nicht/);
  for (let i = 0; i < 4; i++) await post('/api/verify-code', { email: MAIL, code: wrong(code1) });
  v = await post('/api/verify-code', { email: MAIL, code: code1 });
  assert.equal(v.status, 400, 'the right code after five wrong ones is too late');
  assert.match(v.json.error, /abgelaufen/);
  // A new code replaces the old one (and the old link); the answer is the
  // same for an address without a pending sign-up.
  CLIENT_IP = '10.0.0.2';
  const linkBefore = await lastFromLog(/\?verify=([a-f0-9]{64})/g);
  assert.deepEqual((await post('/api/verify-code/resend', { email: 'nobody@example.org' })).json, { ok: true });
  assert.deepEqual((await post('/api/verify-code/resend', { email: MAIL })).json, { ok: true });
  const code2 = await lastFromLog(/Bestätigungscode (\d{6})/g);
  assert.equal((await post('/api/verify-signin', { token: linkBefore })).status, 400, 'the old link died with the old code');
  // The right code confirms AND signs in - no sign-in method exists yet.
  v = await post('/api/verify-code', { email: MAIL, code: code2 });
  assert.equal(v.status, 200, v.body);
  assert.equal(v.json.username, NAME);
  let token = v.json.token;
  assert.equal((await post('/api/verify-code', { email: MAIL, code: code2 })).status, 400, 'single use');
  let m = await post('/api/account/methods', { token });
  assert.deepEqual([m.json.hasPassword, m.json.passkeys.length], [false, 0]);

  // Now the passkey, on the device that signed up.
  let ao = await post('/api/passkey/add/options', { token });
  assert.equal(ao.json.options.rp.id, 'localhost');
  assert.equal(ao.json.options.authenticatorSelection.residentKey, 'required');
  const evil = await post('/api/passkey/add/verify', { token, flowId: ao.json.flowId, response: auth.create(ao.json.options, { origin: 'https://evil.example' }) });
  assert.equal(evil.status, 400, 'foreign origin');
  assert.equal((await post('/api/passkey/add/verify', { token, flowId: ao.json.flowId, response: auth.create(ao.json.options) })).status, 400, 'flow is single use');
  ao = await post('/api/passkey/add/options', { token });
  assert.equal((await post('/api/passkey/add/verify', { token, flowId: ao.json.flowId, response: auth.create(ao.json.options) }, ua)).status, 200);

  // Sign in with the passkey - no username needed (discoverable).
  CLIENT_IP = '10.0.0.3';
  let lo = await post('/api/passkey/login/options', {});
  assert.deepEqual(lo.json.options.allowCredentials || [], []);
  let li = await post('/api/passkey/login/verify', { flowId: lo.json.flowId, response: auth.get(lo.json.options) });
  assert.equal(li.status, 200, li.body);
  assert.equal(li.json.username, NAME);
  token = li.json.token;
  assert.equal((await post('/api/me', { token })).json.username, NAME);
  // A passkey nobody registered gets nowhere.
  const stranger = softAuthenticator(ORIGIN, 'localhost');
  stranger.create({ user: { id: 'eA' }, challenge: 'eA' });
  lo = await post('/api/passkey/login/options', {});
  assert.equal((await post('/api/passkey/login/verify', { flowId: lo.json.flowId, response: stranger.get(lo.json.options) })).status, 401);

  // Methods: one passkey named after the device, no password.
  m = await post('/api/account/methods', { token });
  assert.equal(m.json.hasPassword, false);
  assert.equal(m.json.passkeys.length, 1);
  assert.match(m.json.passkeys[0].name, /^iPhone · /);
  assert.ok(m.json.passkeys[0].lastUsedAt, 'last use recorded');
  assert.equal((await post('/api/passkey/delete', { token, id: auth.id })).status, 400, 'last way in stays');
  assert.equal((await post('/api/password/remove', { token })).status, 200, 'removing a password that is not there is harmless');

  // A second passkey; then the first can go.
  CLIENT_IP = '10.0.0.4';
  const second = softAuthenticator(ORIGIN, 'localhost');
  ao = await post('/api/passkey/add/options', { token });
  assert.deepEqual(ao.json.options.excludeCredentials.map((c) => c.id), [auth.id], 'the existing one is excluded');
  assert.equal((await post('/api/passkey/add/verify', { token, flowId: ao.json.flowId, response: second.create(ao.json.options) })).status, 200);
  assert.equal((await post('/api/passkey/delete', { token, id: auth.id })).status, 200);
  lo = await post('/api/passkey/login/options', {});
  assert.equal((await post('/api/passkey/login/verify', { flowId: lo.json.flowId, response: auth.get(lo.json.options) })).status, 401, 'removed passkey no longer works');

  // Password on top, then password login.
  assert.equal((await post('/api/password/set', { token, password: 'short' })).status, 400);
  assert.equal((await post('/api/password/set', { token, password: 'long-password-7' })).status, 200);
  assert.equal((await post('/api/login', { username: MAIL, password: 'long-password-7' })).status, 200);

  // E-mail login link: neutral answer, single use.
  CLIENT_IP = '10.0.0.5';
  const unknown = await post('/api/login-link', { usernameOrEmail: 'nobody@example.org' });
  const known = await post('/api/login-link', { usernameOrEmail: NAME });
  assert.deepEqual(unknown.json, known.json, 'no account enumeration');
  const linkToken = await lastFromLog(/\?login=([a-f0-9]{64})/g);
  const c1 = await post('/api/login-link/consume', { token: linkToken });
  assert.equal(c1.status, 200);
  assert.equal(c1.json.username, NAME);
  assert.equal((await post('/api/login-link/consume', { token: linkToken })).status, 401, 'single use');

  // Not signed in = no management.
  assert.equal((await post('/api/account/methods', { token: 'nope' })).status, 401);
  assert.equal((await post('/api/passkey/add/options', { token: 'nope' })).status, 401);

  // The link from the sign-up mail confirms and signs in, too (second account).
  const OTHER = `${NAME} Zwei`.slice(0, 24);
  const otherMail = MAIL.replace('@', '.zwei@');
  assert.equal((await post('/api/register-passwordless', { username: OTHER, email: otherMail })).status, 200);
  const setupLink = await lastFromLog(/\?verify=([a-f0-9]{64})/g);
  const vs = await post('/api/verify-signin', { token: setupLink });
  assert.equal(vs.status, 200, vs.body);
  assert.equal(vs.json.username, OTHER);
  assert.equal((await post('/api/verify-signin', { token: setupLink })).status, 400, 'single use');
  const codesBefore = [...log.matchAll(/Bestätigungscode \d{6}/g)].length;
  assert.equal((await post('/api/verify-code/resend', { email: otherMail })).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal([...log.matchAll(/Bestätigungscode \d{6}/g)].length, codesBefore, 'no new code for a confirmed account');

  // Rate limit: cheap reads have their own bucket; the strict one still bites.
  CLIENT_IP = '10.0.0.6';
  for (let i = 0; i < 30; i++) await post('/api/passkey/login/options', {});
  assert.equal((await post('/api/login', { username: 'x', password: 'y' })).status !== 429, true, 'reads did not use up the strict bucket');
  let last;
  for (let i = 0; i < 25; i++) last = await post('/api/login', { username: 'x', password: 'y' });
  assert.equal(last.status, 429, 'password guessing is still limited');
}
