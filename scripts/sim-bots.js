// Bot-vs-bot self-play harness: measures win rates per difficulty so bot
// tuning is DATA-driven instead of vibes-driven. Usage: node scripts/sim-bots.js
// (adjust the series at the bottom; ~3 games/second headless), or --ladder,
// --team ("2 gegen 2" A/B) and --lengths (match length per mode).
// Headless bot-vs-bot simulation: does zen actually beat the field?
// Simulated games are no human moves: never log them (they filled the disk once).
process.env.PIKDAME_LOG_GAMES = '0';
const GameManager = require('../game/GameManager');
const { xpForGame } = require('../game/Progression');

function playGame(difficulties, mcSeats = [], mctsSeats = []) {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('h1', 'Host'); // human seat needed to start; converts below
  g.setHouseRules({ botDifficulty: 'medium' });
  g.fillWithBots();
  // Replace ALL seats with pure bots at the wanted difficulties. Seats listed
  // in mcSeats additionally run the experimental Monte-Carlo discard.
  g.players = difficulties.map((d, i) => ({
    id: `bot-${i}`, name: `B${i}-${d}`, isBot: true, hand: [], connected: true,
    laidOutCards: [], botDifficulty: d,
    mcEnabled: mcSeats.includes(i),
    mctsEnabled: mctsSeats.includes(i),
    mctsForceOff: d === 'zen' && !mctsSeats.includes(i), // control arm: pure heuristic
    mctsDeterminizations: 8,
    mctsEndgameAt: 5,
    mctsMaxHand: 9,
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

function series(label, difficulties, n, mcSeats = [], mctsSeats = []) {
  const wins = {};
  const pdByName = {};
  let played = 0;
  for (let i = 0; i < n; i++) {
    const r = playGame(difficulties, mcSeats, mctsSeats);
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

// Prod-routed game: Zen plays the net when onnxruntime-node and the model are
// there (PIKDAME_ONNX, auto mode), every other level the heuristic - exactly
// like maybeRunBotTurn. Returns the winning seat index, or null.
async function playGameProd(levels) {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('h1', 'Host');
  g.fillWithBots();
  g.players = levels.map((d, i) => ({
    id: `bot-${i}`, name: `B${i}-${d}`, isBot: true, hand: [], connected: true, laidOutCards: [], botDifficulty: d,
  }));
  g.maxSeats = levels.length;
  g.startNewRound();
  let guard = 0;
  while (g.phase !== 'gameOver' && guard++ < 100000) {
    if (g.phase === 'playing') {
      const cp = g.currentPlayer();
      const before = g.turnIndexInRound;
      if (g._botTurnUsesOnnx(cp)) await g._runBotTurnWithOnnx(cp.id);
      else g.runBotTurn(cp.id);
      if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === cp.id) g.finishRound(null);
    } else if (g.phase === 'roundEnd') g.startNewRound();
    else break;
  }
  const totals = { ...g.totals };
  g.destroy();
  if (g.phase !== 'gameOver') return null;
  return Number(Object.entries(totals).sort((a, b) => b[1] - a[1])[0][0].split('-')[1]);
}

// The bot ladder: for each pair "weak,strong", paired 2-vs-2 games with the
// seats alternating; reports the STRONGER level's win share as mean +/- the
// standard error over batches (50 % = no step). Run with the net installed
// (CLAUDE.md: strength is measured with ONNX active, the prod default).
//   node scripts/sim-bots.js --ladder [easy,medium medium,hard hard,zen] [--batches 10] [--games 200]
async function ladder() {
  const argAfter = (flag, def) => {
    const i = process.argv.indexOf(flag);
    return i > -1 ? Number(process.argv[i + 1]) : def;
  };
  const batches = argAfter('--batches', 10);
  const games = argAfter('--games', 200);
  const pairs = process.argv.slice(2).filter((a) => /^[a-z]+,[a-z]+$/.test(a));
  const OnnxPolicy = require('../game/OnnxPolicy');
  console.log(`Bot ladder, ${batches} batches x ${games} paired games, net ${OnnxPolicy.enabled() ? 'ON' : 'OFF'}`);
  for (const pair of pairs.length ? pairs : ['easy,medium', 'medium,hard', 'hard,zen']) {
    const [weak, strong] = pair.split(',');
    const shares = [];
    for (let b = 0; b < batches; b++) {
      let wins = 0;
      let played = 0;
      for (let i = 0; i < games; i++) {
        const seats = i % 2 ? [weak, strong, weak, strong] : [strong, weak, strong, weak];
        const w = await playGameProd(seats);
        if (w === null) continue;
        played += 1;
        if (seats[w] === strong) wins += 1;
      }
      shares.push(wins / played);
    }
    console.log(`  ${weak.padEnd(6)} -> ${strong.padEnd(6)}: ${(mean(shares) * 100).toFixed(1)}% +/- ${(stderr(shares) * 100).toFixed(1)} (strong side)`);
  }
}

const argAfter = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : def;
};

// "2 gegen 2": four bots at one level, teams by seat parity. Seats of team
// `awareTeam` run the team-aware context (GameManager seat flag `teamAware`),
// the others the naive one. Returns { won, rounds, turns } or null.
function playTeamGame(level, awareTeam) {
  const g = new GameManager(() => {}, { teamMode: true });
  g.maybeRunBotTurn = () => {};
  g.players = [0, 1, 2, 3].map((i) => ({
    id: `bot-${i}`, name: `B${i}`, isBot: true, hand: [], connected: true, laidOutCards: [],
    botDifficulty: level, teamAware: i % 2 === awareTeam,
  }));
  for (const p of g.players) g.totals[p.id] = 0;
  g.startNewRound();
  let guard = 0;
  while (g.phase !== 'gameOver' && guard++ < 100000) {
    if (g.phase === 'playing') {
      const cp = g.currentPlayer();
      const before = g.turnIndexInRound;
      g.runBotTurn(cp.id);
      if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === cp.id) g.finishRound(null);
    } else if (g.phase === 'roundEnd') g.startNewRound();
    else break;
  }
  const info = g.gameOverInfo;
  const xp = seatXp(g);
  g.destroy();
  if (g.phase !== 'gameOver' || !info) return null;
  return { won: info.winnerTeam === awareTeam, rounds: info.totalRounds, turns: info.totalTurns, xp };
}

/** Mean XP a seat books for the finished match (Progression.xpForGame). */
function seatXp(g) {
  const rec = g.lastGameRecord;
  return rec ? mean(g.players.map((p) => xpForGame(rec, p.id))) : 0;
}

// A/B for the team-aware bot context: the aware team's win share, sides
// alternating, as mean +/- standard error over batches (50 % = no effect).
//   node scripts/sim-bots.js --team [hard] [--batches 10] [--games 200]
function teamAb() {
  const batches = argAfter('--batches', 10);
  const games = argAfter('--games', 200);
  const levels = process.argv.slice(2).filter((a) => ['easy', 'medium', 'hard', 'zen'].includes(a));
  console.log(`Team A/B (team-aware vs naive), ${batches} batches x ${games} games`);
  for (const level of levels.length ? levels : ['hard']) {
    const shares = [];
    for (let b = 0; b < batches; b++) {
      let wins = 0;
      let played = 0;
      for (let i = 0; i < games; i++) {
        const r = playTeamGame(level, i % 2);
        if (!r) continue;
        played += 1;
        if (r.won) wins += 1;
      }
      shares.push(wins / played);
      process.stdout.write(`  ${level} batch ${b + 1}/${batches}: ${((wins / played) * 100).toFixed(1)}%\n`);
    }
    const m = mean(shares) * 100;
    const se = stderr(shares) * 100;
    console.log(`  ${level.padEnd(6)} aware team: ${m.toFixed(1)}% +/- ${se.toFixed(1)}  (~${(Math.abs(m - 50) / (se || 1)).toFixed(1)} sigma from 50 %)`);
  }
}

// Match length per mode (rounds and turns per finished game), e.g. to compare
// wins per hour of "2 gegen 2" with 1-vs-1 and four-player tables.
//   node scripts/sim-bots.js --lengths [medium] [--games 300]
function lengths() {
  const games = argAfter('--games', 300);
  const level = process.argv.slice(2).find((a) => ['easy', 'medium', 'hard', 'zen'].includes(a)) || 'medium';
  const modes = [
    ['1 vs 1', () => playLength([level, level])],
    ['4 players', () => playLength([level, level, level, level])],
    ['2 vs 2', () => playTeamGame(level, 0)],
  ];
  console.log(`Match length at ${level}, ${games} games per mode`);
  for (const [label, play] of modes) {
    const rounds = [];
    const turns = [];
    const xp = [];
    for (let i = 0; i < games; i++) {
      const r = play();
      if (!r) continue;
      rounds.push(r.rounds);
      turns.push(r.turns);
      xp.push(r.xp);
    }
    console.log(`  ${label.padEnd(9)}: ${mean(rounds).toFixed(2)} +/- ${stderr(rounds).toFixed(2)} rounds, ${mean(turns).toFixed(1)} +/- ${stderr(turns).toFixed(1)} turns, ${mean(xp).toFixed(1)} +/- ${stderr(xp).toFixed(1)} XP per seat`);
  }
}

function playLength(levels) {
  const g = new GameManager(() => {});
  g.maybeRunBotTurn = () => {};
  g.players = levels.map((d, i) => ({ id: `bot-${i}`, name: `B${i}`, isBot: true, hand: [], connected: true, laidOutCards: [], botDifficulty: d }));
  for (const p of g.players) g.totals[p.id] = 0;
  g.maxSeats = levels.length;
  g.startNewRound();
  let guard = 0;
  while (g.phase !== 'gameOver' && guard++ < 100000) {
    if (g.phase === 'playing') {
      const cp = g.currentPlayer();
      const before = g.turnIndexInRound;
      g.runBotTurn(cp.id);
      if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === cp.id) g.finishRound(null);
    } else if (g.phase === 'roundEnd') g.startNewRound();
    else break;
  }
  const info = g.gameOverInfo;
  const xp = seatXp(g);
  g.destroy();
  return g.phase === 'gameOver' && info ? { rounds: info.totalRounds, turns: info.totalTurns, xp } : null;
}

if (process.argv.includes('--team')) {
  teamAb();
} else if (process.argv.includes('--lengths')) {
  lengths();
} else if (process.argv.includes('--ladder')) {
  ladder();
} else if (process.argv.includes('--mc')) {
  // A/B: does the Monte-Carlo endgame discard actually beat plain zen?
  // Seat 0 is zen; in the MC arm it also runs the sampler. We measure seat-0
  // win rate across BATCHES so we get a mean +/- standard error, not a single
  // noisy number (the exact discipline that unmasked the blocking feature).
  const BATCHES = 8;
  const GAMES = 90;
  const field = ['zen', 'medium', 'medium', 'medium'];
  const control = [];
  const mc = [];
  process.stdout.write(`MC A/B: seat0 zen vs 3x medium, ${BATCHES} batches x ${GAMES} games\n`);
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
} else if (process.argv.includes('--mcts')) {
  // A/B: does determinized-rollout endgame discard beat plain zen? Rollouts
  // are expensive, so fewer games per batch; still batched for mean +/- se.
  const BATCHES = 5;
  const GAMES = 26;
  const field = ['zen', 'medium', 'medium', 'medium'];
  const control = [];
  const mcts = [];
  process.stdout.write(`MCTS A/B: seat0 zen vs 3x medium, ${BATCHES} batches x ${GAMES} games\n`);
  for (let b = 0; b < BATCHES; b++) {
    const cw = series('', field, GAMES, [], []).winBySeat[0];
    const mw = series('', field, GAMES, [], [0]).winBySeat[0];
    control.push(cw); mcts.push(mw);
    process.stdout.write(`BATCH ${cw.toFixed(4)} ${mw.toFixed(4)}\n`);
  }
  const cM = mean(control) * 100;
  const mM = mean(mcts) * 100;
  const seD = Math.sqrt(stderr(control) ** 2 + stderr(mcts) ** 2) * 100;
  console.log(`\n  plain zen  : ${cM.toFixed(1)}% +/- ${(stderr(control) * 100).toFixed(1)}`);
  console.log(`  zen + MCTS : ${mM.toFixed(1)}% +/- ${(stderr(mcts) * 100).toFixed(1)}`);
  console.log(`  delta      : ${mM - cM >= 0 ? '+' : ''}${(mM - cM).toFixed(1)} pts  (~${(Math.abs(mM - cM) / (seD || 1)).toFixed(1)} sigma)`);
} else {
  series('zen vs 3x medium ', ['zen', 'medium', 'medium', 'medium'], 130);
  series('zen vs 3x medium', ['zen', 'medium', 'medium', 'medium'], 200);
}

