/**
 * The MCP seat (mcp/PikdameClient.js) against a real server process: open a
 * table, start it, and play listed moves until a whole round is over.
 * Every move must be accepted - a refusal means the move list lied.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PikdameClient } = require('../mcp/PikdameClient');
const { testDatabaseUrl } = require('./helpers/test-db');

const ROOT = path.join(__dirname, '..');
const PORT = 8097;

async function waitForServer(port, timeoutMs = 15000) {
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

test('an MCP seat plays a full round against bots on a real server', { timeout: 120000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-mcp-'));
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('mcp_client'), PORT: String(PORT), PIKDAME_PUBLIC_MODE: '1', PIKDAME_DATA_DIR: dataDir, PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const client = new PikdameClient({ url: `ws://127.0.0.1:${PORT}`, name: 'Claude' });
  t.after(async () => {
    client.close();
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(PORT);

  const code = await client.createGame();
  assert.match(code, /\S+/);
  // Two seats and fast bots keep the round short.
  client._send({ type: 'setMaxSeats', count: 2 });
  client._send({ type: 'setHouseRules', houseRules: { botPace: 'fast' } });
  const start = client.actions().find((a) => a.key === 'start');
  assert.ok(start, 'the host can start the game');
  assert.deepEqual(await client.perform(start), { ok: true });

  let moves = 0;
  while (moves < 400) {
    const need = await client.waitFor(() => client.attention(), 20000);
    assert.ok(need, `seat waited 20 s for a turn (phase ${client.state && client.state.phase})`);
    if (client.state.phase === 'roundEnd' || need === 'gameOver') break;
    const actions = client.actions().filter((a) => !a.msg.type.startsWith('undo'));
    // Prefer melding so the round can end by someone going out.
    const pick = actions.find((a) => a.msg.type === 'layoutMeld') || actions.find((a) => a.msg.type === 'layOff') || actions[0];
    const r = await client.perform(pick);
    assert.deepEqual(r, { ok: true }, `server refused "${pick.label}"`);
    moves++;
  }
  assert.ok(['roundEnd', 'gameOver'].includes(client.state.phase), `round did not end within ${moves} moves`);
});
