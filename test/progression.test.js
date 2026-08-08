// Cross-game progression: experience/levels, the seasonal ladder and the
// daily quests. Pure logic here; the store side is covered further down
// against a temporary players.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  xpForGame,
  levelFromXp,
  seasonForDate,
  questsForDate,
  questDef,
  evaluateQuests,
  badgeProgress,
  QUEST_IDS,
  QUESTS_PER_DAY,
} = require('../game/Progression');
const { BADGE_IDS } = require('../game/Badges');
const { createPlayerStore } = require('../game/PlayerStore');

function record(overrides = {}) {
  return {
    winnerId: 'p1',
    finalTotals: { p1: 1000, p2: 400 },
    players: [
      { id: 'p1', name: 'Flo', isBot: false },
      { id: 'p2', name: 'Zenzi', isBot: true, botDifficulty: 'zen' },
    ],
    rounds: [
      {
        winnerId: 'p1',
        isHandAus: false,
        results: {
          p1: { roundScore: 160, breakdown: { pikDameLaidOut: 1, jokersLaidOut: 2, pikDameCount: 0 } },
          p2: { roundScore: 40, breakdown: { pikDameLaidOut: 0, jokersLaidOut: 0, pikDameCount: 1 } },
        },
      },
      {
        winnerId: 'p2',
        isHandAus: true,
        results: {
          p1: { roundScore: 90, breakdown: { pikDameLaidOut: 0, jokersLaidOut: 1, pikDameCount: 0 } },
          p2: { roundScore: 200, breakdown: { pikDameLaidOut: 1, jokersLaidOut: 0, pikDameCount: 0 } },
        },
      },
    ],
    ...overrides,
  };
}

test('xpForGame: base for finishing, bonus for winning, slope from the score', () => {
  const rec = record();
  // 10 base + 50 win + round(1000/10) = 160
  assert.equal(xpForGame(rec, 'p1'), 160);
  // loser: 10 base + 0 win + round(400/10) = 50
  assert.equal(xpForGame(rec, 'p2'), 50);
});

test('xpForGame: a negative final total never costs experience', () => {
  const rec = record({ winnerId: 'p2', finalTotals: { p1: -320, p2: 1000 } });
  assert.equal(xpForGame(rec, 'p1'), 10, 'losing badly still pays the base for finishing');
  assert.ok(xpForGame(rec, 'p1') >= 0);
});

test('levelFromXp: the curve rises and never loses experience', () => {
  assert.deepEqual(levelFromXp(0), { level: 1, into: 0, need: 100, total: 0 });
  assert.equal(levelFromXp(99).level, 1);
  assert.equal(levelFromXp(100).level, 2, '100 XP is exactly level 2');
  assert.equal(levelFromXp(100).into, 0);
  assert.equal(levelFromXp(250).level, 3, '100 + 150');
  // Monotone: more XP never means a lower level.
  let prev = 0;
  for (let xp = 0; xp < 20000; xp += 137) {
    const l = levelFromXp(xp).level;
    assert.ok(l >= prev, `level dropped at ${xp} XP`);
    prev = l;
  }
  // Garbage in must not spin or throw.
  assert.equal(levelFromXp(undefined).level, 1);
  assert.equal(levelFromXp(-5).level, 1);
  assert.equal(levelFromXp(Number.MAX_SAFE_INTEGER).level, 200, 'capped, does not hang');
});

test('seasonForDate: one calendar month per season', () => {
  assert.equal(seasonForDate('2026-08-08'), '2026-08');
  assert.equal(seasonForDate('2026-12-31'), '2026-12');
  assert.equal(seasonForDate('kaputt'), '1970-01', 'garbage degrades, never throws');
});

test('questsForDate: deterministic, distinct, and known ids', () => {
  const a = questsForDate('2026-08-08');
  const b = questsForDate('2026-08-08');
  assert.deepEqual(a, b, 'same date = same quests for everyone on the planet');
  assert.equal(a.length, QUESTS_PER_DAY);
  assert.equal(new Set(a).size, QUESTS_PER_DAY, 'no quest twice on the same day');
  for (const id of a) assert.ok(QUEST_IDS.includes(id), `unknown quest id ${id}`);
  // Different days must not all be identical (a broken seed would do that).
  const days = new Set();
  for (let d = 1; d <= 28; d++) days.add(questsForDate(`2026-09-${String(d).padStart(2, '0')}`).join(','));
  assert.ok(days.size > 5, `quests barely vary across a month (${days.size} distinct sets)`);
});

