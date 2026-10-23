'use strict';

// Enumerates the moves a seat may make RIGHT NOW, from that seat's own view
// (the `state` the server sends). Every candidate is replayed on a throwaway
// GameManager built from that view, so legality is decided by the real engine
// code, not by a second copy of the rules.

const GameManager = require('../game/GameManager');
const { enumerateMeldOptions, enumerateLayOffOptions, tryJokerSwap } = require('../game/Rules');
const { RANKS, SUITS, cardValue } = require('../game/Card');

const SUIT_SYMBOL = { H: '♥', D: '♦', C: '♣', S: '♠' };
const RING = RANKS.length;

function cardText(card) {
  if (!card) return '?';
  if (card.faceDown) return '(face down)';
  if (card.isJoker) return 'JK';
  return `${card.rank}${SUIT_SYMBOL[card.suit] || card.suit}`;
}

function slotText(slot) {
  if (slot.real) return cardText(slot.real);
  return `JK(=${slot.representsRank}${SUIT_SYMBOL[slot.representsSuit] || ''})`;
}

function meldText(meld) {
  return meld.slots.map(slotText).join(' ');
}

// Sort key for a readable hand: by suit, then rank; jokers last.
function handOrder(a, b) {
  if (a.isJoker !== b.isJoker) return a.isJoker ? 1 : -1;
  if (a.isJoker) return 0;
  if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  return RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank);
}

/** A disposable engine instance holding exactly what `myId` can see. Other
 *  hands and the draw pile are filler cards: no meld-phase rule reads them. */
function buildShadow(state, myId) {
  const g = new GameManager(() => {});
  const filler = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}`, suit: 'H', rank: '2', isJoker: false }));
  g.phase = 'playing';
  g.paused = false;
  g.turnPhase = state.turnPhase;
  g.houseRules = { ...(state.houseRules || {}), turnTimerSeconds: 0 };
  g.players = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    isBot: false,
    connected: true,
    hand: p.id === myId ? structuredClone(p.hand || []) : filler(p.handCount || 0, `hidden-${p.id}`),
    laidOutCards: [],
  }));
  g.currentPlayerIndex = Math.max(0, g.players.findIndex((p) => p.id === state.currentPlayerId));
  g.tableMelds = structuredClone(state.tableMelds || []);
  g.retiredJokers = structuredClone(state.retiredJokers || []);
  g.discardPile = (state.discardCards || []).map((c, i) => (c.faceDown ? { id: `facedown-${i}`, suit: 'H', rank: '2', faceDown: true } : { ...c }));
  g.drawPile = filler(state.drawPileCount || 0, 'pile');
  g.mustLayOffCardId = state.mustLayOffCardId || null;
  // Both are set together on a pickup and cleared together once the card is laid.
  g.pendingDiscardRest = !!state.mustLayOffCardId;
  return g;
}

/** Replays one WS message on a fresh shadow; true when the engine accepts it. */
function engineAccepts(state, myId, msg) {
  const g = buildShadow(state, myId);
  try {
    let r;
    switch (msg.type) {
      case 'layoutMeld': r = g.layoutMeld(myId, msg.cardIds, msg.jokerAssignments || {}, { byOrder: false }); break;
      case 'layOff': r = g.layOffCard(myId, msg.meldId, msg.cardId, msg.asSuit, msg.side); break;
      case 'swapJoker': r = g.swapJoker(myId, msg.meldId, msg.handCardId); break;
      case 'discard': r = g.discard(myId, msg.cardId); break;
      default: return false;
    }
    return !!(r && r.ok);
  } catch (e) {
    return false;
  } finally {
    g.destroy();
  }
}

// One card per identical (rank, suit) pair, preferring `preferId` (the
// mandatory pickup card must be the copy that is used).
function pickCopies(cards, count, preferId) {
  const sorted = cards.slice().sort((a, b) => (a.id === preferId ? -1 : b.id === preferId ? 1 : 0));
  return sorted.slice(0, count);
}

function candidateMelds(hand, mustId) {
  const reals = hand.filter((c) => !c.isJoker);
  const jokers = hand.filter((c) => c.isJoker);
  const out = [];

  // Sets: per rank, 0-2 copies of each suit plus 0..n jokers, 3..8 cards.
  for (const rank of RANKS) {
    const bySuit = SUITS.map((s) => reals.filter((c) => c.rank === rank && c.suit === s));
    if (bySuit.every((l) => l.length === 0)) continue;
    const walk = (si, chosen) => {
      if (si === SUITS.length) {
        if (chosen.length === 0) return;
        for (let j = 0; j <= jokers.length && chosen.length + j <= 8; j++) {
          if (chosen.length + j >= 3) out.push(chosen.concat(jokers.slice(0, j)));
        }
        return;
      }
      for (let n = 0; n <= Math.min(2, bySuit[si].length); n++) {
        walk(si + 1, chosen.concat(pickCopies(bySuit[si], n, mustId)));
      }
    };
    walk(0, []);
  }

  // Runs: every ring window of length 3..13; a hand card fills each rank it
  // has, jokers fill the gaps. (Jokers standing in for a card the hand holds
  // are not offered - it only wastes the joker.)
  for (const suit of SUITS) {
    const byRank = RANKS.map((r) => reals.filter((c) => c.suit === suit && c.rank === r));
    if (byRank.every((l) => l.length === 0)) continue;
    for (let len = 3; len <= RING; len++) {
      for (let start = 0; start < (len === RING ? 1 : RING); start++) {
        const cards = [];
        let gaps = 0;
        for (let i = 0; i < len; i++) {
          const copies = byRank[(start + i) % RING];
          if (copies.length) cards.push(pickCopies(copies, 1, mustId)[0]);
          else gaps++;
        }
        if (cards.length === 0 || gaps > jokers.length) continue;
        out.push(cards.concat(jokers.slice(0, gaps)));
      }
    }
  }

  // One interpretation per card set and meld type: where exactly a joker sits
  // in a run only multiplies the list (it can be swapped or extended later).
  // Joker-heavy melds (more jokers than real cards) are left out to keep the
  // list readable - except for the pickup duty, which must never dead-end.
  const seen = new Set();
  const melds = [];
  for (const cards of out) {
    if (mustId && !cards.some((c) => c.id === mustId)) continue;
    const jokerCount = cards.filter((c) => c.isJoker).length;
    if (!mustId && jokerCount > cards.length - jokerCount) continue;
    for (const opt of enumerateMeldOptions(cards)) {
      const key = `${opt.type}|${cards.map((c) => c.id).sort().join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      melds.push({ cards, type: opt.type, jokerAssignments: opt.jokerAssignments, key });
    }
  }
  return melds;
}

