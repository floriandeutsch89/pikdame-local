const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlayerStore } = require('../game/PlayerStore');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-test-'));
  const filePath = path.join(dir, 'players.json');
  return createPlayerStore(filePath);
}

test('loadStore liefert leeren Store, wenn Datei noch nicht existiert', () => {
  const store = tmpStore();
  const data = store.loadStore();
  assert.deepEqual(data, { players: [], teams: [] });
});

test('upsertPlayerProfile legt neuen Spieler an und ist idempotent (case-insensitive)', () => {
  const store = tmpStore();
  const p1 = store.upsertPlayerProfile('Florian');
  const p2 = store.upsertPlayerProfile('florian');
  assert.equal(p1.id, p2.id);
  assert.equal(store.listPlayers().length, 1);
});

test('recordGameResult aktualisiert Statistiken über mehrere Partien hinweg', () => {
  const store = tmpStore();
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

test('createTeam/updateTeam/deleteTeam verwalten gespeicherte Spielergruppen', () => {
  const store = tmpStore();
  const team = store.createTeam('Familienabend', ['Florian', 'Anna', 'Tom', 'Lisa']);
  assert.equal(store.listTeams().length, 1);
  assert.equal(team.memberNames.length, 4);

  store.updateTeam(team.id, { name: 'Spieleabend', memberNames: ['Florian', 'Anna'] });
  const updated = store.listTeams()[0];
  assert.equal(updated.name, 'Spieleabend');
  assert.deepEqual(updated.memberNames, ['Florian', 'Anna']);

  const deleted = store.deleteTeam(team.id);
  assert.equal(deleted, true);
  assert.equal(store.listTeams().length, 0);
});

test('Daten überleben einen Neustart (neue Store-Instanz, gleiche Datei)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-test-'));
  const filePath = path.join(dir, 'players.json');
  const store1 = createPlayerStore(filePath);
  store1.upsertPlayerProfile('Florian');
  store1.createTeam('Stammtisch', ['Florian', 'Anna']);
  // Writes sind jetzt gecacht/debounced - flushSync entspricht dem
  // Graceful Shutdown vor einem Neustart.
  store1.flushSync();

  const store2 = createPlayerStore(filePath); // simuliert Server-Neustart
  assert.equal(store2.listPlayers().length, 1);
  assert.equal(store2.listTeams().length, 1);
});
