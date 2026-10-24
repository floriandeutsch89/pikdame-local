// game/ScoreBoard.js
const { cardValue, isPikDame } = require('./Card');

const GAME_END_THRESHOLD = 1000;
// "2 gegen 2": two seats feed one total, so a team plays to twice the target and
// every seat's own total stays on the solo scale (about 1000 for a winner).
const TEAM_GAME_END_THRESHOLD = 2 * GAME_END_THRESHOLD;

/** The match target: 1000, or a team's shared 2000. */
function gameEndThreshold(teamMode) {
  return teamMode ? TEAM_GAME_END_THRESHOLD : GAME_END_THRESHOLD;
}

function sumValues(cards) {
  return cards.reduce((sum, c) => sum + cardValue(c), 0);
}

/**
 * House rules (all optional, fixed when the game starts):
 * - handAusDoubles: whoever goes out in the very first turn of a round ("Hand
 *   aus") doubles the whole round score of every seat, minus points included.
 * - strictThreshold: the match ends only ABOVE the target (exactly 1000, a
 *   team's 2000, is not enough); off, reaching it ends the match.
 */
const DEFAULT_HOUSE_RULES = {
  handAusDoubles: false,
  strictThreshold: false,
};

/**
 * Berechnet die Rundenwertung.
 *
 * @param {string} winnerId Spieler, der zuerst alle Karten losgeworden ist
 * @param {Object} players  { [playerId]: { laidOutCards: Card[], handCards: Card[] } }
 * @param {Object} options  { isHandAus?: boolean, houseRules?: Partial<DEFAULT_HOUSE_RULES> }
 * @returns {Object} { [playerId]: { roundScore, breakdown } }
 */
function scoreRound(winnerId, players, options = {}) {
  const houseRules = { ...DEFAULT_HOUSE_RULES, ...(options.houseRules || {}) };
  const isHandAus = !!options.isHandAus;
  const multiplier = isHandAus && houseRules.handAusDoubles ? 2 : 1;

  const result = {};

  for (const [pid, data] of Object.entries(players)) {
    const laidOutValue = sumValues(data.laidOutCards || []);
    const handValue = sumValues(data.handCards || []);
    const pikDameCount = (data.handCards || []).filter(isPikDame).length;
    const pikDameLaidOut = (data.laidOutCards || []).filter(isPikDame).length;
    const jokersLaidOut = (data.laidOutCards || []).filter((cd) => cd.isJoker).length;

    let roundScore;
    if (pid === winnerId) {
      // Gewinner: nur Pluspunkte aus eigenen Auslagen
      roundScore = laidOutValue;
    } else {
      // Mitspieler: Pluspunkte (Auslage) minus Minuspunkte (Handkarten).
      // Eine auf der Hand verbliebene Pik Dame ist hier bereits mit ihrem
      // vollen Wert (100) in handValue enthalten - keine Extra-Strafe.
      roundScore = laidOutValue - handValue;
    }

    roundScore *= multiplier;

    result[pid] = {
      roundScore,
      breakdown: {
        laidOutValue,
        handValue,
        pikDameCount,
        pikDameLaidOut,
        jokersLaidOut,
        isWinner: pid === winnerId,
        multiplier,
      },
    };
  }

  return result;
}

/**
 * Per-card breakdown of a card set, grouped by value class - what the round
 * result shows under each row ("♠Q 100, 3x face 30, ..."). Pure and tiny so
 * the client never has to know the point table.
 * @returns {Array<{kind:'pikdame'|'joker'|'ace'|'face'|'low', count:number, points:number}>}
 */
function scoreLines(cards) {
  const groups = { pikdame: 0, joker: 0, ace: 0, face: 0, low: 0 };
  for (const c of cards || []) {
    if (c.isJoker) groups.joker += 1;
    else if (isPikDame(c)) groups.pikdame += 1;
    else if (c.rank === 'A') groups.ace += 1;
    else if (['10', 'J', 'Q', 'K'].includes(c.rank)) groups.face += 1;
    else groups.low += 1;
  }
  const unit = { pikdame: 100, joker: 20, ace: 20, face: 10, low: 5 };
  return Object.entries(groups)
    .filter(([, n]) => n > 0)
    .map(([kind, count]) => ({ kind, count, points: count * unit[kind] }));
}

function applyRoundScores(totals, roundResult) {
  const newTotals = { ...totals };
  for (const [pid, r] of Object.entries(roundResult)) {
    newTotals[pid] = (newTotals[pid] || 0) + r.roundScore;
  }
  return newTotals;
}

/**
 * @param {Object} totals { [playerId]: number }
 * @param {Object} houseRules { strictThreshold?: boolean }
 * @param {number} [threshold] the match target (gameEndThreshold)
 */
function checkGameOver(totals, houseRules = {}, threshold = GAME_END_THRESHOLD) {
  const strict = !!houseRules.strictThreshold;
  const meetsThreshold = (score) => (strict ? score > threshold : score >= threshold);

  const over = Object.entries(totals).filter(([, score]) => meetsThreshold(score));
  if (over.length === 0) return { gameOver: false };

  // The match ends once anyone reaches the line; the highest total wins.
  let bestScore = -Infinity;
  for (const score of Object.values(totals)) if (score > bestScore) bestScore = score;
  const leaders = Object.entries(totals)
    .filter(([, score]) => score === bestScore)
    .map(([pid]) => pid);

  // A tie at the top plays on until one leads alone (family rule; the first
  // object key used to win). The table is told why another round comes.
  if (leaders.length > 1) {
    return { gameOver: false, tieBreak: true, tiedIds: leaders, tiedScore: bestScore };
  }

  return { gameOver: true, winnerId: leaders[0], finalTotals: totals };
}

/**
 * Team mode: the tie rule over the two team totals at the team target. Both
 * teams past the line in one round: the higher total wins; equal totals play
 * one more round, exactly like a tie between two players.
 * @param {number[]} teamTotals [teamA, teamB]
 * @returns {{gameOver:boolean, winnerTeam?:number, tieBreak?:boolean, tiedScore?:number}}
 */
function checkTeamGameOver(teamTotals, houseRules = {}) {
  const r = checkGameOver({ 0: teamTotals[0] || 0, 1: teamTotals[1] || 0 }, houseRules, TEAM_GAME_END_THRESHOLD);
  if (r.tieBreak) return { gameOver: false, tieBreak: true, tiedScore: r.tiedScore };
  if (!r.gameOver) return { gameOver: false };
  return { gameOver: true, winnerTeam: Number(r.winnerId) };
}

module.exports = {
  GAME_END_THRESHOLD,
  TEAM_GAME_END_THRESHOLD,
  gameEndThreshold,
  DEFAULT_HOUSE_RULES,
  scoreRound,
  scoreLines,
  applyRoundScores,
  checkGameOver,
  checkTeamGameOver,
  sumValues,
};
