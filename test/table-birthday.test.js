// A birthday at the table (PIKDAME_BIRTHDAY): the cake in the felt for everyone seated, but only at
// a private table or the Stammtisch; never at a solo game, never for a guest's name, on a public
// server never at a code table. The table learns a flag: no date, no seat (game/GreetingDays.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { freePort } = require('./helpers/free-port');
const { testDatabaseUrl } = require('./helpers/test-db');
const { parseGreetingDays, greetingAtTable } = require('../game/GreetingDays');
const { gameDay } = require('../game/GameDay');
const GameManager = require('../game/GameManager');

const ROOT = path.join(__dirname, '..');

test('greetingAtTable: a seated account\'s day, only where everyone knows each other', () => {
  const { entries } = parseGreetingDays('03-14:Flo,03-15:Mia');
  const noon = Date.parse('2026-03-14T11:00:00Z'); // 12:00 in Berlin
  const at = (table, now = noon) => greetingAtTable(entries, table, now);
  assert.equal(at({ accounts: ['Flo'] }), true, 'a private table');
  assert.equal(at({ accounts: ['Anna', ' flo '] }), true, 'any seat; case and spaces do not matter');
  assert.equal(at({ accounts: ['Flo'], stammtisch: true }), true, 'the Stammtisch');
  assert.equal(at({ accounts: ['Mia'] }), false, 'not her day yet');
  assert.equal(at({ accounts: ['Anna'] }), false, 'nobody seated has it');
  assert.equal(at({ accounts: [] }), false, 'guests only: no verified seat');
  assert.equal(at({ accounts: ['Flo'], solo: true }), false, 'never a solo game');
  assert.equal(at({ accounts: ['Flo'], publicMode: true }), false, 'a public server: not at a code table');
  assert.equal(at({ accounts: ['Flo'], publicMode: true, stammtisch: true }), true, 'a public server: the Stammtisch');
  assert.equal(greetingAtTable([], { accounts: ['Flo'] }, noon), false, 'no greeting days configured');
  assert.equal(greetingAtTable(entries, undefined, noon), false, 'no table');
  // "Today" is the German game day (game/GameDay.js), not UTC's.
  assert.equal(at({ accounts: ['Flo'] }, Date.parse('2026-03-13T23:30:00Z')), true, '00:30 in Berlin: already the 14th');
  assert.equal(at({ accounts: ['Flo'] }, Date.parse('2026-03-14T22:59:00Z')), true, '23:59 in Berlin: still the 14th');
  assert.equal(at({ accounts: ['Flo'] }, Date.parse('2026-03-14T23:00:00Z')), false, 'midnight in Berlin: over');
});

test('GameManager: every seat\'s state carries the flag, and only the server\'s hook sets it', () => {
  let today = true;
  const g = new GameManager(() => {}, { tableBirthday: () => today });
  g.addOrReconnectPlayer('p1', 'Flo');
  g.addOrReconnectPlayer('p2', 'Anna');
  assert.strictEqual(g.publicState('p1').birthdayToday, true);
  assert.strictEqual(g.publicState('p2').birthdayToday, true, 'everyone at the table sees it');
  assert.ok(g.publicState('p2').players.every((p) => Object.keys(p).every((k) => !/birth|greet/i.test(k))), 'no seat is marked');
  today = false;
  assert.strictEqual(g.publicState('p2').birthdayToday, false);
  today = 'yes';
  assert.strictEqual(g.publicState('p1').birthdayToday, false, 'only true counts');
  const broken = new GameManager(() => {}, { tableBirthday: () => { throw new Error('gone'); } });
  broken.addOrReconnectPlayer('p1', 'Flo');
  assert.strictEqual(broken.publicState('p1').birthdayToday, false, 'decor never breaks a broadcast');
  const plain = new GameManager(() => {});
  plain.addOrReconnectPlayer('p1', 'Flo');
  assert.strictEqual(plain.publicState('p1').birthdayToday, false, 'no hook: no birthday');
  for (const x of [g, broken, plain]) x.destroy();
});

test('GameManager: the hook stays out of the snapshot; a restored table asks the new one', () => {
  const g = new GameManager(() => {}, { tableBirthday: () => true });
  g.addOrReconnectPlayer('p1', 'Flo');
  const snap = JSON.parse(JSON.stringify(g.serialize()));
  assert.ok(!('tableBirthday' in snap), 'not persisted');
  const restored = new GameManager(() => {}, { tableBirthday: () => true });
  restored.deserialize(snap);
  assert.strictEqual(typeof restored.tableBirthday, 'function', 'the restore keeps the new instance\'s hook');
  assert.strictEqual(restored.publicState('p1').birthdayToday, true);
  for (const x of [g, restored]) x.destroy();
});

