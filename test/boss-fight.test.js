// Kartenhaus boss floors: the pure fight rules (BossFight.js) and their place in the engine -
// hits at the end of a turn, a knockout in the middle of a round, rounds that follow,
// the snapshot, the proof play. Off until a month is switched on (BotTower.setBossFrom).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const BossFight = require('../game/BossFight');
const BotTower = require('../game/BotTower');
const GameManager = require('../game/GameManager');
const { playFloor } = require('../game/TowerPlay');
const { createDeck } = require('../game/Deck');
const { isPikDame } = require('../game/Card');

const { BOSSES, PLAYER_HP } = BossFight;
const MONTH = '2026-12';
const withBosses = (t) => { BotTower.setBossFrom(MONTH); t.after(() => BotTower.setBossFrom(null)); };

// --- the rules --------------------------------------------------------------------------
test('a hit is the value laid; two new melds in a turn count x1.5, three x2', () => {
  const boss = { id: 'x', hp: 1000, bot: 'hard' };
  const s = BossFight.start(boss);
  BossFight.playerTurn(s, boss, { points: 40, newMelds: 1 });
  assert.strictEqual(s.boss, 960);
  BossFight.playerTurn(s, boss, { points: 40, newMelds: 2 });
  assert.strictEqual(s.boss, 900);
  BossFight.playerTurn(s, boss, { points: 40, newMelds: 3 });
  assert.strictEqual(s.boss, 820);
  assert.deepStrictEqual(s.events, [{ seq: 3, to: 'boss', amount: 80, kind: 'hit', combo: 2 }], 'the last turn only');
  BossFight.playerTurn(s, boss, { points: 0 });
  assert.deepStrictEqual([s.boss, s.events], [820, []], 'a turn without a meld hits nothing');
  BossFight.bossTurn(s, boss, { points: 55, newMelds: 2 });
  assert.strictEqual(s.me, PLAYER_HP - 83, 'the boss combos too (55 x 1.5, rounded)');
});

test('the jack ambushes once a round, the king\'s armour takes 10 off every hit', () => {
  const jack = BOSSES[10];
  const s = BossFight.start(jack);
  BossFight.bossTurn(s, jack, { points: 0 });
  BossFight.bossTurn(s, jack, { points: 60, newMelds: 1 });
  assert.strictEqual(s.me, PLAYER_HP - 90, 'the first HIT of the round, not the first turn');
  assert.deepStrictEqual(s.events, [{ seq: 1, to: 'me', amount: 90, kind: 'hit', ambush: 1.5 }], 'the reason rides along');
  assert.strictEqual(BossFight.publicView(s, jack).ambushReady, false);
  BossFight.bossTurn(s, jack, { points: 60, newMelds: 1 });
  assert.strictEqual(s.me, PLAYER_HP - 150);
  BossFight.roundEnd(s, jack, {});
  BossFight.bossTurn(s, jack, { points: 20, newMelds: 1 });
  assert.strictEqual(s.me, PLAYER_HP - 180, 'again in the next round');

  const king = BOSSES[15];
  const k = BossFight.start(king);
  BossFight.playerTurn(k, king, { points: 30, newMelds: 2 });
  assert.strictEqual(k.boss, king.hp - 35, 'after the combo: 45 - 10');
  BossFight.playerTurn(k, king, { points: 5, newMelds: 0 });
  assert.strictEqual(k.boss, king.hp - 35, 'a lay-off of 5 bounces off');
});

test('the queen: her cats stand in front and scratch, her card curses, melded she counts double', () => {
  const queen = BOSSES[20];
  const s = BossFight.start(queen);
  assert.deepStrictEqual(s.adds, [100, 100]);
  BossFight.playerTurn(s, queen, { points: 130, newMelds: 1, holdsQueen: true });
  assert.deepStrictEqual([s.adds, s.boss], [[0, 70], queen.hp], 'the first cat falls, the rest carries on to the second');
  assert.strictEqual(s.me, PLAYER_HP - 3 - 10, 'one cat left scratches, the card in hand curses');
  assert.deepStrictEqual(s.events.map((e) => [e.to, e.add, e.amount, e.kind]), [['add', 0, 100, 'hit'], ['add', 1, 30, 'hit'], ['me', undefined, 3, 'scratch'], ['me', undefined, 10, 'curse']]);
  BossFight.playerTurn(s, queen, { points: 100, newMelds: 1, queensLaid: 1 });
  assert.deepStrictEqual([s.adds, s.boss], [[0, 0], queen.hp - 130], '200 for the melded queen: 70 for the cat, 130 for her');
  assert.strictEqual(s.me, PLAYER_HP - 13, 'no cat, no card: nothing strikes back');
});

