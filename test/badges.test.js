const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeEarnedBadges } = require('../game/Badges');
const { createPlayerStore } = require('../game/PlayerStore');

// v1.67 interactive cutting: unit tests exercise the game AFTER the deal, so
// every locally constructed game auto-cuts. Dedicated cutting tests live in
// test/cutting.test.js and do NOT use this hook.
function __autoCutHook(g) {
  const orig = g.startNewRound.bind(g);
  g.startNewRound = (...a) => {
    orig(...a);
    if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  };
  return g;
}


function record(overrides = {}) {
  return {
    winnerId: 'p1',
    finalTotals: { p1: 620, p2: 300 },
    rounds: [
      {
        isHandAus: true,
        winnerId: 'p1',
        totalsAfter: { p1: -50, p2: 40 },
        results: {
          p1: { breakdown: { pikDameLaidOut: 2, pikDameCount: 0 } },
          p2: { breakdown: { pikDameLaidOut: 0, pikDameCount: 1 } },
        },
      },
      {
        isHandAus: false,
        winnerId: 'p2',
        totalsAfter: { p1: 620, p2: 300 },
        results: {
          p1: { breakdown: { pikDameLaidOut: 1, pikDameCount: 0 } },
          p2: { breakdown: { pikDameLaidOut: 0, pikDameCount: 0 } },
        },
      },
    ],
    ...overrides,
  };
}

test('computeEarnedBadges: Gewinner mit Hand-aus, 3 PD, 500+ und Comeback', () => {
  const earned = computeEarnedBadges(record(), 'p1', { gamesWon: 1, winStreak: 3 });
  assert.deepEqual(
    earned.sort(),
    // no_joker_win: the fixture melds no joker and p1 wins (v2.25);
    // quick_start: the fixture's hand-aus is round 1 (v2.48)
    ['comeback', 'double_queen_round', 'first_win', 'hand_aus_win', 'no_joker_win', 'pd_laid', 'pd_triple', 'quick_start', 'score_500', 'streak_3'].sort()
  );
});

test('computeEarnedBadges: Verlierer bekommt nur das Autsch-Badge', () => {
  const earned = computeEarnedBadges(record(), 'p2', { gamesWon: 0, winStreak: 0 });
  assert.deepEqual(earned, ['pd_caught']);
});

test('PlayerStore: winStreak zaehlt hoch und reisst bei Niederlage ab', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikbadge-')), 'players.json');
  const store = createPlayerStore(file);
  store.recordGameResult([{ name: 'Anna', score: 100, won: true }]);
  store.recordGameResult([{ name: 'Anna', score: 100, won: true }]);
  assert.equal(store.getPlayerByName('Anna').winStreak, 2);
  store.recordGameResult([{ name: 'Anna', score: -50, won: false }]);
  assert.equal(store.getPlayerByName('Anna').winStreak, 0);
});

test('PlayerStore.awardBadges: vergibt nur NEUE Badges und persistiert sie', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikbadge-')), 'players.json');
  const store = createPlayerStore(file);
  store.recordGameResult([{ name: 'Anna', score: 100, won: true }]);
  assert.deepEqual(store.awardBadges('Anna', ['first_win', 'pd_laid']), ['first_win', 'pd_laid']);
  assert.deepEqual(store.awardBadges('Anna', ['first_win', 'score_500']), ['score_500']);
  store.flushSync();
  const fresh = createPlayerStore(file);
  assert.deepEqual(Object.keys(fresh.getPlayerByName('Anna').badges).sort(), ['first_win', 'pd_laid', 'score_500']);
});

test('Endspurt-Ansage erscheint ab 800 Punkten im Log (inkl. strenger Variante)', () => {
  const GameManager = require('../game/GameManager');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Ben');
  g.totals = { p1: 850, p2: 200 };
  g.startNewRound();
  assert.ok(g.log.some((e) => /⚠️ Endspurt! Anna steht bei 850 Punkten - ab 1000/.test(e.text)));

  const g2 = __autoCutHook(new GameManager(() => {}));
  g2.addOrReconnectPlayer('p1', 'Anna');
  g2.addOrReconnectPlayer('p2', 'Ben');
  g2.setHouseRules({ strictThreshold: true });
  g2.totals = { p1: 999, p2: 0 };
  g2.startNewRound();
  assert.ok(g2.log.some((e) => /über 1000 endet das Spiel/.test(e.text)));

  const g3 = __autoCutHook(new GameManager(() => {}));
  g3.addOrReconnectPlayer('p1', 'Anna');
  g3.addOrReconnectPlayer('p2', 'Ben');
  g3.totals = { p1: 500, p2: 200 };
  g3.startNewRound();
  assert.ok(!g3.log.some((e) => /Endspurt/.test(e.text)), 'unter 800 keine Ansage');
});


