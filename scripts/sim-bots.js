// Bot-vs-bot self-play harness: measures win rates per difficulty so bot
// tuning is DATA-driven instead of vibes-driven. Usage: node scripts/sim-bots.js
// (adjust the series at the bottom; ~3 games/second headless).
// Headless bot-vs-bot simulation: does zen actually beat hard/medium?
const GameManager = require('../game/GameManager');

function playGame(difficulties, mcSeats = []) {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('h1', 'Host'); // human seat needed to start; converts below
  g.setHouseRules({ botDifficulty: 'medium' });
  g.fillWithBots();
  // Replace ALL seats with pure bots at the wanted difficulties. Seats listed
  // in mcSeats additionally run the experimental Monte-Carlo discard.
  g.players = difficulties.map((d, i) => ({
    id: `bot-${i}`, name: `B${i}-${d}`, isBot: true, hand: [], connected: true,
    laidOutCards: [], botDifficulty: d, mcEnabled: mcSeats.includes(i),
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

function series(label, difficulties, n, mcSeats = []) {
  const wins = {};
  const pdByName = {};
  let played = 0;
  for (let i = 0; i < n; i++) {
    const r = playGame(difficulties, mcSeats);
    if (!r) continue;
    played += 1;
    wins[r.winner] = (wins[r.winner] || 0) + 1;
    for (const [name, cnt] of Object.entries(r.pdDiscards || {})) {
      pdByName[name] = (pdByName[name] || 0) + cnt;
    }
  }
  const line = difficulties.map((d, i) => `${d}:${(((wins[`bot-${i}`] || 0) / played) * 100).toFixed(0)}%`).join(' ');
  const pdLine = difficulties.map((d, i) => `${d}:${((pdByName[`B${i}-${d}`] || 0) / played).toFixed(2)}`).join(' ');
  if (label) console.log(`${label} (${played} Partien): ${line}  |  ♠Q-Abwürfe/Spiel: ${pdLine}`);
  return { played, winBySeat: difficulties.map((_, i) => (wins[`bot-${i}`] || 0) / played) };
}

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function stderr(a) {
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1);
  return Math.sqrt(v / a.length);
}

if (process.argv.includes('--mc')) {
  // A/B: does the Monte-Carlo endgame discard actually beat plain zen?
  // Seat 0 is zen; in the MC arm it also runs the sampler. We measure seat-0
  // win rate across BATCHES so we get a mean +/- standard error, not a single
  // noisy number (the exact discipline that unmasked the blocking feature).
  const BATCHES = 8;
  const GAMES = 90;
  const field = ['zen', 'hard', 'hard', 'hard'];
  const control = [];
  const mc = [];
  process.stdout.write(`MC A/B: seat0 zen vs 3x hard, ${BATCHES} batches x ${GAMES} games\n`);
  for (let b = 0; b < BATCHES; b++) {
    control.push(series('', field, GAMES, []).winBySeat[0]);
    mc.push(series('', field, GAMES, [0]).winBySeat[0]);
    process.stdout.write(`  batch ${b + 1}/${BATCHES} done\n`);
  }
  const cM = mean(control) * 100;
  const mM = mean(mc) * 100;
  console.log(`\n  plain zen : ${cM.toFixed(1)}% +/- ${(stderr(control) * 100).toFixed(1)}`);
  console.log(`  zen + MC  : ${mM.toFixed(1)}% +/- ${(stderr(mc) * 100).toFixed(1)}`);
  const delta = mM - cM;
  const seDelta = Math.sqrt(stderr(control) ** 2 + stderr(mc) ** 2) * 100;
  console.log(`  delta     : ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts  (~${(Math.abs(delta) / (seDelta || 1)).toFixed(1)} sigma)`);
} else {
  series('zen vs 3x hard  ', ['zen', 'hard', 'hard', 'hard'], 130);
  series('zen vs 3x medium', ['zen', 'medium', 'medium', 'medium'], 200);
}

