/**
 * Runtime guarantees of the real server process and bare game objects:
 *  - WebSocket frames are compressed (permessage-deflate negotiated),
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  t.after(() => {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await wait(2200);

  assert.match(output(), /Snapshot ist zu alt/);
  assert.ok(!fs.existsSync(snapshotFile), 'a stale snapshot is deleted, not kept around');

  const ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  assert.match(ws.extensions, /permessage-deflate/);
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
