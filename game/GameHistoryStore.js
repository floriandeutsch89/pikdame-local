// game/GameHistoryStore.js
// Persistiert abgeschlossene PARTIEN (nicht nur Runden) als vollständige
// Runde-für-Runde-Aufzeichnung in einer JSON-Datei. Dient als Grundlage für
// den Spielverlauf-Export und spätere Auswertungen über mehrere Partien.

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'games.json');
const MAX_STORED_GAMES = 200; // Sicherheitsnetz gegen unbegrenztes Wachstum

function genId() {
  return `game-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createGameHistoryStore(filePath = DEFAULT_DATA_FILE) {
  function loadAll() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.games) ? parsed.games : [];
    } catch (e) {
      return [];
    }
  }

  function saveAll(games) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ games }, null, 2), 'utf8');
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

  return { filePath, loadAll, saveGame, listGames, getGame };
}

module.exports = { createGameHistoryStore, DEFAULT_DATA_FILE };
