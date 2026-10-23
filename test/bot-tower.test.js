/** Kartenhaus: a monthly tower of twenty one-round floors (game/BotTower.js is
 *  the only definition). Module rules, months and seeds, the engine path (one
 *  round, solo, frozen table, modifiers, card conservation, snapshot), best-of
 *  storage per month with XP, crown and badges, and the real server's messages. */
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const BotTower = require('../game/BotTower');
const GameManager = require('../game/GameManager');
const { createDeck } = require('../game/Deck');
const { createPlayerStore } = require('../game/PlayerStore');
const { familyBadges, BADGE_IDS } = require('../game/Badges');
const { testDatabaseUrl } = require('./helpers/test-db');

const { TOWER_STAGES, starsFor, outcomeFromRecord, unlockedStage, summarize } = BotTower;

// --- Module ---------------------------------------------------------------------

const TowerSeeds = require('../game/TowerSeeds');

test('twenty floors: the old ladder, then three Zen bots with modifiers; 60 stars', () => {
  assert.strictEqual(BotTower.TOWER_SIZE, 20);
  assert.strictEqual(BotTower.MAX_STARS, 60);
  assert.deepStrictEqual(TOWER_STAGES.map((s) => s.stage), Array.from({ length: 20 }, (_, i) => i + 1));
  const levels = ['easy', 'medium', 'hard', 'zen'];
  for (const s of TOWER_STAGES) {
    assert.ok(!('seed' in s), `floor ${s.stage}: seeds live per month`);
    assert.ok(s.bots.length >= 2 && s.bots.length <= 3, `floor ${s.stage}: 3-4 seats`);
    for (const b of s.bots) assert.ok(levels.includes(b), `floor ${s.stage}: level ${b}`);
  }
  for (let i = 1; i < 10; i++) {
    assert.ok(TOWER_STAGES[i].handicap >= TOWER_STAGES[i - 1].handicap, `handicap never drops at floor ${i + 1}`);
  }
  const has = (s, level) => s.bots.includes(level);
  for (const s of TOWER_STAGES.slice(0, 3)) assert.ok(!has(s, 'hard') && !has(s, 'zen'), `floor ${s.stage}: easy/medium only`);
  for (const s of TOWER_STAGES.slice(3, 6)) assert.ok(has(s, 'hard') && !has(s, 'zen'), `floor ${s.stage}: hard, no Zen yet`);
  for (const s of TOWER_STAGES.slice(6, 9)) assert.ok(has(s, 'zen'), `floor ${s.stage}: Zen in the mix`);
  for (const s of TOWER_STAGES.slice(9)) {
    assert.deepStrictEqual(s.bots, ['zen', 'zen', 'zen'], `floor ${s.stage}: three Zen`);
    assert.ok(s.handicap >= 100, `floor ${s.stage}: a big head start`);
  }
  for (const s of TOWER_STAGES.slice(0, 10)) assert.ok(!s.mods, `floor ${s.stage}: plain rules`);
  for (const s of TOWER_STAGES.slice(10)) {
    assert.ok(s.mods.length >= 1 && s.mods.every((m) => BotTower.MODS.includes(m)), `floor ${s.stage}: known modifiers`);
  }
  assert.deepStrictEqual(TOWER_STAGES[19].mods.slice().sort(), BotTower.MODS.slice().sort(), 'the top floor: all three');
  // Floors 11-20 as decided (head start and modifiers, measured against the Zen net).
  assert.deepStrictEqual(TOWER_STAGES.slice(10).map((s) => [s.handicap, s.mods.join('+')]), [
    [100, 'queen'], [100, 'goOut'], [100, 'noDiscard'], [140, 'queen'], [120, 'goOut'], [120, 'noDiscard'],
    [140, 'queen+goOut'], [160, 'queen+noDiscard'], [160, 'noDiscard+goOut'], [160, 'queen+noDiscard+goOut'],
  ]);
});

test('months: the static list ends 2026-12, later months come from the generator, nothing cycles', () => {
  const months = Object.keys(TowerSeeds).sort();
  assert.strictEqual(BotTower.LEGACY_MONTH, '2026-10');
  assert.deepStrictEqual(months, ['2026-10', '2026-11', '2026-12']);
  assert.deepStrictEqual(TowerSeeds['2026-10'].slice(0, 10), [84, 10, 78, 24, 63, 131, 34, 89, 28, 170], 'stars of the old tower stay valid');
  const all = [];
  for (const m of months) {
    assert.strictEqual(TowerSeeds[m].length, 20, `${m}: one deal per floor`);
    all.push(...TowerSeeds[m]);
  }
  assert.strictEqual(new Set(all).size, all.length, 'every deal once');
  assert.strictEqual(BotTower.monthOf('2026-11-03'), '2026-11');
  const cfg = BotTower.stageConfig(12, '2026-11');
  assert.deepStrictEqual([cfg.seed, cfg.month, cfg.handicap], [TowerSeeds['2026-11'][11], '2026-11', TOWER_STAGES[11].handicap]);
  assert.strictEqual(BotTower.stageConfig(3).month, '2026-10', 'no month: the first one (an old snapshot)');
  assert.strictEqual(BotTower.stageConfig(3, 'nonsense'), null);
  // No generator: a later month has no deals at all (never a repeated month).
  BotTower.setMonthSource(null);
  assert.deepStrictEqual(BotTower.monthSeeds('2027-01'), Array(20).fill(null));
  const later = BotTower.stageConfig(5, '2027-01');
  assert.deepStrictEqual([later.seed, later.bots], [null, TOWER_STAGES[4].bots], 'bots and rules stay, the deal is missing');
  try {
    BotTower.setMonthSource((m) => (m === '2027-01' ? Array.from({ length: 20 }, (_, i) => (i === 4 ? null : 7000 + i)) : null));
    assert.strictEqual(BotTower.stageConfig(1, '2027-01').seed, 7000);
    assert.strictEqual(BotTower.stageConfig(5, '2027-01').seed, null, 'a floor still being built has no deal');
    assert.strictEqual(BotTower.stageConfig(1, '2027-02').seed, null);
    assert.strictEqual(BotTower.stageConfig(1, '2026-11').seed, TowerSeeds['2026-11'][0], 'the static list wins');
  } finally {
    BotTower.setMonthSource(null);
  }
});

