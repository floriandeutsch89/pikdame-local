// game/GameHistoryStore.js
// Persistiert abgeschlossene PARTIEN (nicht nur Runden) als vollständige
// Runde-für-Runde-Aufzeichnung in einer JSON-Datei. Dient als Grundlage für
// den Spielverlauf-Export und spätere Auswertungen über mehrere Partien.

const path = require('path');
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const DEFAULT_DATA_DIR = process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data');
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

/**
 * Persönliche Spielhistorie für EINEN Spielernamen: die letzten beendeten
 * Partien, in denen er als echter Spieler (kein Bot) dabei war - neueste
 * zuerst, auf `limit` gekürzt und auf das für eine Übersichtsliste Nötige
 * reduziert (nicht die komplette Runde-für-Runde-Aufzeichnung).
 *
 * Als eigene, reine Funktion statt inline im WebSocket-Handler, damit sie
 * ohne einen laufenden Server geprüft werden kann.
 *
 * @param {Array} allGames  Rückgabe von listGames()
 * @param {string} name     Spielername (Groß-/Kleinschreibung egal)
 * @param {number} limit
 */
function historyForPlayer(allGames, name, limit = 20) {
  const nameLower = String(name || '').trim().toLowerCase();
  if (!nameLower) return [];
  return allGames
    .filter((g) => (g.players || []).some((p) => !p.isBot && (p.name || '').toLowerCase() === nameLower))
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
    .slice(0, limit)
    .map((g) => {
      const me = (g.players || []).find((p) => !p.isBot && (p.name || '').toLowerCase() === nameLower);
      return {
        id: g.id,
        finishedAt: g.finishedAt,
        challengeDate: g.challengeDate || null,
        rounds: (g.rounds || []).length,
        players: (g.players || []).map((p) => ({ name: p.name, isBot: p.isBot })),
        finalTotals: g.finalTotals,
        winnerId: g.winnerId,
        won: !!(me && me.id === g.winnerId),
        myScore: me ? (g.finalTotals || {})[me.id] : undefined,
      };
    });
}

module.exports = { createGameHistoryStore, historyForPlayer, DEFAULT_DATA_FILE };