test('server: the cake at a private table and the Stammtisch, never a date, a guest or a solo game', async (t) => {
  const md = gameDay().slice(5);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-bday-'));
  const PORT = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('table_bday'), PORT: String(PORT), PIKDAME_DATA_DIR: dataDir,
      PIKDAME_PUBLIC_MODE: '0', PIKDAME_ACCOUNTS: '', PIKDAME_SMTP_HOST: '', PIKDAME_ONNX: '0',
      // "Gast" is no account: a guest who calls themself so must never bring a birthday along.
      PIKDAME_BIRTHDAY: `${md}:Flo,${md}:Gast`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.terminate();
    // SIGTERM writes the snapshot into dataDir - wait for the exit before removing it.
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let up = false, i = 0; !up; i++) {
    if (i > 150) throw new Error(`server did not come up:\n${out}`);
    up = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 500 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  const post = (urlPath, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  // Flo signs up (the e-mail code from the log): the account behind the greeting day.
  assert.equal((await post('/api/register-passwordless', { username: 'Flo', email: 'flo@example.org' })).status, 200);
  let mailCode = null;
  for (let i = 0; i < 80 && !mailCode; i++) {
    const m = out.match(/Bestätigungscode (\d{6})/);
    if (m) mailCode = m[1]; else await new Promise((r) => setTimeout(r, 50));
  }
  const verified = await post('/api/verify-code', { email: 'flo@example.org', code: mailCode });
  assert.equal(verified.status, 200);
  const token = verified.json.token;
  assert.ok(token, 'signed in');

  const open = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    sockets.push(ws);
    ws.inbox = [];
    ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw)));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  /** Takes the first message that matches out of the inbox (later ones stay). */
  const take = (ws, pred, what) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const i = ws.inbox.findIndex(pred);
      if (i !== -1) return resolve(ws.inbox.splice(i, 1)[0]);
      if (Date.now() - started > 5000) return reject(new Error(`no ${what}; got ${JSON.stringify(ws.inbox.map((m) => m.error || m.type))}`));
      setTimeout(tick, 20);
    };
    tick();
  });
  const stateOf = async (ws, pred = () => true, what = 'state') => (await take(ws, (m) => m.type === 'state' && pred(m.state), what)).state;
  /** The flag, and nothing that says when or whose. */
  const flagOf = (st) => {
    const json = JSON.stringify(st);
    assert.doesNotMatch(json, /\d{4}-\d{2}-\d{2}/, 'no date in the table state');
    assert.ok(!json.includes(`"${md}"`), 'nor the day of the year');
    assert.deepStrictEqual(Object.keys(st).filter((k) => /birth|greet/i.test(k)), ['birthdayToday'], 'one flag');
    assert.ok(st.players.every((p) => Object.keys(p).every((k) => !/birth|greet/i.test(k))), 'no seat is marked');
    return st.birthdayToday;
  };

  // A private table ("Tisch erstellen"): Flo's day, and the guest who joins by code sees it too.
  const flo = await open();
  flo.send(JSON.stringify({ type: 'createSession', name: 'Flo', accountToken: token }));
  const joined = await take(flo, (m) => m.type === 'joined', 'joined');
  assert.strictEqual(flagOf(await stateOf(flo)), true, 'Flo\'s birthday at Flo\'s table');
  const anna = await open();
  anna.send(JSON.stringify({ type: 'joinSession', code: joined.sessionCode, name: 'Anna' }));
  assert.strictEqual(flagOf(await stateOf(anna, (s) => s.players.some((p) => p.name === 'Anna'), 'Anna seated')), true,
    'everyone at the table sees it');

  // A guest cannot sit down under the account's name, nor bring a configured day of their own.
  const fake = await open();
  fake.send(JSON.stringify({ type: 'createSession', name: 'flo' }));
  assert.match((await take(fake, (m) => m.type === 'error', 'error')).error, /registrierten Konto/, 'the name needs its token');
  const gast = await open();
  gast.send(JSON.stringify({ type: 'createSession', name: 'Gast' }));
  assert.strictEqual(flagOf(await stateOf(gast)), false, 'a guest\'s name never counts');

  // The Stammtisch: the group's own table.
  const stamm = await open();
  stamm.send(JSON.stringify({ type: 'createStammtisch', stammtischName: 'Familie', name: 'Flo', accountToken: token }));
  assert.ok((await take(stamm, (m) => m.type === 'joined', 'joined')).stammtisch, 'a Stammtisch table');
  assert.strictEqual(flagOf(await stateOf(stamm)), true, 'Flo\'s birthday at the Stammtisch');

  // Solo games are no table to celebrate at (the challenge is everyone's deck of the day).
  const solo = await open();
  solo.send(JSON.stringify({ type: 'startChallenge', name: 'Flo', accountToken: token }));
  const challenge = await stateOf(solo, (s) => !!s.challengeDate, 'challenge state');
  assert.strictEqual(challenge.birthdayToday, false, 'not in the daily challenge');
  const tut = await open();
  tut.send(JSON.stringify({ type: 'startTutorial', name: 'Flo', accountToken: token }));
  assert.strictEqual(flagOf(await stateOf(tut, (s) => s.tutorialMode, 'tutorial state')), false, 'not in the tutorial');
});