test('the client never learns the seeds', () => {
  const pub = BotTower.publicStages();
  assert.strictEqual(pub.length, 20);
  for (const s of pub) assert.deepStrictEqual(Object.keys(s).sort(), s.stage > 10 ? ['bots', 'handicap', 'mods', 'stage'] : ['bots', 'handicap', 'stage']);
  pub[0].bots.push('zen');
  assert.strictEqual(TOWER_STAGES[0].bots.length, 2, 'a copy, not the definition');
  assert.strictEqual(BotTower.stageConfig('3').stage, 3, 'stage numbers from a message work too');
  assert.strictEqual(BotTower.stageConfig(21), null);
  assert.strictEqual(BotTower.stageConfig('x'), null);
});

test('stars: ahead after the handicap, 100 clear, out yourself', () => {
  const s = (myScore, botScores, wentOut, handicap = 0) => starsFor({ myScore, botScores, wentOut, handicap });
  assert.strictEqual(s(100, [100, 40], true), 0, 'a tie is no star');
  assert.strictEqual(s(105, [100, 40], false), 1);
  assert.strictEqual(s(199, [100], true), 1, '99 ahead: one star, going out does not skip a step');
  assert.strictEqual(s(200, [100], false), 2, '100 ahead');
  assert.strictEqual(s(200, [100], true), 3, '100 ahead and out');
  assert.strictEqual(s(120, [100], true, 20), 0, 'the handicap counts');
  assert.strictEqual(s(125, [100], true, 20), 1);
  assert.strictEqual(s(-20, [-40, -60], false), 1, 'negative rounds compare too');
  assert.strictEqual(s(50, [], false), 1, 'no bots: ahead of zero');
});

function stageRecord({ stage = 4, my = 230, bots = [145, 60], winnerId = 'me' } = {}) {
  const results = { me: { roundScore: my } };
  bots.forEach((v, i) => { results[`bot-${i + 1}`] = { roundScore: v }; });
  return {
    towerStage: stage,
    players: [{ id: 'me', name: 'Ada', isBot: false }, ...bots.map((_, i) => ({ id: `bot-${i + 1}`, name: `B${i}`, isBot: true }))],
    rounds: [{ winnerId, results }],
  };
}

test('XP: the first star of a floor pays once a month, more stars and retries nothing', () => {
  const { xpForTowerStage, XP_TOWER_FIRST_STAR, XP_TOWER_CROWN } = require('../game/Progression');
  assert.deepStrictEqual([XP_TOWER_FIRST_STAR, XP_TOWER_CROWN], [10, 50]);
  assert.strictEqual(xpForTowerStage(0, 1), 10, 'first star');
  assert.strictEqual(xpForTowerStage(0, 3), 10, 'three at once are still one first star');
  assert.strictEqual(xpForTowerStage(1, 2), 0, 'a second star');
  assert.strictEqual(xpForTowerStage(3, 3), 0, 'a repeat');
  assert.strictEqual(xpForTowerStage(0, 0), 0, 'no star');
  assert.strictEqual(TOWER_STAGES.length * xpForTowerStage(0, 1) + XP_TOWER_CROWN, 250, 'a whole month: at most 250');
});

test('stageWinner: the human wins exactly with a star, the handicap included', () => {
  const { stageWinner } = BotTower;
  assert.strictEqual(stageWinner({ me: 145, a: 140, b: 30 }, 'me', 'me', 20), 'a', 'ahead on points, behind after the handicap');
  assert.strictEqual(stageWinner({ me: 165, a: 140, b: 30 }, 'b', 'me', 20), 'me');
  assert.strictEqual(stageWinner({ me: 140, a: 140, b: 30 }, 'me', 'me', 0), 'a', 'a tie is no star, so no win');
  assert.strictEqual(stageWinner({ me: 10, a: 90, b: 90 }, 'b', 'me', 0), 'b', 'tied bots: whoever went out');
  assert.strictEqual(stageWinner({ me: 10, a: 90, b: 90 }, 'me', 'me', 0), 'a', 'else the first of them');
});

