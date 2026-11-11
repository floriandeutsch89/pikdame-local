/** The server builds the Kartenhaus months from 2027-01 itself (TowerMonths.js,
 *  TowerGen.js in a worker). Here with a stub policy (test/fixtures/tower-stub-play.js)
 *  and tiny candidate counts; the CI job tower-proofs builds one real month. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const TowerGen = require('../game/TowerGen');
const R = require('../game/TowerRule');
const BotTower = require('../game/BotTower');
const GameManager = require('../game/GameManager');
const { createTowerMonths, nextMonth } = require('../game/TowerMonths');
const { memoryTowerStore } = require('../game/TowerMonthStore');
const stub = require('./fixtures/tower-stub-play');
const { createDeck } = require('../game/Deck');

const STUB = path.join(__dirname, 'fixtures', 'tower-stub-play.js');
const play = (o) => stub.playFloor(o);
const rate = (o) => stub.slipRate(o);
const tmpFile = () => memoryTowerStore(); // `file` below: the store an instance shares with the next one
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const service = (file, day, extra = {}) => createTowerMonths({
  store: file, today: () => day, netReady: () => true, policy: STUB, maxTries: 300, emergencyTries: 120,
  log: () => {}, warn: () => {}, ...extra,
});

/** The rule on a month's entries (what the generator promises). */
function assertRule(month, floors) {
  floors.forEach((f, i) => {
    const stage = i + 1;
    assert.ok(TowerGen.proven(f), `${month} floor ${stage}: a proven deal`);
    if (stage <= 10) {
      assert.ok(f.hard && f.hard[0] >= 1 && f.hard[1] <= R.marginCap(stage), `${month} floor ${stage}: Hard's tight star`);
      return;
    }
    const [lo, hi] = R.mediumWindow(stage);
    if (!f.relaxed) assert.ok(f.medium10 >= lo && f.medium10 <= hi, `${month} floor ${stage}: medium ${f.medium10} outside ${lo}-${hi}`);
    assert.ok(f.hard10 >= R.hardMin(stage), `${month} floor ${stage}: Hard ${f.hard10} % below ${R.hardMin(stage)} %`);
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

test('generator: a deal medium likes but Hard rarely wins is never picked', async () => {
  const rates = [];
  const spy = async (o) => { const r = await rate(o); if (o.proxy === 'hard') rates.push([o.stage, r]); return r; };
  const ok = await TowerGen.generateMonth({ month: '2027-03', play, rate: spy, maxTries: 300, pause: async () => {} });
  assert.ok(rates.some(([, r]) => r == null), 'the stub offers deals the gate turns down');
  assertRule('2027-03', ok.floors);
  await withEnv({ TOWER_STUB_HARD_NEVER: '14' }, async () => {
    const res = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 60, pause: async () => {} });
    assert.deepStrictEqual(res.failed.map((f) => f.stage), [14], 'no deal for floor 14 by the rule');
  });
});

test('generator: no deal in the medium window - the nearest one that keeps Hard\'s gate (never without it)', async () => {
  await withEnv({ TOWER_STUB_MEDIUM_NEVER: '15' }, async () => {
    const res = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 300, pause: async () => {} });
    assert.deepStrictEqual(res.failed, []);
    const f = res.floors[14];
    assert.ok(f.relaxed && f.zen[0] >= 1 && f.hard10 >= R.hardMin(15), JSON.stringify(f));
  });
  await withEnv({ TOWER_STUB_MEDIUM_NEVER: '15', TOWER_STUB_HARD_NEVER: '15' }, async () => {
    const res = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 300, pause: async () => {} });
    assert.deepStrictEqual(res.failed.map((x) => x.stage), [15], 'outside an emergency: no unfair deal');
  });
});

