/**
 * Runtime guarantees of the real server process and bare game objects:
 *  - WebSocket frames are compressed (permessage-deflate negotiated, with a
 *    window large enough to diff consecutive states), and an app-level
 *    ping is answered with a pong (client liveness watchdog),
 *  - a stale session snapshot is discarded instead of restored,
 *  - game timers never keep a process alive on their own (the 75s takeover
 *    grace used to hang every test file that disconnected a player).
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8093;

// Poll until the server accepts connections instead of sleeping a fixed
// time: a fixed 2.2s wait went red once under load (the server just had not
// finished booting).
async function waitForServer(port, timeoutMs = 15000) {
  const http = require('node:http');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 500 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${port} did not come up within ${timeoutMs}ms`);
}

function startServer(dataDir) {
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PIKDAME_PUBLIC_MODE: '1', PIKDAME_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  return { server, output: () => out };
}

test('server negotiates permessage-deflate and drops a stale snapshot', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-rt-'));
  const snapshotFile = path.join(dataDir, 'sessions-snapshot.json');
  // Two hours old - far beyond the restore age limit.
  fs.writeFileSync(snapshotFile, JSON.stringify({ savedAt: Date.now() - 2 * 60 * 60 * 1000, sessions: [] }));

  const { server, output } = startServer(dataDir);
  t.after(async () => {
    // SIGTERM makes the server write its session snapshot into dataDir;
    // removing the directory before it exits raced that write (ENOTEMPTY).
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(PORT);

  assert.match(output(), /Snapshot ist zu alt/);
  assert.ok(!fs.existsSync(snapshotFile), 'a stale snapshot is deleted, not kept around');

  const ws = new WebSocket(`ws://localhost:${PORT}`);
  let negotiated = '';
  ws.once('upgrade', (res) => { negotiated = String(res.headers['sec-websocket-extensions'] || ''); });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  assert.match(ws.extensions, /permessage-deflate/);
  // The 16 KB window holds a whole previous state, so the next one
  // compresses as a diff (~200 B instead of ~1.9 KB) - the EDGE/train lever.
  assert.match(negotiated, /server_max_window_bits=14/);

  // App-level keepalive: the client's liveness watchdog relies on this pong.
  const pong = new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'pong') resolve(msg);
    });
  });
  ws.send(JSON.stringify({ type: 'ping' }));
  assert.deepEqual(await pong, { type: 'pong' });
  ws.close();
});

test('a disconnected human does not keep a bare GameManager process alive', () => {
  const script = `
    const GameManager = require(${JSON.stringify(path.join(ROOT, 'game', 'GameManager.js'))});
    const g = new GameManager(() => {});
    g.addOrReconnectPlayer('p1', 'Anna');
    g.addOrReconnectPlayer('p2', 'Ben');
    g.markDisconnected('p2');
  `;
  const started = Date.now();
  const res = spawnSync('node', ['-e', script], { timeout: 20000 });
  assert.strictEqual(res.status, 0, String(res.stderr));
  assert.ok(Date.now() - started < 10000, 'process exits without waiting for the takeover grace');
});

// Stammtisch over the wire: founding binds a live session to the group code,
// the group code joins that same session, and a member who dropped out gets
// their seat back by NAME (there is no seat token to show at a Stammtisch).
test('Stammtisch: found, join by group code, reclaim seat by name', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-st-'));
  const { server } = startServer(dataDir);
  t.after(() => {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(PORT);

  const open = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.inbox = [];
    ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw)));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  const waitFor = (ws, type, timeoutMs = 4000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const m = ws.inbox.find((x) => x.type === type);
      if (m) return resolve(m);
      if (Date.now() - started > timeoutMs) return reject(new Error(`no ${type} message`));
      setTimeout(tick, 25);
    };
    tick();
  });

  const flo = await open();
  flo.send(JSON.stringify({ type: 'createStammtisch', stammtischName: 'Familie', name: 'Flo' }));
  const joinedFlo = await waitFor(flo, 'joined');
  assert.ok(joinedFlo.stammtisch && /^ST[A-Z2-9]{4}$/.test(joinedFlo.stammtisch.code), 'joined carries the group code');
  assert.strictEqual(joinedFlo.stammtisch.name, 'Familie');
  const summary = await waitFor(flo, 'stammtisch');
  assert.strictEqual(summary.summary.series.no, 1);
  const code = joinedFlo.stammtisch.code;

  const anna = await open();
  anna.send(JSON.stringify({ type: 'joinSession', code, name: 'Anna' }));
  const joinedAnna = await waitFor(anna, 'joined');
  assert.strictEqual(joinedAnna.sessionCode, joinedFlo.sessionCode, 'the group code lands at the live table');
  assert.notStrictEqual(joinedAnna.playerId, joinedFlo.playerId);

  // Anna drops out and comes back with nothing but the group code + her name.
  anna.close();
  await new Promise((r) => setTimeout(r, 300));
  const anna2 = await open();
  anna2.send(JSON.stringify({ type: 'joinSession', code, name: 'anna' }));
  const back = await waitFor(anna2, 'joined');
  assert.strictEqual(back.playerId, joinedAnna.playerId, 'same seat again, matched by name');

  // A namesake cannot take a CONNECTED seat.
  const impostor = await open();
  impostor.send(JSON.stringify({ type: 'joinSession', code, name: 'Anna' }));
  const imp = await waitFor(impostor, 'joined');
  assert.notStrictEqual(imp.playerId, joinedAnna.playerId, 'a connected seat is never handed over');

  const probe = await open();
  probe.send(JSON.stringify({ type: 'checkSession', code }));
  assert.strictEqual((await waitFor(probe, 'sessionStatus')).exists, true, 'the group code counts as an existing game');
  probe.send(JSON.stringify({ type: 'getStammtisch', code }));
  const info = await waitFor(probe, 'stammtischInfo');
  assert.strictEqual(info.exists, true);
  assert.strictEqual(info.name, 'Familie');
  for (const ws of [flo, anna2, impostor, probe]) ws.close();
});