test('outcomeFromRecord: the verdict of the one round', () => {
  assert.deepStrictEqual(outcomeFromRecord(stageRecord(), 'me'),
    { stage: 4, month: '2026-10', stars: 1, myScore: 230, bestBot: 145, handicap: 0, margin: 85, wentOut: true });
  const g = outcomeFromRecord({ ...stageRecord({ stage: 12, my: 400, bots: [100], winnerId: 'bot-1' }), towerMonth: '2026-11' }, 'me');
  assert.deepStrictEqual([g.month, g.stars, g.mods], ['2026-11', 0, ['goOut']], 'goOut: far ahead but not out - no star');
  const h = outcomeFromRecord(stageRecord({ stage: 10, my: 305, bots: [190, 20, -10], winnerId: 'bot-2' }), 'me');
  assert.deepStrictEqual({ stars: h.stars, margin: h.margin, handicap: h.handicap, wentOut: h.wentOut }, { stars: 1, margin: 15, handicap: 100, wentOut: false });
  assert.strictEqual(outcomeFromRecord(stageRecord({ my: 300, bots: [100] }), 'me').stars, 3);
  assert.strictEqual(outcomeFromRecord({ ...stageRecord(), rounds: [] }, 'me'), null, 'no round, no verdict');
  assert.strictEqual(outcomeFromRecord({ ...stageRecord(), towerStage: undefined }, 'me'), null, 'not a tower game');
  assert.strictEqual(outcomeFromRecord(stageRecord(), 'nobody'), null);
});

test('unlocking: stage 1 first, then one above every cleared stage in a row', () => {
  assert.strictEqual(unlockedStage({}), 1);
  assert.strictEqual(unlockedStage({ 1: 1 }), 2);
  assert.strictEqual(unlockedStage({ 1: 3, 2: 0 }), 2);
  assert.strictEqual(unlockedStage({ 1: 1, 3: 3 }), 2, 'a gap stops the climb');
  const all = Object.fromEntries(TOWER_STAGES.map((s) => [s.stage, 1]));
  assert.strictEqual(unlockedStage(all), 20, 'never beyond the top');
  assert.strictEqual(unlockedStage(Object.fromEntries(TOWER_STAGES.slice(0, 10).map((s) => [s.stage, 1]))), 11, 'floor 11 after floor 10');
  assert.deepStrictEqual(summarize({ 1: 3, 2: 2, 3: 9, 4: -1, 5: 'x' }), { stars: 8, cleared: 3, unlocked: 4, crowned: false }, 'clamped per floor');
  assert.deepStrictEqual(summarize(Object.fromEntries(TOWER_STAGES.map((s) => [s.stage, 3]))), { stars: 60, cleared: 20, unlocked: 20, crowned: true });
  assert.strictEqual(summarize({ ...all, 20: 0 }).crowned, false, 'one floor short: no crown');
});

// --- Engine ---------------------------------------------------------------------

const REFERENCE = (() => {
  const counts = new Map();
  for (const card of createDeck()) counts.set(card.id, (counts.get(card.id) || 0) + 1);
  return counts;
})();
/** Every card exactly as often as in the 110-card deck (see card-conservation.test.js). */
function conserved(g) {
  const found = new Map();
  const add = (c) => { if (c && c.id) found.set(c.id, (found.get(c.id) || 0) + 1); };
  for (const p of g.players) (p.hand || []).forEach(add);
  for (const m of g.tableMelds || []) for (const s of m.slots || []) { add(s.real); add(s.joker); }
  for (const pile of [g.drawPile, g.discardPile, g.retiredJokers, g._pendingDeck]) (pile || []).forEach(add);
  if (found.size !== REFERENCE.size) return false;
  for (const [id, n] of REFERENCE) if (found.get(id) !== n) return false;
  return true;
}

function towerGame(stage, extra = {}) {
  const cfg = BotTower.stageConfig(stage);
  const g = new GameManager(() => {}, { deckSeed: cfg.seed, towerStage: cfg.stage, ...extra });
  g.addOrReconnectPlayer('me', 'Ada');
  g.syncLobbyBots(); // what joinSession does before the stage starts
  return g;
}

/** Plays the stage to its end, every seat by the heuristic (the human forced). */
function playOut(g) {
  let turns = 0;
  while (g.phase === 'playing' && turns++ < 3000) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
    assert.ok(conserved(g), `card conservation after turn ${turns}`);
  }
}

test('startTowerRound: the stage bots after the human, who moves first, timer off', () => {
  const g = towerGame(8);
  assert.deepStrictEqual(g.startTowerRound(), { ok: true });
  assert.strictEqual(g.phase, 'playing');
  assert.deepStrictEqual(g.players.map((p) => (p.isBot ? p.botDifficulty : 'human')), ['human', 'zen', 'hard', 'hard']);
  assert.strictEqual(g.currentPlayer().id, 'me');
  assert.strictEqual(g.houseRules.turnTimerSeconds, 0);
  assert.ok(g.log.some((e) => e.text === 'Kartenhaus, Etage 8: Hol in dieser Runde mehr Punkte als jeder Bot - die Bots bekommen 40 Punkte Vorgabe.'));
  assert.ok(conserved(g));
  assert.match(g.startTowerRound().error, /lässt sich nicht starten/, 'only from the lobby');
  assert.strictEqual(g.seatStatus('me').tower, 8);
  assert.strictEqual(g.publicState('me').towerStage, 8);
  g.destroy();
  const plain = new GameManager(() => {});
  assert.ok(plain.startTowerRound().error, 'not a tower table');
  plain.destroy();
});

