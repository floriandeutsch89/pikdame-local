const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayerStore } = require('../game/PlayerStore');
const { loadedStore } = require('./helpers/test-db');

const tmpStore = () => loadedStore(createPlayerStore, 'players');

test('loadStore liefert leeren Store, wenn die Tabelle noch leer ist', async () => {
  const store = await tmpStore();
  const data = store.loadStore();
  assert.deepEqual(data, { players: [] });
});

test('upsertPlayerProfile legt neuen Spieler an und ist idempotent (case-insensitive)', async () => {
  const store = await tmpStore();
  const p1 = store.upsertPlayerProfile('Florian');
  const p2 = store.upsertPlayerProfile('florian');
  assert.equal(p1.id, p2.id);
  assert.equal(store.listPlayers().length, 1);
});

test('recordGameResult aktualisiert Statistiken über mehrere Partien hinweg', async () => {
  const store = await tmpStore();
  store.recordGameResult([
    { name: 'Florian', score: 250, won: true },
    { name: 'Anna', score: -40, won: false },
  ]);
  store.recordGameResult([
    { name: 'Florian', score: 100, won: false },
    { name: 'Anna', score: 300, won: true },
  ]);

  const players = store.listPlayers();
  const florian = players.find((p) => p.name === 'Florian');
  const anna = players.find((p) => p.name === 'Anna');

  assert.equal(florian.gamesPlayed, 2);
  assert.equal(florian.gamesWon, 1);
  assert.equal(florian.totalScore, 350);

  assert.equal(anna.gamesPlayed, 2);
  assert.equal(anna.gamesWon, 1);
  assert.equal(anna.totalScore, 260);
});

test('Daten überleben einen Neustart (neue Store-Instanz, gleiche Datenbank)', async () => {
  const store1 = await tmpStore();
  store1.upsertPlayerProfile('Florian');
  const store2 = await store1.reopen(); // flush like a graceful shutdown, then a fresh load
  assert.equal(store2.listPlayers().length, 1);
  assert.equal(store2.getPlayerByName('florian').name, 'Florian');
});
