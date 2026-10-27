/** The server builds the Kartenhaus months from 2027-01 itself (TowerMonths.js,
 *  TowerGen.js in a worker). Here with a stub policy (test/fixtures/tower-stub-play.js)
 *  and tiny candidate counts; the CI job tower-proofs builds one real month. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TowerGen = require('../game/TowerGen');
const R = require('../game/TowerRule');
const BotTower = require('../game/BotTower');
const GameManager = require('../game/GameManager');
const { createTowerMonths, nextMonth } = require('../game/TowerMonths');
const stub = require('./fixtures/tower-stub-play');
const { createDeck } = require('../game/Deck');

const STUB = path.join(__dirname, 'fixtures', 'tower-stub-play.js');
const play = (o) => stub.playFloor(o);
const rate = (o) => stub.slipRate(o);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-tower-')), 'tower-months.json');
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const service = (file, day, extra = {}) => createTowerMonths({
  file, today: () => day, netReady: () => true, policy: STUB, maxTries: 300, emergencyTries: 120,
  log: () => {}, warn: () => {}, ...extra,
});

/** The rule on a month's entries (what the generator promises). */
function assertRule(month, floors) {
  let prev = null;
  floors.forEach((f, i) => {
    const stage = i + 1;
    assert.ok(TowerGen.proven(f), `${month} floor ${stage}: a proven deal`);
    if (stage <= 10) {
      assert.ok(f.hard && f.hard[0] >= 1 && f.hard[1] <= R.marginCap(stage), `${month} floor ${stage}: Hard's tight star`);
      return;
    }
    const [lo, hi] = R.mediumWindow(stage, prev);
    assert.ok(f.medium10 >= lo && f.medium10 <= hi, `${month} floor ${stage}: medium ${f.medium10} outside ${lo}-${hi}`);
    prev = f.medium10;
  });
  const seeds = floors.map((f) => f.seed);
  assert.strictEqual(new Set(seeds).size, 20, 'every deal once');
}

test('generator: the month alone decides the deals (every replica, every restart)', async () => {
  const a = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 300, pause: async () => {} });
  const b = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 300, pause: async () => {} });
  assert.deepStrictEqual(a.failed, []);
  assertRule('2027-03', a.floors);
  assert.deepStrictEqual(b.floors, a.floors, 'same month, same deals');
  const c = await TowerGen.generateMonth({ month: '2027-04', play, rate, maxTries: 300, pause: async () => {} });
  assert.notDeepStrictEqual(c.floors.map((f) => f.seed), a.floors.map((f) => f.seed), 'another month, other deals');
  assert.strictEqual(R.candidateSeed('2027-03', 4, 17), R.candidateSeed('2027-03', 4, 17));
});

test('generator: resumes after the last finished floor and lands on the same month', async () => {
  const full = await TowerGen.generateMonth({ month: '2027-05', play, rate, maxTries: 300, pause: async () => {} });
  const half = full.floors.map((f, i) => (i < 12 ? f : null)); // stopped after floor 12
  const before = stub.calls();
  const resumed = await TowerGen.generateMonth({ month: '2027-05', floors: half, play, rate, maxTries: 300, pause: async () => {} });
  const resumeCalls = stub.calls() - before;
  assert.deepStrictEqual(resumed.floors, full.floors);
  const b2 = stub.calls();
  await TowerGen.generateMonth({ month: '2027-05', play, rate, maxTries: 300, pause: async () => {} });
  assert.ok(resumeCalls < stub.calls() - b2, `the finished floors are not searched again (${resumeCalls} plays)`);
});

test('service: builds next month from the 15th in its worker, persists per floor, a new instance reads it', async () => {
  const file = tmpFile();
  const s = service(file, '2027-02-15');
  await s.tick();
  await s.stop();
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = stored.months['2027-03'];
  assert.strictEqual(m.version, R.GEN_VERSION);
  assertRule('2027-03', m.floors);
  for (const f of m.floors) assert.ok(Array.isArray(f.zen) && typeof f.zen[2] === 'string', 'Zen proof hash stored');
  const direct = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 300, pause: async () => {} });
  assert.deepStrictEqual(m.floors, direct.floors, 'the worker picks what the generator picks');
  // The 14th: nothing for next month yet; the 15th: built.
  const early = service(tmpFile(), '2027-02-14');
  await early.tick();
  await early.stop();
  assert.strictEqual(early.data().months['2027-03'], undefined, 'next month waits for the 15th');
  assert.ok(early.data().months['2027-02'], 'this month (empty) was built at once');
  // Restart: the file is the truth, BotTower serves it.
  const again = service(file, '2027-03-02');
  try {
    BotTower.setMonthSource(again.seedsFor);
    assert.strictEqual(BotTower.stageConfig(11, '2027-03').seed, m.floors[10].seed);
    assert.deepStrictEqual(again.closedFloors('2027-03'), {});
    assert.deepStrictEqual(again.closedFloors('2026-11'), {}, 'static months are never closed');
  } finally {
    BotTower.setMonthSource(null);
    await again.stop();
  }
});

