// game/Badges.js
// Achievement badges: computed after every finished MATCH from the
// gameRecord, the ROUND_BADGES already after each round. Pure functions (testable, no store access) -
// awarding and persistence live in PlayerStore (awardBadges), which ignores
// badges already earned.
//
// Display names/descriptions live in the CLIENT (bilingual via L()); this
// module only deals in stable ids.

const { gameHour } = require('./GameDay');
const { isRecordWinner, recordOpponentIds, teamIndexOf } = require('./Teams');
const { GAME_END_THRESHOLD, gameEndThreshold } = require('./ScoreBoard');

const BADGE_IDS = [
  'first_win', // first game won
  'hand_aus_win', // a round won by going "out in one"
  'pd_laid', // first Queen of Spades safely melded (+100)
  'pd_triple', // three or more Queens of Spades melded in ONE match
  'pd_caught', // caught with the Queen of Spades in hand at round end (ouch)
  'score_500', // 500+ final score in one match
  'streak_3', // three matches won in a row
  'comeback', // last after round 1 - and still won the match
  'double_queen_round', // BOTH Queens of Spades melded in one and the same round
  'round_300', // 300+ points in a single round
  'zen_slayer', // won a match with at least one zen-master bot at the table
  'marathon_10', // 10 matches played
  'pd_hunter_10', // 10 Queens of Spades melded in total (across all matches)
  // --- tiers (v2.25): bronze/silver/gold steps on the counters above ------
  'pd_hunter_50', // 50 Queens of Spades melded in total
  'marathon_50', // 50 matches played
  'marathon_100', // 100 matches played
  'wins_10', // 10 matches won
  'wins_50', // 50 matches won
  'streak_5', // five matches won in a row
  'streak_10', // ten matches won in a row
  'hand_aus_5', // five rounds won by going out in one
  'daily_7', // played on 7 days in a row (one grace day per week allowed)
  'daily_30', // played on 30 days in a row
  // --- one-offs from the engine facts (v2.25) ---------------------------------
  'ring_run', // melded a run that wraps K-A-2
  'run_13', // melded a full 13-card run
  'pile_glutton', // picked up a discard pile of 10+ cards and still won the round
  'zen_trio', // won a match against three zen-master bots
  'no_joker_win', // won a match without ever melding a joker
  // --- v2.48: consolation and curiosity badges ----------------------------------
  'purple_heart_10', // 10 matches lost (tiers 50/100 below)
  'purple_heart_50',
  'purple_heart_100',
  'red_lantern', // last place in 3 matches in a row
  'rock_bottom', // finished a match with a negative total
  'cold_shower', // caught with BOTH Queens of Spades in one round
  'joker_king', // 4+ jokers melded in one round
  'quick_start', // went out in one ("Hand aus") in round 1
  'near_miss', // lost a match by less than 20 points (a team: 40, the margins scale with the target)
  'landslide', // won a match by 500+ points (a team: 1000)
  'night_owl', // finished a match between 0:00 and 3:59 German time
  'stammtisch_10', // 10 matches at a Stammtisch
  'challenger_7', // 7 daily challenges played (tier 30 below)
  'challenger_30',
  'challenge_champ', // first place of a daily challenge once the day was over
  'queen_magnet_day', // "Damen-Magnet des Tages": most queens caught in a ranked challenge, day over
  'puzzle_7', // 7 daily puzzles solved (tier 30 below)
  'puzzle_30',
  'puzzle_perfect_10', // 10 daily puzzles solved with three stars (tiers 30/100 below)
  'puzzle_perfect_30',
  'puzzle_perfect_100',
  'royal_flush', // melded 10-J-Q-K-A of one suit, all real cards
  'pik_royal', // ... in spades (with the Queen of Spades)
  // --- Kartenhaus (BotTower.js): floors and stars in the best month ------------
  // (the ids come from the old ten-stage tower, which is October 2026 now)
  'tower_3',
  'tower_6',
  'tower_10',
  'tower_stars_30',
  'tower_crowned_1', // a crowned month: all 20 floors starred (tiers 3/12 below)
  'tower_crowned_3',
  'tower_crowned_12',
];