// --- v1.32.0: new badges --------------------------------------------------------
test('computeEarnedBadges: round_300, zen_slayer, marathon and cumulative queen hunter', () => {
  const rec = record({
    players: [
      { id: 'p1', name: 'Anna', isBot: false },
      { id: 'b1', name: 'Klaus', isBot: true, botDifficulty: 'zen' },
    ],
  });
  rec.rounds[1].results.p1.roundScore = 320;
  const earned = computeEarnedBadges(rec, 'p1', {
    gamesWon: 1, winStreak: 1, gamesPlayed: 10, totalQueensLaid: 11,
  });
  for (const id of ['round_300', 'zen_slayer', 'marathon_10', 'pd_hunter_10']) {
    assert.ok(earned.includes(id), `${id} expected`);
  }
});

test('computeEarnedBadges: zen_slayer requires WINNING against a zen bot', () => {
  const rec = record({
    winnerId: 'p2',
    players: [
      { id: 'p1', name: 'Anna', isBot: false },
      { id: 'b1', name: 'Klaus', isBot: true, botDifficulty: 'zen' },
    ],
  });
  assert.ok(!computeEarnedBadges(rec, 'p1', {}).includes('zen_slayer'));
});

// --- v1.32.0: player records pipeline -------------------------------------------
test('recordGameResult: records and cumulative counters from facts', () => {
  const file = require('path').join(require('os').tmpdir(), `pikdame-store-test-${Date.now()}.json`);
  const store = createPlayerStore(file);
  store.recordGameResult([
    { name: 'Anna', score: 480, won: true, facts: { bestRound: 185, pdLaid: 2, pdCaught: 1, jokersLaid: 3, handAusWins: 1 } },
  ]);
  store.recordGameResult([
    { name: 'Anna', score: 1120, won: true, facts: { bestRound: 140, pdLaid: 1, pdCaught: 0, jokersLaid: 2, handAusWins: 0 } },
  ]);
  const p = store.getPlayerByName('Anna');
  assert.equal(p.bestGameScore, 1120);
  assert.equal(p.bestRoundScore, 185, 'best round survives a weaker second game');
  assert.equal(p.totalQueensLaid, 3);
  assert.equal(p.totalQueensCaught, 1);
  assert.equal(p.totalJokersLaid, 5);
  assert.equal(p.totalHandAus, 1);
  try { require('fs').unlinkSync(file); } catch (e) { /* store may write lazily */ }
});

// --- v2.25: tiers and engine-fact badges -------------------------------------
test('computeEarnedBadges: counter tiers follow the profile, streak/wins tiers only on a win', () => {
  const { BADGE_FAMILIES } = require('../game/Badges');
  const won = computeEarnedBadges(record(), 'p1', {
    gamesWon: 50, gamesPlayed: 100, winStreak: 10, totalQueensLaid: 50, totalHandAus: 5, dailyStreak: 30,
    gamesLost: 100, totalChallenges: 30, totalPuzzlesSolved: 30,
  });
  for (const fam of BADGE_FAMILIES) for (const [id] of fam.tiers) assert.ok(won.includes(id), `winner with maxed counters gets ${id}`);
  const lost = computeEarnedBadges(record(), 'p2', { gamesWon: 50, gamesPlayed: 100, winStreak: 10, totalQueensLaid: 50, dailyStreak: 30 });
  assert.ok(!lost.includes('wins_10') && !lost.includes('streak_5'), 'wins/streak tiers need a win');
  assert.ok(lost.includes('marathon_100') && lost.includes('pd_hunter_50') && lost.includes('daily_30'), 'played/queens/daily tiers do not');
});

