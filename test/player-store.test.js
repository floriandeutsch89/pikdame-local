// Player profiles in PostgreSQL (game/PlayerStore.js): basics, the profiles
// list, writes racing on one profile, restart, cascading deletes and the
// one-time import of players.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { createPlayerStore, legacyRows } = require('../game/PlayerStore');
const { testPlayerStore } = require('./helpers/player-store');
const { testPool } = require('./helpers/test-db');

function tmpFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-players-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'players.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('upsertPlayerProfile: one profile per name, case-insensitive; empty and unknown names are null', async (t) => {
  const { store } = testPlayerStore(t);
  const p1 = await store.upsertPlayerProfile('Florian');
  const p2 = await store.upsertPlayerProfile(' florian ');
  assert.equal(p1.id, p2.id);
  assert.equal(p2.name, 'Florian', 'the first spelling stays');
  assert.equal(await store.upsertPlayerProfile('  '), null);
  assert.equal(await store.getPlayerByName('Nobody'), null);
  assert.ok(p1.createdAt > 0 && p1.createdAt <= Date.now());
});

test('recordGameResult: statistics over several matches, the lifetime record per name', async (t) => {
  const { store } = testPlayerStore(t);
  await store.recordGameResult([{ name: 'Florian', score: 250, won: true }, { name: 'Anna', score: -40, won: false }]);
  const records = await store.recordGameResult([{ name: 'Florian', score: 100, won: false }, { name: 'Anna', score: 300, won: true }, { name: '' }]);
  assert.deepEqual(records, { anna: { played: 2, won: 1 }, florian: { played: 2, won: 1 } });
  const florian = await store.getPlayerByName('Florian');
  const anna = await store.getPlayerByName('anna');
  assert.deepEqual([florian.gamesPlayed, florian.gamesWon, florian.gamesLost, florian.totalScore, florian.winStreak], [2, 1, 1, 350, 0]);
  assert.deepEqual([anna.gamesPlayed, anna.gamesWon, anna.totalScore, anna.winStreak, anna.bestGameScore], [2, 1, 260, 1, 300]);
});

test('profiles list: the board\'s best by wins and score, the asking player with details, named players without', async (t) => {
  const { store } = testPlayerStore(t);
  for (const [name, wins, score] of [['Ada', 3, 900], ['Ben', 3, 1200], ['Cy', 1, 50], ['Dee', 0, 10]]) {
    for (let i = 0; i < Math.max(1, wins); i++) await store.recordGameResult([{ name, score: score / Math.max(1, wins), won: i < wins }]);
  }
  await store.recordTowerResult('Eve', '2026-10', 1, 2); // a profile without a match
  await store.addProgress('Cy', { xp: 5, date: '2026-10-23', quests: { win_game: 1 } });

  const board = await store.listProfiles({ limit: 2 });
  assert.deepEqual(board.map((p) => p.name), ['Ben', 'Ada'], 'wins, then score; the limit holds');
  assert.ok(board.every((p) => !('quests' in p)), 'no per-day details without asking');

  const mine = await store.listProfiles({ me: 'cy', names: ['Eve', 'Dee', 'nobody'], limit: 2 });
  assert.deepEqual(mine.map((p) => p.name), ['Ben', 'Ada', 'Cy', 'Dee', 'Eve'], 'the board plus me and the table');
  const cy = mine.find((p) => p.name === 'Cy');
  assert.deepEqual(cy.quests, { '2026-10-23': { win_game: 1 } }, 'my own quests ride along');
  assert.deepEqual([cy.seasonalBacks, cy.puzzles], [{}, {}]);
  assert.ok(!('quests' in mine.find((p) => p.name === 'Eve')), 'only mine');
  assert.deepEqual((await store.listProfiles()).map((p) => p.name), ['Ben', 'Ada', 'Cy', 'Dee'], 'no match, not on the board');
});

test('restart: a new store on a new pool reads everything back', async (t) => {
  const { store, pool } = testPlayerStore(t);
  await store.recordGameResult([{ name: 'Flo', score: 120, won: true, facts: { pdLaid: 2 } }]);
  await store.awardBadges('Flo', ['first_win']);
  await store.unlockSeasonalBack('Flo', 'pumpkin', '2026-10-20');
  const pool2 = new Pool({ connectionString: pool.options.connectionString, max: 2 });
  t.after(() => pool2.end());
  const again = createPlayerStore(pool2, { legacyFile: null });
  const p = await again.getPlayerByName('flo');
  assert.deepEqual([p.gamesWon, p.totalQueensLaid, Object.keys(p.badges), p.seasonalBacks], [1, 2, ['first_win'], { pumpkin: '2026-10-20' }]);
});