test('service: a stop mid-month ends the worker between games; the next start resumes to the same month', async () => {
  const file = tmpFile();
  await withEnv({ TOWER_STUB_DELAY_MS: '3' }, async () => {
    const s = service(file, '2027-04-16');
    const run = s.tick();
    // Stop once next month has a floor: a fixed wait stopped before it under CI load (flaky).
    const started = () => (s.data().months['2027-05'] || { floors: [] }).floors.some(Boolean);
    for (const deadline = Date.now() + 60000; !started() && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(started(), 'next month got its first floor');
    const t = Date.now();
    await s.stop();
    await run;
    assert.ok(Date.now() - t < 2000, 'ended between two games, not by the last-resort terminate');
  });
  const partial = JSON.parse(fs.readFileSync(file, 'utf8')).months['2027-05'];
  const doneBefore = partial ? partial.floors.filter(Boolean).length : 0;
  assert.ok(doneBefore >= 1 && doneBefore < 20, `stopped mid-month (${doneBefore} floors)`);
  const s2 = service(file, '2027-04-16');
  await s2.tick();
  await s2.stop();
  const direct = await TowerGen.generateMonth({ month: '2027-05', play, rate, maxTries: 300, pause: async () => {} });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).months['2027-05'].floors, direct.floors, 'resumed to the same deals');
});

test('service: a stale proof (the bots changed) is picked again - that floor, and the next only if the staircase needs it', async () => {
  const file = tmpFile();
  const s = service(file, '2027-02-20');
  await s.tick();
  await s.stop();
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).months['2027-03'].floors;
  const stale = 13;
  await withEnv({ TOWER_STUB_ZEN_LOSES: String(before[stale - 1].seed) }, async () => {
    const t = service(file, '2027-03-01'); // March is now this month: only what is missing is filled
    await t.tick();
    await t.stop();
  });
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).months['2027-03'].floors;
  assert.notStrictEqual(after[stale - 1].seed, before[stale - 1].seed, 'the stale floor got a new deal');
  assert.ok(TowerGen.proven(after[stale - 1]));
  after.forEach((f, i) => {
    if (i === stale - 1 || i === stale) return;
    assert.deepStrictEqual(f, before[i], `floor ${i + 1} unchanged`);
  });
  const [, hi] = R.mediumWindow(stale + 1, after[stale - 1].medium10);
  if (before[stale].medium10 <= hi) assert.deepStrictEqual(after[stale], before[stale], 'the staircase holds: the floor above stays');
  else assert.ok(after[stale].medium10 <= hi, 'the floor above was picked again to keep the staircase');
});

test('service: emergency on an empty month - the band may relax, Zen\'s proof never; no proven deal locks the floor', async () => {
  const file = tmpFile();
  await withEnv({ TOWER_STUB_ZEN_NEVER: '13', TOWER_STUB_MEDIUM_NEVER: '15' }, async () => {
    const s = service(file, '2027-06-01');
    await s.tick();
    try {
      const floors = s.data().months['2027-06'].floors;
      assert.deepStrictEqual(floors[12], { locked: true }, 'floor 13: no deal Zen wins - locked');
      assert.strictEqual(floors[14].relaxed, true, 'floor 15: the band relaxed');
      assert.ok(floors[14].zen[0] >= 1, '... but Zen still proves it');
      assert.deepStrictEqual(s.closedFloors('2027-06'), { 13: 'locked' });
      BotTower.setMonthSource(s.seedsFor);
      assert.strictEqual(BotTower.stageConfig(13, '2027-06').seed, null, 'never an unproven deal');
      assert.strictEqual(BotTower.stageConfig(15, '2027-06').seed, floors[14].seed);
    } finally {
      BotTower.setMonthSource(null);
      await s.stop();
    }
  });
  // While nothing is ready, every floor reads as being built.
  const empty = service(tmpFile(), '2027-06-01', { netReady: () => false });
  assert.strictEqual(Object.values(empty.closedFloors('2027-06')).filter((v) => v === 'building').length, 20);
  await empty.stop();
});

