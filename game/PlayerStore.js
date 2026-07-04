// game/PlayerStore.js
// Persistiert Spielerprofile (Name, Statistiken über mehrere Partien) in
// einer einfachen JSON-Datei. (Die frühere Team-Funktion wurde entfernt -
// ein teams-Feld in Altdateien wird schlicht ignoriert.) Bewusst dependency-frei (kein DB-Treiber nötig) und
// für den Offline-Hotspot-Use-Case völlig ausreichend.

const path = require('path');
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'players.json');

function emptyStore() {
  return { players: [] };
}

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Erzeugt eine PlayerStore-Instanz, die auf einer bestimmten Datei arbeitet.
 * Standardmäßig `data/players.json` im Projektordner - für Tests kann ein
 * eigener (temporärer) Pfad übergeben werden, um die echte Datei nicht
 * anzufassen.
 */
function createPlayerStore(filePath = DEFAULT_DATA_FILE) {
  // Gecacht + debounced + atomar: blockiert die Event-Loop nie (wichtig
  // bei vielen parallelen Spielen, wo staendig Partien enden).
  const file = createAtomicJsonFile(filePath);

  function loadStore() {
    const parsed = file.read();
    if (!parsed) return emptyStore();
    return {
      players: Array.isArray(parsed.players) ? parsed.players : [],
    };
  }

  function saveStore(store) {
    file.write(store);
    return store;
  }

  function findPlayerByName(store, name) {
    const lower = name.trim().toLowerCase();
    return store.players.find((p) => p.name.toLowerCase() === lower);
  }

  function upsertPlayerProfile(name) {
    const store = loadStore();
    let p = findPlayerByName(store, name);
    if (!p) {
      p = { id: genId('profile'), name: name.trim(), gamesPlayed: 0, gamesWon: 0, totalScore: 0 };
      store.players.push(p);
      saveStore(store);
    }
    return p;
  }

  /**
   * Trägt das Ergebnis einer abgeschlossenen Partie (nicht nur einer Runde!)
   * für jeden Spieler anhand seines Namens ein. Legt unbekannte Namen
   * automatisch als neues Profil an.
   *
   * @param {Array<{name: string, score: number, won: boolean}>} results
   */
  function recordGameResult(results) {
    const store = loadStore();
    for (const r of results) {
      let p = findPlayerByName(store, r.name);
      if (!p) {
        p = { id: genId('profile'), name: r.name.trim(), gamesPlayed: 0, gamesWon: 0, totalScore: 0 };
        store.players.push(p);
      }
      p.gamesPlayed = (p.gamesPlayed || 0) + 1;
      p.totalScore = (p.totalScore || 0) + (r.score || 0);
      if (r.won) p.gamesWon = (p.gamesWon || 0) + 1;
      // Siegesserie: Basis für das "3 in Folge"-Badge
      p.winStreak = r.won ? (p.winStreak || 0) + 1 : 0;
      // Records & cumulative counters (feed profile display + badges)
      if ((r.score || 0) > (p.bestGameScore || 0)) p.bestGameScore = r.score || 0;
      const f = r.facts || {};
      if ((f.bestRound || 0) > (p.bestRoundScore || 0)) p.bestRoundScore = f.bestRound;
      p.totalQueensLaid = (p.totalQueensLaid || 0) + (f.pdLaid || 0);
      p.totalQueensCaught = (p.totalQueensCaught || 0) + (f.pdCaught || 0);
      p.totalJokersLaid = (p.totalJokersLaid || 0) + (f.jokersLaid || 0);
      p.totalHandAus = (p.totalHandAus || 0) + (f.handAusWins || 0);
      // Bester Endstand einer einzelnen Partie (für die Statistik-Seite)
      if (p.bestGameScore === undefined || (r.score || 0) > p.bestGameScore) {
        p.bestGameScore = r.score || 0;
      }
    }
    // Cap gegen unbegrenztes Wachstum auf einem oeffentlichen Server: bei
    // mehr als 500 Profilen fliegen die mit den wenigsten Partien zuerst.
    const MAX_PROFILES = 500;
    if (store.players.length > MAX_PROFILES) {
      store.players.sort((a, b) => (b.gamesPlayed || 0) - (a.gamesPlayed || 0));
      store.players.length = MAX_PROFILES;
    }
    saveStore(store);
    return store.players;
  }

  function listPlayers() {
    return loadStore().players;
  }

  function getPlayerByName(name) {
    return findPlayerByName(loadStore(), name) || null;
  }

  /**
   * Vergibt Badges an einen Spieler. Bereits vorhandene werden ignoriert.
   * @returns {string[]} nur die NEU vergebenen Badge-IDs
   */
  function awardBadges(name, badgeIds = []) {
    const store = loadStore();
    const p = findPlayerByName(store, name);
    if (!p) return [];
    p.badges = p.badges || {};
    const fresh = [];
    for (const id of badgeIds) {
      if (!p.badges[id]) {
        p.badges[id] = Date.now();
        fresh.push(id);
      }
    }
    if (fresh.length > 0) saveStore(store);
    return fresh;
  }





  return {
    filePath,
    flushSync: file.flushSync,
    loadStore,
    saveStore,
    upsertPlayerProfile,
    recordGameResult,
    listPlayers,
    getPlayerByName,
    awardBadges,
  };
}

module.exports = { createPlayerStore, DEFAULT_DATA_FILE };
