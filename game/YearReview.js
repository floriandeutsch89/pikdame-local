// game/YearReview.js
// "Dein Pik-Dame-Jahr": per-year counters and the December review built from
// them. Pure functions over plain objects; YearStatsStore persists, server.js
// feeds them from onGameOver. Dates are GameDay strings ("YYYY-MM-DD").

const BOT_LEVELS = ['easy', 'medium', 'hard', 'zen'];
const MAX_OPPONENTS = 30;
const MAX_TABLES = 10;

/** December of the game day: the review is offered and the mail goes out. */
function isReviewSeason(date) {
  return /^\d{4}-12-\d{2}$/.test(String(date || ''));
}

function yearOf(date) {
  return String(date || '').slice(0, 4);
}

function emptyYear() {
  return {
    games: 0, wins: 0, queensLaid: 0, queensCaught: 0, bestRound: 0, bestGame: null,
    handAus: 0, jokers: 0, days: 0, lastDay: null, bestStreak: 0, opponents: {}, bots: {}, tables: {},
  };
}

/** Strongest bot level at the table, null without bots. */
function strongestBot(players) {
  let best = -1;
  for (const p of players || []) {
    if (!p || !p.isBot) continue;
    // A bot without a level plays as Zen (GameManager's fallback).
    const i = BOT_LEVELS.indexOf(p.botDifficulty || 'zen');
    if (i > best) best = i;
  }
  return best < 0 ? null : BOT_LEVELS[best];
}

/** Keeps the `max` entries with the most games: a map per year must stay small. */
function capByGames(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  keys.sort((a, b) => (map[b].games || 0) - (map[a].games || 0));
  const out = {};
  for (const k of keys.slice(0, max)) out[k] = map[k];
  return out;
}

/**
 * One finished game for one human seat.
 * @param {object|undefined} year the player's counters for the game's year
 * @param {{date:string, won:boolean, score:number, facts?:object, opponents?:string[], botLevel?:string|null, table?:string|null}} game
 */
function bumpYear(year, game) {
  const y = { ...emptyYear(), ...(year || {}) };
  const f = game.facts || {};
  y.games += 1;
  if (game.won) y.wins += 1;
  y.queensLaid += f.pdLaid || 0;
  y.queensCaught += f.pdCaught || 0;
  y.jokers += f.jokersLaid || 0;
  y.handAus += f.handAusWins || 0;
  y.bestRound = Math.max(y.bestRound || 0, f.bestRound || 0);
  const score = Number(game.score) || 0;
  y.bestGame = y.bestGame === null || y.bestGame === undefined ? score : Math.max(y.bestGame, score);
  if (game.date && game.date !== y.lastDay) {
    y.days += 1;
    y.lastDay = game.date;
  }
  y.opponents = { ...y.opponents };
  for (const name of game.opponents || []) {
    const key = String(name).toLowerCase();
    const o = y.opponents[key] || { name, games: 0, wins: 0 };
    y.opponents[key] = { name, games: o.games + 1, wins: o.wins + (game.won ? 1 : 0) };
  }
  y.opponents = capByGames(y.opponents, MAX_OPPONENTS);
  y.bots = { ...y.bots };
  if (game.botLevel) {
    const b = y.bots[game.botLevel] || { games: 0, wins: 0 };
    y.bots[game.botLevel] = { games: b.games + 1, wins: b.wins + (game.won ? 1 : 0) };
  }
  y.tables = { ...y.tables };
  if (game.table) {
    const key = String(game.table).toLowerCase();
    const t = y.tables[key] || { name: game.table, games: 0, wins: 0 };
    y.tables[key] = { name: game.table, games: t.games + 1, wins: t.wins + (game.won ? 1 : 0) };
  }
  y.tables = capByGames(y.tables, MAX_TABLES);
  return y;
}

/** The daily streak after a game: the year keeps its longest. */
function noteStreak(year, streak) {
  const y = { ...emptyYear(), ...(year || {}) };
  y.bestStreak = Math.max(y.bestStreak || 0, Number(streak) || 0);
  return y;
}

/** Creation date of a name profile ("profile-<ms>-…"), null if unknown. */
function profileCreated(profile) {
  const m = /^profile-(\d{12,})-/.exec(String((profile && profile.id) || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function topBy(map) {
  const list = Object.values(map || {}).filter((e) => e && e.games > 0);
  list.sort((a, b) => (b.games - a.games) || (b.wins - a.wins) || String(a.name).localeCompare(String(b.name)));
  return list[0] ? { name: list[0].name, games: list[0].games, wins: list[0].wins } : null;
}

/**
 * The review for one player and year, or null without a game that year.
 * A profile born this year holds exactly this year in its all-time counters;
 * otherwise the year bucket counts - from `trackingSince` (the day the store
 * began) when that lies inside the year and the profile is older.
 * @param {{year:string, profile?:object, bucket?:object, trackingSince?:string}} input
 */
function buildReview({ year, profile, bucket, trackingSince = null }) {
  const y = String(year);
  const created = profileCreated(profile);
  const bornThisYear = !!(profile && created && yearOf(created) === y);
  const b = bucket || null;
  const partialSince = trackingSince && trackingSince > `${y}-01-01` && !(created && created >= trackingSince)
    ? trackingSince
    : null;
  const bucketPartial = !!(b && partialSince);
  let totals;
  let totalsSince = null;
  if (bornThisYear) {
    const p = profile;
    totals = {
      games: p.gamesPlayed || 0,
      wins: p.gamesWon || 0,
      queensLaid: p.totalQueensLaid || 0,
      queensCaught: p.totalQueensCaught || 0,
      bestRound: p.bestRoundScore || 0,
      bestGame: p.bestGameScore === undefined ? null : p.bestGameScore,
      handAus: p.totalHandAus || 0,
      jokers: p.totalJokersLaid || 0,
      bestStreak: Math.max((p.daily && p.daily.best) || 0, p.dailyStreak || 0, (b && b.bestStreak) || 0),
    };
  } else if (b) {
    totals = {
      games: b.games || 0,
      wins: b.wins || 0,
      queensLaid: b.queensLaid || 0,
      queensCaught: b.queensCaught || 0,
      bestRound: b.bestRound || 0,
      bestGame: b.bestGame === undefined ? null : b.bestGame,
      handAus: b.handAus || 0,
      jokers: b.jokers || 0,
      bestStreak: b.bestStreak || 0,
    };
    if (bucketPartial) totalsSince = partialSince;
  } else {
    return null;
  }
  if (!totals.games) return null;
  const bots = b
    ? BOT_LEVELS.filter((l) => b.bots && b.bots[l] && b.bots[l].games > 0).map((l) => ({ level: l, games: b.bots[l].games, wins: b.bots[l].wins }))
    : [];
  return {
    year: y,
    name: (profile && profile.name) || null,
    totals,
    totalsSince,
    // Opponents, bots, tables and days only exist in the bucket.
    breakdownSince: bucketPartial ? partialSince : null,
    activeDays: b ? b.days || 0 : 0,
    favorite: b ? topBy(b.opponents) : null,
    bots,
    table: b ? topBy(b.tables) : null,
  };
}

module.exports = {
  BOT_LEVELS, isReviewSeason, yearOf, emptyYear, strongestBot, bumpYear, noteStreak, profileCreated, buildReview,
};
