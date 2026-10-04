// Guest-profile import into accounts, the admin Users tab (list, resend,
// delete) and the Monitoring tab.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createAccountStore } = require('../game/AccountStore');
const { createPgAccountStore } = require('../game/PgAccountStore');
const { createMonitor, readCgroup } = require('../game/Monitor');
const AdminPage = require('../game/AdminPage');

let HAS_SQLITE = true;
try { require('node:sqlite'); } catch (e) { HAS_SQLITE = false; }
const PG_URL = process.env.PIKDAME_TEST_PG_URL || '';

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// The same contract for both backends.
async function storeContract(store, uniq) {
  const name = `Flo${uniq}`;
  const r = await store.register(name, `flo${uniq}@example.org`, 'long-password-1');
  assert.ok(r.ok, r.error);
  // Unverified accounts get nothing.
  assert.equal((await store.importProfile(name, { xp: 100, games: 3, wins: 1, season: '2026-10' })).imported, false);

  // Resend: a fresh link replaces the old one.
  const renewed = await store.renewVerification(name);
  assert.ok(renewed.ok && renewed.verifyToken !== r.verifyToken);
  assert.equal(renewed.email, `flo${uniq}@example.org`);
  assert.ok((await store.verifyEmail(r.verifyToken)).error, 'old link no longer works');
  assert.ok((await store.verifyEmail(renewed.verifyToken)).ok);
  assert.ok((await store.renewVerification(name)).error, 'verified accounts get no new link');

  // A game booked after verification, then the import: lifted TO the
  // profile, not added on top (the 40 XP game is part of the profile too).
  await store.addGameResult(name, { xp: 40, won: true, season: '2026-10' });
  const imp = await store.importProfile(name, { xp: 250, games: 5, wins: 2, season: '2026-10' });
  assert.equal(imp.imported, true);
  assert.equal(imp.progress.xp, 250);
  assert.equal(imp.progress.games, 5);
  assert.equal(imp.progress.wins, 2);
  assert.equal(imp.progress.seasonXp, 250, 'old games count into the current season');
  assert.equal(imp.progress.season, '2026-10');
  // Once only.
  const again = await store.importProfile(name, { xp: 900, games: 50, wins: 20, season: '2026-10' });
  assert.equal(again.imported, false);
  assert.equal(again.progress.xp, 250);

  // Admin list: e-mail yes, password data never.
  const list = await store.listUsers();
  const me = list.users.find((u) => u.username === name);
  assert.ok(me && me.verified && me.email === `flo${uniq}@example.org` && me.xp === 250);
  assert.ok(list.total >= 1);
  for (const u of list.users) for (const k of Object.keys(u)) assert.ok(!/pass|salt|hash|token/i.test(k), `leaks ${k}`);

  // Delete frees the name.
  assert.ok((await store.deleteUser(name)).ok);
  assert.equal(await store.isRegisteredName(name), false);
  assert.ok((await store.deleteUser(name)).error);
  assert.ok((await store.register(name, `flo${uniq}@example.org`, 'long-password-1')).ok, 'name and e-mail are free again');
}

