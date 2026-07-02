const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeEarnedBadges } = require('../game/Badges');
const { createPlayerStore } = require('../game/PlayerStore');

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
    ['comeback', 'first_win', 'hand_aus_win', 'pd_laid', 'pd_triple', 'score_500', 'streak_3'].sort()
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
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Ben');
  g.totals = { p1: 850, p2: 200 };
  g.startNewRound();
  assert.ok(g.log.some((e) => /⚠️ Endspurt! Anna steht bei 850 Punkten - ab 1000/.test(e.text)));

  const g2 = new GameManager(() => {});
  g2.addOrReconnectPlayer('p1', 'Anna');
  g2.addOrReconnectPlayer('p2', 'Ben');
  g2.setHouseRules({ strictThreshold: true });
  g2.totals = { p1: 999, p2: 0 };
  g2.startNewRound();
  assert.ok(g2.log.some((e) => /über 1000 endet das Spiel/.test(e.text)));

  const g3 = new GameManager(() => {});
  g3.addOrReconnectPlayer('p1', 'Anna');
  g3.addOrReconnectPlayer('p2', 'Ben');
  g3.totals = { p1: 500, p2: 200 };
  g3.startNewRound();
  assert.ok(!g3.log.some((e) => /Endspurt/.test(e.text)), 'unter 800 keine Ansage');
});
