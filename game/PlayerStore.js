// game/PlayerStore.js
// Persistiert Spielerprofile (Name, Statistiken über mehrere Partien) in
// einer einfachen JSON-Datei. (Die frühere Team-Funktion wurde entfernt -
// ein teams-Feld in Altdateien wird schlicht ignoriert.) Bewusst dependency-frei (kein DB-Treiber nötig) und
// für den Offline-Hotspot-Use-Case völlig ausreichend.

const path = require('path');
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const DEFAULT_DATA_DIR = process.env.PIKDAME_DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'players.json');
const FAVORITE_BADGES_MAX = 3;

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
function createPlayerStore(backend = DEFAULT_DATA_FILE) {
  // A path = atomic JSON file (tests, tools); the server passes a document
  // backend (Postgres, or memory without a database).
  const file = typeof backend === 'string' ? createAtomicJsonFile(backend) : backend;
  const filePath = typeof backend === 'string' ? backend : null;

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
      // Derived, so profiles from before the "purple heart" count all old losses too.
      p.gamesLost = p.gamesPlayed - (p.gamesWon || 0);
      p.lastPlaceStreak = f.lastPlace ? (p.lastPlaceStreak || 0) + 1 : 0;
      if (f.challenge) p.totalChallenges = (p.totalChallenges || 0) + 1;
      if (f.stammtisch) p.totalStammtischGames = (p.totalStammtischGames || 0) + 1;
      // Bester Endstand einer einzelnen Partie (für die Statistik-Seite)
      if (p.bestGameScore === undefined || (r.score || 0) > p.bestGameScore) {
        p.bestGameScore = r.score || 0;
      }
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
  /**
   * Favourite badges (#317): up to 3 earned badge tiles in the order chosen.
   * A key is a single badge id or a family id (shown as its top tier).
   * The caller checks the account; this only checks the profile.
   * @returns {{favorites:string[]}|{error:string}}
   */
  function setFavoriteBadges(name, keys) {
    const store = loadStore();
    const p = findPlayerByName(store, name);
    if (!p) return { error: 'Profil nicht gefunden.' };
    if (!Array.isArray(keys)) return { error: 'Ungültige Auswahl.' };
    const { BADGE_IDS, BADGE_FAMILIES } = require('./Badges');
    const owned = p.badges || {};
    const earned = (key) => {
      const fam = BADGE_FAMILIES.find((f) => f.id === key);
      if (fam) return fam.tiers.some(([id]) => owned[id]);
      return BADGE_IDS.includes(key) && !!owned[key];
    };
    const unique = [...new Set(keys.map(String))];
    if (unique.length > FAVORITE_BADGES_MAX) return { error: 'Höchstens 3 Lieblingsabzeichen.' };
    if (!unique.every(earned)) return { error: 'Nur verdiente Abzeichen können Lieblingsabzeichen sein.' };
    p.favoriteBadges = unique;
    saveStore(store);
    return { favorites: unique };
  }

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

  /** Seasonal card back for this profile (first unlock date kept). @returns {boolean} newly unlocked */
  function unlockSeasonalBack(name, backId, date) {
    if (!backId) return false;
    const store = loadStore();
    const p = findPlayerByName(store, name);
    if (!p) return false;
    p.seasonalBacks = p.seasonalBacks || {};
    if (p.seasonalBacks[backId]) return false;
    p.seasonalBacks[backId] = date;
    saveStore(store);
    return true;
  }

  // --- Progression (XP + daily quests) -------------------------------------
  // Kept on the local, NAME-based profile so it works exactly where the rest
  // of the statistics work: family/hotspot play without any account. The
  // account store mirrors the XP for the cross-device season ladder.
  const QUEST_HISTORY_DAYS = 7; // older days are pruned - this file is small on purpose

  /**
   * Adds experience and daily-quest progress for one finished game.
   * @param {string} name
   * @param {{xp?: number, date?: string, quests?: Object<string, number>}} gain
   * @returns {{xp:number, gainedXp:number, quests:Object<string,number>, completed:string[]}}
   */
  function addProgress(name, gain = {}) {
    const store = loadStore();
    const p = findPlayerByName(store, name);
    if (!p) return { xp: 0, gainedXp: 0, quests: {}, completed: [] };
    const gainedXp = Math.max(0, Math.round(Number(gain.xp) || 0));
    p.xp = (p.xp || 0) + gainedXp;

    const completed = [];
    const date = gain.date;
    const deltas = gain.quests || {};
    if (date && Object.keys(deltas).length > 0) {
      p.quests = p.quests || {};
      const day = (p.quests[date] = p.quests[date] || {});
      for (const [id, delta] of Object.entries(deltas)) {
        const before = day[id] || 0;
        day[id] = before + Math.max(0, Math.round(Number(delta) || 0));
        completed.push(id); // caller compares against the quest's target
      }
      // Prune: only the recent days are ever displayed, and an unbounded map
      // would grow with every day a profile is used.
      const days = Object.keys(p.quests).sort();
      while (days.length > QUEST_HISTORY_DAYS) delete p.quests[days.shift()];
    }
    saveStore(store);
    return {
      xp: p.xp,
      gainedXp,
      quests: (p.quests && date && p.quests[date]) || {},
      completed,
    };
  }

  /** Quest counters a player has collected on a given day (never null). */
  function questProgress(name, date) {
    const p = findPlayerByName(loadStore(), name);
    return (p && p.quests && p.quests[date]) || {};
  }

  /**
   * "Played today": advances the daily streak (see Progression.js). The
   * flat `dailyStreak` mirror on the profile is what the badge tiers and the
   * client read; `daily` holds the full state.
   * @returns {{streak:number,best:number,event:string,graceFree:boolean,welcomeBack:boolean}|null}
   */
  function touchDailyStreak(name, date) {
    const store = loadStore();
    const p = findPlayerByName(store, name);
    if (!p) return null;
    const { advanceDailyStreak, streakGraceAvailable, isWelcomeBack } = require('./Progression');
    const welcomeBack = isWelcomeBack(p.daily, date);
    const { state, event } = advanceDailyStreak(p.daily, date);
    p.daily = state;
    p.dailyStreak = state.streak;
    saveStore(store);
    return { streak: state.streak, best: state.best, event, graceFree: streakGraceAvailable(state, date), welcomeBack };
  }





  // --- Daily puzzle (see game/DailyPuzzle.js) --------------------------------
  // tries / solved / revealed per day; the profile is created on first
  // contact so the puzzle works before the first match. Pruned like quests.
  const PUZZLE_HISTORY_DAYS = 7;
  function puzzleDay(p, date) {
    p.puzzles = p.puzzles || {};
    const day = (p.puzzles[date] = p.puzzles[date] || { tries: 0, solved: false, revealed: false });
    const days = Object.keys(p.puzzles).sort();
    while (days.length > PUZZLE_HISTORY_DAYS) delete p.puzzles[days.shift()];
    return day;
  }
  function puzzleStatus(name, date) {
    const p = findPlayerByName(loadStore(), name);
    return (p && p.puzzles && p.puzzles[date]) || { tries: 0, solved: false, revealed: false };
  }
  /** @returns {{tries,solved,revealed,justSolved:boolean}} */
  function recordPuzzleAttempt(name, date, solved) {
    upsertPlayerProfile(name);
    const store = loadStore();
    const p = findPlayerByName(store, name);
    const day = puzzleDay(p, date);
    let justSolved = false;
    if (!day.solved) {
      day.tries += 1;
      if (solved) {
        day.solved = true;
        justSolved = !day.revealed; // a revealed solution earns nothing
        if (justSolved) p.totalPuzzlesSolved = (p.totalPuzzlesSolved || 0) + 1;
      }
    }
    saveStore(store);
    return { ...day, justSolved };
  }
  function revealPuzzle(name, date) {
    upsertPlayerProfile(name);
    const store = loadStore();
    const p = findPlayerByName(store, name);
    const day = puzzleDay(p, date);
    day.revealed = true;
    saveStore(store);
    return { ...day };
  }

  return {
    filePath,
    flushSync: file.flushSync,
    flush: file.flush || (async () => {}),
    pendingStatements: file.pendingStatements || (() => []),
    status: file.status || (() => 'ok'),
    loadStore,
    saveStore,
    upsertPlayerProfile,
    recordGameResult,
    listPlayers,
    getPlayerByName,
    awardBadges,
    unlockSeasonalBack,
    addProgress,
    questProgress,
    touchDailyStreak,
    setFavoriteBadges,
    puzzleStatus,
    recordPuzzleAttempt,
    revealPuzzle,
  };
}