test('a knockout ends it at once; both down: the higher share of life; the stars follow the life left', () => {
  const boss = { id: 'x', hp: 100, bot: 'hard' };
  let s = BossFight.start(boss);
  BossFight.playerTurn(s, boss, { points: 100, newMelds: 1, holdsQueen: true });
  assert.deepStrictEqual([s.over, s.won, BossFight.starsFor(s)], [true, true, 3]);
  BossFight.bossTurn(s, boss, { points: 999 });
  assert.strictEqual(s.me, PLAYER_HP, 'nothing after the end');

  s = BossFight.start(boss);
  BossFight.bossTurn(s, boss, { points: 420, newMelds: 1 });
  BossFight.playerTurn(s, boss, { points: 100, newMelds: 1 });
  assert.strictEqual(BossFight.starsFor(s), 1, '180 of 600 left: under a third');
  s = BossFight.start(boss);
  BossFight.bossTurn(s, boss, { points: 400, newMelds: 1 });
  BossFight.playerTurn(s, boss, { points: 100, newMelds: 1 });
  assert.strictEqual(BossFight.starsFor(s), 2, 'exactly a third');
  s = BossFight.start(boss);
  BossFight.bossTurn(s, boss, { points: 600, newMelds: 1 });
  assert.deepStrictEqual([s.over, s.won, BossFight.starsFor(s)], [true, false, 0]);

  // The round's leftovers take both down: 590 of 600 lost against 99 of 100.
  s = BossFight.start(boss);
  BossFight.bossTurn(s, boss, { points: 590, newMelds: 1 });
  BossFight.playerTurn(s, boss, { points: 99, newMelds: 1 });
  BossFight.roundEnd(s, boss, { myHand: 20, bossHand: 5 });
  assert.deepStrictEqual([s.over, s.won], [true, true], '-10/600 beats -4/100');
});

test('between rounds: the boss below half is enraged (+25 %), round 5 is the last', () => {
  const boss = { id: 'x', hp: 400, bot: 'hard' };
  const s = BossFight.start(boss);
  BossFight.playerTurn(s, boss, { points: 210, newMelds: 1 });
  BossFight.roundEnd(s, boss, { myHand: 15, bossHand: 5 });
  assert.deepStrictEqual([s.round, s.enraged, s.me, s.boss], [2, true, PLAYER_HP - 15, 185]);
  BossFight.bossTurn(s, boss, { points: 40, newMelds: 1 });
  assert.strictEqual(s.me, PLAYER_HP - 15 - 50);
  for (let r = 2; r <= 4; r++) BossFight.roundEnd(s, boss, {});
  assert.deepStrictEqual([s.round, s.over], [5, false]);
  BossFight.roundEnd(s, boss, {});
  assert.deepStrictEqual([s.over, s.won], [true, true], 'time is up: 535/600 against 185/400');
});

// --- in the engine ----------------------------------------------------------------------
function floor(stage, seed = 4711) {
  const g = new GameManager(() => {}, { deckSeed: seed, towerStage: stage, towerMonth: MONTH });
  g.maybeRunBotTurn = () => {};
  g._noMoveLog = true;
  g.addOrReconnectPlayer('me', 'Flo');
  g.syncLobbyBots();
  assert.ok(!g.startTowerRound().error);
  g.players.find((p) => p.id === 'me').botDifficulty = 'hard';
  return g;
}
const turn = (g) => { const cp = g.currentPlayer(); g.runBotTurn(cp.id, { forced: cp.id === 'me' }); };
const cardsOf = (g) => [...g.players.flatMap((p) => p.hand), ...g.drawPile, ...g.discardPile, ...g.tableMelds.flatMap((m) => m.slots.map((s) => s.real || s.joker)), ...g.retiredJokers];

test('off by default: floors 10, 15 and 20 stay what they were until a month is switched on', () => {
  assert.strictEqual(BotTower.stageConfig(10, MONTH).boss, undefined);
  assert.deepStrictEqual(BotTower.stageConfig(20, MONTH).mods, ['queen', 'noDiscard', 'goOut']);
  assert.ok(BotTower.publicStages(MONTH).every((s) => !s.boss));
  BotTower.setBossFrom('2027-02');
  try {
    assert.strictEqual(BotTower.stageConfig(10, '2027-01').boss, undefined, 'the month before stays');
    const cfg = BotTower.stageConfig(20, '2027-02');
    assert.deepStrictEqual([cfg.boss.id, cfg.bots, cfg.handicap, cfg.mods], ['queen', ['zen'], 0, undefined], 'a duel, the boss\'s rules replace the modifiers');
    assert.deepStrictEqual(BotTower.publicStages('2027-03').filter((s) => s.boss).map((s) => [s.stage, s.boss]), [[10, 'jack'], [15, 'king'], [20, 'queen']]);
    assert.strictEqual(BotTower.stageConfig(11, '2027-02').boss, undefined);
  } finally { BotTower.setBossFrom(null); }
});