test('AccountStore (SQLite): profile import, resend, list, delete', { skip: !HAS_SQLITE }, async () => {
  const dir = tmpDir('pikdame-acc-');
  const store = createAccountStore(path.join(dir, 'users.db'));
  try { await storeContract(store, ''); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AccountStore (SQLite): import into an account from an older season starts the new season', { skip: !HAS_SQLITE }, async () => {
  const dir = tmpDir('pikdame-acc-');
  const store = createAccountStore(path.join(dir, 'users.db'));
  try {
    const r = store.register('Max', 'max@example.org', 'long-password-1');
    store.verifyEmail(r.verifyToken);
    store.addGameResult('Max', { xp: 30, season: '2026-09' });
    const imp = store.importProfile('Max', { xp: 100, games: 2, wins: 0, season: '2026-10' });
    assert.equal(imp.progress.xp, 100);
    assert.equal(imp.progress.season, '2026-10');
    assert.equal(imp.progress.seasonXp, 70, 'only the not yet booked difference, in the new season');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PgAccountStore: profile import, resend, list, delete', { skip: !PG_URL }, async () => {
  const store = createPgAccountStore(PG_URL);
  try { await storeContract(store, `${Date.now()}`.slice(-8)); } finally { await store.close(); }
});

test('Monitor: reads cgroup v2 numbers, keeps a capped history', () => {
  const dir = tmpDir('pikdame-cg-');
  fs.writeFileSync(path.join(dir, 'memory.current'), String(64 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, 'memory.max'), String(512 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, 'cpu.stat'), 'usage_usec 1000000\nuser_usec 800000\n');
  fs.writeFileSync(path.join(dir, 'cpu.max'), '100000 100000');
  const cg = readCgroup(dir);
  assert.equal(cg.memBytes, 64 * 1024 * 1024);
  assert.equal(cg.memLimitBytes, 512 * 1024 * 1024);
  assert.equal(cg.cpuUsageUsec, 1000000);
  assert.equal(cg.cpuLimit, 1);
  fs.writeFileSync(path.join(dir, 'memory.max'), 'max');
  fs.writeFileSync(path.join(dir, 'cpu.max'), 'max 100000');
  assert.equal(readCgroup(dir).memLimitBytes, null, '"max" = no limit');
  assert.equal(readCgroup(dir).cpuLimit, null);
  assert.equal(readCgroup(path.join(dir, 'missing')).memBytes, null, 'outside Docker: nulls, no throw');

  const m = createMonitor({ dataDir: dir, cgroupRoot: dir, keep: 3, stats: () => ({ sessions: 2, players: 5 }) });
  for (let i = 0; i < 5; i++) m.sample();
  m.stop();
  assert.equal(m.history().length, 3);
  const c = m.current();
  assert.equal(Math.round(c.container.memMb), 64);
  assert.deepEqual(c.game, { sessions: 2, players: 5 });
  assert.ok(c.host.memTotalMb > 0 && c.host.cores > 0);
  const html = AdminPage.renderAdminPage({ tab: 'monitor', monitor: { current: c, history: m.history() }, version: '1.0.0', csrf: 'x' });
  assert.match(html, /<svg class="spark"/);
  assert.match(html, /http-equiv="refresh" content="15"/, 'the monitor tab refreshes itself');
  assert.doesNotMatch(html, /<script/i, 'no script - fits the CSP');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Real server: guest plays -> registers -> keeps progress; admin tabs ----
const PORT = 8097;
function request(method, urlPath, { auth, body, json, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (auth) h.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');
    let payload = body;
    if (json) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
    else if (body) h['Content-Type'] = 'application/x-www-form-urlencoded';
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('server: guest progress follows the name into the account; admin users + monitor tabs', { skip: !HAS_SQLITE }, async (t) => {
  const dataDir = tmpDir('pikdame-adminusers-');
  // A guest who has played before registering.
  fs.writeFileSync(path.join(dataDir, 'players.json'), JSON.stringify({
    players: [{ id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7, gamesWon: 3, totalScore: 900, xp: 420 }],
  }));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_ADMIN_TOKEN: 'admin-test-token', PIKDAME_SMTP_HOST: '', PIKDAME_DATABASE_URL: '', PIKDAME_PUBLIC_MODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c; });
  t.after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await request('GET', '/healthz')).status === 200) break; } catch (e) { /* booting */ }
    if (Date.now() > deadline) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }
  const tokenFromLog = () => {
    const all = [...log.matchAll(/verify\?token=([a-f0-9]{64})/g)];
    return all.length ? all[all.length - 1][1] : null;
  };
  const waitForToken = async (previous) => {
    for (let i = 0; i < 50; i++) {
      const tok = tokenFromLog();
      if (tok && tok !== previous) return tok;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no verification link in the log');
  };

  const reg = await request('POST', '/api/register', { json: { username: 'Oma Inge', email: 'inge@example.org', password: 'long-password-1' } });
  assert.equal(reg.status, 200);
  const firstToken = await waitForToken(null);

  // Admin: list shows the unverified account; resend makes a new link.
  const auth = 'admin:admin-test-token';
  let page = await request('GET', '/admin/users', { auth });
  assert.equal(page.status, 200);
  assert.match(page.body, /Oma Inge/);
  assert.match(page.body, /inge@example\.org/);
  assert.match(page.body, /offen bis/);
  const csrf = (page.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf);
  const resend = await request('POST', '/admin/users', { auth, body: `csrf=${csrf}&username=${encodeURIComponent('Oma Inge')}&action=resend` });
  assert.equal(resend.status, 200);
  assert.match(resend.body, /Neuer Link erstellt/, 'no SMTP here - the link goes to the log');
  const newToken = await waitForToken(firstToken);

  // Confirming with the new link imports the guest profile.
  assert.equal((await request('GET', `/verify?token=${firstToken}`)).status, 400, 'old link is dead');
  assert.equal((await request('GET', `/verify?token=${newToken}`)).status, 200);
  page = await request('GET', '/admin/users', { auth });
  assert.match(page.body, /bestätigt/);
  assert.match(page.body, /data-label="EP">420<\/td><td class="num" data-label="Spiele">7<\/td><td class="num" data-label="Siege">3<\/td>/, 'XP, games, wins carried over');
  assert.match(page.body, /data-label="Saison-EP">420 /, 'into the current season too');
  assert.match(log, /Gast-Fortschritt übernommen: Oma Inge/);

  // Delete is two-step: ask, then confirm.
  const ask = await request('POST', '/admin/users', { auth, body: `csrf=${csrf}&username=${encodeURIComponent('Oma Inge')}&action=ask-delete` });
  assert.match(ask.body, /wirklich löschen/);
  assert.match(ask.body, /value="delete"/);
  assert.match(page.body, /Oma Inge/, 'still there after the question');
  assert.equal((await request('POST', '/admin/users', { auth, body: `username=Oma&action=delete` })).status, 403, 'CSRF token required');
  const del = await request('POST', '/admin/users', { auth, body: `csrf=${csrf}&username=${encodeURIComponent('Oma Inge')}&action=delete` });
  assert.match(del.body, /wurde gelöscht/);
  assert.doesNotMatch(del.body, /inge@example\.org/);

  // Monitoring tab.
  const mon = await request('GET', '/admin/monitor', { auth });
  assert.equal(mon.status, 200);
  assert.match(mon.body, /Arbeitsspeicher/);
  assert.match(mon.body, /Server gesamt/);
  assert.equal((await request('GET', '/admin/nope', { auth })).status, 404);
});
