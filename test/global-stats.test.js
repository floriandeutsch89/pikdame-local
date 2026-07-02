const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGlobalStatsStore } = require('../game/GlobalStatsStore');

test('GlobalStatsStore: aggregiert Partien, Runden, Pik Damen und Hand-aus', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikstats-')), 'stats.json');
  const store = createGlobalStatsStore(file);
  store.recordGame({
    rounds: [
      {
        isHandAus: true,
        results: {
          p1: { roundScore: 100, breakdown: { pikDameLaidOut: 1, pikDameCount: 0 } },
          p2: { roundScore: -150, breakdown: { pikDameLaidOut: 0, pikDameCount: 1 } },
        },
      },
      {
        isHandAus: false,
        results: {
          p1: { roundScore: 40, breakdown: { pikDameLaidOut: 0, pikDameCount: 0 } },
          p2: { roundScore: 10, breakdown: { pikDameLaidOut: 2, pikDameCount: 0 } },
        },
      },
    ],
  });
  store.flushSync();
  const s = createGlobalStatsStore(file).getStats(); // frisch von Platte
  assert.equal(s.games, 1);
  assert.equal(s.rounds, 2);
  assert.equal(s.pikDamesLaidOut, 3);
  assert.equal(s.pikDamesCaught, 1);
  assert.equal(s.handAusRounds, 1);
});

test('GlobalStatsStore: kaputte/fehlende Datei faellt auf Nullwerte zurueck', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikstats-')), 'stats.json');
  const s = createGlobalStatsStore(file).getStats();
  assert.deepEqual(s, { games: 0, rounds: 0, pikDamesLaidOut: 0, pikDamesCaught: 0, handAusRounds: 0 });
});