test('generator, only: re-picks just the named floors of a played month, the rest stays as it is', async () => {
  const { floors } = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 300, pause: async () => {} });
  const old = floors.map((f, i) => (i === 14 ? { ...f, hard10: 3 } : i === 16 ? { ...f, hard10: 4 } : f));
  const res = await TowerGen.generateMonth({ month: '2027-03', floors: old, only: [15], play, rate, maxTries: 300, pause: async () => {} });
  assert.notStrictEqual(res.floors[14].seed, old[14].seed, 'floor 15 re-picked');
  assert.ok(res.floors[14].hard10 >= R.hardMin(15));
  res.floors.forEach((f, i) => { if (i !== 14) assert.deepStrictEqual(f, old[i], `floor ${i + 1} kept`); });
  assert.deepStrictEqual(res.failed.filter((f) => f.kept).map((f) => f.stage), [17], 'a kept floor off the rule is reported');
});

test('generator, missing: a running month keeps its floors from before the Hard gate', async () => {
  const { floors } = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 300, pause: async () => {} });
  const v1 = floors.map(({ hard10: _h, ...f }) => f); // stored by GEN_VERSION 1
  const res = await TowerGen.generateMonth({ month: '2027-03', floors: v1, mode: 'missing', play, rate, maxTries: 300, pause: async () => {} });
  assert.deepStrictEqual(res.floors, v1, 'players keep the deals they have stars on');
  const ruled = await TowerGen.generateMonth({ month: '2027-03', floors: v1, mode: 'rule', play, rate, maxTries: 300, pause: async () => {} });
  assertRule('2027-03', ruled.floors); // next month (nobody plays it yet) gets the gate
});

test('generator, boss floors: picked by Hard\'s and Mittel\'s rate on floors 10, 15 and 20, tagged, never mixed with an old entry', async () => {
  const boss = (stage) => [10, 15, 20].includes(stage);
  const plain = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 300, pause: async () => {}, boss: () => false });
  const res = await TowerGen.generateMonth({ month: '2027-03', play, rate, maxTries: 300, pause: async () => {}, boss });
  assert.deepStrictEqual(res.failed, []);
  for (const stage of [10, 15, 20]) {
    const f = res.floors[stage - 1];
    const [lo, hi] = R.bossMediumWindow(stage);
    assert.ok(TowerGen.proven(f) && f.boss === 1, `floor ${stage}: a proven deal, tagged as a boss deal`);
    assert.ok(f.hard10 >= R.bossHardMin(stage) && f.hard10 <= R.bossHardMax(stage) && f.medium10 >= lo && f.medium10 <= hi, `floor ${stage}: inside the boss gates (${f.hard10}, ${f.medium10})`);
  }
  res.floors.forEach((f, i) => { if (!boss(i + 1)) { assert.strictEqual(f.boss, undefined); assert.deepStrictEqual(f, plain.floors[i], `floor ${i + 1}: an ordinary floor as ever`); } });
  assert.deepStrictEqual([R.bossHardMin(10), R.bossHardMin(15), R.bossHardMin(20), R.bossHardMax(20)], [50, 40, 30, 60]);
  assert.deepStrictEqual(R.bossMediumWindow(20), [10, 60]);

  // A month stored before its floors became boss floors: exactly those three are picked again.
  for (const mode of ['rule', 'missing']) {
    const again = await TowerGen.generateMonth({ month: '2027-03', floors: plain.floors, mode, play, rate, maxTries: 300, pause: async () => {}, boss });
    again.floors.forEach((f, i) => {
      if (boss(i + 1)) assert.strictEqual(f.boss, 1, `${mode}, floor ${i + 1}: picked under the boss rule`);
      else assert.deepStrictEqual(f, plain.floors[i], `${mode}, floor ${i + 1}: kept`);
    });
    assert.deepStrictEqual(again.floors, res.floors, `${mode}: the same deals as a fresh boss month`);
  }
  // A static month players already climb: --floors 10,15,20 touches nothing else.
  const only = await TowerGen.generateMonth({ month: '2027-03', floors: plain.floors, only: [10, 15, 20], play, rate, maxTries: 300, pause: async () => {}, boss });
  assert.deepStrictEqual(only.floors, res.floors);
  // And the way back: a boss entry on a floor that is none any more does not fit either.
  const back = await TowerGen.generateMonth({ month: '2027-03', floors: res.floors, play, rate, maxTries: 300, pause: async () => {}, boss: () => false });
  assert.strictEqual(back.floors[14].boss, undefined);
});