test('every try deals the same cards (the seed fixes deck and cut)', () => {
  const hands = [1, 2].map(() => {
    const g = towerGame(5);
    g.startTowerRound();
    const ids = g.players.map((p) => p.hand.map((c) => c.id).join(','));
    g.destroy();
    return ids;
  });
  assert.deepStrictEqual(hands[0], hands[1]);
});

test('a stage is one round: game over after it, the record carries the stage', () => {
  for (const stage of [3, 6]) {
    let record = null;
    const g = towerGame(stage, { onGameOver: (r, rec) => { record = rec; } });
    g.startTowerRound();
    playOut(g);
    assert.strictEqual(g.phase, 'gameOver', `stage ${stage}: over after one round`);
    assert.strictEqual(g.roundNumber, 1);
    assert.ok(record, 'onGameOver ran');
    assert.strictEqual(record.towerStage, stage);
    assert.strictEqual(record.rounds.length, 1);
    const out = outcomeFromRecord(record, 'me');
    assert.ok(out, 'gradable');
    // The match winner says the same as the stars: the human wins exactly with a star.
    assert.strictEqual(g.gameOverInfo.winnerId === 'me', out.stars >= 1, `stage ${stage}: winner and stars agree`);
    g.destroy();
  }
});

test('solo and frozen: nobody joins, rules and bot levels stay, leaving ends it without stars', () => {
  let recorded = false;
  const g = towerGame(4, { onGameOver: () => { recorded = true; } });
  g.startTowerRound();
  assert.strictEqual(g.isSoloMode(), true);
  assert.strictEqual(g.addOrReconnectPlayer('p2', 'Ben'), null, 'no join by code');
  assert.match(g.setHouseRules({ handAusDoubles: true }).error, /Kartenhaus/);
  assert.strictEqual(g.houseRules.handAusDoubles, false, 'unchanged');
  const bot = g.players.find((p) => p.isBot);
  assert.match(g.setBotDifficulty('me', bot.id, 'easy').error, /Kartenhaus/);
  assert.match(g.setAllBotsDifficultyBy('me', 'easy').error, /Kartenhaus/);
  assert.strictEqual(bot.botDifficulty, 'hard');
  assert.strictEqual(g.isBotControlled(g.players[0]), false, 'no bot takes the human seat');
  assert.deepStrictEqual(g.abandonSeat('me'), { outcome: 'ended' });
  assert.strictEqual(g.phase, 'abandoned');
  assert.strictEqual(recorded, false, 'no verdict for a stage given up');
  g.destroy();
});

test('snapshot roundtrip: a running stage comes back as a tower stage and still ends after its round', () => {
  const g = towerGame(2);
  g.startTowerRound();
  for (let i = 0; i < 6 && g.phase === 'playing'; i++) {
    const cp = g.currentPlayer();
    g.runBotTurn(cp.id, { forced: !cp.isBot });
  }
  const state = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  assert.strictEqual(state.towerStage, 2);
  let record = null;
  const back = new GameManager(() => {}, { onGameOver: (r, rec) => { record = rec; } });
  back.deserialize(state);
  assert.strictEqual(back.towerStage, 2);
  assert.strictEqual(back.isSoloMode(), true);
  assert.ok(conserved(back));
  back.addOrReconnectPlayer('me', 'Ada'); // the player comes back after the restart
  playOut(back);
  assert.strictEqual(back.phase, 'gameOver');
  assert.strictEqual(record.towerStage, 2);
  back.destroy();
});

// --- Storage + badges -------------------------------------------------------------

