// public/table-moves.js
// What another player just did at the table, read from two states: which pile,
// meld or the stock gained or lost which card. A bot turn arrives as ONE state,
// so moves come from locations, never from hand counts. Loaded before
// client.js (which flies them); the tests require() it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PikdameTableMoves = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const FACE_DOWN = '#faceDown'; // the last card goes face down: it has no id
  const OVER = new Set(['roundEnd', 'gameOver']);
  // One opponent turn on the table at normal bot pace; "Schnell" halves it (bot pace).
  const BUDGET_MS = 600;
  const TAKE_SHOWN = 3; // a swallowed pile: its top cards fly, the rest is implied

  /** The positions of one state as seen by `meId` (card ids by location), or null. */
  function facts(st, meId) {
    if (!st || typeof st !== 'object' || !Array.isArray(st.players) || !Array.isArray(st.discardCards)) return null;
    const pile = [];
    const faces = new Map();
    for (const c of st.discardCards) {
      if (!c || c.faceDown || c.id == null) { pile.push(FACE_DOWN); continue; }
      pile.push(c.id);
      faces.set(c.id, { id: c.id, rank: c.rank, suit: c.suit, isJoker: !!c.isJoker });
    }
    const table = new Map();
    const order = [];
    for (const m of st.tableMelds || []) {
      if (!m) continue;
      order.push(m.id);
      (m.slots || []).forEach((s, slot) => {
        const c = s && (s.real || s.joker);
        if (c && c.id != null) table.set(c.id, { meld: m.id, owner: m.ownerId, slot });
      });
    }
    const me = st.players.find((p) => p && p.id === meId);
    return {
      round: st.roundNumber,
      phase: st.phase,
      turn: st.turnIndexInRound,
      cur: st.currentPlayerId || null,
      step: st.turnPhase || null,
      mustLay: st.mustLayOffCardId || null,
      // The stock is the one place without card ids; within a round it only ever shrinks.
      stock: Number.isFinite(st.drawPileCount) ? st.drawPileCount : null,
      pile, // top first
      faces,
      table,
      order,
      mine: new Set(((me && me.hand) || []).map((c) => c.id)),
    };
  }

  const endsWith = (arr, tail) => arr.length >= tail.length && tail.every((id, i) => arr[arr.length - tail.length + i] === id);

  /** The pile is a stack: a take lifts the top card, the rest goes as a whole,
   *  a discard lands on top. `taken` top first, `placed` the new cards on top. */
  function pileMoves(before, after, turnDone) {
    if (endsWith(after, before)) return { taken: [], placed: after.slice(0, after.length - before.length) };
    const rest = before.slice(1);
    // [A, x] -> [x] after a finished turn: all of it was taken and x thrown again.
    const rethrown = turnDone && after.length === 1 && after.length === rest.length;
    if (before.length && endsWith(after, rest) && !rethrown) {
      return { taken: [before[0]], placed: after.slice(0, after.length - rest.length) };
    }
    return { taken: before.slice(), placed: after.slice() };
  }

  /** The moves of the player on turn between two facts; [] when unsure (never a false move).
   *  draw (stock), take (pile cards, top first), meld (new cards per meld), discard. */
  function diff(prev, now, meId) {
    if (!prev || !now || prev.round !== now.round || prev.phase !== 'playing') return [];
    const over = OVER.has(now.phase);
    if (now.phase !== 'playing' && !over) return [];
    const who = prev.cur;
    if (!who || who === meId) return []; // my own moves fly from my taps
    const dTurn = now.turn - prev.turn;
    // A round ends inside the turn; otherwise the same turn goes on or the next began.
    if (over ? dTurn !== 0 : !((dTurn === 0 && now.cur === who) || dTurn === 1)) return [];
    const turnDone = dTurn === 1 || over;

    const { taken, placed } = pileMoves(prev.pile, now.pile, turnDone);
    const drawn = prev.stock != null && now.stock != null ? prev.stock - now.stock : 0;
    if (drawn < 0 || drawn > 1 || placed.length > 1 || (drawn && taken.length)) return [];
    if (drawn && prev.step !== 'draw') return [];
    // Pile cards leave in the draw phase, or as the rest once the taken card is laid.
    if (taken.length && prev.step !== 'draw' && !prev.mustLay) return [];
    for (const id of taken) {
      const t = now.table.get(id);
      if (now.mine.has(id) || (t && t.owner !== who)) return [];
    }
    const laid = [];
    for (const [id, t] of now.table) {
      if (prev.table.has(id)) continue;
      if (t.owner !== who || now.mine.has(id)) return [];
      laid.push(id);
    }
    let card = null;
    if (placed.length) {
      const id = placed[0];
      if (id === FACE_DOWN) {
        if (!over) return [];
        card = { faceDown: true };
      } else {
        if (prev.table.has(id) || now.table.has(id) || now.mine.has(id) || !now.faces.has(id)) return [];
        // Within the turn only "Zurücklegen" puts a card on the pile: the one just taken.
        if (!turnDone && prev.mustLay !== id) return [];
        card = now.faces.get(id);
      }
    } else if (dTurn === 1) {
      return []; // every finished turn ends with its discard
    }

    const moves = [];
    if (drawn) moves.push({ kind: 'draw', who });
    if (taken.length) moves.push({ kind: 'take', who, cards: taken.map((id) => prev.faces.get(id)) });
    for (const meld of now.order) {
      const cards = laid
        .filter((id) => now.table.get(id).meld === meld)
        .map((id) => ({ id, slot: now.table.get(id).slot }))
        .sort((a, b) => a.slot - b.slot);
      if (cards.length) moves.push({ kind: 'meld', who, meld, cards });
    }
    if (card) moves.push({ kind: 'discard', who, card, back: !turnDone });
    return moves;
  }

  /** Did anything move between two facts (a vote or an emote moves nothing)? */
  function changed(a, b) {
    if (!a || !b) return a !== b;
    if (a.round !== b.round || a.phase !== b.phase || a.turn !== b.turn || a.cur !== b.cur ||
      a.step !== b.step || a.stock !== b.stock || a.mustLay !== b.mustLay) return true;
    if (a.pile.length !== b.pile.length || a.pile.some((id, i) => id !== b.pile[i])) return true;
    if (a.table.size !== b.table.size) return true;
    for (const [id, t] of a.table) {
      const u = b.table.get(id);
      if (!u || u.meld !== t.meld || u.slot !== t.slot) return true;
    }
    return false;
  }

  /** Flight times for moves, starting `from` ms into a turn of `budget` ms: one
   *  flight per stock draw, taken card (top three), meld card and discard, in
   *  turn order and overlapping; squeezed into what is left of the budget. */
  function plan(moves, { budget = BUDGET_MS, from = 0 } = {}) {
    const B = budget;
    const fly = 0.45 * B;
    const flights = [];
    let t = from;
    let meldCards = [];
    const flushMelds = () => {
      if (!meldCards.length) return;
      const n = meldCards.length;
      const step = n > 1 ? Math.min(0.07 * B, (0.22 * B) / (n - 1)) : 0;
      meldCards.forEach(([move, card], i) => flights.push({ move, card, start: t + i * step, dur: fly }));
      t += (n - 1) * step + 0.25 * B;
      meldCards = [];
    };
    for (const move of moves) {
      if (move.kind === 'meld') {
        for (const card of move.cards) meldCards.push([move, card]);
        continue;
      }
      flushMelds();
      if (move.kind === 'draw') {
        flights.push({ move, card: null, start: t, dur: fly });
        t += 0.3 * B;
      } else if (move.kind === 'take') {
        const shown = move.cards.slice(0, TAKE_SHOWN);
        shown.forEach((card, i) => flights.push({ move, card, start: t + i * 0.06 * B, dur: fly }));
        t += 0.3 * B + (shown.length - 1) * 0.06 * B;
      } else if (move.kind === 'discard') {
        flights.push({ move, card: move.card, start: t, dur: fly });
        t += fly;
      }
    }
    flushMelds();
    const end = flights.reduce((m, f) => Math.max(m, f.start + f.dur), from);
    const room = B - from;
    if (end - from > room) {
      // Never slower than the next bot move; below 55 % a flight is a blur, so the tail may run over.
      const k = Math.max(0.55, room / (end - from));
      for (const f of flights) {
        f.start = from + (f.start - from) * k;
        f.dur *= k;
      }
      t = from + (t - from) * k;
    }
    return { flights, cursor: t };
  }

  return { FACE_DOWN, BUDGET_MS, TAKE_SHOWN, facts, diff, changed, plan, pileMoves };
}));