test('two tabs at once: every write lands exactly once, nothing is lost', async (t) => {
  const { store, pool } = testPlayerStore(t);
  await store.upsertPlayerProfile('Ida');
  const day = '2026-10-23';
  const n = 12;
  const all = (fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

  const progress = await all(() => store.addProgress('Ida', { xp: 5, date: day, quests: { play_games: 1 } }));
  const p = await store.getPlayerByName('Ida');
  assert.equal(p.xp, 5 * n, 'no lost XP');
  assert.deepEqual(p.quests[day], { play_games: n }, 'no lost quest step');
  assert.deepEqual(progress.map((r) => r.before.play_games).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i),
    'each game sees its own "before" (the quest crosses its target exactly once)');

  const badges = await all(() => store.awardBadges('Ida', ['first_win']));
  assert.equal(badges.filter((b) => b.length).length, 1, 'a badge is new exactly once');

  const solves = await all(() => store.recordPuzzleAttempt('Ida', day, true));
  assert.equal(solves.filter((s) => s.justSolved).length, 1, 'one solve pays');
  assert.equal((await store.getPlayerByName('Ida')).totalPuzzlesSolved, 1);

  const floors = await all(() => store.recordTowerResult('Ida', '2026-10', 1, 1));
  assert.equal(floors.reduce((sum, r) => sum + r.xp, 0), 10, 'the first star pays once');

  const streaks = await all(() => store.touchDailyStreak('Ida', day));
  assert.ok(streaks.every((s) => s.streak === 1));

  await all((i) => store.recordGameResult([{ name: i % 2 ? 'Ida' : 'Jo', score: 10, won: true }, { name: i % 2 ? 'Jo' : 'Ida', score: 5, won: false }]));
  const [ida, jo] = [await store.getPlayerByName('Ida'), await store.getPlayerByName('Jo')];
  assert.deepEqual([ida.gamesPlayed, jo.gamesPlayed, ida.gamesWon + jo.gamesWon], [n, n, n], 'two tables with the same names: no deadlock, no loss');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM players')).rows[0].n, 2);
});

test('deleting a player removes the whole profile, its challenge rows and attempts', async (t) => {
  const { store, pool } = testPlayerStore(t);
  await store.recordGameResult([{ name: 'Oma Inge', score: 10, won: true }]);
  await store.awardBadges('Oma Inge', ['first_win']);
  await store.addProgress('Oma Inge', { xp: 1, date: '2026-10-23', quests: { win_game: 1 } });
  await store.recordPuzzleAttempt('Oma Inge', '2026-10-23', true);
  await store.recordTowerResult('Oma Inge', '2026-10', 1, 1);
  await store.unlockSeasonalBack('Oma Inge', 'pumpkin', '2026-10-23');
  const { createChallengeStore } = require('../game/ChallengeStore');
  const challenge = createChallengeStore(pool, { legacyFile: null });
  const today = require('../game/GameDay').gameDay(); // older days fall to the 14-day retention
  await challenge.beginAttempt(today, 'Oma Inge', 'ABC123');
  await challenge.submit(today, 'Oma Inge', 400);
  const { createPlayEvents } = require('../game/PlayEvents');
  await createPlayEvents(pool).record({ name: 'Oma Inge', mode: 'tower', period: '2026-10', stage: 1, outcome: 'won', facts: {} });

  const count = async () => (await pool.query(`SELECT
    (SELECT count(*) FROM player_badges) + (SELECT count(*) FROM player_quests) + (SELECT count(*) FROM player_puzzles)
    + (SELECT count(*) FROM player_tower_stars) + (SELECT count(*) FROM player_card_backs) + (SELECT count(*) FROM challenge_results)
    + (SELECT count(*) FROM challenge_attempts) + (SELECT count(*) FROM play_attempts) AS n`)).rows[0].n;
  assert.equal(Number(await count()), 8);
  assert.equal((await pool.query('SELECT count(DISTINCT player_id)::int AS n FROM challenge_results')).rows[0].n, 1);
  await pool.query("DELETE FROM players WHERE player_key = 'oma inge'");
  assert.equal(Number(await count()), 0, 'one statement deletes a guest');
});