test('best stars per month and floor, never worse; XP once per floor and month, the crown once more', () => {
  const store = createPlayerStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-tower-')), 'players.json'));
  const OCT = '2026-10';
  const NOV = '2026-11';
  let r = store.recordTowerResult('Ada', NOV, 1, 1);
  assert.deepStrictEqual({ best: r.best, improved: r.improved, stars: r.stars, cleared: r.cleared, unlocked: r.unlocked, crowned: r.crowned },
    { best: { 1: 1 }, improved: true, stars: 1, cleared: 1, unlocked: 2, crowned: false });
  assert.deepStrictEqual([r.xp, r.totalXp, store.getPlayerByName('Ada').xp], [10, 10, 10], 'the first star pays into the profile');
  r = store.recordTowerResult('ada', NOV, 1, 3);
  assert.strictEqual(r.improved, true);
  assert.strictEqual(r.xp, 0, 'more stars on the same floor pay nothing');
  r = store.recordTowerResult('ADA', NOV, 1, 2);
  assert.strictEqual(r.improved, false, 'a worse try never overwrites');
  assert.strictEqual(store.recordTowerResult('Ada', NOV, 2, 0).xp, 0, 'a missed floor pays nothing');
  assert.strictEqual(store.recordTowerResult('Ada', '2026-12', 1, 1).xp, 10, 'a new month pays again');
  assert.strictEqual(store.getPlayerByName('Ada').gamesPlayed, 0, 'no game counted');
  assert.deepStrictEqual(store.towerBest('Ada', NOV), { 1: 3 });
  assert.deepStrictEqual(store.towerBest('Ada', OCT), {});
  const copy = store.towerBest('Ada', NOV);
  copy[1] = 0;
  assert.deepStrictEqual(store.towerBest('Ada', NOV), { 1: 3 }, 'a copy, not the profile');

  // A profile from the fixed tower: its stars are October's, already paid (25 each back then).
  const raw = store.loadStore();
  raw.players.find((x) => x.name === 'Ada').tower = { 1: 3, 2: 1 };
  store.saveStore(raw);
  assert.deepStrictEqual(store.towerBest('Ada', OCT), { 1: 3, 2: 1 });
  assert.strictEqual(store.recordTowerResult('Ada', OCT, 2, 3).xp, 0, 'an old starred floor does not pay twice');
  assert.strictEqual(store.recordTowerResult('Ada', OCT, 3, 1).xp, 10, 'a new floor in October pays');
  assert.deepStrictEqual(store.towerBest('Ada', OCT), { 1: 3, 2: 3, 3: 1 }, 'old and new merged');
  assert.deepStrictEqual(store.towerMonths('Ada').map((m) => [m.month, m.stars]), [['2026-12', 1], [NOV, 3], [OCT, 7]], 'newest first');

  // Crown: every floor of a month with a star pays 50 once, never twice.
  for (const s of TOWER_STAGES.slice(1, 19)) store.recordTowerResult('Ada', NOV, s.stage, 1);
  const before = store.getPlayerByName('Ada').xp;
  r = store.recordTowerResult('Ada', NOV, 20, 1);
  assert.deepStrictEqual([r.crowned, r.crownedNow, r.xp], [true, true, 60], 'first star plus the crown');
  assert.strictEqual(store.getPlayerByName('Ada').xp, before + 60);
  r = store.recordTowerResult('Ada', NOV, 20, 3);
  assert.deepStrictEqual([r.crowned, r.crownedNow, r.xp], [true, false, 0], 'a crowned month pays no more');

  // Badge counters: the best month (like the old ten-stage tower), crowns over all months.
  let p = store.getPlayerByName('Ada');
  assert.strictEqual(p.towerCrownedMonths, 1);
  assert.strictEqual(p.towerCleared, 20, 'floors of the best month');
  assert.strictEqual(p.towerStars, 3 + 18 + 3, 'stars of the best month, not the sum of all months');
  assert.strictEqual(r.totalStars, 24 + 1 + 7, 'the total over all months rides along');
  let fam = familyBadges(p);
  for (const id of ['tower_3', 'tower_6', 'tower_10', 'tower_crowned_1']) {
    assert.ok(BADGE_IDS.includes(id), `${id} is a badge`);
    assert.ok(fam.includes(id), `${id} earned`);
  }
  assert.ok(!fam.includes('tower_stars_30') && !fam.includes('tower_crowned_3'), '24 stars in one month are not 30');
  for (const stage of [2, 3, 4]) store.recordTowerResult('Ada', NOV, stage, 3);
  p = store.getPlayerByName('Ada');
  assert.strictEqual(p.towerStars, 30);
  fam = familyBadges(p);
  assert.deepStrictEqual(store.awardBadges('Ada', fam).filter((id) => id.startsWith('tower')).sort(),
    ['tower_10', 'tower_3', 'tower_6', 'tower_crowned_1', 'tower_stars_30']);
  assert.deepStrictEqual(store.awardBadges('Ada', familyBadges(p)), [], 'each badge once');
});