test('computeEarnedBadges: ring run, 13-run, pile glutton, zen trio and no-joker win come from the record', () => {
  const rec = record({
    players: [
      { id: 'p1', name: 'A', isBot: false },
      { id: 'b1', isBot: true, botDifficulty: 'zen' }, { id: 'b2', isBot: true, botDifficulty: 'zen' }, { id: 'b3', isBot: true, botDifficulty: 'zen' },
    ],
    rounds: [
      {
        winnerId: 'p1', totalsAfter: { p1: 10, p2: 20 },
        results: {
          p1: { roundScore: 10, breakdown: { ringRuns: 1, longestRun: 13, bigPileTake: true, jokersLaidOut: 0 } },
          p2: { roundScore: -20, breakdown: { ringRuns: 0, longestRun: 4, bigPileTake: true, jokersLaidOut: 2 } },
        },
      },
    ],
  });
  const a = computeEarnedBadges(rec, 'p1', { gamesWon: 1 });
  for (const id of ['ring_run', 'run_13', 'pile_glutton', 'zen_trio', 'zen_slayer', 'no_joker_win']) assert.ok(a.includes(id), id);
  // p2 swallowed a pile too but lost the round - and melded jokers.
  const b = computeEarnedBadges(rec, 'p2', {});
  assert.ok(!b.includes('pile_glutton') && !b.includes('no_joker_win') && !b.includes('ring_run'));
});

test('GameManager: round breakdown carries ring run / longest run / big pile facts', () => {
  const GameManager = require('../game/GameManager');
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Ben');
  g.startNewRound();
  const anna = g.players.find((p) => p.id === 'p1');
  // Hand-built table: a K-A-2 wrap for Anna, a plain 3-4-5 for Ben.
  const kA2 = [makeStandardCard('H', 'K', 0), makeStandardCard('H', 'A', 0), makeStandardCard('H', '2', 0)];
  const r345 = [makeStandardCard('S', '3', 0), makeStandardCard('S', '4', 0), makeStandardCard('S', '5', 0)];
  g.tableMelds = [
    { id: 'm1', ownerId: 'p1', type: 'run', suit: 'H', slots: kA2.map((c) => ({ real: c })) },
    { id: 'm2', ownerId: 'p2', type: 'run', suit: 'S', slots: r345.map((c) => ({ real: c })) },
  ];
  anna.laidOutCards = kA2;
  anna._bigPileTake = true;
  g.finishRound('p1');
  const b1 = g.lastRoundResult.p1.breakdown;
  const b2 = g.lastRoundResult.p2.breakdown;
  assert.equal(b1.ringRuns, 1);
  assert.equal(b1.longestRun, 3);
  assert.equal(b1.bigPileTake, true);
  assert.equal(b2.ringRuns, 0);
  assert.equal(b2.bigPileTake, false);
  // The facts travel into the record the badges are computed from.
  assert.equal(g.roundHistory[0].results.p1.breakdown.ringRuns, 1);
});

test('every badge has a de/en "how to earn" text in the client (#300)', () => {
  const vm = require('node:vm');
  const { BADGE_IDS, BADGE_FAMILIES } = require('../game/Badges');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const m = src.match(/\n  function badgeMeta\(id\) \{[\s\S]*?\n  \}\n/);
  assert.ok(m, 'badgeMeta is defined in client.js');
  for (const lang of ['de', 'en']) {
    const ctx = { L: (de, en) => (lang === 'de' ? de : en) };
    vm.runInNewContext(`${m[0]}\nthis.meta = badgeMeta;`, ctx);
    for (const id of BADGE_IDS) {
      const how = ctx.meta(id).how;
      assert.ok(typeof how === 'string' && how.length > 10, `${id}: missing ${lang} how-to-earn text`);
    }
  }
  // The client's families mirror the server's, so a tapped family tile lists the right tiers.
  const client = src.match(/const BADGE_FAMILIES = \[([\s\S]*?)\n  \];/)[1];
  for (const fam of BADGE_FAMILIES) {
    assert.match(client, new RegExp(`id: '${fam.id}', tiers: \\[${fam.tiers.map(([id]) => `'${id}'`).join(', ')}\\]`), fam.id);
  }
});

// --- v2.48: consolation and curiosity badges -----------------------------------
test('computeEarnedBadges: round facts - cold shower (both queens caught) and joker king (4+ jokers)', () => {
  const rec = record();
  rec.rounds[1].results.p2.breakdown = { pikDameLaidOut: 0, pikDameCount: 2, jokersLaidOut: 0 };
  rec.rounds[1].results.p1.breakdown = { pikDameLaidOut: 1, pikDameCount: 0, jokersLaidOut: 4 };
  assert.ok(computeEarnedBadges(rec, 'p2', {}).includes('cold_shower'));
  assert.ok(computeEarnedBadges(rec, 'p1', {}).includes('joker_king'));
  assert.ok(!computeEarnedBadges(record(), 'p2', {}).includes('cold_shower'), 'one queen is just "Autsch"');
});

