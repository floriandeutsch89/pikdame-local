const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGameHistoryStore } = require('../game/GameHistoryStore');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-history-test-'));
  return createGameHistoryStore(path.join(dir, 'games.json'));
}

test('listGames liefert leeres Array, wenn noch keine Datei existiert', () => {
  const store = tmpStore();
  assert.deepEqual(store.listGames(), []);
});

test('saveGame speichert einen vollständigen Spielverlauf inkl. generierter ID', () => {
  const store = tmpStore();
  const record = {
    players: [{ id: 'p1', name: 'Florian' }, { id: 'p2', name: 'Anna' }],
    rounds: [{ roundNumber: 1, winnerId: 'p1' }],
    finalTotals: { p1: 1010, p2: 200 },
    winnerId: 'p1',
    houseRules: { handAusDoubles: false },
    finishedAt: Date.now(),
  };
  const saved = store.saveGame(record);
  assert.ok(saved.id);
  assert.equal(store.listGames().length, 1);
  assert.equal(store.getGame(saved.id).winnerId, 'p1');
});

test('Spielverlauf übersteht einen Neustart (neue Store-Instanz, gleiche Datei)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-history-test-'));
  const filePath = path.join(dir, 'games.json');
  const store1 = createGameHistoryStore(filePath);
  store1.saveGame({ players: [], rounds: [], finalTotals: {}, winnerId: null, finishedAt: Date.now() });
  // Writes sind jetzt gecacht/debounced (blockieren die Event-Loop nicht) -
  // flushSync entspricht dem Graceful Shutdown vor einem Neustart.
  store1.flushSync();

  const store2 = createGameHistoryStore(filePath);
  assert.equal(store2.listGames().length, 1);
});

test('Älteste Partien werden ab MAX_STORED_GAMES verworfen (kein unbegrenztes Wachstum)', () => {
  const store = tmpStore();
  for (let i = 0; i < 205; i++) {
    store.saveGame({ players: [], rounds: [], finalTotals: {}, winnerId: null, finishedAt: i });
  }
  const games = store.listGames();
  assert.ok(games.length <= 200);
  // Die zuletzt gespeicherte Partie muss erhalten bleiben
  assert.equal(games[games.length - 1].finishedAt, 204);
});