// --- Postgres codec (see game/PgDocument.js) --------------------------------
const { upsert, stableJson, num, json } = require('./SqlRows');

// [profile field, column, kind]; a field not listed here is kept in `extra`.
const PROFILE_COLUMNS = [
  ['gamesPlayed', 'games_played', 'int'], ['gamesWon', 'games_won', 'int'], ['gamesLost', 'games_lost', 'int'],
  ['totalScore', 'total_score', 'int'], ['winStreak', 'win_streak', 'int'], ['bestGameScore', 'best_game_score', 'int'],
  ['bestRoundScore', 'best_round_score', 'int'], ['totalQueensLaid', 'total_queens_laid', 'int'],
  ['totalQueensCaught', 'total_queens_caught', 'int'], ['totalJokersLaid', 'total_jokers_laid', 'int'],
  ['totalHandAus', 'total_hand_aus', 'int'], ['lastPlaceStreak', 'last_place_streak', 'int'],
  ['totalChallenges', 'total_challenges', 'int'], ['totalStammtischGames', 'total_stammtisch_games', 'int'],
  ['totalPuzzlesSolved', 'total_puzzles_solved', 'int'], ['xp', 'xp', 'int'], ['dailyStreak', 'daily_streak', 'int'],
  ['badges', 'badges', 'json'], ['favoriteBadges', 'favorite_badges', 'json'], ['seasonalBacks', 'seasonal_backs', 'json'],
  ['quests', 'quests', 'json'], ['daily', 'daily', 'json'], ['puzzles', 'puzzles', 'json'],
];
const KNOWN_FIELDS = new Set(['id', 'name', ...PROFILE_COLUMNS.map(([f]) => f)]);
const PROFILE_SQL_COLUMNS = ['name_key', 'name', 'profile_id', ...PROFILE_COLUMNS.map(([, c]) => c), 'extra'];
const INT_LIMIT = 2147483647; // INT columns; BIGINT ones (total_score, xp) take more

