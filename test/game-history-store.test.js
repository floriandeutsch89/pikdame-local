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