test('evaluateQuests: counts exactly what the game record shows', () => {
  const rec = record();
  const all = evaluateQuests(rec, 'p1', QUEST_IDS);
  assert.equal(all.finish_game, 1);
  assert.equal(all.win_game, 1);
  assert.equal(all.win_rounds_3, 1, 'p1 won one of the two rounds');
  assert.equal(all.meld_queen, 1);
  assert.equal(all.meld_jokers_3, 3);
  assert.equal(all.round_150, 1, 'the 160-point round counts');
  assert.equal(all.clean_hands, 1, 'never caught with the queen');
  assert.equal(all.score_400, 1);
  assert.equal(all.beat_zen, 1, 'won with a zen bot at the table');
  assert.ok(!('hand_aus' in all), 'the hand-aus round was won by p2');

  // The loser's view of the SAME record.
  const other = evaluateQuests(rec, 'p2', QUEST_IDS);
  assert.ok(!('win_game' in other));
  assert.equal(other.hand_aus, 1);
  assert.ok(!('clean_hands' in other), 'p2 was caught with a queen');
});

test('evaluateQuests: unknown ids and broken records degrade to nothing', () => {
  assert.deepEqual(evaluateQuests(record(), 'p1', ['does_not_exist']), {});
  assert.deepEqual(evaluateQuests(null, 'p1', QUEST_IDS), {});
  assert.deepEqual(evaluateQuests({}, 'p1', ['win_rounds_3', 'meld_queen']), {});
});

test('every quest target is reachable and every id has a definition', () => {
  for (const id of QUEST_IDS) {
    const def = questDef(id);
    assert.ok(def, `no definition for ${id}`);
    assert.ok(def.need >= 1, `${id} has a nonsense target`);
  }
});

test('badgeProgress: only countable badges, always clamped to the target', () => {
  const p = { gamesPlayed: 40, totalQueensLaid: 25, winStreak: 9, bestGameScore: 900 };
  const prog = badgeProgress(p);
  assert.equal(prog.marathon_10.have, 10, 'clamped at the target, never above');
  assert.equal(prog.pd_hunter_10.have, 10);
  assert.equal(prog.streak_3.have, 3);
  assert.equal(prog.score_500.have, 500);
  assert.deepEqual(badgeProgress({}).marathon_10, { have: 0, need: 10 }, 'empty profile is fine');
  // Every id it reports must be a real badge - a typo here would show a
  // progress bar on a badge that can never be earned.
  for (const id of Object.keys(prog)) assert.ok(BADGE_IDS.includes(id), `unknown badge ${id}`);
});

// --- Persistence -----------------------------------------------------------

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-prog-'));
  return createPlayerStore(path.join(dir, 'players.json'));
}

test('PlayerStore.addProgress: accumulates XP and daily quest counters', () => {
  const store = tempStore();
  store.upsertPlayerProfile('Flo');
  const first = store.addProgress('Flo', { xp: 160, date: '2026-08-08', quests: { win_game: 1, meld_jokers_3: 2 } });
  assert.equal(first.xp, 160);
  assert.equal(first.gainedXp, 160);
  assert.deepEqual(first.quests, { win_game: 1, meld_jokers_3: 2 });

  const second = store.addProgress('Flo', { xp: 50, date: '2026-08-08', quests: { meld_jokers_3: 1 } });
  assert.equal(second.xp, 210, 'XP adds up across games');
  assert.equal(second.quests.meld_jokers_3, 3, 'quest counters add up within the day');
  assert.equal(store.questProgress('Flo', '2026-08-08').meld_jokers_3, 3);
  assert.deepEqual(store.questProgress('Flo', '2026-08-09'), {}, 'a new day starts empty');
});

test('PlayerStore.addProgress: unknown player and junk input are harmless', () => {
  const store = tempStore();
  assert.deepEqual(store.addProgress('Niemand', { xp: 10 }).completed, []);
  store.upsertPlayerProfile('Flo');
  const r = store.addProgress('Flo', { xp: -50, date: '2026-08-08', quests: { win_game: 'viel' } });
  assert.equal(r.xp, 0, 'negative XP cannot drain a profile');
  assert.equal(r.quests.win_game, 0, 'non-numeric progress counts as nothing');
});

test('PlayerStore.addProgress: quest history is pruned to a week', () => {
  const store = tempStore();
  store.upsertPlayerProfile('Flo');
  for (let d = 1; d <= 12; d++) {
    store.addProgress('Flo', { xp: 1, date: `2026-08-${String(d).padStart(2, '0')}`, quests: { win_game: 1 } });
  }
  const days = Object.keys(store.getPlayerByName('Flo').quests);
  assert.ok(days.length <= 7, `quest history grew unbounded: ${days.length} days`);
  assert.ok(days.includes('2026-08-12'), 'the newest day survives');
  assert.ok(!days.includes('2026-08-01'), 'the oldest day was pruned');
});

test('PlayerStore progression survives a save/load roundtrip', () => {
  const store = tempStore();
  store.upsertPlayerProfile('Flo');
  store.addProgress('Flo', { xp: 300, date: '2026-08-08', quests: { win_game: 1 } });
  store.flushSync(); // writes are debounced - force them out like a shutdown does
  const reopened = createPlayerStore(store.filePath);
  const p = reopened.getPlayerByName('Flo');
  assert.equal(p.xp, 300);
  assert.equal(reopened.questProgress('Flo', '2026-08-08').win_game, 1);
});
