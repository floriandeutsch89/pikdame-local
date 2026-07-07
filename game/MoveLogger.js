'use strict';

/**
 * Records human move decisions for imitation learning (behavioral cloning).
 *
 * When PIKDAME_LOG_GAMES=1, every draw and discard decision made by a HUMAN
 * (never a bot) is encoded with the SAME StateEncoder the network uses, and
 * buffered per game. At game over the buffer is flushed to a JSONL file with a
 * `won` flag per row, so the Python side can train on the moves of the game's
 * winner. Off by default; wrapped so it can never disrupt a game.
 *
 * Privacy: only anonymous data is written - the encoded observation (numbers),
 * the chosen action, the legal-action mask, an anonymous per-game id, and the
 * won flag. No names, no account ids, no raw cards.
 */

const fs = require('fs');
const path = require('path');
const SE = require('./StateEncoder');

const LOG_PATH = process.env.PIKDAME_LOG_PATH || path.join(__dirname, '..', 'data', 'human-moves.jsonl');

function enabled() {
  return process.env.PIKDAME_LOG_GAMES === '1' || process.env.PIKDAME_LOG_GAMES === 'true';
}

/**
 * Buffer one human decision. `phase` is 'draw' or 'discard'; `action` is the
 * StateEncoder action index (draw: ACTION_DRAW_PILE / ACTION_TAKE_PILE;
 * discard: the card-type index). Bots and invalid actions are skipped.
 */
function record(game, playerId, phase, action) {
  if (!enabled()) return;
  try {
    const player = (game.players || []).find((p) => p.id === playerId);
    if (!player || player.isBot || game.isBotControlled(player)) return; // humans only
    if (typeof action !== 'number' || action < 0) return;
    const pileLegal = phase === 'draw' ? SE.pileTakeLegal(game, playerId) : false;
    const obs = SE.encode(game, playerId, { phase });
    const mask = SE.actionMask(game, playerId, { phase, pileTakeLegal: pileLegal });
    if (!game._moveLog) game._moveLog = [];
    game._moveLog.push({ playerId, phase, obs: Array.from(obs), action, mask });
  } catch (e) {
    /* never disrupt a turn */
  }
}

/** Write the buffered moves for a finished game, tagged with the winner. */
function flush(game) {
  if (!enabled()) return;
  try {
    const buf = game && game._moveLog;
    if (!buf || buf.length === 0) return;
    // Game winner = highest cumulative total.
    const totals = game.totals || {};
    let winnerId = null;
    let best = -Infinity;
    for (const [pid, t] of Object.entries(totals)) {
      if (t > best) {
        best = t;
        winnerId = pid;
      }
    }
    const gameId = Math.random().toString(36).slice(2, 10);
    const lines = buf.map((m) =>
      JSON.stringify({
        g: gameId,
        phase: m.phase,
        obs: m.obs,
        action: m.action,
        mask: m.mask,
        won: m.playerId === winnerId,
      })
    );
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, lines.join('\n') + '\n');
    game._moveLog = [];
  } catch (e) {
    /* logging must never break a game */
  }
}

module.exports = { enabled, record, flush, LOG_PATH };