test('service: builds next month from the 15th in its worker, persists per floor, a new instance reads it', async () => {
  const file = tmpFile();
  const s = service(file, '2027-02-15');
  await s.tick();
  await s.stop();
  const stored = file.snapshot();
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
  // Restart: the store is the truth, BotTower serves it once it is read.
  const again = service(file, '2027-03-02');
  await again.ready();
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
  const partial = file.snapshot().months['2027-05'];
  const doneBefore = partial ? partial.floors.filter(Boolean).length : 0;
  assert.ok(doneBefore >= 1 && doneBefore < 20, `stopped mid-month (${doneBefore} floors)`);
  const s2 = service(file, '2027-04-16');
  await s2.tick();
  await s2.stop();
  const direct = await TowerGen.generateMonth({ month: '2027-05', play, rate, maxTries: 300, pause: async () => {} });
  assert.deepStrictEqual(file.snapshot().months['2027-05'].floors, direct.floors, 'resumed to the same deals');
});

test('service: a stale proof (the bots changed) is picked again - that floor only', async () => {
  const file = tmpFile();
  const s = service(file, '2027-02-20');
  await s.tick();
  await s.stop();
  const before = file.snapshot().months['2027-03'].floors;
  const stale = 13;
  await withEnv({ TOWER_STUB_ZEN_LOSES: String(before[stale - 1].seed) }, async () => {
    const t = service(file, '2027-03-01'); // March is now this month: only what is missing is filled
    await t.tick();
    await t.stop();
  });
  const after = file.snapshot().months['2027-03'].floors;
  assert.notStrictEqual(after[stale - 1].seed, before[stale - 1].seed, 'the stale floor got a new deal');
  assert.ok(TowerGen.proven(after[stale - 1]));
  after.forEach((f, i) => {
    if (i !== stale - 1) assert.deepStrictEqual(f, before[i], `floor ${i + 1} unchanged`);
  });
});