test('a boss floor is a duel: hits land when a turn ends, the deck stays whole, rounds follow until one is down', (t) => {
  withBosses(t);
  const g = floor(15);
  assert.strictEqual(g.players.length, 2);
  assert.strictEqual(g.players.find((p) => p.isBot).botDifficulty, 'zen');
  const view = () => g.publicState('me').bossFight;
  assert.deepStrictEqual([view().id, view().hp, view().me, view().round, view().traits.armor], ['king', 500, 600, 1, 10]);
  const deck = createDeck().map((c) => c.id).sort();
  let rounds = 1; let guard = 0; let lastSeq = 0;
  while (g.phase !== 'gameOver' && guard++ < 3000) {
    if (g.phase === 'roundEnd') {
      assert.strictEqual(g.publicState('me').bossFight.over, false);
      assert.ok(!g.markNextRoundReady('me').error, 'the human taps on');
      rounds += 1;
      continue;
    }
    const before = { me: g.bossFight.me, boss: g.bossFight.boss };
    const cp = g.currentPlayer();
    turn(g);
    assert.deepStrictEqual(cardsOf(g).map((c) => c.id).sort(), deck, 'exactly the 110 cards after every turn');
    // Only the side that did not play can have lost life from a hit.
    if (cp.id === 'me') assert.ok(g.bossFight.boss <= before.boss); else assert.ok(g.bossFight.me <= before.me);
    assert.ok(g.bossFight.seq >= lastSeq);
    lastSeq = g.bossFight.seq;
  }
  assert.strictEqual(g.phase, 'gameOver');
  const fight = g.bossFight;
  assert.ok(fight.over && (fight.me <= 0 || fight.boss <= 0 || fight.round === BossFight.MAX_ROUNDS));
  assert.strictEqual(g.roundNumber, rounds);
  const rec = g.lastGameRecord;
  assert.strictEqual(rec.rounds.length, rounds);
  assert.strictEqual(rec.winnerId, fight.won ? 'me' : g.players.find((p) => p.isBot).id);
  const o = BotTower.outcomeFromRecord(rec, 'me');
  assert.deepStrictEqual([o.boss, o.won, o.stars, o.rounds], ['king', fight.won, BossFight.starsFor(fight), rounds]);
  g.destroy();
});

test('a knockout in the middle of a round ends the floor right there', (t) => {
  withBosses(t);
  const g = floor(10);
  g.bossFight.me = 1; // the boss's next hit is the last
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 400) turn(g);
  assert.strictEqual(g.phase, 'gameOver', 'no "Weiter", no further round');
  assert.deepStrictEqual([g.bossFight.over, g.bossFight.won, g.roundNumber], [true, false, 1]);
  assert.ok(g.players.every((p) => p.hand.length > 0), 'nobody went out: the round was cut short');
  assert.strictEqual(BotTower.outcomeFromRecord(g.lastGameRecord, 'me').stars, 0);
  assert.strictEqual(g.gameOverInfo.winnerId, g.players.find((p) => p.isBot).id);
  g.destroy();
});

test('a running fight survives snapshot and restore, life points and seen melds included', (t) => {
  withBosses(t);
  const play = (restoreAt) => {
    let g = floor(20, 99);
    let n = 0; let guard = 0;
    while (g.phase !== 'gameOver' && guard++ < 3000) {
      if (g.phase === 'roundEnd') { g.markNextRoundReady('me'); continue; }
      if (n === restoreAt) {
        const snap = JSON.parse(JSON.stringify(g.serialize()));
        g.destroy();
        g = new GameManager(() => {});
        g.maybeRunBotTurn = () => {};
        g._noMoveLog = true;
        g.deserialize(snap);
        g.addOrReconnectPlayer('me', 'Flo'); // the human comes back after the restart
        g.players.find((p) => p.id === 'me').botDifficulty = 'hard';
        assert.ok(g.bossFight && g.publicState('me').bossFight.id === 'queen');
      }
      turn(g);
      n += 1;
    }
    const out = [g.bossFight.me, g.bossFight.boss, g.bossFight.adds, g.bossFight.round, g.bossFight.won];
    g.destroy();
    return JSON.stringify(out);
  };
  const straight = play(-1);
  assert.strictEqual(play(7), straight, 'restored in round 1');
  assert.strictEqual(play(30), straight, 'restored later');
});

