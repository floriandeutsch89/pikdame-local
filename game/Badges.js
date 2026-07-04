// game/Badges.js
// Erfolgs-Badges: werden nach jeder abgeschlossenen PARTIE aus dem
// gameRecord berechnet. Die Berechnung ist bewusst eine reine Funktion
// (testbar, kein Store-Zugriff) - Vergabe & Persistenz übernimmt der
// PlayerStore (awardBadges), der bereits verdiente Badges ignoriert.
//
// Die Anzeigenamen/Beschreibungen leben im CLIENT (zweisprachig via L());
// hier gibt es nur stabile IDs.

const BADGE_IDS = [
  'first_win', // erste gewonnene Partie
  'hand_aus_win', // eine Runde per "Hand aus" gewonnen
  'pd_laid', // erste Pik Dame sicher ausgelegt (+100)
  'pd_triple', // drei oder mehr Pik Damen in EINER Partie ausgelegt
  'pd_caught', // Pik Dame am Rundenende auf der Hand erwischt (Autsch!)
  'score_500', // 500+ Punkte Endstand in einer Partie
  'streak_3', // drei gewonnene Partien in Folge
  'comeback', // nach Runde 1 Letzter - und trotzdem die Partie gewonnen
  'double_queen_round', // BEIDE Pik Damen in ein und derselben Runde ausgelegt
  'round_300', // 300+ Punkte in einer einzigen Runde
  'zen_slayer', // Partie mit mindestens einem Zen-Meister-Bot am Tisch gewonnen
  'marathon_10', // 10 Partien gespielt
  'pd_hunter_10', // 10 Pik Damen insgesamt ausgelegt (über alle Partien)
];

/**
 * Berechnet, welche Badges ein Spieler sich in DIESER Partie verdient hat.
 *
 * @param {Object} gameRecord GameManager.lastGameRecord (rounds, finalTotals, winnerId)
 * @param {string} playerId   Spieler-ID innerhalb der Partie
 * @param {Object} profile    Spielerprofil NACH recordGameResult (für winStreak/gamesWon)
 * @returns {string[]} verdiente Badge-IDs
 */
function computeEarnedBadges(gameRecord, playerId, profile = {}) {
  const earned = [];
  const rounds = (gameRecord && gameRecord.rounds) || [];
  const won = gameRecord && gameRecord.winnerId === playerId;

  let pdLaid = 0;
  let pdCaught = 0;
  let handAusWin = false;
  let doubleQueenRound = false;
  let bigRound = false;
  for (const round of rounds) {
    const r = round.results && round.results[playerId];
    const b = r && r.breakdown;
    if (b) {
      pdLaid += b.pikDameLaidOut || 0;
      pdCaught += b.pikDameCount || 0;
      if ((b.pikDameLaidOut || 0) >= 2) doubleQueenRound = true;
    }
    if (r && r.roundScore >= 300) bigRound = true;
    if (round.isHandAus && round.winnerId === playerId) handAusWin = true;
  }

  if (won && (profile.gamesWon || 0) >= 1) earned.push('first_win');
  if (handAusWin) earned.push('hand_aus_win');
  if (pdLaid >= 1) earned.push('pd_laid');
  if (pdLaid >= 3) earned.push('pd_triple');
  if (pdCaught >= 1) earned.push('pd_caught');
  if (((gameRecord && gameRecord.finalTotals) || {})[playerId] >= 500) earned.push('score_500');
  if (won && (profile.winStreak || 0) >= 3) earned.push('streak_3');

  // Comeback: nach der ERSTEN Runde alleiniger Letzter, am Ende Sieger.
  if (won && rounds.length >= 2 && rounds[0].totalsAfter) {
    const totals = rounds[0].totalsAfter;
    const my = totals[playerId];
    const others = Object.entries(totals).filter(([pid]) => pid !== playerId).map(([, v]) => v);
    if (others.length > 0 && others.every((v) => v > my)) earned.push('comeback');
  }

  if (doubleQueenRound) earned.push('double_queen_round');
  if (bigRound) earned.push('round_300');
  if (
    won &&
    ((gameRecord && gameRecord.players) || []).some((p) => p.isBot && p.botDifficulty === 'zen')
  ) {
    earned.push('zen_slayer');
  }
  if ((profile.gamesPlayed || 0) >= 10) earned.push('marathon_10');
  if ((profile.totalQueensLaid || 0) >= 10) earned.push('pd_hunter_10');

  return earned;
}

module.exports = { BADGE_IDS, computeEarnedBadges };
