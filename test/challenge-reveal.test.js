/** Daily challenge: today's scores stay hidden until the asking player's own
 *  game ended (played or given up). /challengeboardz before that sends only the
 *  number of players; an account name needs its login token. Real server. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createAccountStore } = require('../game/AccountStore');
const { gameDay, addDays } = require('../game/GameDay');

const PORT = 8142;
const probe = createAccountStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-rev-probe-')), 'probe.db'));
const HAS_SQLITE = probe !== null;
if (probe) probe.close();

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 500 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${PORT} did not come up within ${timeoutMs}ms`);
}

test('today\'s challenge scores show only after the own game; past days stay visible', { skip: !HAS_SQLITE }, async (t) => {
  const today = gameDay();
  const yesterday = addDays(today, -1);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-rev-'));
  const accounts = createAccountStore(path.join(dataDir, 'users.db'));
  accounts.verifyEmail(accounts.register('Ada', 'ada@example.com', 'geheim123').verifyToken);
  const adaToken = accounts.login('Ada', 'geheim123').token;
  accounts.close();
  const at = Date.now();
  fs.writeFileSync(path.join(dataDir, 'challenges.json'), JSON.stringify({
    days: {
      [today]: [{ name: 'Anna', score: 310, at, queens: 1 }, { name: 'Ada', score: 250, at }],
      [yesterday]: [{ name: 'Yuri', score: 400, at: at - 864e5 }],
    },
    attempts: {
      [today]: {
        anna: { name: 'Anna', code: 'A1', at, state: 'done' },
        ada: { name: 'Ada', code: 'A2', at, state: 'done' },
        gina: { name: 'Gina', code: 'A4', at, state: 'done' },
      },
    },
  }));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_PUBLIC_MODE: '0', PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer();
  const board = async (name, token) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/challengeboardz${name ? `?name=${encodeURIComponent(name)}` : ''}`,
      token ? { headers: { 'X-Account-Token': token } } : undefined);
    return res.json();
  };
  const leaksToday = (d) => JSON.stringify([d.board, d.magnet, d.you, d.weekly, d.trend]).match(/Anna|310/);

  for (const [who, d] of [['nobody', await board('')], ['a stranger', await board('Neu')],
    ['an account name without its token', await board('Ada')], ['a wrong token', await board('Ada', 'nope')]]) {
    assert.strictEqual(d.revealed, false, who);
    assert.strictEqual(d.players, 2, `${who}: only the count`);
    assert.deepStrictEqual(d.board, [], who);
    assert.strictEqual(d.magnet, null, who);
    assert.strictEqual(leaksToday(d), null, `${who}: no score of today anywhere`);
    const yIdx = d.trend.dates.indexOf(yesterday);
    assert.strictEqual(d.trend.top.find((p) => p.name === 'Yuri').scores[yIdx], 400, `${who}: past days stay visible`);
  }
  assert.strictEqual((await board('Ada')).attempted, true, 'the tile still knows the day is used');

  const gaveUp = await board('Gina');
  assert.strictEqual(gaveUp.revealed, true, 'given up counts as played');
  assert.deepStrictEqual(gaveUp.board.map((e) => e.name), ['Anna', 'Ada']);
  assert.deepStrictEqual(gaveUp.magnet, { name: 'Anna', queens: 1 });
  assert.strictEqual(gaveUp.you, null);

  const guest = await board('Anna');
  assert.strictEqual(guest.revealed, true);
  assert.strictEqual(guest.you.rank, 1);

  const account = await board('Ada', adaToken);
  assert.strictEqual(account.revealed, true, 'the account with its token sees the day');
  assert.strictEqual(account.you.rank, 2);
});
