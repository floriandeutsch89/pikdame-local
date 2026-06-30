// game/PlayerStore.js
// Persistiert Spielerprofile (Name, Statistiken über mehrere Partien) und
// Teams (gespeicherte Gruppen von Spielernamen zum Wiederverwenden) in einer
// einfachen JSON-Datei. Bewusst dependency-frei (kein DB-Treiber nötig) und
// für den Offline-Hotspot-Use-Case völlig ausreichend.

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'players.json');

function emptyStore() {
  return { players: [], teams: [] };
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
  function loadStore() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        players: Array.isArray(parsed.players) ? parsed.players : [],
        teams: Array.isArray(parsed.teams) ? parsed.teams : [],
      };
    } catch (e) {
      return emptyStore();
    }
  }

  function saveStore(store) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
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
    }
    saveStore(store);
    return store.players;
  }

  function listPlayers() {
    return loadStore().players;
  }

  function listTeams() {
    return loadStore().teams;
  }

  function createTeam(name, memberNames) {
    const store = loadStore();
    const team = { id: genId('team'), name: name.trim(), memberNames: (memberNames || []).slice(0, 4) };
    store.teams.push(team);
    saveStore(store);
    return team;
  }

  function updateTeam(id, updates = {}) {
    const store = loadStore();
    const team = store.teams.find((t) => t.id === id);
    if (!team) return null;
    if (typeof updates.name === 'string') team.name = updates.name.trim();
    if (Array.isArray(updates.memberNames)) team.memberNames = updates.memberNames.slice(0, 4);
    saveStore(store);
    return team;
  }

  function deleteTeam(id) {
    const store = loadStore();
    const before = store.teams.length;
    store.teams = store.teams.filter((t) => t.id !== id);
    saveStore(store);
    return store.teams.length < before;
  }

  return {
    filePath,
    loadStore,
    saveStore,
    upsertPlayerProfile,
    recordGameResult,
    listPlayers,
    listTeams,
    createTeam,
    updateTeam,
    deleteTeam,
  };
}

module.exports = { createPlayerStore, DEFAULT_DATA_FILE };
