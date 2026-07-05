// Bot-vs-bot self-play harness: measures win rates per difficulty so bot
// tuning is DATA-driven instead of vibes-driven. Usage: node scripts/sim-bots.js
// (adjust the series at the bottom; ~3 games/second headless).
// Headless bot-vs-bot simulation: does zen actually beat hard/medium?
const GameManager = require('../game/GameManager');

function playGame(difficulties) {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('h1', 'Host'); // human seat needed to start; converts below
  g.setHouseRules({ botDifficulty: 'medium' });
  g.fillWithBots();
  // Replace ALL seats with pure bots at the wanted difficulties
  g.players = difficulties.map((d, i) => ({
    id: `bot-${i}`, name: `B${i}-${d}`, isBot: true, hand: [], connected: true,
    laidOutCards: [], botDifficulty: d,
  }));
  g.maxSeats = difficulties.length;
  let rounds = 0;
  g.startNewRound();
  while (g.phase !== 'gameOver' && rounds < 300) {
    if (g.phase === 'playing') {
      const cp = g.currentPlayer();
      const before = g.turnIndexInRound;
      g.runBotTurn(cp.id);
      if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === cp.id) {
        // safety: no progress -> forfeit round to avoid infinite loop
        g.finishRound(null);
      }
    } else if (g.phase === 'roundEnd') {
      rounds += 1;
      g.startNewRound();
    } else break;
  }
  const totals = g.totals || {};
  // How often did each seat throw the Queen of Spades away? (Log-based,
  // seat names embed the difficulty: B0-zen etc.)
  const pdDiscards = {};
  for (const e of g.log || []) {
    const m = /^(B\d+-\w+) wirft Pik-Q ab\.$/.exec(e.text);
    if (m) pdDiscards[m[1]] = (pdDiscards[m[1]] || 0) + 1;
  }
  g.destroy();
  if (g.phase !== 'gameOver') return null;
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  return { winner: ranked[0][0], totals, pdDiscards };
}

function series(label, difficulties, n) {
  const wins = {};
  const pdByName = {};
  let played = 0;
  for (let i = 0; i < n; i++) {
    const r = playGame(difficulties);
    if (!r) continue;
    played += 1;
    wins[r.winner] = (wins[r.winner] || 0) + 1;
    for (const [name, cnt] of Object.entries(r.pdDiscards || {})) {
      pdByName[name] = (pdByName[name] || 0) + cnt;
    }
  }
  const line = difficulties.map((d, i) => `${d}:${(((wins[`bot-${i}`] || 0) / played) * 100).toFixed(0)}%`).join(' ');
  const pdLine = difficulties.map((d, i) => `${d}:${((pdByName[`B${i}-${d}`] || 0) / played).toFixed(2)}`).join(' ');
  console.log(`${label} (${played} Partien): ${line}  |  ♠Q-Abwürfe/Spiel: ${pdLine}`);
}

series("zen vs 3x hard  ", ["zen", "hard", "hard", "hard"], 130);
series('zen vs 3x medium', ['zen', 'medium', 'medium', 'medium'], 200);

