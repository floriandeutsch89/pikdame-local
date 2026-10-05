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

// --- Daily streak --------------------------------------------------------------
test('advanceDailyStreak: consecutive days extend, one gap per week is bridged, more resets', () => {
  const { advanceDailyStreak, streakGraceAvailable } = require('../game/Progression');
  let s = null;
  const step = (d) => { const r = advanceDailyStreak(s, d); s = r.state; return r.event; };
  assert.equal(step('2026-09-01'), 'started');
  assert.equal(step('2026-09-02'), 'extended');
  assert.equal(step('2026-09-02'), 'same', 'a second game on the same day changes nothing');
  assert.equal(s.streak, 2);
  assert.equal(step('2026-09-04'), 'bridged', 'one missed day is bridged by the grace day');
  assert.equal(s.streak, 3);
  assert.equal(streakGraceAvailable(s, '2026-09-05'), false, 'grace is spent for a week');
  assert.equal(step('2026-09-05'), 'extended');
  assert.equal(step('2026-09-07'), 'reset', 'second gap within the same week resets');
  assert.equal(s.streak, 1);
  assert.equal(s.best, 4, 'best streak is remembered');
  assert.equal(streakGraceAvailable(s, '2026-09-11'), true, 'grace is back after seven days');
  assert.equal(step('2026-08-01'), 'same', 'a date from the past never counts twice');
  assert.equal(advanceDailyStreak(s, 'garbage').event, 'same');
});

test('PlayerStore.touchDailyStreak: persists the streak and mirrors it for the badge tiers', () => {
  const store = tempStore();
  store.recordGameResult([{ name: 'Anna', score: 10, won: true }]);
  assert.equal(store.touchDailyStreak('Anna', '2026-09-01').streak, 1);
  assert.equal(store.touchDailyStreak('Anna', '2026-09-02').streak, 2);
  const r = store.touchDailyStreak('Anna', '2026-09-02');
  assert.equal(r.event, 'same');
  assert.equal(store.getPlayerByName('Anna').dailyStreak, 2);
  assert.equal(store.touchDailyStreak('Nobody', '2026-09-02'), null);
  store.flushSync();
  const fresh = createPlayerStore(store.filePath);
  assert.equal(fresh.getPlayerByName('Anna').daily.streak, 2);
});

// --- v2.50: level titles, level rewards, seasonal card backs ------------------
test('level titles: strictly ascending, start at level 1, de/en for every rank (#312)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const block = src.match(/const LEVEL_TITLES = \[([\s\S]*?)\n  \];/);
  assert.ok(block, 'LEVEL_TITLES exists');
  const rows = [...block[1].matchAll(/\[(\d+), '([^']+)', '([^']+)'\]/g)].map((m) => [Number(m[1]), m[2], m[3]]);
  assert.ok(rows.length >= 8);
  assert.equal(rows[0][0], 1, 'everyone has a title from level 1');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i][0] > rows[i - 1][0], `ascending at ${rows[i][1]}`);
});

test('seasonal card backs: the game day decides, the client mirrors the ids (#314)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { seasonalBacksFor, SEASONAL_BACKS, easterSunday } = require('../game/SeasonalBacks');
  const { gameDay } = require('../game/GameDay');
  // 2026-10-31 23:30 German time (CET) is still October; 00:30 is November.
  assert.deepEqual(seasonalBacksFor(gameDay(Date.parse('2026-10-31T22:30:00Z'))), ['pumpkin']);
  assert.deepEqual(seasonalBacksFor(gameDay(Date.parse('2026-10-31T23:30:00Z'))), []);
  assert.deepEqual(seasonalBacksFor('2026-12-10'), ['winter']);
  assert.deepEqual(seasonalBacksFor('2026-12-24'), ['winter', 'christmas'], 'Christmas Eve unlocks both');
  assert.deepEqual(seasonalBacksFor('2026-12-27'), ['winter']);
  // Easter: Good Friday .. Easter Monday, computed per year.
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
  assert.equal(easterSunday(2025), '2025-04-20');
  assert.deepEqual(seasonalBacksFor('2026-04-02'), [], 'Maundy Thursday is too early');
  assert.deepEqual(seasonalBacksFor('2026-04-03'), ['easter']);
  assert.deepEqual(seasonalBacksFor('2026-04-06'), ['easter']);
  assert.deepEqual(seasonalBacksFor('2026-04-07'), []);
  assert.deepEqual(seasonalBacksFor('2027-03-26'), ['easter'], 'Good Friday 2027 in March');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  for (const b of SEASONAL_BACKS) {
    assert.match(src, new RegExp(`id: '${b.id}'[^\\n]*field: 'seasonal'`), `client mirrors ${b.id}`);
  }
  const { createPlayerStore } = require('../game/PlayerStore');
  const store = createPlayerStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikseason-')), 'players.json'));
  store.recordGameResult([{ name: 'Ida', score: 10, won: false }]);
  assert.equal(store.unlockSeasonalBack('Ida', 'pumpkin', '2026-10-05'), true);
  assert.equal(store.unlockSeasonalBack('ida', 'pumpkin', '2026-10-20'), false, 'kept, first date wins');
  assert.equal(store.getPlayerByName('Ida').seasonalBacks.pumpkin, '2026-10-05');
});

