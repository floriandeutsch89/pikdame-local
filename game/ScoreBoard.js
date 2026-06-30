// game/ScoreBoard.js
const { cardValue, isPikDame } = require('./Card');

const GAME_END_THRESHOLD = 1000;

function sumValues(cards) {
  return cards.reduce((sum, c) => sum + cardValue(c), 0);
}

/**
 * Berechnet die Rundenwertung.
 *
 * @param {string} winnerId Spieler, der zuerst alle Karten losgeworden ist
 * @param {Object} players  { [playerId]: { laidOutCards: Card[], handCards: Card[] } }
 * @returns {Object} { [playerId]: { roundScore, breakdown } }
 */
function scoreRound(winnerId, players) {
  const result = {};

  for (const [pid, data] of Object.entries(players)) {
    const laidOutValue = sumValues(data.laidOutCards || []);
    const handValue = sumValues(data.handCards || []);
    const pikDamePenaltyCount = (data.handCards || []).filter(isPikDame).length;
    const pikDamePenalty = pikDamePenaltyCount * 100;

    let roundScore;
    if (pid === winnerId) {
      // Gewinner: nur Pluspunkte aus eigenen Auslagen
      roundScore = laidOutValue;
    } else {
      // Mitspieler: Pluspunkte (Auslage) minus Minuspunkte (Handkarten)
      roundScore = laidOutValue - handValue;
    }
    // Sonder-Strafe: Pik-Dame noch auf der Hand -> zusätzlich -100 pro Stück
    roundScore -= pikDamePenalty;

    result[pid] = {
      roundScore,
      breakdown: {
        laidOutValue,
        handValue,
        pikDamePenalty,
        isWinner: pid === winnerId,
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

function checkGameOver(totals) {
  const over = Object.entries(totals).filter(([, score]) => score > GAME_END_THRESHOLD);
  if (over.length === 0) return { gameOver: false };

  // Spiel endet, sobald irgendein Spieler die Schwelle überschreitet.
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
  scoreRound,
  applyRoundScores,
  checkGameOver,
  sumValues,
};