function meldPreview(cards, type, assignments) {
  // Jokers show the card they stand for; runs are printed in ring order.
  const real = cards.find((c) => !c.isJoker);
  if (type === 'set') {
    return cards.map((c) => (c.isJoker ? `JK(=${real.rank})` : cardText(c))).join(' ');
  }
  const idx = (c) => RANKS.indexOf(c.isJoker ? assignments[c.id] : c.rank);
  const sorted = cards.slice().sort((a, b) => idx(a) - idx(b));
  // Restore ring order for wrapping runs (K-A-2): start after the largest gap.
  let cut = 0;
  let best = -1;
  for (let i = 0; i < sorted.length; i++) {
    const gap = (idx(sorted[(i + 1) % sorted.length]) - idx(sorted[i]) + RING) % RING;
    if (gap > best) { best = gap; cut = (i + 1) % sorted.length; }
  }
  const ordered = sorted.slice(cut).concat(sorted.slice(0, cut));
  return ordered.map((c) => (c.isJoker ? `JK(=${assignments[c.id]}${SUIT_SYMBOL[real.suit]})` : cardText(c))).join(' ');
}

const sumPoints = (cards) => cards.reduce((s, c) => s + cardValue(c), 0);

/**
 * All legal actions for `myId` in `state`, each with a stable `key`, a
 * human-readable `label` and the WS `msg` that performs it.
 */