// Badge families: the same counter at rising thresholds, shown as ONE tile
// with tier dots instead of three unrelated trophies. `field` is the profile
// counter; `tiers` are ordered lowest first.
const BADGE_FAMILIES = [
  { id: 'queens', field: 'totalQueensLaid', tiers: [['pd_laid', 1], ['pd_hunter_10', 10], ['pd_hunter_50', 50]] },
  { id: 'games', field: 'gamesPlayed', tiers: [['marathon_10', 10], ['marathon_50', 50], ['marathon_100', 100]] },
  { id: 'wins', field: 'gamesWon', tiers: [['first_win', 1], ['wins_10', 10], ['wins_50', 50]] },
  { id: 'streak', field: 'winStreak', tiers: [['streak_3', 3], ['streak_5', 5], ['streak_10', 10]] },
  { id: 'handaus', field: 'totalHandAus', tiers: [['hand_aus_win', 1], ['hand_aus_5', 5]] },
  { id: 'daily', field: 'dailyStreak', tiers: [['daily_7', 7], ['daily_30', 30]] },
  { id: 'hearts', field: 'gamesLost', tiers: [['purple_heart_10', 10], ['purple_heart_50', 50], ['purple_heart_100', 100]] },
  { id: 'challenger', field: 'totalChallenges', tiers: [['challenger_7', 7], ['challenger_30', 30]] },
  { id: 'puzzles', field: 'totalPuzzlesSolved', tiers: [['puzzle_7', 7], ['puzzle_30', 30]] },
  { id: 'puzzlePerfect', field: 'totalPerfectPuzzles', tiers: [['puzzle_perfect_10', 10], ['puzzle_perfect_30', 30], ['puzzle_perfect_100', 100]] },
  { id: 'tower', field: 'towerCleared', tiers: [['tower_3', 3], ['tower_6', 6], ['tower_10', 10]] },
  { id: 'towerStars', field: 'towerStars', tiers: [['tower_stars_30', 30]] },
  { id: 'towerCrowned', field: 'towerCrownedMonths', tiers: [['tower_crowned_1', 1], ['tower_crowned_3', 3], ['tower_crowned_12', 12]] },
];

/**
 * Computes which badges a player earned in THIS match.
 *
 * @param {Object} gameRecord GameManager.lastGameRecord (rounds, finalTotals, winnerId)
 * @param {string} playerId   player id inside the match
 * @param {Object} profile    player profile AFTER recordGameResult (winStreak/gamesWon/...)
 * @param {Object} [context]  facts outside the record: {challengeChamp, queenMagnet}
 * @returns {string[]} earned badge ids
 */