test('service: without the net nothing is generated, data/ is used as it is', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ months: { '2027-01': { version: 1, floors: Array.from({ length: 20 }, (_, i) => ({ seed: 900 + i, zen: [1, 10, 'x'] })) } } }));
  const warnings = [];
  const s = service(file, '2027-01-20', { netReady: () => false, warn: (w) => warnings.push(w) });
  await s.tick();
  await s.tick();
  await s.stop();
  assert.strictEqual(warnings.length, 1, 'one warning, not one per tick');
  assert.match(warnings[0], /no onnxruntime/);
  assert.deepStrictEqual(s.seedsFor('2027-01'), Array.from({ length: 20 }, (_, i) => 900 + i));
  assert.strictEqual(s.data().months['2027-02'], undefined, 'next month not built');
});

test('service, PIKDAME_TOWER_GEN=0: reads only, the start check just logs, a generator instance\'s file shows up', async () => {
  const file = tmpFile();
  const builder = service(file, '2027-08-20'); // the generator instance
  await builder.tick();
  await builder.stop();
  const built = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sep = built.months['2027-09'].floors;
  const warnings = [];
  await withEnv({ TOWER_STUB_ZEN_LOSES: String(sep[4].seed) }, async () => {
    const reader = service(file, '2027-09-01', { generate: false, warn: (w) => warnings.push(w) });
    await reader.tick();
    try {
      assert.ok(warnings.some((w) => /no longer wins floor\(s\) 5 - not picked again here/.test(w)), warnings.join(' | '));
      assert.deepStrictEqual(reader.data().months['2027-09'].floors, sep, 'nothing changed by the reader');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), built, 'the file untouched');
      assert.strictEqual(reader.data().months['2027-10'], undefined, 'no next month from a reader');
      // The generator instance writes a new month: the reader's next pass sees it.
      const next = { ...built, months: { ...built.months, '2027-10': { version: R.GEN_VERSION, floors: sep } } };
      fs.writeFileSync(file, JSON.stringify(next));
      await reader.tick();
      assert.deepStrictEqual(reader.seedsFor('2027-10'), sep.map((f) => f.seed));
    } finally {
      await reader.stop();
    }
  });
  // An empty month stays empty on a reader (closed floors, never generated).
  const lone = service(tmpFile(), '2027-11-02', { generate: false });
  await lone.tick();
  assert.strictEqual(Object.keys(lone.closedFloors('2027-11')).length, 20);
  await lone.stop();
});

test('a running floor of a generated month survives snapshot and restore', async () => {
  const { floors } = await TowerGen.generateMonth({ month: '2027-07', play, rate, maxTries: 300, pause: async () => {} });
  BotTower.setMonthSource((m) => (m === '2027-07' ? floors.map((f) => f.seed) : null));
  try {
    const cfg = BotTower.stageConfig(3, '2027-07');
    const g = new GameManager(() => {}, { deckSeed: cfg.seed, towerStage: 3, towerMonth: '2027-07' });
    g.maybeRunBotTurn = () => {};
    g.addOrReconnectPlayer('me', 'Ada');
    g.syncLobbyBots();
    assert.ok(!g.startTowerRound().error);
    for (let i = 0; i < 6 && g.phase === 'playing'; i++) { const cp = g.currentPlayer(); g.runBotTurn(cp.id, { forced: cp.id === 'me' }); }
    const snap = JSON.parse(JSON.stringify(g.serialize()));
    g.destroy();
    const back = new GameManager(() => {});
    back.maybeRunBotTurn = () => {};
    back.deserialize(snap);
    assert.deepStrictEqual([back.deckSeed, back.towerStage, back.towerMonth], [cfg.seed, 3, '2027-07']);
    let guard = 0;
    while (back.phase === 'playing' && guard++ < 3000) { const cp = back.currentPlayer(); back.runBotTurn(cp.id, { forced: cp.id === 'me' }); }
    const cards = [...back.players.flatMap((p) => p.hand), ...back.drawPile, ...back.discardPile, ...back.tableMelds.flatMap((m) => m.cards)];
    assert.ok(back.phase !== 'playing', 'the restored floor plays to its end');
    assert.ok(cards.length <= createDeck().length);
    back.destroy();
  } finally {
    BotTower.setMonthSource(null);
  }
});

test('months: next month of December is January', () => {
  assert.strictEqual(nextMonth('2027-12'), '2028-01');
  assert.strictEqual(nextMonth('2027-01'), '2027-02');
});