test('legacyRows: every profile field lands in its column or child table; junk is skipped', () => {
  const rows = legacyRows({ players: [
    {
      id: 'profile-1767225600000-ab12cd', name: ' Oma Inge ', gamesPlayed: 9, gamesWon: 4, totalScore: 3500, xp: 420,
      bestGameScore: -20, bestRoundScore: 185, winStreak: 2, lastPlaceStreak: 0, totalQueensLaid: 3, totalQueensCaught: 1,
      totalJokersLaid: 5, totalHandAus: 1, totalChallenges: 2, totalStammtischGames: 1, dailyStreak: 4,
      daily: { streak: 4, last: '2026-10-20', graceAt: '2026-10-18', best: 6 },
      totalPuzzlesSolved: 2, totalPerfectPuzzles: 1, perfectPuzzleStreak: 1, bestPerfectPuzzleStreak: 1, lastPerfectPuzzleDay: '2026-10-19',
      towerStars: 5, towerCleared: 3, towerCrownedMonths: 0, celebration: 'fireworks', favoriteBadges: ['wins', 'wins', 'pd_laid', 'x', 'y'],
      badges: { first_win: 1767225600123, pd_laid: 'soon' }, seasonalBacks: { pumpkin: '2026-10-05', bad: '2026-13-01' },
      quests: { '2026-10-20': { win_game: 1, play_games: 'lots' }, 'yesterday': { win_game: 1 } },
      puzzles: { '2026-10-19': { tries: 1, solved: true, revealed: false, stars: 3 }, '2026-10-20': { tries: 2, solved: false, revealed: true } },
      puzzleStars: { '2026-10-19': 3, '2026-09-01': 2 },
      tower: { 1: 3, 2: 1 }, towers: { '2026-10': { 2: 2, 3: 1 }, '2026-11': { 1: 1, 2: 0 }, 'nope': { 1: 1 } },
      teams: ['old field'],
    },
    { name: 'oma inge', gamesPlayed: 99 }, // the same name again: the old store found the first
    { name: '' }, null, { name: 42 }, { id: 'x', name: 'Neu', gamesWon: 5, gamesPlayed: 2 },
  ] });
  assert.deepEqual(rows.players.map((p) => p.player_key), ['oma inge', 'neu']);
  const oma = rows.players[0];
  assert.deepEqual(oma, {
    player_key: 'oma inge', player_name: 'Oma Inge', created_at: '2026-01-01T00:00:00.000Z', xp: 420, games_played: 9, games_won: 4,
    total_score: 3500, best_game_score: -20, best_round_score: 185, win_streak: 2, last_place_streak: 0, queens_laid: 3,
    queens_caught: 1, jokers_laid: 5, hand_aus_wins: 1, challenges_played: 2, stammtisch_games: 1, daily_streak: 4,
    daily_best_streak: 6, daily_last_day: '2026-10-20', daily_grace_day: '2026-10-18', puzzles_solved: 2, perfect_puzzles: 1,
    perfect_puzzle_streak: 1, best_perfect_puzzle_streak: 1, last_perfect_puzzle_day: '2026-10-19', tower_stars: 5,
    tower_floors_cleared: 3, tower_crowned_months: 0, celebration: 'fireworks', favorite_badges: ['wins', 'pd_laid', 'x'],
  });
  assert.deepEqual([rows.players[1].created_at, rows.players[1].games_won], [null, 2], 'unknown age; never more wins than games');
  assert.deepEqual(rows.badges.map((b) => [b.badge_id, b.earned_at]), [['first_win', '2026-01-01T00:00:00.123Z'], ['pd_laid', null]]);
  assert.deepEqual(rows.cardBacks.map((c) => c.card_back_id), ['pumpkin'], 'no impossible day');
  assert.deepEqual(rows.quests.map((q) => [q.game_day, q.quest_id, q.progress]), [['2026-10-20', 'win_game', 1], ['2026-10-20', 'play_games', 0]]);
  assert.deepEqual(rows.puzzles.map((z) => [z.game_day, z.tries, z.solved, z.revealed, z.stars]),
    [['2026-10-19', 1, true, false, 3], ['2026-10-20', 2, false, true, null], ['2026-09-01', 0, true, false, 2]]);
  assert.deepEqual(rows.towerStars.map((s) => [s.tower_month, s.stage, s.stars]),
    [['2026-10', 1, 3], ['2026-10', 2, 2], ['2026-10', 3, 1], ['2026-11', 1, 1]], 'the old tower merged into its month; no zero');
});

