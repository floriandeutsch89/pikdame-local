const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { hasPg, freshSchema } = require('./helpers/pg');

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

async function startServer(env, port, { waitHealthy = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikstats-srv-'));
  for (const [f, data] of Object.entries(env.files || {})) fs.writeFileSync(path.join(dataDir, f), JSON.stringify(data));
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ADMIN_TOKEN: '', PIKDAME_SMTP_HOST: '', PIKDAME_PUBLIC_MODE: '', ...env.vars },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (c) => { log += c; });
  proc.stderr.on('data', (c) => { log += c; });
  const stop = async () => {
    const gone = (proc.exitCode !== null || proc.signalCode !== null) ? null : new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await gone;
  };
  const deadline = Date.now() + 20000;
  while (waitHealthy) {
    try { if ((await get(port, '/healthz')).status === 200) break; } catch (e) { /* booting */ }
    let failure = null;
    if (proc.exitCode !== null) failure = `server exited: ${log}`;
    else if (Date.now() > deadline) failure = `server did not come up: ${log}`;
    if (failure) { await stop(); throw new Error(failure); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { dataDir, proc, stop, log: () => log };
}

test('server without a database: play-only, no stats files written', async () => {
  const srv = await startServer({ vars: { PIKDAME_DATABASE_URL: '' } }, 18931);
  try {
    assert.equal((await get(18931, '/healthz')).body, 'ok');
    assert.match(srv.log(), /play-only/);
  } finally { await srv.stop(); }
  const files = fs.readdirSync(srv.dataDir).filter((f) => /^(players|games|stats|challenges|stammtisch)\.json$|pending-stats/.test(f));
  assert.deepEqual(files, []);
  fs.rmSync(srv.dataDir, { recursive: true, force: true });
});

test('server with Postgres: imports the files, loads stats before listening and restoring sessions', { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL' }, async () => {
  const s = await freshSchema();
  let srv = null;
  try {
    srv = await startServer({
      vars: { PIKDAME_DATABASE_URL: s.url },
      files: { 'players.json': { players: [{ id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7, gamesWon: 3, totalScore: 900, xp: 420 }] } },
    }, 18932);
    assert.ok(fs.existsSync(path.join(srv.dataDir, 'players.json.imported')));
    const r = await s.pool.query("SELECT games_played, xp FROM player_profiles WHERE name_key = 'oma inge'");
    assert.deepEqual(r.rows[0], { games_played: 7, xp: '420' });
    const log = srv.log();
    assert.ok(log.indexOf('[stats] statistics loaded') !== -1, 'stats boot logged');
    assert.ok(log.indexOf('[stats] statistics loaded') < log.indexOf('Pik Dame Server läuft'), 'loaded before listening');
    await srv.stop();
    assert.ok(!fs.existsSync(path.join(srv.dataDir, 'pending-stats.json')), 'clean shutdown leaves nothing pending');
  } finally {
    if (srv) { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); }
    await s.drop();
  }
});

// Windows has no SIGTERM: kill() is a hard kill there, so the handler never runs.
test('SIGTERM while the database is unreachable: exits cleanly, snapshot untouched, no boot crash',
  { skip: process.platform === 'win32' && 'SIGTERM is a hard kill on Windows' }, async () => {
    const snapshot = JSON.stringify({ savedAt: Date.now(), sessions: [] });
    const srv = await startServer({
      vars: { PIKDAME_DATABASE_URL: 'postgres://nouser:nopass@127.0.0.1:59999/nodb' },
      files: {},
    }, 18933, { waitHealthy: false });
    try {
      fs.writeFileSync(path.join(srv.dataDir, 'sessions-snapshot.json'), snapshot);
      for (let i = 0; i < 100 && !/not reachable/.test(srv.log()); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(srv.log(), /not reachable/);
      const code = await new Promise((resolve) => { srv.proc.once('exit', resolve); srv.proc.kill('SIGTERM'); });
      assert.equal(code, 0);
      assert.equal(fs.readFileSync(path.join(srv.dataDir, 'sessions-snapshot.json'), 'utf8'), snapshot, 'snapshot kept for the next start');
      const crash = path.join(srv.dataDir, 'crash.log');
      assert.ok(!fs.existsSync(crash) || !/stats-boot/.test(fs.readFileSync(crash, 'utf8')), 'no boot crash entry');
    } finally {
      await srv.stop();
      fs.rmSync(srv.dataDir, { recursive: true, force: true });
    }
  });
