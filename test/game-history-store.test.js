// Finished matches and the anonymous counters on PostgreSQL (migrations/013),
// the one-time import of games.json/stats.json and anonymising a deleted account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGameHistoryStore, statsOfGame } = require('../game/GameHistoryStore');
const { testPool } = require('./helpers/test-db');

const NO_FILES = { legacyGamesFile: null, legacyStatsFile: null };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-history-test-'));

function match(finishedAt, overrides = {}) {
  return {
    players: [{ id: 'p1', name: 'Florian', isBot: false }, { id: 'p2', name: 'Anna', isBot: false }, { id: 'b1', name: 'Bot Bert', isBot: true, botDifficulty: 'hard' }],
    rounds: [
      { roundNumber: 1, winnerId: 'p1', isHandAus: true, results: { p1: { roundScore: 120, breakdown: { pikDameLaidOut: 1 } }, p2: { roundScore: -40, breakdown: { pikDameCount: 1 } } }, totalsAfter: { p1: 120, p2: -40, b1: 10 } },
      { roundNumber: 2, winnerId: 'p1', results: {}, totalsAfter: { p1: 1010, p2: 200, b1: 300 } },
    ],
    finalTotals: { p1: 1010, p2: 200, b1: 300 },
    winnerId: 'p1',
    houseRules: { handAusDoubles: false },
    startedAt: finishedAt - 600000,
    finishedAt,
    ...overrides,
  };
}

test('a saved match comes back as the record GameManager wrote, newest first, by name', async (t) => {
  const store = createGameHistoryStore(testPool(t, 'history'), NO_FILES);
  await store.saveGame(match(1000));
  await store.saveGame(match(2000, { challengeDate: '2026-11-09' }), { stammtisch: true });
  const games = await store.gamesOf('florian');
  assert.equal(games.length, 2);
  const [g] = games;
  assert.equal(g.finishedAt, 2000);
  assert.equal(g.startedAt, 2000 - 600000);
  assert.equal(g.challengeDate, '2026-11-09');
  assert.equal(g.stammtisch, true);
  assert.deepEqual(g.players, [{ id: 'p1', name: 'Florian', isBot: false }, { id: 'p2', name: 'Anna', isBot: false }, { id: 'b1', name: 'Bot Bert', isBot: true, botDifficulty: 'hard' }]);
  assert.deepEqual(g.finalTotals, { p1: 1010, p2: 200, b1: 300 });
  assert.equal(g.rounds.length, 2);
  assert.deepEqual(g.houseRules, { handAusDoubles: false });
  assert.equal(games[1].stammtisch, undefined);
  assert.deepEqual(await store.gamesOf('Bot Bert'), [], 'a bot seat is nobody\'s history');
  assert.deepEqual(await store.gamesOf(''), []);
});

test('no cap of 200: every match is kept, the limit only cuts the answer', async (t) => {
  const store = createGameHistoryStore(testPool(t, 'history'), NO_FILES);
  for (let i = 0; i < 205; i++) await store.saveGame(match(i + 1));
  assert.equal((await store.gamesOf('Anna', 200)).length, 200);
  const newest = await store.gamesOf('Anna', 3);
  assert.deepEqual(newest.map((g) => g.finishedAt), [205, 204, 203]);
});

test('team matches keep both winners, the seat flag says who won', async (t) => {
  const pool = testPool(t, 'history');
  const store = createGameHistoryStore(pool, NO_FILES);
  const players = ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, name: `N${id}`, isBot: false }));
  await store.saveGame(match(5, { players, finalTotals: { p1: 900, p2: 50, p3: 1100, p4: 10 }, winnerId: null, teamMode: true, teams: [['p1', 'p3'], ['p2', 'p4']], winnerIds: ['p1', 'p3'], winnerTeam: 0 }));
  const { rows } = await pool.query('SELECT seat_ref, is_winner FROM game_seats ORDER BY seat_no');
  assert.deepEqual(rows.map((r) => [r.seat_ref, r.is_winner]), [['p1', true], ['p2', false], ['p3', true], ['p4', false]]);
  const [g] = await store.gamesOf('Np1');
  assert.equal(g.teamMode, true);
  assert.deepEqual(g.winnerIds, ['p1', 'p3']);
});