function legalActions(state, myId) {
  if (!state || !myId) return [];
  const me = state.players.find((p) => p.id === myId);
  if (!me) return [];
  const actions = [];
  const add = (key, label, msg) => actions.push({ key, label, msg });

  if (state.phase === 'lobby') {
    if (state.isHost) add('start', 'Start the game (empty seats are filled with bots)', { type: 'startGame' });
    const ready = (state.lobbyReady || []).includes(myId);
    add('ready', ready ? 'Withdraw "ready"' : 'Mark yourself ready (needed when several humans sit at the table)', { type: 'lobbyReady' });
    // "2 gegen 2": move to a bot seat of the other team (the server refuses when none is free).
    if (state.teamMode) add('switchTeam', 'Switch to the other team (takes a free bot seat there)', { type: 'switchTeam' });
    // The host picks the mode (the server refuses it at a Stammtisch).
    if (state.isHost) {
      add('teamMode', state.teamMode ? 'Back to a normal table (everyone plays for themselves)' : 'Make it "2 vs 2": two teams of two, seated crosswise, sharing their points',
        { type: 'setTeamMode', on: !state.teamMode });
    }
    return actions;
  }
  if (state.phase === 'cutting') {
    if (state.cutterId === myId) {
      for (const [k, pos] of [['top', 0.2], ['middle', 0.5], ['bottom', 0.8]]) {
        add(`cut:${k}`, `Cut the deck near the ${k}`, { type: 'performCut', position: pos });
      }
    }
    return actions;
  }
  if (state.phase === 'roundEnd') {
    if (!(state.nextRoundReady || []).includes(myId)) add('next', 'Continue to the next round', { type: 'nextRound' });
    return actions;
  }
  if (state.phase !== 'playing' || state.paused || state.currentPlayerId !== myId) return actions;

  const hand = me.hand || [];
  if (state.turnPhase === 'draw') {
    if (state.discardTakeable) {
      const rest = Math.max(0, (state.discardPileCount || 1) - 1);
      add('take', `Take the discard pile (top ${cardText(state.discardTop)} must be laid in a NEW meld right away${rest ? `; the other ${rest} cards then go onto your hand` : ''})`, { type: 'drawFromDiscard' });
    }
    if (!(state.drawPileCount === 0 && state.discardTakeable)) {
      add('draw', state.drawPileCount > 0 ? 'Draw the top card of the draw pile' : 'Draw pile is empty - this ends the round', { type: 'drawFromPile' });
    }
    return actions;
  }

  // --- meld phase ---
  const mustId = state.mustLayOffCardId || null;

  const ownSets = new Set(state.tableMelds.filter((m) => m.ownerId === myId && m.type === 'set').map((m) => m.rank));
  const melds = candidateMelds(hand, mustId)
    .map((m) => ({ ...m, msg: { type: 'layoutMeld', cardIds: m.cards.map((c) => c.id), jokerAssignments: m.jokerAssignments } }))
    .filter((m) => engineAccepts(state, myId, m.msg))
    .sort((a, b) => b.cards.length - a.cards.length || sumPoints(b.cards) - sumPoints(a.cards));
  for (const m of melds) {
    const rank = m.type === 'set' && (m.cards.find((c) => !c.isJoker) || {}).rank;
    const merge = m.type === 'set' && ownSets.has(rank) ? ', merges into your existing set' : '';
    add(`meld:${m.key}`, `Lay out ${m.type}: ${meldPreview(m.cards, m.type, m.jokerAssignments)} (+${sumPoints(m.cards)}${merge})`, m.msg);
  }

  const own = state.tableMelds.filter((m) => m.ownerId === myId);
  const distinct = [];
  const seenCard = new Set();
  for (const c of hand.slice().sort(handOrder)) {
    const sig = c.isJoker ? 'JK' : `${c.rank}${c.suit}`;
    if (seenCard.has(sig) && c.id !== mustId) continue;
    seenCard.add(sig);
    distinct.push(c);
  }

  for (const meld of own) {
    for (const card of distinct) {
      for (const opt of enumerateLayOffOptions(meld, card)) {
        const msg = { type: 'layOff', meldId: meld.id, cardId: card.id, asSuit: opt.asSuit, side: opt.side };
        if (!engineAccepts(state, myId, msg)) continue;
        const where = opt.side ? ` at the ${opt.side} end` : '';
        add(`layoff:${meld.id}:${card.id}:${opt.asSuit || ''}:${opt.side || ''}`, `Lay off ${cardText(card)} onto your meld [${meldText(meld)}]${where} (+${cardValue(card)})`, msg);
      }
      if (!card.isJoker && tryJokerSwap(meld, card)) {
        const msg = { type: 'swapJoker', meldId: meld.id, handCardId: card.id };
        if (engineAccepts(state, myId, msg)) {
          add(`swap:${meld.id}:${card.id}`, `Swap ${cardText(card)} for the joker in your meld [${meldText(meld)}] (the joker leaves play)`, msg);
        }
      }
    }
  }

  if (!mustId) {
    for (const card of distinct) {
      const last = hand.length === 1;
      add(`discard:${card.id}`, `Discard ${cardText(card)}${last ? ' - your LAST card: you go out and end the round' : ' (ends your turn)'}`, { type: 'discard', cardId: card.id });
    }
  }
  // Last on purpose: a careless "option 1" should never be a take-back.
  if (state.canUndoPileTake) add('undoTake', 'Undo: put the taken discard card back and draw again', { type: 'undoPileTake' });
  if (state.canUndoMeld) add('undoMeld', 'Undo your last meld/lay-off/joker swap of this turn', { type: 'undoMeld' });
  return actions;
}

module.exports = { legalActions, buildShadow, engineAccepts, cardText, meldText, handOrder, SUIT_SYMBOL };
