/** Monthly tower "Turmbau zu Babel": the fixed tower's ladder with ten new deals
 *  per month (game/BabelSeeds.js), its own stars per month, totals over all
 *  months, 10 XP per first star, and the server's getTower/startTower path. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const BotTower = require('../game/BotTower');
const BABEL_SEEDS = require('../game/BabelSeeds');
const GameManager = require('../game/GameManager');
const { createPlayerStore } = require('../game/PlayerStore');
const { familyBadges, BADGE_IDS } = require('../game/Badges');
const { gameDay } = require('../game/GameDay');

const MONTHS = Object.keys(BABEL_SEEDS).sort();

test('seed table: at least 12 months of ten unique deals, none from the fixed tower', () => {
  assert.ok(MONTHS.length >= 12, `${MONTHS.length} months`);
  const all = [];
  for (const m of MONTHS) {
    assert.match(m, /^\d{4}-(0[1-9]|1[0-2])$/);
    assert.strictEqual(BABEL_SEEDS[m].length, BotTower.TOWER_SIZE, `${m}: one deal per stage`);
    for (const seed of BABEL_SEEDS[m]) assert.ok(Number.isInteger(seed) && seed >= 0);
    all.push(...BABEL_SEEDS[m]);
  }
  assert.strictEqual(new Set(all).size, all.length, 'every deal once');
  const fixed = new Set(BotTower.TOWER_STAGES.map((s) => s.seed));
  assert.ok(all.every((seed) => !fixed.has(seed)), 'no fixed-tower deal');
  assert.ok(BABEL_SEEDS[BotTower.babelMonthOf(gameDay())] || MONTHS[0] > gameDay(), 'the current month has its own deals');
});

test('babelSeeds: listed months are theirs, later and earlier months cycle', () => {
  const first = MONTHS[0];
  const n = MONTHS.length;
  assert.deepStrictEqual(BotTower.babelSeeds(first), BABEL_SEEDS[first]);
  const [y, m] = first.split('-').map(Number);
  const plus = (k) => { const i = y * 12 + m - 1 + k; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };
  assert.deepStrictEqual(BotTower.babelSeeds(plus(n)), BABEL_SEEDS[first], 'one cycle later: the first month again');
  assert.deepStrictEqual(BotTower.babelSeeds(plus(n + 1)), BABEL_SEEDS[MONTHS[1]]);
  assert.deepStrictEqual(BotTower.babelSeeds(plus(-1)), BABEL_SEEDS[MONTHS[n - 1]], 'before the list: from its end');
  assert.strictEqual(BotTower.babelMonthOf('2026-10-19'), '2026-10');
});

test('stageConfig with a month: the same bots and handicap, that month\'s deal', () => {
  const month = MONTHS[0];
  for (const s of BotTower.TOWER_STAGES) {
    const cfg = BotTower.stageConfig(s.stage, month);
    assert.deepStrictEqual({ bots: cfg.bots, handicap: cfg.handicap, month: cfg.month }, { bots: s.bots, handicap: s.handicap, month });
    assert.strictEqual(cfg.seed, BABEL_SEEDS[month][s.stage - 1]);
  }
  assert.strictEqual(BotTower.stageConfig(1, 'nonsense'), null);
  assert.strictEqual(BotTower.stageConfig(11, month), null);
  assert.strictEqual(BotTower.stageConfig(1).seed, BotTower.TOWER_STAGES[0].seed, 'without a month: the fixed tower');
});

test('engine: a Babel stage deals its month\'s cards, logs its name, keeps the month in record and snapshot', () => {
  const month = MONTHS[0];
  const cfg = BotTower.stageConfig(3, month);
  const g = new GameManager(() => {}, { deckSeed: cfg.seed, towerStage: 3, towerMonth: month });
  g.addOrReconnectPlayer('me', 'Ada');
  g.syncLobbyBots();
  assert.deepStrictEqual(g.startTowerRound(), { ok: true });
  assert.ok(g.log.some((e) => e.text === 'Turmbau zu Babel, Stufe 3: Hol in dieser Runde mehr Punkte als jeder Bot.'));
  assert.strictEqual(g.publicState('me').towerMonth, month);
  assert.strictEqual(g.seatStatus('me').towerMonth, month);
  const copy = new GameManager(() => {});
  copy.deserialize(JSON.parse(JSON.stringify(g.serialize())));
  assert.strictEqual(copy.towerMonth, month, 'snapshot roundtrip');
  let turns = 0;
  while (g.phase === 'playing' && turns++ < 3000) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
  }
  assert.strictEqual(g.phase, 'gameOver');
  assert.strictEqual(g.lastGameRecord.towerMonth, month);
  const outcome = BotTower.outcomeFromRecord(g.lastGameRecord, 'me');
  assert.strictEqual(outcome.month, month);
  assert.strictEqual(outcome.stage, 3);
  g.destroy();
  copy.destroy();
  // A plain tower game carries no month, a month alone makes no tower.
  assert.strictEqual(new GameManager(() => {}, { towerMonth: month }).towerMonth, null);
});

test('PlayerStore: best per month and stage, totals over months, 10 XP per first star', () => {
  const store = createPlayerStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-babel-')), 'players.json'));
  let r = store.recordBabelResult('Ada', '2026-10', 1, 2);
  assert.deepStrictEqual({ best: r.best, stars: r.stars, unlocked: r.unlocked, xp: r.xp, totalStars: r.totalStars },
    { best: { 1: 2 }, stars: 2, unlocked: 2, xp: 10, totalStars: 2 });
  r = store.recordBabelResult('ada', '2026-10', 1, 3);
  assert.strictEqual(r.xp, 0, 'more stars on the same stage pay nothing');
  r = store.recordBabelResult('Ada', '2026-11', 1, 1);
  assert.deepStrictEqual({ best: r.best, unlocked: r.unlocked, xp: r.xp, totalStars: r.totalStars },
    { best: { 1: 1 }, unlocked: 2, xp: 10, totalStars: 4 }, 'a new month starts at the bottom and pays again');
  assert.deepStrictEqual(store.babelBest('Ada', '2026-10'), { 1: 3 });
  assert.deepStrictEqual(store.babelBest('Ada', '2026-12'), {});
  assert.deepStrictEqual(store.towerBest('Ada'), {}, 'the fixed tower stays untouched');
  const p = store.getPlayerByName('Ada');
  assert.deepStrictEqual([p.babelStars, p.babelCleared, p.xp, p.gamesPlayed || 0], [4, 2, 20, 0]);

  for (const id of ['babel_30', 'babel_100', 'babel_300']) assert.ok(BADGE_IDS.includes(id), `${id} is a badge`);
  for (const s of BotTower.TOWER_STAGES) store.recordBabelResult('Ada', '2027-01', s.stage, 3);
  assert.ok(familyBadges(store.getPlayerByName('Ada')).includes('babel_30'));
  assert.ok(!familyBadges(store.getPlayerByName('Ada')).includes('babel_100'));
});

// --- Real server ----------------------------------------------------------------

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

function next(ws, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`no ${type}`)); }, timeoutMs);
    function onMsg(raw) {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(m);
    }
    ws.on('message', onMsg);
  });
}

test('server: getTower carries this month\'s Babel tower, startTower babel seats its deal', async (t) => {
  const port = 8146;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-babel-srv-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ws = null;
  t.after(async () => {
    if (ws) ws.close();
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(port);
  ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://localhost:${port}`);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  const reply = next(ws, 'towerInfo');
  ws.send(JSON.stringify({ type: 'getTower', name: 'Ada' }));
  const info = await reply;
  const month = BotTower.babelMonthOf(gameDay());
  assert.deepStrictEqual(info.babel, { month, best: {}, stars: 0, cleared: 0, unlocked: 1, totalStars: 0 });
  assert.ok(info.stages.every((s) => !('seed' in s)));

  const locked = next(ws, 'error');
  ws.send(JSON.stringify({ type: 'startTower', stage: 2, babel: true, name: 'Ada' }));
  assert.match((await locked).error, /noch gesperrt/);

  const state = new Promise((resolve) => {
    ws.on('message', function onMsg(raw) {
      const m = JSON.parse(raw);
      if (m.type === 'state' && m.state.phase === 'playing') { ws.off('message', onMsg); resolve(m.state); }
    });
  });
  ws.send(JSON.stringify({ type: 'startTower', stage: 1, babel: true, name: 'Ada' }));
  const s = await state;
  assert.deepStrictEqual([s.towerStage, s.towerMonth], [1, month]);
  assert.deepStrictEqual(s.players.map((p) => (p.isBot ? p.botDifficulty : 'human')), ['human', 'easy', 'easy']);
});