test('level rewards: new emotes are level-gated on the server too (#313)', () => {
  const { EMOTE_DEFS } = require('../game/Emotes');
  const lvl = Object.fromEntries(EMOTE_DEFS.map((e) => [e.id, e.level]));
  assert.deepEqual([lvl['🤩'], lvl['🥳'], lvl['💪']], [14, 16, 18]);
});

test('level-up dialog: rewards between two levels and the next reward (#315)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const pick = (name) => src.match(new RegExp(`\\n  function ${name}\\([\\s\\S]*?\\n  \\}\\n`))[0];
  const ctx = {};
  vm.runInNewContext(`${pick('rewardsBetween')}${pick('nextRewards')}\nthis.between = rewardsBetween; this.next = nextRewards;`, ctx);
  const rewards = [
    { level: 5, id: '🍀' }, { level: 6, id: '😎' }, { level: 8, id: '🔥' }, { level: 8, id: 'Kartenhai' }, { level: 10, id: 'master' },
  ];
  assert.deepEqual(ctx.between(rewards, 5, 8).map((r) => r.id), ['😎', '🔥', 'Kartenhai'], 'from is exclusive, to inclusive');
  assert.deepEqual(ctx.between(rewards, 6, 7).map((r) => r.id), [], 'a level without rewards');
  assert.deepEqual(ctx.next(rewards, 6).map((r) => r.id), ['🔥', 'Kartenhai'], 'all items of the next rewarded level');
  assert.deepEqual(ctx.next(rewards, 10).map((r) => r.id), [], 'nothing left');
});

test('level-up dialog: the client markup exists and sits above the result overlay (#315)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const result = html.indexOf('id="resultOverlay"');
  const levelUp = html.indexOf('id="levelUpOverlay"');
  assert.ok(result > 0 && levelUp > result, 'later in the DOM = on top at the same layer');
  assert.doesNotMatch(html.match(/<section id="levelUpOverlay"[^>]*>/)[0], /overlayTop/, 'pause and forfeit stay above it');
});

test('welcome back (#316): first game after 7+ days away flags double XP, nothing else does', () => {
  const store = tempStore();
  store.recordGameResult([{ name: 'Anna', score: 10, won: true }]);
  // New profile: no last day yet, not "back".
  assert.equal(store.touchDailyStreak('Anna', '2026-09-01').welcomeBack, false);
  // 6 days away: normal.
  assert.equal(store.touchDailyStreak('Anna', '2026-09-07').welcomeBack, false);
  // 7 days away: double, but only the first game that day.
  assert.equal(store.touchDailyStreak('Anna', '2026-09-14').welcomeBack, true);
  assert.equal(store.touchDailyStreak('Anna', '2026-09-14').welcomeBack, false);
  assert.equal(store.touchDailyStreak('Anna', '2026-10-26').welcomeBack, true);
});

test('welcome back: server doubles the game XP (progress and ladder) from the streak flag', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const xpFor = \(p\) => xpForGame\(gameRecord, p\.id\) \* \(streaks\[p\.id\] && streaks\[p\.id\]\.welcomeBack \? 2 : 1\)/);
  // Both consumers use the doubled value; quest XP is untouched.
  assert.equal((src.match(/xpForGame\(gameRecord, p\.id\)/g) || []).length, 1);
  assert.match(src, /type: 'progress',\s+gainedXp,\s+welcomeBack,/);
});