test('computeEarnedBadges: final margins - rock bottom, near miss, landslide; quick start only for round 1', () => {
  const close = record({ finalTotals: { p1: 1010, p2: 995 } });
  assert.ok(computeEarnedBadges(close, 'p2', {}).includes('near_miss'), 'lost by 15');
  assert.ok(!computeEarnedBadges(record(), 'p2', {}).includes('near_miss'), 'lost by 320');
  assert.ok(!computeEarnedBadges(close, 'p1', {}).includes('near_miss'), 'the winner never misses');
  const big = record({ finalTotals: { p1: 1100, p2: 600 } });
  assert.ok(computeEarnedBadges(big, 'p1', {}).includes('landslide'), 'won by 500');
  assert.ok(!computeEarnedBadges(record(), 'p1', {}).includes('landslide'), 'won by 320');
  const minus = record({ finalTotals: { p1: 1000, p2: -40 } });
  assert.ok(computeEarnedBadges(minus, 'p2', {}).includes('rock_bottom'));
  assert.ok(!computeEarnedBadges(record(), 'p2', {}).includes('rock_bottom'));
  assert.ok(!computeEarnedBadges(record(), 'p2', {}).includes('quick_start'), 'round 1 was not theirs');
  const late = record();
  late.rounds[0].isHandAus = false;
  late.rounds[1].isHandAus = true;
  late.rounds[1].winnerId = 'p1';
  assert.ok(!computeEarnedBadges(late, 'p1', {}).includes('quick_start'), 'hand out in round 2 is no quick start');
});

test('computeEarnedBadges: night owl by German time, profile streaks and the challenge champion', () => {
  // 23:30Z in October = 01:30 in Germany; 10:00Z = 12:00.
  assert.ok(computeEarnedBadges(record({ finishedAt: Date.parse('2026-10-04T23:30:00Z') }), 'p2', {}).includes('night_owl'));
  assert.ok(!computeEarnedBadges(record({ finishedAt: Date.parse('2026-10-05T10:00:00Z') }), 'p2', {}).includes('night_owl'));
  assert.ok(!computeEarnedBadges(record({ finishedAt: Date.parse('2026-10-05T02:30:00Z') }), 'p2', {}).includes('night_owl'), '04:30 is morning');
  assert.ok(computeEarnedBadges(record(), 'p2', { lastPlaceStreak: 3 }).includes('red_lantern'));
  assert.ok(!computeEarnedBadges(record(), 'p2', { lastPlaceStreak: 2 }).includes('red_lantern'));
  assert.ok(computeEarnedBadges(record(), 'p2', { totalStammtischGames: 10 }).includes('stammtisch_10'));
  assert.ok(computeEarnedBadges(record(), 'p2', {}, { challengeChamp: true }).includes('challenge_champ'));
  assert.ok(!computeEarnedBadges(record(), 'p2', {}).includes('challenge_champ'));
});

test('PlayerStore: losses, last-place streak, challenge/Stammtisch games and solved puzzles are counted', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikbadge-')), 'players.json');
  const store = createPlayerStore(file);
  const game = (won, facts = {}) => store.recordGameResult([{ name: 'Ute', score: 100, won, facts }]);
  game(false, { lastPlace: true, challenge: true });
  game(false, { lastPlace: true, stammtisch: true });
  let u = store.getPlayerByName('Ute');
  assert.deepEqual([u.gamesLost, u.lastPlaceStreak, u.totalChallenges, u.totalStammtischGames], [2, 2, 1, 1]);
  game(true);
  u = store.getPlayerByName('Ute');
  assert.deepEqual([u.gamesLost, u.lastPlaceStreak], [2, 0], 'a game off the bottom resets the streak');
  store.recordPuzzleAttempt('Ute', '2026-10-01', true);
  store.recordPuzzleAttempt('Ute', '2026-10-01', true); // same day again: no second count
  store.revealPuzzle('Ute', '2026-10-02');
  store.recordPuzzleAttempt('Ute', '2026-10-02', true); // revealed first: earns nothing
  assert.equal(store.getPlayerByName('Ute').totalPuzzlesSolved, 1);
  const { familyBadges } = require('../game/Badges');
  assert.deepEqual(familyBadges({ totalPuzzlesSolved: 7, gamesLost: 10, totalChallenges: 30 }).sort(),
    ['challenger_30', 'challenger_7', 'puzzle_7', 'purple_heart_10'].sort());
});

