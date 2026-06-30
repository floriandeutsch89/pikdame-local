// game/ScoreBoard.js
const { cardValue, isPikDame } = require('./Card');

const GAME_END_THRESHOLD = 1000;

function sumValues(cards) {
  return cards.reduce((sum, c) => sum + cardValue(c), 0);
}

/**
 * Hausregeln (alle optional, werden bei Spielbeginn festgelegt):
 * - handAusDoubles: Geht ein Spieler im ALLERERSTEN Zug der Runde komplett
 *   aus ("Hand aus"), wird die komplette Rundenwertung aller Spieler
 *   (inkl. Minuspunkte) verdoppelt.
 * - strictThreshold: Das Gesamtspiel endet erst, wenn ein Spieler MEHR als
 *   1000 Punkte hat (genau 1000 reicht nicht). Ist diese Regel AUS, reicht
 *   bereits das Erreichen von 1000 Punkten (>=) zum Spielende.
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
        isWinner: pid === winnerId,
        multiplier,
      },
    };
  }

  return result;
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
 */
function checkGameOver(totals, houseRules = {}) {
  const strict = !!houseRules.strictThreshold;
  const meetsThreshold = (score) => (strict ? score > GAME_END_THRESHOLD : score >= GAME_END_THRESHOLD);

  const over = Object.entries(totals).filter(([, score]) => meetsThreshold(score));
  if (over.length === 0) return { gameOver: false };

  // Spiel endet, sobald irgendein Spieler die Schwelle erreicht/überschreitet.
  // Gewinner = höchste Gesamtpunktzahl.
  let bestId = null;
  let bestScore = -Infinity;
  for (const [pid, score] of Object.entries(totals)) {
    if (score > bestScore) {
      bestScore = score;
      bestId = pid;
    }
  }
  return { gameOver: true, winnerId: bestId, finalTotals: totals };
}

module.exports = {
  GAME_END_THRESHOLD,
  DEFAULT_HOUSE_RULES,
  scoreRound,
  applyRoundScores,
  checkGameOver,
  sumValues,
};