test('the counters grow with every match, also without history (public mode)', async (t) => {
  const pool = testPool(t, 'history');
  const store = createGameHistoryStore(pool, NO_FILES);
  assert.deepEqual(await store.load(), { games: 0, rounds: 0, pikDamesLaidOut: 0, pikDamesCaught: 0, handAusRounds: 0 });
  await store.saveGame(match(1));
  await store.saveGame(match(2), { keepHistory: false });
  const expected = { games: 2, rounds: 4, pikDamesLaidOut: 2, pikDamesCaught: 2, handAusRounds: 2 };
  assert.deepEqual(store.getStats(), expected);
  assert.equal((await store.gamesOf('Florian')).length, 1, 'public mode stores no names');
  assert.deepEqual(await createGameHistoryStore(pool, NO_FILES).load(), expected, 'a restart reads them back');
});

test('statsOfGame: a broken record adds nothing', () => {
  assert.deepEqual(statsOfGame(null), { games: 0, rounds: 0, pikDamesLaidOut: 0, pikDamesCaught: 0, handAusRounds: 0 });
  assert.equal(statsOfGame({ rounds: [null, { results: { p1: null } }] }).rounds, 2);
});

test('a deleted account: its seats lose name and link, the others still see the match', async (t) => {
  const pool = testPool(t, 'history');
  const store = createGameHistoryStore(pool, NO_FILES);
  await store.saveGame(match(1));
  assert.equal(await store.anonymizeName('FLORIAN'), 1);
  assert.deepEqual(await store.gamesOf('Florian'), []);
  const [g] = await store.gamesOf('Anna');
  assert.equal(g.players[0].name, null);
  assert.equal(g.players[0].id, 'p1', 'totals stay readable');
  assert.equal(g.finalTotals.p1, 1010);
  assert.equal(await store.anonymizeName('nobody'), 0);
});

test('games.json and stats.json are imported once, then renamed', async (t) => {
  const pool = testPool(t, 'history');
  const dir = tmpDir();
  const gamesFile = path.join(dir, 'games.json');
  const statsFile = path.join(dir, 'stats.json');
  const old = { id: 'game-1-abc', stammtisch: true, ...match(1700000000000, { challengeDate: '2026-10-01' }) };
  fs.writeFileSync(gamesFile, JSON.stringify({ games: [old, { broken: true }, match(1700000001000)] }));
  fs.writeFileSync(statsFile, JSON.stringify({ games: 40, rounds: 300, pikDamesLaidOut: 7, pikDamesCaught: 9, handAusRounds: 1 }));
  const store = createGameHistoryStore(pool, { legacyGamesFile: gamesFile, legacyStatsFile: statsFile });
  assert.deepEqual(await store.load(), { games: 40, rounds: 300, pikDamesLaidOut: 7, pikDamesCaught: 9, handAusRounds: 1 }, 'imported games are already in the counters');
  const games = await store.gamesOf('Florian');
  assert.equal(games.length, 2, 'the broken entry is skipped');
  assert.equal(games[1].stammtisch, true);
  assert.equal(games[1].challengeDate, '2026-10-01');
  assert.ok(fs.existsSync(`${gamesFile}.migrated`) && fs.existsSync(`${statsFile}.migrated`));
  const { rows } = await pool.query("SELECT created_at FROM players WHERE player_key = 'anna'");
  assert.equal(rows[0].created_at, null, 'a name first seen in the import claims no age');

  // A restored old file is not imported twice.
  fs.writeFileSync(gamesFile, JSON.stringify({ games: [match(5)] }));
  fs.writeFileSync(statsFile, JSON.stringify({ games: 1 }));
  const again = createGameHistoryStore(pool, { legacyGamesFile: gamesFile, legacyStatsFile: statsFile });
  assert.equal((await again.load()).games, 40);
  assert.equal((await again.gamesOf('Florian')).length, 2);
  assert.equal(fs.existsSync(gamesFile), false);
});

test('a broken games.json is not marked imported: the history works, the import retries', async (t) => {
  const pool = testPool(t, 'history');
  const gamesFile = path.join(tmpDir(), 'games.json');
  fs.writeFileSync(gamesFile, '{not json');
  const store = createGameHistoryStore(pool, { legacyGamesFile: gamesFile, legacyStatsFile: null });
  await store.saveGame(match(1));
  assert.equal((await store.gamesOf('Anna')).length, 1);
  const { rows } = await pool.query("SELECT * FROM legacy_imports WHERE source = 'games.json'");
  assert.equal(rows.length, 0);
  assert.ok(fs.existsSync(gamesFile));
});

// --- historyForPlayer: persönliche Spielhistorie fürs Statistik-Overlay -------
const { historyForPlayer } = require('../game/GameHistoryStore');