test('ChallengeStore.wasChampion: first place counts only once the day is over', () => {
  const { createChallengeStore } = require('../game/ChallengeStore');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikchamp-')), 'challenges.json');
  const cs = createChallengeStore(file);
  const now = Date.parse('2026-10-05T10:00:00Z');
  cs.submit('2026-10-05', 'Ada', 900, now); // today: still open
  assert.equal(cs.wasChampion('ada', now), false);
  cs.submit('2026-10-04', 'Ben', 300, now);
  cs.submit('2026-10-04', 'Ada', 500, now);
  assert.equal(cs.wasChampion('Ada', now), true);
  assert.equal(cs.wasChampion('Ben', now), false, 'second place is not first');
});

test('client lists every badge exactly once (families + singles)', () => {
  const { BADGE_IDS } = require('../game/Badges');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const fams = src.match(/const BADGE_FAMILIES = \[([\s\S]*?)\n  \];/)[1];
  const singles = src.match(/const BADGE_SINGLES = \[([\s\S]*?)\n  \];/)[1];
  const listed = [...fams.matchAll(/tiers: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]))
    .concat([...singles.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]));
  assert.deepEqual([...listed].sort(), [...BADGE_IDS].sort());
});

test('royal flush: 10-J-Q-K-A of one suit as real cards; pik royal in spades; a joker spoils it', () => {
  const GameManager = require('../game/GameManager');
  const { makeStandardCard, makeJoker } = require('../game/Card');
  const round = (suit, withJoker) => {
    const g = __autoCutHook(new GameManager(() => {}));
    g.addOrReconnectPlayer('p1', 'Anna');
    g.addOrReconnectPlayer('p2', 'Ben');
    g.startNewRound();
    const ranks = ['10', 'J', 'Q', 'K', 'A'];
    const slots = ranks.map((r) => (withJoker && r === 'K'
      ? { joker: makeJoker(0), representsRank: 'K', representsSuit: suit }
      : { real: makeStandardCard(suit, r, 0) }));
    g.tableMelds = [{ id: 'm1', ownerId: 'p1', type: 'run', suit, slots }];
    g.players[0].laidOutCards = slots.map((sl) => sl.real || sl.joker);
    g.finishRound('p1');
    const rec = { winnerId: 'p1', finalTotals: g.totals, rounds: g.roundHistory };
    return computeEarnedBadges(rec, 'p1', {});
  };
  const hearts = round('H', false);
  assert.ok(hearts.includes('royal_flush') && !hearts.includes('pik_royal'));
  const spades = round('S', false);
  assert.ok(spades.includes('royal_flush') && spades.includes('pik_royal'));
  const joker = round('S', true);
  assert.ok(!joker.includes('royal_flush') && !joker.includes('pik_royal'), 'a joker in the royal spots does not count');
});

test('gallery order: unlocked newest first (family = latest tier), locked by progress then name', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const m = src.match(/\n  function achievementOrder\([\s\S]*?\n  \}\n/);
  assert.ok(m, 'achievementOrder is defined in client.js');
  const ctx = {};
  vm.runInNewContext(`${m[0]}\nthis.order = achievementOrder;`, ctx);
  const families = [{ id: 'wins', tiers: ['w1', 'w10'] }, { id: 'games', tiers: ['g10', 'g50'] }];
  const singles = ['zeta', 'alpha', 'mid'];
  const owned = { w1: 100, w10: 500, alpha: 300 };
  const progress = { g10: { have: 9, need: 10 }, mid: { have: 1, need: 3 } };
  const names = { g10: 'Marathon', zeta: 'Zeta', mid: 'Mitte', alpha: 'Alpha', w1: 'Sieg' };
  const r = ctx.order(families, singles, owned, progress, (id) => names[id]);
  assert.deepEqual([...r.unlocked], ['wins', 'alpha'], 'family took its latest tier time (500)');
  assert.deepEqual([...r.locked], ['games', 'mid', 'zeta'], '9/10 before 1/3 before no progress');
});
