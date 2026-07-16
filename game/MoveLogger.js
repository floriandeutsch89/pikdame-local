'use strict';

/**
 * Records human move decisions for imitation learning (behavioral cloning) and
 * offline RL, in a best-practice, self-describing, encoder-independent format.
 *
 * When PIKDAME_LOG_GAMES is not disabled (on by default; PIKDAME_LOG_GAMES=0
 * /false/off turns it off), every draw and discard decision made by a HUMAN
 * (never a bot) is recorded and buffered per game, then flushed to a JSONL file
 * at game over with the final outcome.
 *
 * Each row carries THREE views of the same decision so the data stays useful
 * even if the model changes:
 *   1. `state` - the raw, human-readable game state FROM THE DECIDING PLAYER'S
 *      POV (their actual hand, the discard top, table melds, opponents' hand
 *      counts and publicly-known cards, pile counts). Encoder-independent, so a
 *      future/improved StateEncoder can RE-ENCODE these logs.
 *   2. `move` - the deserialized action (e.g. {type:'discard', card:'QS'} or
 *      {type:'takeDiscard'} / {type:'drawPile'}), human-readable.
 *   3. `obs` + `action` + `mask` - the encoded network input (StateEncoder,
 *      OBS_SIZE floats), the action index (ACTION_SIZE space) and the legal
 *      mask, so training runs directly without re-implementing the encoder.
 * Plus the game outcome (won/rank/totals) for winner-filtering and weighting.
 *
 * Privacy: only anonymous gameplay data is written - the cards and game state of
 * an anonymous seat in an anonymous game. NO names, NO account or device ids, NO
 * IP addresses; the per-game id is random and not linkable to a person. Card
 * codes are gameplay moves, not personal data.
 *
 * See https://pik-dame.readthedocs.io/en/latest/developer/rl-setup.html ("Log data format") for the full field reference.
 */

const fs = require('fs');
const path = require('path');
const SE = require('./StateEncoder');

const LOG_PATH = process.env.PIKDAME_LOG_PATH || path.join(__dirname, '..', 'data', 'human-moves.jsonl');

/**
 * Rules version stamped into every row, so training can filter out data that
 * was collected under different game rules:
 *   1 = up to v1.70: discard pile recycled on an empty draw pile, no set-aside
 *       cut packet (rows without an `rv` field are implicitly version 1)
 *   2 = v1.71..v1.77: the cut packet was set aside for the whole round,
 *       nothing refilled on an empty draw pile, empty-pile round end
 *   3 = since v1.78: the cut packet RETURNS to the draw pile (constant
 *       opening pile again); empty-pile round end and no-reshuffle unchanged
 * Bump this whenever a gameplay rule changes the decision environment.
 */
const RULES_VERSION = 3;

