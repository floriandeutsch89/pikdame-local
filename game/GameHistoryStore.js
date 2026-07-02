// game/GameHistoryStore.js
// Persistiert abgeschlossene PARTIEN (nicht nur Runden) als vollständige
// Runde-für-Runde-Aufzeichnung in einer JSON-Datei. Dient als Grundlage für
// den Spielverlauf-Export und spätere Auswertungen über mehrere Partien.

const path = require('path');
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'games.json');
const MAX_STORED_GAMES = 200; // Sicherheitsnetz gegen unbegrenztes Wachstum

function genId() {
  return `game-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createGameHistoryStore(filePath = DEFAULT_DATA_FILE) {
  const file = createAtomicJsonFile(filePath);

  function loadAll() {
    const parsed = file.read();
    return parsed && Array.isArray(parsed.games) ? parsed.games : [];
  }

  function saveAll(games) {
    file.write({ games });
  }

  /**
   * @param {Object} record { players, rounds, finalTotals, winnerId, houseRules, finishedAt }
   * @returns {Object} der gespeicherte Datensatz inkl. generierter id
   */
  function saveGame(record) {
    const games = loadAll();
    const stored = { id: genId(), ...record };
    games.push(stored);
    while (games.length > MAX_STORED_GAMES) games.shift();
    saveAll(games);
    return stored;
  }

  function listGames() {
    return loadAll();
  }

  function getGame(id) {
    return loadAll().find((g) => g.id === id) || null;
  }

  return {
    flushSync: file.flushSync, filePath, loadAll, saveGame, listGames, getGame };
}

module.exports = { createGameHistoryStore, DEFAULT_DATA_FILE };