function profileRow(p, key) {
  const extra = {};
  for (const [k, v] of Object.entries(p)) if (!KNOWN_FIELDS.has(k) && v !== undefined) extra[k] = v;
  const values = [key, String(p.name), p.id == null ? null : String(p.id)];
  for (const [field, column, kind] of PROFILE_COLUMNS) {
    const v = p[field];
    if (v === undefined || v === null) values.push(null);
    else if (kind === 'json') values.push(stableJson(v));
    else if (Number.isInteger(v) && (column === 'total_score' || column === 'xp' || Math.abs(v) <= INT_LIMIT)) values.push(v);
    else { extra[field] = v; values.push(null); } // keeps odd legacy values unchanged
  }
  values.push(Object.keys(extra).length ? stableJson(extra) : null);
  return upsert('player_profiles', PROFILE_SQL_COLUMNS, ['name_key'], values);
}

function rowToProfile(row) {
  const p = {};
  if (row.profile_id !== null) p.id = row.profile_id;
  p.name = row.name;
  for (const [field, column, kind] of PROFILE_COLUMNS) {
    const v = kind === 'json' ? json(row[column]) : num(row[column]);
    if (v !== undefined) p[field] = v;
  }
  return Object.assign(p, row.extra || {});
}

const playerCodec = {
  name: 'player_profiles',
  table: 'player_profiles',
  // report(reason, entry) is called for every entry that is not carried over.
  normalize(parsed, report = () => {}) {
    const list = parsed && Array.isArray(parsed.players) ? parsed.players : [];
    const players = [];
    for (const p of list) {
      if (p && typeof p.name === 'string') players.push(p);
      else report('profile without a name', p);
    }
    return { players };
  },
  *rows(doc, report = () => {}) {
    const seen = new Set();
    for (const p of doc.players) {
      const key = p.name.toLowerCase(); // the store's lookup key (findPlayerByName)
      if (seen.has(key)) { report('duplicate profile name (first one kept)', p); continue; } // find() returns the first
      seen.add(key);
      yield [key, profileRow(p, key)];
    }
  },
  async load(q) {
    const r = await q.query('SELECT * FROM player_profiles ORDER BY seq');
    return { players: r.rows.map(rowToProfile) };
  },
};

module.exports = { createPlayerStore, playerCodec, DEFAULT_DATA_FILE };
