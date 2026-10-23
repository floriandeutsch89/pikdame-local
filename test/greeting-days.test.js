// Greeting days (PIKDAME_BIRTHDAY): parsing, the window on the German game
// day, and /api/me telling only the matching signed-in account.
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { parseGreetingDays, greetingWindow } = require('../game/GreetingDays');
const { gameDay } = require('../game/GameDay');

const { testDatabaseUrl } = require('./helpers/test-db');
const HOUR = 60 * 60 * 1000;

test('greeting days: parsing keeps valid entries and reports broken ones by position only', () => {
  assert.deepStrictEqual(parseGreetingDays(''), { entries: [], invalid: [] });
  assert.deepStrictEqual(parseGreetingDays(undefined), { entries: [], invalid: [] });
  const r = parseGreetingDays(' 03-09 : Testkonto ,02-29:Schalt, 02-30:Nie,13-01:X,03-09:, Testkonto, 3-9:Kurz,,04-01:Oma: Inge');
  assert.deepStrictEqual(r.entries, [
    { md: '03-09', name: 'testkonto' },
    { md: '02-29', name: 'schalt' },
    { md: '04-01', name: 'oma: inge' },
  ]);
  assert.deepStrictEqual(r.invalid, [3, 4, 5, 6, 7]);
});

test('greeting days: the window is the whole German game day, today or tomorrow only', () => {
  const { entries } = parseGreetingDays('03-09:Testkonto,03-10:Morgen,03-11:Spaeter');
  const now = Date.parse('2026-03-09T10:00:00Z');
  assert.deepStrictEqual(greetingWindow(entries, 'TESTKONTO ', now), {
    from: Date.parse('2026-03-08T23:00:00Z'), until: Date.parse('2026-03-09T23:00:00Z'),
  });
  assert.deepStrictEqual(greetingWindow(entries, 'morgen', now), {
    from: Date.parse('2026-03-09T23:00:00Z'), until: Date.parse('2026-03-10T23:00:00Z'),
  }, 'tomorrow is announced, so the client can switch at midnight');
  assert.strictEqual(greetingWindow(entries, 'spaeter', now), null, 'the day after tomorrow stays a secret');
  assert.strictEqual(greetingWindow(entries, 'jemand', now), null);
  assert.strictEqual(greetingWindow(entries, '', now), null);
  assert.strictEqual(greetingWindow([], 'testkonto', now), null);
  // 00:30 in Berlin is already the next game day, while UTC still says the 9th.
  const late = Date.parse('2026-03-09T23:30:00Z');
  assert.strictEqual(greetingWindow(entries, 'testkonto', late), null, 'yesterday is over');
  assert.strictEqual(greetingWindow(entries, 'morgen', late).until, Date.parse('2026-03-10T23:00:00Z'));
});

test('greeting days: DST days are 23 and 25 hours long, and the year boundary works', () => {
  const { entries } = parseGreetingDays('03-29:Fruehling,10-25:Herbst,01-01:Neujahr');
  const spring = greetingWindow(entries, 'fruehling', Date.parse('2026-03-29T12:00:00Z'));
  assert.strictEqual(spring.until - spring.from, 23 * HOUR);
  const autumn = greetingWindow(entries, 'herbst', Date.parse('2026-10-25T12:00:00Z'));
  assert.strictEqual(autumn.until - autumn.from, 25 * HOUR);
  assert.deepStrictEqual(greetingWindow(entries, 'neujahr', Date.parse('2026-12-31T12:00:00Z')), {
    from: Date.parse('2026-12-31T23:00:00Z'), until: Date.parse('2027-01-01T23:00:00Z'),
  });
});

test('greeting days: the client offers exactly the emote the server whitelist knows', () => {
  const { GREETING_EMOTE, isAllowedEmote, emoteLevel } = require('../game/Emotes');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const m = client.match(/const GREETING_EMOTE = '([^']+)'/);
  assert.ok(m, 'client.js declares GREETING_EMOTE');
  assert.strictEqual(m[1], GREETING_EMOTE);
  assert.ok(isAllowedEmote(GREETING_EMOTE));
  assert.strictEqual(emoteLevel(GREETING_EMOTE), 1, 'never level-locked');
});

// --- /api/me on a real server ---------------------------------------------------
let CLIENT_IP = '10.0.1.1';
function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Forwarded-For': CLIENT_IP } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* html */ } resolve({ status: res.statusCode, json, body: data }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const healthz = (port) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

async function meJourney(t, databaseUrl, suffix) {
  const port = await freePort();
  const name = `Testkonto${suffix}`;
  const other = `Andere${suffix}`;
  const md = gameDay().slice(5);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-greeting-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_SMTP_HOST: '', PIKDAME_DATABASE_URL: databaseUrl,
      PIKDAME_ADMIN_TOKEN: '', PIKDAME_TRUST_PROXY: '1', PIKDAME_BIRTHDAY: `${md}:${name.toLowerCase()}, 02-30:${other}, ${md}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c; });
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; ; i++) {
    try { if ((await healthz(port)) === 200) break; } catch (e) { /* booting */ }
    if (i > 150) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }
  const signUp = async (username, ip) => {
    CLIENT_IP = ip;
    const email = `${username.toLowerCase()}@example.org`;
    const reg = await post(port, '/api/register-passwordless', { username, email });
    assert.strictEqual(reg.status, 200, reg.body);
    let code = null;
    for (let i = 0; i < 50 && !code; i++) {
      const all = [...log.matchAll(/Bestätigungscode (\d{6})/g)];
      if (all.length) code = all[all.length - 1][1];
      else await new Promise((r) => setTimeout(r, 50));
    }
    const v = await post(port, '/api/verify-code', { email, code });
    assert.strictEqual(v.status, 200, v.body);
    return v.json.token;
  };
  const mine = await post(port, '/api/me', { token: await signUp(name, '10.0.1.2') });
  assert.strictEqual(mine.json.username, name);
  assert.ok(mine.json.greeting, 'the configured account gets its window');
  assert.ok(mine.json.greeting.from <= Date.now() && Date.now() < mine.json.greeting.until, 'and it is today');
  const theirs = await post(port, '/api/me', { token: await signUp(other, '10.0.1.3') });
  assert.strictEqual(theirs.json.username, other);
  assert.strictEqual(theirs.json.greeting, undefined, 'nobody else hears about it');
  const warning = log.split('\n').find((l) => l.includes('PIKDAME_BIRTHDAY'));
  assert.match(warning, /ignored entry 2, 3 /);
  assert.ok(!warning.includes(other) && !warning.includes('02-30'), 'logged by position, never by value');
}

test('greeting days: /api/me tells the configured account only', (t) => meJourney(t, testDatabaseUrl('greeting'), ''));
