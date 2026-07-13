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
    ['comeback', 'double_queen_round', 'first_win', 'hand_aus_win', 'pd_laid', 'pd_triple', 'score_500', 'streak_3'].sort()
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
