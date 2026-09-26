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
