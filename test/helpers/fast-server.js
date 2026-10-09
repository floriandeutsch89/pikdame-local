// Test-only entry point: starts server.js with bot think time and the game-end
// score cut down, so a whole game over WebSocket takes seconds instead of minutes.
const ScoreBoard = require('../../game/ScoreBoard');

const FAST_END_SCORE = 60;
// Replaced before GameManager destructures it; same rules, lower threshold.
ScoreBoard.checkGameOver = (totals) => {
  const entries = Object.entries(totals).filter(([, s]) => s >= FAST_END_SCORE);
  if (entries.length === 0) return { gameOver: false };
  const best = Math.max(...Object.values(totals));
  const leaders = Object.entries(totals).filter(([, s]) => s === best).map(([id]) => id);
  if (leaders.length > 1) return { gameOver: false, tieBreak: true, tiedIds: leaders, tiedScore: best };
  return { gameOver: true, winnerId: leaders[0], finalTotals: totals };
};

// Bot turns are scheduled with 700-1300 ms (x pace): run them at once.
const realSetTimeout = global.setTimeout;
global.setTimeout = function patched(fn, ms, ...rest) {
  return realSetTimeout(fn, ms >= 300 && ms <= 1400 ? 1 : ms, ...rest);
};

require('../../server.js');
