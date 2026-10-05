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
const { createMonitor, readCgroup, TIERS } = require('../game/Monitor');
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
  // hasPassword (a yes/no) is fine; the hash, salt and tokens never leave the store.
  for (const u of list.users) for (const k of Object.keys(u)) assert.ok(!/salt|hash|token/i.test(k) && k !== 'password', `leaks ${k}`);

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

  const m = createMonitor({ dataDir: dir, cgroupRoot: dir, historyFile: null, stats: () => ({ sessions: 2, players: 5 }) });
  for (let i = 0; i < 5; i++) m.sample();
  m.stop();
  assert.equal(m.history().length, 5);
  const c = m.current();
  assert.equal(Math.round(c.container.memMb), 64);
  assert.deepEqual(c.game, { sessions: 2, players: 5 });
  assert.ok(c.host.memTotalMb > 0 && c.host.cores > 0);
  const html = AdminPage.renderAdminPage({ tab: 'monitor', monitor: { current: c, range: '24h' }, version: '1.0.0', csrf: 'x' });
  assert.match(html, /<script src="\/vendor-uplot\.js" defer><\/script>/);
  assert.match(html, /<script src="\/uplot-touch\.js" defer><\/script>\n<script src="\/admin-monitor\.js" defer><\/script>/, 'touch plugin loads before the charts (#305)');
  assert.ok(c.process.externalMb >= 0, 'external memory is sampled (#306)');
  assert.match(html, /<dt>Nativ<\/dt><dd>\d+ MB/, 'native memory (outside the JS heap) is shown (#306)');
  assert.doesNotMatch(html, /<script>/, 'no inline script - the CSP only allows same-origin files');
  assert.match(html, /data-range="24h"/);
  assert.match(html, /href="\/admin\/monitor\?range=24h" class="active"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Monitor: 5- and 30-minute averages with peaks, pruning, gaps, persistence', () => {
  const dir = tmpDir('pikdame-hist-');
  let clock = Date.UTC(2026, 9, 5, 10, 0, 0);
  let cpu = 0;
  const cg = path.join(dir, 'cg');
  fs.mkdirSync(cg);
  const writeCg = () => {
    fs.writeFileSync(path.join(cg, 'memory.current'), String(100 * 1024 * 1024));
    fs.writeFileSync(path.join(cg, 'cpu.stat'), `usage_usec ${cpu}\n`);
  };
  writeCg();
  const file = path.join(dir, 'monitor-history.json');
  const mk = () => createMonitor({ dataDir: dir, cgroupRoot: cg, historyFile: file, now: () => clock });
  let m = mk();
  // 40 minutes at 15 s; one CPU spike of a full core for 15 s at minute 7.
  for (let i = 0; i < 160; i++) {
    clock += 15000;
    cpu += i === 28 ? 15000000 : 150000; // 100 % for one sample, else 1 %
    writeCg();
    m.sample();
  }
  const day = m.series('24h');
  assert.equal(day.step, TIERS.m5.step);
  assert.ok(day.points.length >= 8 && day.points.length <= 9, `5-min buckets: ${day.points.length}`);
  const spikeBucket = day.points.find((p) => p.cpuPctMax > 90);
  assert.ok(spikeBucket, 'the spike survives as a peak');
  assert.ok(spikeBucket.cpuPct < 20, 'while the average stays low');
  assert.equal(m.series('1h').points.length, 160, 'raw tier: every sample of the last hour');
  m.flushSync();
  m.stop();

  // "Restart": the history comes back from the data directory.
  m = mk();
  assert.equal(m.series('1h').points.length, 160);
  assert.ok(m.series('24h').points.length >= 8);

  // Server off for 2 hours: the raw tier forgets the old hour, the 24 h
  // range keeps it, and the client sees the hole through the step size.
  clock += 2 * 60 * 60 * 1000;
  writeCg(); m.sample();
  assert.equal(m.series('1h').points.length, 1, 'raw tier is pruned to one hour');
  const after = m.series('24h');
  const gaps = after.points.slice(1).filter((p, i) => p.at - after.points[i].at > after.step * 2.5);
  assert.equal(gaps.length, 1, 'one gap where the server did not run');
  const json = AdminPage.monitorData(after, m.current());
  assert.equal(json.range, '24h');
  assert.ok(json.points.every((p) => typeof p.at === 'number'));
  assert.equal(json.current.memMb, 100);
  m.stop();
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
  // Wait for exit: the server writes its snapshot into dataDir on SIGTERM (ENOTEMPTY race).
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await request('GET', '/healthz')).status === 200) break; } catch (e) { /* booting */ }
    if (Date.now() > deadline) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }
  const tokenFromLog = () => {
    const all = [...log.matchAll(/\?verify=([a-f0-9]{64})/g)];
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

  // The old password sign-up endpoint is gone; sign-up is e-mail first.
  assert.equal((await request('POST', '/api/register', { json: { username: 'X Y', email: 'xy@example.org', password: 'long-password-1' } })).status, 404);
  const reg = await request('POST', '/api/register-passwordless', { json: { username: 'Oma Inge', email: 'inge@example.org' } });
  assert.equal(reg.status, 200);
  const firstToken = await waitForToken(null);

  // Admin: list shows the unverified account; resend makes a new link.
  const auth = 'admin:admin-test-token';
  let page = await request('GET', '/admin/users', { auth });
  assert.equal(page.status, 200);
  assert.match(page.body, /Oma Inge/);
  assert.match(page.body, /inge@example\.org/);
  assert.match(page.body, /Link offen/);
  const csrf = (page.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
  assert.ok(csrf);
  const resend = await request('POST', '/admin/users', { auth, body: `csrf=${csrf}&username=${encodeURIComponent('Oma Inge')}&action=resend` });
  assert.equal(resend.status, 200);
  assert.match(resend.body, /Neuer Link erstellt/, 'no SMTP here - the link goes to the log');
  const newToken = await waitForToken(firstToken);

  // Confirming with the new link imports the guest profile.
  assert.equal((await request('POST', '/api/verify-signin', { json: { token: firstToken } })).status, 400, 'old link is dead');
  assert.equal((await request('POST', '/api/verify-signin', { json: { token: newToken } })).status, 200);
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

  // Monitoring tab + its JSON.
  const mon = await request('GET', '/admin/monitor?range=7d', { auth });
  assert.equal(mon.status, 200);
  assert.match(mon.body, /Arbeitsspeicher/);
  assert.match(mon.body, /data-range="7d"/);
  assert.equal((await request('GET', '/admin/monitor/data?range=7d')).status, 401, 'the data needs the login too');
  const data = await request('GET', '/admin/monitor/data?range=7d', { auth });
  assert.equal(data.status, 200);
  const parsed = JSON.parse(data.body);
  assert.equal(parsed.range, '7d');
  assert.ok(Array.isArray(parsed.points) && parsed.current && parsed.limits);
  assert.equal(JSON.parse((await request('GET', '/admin/monitor/data?range=evil', { auth })).body).range, '1h', 'unknown ranges fall back');
  assert.equal((await request('GET', '/uplot-touch.js')).status, 200);
  const vendor = await request('GET', '/vendor-uplot.js');
  assert.equal(vendor.status, 200);
  assert.match(vendor.body, /uPlot 1\.6\.32/);
  assert.equal((await request('GET', '/admin/nope', { auth })).status, 404);
  // Trailing slash (browser autocomplete): redirect, never a 404 after login.
  for (const [from, to] of [['/admin/', '/admin'], ['/admin/users/', '/admin/users'], ['/admin/monitor/?range=7d', '/admin/monitor?range=7d']]) {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: from, headers: { Authorization: 'Basic ' + Buffer.from(auth).toString('base64') } },
        (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location }); }).on('error', reject);
    });
    assert.equal(r.status, 302, from);
    assert.equal(r.location, to, from);
  }
});