test('service: emergency on an empty month - the medium window may relax, Zen\'s proof never; no proven deal locks the floor', async () => {
  const file = tmpFile();
  await withEnv({ TOWER_STUB_ZEN_NEVER: '13', TOWER_STUB_MEDIUM_NEVER: '15' }, async () => {
    const s = service(file, '2027-06-01');
    await s.tick();
    try {
      const floors = s.data().months['2027-06'].floors;
      assert.deepStrictEqual(floors[12], { locked: true }, 'floor 13: no deal Zen wins - locked');
      assert.strictEqual(floors[14].relaxed, true, 'floor 15: the medium window relaxed');
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

test('service: without the net nothing is generated, the stored months are used as they are', async () => {
  const file = tmpFile();
  file.set({ months: { '2027-01': { version: 1, floors: Array.from({ length: 20 }, (_, i) => ({ seed: 900 + i, zen: [1, 10, 'x'] })) } } });
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
  const built = file.snapshot();
  const sep = built.months['2027-09'].floors;
  const warnings = [];
  await withEnv({ TOWER_STUB_ZEN_LOSES: String(sep[4].seed) }, async () => {
    const reader = service(file, '2027-09-01', { generate: false, warn: (w) => warnings.push(w) });
    await reader.tick();
    try {
      assert.ok(warnings.some((w) => /no longer wins floor\(s\) 5 - not picked again here/.test(w)), warnings.join(' | '));
      assert.deepStrictEqual(reader.data().months['2027-09'].floors, sep, 'nothing changed by the reader');
      assert.deepStrictEqual(file.snapshot(), built, 'the store untouched');
      assert.strictEqual(reader.data().months['2027-10'], undefined, 'no next month from a reader');
      // The generator instance writes a new month: the reader's next pass sees it.
      const next = { ...built, months: { ...built.months, '2027-10': { version: R.GEN_VERSION, floors: sep } } };
      file.set(next);
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

// --- PostgreSQL store (TowerMonthStore.js) -----------------------------------------------
const fs = require('fs');
const os = require('os');
const { createPgTowerStore } = require('../game/TowerMonthStore');
const { testPool } = require('./helpers/test-db');

test('PostgreSQL store: floors are kept per row, a reopened floor is gone, a second instance reads the same', async (t) => {
  const pool = testPool(t, 'tower');
  const store = createPgTowerStore(pool);
  assert.deepStrictEqual(await store.load(), { months: {} });
  store.saveFloor('2027-03', 1, { seed: 11, zen: [1, 10, 'a'] }, 2);
  store.saveFloor('2027-03', 20, { locked: true }, 3);
  store.saveFloor('2027-04', 5, { seed: 55, zen: [2, 40, 'b'] }, 3);
  await store.flush();
  const data = await createPgTowerStore(pool).load();
  assert.deepStrictEqual(Object.keys(data.months).sort(), ['2027-03', '2027-04']);
  assert.strictEqual(data.months['2027-03'].version, 3, 'the newest rule of its floors');
  assert.strictEqual(data.months['2027-03'].floors.length, 20);
  assert.deepStrictEqual(data.months['2027-03'].floors[0], { seed: 11, zen: [1, 10, 'a'] });
  assert.deepStrictEqual(data.months['2027-03'].floors[19], { locked: true });
  assert.strictEqual(data.months['2027-03'].floors[1], null);
  store.saveFloor('2027-03', 1, { seed: 12, zen: [1, 5, 'c'] }, 3);
  store.saveFloor('2027-03', 20, null, 3);
  await store.flush();
  const after = (await store.load()).months['2027-03'].floors;
  assert.strictEqual(after[0].seed, 12);
  assert.strictEqual(after[19], null, 'open again');
});

test('PostgreSQL store: the service builds a month into it and a restart serves it', async (t) => {
  const pool = testPool(t, 'tower');
  const s = service(createPgTowerStore(pool), '2027-02-15');
  await s.tick();
  await s.stop();
  const { rows } = await pool.query("SELECT count(*)::int AS n, min(gen_version) AS v FROM tower_floors WHERE tower_month = '2027-03'");
  assert.deepStrictEqual(rows[0], { n: 20, v: R.GEN_VERSION });
  const again = service(createPgTowerStore(pool), '2027-03-02');
  await again.ready();
  assert.deepStrictEqual(again.seedsFor('2027-03'), s.seedsFor('2027-03'));
  assert.deepStrictEqual(again.closedFloors('2027-03'), {});
  await again.stop();
});

test('PostgreSQL store: tower-months.json is imported once; a database that is away never throws into the service', async (t) => {
  const pool = testPool(t, 'tower');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-tower-')), 'tower-months.json');
  const floors = Array.from({ length: 20 }, (_, i) => (i === 3 ? null : { seed: 900 + i, zen: [1, 10, 'x'] }));
  fs.writeFileSync(file, JSON.stringify({ months: { '2027-01': { version: 2, floors }, kaputt: { floors: 'x' } } }));
  const store = createPgTowerStore(pool, { legacyFile: file });
  const data = await store.load();
  assert.deepStrictEqual(data.months, { '2027-01': { version: 2, floors } });
  assert.ok(fs.existsSync(`${file}.migrated`) && !fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify({ months: { '2027-02': { version: 2, floors } } }));
  assert.deepStrictEqual(Object.keys((await createPgTowerStore(pool, { legacyFile: file }).load()).months), ['2027-01'], 'not imported twice');

  const { Pool } = require('pg');
  const dead = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
  const errors = [];
  const away = createPgTowerStore(dead, { logError: (l) => errors.push(l) });
  const warnings = [];
  const svc = service(away, '2027-02-15', { warn: (w) => warnings.push(w) });
  await svc.tick();
  assert.match(warnings.join('|'), /generation failed/);
  assert.strictEqual(svc.data().months['2027-03'], undefined, 'nothing is generated on top of an unread store');
  away.saveFloor('2027-03', 1, { seed: 1 }, 3);
  await away.flush();
  assert.match(errors.join('|'), /2027-03 floor 1 not stored/);
  await svc.stop();
  await dead.end();
});
