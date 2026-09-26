// game/Badges.js
// Achievement badges: computed after every finished MATCH from the
// gameRecord. Deliberately a pure function (testable, no store access) -
// awarding and persistence live in PlayerStore (awardBadges), which ignores
// badges already earned.
//
// Display names/descriptions live in the CLIENT (bilingual via L()); this
// module only deals in stable ids.

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
];

/**
 * Computes which badges a player earned in THIS match.
 *
 * @param {Object} gameRecord GameManager.lastGameRecord (rounds, finalTotals, winnerId)
 * @param {string} playerId   player id inside the match
 * @param {Object} profile    player profile AFTER recordGameResult (winStreak/gamesWon/...)
 * @returns {string[]} earned badge ids
 */
function computeEarnedBadges(gameRecord, playerId, profile = {}) {
  const earned = [];
  const rounds = (gameRecord && gameRecord.rounds) || [];
  const won = gameRecord && gameRecord.winnerId === playerId;

  let pdLaid = 0;
  let pdCaught = 0;
  let jokersLaid = 0;
  let handAusWin = false;
  let doubleQueenRound = false;
  let bigRound = false;
  let ringRun = false;
  let run13 = false;
  let pileGlutton = false;
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
    }
    if (r && r.roundScore >= 300) bigRound = true;
    if (round.isHandAus && round.winnerId === playerId) handAusWin = true;
  }

  if (handAusWin) earned.push('hand_aus_win');
  if (pdLaid >= 1) earned.push('pd_laid');
  if (pdLaid >= 3) earned.push('pd_triple');
  if (pdCaught >= 1) earned.push('pd_caught');
  if (((gameRecord && gameRecord.finalTotals) || {})[playerId] >= 500) earned.push('score_500');

  // Comeback: sole last after the FIRST round, winner at the end.
  if (won && rounds.length >= 2 && rounds[0].totalsAfter) {
    const totals = rounds[0].totalsAfter;
    const my = totals[playerId];
    const others = Object.entries(totals).filter(([pid]) => pid !== playerId).map(([, v]) => v);
    if (others.length > 0 && others.every((v) => v > my)) earned.push('comeback');
  }

  if (doubleQueenRound) earned.push('double_queen_round');
  if (bigRound) earned.push('round_300');
  const zenBots = ((gameRecord && gameRecord.players) || []).filter((p) => p.isBot && p.botDifficulty === 'zen').length;
  if (won && zenBots >= 1) earned.push('zen_slayer');
  if (won && zenBots >= 3) earned.push('zen_trio');
  if (won && rounds.length > 0 && jokersLaid === 0) earned.push('no_joker_win');
  if (ringRun) earned.push('ring_run');
  if (run13) earned.push('run_13');
  if (pileGlutton) earned.push('pile_glutton');

  // Counter families: every tier whose threshold the profile has reached.
  // The win streak only counts on a WIN (a lost match resets it anyway).
  for (const fam of BADGE_FAMILIES) {
    if (fam.field === 'winStreak' && !won) continue;
    if (fam.field === 'gamesWon' && !won) continue;
    const have = (profile && profile[fam.field]) || 0;
    for (const [id, need] of fam.tiers) if (have >= need) earned.push(id);
  }

  return earned;
}

module.exports = { BADGE_IDS, BADGE_FAMILIES, computeEarnedBadges };