test('import: players.json moves into the tables once, the file is renamed, a second start imports nothing', async (t) => {
  const pool = testPool(t, 'players_import');
  const file = tmpFile(t, { players: [
    { id: 'profile-1767225600000-ab12cd', name: 'Oma Inge', gamesPlayed: 9, gamesWon: 4, totalScore: 3500, xp: 420,
      badges: { first_win: 1767225600123 }, favoriteBadges: ['wins'], towers: { '2026-11': { 1: 3 } },
      quests: { '2026-10-20': { win_game: 1 } }, puzzles: { '2026-10-20': { tries: 1, solved: true, revealed: false, stars: 3 } },
      puzzleStars: { '2026-10-20': 3 }, seasonalBacks: { pumpkin: '2026-10-05' }, daily: { streak: 2, last: '2026-10-20', graceAt: null, best: 2 } },
    { id: 'profile-2', name: 'Ben', gamesPlayed: 1, gamesWon: 1, totalScore: 1000 },
  ] });
  const store = createPlayerStore(pool, { legacyFile: file, now: () => Date.parse('2026-10-21T12:00:00Z') });
  const oma = await store.getPlayerByName('oma inge');
  assert.deepEqual([oma.name, oma.gamesPlayed, oma.gamesWon, oma.totalScore, oma.xp, oma.createdAt],
    ['Oma Inge', 9, 4, 3500, 420, Date.parse('2026-01-01T00:00:00Z')]);
  assert.deepEqual([oma.badges, oma.favoriteBadges, oma.seasonalBacks], [{ first_win: 1767225600123 }, ['wins'], { pumpkin: '2026-10-05' }]);
  assert.deepEqual([oma.quests, oma.puzzles], [{ '2026-10-20': { win_game: 1 } }, { '2026-10-20': { tries: 1, solved: true, revealed: false, stars: 3 } }]);
  assert.deepEqual(oma.daily, { streak: 2, last: '2026-10-20', graceAt: null, best: 2 });
  assert.deepEqual(await store.towerBest('Oma Inge', '2026-11'), { 1: 3 });
  assert.equal(await store.puzzleStarsFor('Oma Inge', '2026-10-20'), 3);
  assert.equal((await store.getPlayerByName('Ben')).createdAt, null, 'an old id without a time: age unknown');
  assert.deepEqual(await store.claimBadgeNotices('Oma Inge'), [], 'imported badges were celebrated back then: no unlock card');
  assert.ok(!fs.existsSync(file) && fs.existsSync(`${file}.migrated`), 'renamed after the commit');
  assert.deepEqual((await pool.query('SELECT source FROM legacy_imports')).rows.map((r) => r.source), ['players.json']);

  // The old file comes back (a rollback and forward again): moved aside, never counted twice.
  fs.renameSync(`${file}.migrated`, file);
  const second = createPlayerStore(pool, { legacyFile: file });
  assert.equal((await second.getPlayerByName('Oma Inge')).gamesPlayed, 9);
  assert.ok(!fs.existsSync(file));
});

test('import: an unreadable file blocks the import (not marked, kept) while profiles keep working; fixed, it merges', async (t) => {
  const pool = testPool(t, 'players_broken');
  const file = tmpFile(t, '{"players": [ {"name": "Oma Inge", "gamesPlayed": 9');
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let store;
  try {
    store = createPlayerStore(pool, { legacyFile: file });
    // Live play before the import: a match, a challenge result (a player row without a profile).
    await store.recordGameResult([{ name: 'Oma Inge', score: 50, won: true }]);
  } finally {
    console.error = orig;
  }
  assert.match(errors.join('\n'), /players\.json import failed, retrying in 10 min/);
  assert.ok(fs.existsSync(file), 'the file stays for the next try');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM legacy_imports')).rows[0].n, 0, 'never marked done');
  assert.equal((await store.getPlayerByName('Oma Inge')).gamesPlayed, 1);

  // Fixed (the next try or start): the file's numbers are added to what was played meanwhile.
  fs.writeFileSync(file, JSON.stringify({ players: [{ id: 'p', name: 'Oma Inge', gamesPlayed: 9, gamesWon: 4, totalScore: 900, xp: 40,
    winStreak: 3, badges: { first_win: 1 }, towers: { '2026-10': { 1: 1 } } }] }));
  const restarted = createPlayerStore(pool, { legacyFile: file });
  const p = await restarted.getPlayerByName('Oma Inge');
  assert.deepEqual([p.gamesPlayed, p.gamesWon, p.totalScore, p.xp, p.winStreak], [10, 5, 950, 40, 4], 'counters add up, the streak goes on');
  assert.deepEqual(p.badges, { first_win: 1 });
  assert.ok(fs.existsSync(`${file}.migrated`));
});

test('import: a file that is no player store throws and is retried, an empty one is fine', async (t) => {
  const { importLegacyFile } = require('../game/PlayerStore');
  const pool = testPool(t, 'players_shape');
  await require('../game/Migrations').ensureMigrated(pool);
  await assert.rejects(importLegacyFile(pool, tmpFile(t, '[1, 2]')), /not a player store/);
  assert.equal(await importLegacyFile(pool, tmpFile(t)), false, 'no file, nothing to do');
  assert.equal(await importLegacyFile(pool, tmpFile(t, { players: [] })), true);
});
