// Paired A/B self-play: 4 zen bots per game, 2 seats get a VARIANT config and
// 2 stay BASELINE, in the SAME games (controls for game-to-game variance).
// Reports the variant win share (0.5 == no effect) with standard error, plus
// the average per-seat final-score margin. Usage:
//   node scripts/sim-ab.js <games> <variantKey> <variantValue>
//
// Supported (default-off, sanitized) seat knobs:
//   queenDumpMaxHand=<n>          endgame Queen-of-Spades dump threshold (def 6)
//   earlyDrawBiasTurns=<n>        prefer the draw pile for the first n turns
//   relaxQueenBaitOnJoker=true    discard spades J/K more freely once an
//                                 opponent has a joker on the table
//   preferDrawOnRedundantSet=true if taking the discard would only form ANOTHER
//                                 set while we already have one, and the pile is
//                                 small (<=2), draw instead
//
// Measured 2026-07-09 (5000 games each, 4x zen):
//   queenDumpMaxHand=5           -> 50.24% win share (z=0.34)  -> no effect
//   earlyDrawBiasTurns=3         -> 44.58% win share (z=-7.71) -> clearly WORSE
//   relaxQueenBaitOnJoker=true   -> 50.34% win share (z=0.48)  -> no effect
//   preferDrawOnRedundantSet=true-> 46.08% win share (z=-5.56) -> clearly WORSE
//
// Measured 2026-07-14 (5000 games each, 4x zen, AFTER the set-aside/no-refill
// rules - ~57% of rounds end via the empty-pile rule):
//   capMeldSize=3                -> 50.24% win share (z=0.34)  -> no effect
//   mod3Trim=true                -> 49.24% win share (z=-1.07) -> no effect
// WHY zero effect: a card held back from a fresh meld can be laid off onto
// that same meld at any time - and the bot's lay-off pass runs right after
// the meld pass, so the held card usually returns to the table IN THE SAME
// TURN. 'Flexibility through holding back' already exists for free via
// lay-offs; capping meld size just shuffles cards between two moves.
//   capMeldSize=<n>              cap fresh melds at n cards, keep surplus in hand
//   mod3Trim=true                steer remaining hand to ==1 (mod 3) (one card
//                                for the forced final discard, rest in threes)
//
// None shipped; all left as off-by-default tuning seams. Recurring lesson:
// passing up a GUARANTEED discard-meld to gamble on a draw costs ~30 points.
const GameManager = require('../game/GameManager');

const GAMES = parseInt(process.argv[2] || '1500', 10);
const KEY = process.argv[3] || 'queenDumpMaxHand';
const VAL = JSON.parse(process.argv[4] || '5');

function playGame(variantSeats) {
  const g = new GameManager(() => {});
  g.players = [0, 1, 2, 3].map((i) => {
    const p = {
      id: `b${i}`, name: `B${i}`, isBot: true, hand: [], connected: true,
      laidOutCards: [], botDifficulty: 'zen',
    };
    if (variantSeats.includes(i)) p[KEY] = VAL;
    return p;
  });
  g.maxSeats = 4;
  g.startNewRound();
  let rounds = 0;
  while (g.phase !== 'gameOver' && rounds < 400) {
    if (g.phase === 'playing') {
      const cp = g.currentPlayer();
      const before = g.turnIndexInRound;
      g.runBotTurn(cp.id);
      if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === cp.id) {
        g.finishRound(null);
      }
    } else if (g.phase === 'roundEnd') {
      rounds += 1;
      g.startNewRound();
    } else break;
  }
  const totals = g.totals || {};
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const winnerSeat = ranked.length ? parseInt(ranked[0][0].slice(1), 10) : -1;
  const scores = [0, 1, 2, 3].map((i) => totals[`b${i}`] || 0);
  g.destroy();
  return { winnerSeat, scores };
}

let variantWins = 0;
let baselineWins = 0;
let variantScore = 0;
let baselineScore = 0;
let counted = 0;
for (let n = 0; n < GAMES; n++) {
  // random 2 of 4 seats are variant (removes positional bias)
  const perm = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  const variantSeats = perm.slice(0, 2);
  const { winnerSeat, scores } = playGame(variantSeats);
  if (winnerSeat < 0) continue;
  counted += 1;
  if (variantSeats.includes(winnerSeat)) variantWins += 1; else baselineWins += 1;
  for (let i = 0; i < 4; i++) {
    if (variantSeats.includes(i)) variantScore += scores[i]; else baselineScore += scores[i];
  }
}

const share = variantWins / counted; // 0.5 == no effect (2 variant vs 2 baseline seats)
const se = Math.sqrt((share * (1 - share)) / counted);
const z = (share - 0.5) / se;
const avgVariant = variantScore / (counted * 2);
const avgBaseline = baselineScore / (counted * 2);
console.log(`Variant: ${KEY}=${VAL}  (baseline: default)`);
console.log(`Games counted:     ${counted}`);
console.log(`Variant wins:      ${variantWins}  Baseline wins: ${baselineWins}`);
console.log(`Variant win share: ${(share * 100).toFixed(2)}%  (50% = kein Effekt)  SE ${(se * 100).toFixed(2)}%  z=${z.toFixed(2)}`);
console.log(`Avg final score:   variant ${avgVariant.toFixed(1)}  vs baseline ${avgBaseline.toFixed(1)}  (Δ ${(avgVariant - avgBaseline).toFixed(1)})`);