test('migration: the old fixed tower is October 2026, floors 1-10 - no XP twice, nothing taken away', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-tower-mig-'));
  const file = path.join(dir, 'players.json');
  // A profile as the fixed tower left it: ten stages starred, 250 XP paid, its badges earned.
  const old = { 1: 3, 2: 3, 3: 2, 4: 2, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1 };
  const earned = { tower_3: 1, tower_6: 2, tower_10: 3 };
  fs.writeFileSync(file, JSON.stringify({ players: [
    { id: 'p1', name: 'Oma', gamesPlayed: 9, xp: 400, tower: old, towerStars: 16, towerCleared: 10, badges: { ...earned } },
  ] }));
  const store = createPlayerStore(file);
  const OCT = BotTower.LEGACY_MONTH;
  assert.strictEqual(OCT, '2026-10');
  assert.deepStrictEqual(store.towerBest('Oma', OCT), old, 'the old stars are October\'s floors 1-10');
  assert.deepStrictEqual(store.towerBest('Oma', OCT), old, 'idempotent: reading changes nothing');
  assert.strictEqual(unlockedStage(store.towerBest('Oma', OCT)), 11, 'floor 10 starred: floor 11 is next');
  assert.deepStrictEqual(summarize(store.towerBest('Oma', OCT)), { stars: 16, cleared: 10, unlocked: 11, crowned: false });
  assert.deepStrictEqual(store.towerBest('Oma', '2026-11'), {}, 'November starts empty');
  assert.deepStrictEqual(store.towerMonths('Oma').map((m) => [m.month, m.stars, m.cleared]), [[OCT, 16, 10]], 'October in the archive later');

  // Replaying an old floor pays nothing (its 25 XP were paid), even with more stars.
  let r = store.recordTowerResult('Oma', OCT, 5, 3);
  assert.deepStrictEqual([r.xp, r.improved, r.best[5]], [0, true, 3]);
  // Floor 11 is new: its first star pays 10.
  r = store.recordTowerResult('Oma', OCT, 11, 1);
  assert.deepStrictEqual([r.xp, r.unlocked, r.stars], [10, 12, 19]);
  let p = store.getPlayerByName('Oma');
  assert.strictEqual(p.xp, 410, 'the old XP stay, only the new star added');
  assert.deepStrictEqual(p.tower, old, 'the old field is kept as it was');
  assert.deepStrictEqual(p.towers[OCT], { 5: 3, 11: 1 }, 'only new results are written');
  assert.deepStrictEqual(Object.keys(p.badges).sort(), Object.keys(earned).sort(), 'badges stay');
  assert.ok(familyBadges(p).includes('tower_10'), 'and stay earned by the counters');
  assert.strictEqual(p.towerCleared, 11);
  assert.strictEqual(p.towerStars, 19);

  // A worse October try never lowers a migrated floor; the counters never shrink.
  r = store.recordTowerResult('Oma', OCT, 1, 1);
  assert.deepStrictEqual([r.xp, r.improved, r.best[1]], [0, false, 3]);
  store.recordTowerResult('Oma', '2026-11', 1, 1);
  p = store.getPlayerByName('Oma');
  assert.deepStrictEqual([p.towerStars, p.towerCleared], [19, 11], 'a weak new month keeps the best one');
  assert.deepStrictEqual(store.towerMonths('Oma').map((m) => [m.month, m.stars]), [['2026-11', 1], [OCT, 19]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Real server ------------------------------------------------------------------

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

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => reject(new Error('socket did not open')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
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

async function ask(ws, msg, replyType) {
  const reply = next(ws, replyType);
  ws.send(JSON.stringify(msg));
  return reply;
}

async function startServer(t, env = {}, prepare = null) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-tower-srv-'));
  if (prepare) prepare(dataDir); // seed the data dir (accounts, a session snapshot) before the boot
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('bot_tower'), PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ONNX: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) { try { s.close(); } catch (e) { /* closing */ } }
    // SIGTERM still writes the snapshot: removing the dir before exit raced (ENOTEMPTY).
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(port);
  return { dataDir, socket: async () => { const s = await openSocket(port); sockets.push(s); return s; } };
}

test('server: getTower lists this month\'s floors, startTower checks the lock and seats a solo floor', async (t) => {
  const srv = await startServer(t);
  const ws = await srv.socket();
  const info = await ask(ws, { type: 'getTower', name: 'Ada' }, 'towerInfo');
  assert.strictEqual(info.stages.length, 20);
  assert.ok(info.stages.every((s) => !('seed' in s)), 'no seeds over the wire');
  assert.deepStrictEqual(info.stages[19].mods, ['queen', 'noDiscard', 'goOut']);
  const { gameDay } = require('../game/GameDay');
  assert.deepStrictEqual({ month: info.month, best: info.best, stars: info.stars, cleared: info.cleared, unlocked: info.unlocked, crowned: info.crowned,
    clearMargin: info.clearMargin, totalStars: info.totalStars, archive: info.archive },
  { month: BotTower.monthOf(gameDay()), best: {}, stars: 0, cleared: 0, unlocked: 1, crowned: false, clearMargin: 100, totalStars: 0, archive: [] });

  const locked = await ask(ws, { type: 'startTower', stage: 2, name: 'Ada' }, 'error');
  assert.match(locked.error, /noch gesperrt/);
  const unknown = await ask(ws, { type: 'startTower', stage: 99, name: 'Ada' }, 'error');
  assert.match(unknown.error, /gibt es nicht/);

  const joined = next(ws, 'joined');
  const state = new Promise((resolve) => {
    ws.on('message', function onMsg(raw) {
      const m = JSON.parse(raw);
      if (m.type === 'state' && m.state.phase === 'playing') { ws.off('message', onMsg); resolve(m.state); }
    });
  });
  ws.send(JSON.stringify({ type: 'startTower', stage: 1, name: 'Ada' }));
  const j = await joined;
  const s = await state;
  assert.deepStrictEqual([s.towerStage, s.towerMonth], [1, info.month]);
  assert.deepStrictEqual(s.players.map((p) => (p.isBot ? p.botDifficulty : 'human')), ['human', 'easy', 'easy']);
  assert.strictEqual(s.currentPlayerId, j.playerId, 'the human opens');

  // Nobody joins a tower stage by its code.
  const ben = await srv.socket();
  const refused = await ask(ben, { type: 'joinSession', code: j.sessionCode, name: 'Ben' }, 'error');
  assert.match(refused.error, /voll/);
});

test('server: public mode keeps no profiles, so the tower is off', async (t) => {
  const srv = await startServer(t, { PIKDAME_PUBLIC_MODE: '1' });
  const ws = await srv.socket();
  const info = await ask(ws, { type: 'getTower', name: 'Ada' }, 'towerInfo');
  assert.deepStrictEqual(info.best, {});
  const off = await ask(ws, { type: 'startTower', stage: 1, name: 'Ada' }, 'error');
  assert.match(off.error, /auf diesem Server ist es aus/);
});

test('server: a profile from the fixed tower climbs on at floor 11 in October, later it is the archive', async (t) => {
  const old = { 1: 3, 2: 3, 3: 2, 4: 2, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1 };
  const srv = await startServer(t, {}, (dataDir) => {
    fs.writeFileSync(path.join(dataDir, 'players.json'), JSON.stringify({ players: [
      { id: 'p1', name: 'Oma', gamesPlayed: 9, xp: 400, tower: old, towerStars: 16, towerCleared: 10, badges: { tower_10: 1 } },
    ] }));
  });
  const ws = await srv.socket();
  const info = await ask(ws, { type: 'getTower', name: 'Oma' }, 'towerInfo');
  assert.strictEqual(info.totalStars, 16, 'the old stars count');
  if (info.month === BotTower.LEGACY_MONTH) {
    // Right after the update: October holds the old stars and floor 11 is open.
    assert.deepStrictEqual([info.best, info.unlocked, info.stars, info.archive], [old, 11, 16, []]);
    const state = new Promise((resolve) => {
      ws.on('message', function onMsg(raw) {
        const m = JSON.parse(raw);
        if (m.type === 'state' && m.state.phase === 'playing') { ws.off('message', onMsg); resolve(m.state); }
      });
    });
    ws.send(JSON.stringify({ type: 'startTower', stage: 11, name: 'Oma' }));
    const s = await state;
    assert.deepStrictEqual([s.towerStage, s.towerMonth, s.towerMods], [11, '2026-10', ['queen']]);
    const me = s.players.find((p) => !p.isBot);
    assert.ok(me.hand.some((c) => c.rank === 'Q' && c.suit === 'S'), 'floor 11: the Queen of Spades in hand');
  } else {
    // A later month: October is the read-only archive with the old stars.
    assert.deepStrictEqual([info.best, info.unlocked], [{}, 1]);
    assert.deepStrictEqual(info.archive.map((m) => [m.month, m.stars, m.cleared, m.crowned]), [['2026-10', 16, 10, false]]);
    assert.deepStrictEqual(info.archive[0].best, old);
  }
});

// --- XP for a stage's first star, through the real server ---------------------------
const { createPgAccountStore } = require('../game/PgAccountStore');

/** A stage-1 table one discard from its end: the human has melded all but one card. */
function stageAtTheEnd(playerId, name) {
  const g = new GameManager(() => {}, { deckSeed: BotTower.stageConfig(1).seed, towerStage: 1 });
  g.addOrReconnectPlayer(playerId, name);
  g.syncLobbyBots();
  g.startTowerRound();
  const me = g.players.find((p) => p.id === playerId);
  me.laidOutCards = me.hand.slice(1);
  me.hand = me.hand.slice(0, 1);
  g.turnPhase = 'meld'; // as if drawn: the last card is the discard that goes out
  const lastCardId = me.hand[0].id;
  const state = JSON.parse(JSON.stringify(g.serialize()));
  g.destroy();
  return { state, lastCardId };
}

function inbox(ws) {
  const box = [];
  ws.on('message', (raw) => { try { box.push(JSON.parse(raw)); } catch (e) { /* binary */ } });
  return box;
}

async function waitIn(box, type, timeoutMs = 4000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    const m = box.find((x) => x.type === type);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${type}`);
}

test('server: the first star pays 10 XP (account and season too), a repeat and a guest only what is theirs', async (t) => {
  const tables = {
    first: { code: 'TWRAA2', id: 'p-ada1', token: 'tok-ada1', name: 'Ada', ...stageAtTheEnd('p-ada1', 'Ada') },
    again: { code: 'TWRAA3', id: 'p-ada2', token: 'tok-ada2', name: 'Ada', ...stageAtTheEnd('p-ada2', 'Ada') },
    guest: { code: 'TWRBB4', id: 'p-ben', token: 'tok-ben', name: 'Ben', ...stageAtTheEnd('p-ben', 'Ben') },
  };
  const databaseUrl = testDatabaseUrl('bot_tower');
  const accounts = createPgAccountStore(databaseUrl);
  await accounts.verifyEmail((await accounts.register('Ada', 'ada@example.com', 'geheim123')).verifyToken);
  const accountToken = (await accounts.login('Ada', 'geheim123')).token;
  await accounts.close();
  const srv = await startServer(t, { PIKDAME_DATABASE_URL: databaseUrl }, (dataDir) => {
    const now = Date.now();
    const sessions = Object.values(tables).map((x) => ({
      code: x.code, createdAt: now, lastActivity: now, playerTokens: { [x.id]: x.token }, stammtisch: null, state: x.state,
    }));
    fs.writeFileSync(path.join(dataDir, 'sessions-snapshot.json'), JSON.stringify({ savedAt: now, sessions }));
  });

  /** Back at the restored table, then the last card: the verdict and what followed it. */
  const finish = async (x, withAccount) => {
    const ws = await srv.socket();
    const box = inbox(ws);
    ws.send(JSON.stringify({ type: 'joinSession', code: x.code, playerId: x.id, playerToken: x.token, name: x.name, accountToken: withAccount ? accountToken : undefined }));
    await waitIn(box, 'joined');
    ws.send(JSON.stringify({ type: 'discard', cardId: x.lastCardId }));
    const verdict = await waitIn(box, 'towerResult');
    await new Promise((r) => setTimeout(r, 300)); // room for the account booking
    return { verdict, account: box.find((m) => m.type === 'accountProgress') || null };
  };

  const first = await finish(tables.first, true);
  assert.ok(first.verdict.stars >= 1, 'went out far ahead: a star');
  assert.strictEqual(first.verdict.xp, 10);
  assert.strictEqual(first.verdict.month, '2026-10', 'a snapshot from before the monthly tower counts for its first month');
  assert.strictEqual(first.verdict.level.total, 10, 'level bookkeeping like the solved puzzle');
  assert.ok(first.account, 'the account is booked');
  assert.deepStrictEqual([first.account.progress.xp, first.account.progress.seasonXp, first.account.progress.games], [10, 10, 0],
    'lifetime and season XP, no game counted');

  const again = await finish(tables.again, true);
  assert.strictEqual(again.verdict.xp, 0, 'a repeat of a cleared stage pays nothing');
  assert.strictEqual(again.account, null, 'nor books the account');

  const guest = await finish(tables.guest, false);
  assert.strictEqual(guest.verdict.xp, 10, 'a guest earns the profile XP');
  assert.strictEqual(guest.account, null, 'but has no account to book');

  const ws = await srv.socket();
  const profiles = await ask(ws, { type: 'listProfiles' }, 'profiles');
  const p = (name) => profiles.players.find((x) => x.name === name);
  assert.deepStrictEqual([p('Ada').xp, p('Ada').gamesPlayed], [10, 0], 'profile: XP once, no game');
  assert.deepStrictEqual([p('Ben').xp, p('Ben').gamesPlayed], [10, 0]);
});

/** Plays floor `stage` out (human seat forced to the heuristic) and returns who discarded what. */
function towerTrace(stage, { random = Math.random, restoreAt = -1 } = {}) {
  const orig = Math.random;
  Math.random = random;
  try {
    let g = towerGame(stage);
    g.startTowerRound();
    const trace = [];
    let turns = 0;
    while (g.phase === 'playing' && turns++ < 3000) {
      if (turns === restoreAt) { // a server restart mid-floor
        const fresh = new GameManager(() => {});
        fresh.deserialize(JSON.parse(JSON.stringify(g.serialize())));
        g.destroy();
        g = fresh;
      }
      const cp = g.currentPlayer();
      g.runBotTurn(cp.id, { forced: !cp.isBot });
      assert.ok(conserved(g), `card conservation after turn ${turns}`);
      trace.push(`${cp.id}:${g.discardPile[0] ? g.discardPile[0].id : '-'}`);
    }
    g.destroy();
    return trace.join(' ');
  } finally {
    Math.random = orig;
  }
}

test('easy bots on a floor draw their luck from the deal: one line of play, one game', () => {
  assert.ok(TOWER_STAGES[0].bots.includes('easy') && TOWER_STAGES[1].bots.includes('easy'));
  for (const stage of [1, 2]) {
    const a = towerTrace(stage, { random: () => 0.01 });
    const b = towerTrace(stage, { random: () => 0.99 });
    assert.strictEqual(a, b, `floor ${stage}: Math.random does not steer the game`);
    assert.strictEqual(towerTrace(stage, { restoreAt: 9 }), a, `floor ${stage}: a restore mid-floor plays on the same`);
  }
});

test('normal tables keep Math.random for the easy bots', () => {
  const orig = Math.random;
  Math.random = () => 0.4242;
  try {
    const plain = new GameManager(() => {}, { deckSeed: 7 }); // a seeded deal alone (challenge) is no floor
    assert.strictEqual(plain._botRandom('discard'), 0.4242);
    plain.destroy();
    const g = towerGame(1);
    const r = g._botRandom('discard');
    assert.ok(r !== 0.4242 && r >= 0 && r < 1);
    assert.strictEqual(g._botRandom('discard'), r, 'same turn, same tag, same draw');
    assert.notStrictEqual(g._botRandom('pile'), r, 'tags draw independently');
    g.destroy();
  } finally {
    Math.random = orig;
  }
  const Bot = require('../game/Bot');
  const hand = createDeck().filter((c) => !c.isJoker).slice(0, 5);
  assert.strictEqual(Bot.chooseDiscard(hand, [], { difficulty: 'easy', random: () => 0.99 }).id, hand[4].id);
});

test('the net plays the human seat only when tooling forces it', async () => {
  const g = towerGame(3);
  g.startTowerRound();
  assert.strictEqual(g.currentPlayer().id, 'me');
  await g._runBotTurnWithOnnx('me');
  assert.strictEqual(g.currentPlayer().id, 'me', 'a solo human seat is never taken over');
  await g._runBotTurnWithOnnx('me', { forced: true });
  assert.notStrictEqual(g.currentPlayer().id, 'me', 'forced (seed tooling): the turn is played');
  assert.ok(conserved(g));
  g.destroy();
});