function computeEarnedBadges(gameRecord, playerId, profile = {}, context = {}) {
  const earned = [];
  const rounds = (gameRecord && gameRecord.rounds) || [];
  // "2 gegen 2": a team win counts for both; margins and the comeback compare
  // the team totals (docs/developer/team-mode.md).
  const won = isRecordWinner(gameRecord, playerId);
  const team = gameRecord && gameRecord.teamMode ? teamIndexOf(gameRecord.teams, playerId) : -1;

  let pdLaid = 0;
  let pdCaught = 0;
  let jokersLaid = 0;
  let handAusWin = false;
  let doubleQueenRound = false;
  let bigRound = false;
  let ringRun = false;
  let run13 = false;
  let pileGlutton = false;
  let coldShower = false;
  let jokerKing = false;
  let royal = null;
  for (const round of rounds) {
    const r = round.results && round.results[playerId];
    const b = r && r.breakdown;
    if (b) {
      pdLaid += b.pikDameLaidOut || 0;
      pdCaught += b.pikDameCount || 0;
      jokersLaid += b.jokersLaidOut || 0;
      if ((b.pikDameLaidOut || 0) >= 2) doubleQueenRound = true;
      if ((b.ringRuns || 0) > 0) ringRun = true;
      if ((b.longestRun || 0) >= 13) run13 = true;
      if (b.bigPileTake && round.winnerId === playerId) pileGlutton = true;
      if ((b.pikDameCount || 0) >= 2) coldShower = true;
      if ((b.jokersLaidOut || 0) >= 4) jokerKing = true;
      if (b.royalFlush) royal = royal === 'S' ? 'S' : b.royalFlush;
    }
    if (r && r.roundScore >= 300) bigRound = true;
    if (round.isHandAus && round.winnerId === playerId) handAusWin = true;
  }

  if (handAusWin) earned.push('hand_aus_win');
  if (pdLaid >= 1) earned.push('pd_laid');
  if (pdLaid >= 3) earned.push('pd_triple');
  if (pdCaught >= 1) earned.push('pd_caught');
  if (((gameRecord && gameRecord.finalTotals) || {})[playerId] >= 500) earned.push('score_500');

  // Comeback: sole last after the FIRST round, winner at the end (team mode: the own team behind).
  if (won && rounds.length >= 2 && team >= 0 && Array.isArray(rounds[0].teamTotalsAfter)) {
    const tt = rounds[0].teamTotalsAfter;
    if (tt[1 - team] > tt[team]) earned.push('comeback');
  } else if (won && rounds.length >= 2 && team < 0 && rounds[0].totalsAfter) {
    const totals = rounds[0].totalsAfter;
    const my = totals[playerId];
    const others = Object.entries(totals).filter(([pid]) => pid !== playerId).map(([, v]) => v);
    if (others.length > 0 && others.every((v) => v > my)) earned.push('comeback');
  }

  if (doubleQueenRound) earned.push('double_queen_round');
  if (bigRound) earned.push('round_300');
  // Only Zen OPPONENTS count: a Zen partner does not make a win a Zen win.
  const opponents = new Set(recordOpponentIds(gameRecord, playerId));
  const zenBots = ((gameRecord && gameRecord.players) || []).filter((p) => opponents.has(p.id) && p.isBot && p.botDifficulty === 'zen').length;
  if (won && zenBots >= 1) earned.push('zen_slayer');
  if (won && zenBots >= 3) earned.push('zen_trio');
  if (won && rounds.length > 0 && jokersLaid === 0) earned.push('no_joker_win');
  if (ringRun) earned.push('ring_run');
  if (run13) earned.push('run_13');
  if (pileGlutton) earned.push('pile_glutton');

  if (coldShower) earned.push('cold_shower');
  if (jokerKing) earned.push('joker_king');
  if (royal) earned.push('royal_flush');
  if (royal === 'S') earned.push('pik_royal');
  if (rounds[0] && rounds[0].isHandAus && rounds[0].winnerId === playerId) earned.push('quick_start');

  // Final standings: margins against the winner / the runner-up.
  const totals = (gameRecord && gameRecord.finalTotals) || {};
  const mine = totals[playerId];
  if (typeof mine === 'number' && rounds.length > 0) {
    if (mine < 0) earned.push('rock_bottom');
    const tt = gameRecord.teamTotals;
    if (team >= 0 && Array.isArray(tt)) {
      // A team plays to twice the target, so its margins are twice as wide.
      const scale = (gameRecord.targetScore || gameEndThreshold(true)) / GAME_END_THRESHOLD;
      const gap = tt[team] - tt[1 - team];
      if (!won && -gap < 20 * scale) earned.push('near_miss');
      if (won && gap >= 500 * scale) earned.push('landslide');
    } else {
      const others = Object.entries(totals).filter(([pid]) => pid !== playerId).map(([, v]) => v);
      const winnerTotal = totals[gameRecord.winnerId];
      if (!won && typeof winnerTotal === 'number' && winnerTotal - mine < 20) earned.push('near_miss');
      if (won && others.length > 0 && mine - Math.max(...others) >= 500) earned.push('landslide');
    }
  }
  if (rounds.length > 0 && gameRecord.finishedAt && gameHour(gameRecord.finishedAt) < 4) earned.push('night_owl');
  if ((profile.lastPlaceStreak || 0) >= 3) earned.push('red_lantern');
  if ((profile.totalStammtischGames || 0) >= 10) earned.push('stammtisch_10');
  if (context.challengeChamp) earned.push('challenge_champ');
  if (context.queenMagnet) earned.push('queen_magnet_day');

  earned.push(...familyBadges(profile, won));
  return earned;
}

// Decided by the rounds alone (round facts in the record), so server.js awards
// them at each round end; the rest needs the finished match or the profile.
const ROUND_BADGES = [
  'hand_aus_win', 'pd_laid', 'pd_triple', 'pd_caught', 'double_queen_round', 'round_300', 'ring_run',
  'run_13', 'pile_glutton', 'cold_shower', 'joker_king', 'royal_flush', 'pik_royal', 'quick_start',
];

/** The ROUND_BADGES a player holds after the rounds played so far (a running match). */
function computeRoundBadges(gameRecord, playerId) {
  const rounds = (gameRecord && gameRecord.rounds) || [];
  return computeEarnedBadges({ rounds }, playerId).filter((id) => ROUND_BADGES.includes(id));
}

/**
 * Counter families: every tier whose threshold the profile has reached.
 * Win-based counters only count on a WIN (a loss resets the streak anyway).
 * Also used outside a match (a solved daily puzzle).
 */
function familyBadges(profile = {}, won = false) {
  const out = [];
  for (const fam of BADGE_FAMILIES) {
    if (!won && (fam.field === 'winStreak' || fam.field === 'gamesWon')) continue;
    const have = (profile && profile[fam.field]) || 0;
    for (const [id, need] of fam.tiers) if (have >= need) out.push(id);
  }
  return out;
}

module.exports = { BADGE_IDS, BADGE_FAMILIES, ROUND_BADGES, computeEarnedBadges, computeRoundBadges, familyBadges };
