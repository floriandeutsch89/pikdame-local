// Load test: N concurrent games (bots playing), measuring what actually matters
// for responsiveness — EVENT LOOP LAG (how long a human's message would wait
// before the server even looks at it) plus memory and broadcast volume.
//   node scripts/load-test.js [games=200]
const GameManager = require('../game/GameManager');

const GAMES = parseInt(process.argv[2] || '200', 10);
const SECONDS = 10;

let sends = 0;
let bytes = 0;
const games = [];
for (let i = 0; i < GAMES; i++) {
  const g = new GameManager((pid, msg) => {
    sends += 1;
    bytes += JSON.stringify(msg).length; // simulates the real ws.send serialisation
  });
  g.addOrReconnectPlayer(`h${i}`, `Mensch${i}`); // 1 human + 3 bots, like a real table
  g.maxSeats = 4;
  g.fillWithBots();
  g.startNewRound();
  games.push(g);
}

// Event-loop lag: schedule a 20ms interval and measure how late it actually runs.
const lags = [];
let expected = Date.now() + 20;
const lagTimer = setInterval(() => {
  const now = Date.now();
  lags.push(now - expected);
  expected = now + 20;
}, 20);

// Drive every game like a real table: each game takes a bot turn ~every 600ms.
const turnTimer = setInterval(() => {
  for (const g of games) {
    if (g.phase === 'roundEnd') {
      g.startNewRound();
      continue;
    }
    if (g.phase !== 'playing') continue;
    const cp = g.currentPlayer();
    if (cp && cp.isBot) g.runBotTurn(cp.id);
    else if (cp) {
      // stand in for the human: draw + discard so the table keeps moving
      try {
        g.drawFromPile(cp.id);
        if (cp.hand.length) g.discardCard(cp.id, cp.hand[cp.hand.length - 1].id);
      } catch (e) { /* ignore */ }
    }
  }
}, 600);

const startedAt = Date.now();
setTimeout(() => {
  clearInterval(lagTimer);
  clearInterval(turnTimer);
  const elapsed = (Date.now() - startedAt) / 1000;
  lags.sort((a, b) => a - b);
  const p = (q) => lags[Math.floor(lags.length * q)] || 0;
  const mem = process.memoryUsage();
  console.log(`Load test: ${GAMES} concurrent games (1 human + 3 bots each), ${elapsed.toFixed(0)}s\n`);
  console.log('EVENT LOOP LAG (how long a player message would wait):');
  console.log(`  median ${p(0.5)} ms | p95 ${p(0.95)} ms | p99 ${p(0.99)} ms | max ${lags[lags.length - 1]} ms`);
  console.log('\nTHROUGHPUT:');
  console.log(`  state broadcasts: ${sends} (${(sends / elapsed).toFixed(0)}/s)`);
  console.log(`  serialised:       ${(bytes / 1024 / 1024).toFixed(1)} MB (${(bytes / 1024 / elapsed).toFixed(0)} KB/s)`);
  console.log('\nMEMORY:');
  console.log(`  RSS ${Math.round(mem.rss / 1024 / 1024)} MB | heap ${Math.round(mem.heapUsed / 1024 / 1024)} MB`);
  console.log(`  per game: ~${Math.round(mem.heapUsed / GAMES / 1024)} KB`);
  for (const g of games) g.destroy();
  process.exit(0);
}, SECONDS * 1000);