function enabled() {
  // On by default; only an explicit 0/false/off turns human-move logging off.
  const v = process.env.PIKDAME_LOG_GAMES;
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** Compact, human-readable card code: rank+suit ("QS", "10H"), jokers "JK". */
function cardCode(card) {
  if (!card) return null;
  if (card.isJoker) return 'JK';
  return `${card.rank}${card.suit}`;
}

function seatIndex(game, playerId) {
  return (game.players || []).findIndex((p) => p.id === playerId);
}

/** The full decision context as the deciding player could legitimately see it
 *  (own hand in full; opponents only by count + publicly-known cards). */
function povState(game, playerId) {
  const me = (game.players || []).find((p) => p.id === playerId) || { hand: [] };
  const known = game.publicKnownHands || {};
  return {
    hand: (me.hand || []).map(cardCode),
    drawCount: game.drawPile.length,
    discardTop: cardCode(game.discardPile[0]),
    discardCount: game.discardPile.length,
    melds: (game.tableMelds || []).map((m) => ({
      owner: seatIndex(game, m.ownerId),
      type: m.type,
      cards: m.slots.map((s) => cardCode(s.real || s.joker)).filter(Boolean),
    })),
    opponents: (game.players || [])
      .filter((p) => p.id !== playerId)
      .map((p) => ({
        seat: seatIndex(game, p.id),
        handCount: (p.hand || []).length,
        isBot: !!p.isBot,
        known: (known[p.id] || []).map(cardCode), // cards everyone has SEEN them take
      })),
  };
}

/** Deserialized action for readability/verification. `card` is the actual
 *  discarded card (discard phase only). */
function moveFor(game, phase, action, card) {
  if (phase === 'draw') {
    if (action === SE.ACTION_TAKE_PILE) return { type: 'takeDiscard', card: cardCode(game.discardPile[0]) };
    return { type: 'drawPile', card: null };
  }
  return { type: 'discard', card: cardCode(card) };
}

/**
 * Buffer one human decision. `phase` is 'draw' or 'discard'; `action` is the
 * StateEncoder action index; `card` is the actual card for a discard (optional).
 * Bots and invalid actions are skipped.
 */
function record(game, playerId, phase, action, card) {
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
      playerId, // stripped on flush - only used to tag won/rank
      seat: seatIndex(game, playerId),
      phase,
      round: game.roundNumber || 0,
      turn: game.gameTurnCount || 0,
      pileTakeLegal: !!pileLegal,
      move: moveFor(game, phase, action, card),
      state: povState(game, playerId),
      action,
      obs: Array.from(obs),
      mask,
    });
  } catch (e) {
    /* never disrupt a turn */
  }
}

// Round observation floats to keep the log compact ("minified") by default.
function round4(x) {
  return Math.round(x * 1e4) / 1e4;
}

/**
 * Write the buffered moves for a finished game, tagged with the outcome.
 * `outcome`: 'completed' (played to 1000) or 'forfeit' (abandoned by vote).
 * Forfeited games are still WRITTEN (they may be useful for other analyses),
 * but the training loader skips everything that is not 'completed'.
 */
function flush(game, outcome = 'completed') {
  if (!enabled()) return;
  try {
    const buf = game && game._moveLog;
    if (!buf || buf.length === 0) return;
    const totals = game.totals || {};
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

    const lines = buf.map((m) =>
      JSON.stringify({
        g: gameId,
        seat: m.seat,
        phase: m.phase,
        round: m.round,
        turn: m.turn,
        pileTakeLegal: m.pileTakeLegal ? 1 : 0,
        // deserialized + raw state (encoder-independent, human-readable)
        move: m.move,
        state: m.state,
        // encoded network view (for direct training), minified
        action: m.action,
        obs: m.obs.map(round4),
        mask: m.mask.map((b) => (b ? 1 : 0)),
        // outcome
        outcome,
        rv: RULES_VERSION,
        won: m.playerId === winnerId,
        rank: rankOf[m.playerId] || null,
        finalTotal: totals[m.playerId] != null ? totals[m.playerId] : null,
        winnerTotal,
        players,
        rounds,
        turns,
      })
    );
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, lines.join('\n') + '\n');
    game._moveLog = [];
  } catch (e) {
    /* logging must never break a game */
  }
}

/**
 * Remove the most recent buffered move if it is a TAKE_PILE by this player -
 * called when the pickup is taken back (undoPileTake). A take that was
 * immediately undone never happened as far as imitation learning is
 * concerned; leaving it in would teach the model takes with no follow-up.
 */
function unrecordLastPileTake(game, playerId) {
  try {
    const buf = game && game._moveLog;
    if (!buf || buf.length === 0) return;
    const last = buf[buf.length - 1];
    if (last.playerId === playerId && last.action === SE.ACTION_TAKE_PILE) buf.pop();
  } catch (e) {
    /* logging must never break a game */
  }
}

module.exports = { enabled, record, flush, unrecordLastPileTake, cardCode, LOG_PATH, RULES_VERSION };