function sampleGames() {
  return [
    {
      id: 'g-old', finishedAt: 1000, challengeDate: null,
      players: [{ id: 'p1', name: 'Flodex', isBot: false }, { id: 'b1', name: 'Bot', isBot: true }],
      rounds: [1, 2, 3], finalTotals: { p1: 1040, b1: 800 }, winnerId: 'p1',
    },
    {
      id: 'g-new', finishedAt: 2000, challengeDate: '2026-08-12',
      players: [{ id: 'p2', name: 'flodex', isBot: false }, { id: 'p3', name: 'Renate', isBot: false }],
      rounds: [1, 2], finalTotals: { p2: 700, p3: 1010 }, winnerId: 'p3',
    },
    {
      id: 'g-other', finishedAt: 3000, challengeDate: null,
      players: [{ id: 'p4', name: 'Uwe', isBot: false }],
      rounds: [1], finalTotals: { p4: 1000 }, winnerId: 'p4',
    },
  ];
}

test('historyForPlayer: findet nur Partien mit diesem Namen, unabhängig von Groß-/Kleinschreibung', () => {
  const games = historyForPlayer(sampleGames(), 'Flodex');
  assert.equal(games.length, 2, 'Uwe-Partie gehört nicht dazu');
  assert.deepEqual(games.map((g) => g.id), ['g-new', 'g-old'], 'neueste zuerst');
});

test('historyForPlayer: won/myScore beziehen sich auf DIESEN Spieler, nicht auf den Sieger allgemein', () => {
  const [newest, oldest] = historyForPlayer(sampleGames(), 'Flodex');
  assert.equal(oldest.won, true, 'g-old: Flodex (p1) hat gewonnen');
  assert.equal(oldest.myScore, 1040);
  assert.equal(newest.won, false, 'g-new: Renate hat gewonnen, nicht flodex (p2)');
  assert.equal(newest.myScore, 700);
});

test('historyForPlayer: gibt nur das Nötige weiter, keine Runde-für-Runde-Aufzeichnung', () => {
  const [g] = historyForPlayer(sampleGames(), 'Uwe');
  assert.equal(g.rounds, 1, 'Rundenanzahl, nicht das Array selbst');
  assert.equal(Array.isArray(g.rounds), false);
  assert.equal('finishedAt' in g, true);
});

test('historyForPlayer: Bots mit gleichem Namen zählen nicht als der Spieler', () => {
  const games = [{
    id: 'g-bot-name', finishedAt: 1, challengeDate: null,
    players: [{ id: 'b1', name: 'Flodex', isBot: true }],
    rounds: [], finalTotals: {}, winnerId: 'b1',
  }];
  assert.deepEqual(historyForPlayer(games, 'Flodex'), []);
});

test('historyForPlayer: leerer/fehlender Name liefert leere Liste statt eines Fehlers', () => {
  assert.deepEqual(historyForPlayer(sampleGames(), ''), []);
  assert.deepEqual(historyForPlayer(sampleGames(), undefined), []);
});

test('historyForPlayer: respektiert das limit', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `g${i}`, finishedAt: i, challengeDate: null,
    players: [{ id: 'p1', name: 'Flodex', isBot: false }],
    rounds: [], finalTotals: { p1: i }, winnerId: 'p1',
  }));
  assert.equal(historyForPlayer(many, 'Flodex', 20).length, 20);
  assert.equal(historyForPlayer(many, 'Flodex', 5).length, 5);
});

test('historyForPlayer: per round only the totals (chart), never the breakdowns; ids for the mapping', () => {
  const games = [{
    id: 'g-r', finishedAt: 5, startedAt: 1, challengeDate: null, stammtisch: true,
    players: [{ id: 'p1', name: 'Flodex', isBot: false }, { id: 'b1', name: 'Klaus', isBot: true, botDifficulty: 'zen' }],
    rounds: [
      { roundNumber: 1, results: { p1: { roundScore: 50, breakdown: { handPoints: 30 } } }, totalsAfter: { p1: 50, b1: 20 } },
      { roundNumber: 2, results: {}, totalsAfter: { p1: 1010, b1: 300 } },
    ],
    finalTotals: { p1: 1010, b1: 300 }, winnerId: 'p1',
  }];
  const [g] = historyForPlayer(games, 'flodex');
  assert.deepEqual(g.roundTotals, [{ p1: 50, b1: 20 }, { p1: 1010, b1: 300 }]);
  assert.equal(JSON.stringify(g).includes('breakdown'), false, 'no per-round breakdowns');
  assert.equal(g.myId, 'p1');
  assert.equal(g.stammtisch, true);
  assert.equal(g.startedAt, 1);
  assert.deepEqual(g.players[1], { id: 'b1', name: 'Klaus', isBot: true, botDifficulty: 'zen' });
});