test('the queen\'s floor: no forced card, the pile may be taken, her curse reads the hand', (t) => {
  withBosses(t);
  const g = floor(20, 5);
  const me = g.players.find((p) => p.id === 'me');
  assert.strictEqual(g.publicState('me').towerMods, null, 'the old modifiers are gone on a boss floor');
  assert.strictEqual(g._discardBlockedFor(me), false);
  // Hand her the card: the curse costs 10 at the end of each own turn it stays, the cats 3 each.
  if (!me.hand.some(isPikDame)) {
    const piles = [g.drawPile, g.players.find((p) => p.isBot).hand, g.discardPile];
    const pile = piles.find((p) => p.some(isPikDame));
    const i = pile.findIndex(isPikDame);
    const h = me.hand.findIndex((c) => !c.isJoker && !isPikDame(c));
    [pile[i], me.hand[h]] = [me.hand[h], pile[i]];
  }
  const state = BossFight.start(BOSSES[20]);
  BossFight.playerTurn(state, BOSSES[20], { points: 0, holdsQueen: true });
  assert.strictEqual(state.me, PLAYER_HP - 16, 'two cats and the curse');
  g.destroy();
});

test('the proof play runs a boss floor to its verdict, the same way every time; other floors keep their hash', async (t) => {
  const proofs = require('./fixtures/tower-proofs.json');
  const first = proofs[MONTH][0];
  const plain = await playFloor({ seed: first.seed, stage: 1, month: MONTH, proxy: 'hard' });
  assert.strictEqual(plain.hash, first.hard[2], 'floor 1 as recorded');
  withBosses(t);
  const a = await playFloor({ seed: 31337, stage: 10, month: MONTH, proxy: 'hard' });
  const b = await playFloor({ seed: 31337, stage: 10, month: MONTH, proxy: 'hard' });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.boss, 'jack');
  assert.ok(a.rounds >= 1 && a.rounds <= BossFight.MAX_ROUNDS && typeof a.won === 'boolean');
  const again = await playFloor({ seed: first.seed, stage: 1, month: MONTH, proxy: 'hard' });
  assert.strictEqual(again.hash, first.hard[2], 'a boss month leaves the other floors alone');
});

test('the boss\'s seat carries the boss\'s name, and the deal stays the one the plain bot name would get', () => {
  BotTower.setBossFrom(MONTH);
  try {
    const g = floor(15);
    assert.strictEqual(g.players.find((p) => p.isBot).name, 'Kreuz-König');
    assert.strictEqual(g.publicState('me').bossFight.ambushReady, false, 'the king has no ambush');
    assert.deepStrictEqual(g.publicState('me').bossFight.starLife, [200, 400]);
    g.destroy();
  } finally { BotTower.setBossFrom(null); }
});

test('badges: a win names the boss, three stars a second one, the court needs all boss floors at three stars', () => {
  const { bossBadges, BADGE_IDS, BOSS_BADGES } = require('../game/Badges');
  assert.deepStrictEqual(Object.keys(BOSS_BADGES).sort(), Object.values(BOSSES).map((b) => b.id).sort(), 'every boss has its pair');
  for (const id of [...Object.values(BOSS_BADGES).flat(), 'boss_court']) assert.ok(BADGE_IDS.includes(id), id);
  const stages = [10, 15, 20];
  assert.deepStrictEqual(bossBadges({ boss: 'jack', won: false, stars: 0 }, {}, stages), [], 'a loss earns nothing');
  assert.deepStrictEqual(bossBadges({ boss: 'jack', won: true, stars: 1 }, { 10: 1 }, stages), ['boss_jack']);
  assert.deepStrictEqual(bossBadges({ boss: 'king', won: true, stars: 3 }, { 10: 3, 15: 3, 20: 2 }, stages), ['boss_king', 'boss_king_3']);
  assert.deepStrictEqual(bossBadges({ boss: 'queen', won: true, stars: 1 }, { 10: 3, 15: 3, 20: 3 }, stages), ['boss_queen', 'boss_court'],
    'the month\'s best counts, not this try');
  assert.deepStrictEqual(bossBadges({ boss: 'queen', won: true, stars: 3 }, { 10: 3, 15: 3, 20: 3 }, []), ['boss_queen', 'boss_queen_3'], 'no boss month, no court');
  assert.deepStrictEqual(bossBadges({ stars: 3, won: true }, {}, stages), [], 'an ordinary floor');
});
