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
    game._moveLog.push({
      playerId,
      phase,
      obs: Array.from(obs),
      action,
      mask,
      // Per-move context that helps training (weighting, curriculum, analysis):
      round: game.roundNumber || 0,
      turn: game.gameTurnCount || 0,
      hand: (player.hand || []).length,
      opp: (game.players || []).filter((p) => p.id !== playerId).map((p) => (p.hand || []).length),
      pileTakeLegal: !!pileLegal,
    });
  } catch (e) {
    /* never disrupt a turn */
  }
}

// Round observation floats to keep the log compact ("minified") by default -
// 377 full-precision doubles per row is wasteful and hurts nothing at 4dp.
function round4(x) {
  return Math.round(x * 1e4) / 1e4;
}

/** Write the buffered moves for a finished game, tagged with rich outcome info. */
function flush(game) {
  if (!enabled()) return;
  try {
    const buf = game && game._moveLog;
    if (!buf || buf.length === 0) return;
    const totals = game.totals || {};
    // Rank players by final total (1 = winner).
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const rankOf = {};
    ranked.forEach(([pid], i) => {
      rankOf[pid] = i + 1;
    });
    const winnerId = ranked.length ? ranked[0][0] : null;
    const winnerTotal = ranked.length ? ranked[0][1] : 0;
    const gameId = Math.random().toString(36).slice(2, 10);
    const players = (game.players || []).length;
    const rounds = game.roundNumber || 0;
    const turns = game.gameTurnCount || 0;

    const lines = buf.map((m) => {
      // Compact ("minified") row: rounded observation, 0/1 mask, no whitespace.
      const row = {
        g: gameId,
        phase: m.phase,
        obs: m.obs.map(round4),
        action: m.action,
        mask: m.mask.map((b) => (b ? 1 : 0)),
        won: m.playerId === winnerId,
        rank: rankOf[m.playerId] || null,
        finalTotal: totals[m.playerId] != null ? totals[m.playerId] : null,
        winnerTotal,
        players,
        rounds,
        turns,
        round: m.round,
        turn: m.turn,
        hand: m.hand,
        opp: m.opp,
        pileTakeLegal: m.pileTakeLegal ? 1 : 0,
      };
      return JSON.stringify(row); // JSON.stringify emits no extra whitespace
    });
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, lines.join('\n') + '\n');
    game._moveLog = [];
  } catch (e) {
    /* logging must never break a game */
  }
}

module.exports = { enabled, record, flush, LOG_PATH };
