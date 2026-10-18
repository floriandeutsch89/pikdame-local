// Startup against PostgreSQL: no URL = no start; an unreachable database is
// retried, and a SIGTERM meanwhile leaves the running tables' snapshot alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function boot(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-startup-'));
  const child = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: '8194', PIKDAME_DATA_DIR: dataDir, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { log: '' };
  child.stdout.on('data', (c) => { out.log += c; });
  child.stderr.on('data', (c) => { out.log += c; });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  return { dataDir, child, out, exited };
}

const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

test('without PIKDAME_DATABASE_URL the server says why and exits 1', async () => {
  const s = boot({ PIKDAME_DATABASE_URL: '' });
  assert.equal(await s.exited, 1);
  assert.match(s.out.log, /PIKDAME_DATABASE_URL is not set/);
  fs.rmSync(s.dataDir, { recursive: true, force: true });
});

test('an unreachable database is retried; SIGTERM meanwhile keeps the snapshot', async () => {
  const s = boot({ PIKDAME_DATABASE_URL: 'postgres://nobody@127.0.0.1:59998/none' });
  const snapshot = JSON.stringify({ savedAt: Date.now(), sessions: [{ code: 'KEEPME' }] });
  fs.writeFileSync(path.join(s.dataDir, 'sessions-snapshot.json'), snapshot);
  await until(() => /load failed \(attempt 1/.test(s.out.log));
  s.child.kill('SIGTERM');
  assert.equal(await s.exited, 0);
  assert.equal(fs.readFileSync(path.join(s.dataDir, 'sessions-snapshot.json'), 'utf8'), snapshot, 'not overwritten by an empty registry');
  assert.doesNotMatch(s.out.log, /läuft auf Port/, 'never listened');
  fs.rmSync(s.dataDir, { recursive: true, force: true });
});
