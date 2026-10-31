// Other players' moves read from two states (public/table-moves.js): stock draw,
// pile take, new meld cards and the discard - from where the cards are, never from
// hand counts. The fuzz drives the engine seat by seat and checks every state against
// what the engine did since the state before: no false moves, no missed ones.
const test = require('node:test');
const assert = require('node:assert');
const TM = require('../public/table-moves.js');
const GameManager = require('../game/GameManager');
const Bot = require('../game/Bot');

// --- hand-built states ------------------------------------------------------------
/** 'H7-0' -> the seven of hearts of deck 0 (engine ids: suit, rank, deck). */
const C = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
/** A playing state as p1 sees it: pile top first, melds as [ownerId, [ids]] (a 'J*' id is a joker slot). */
function st({ pile = ['D4-0'], melds = [], turn = 8, cur = 'b1', phase = 'meld', draw = 40, faceDownTop = false, mustLay = null, roundNumber = 2, state = 'playing' } = {}) {
  const cards = pile.map(C);
  return {
    phase: state, roundNumber, turnIndexInRound: turn, currentPlayerId: cur, turnPhase: phase,
    drawPileCount: draw, mustLayOffCardId: mustLay,
    discardTop: cards[0] ? (faceDownTop ? { faceDown: true } : cards[0]) : null,
    discardCards: cards.map((c, i) => (i === 0 && faceDownTop ? { faceDown: true } : c)),
    tableMelds: melds.map(([ownerId, ids], i) => ({
      id: `m${i}`, ownerId, type: 'set',
      slots: ids.map((id) => (id.startsWith('J') ? { joker: { id, isJoker: true }, representsRank: '7', representsSuit: 'S' } : { real: C(id) })),
    })),
    players: [
      { id: 'p1', name: 'Flo', handCount: 2, hand: [C('H2-0'), C('C9-0')] },
      { id: 'b1', name: 'Klaus', handCount: 12 },
      { id: 'b2', name: 'Horst', handCount: 9 },
    ],
  };
}
const F = (o) => TM.facts(st(o), 'p1');
/** Moves as short strings: draw:b1, take:b1:D4-0, meld:b1:m0:H7-0, discard:b1:C3-0, back:b1:D4-0. */
function said(moves) {
  const out = [];
  for (const m of moves) {
    if (m.kind === 'draw') out.push(`draw:${m.who}`);
    if (m.kind === 'take') for (const c of m.cards) out.push(`take:${m.who}:${c.id}`);
    if (m.kind === 'meld') for (const c of m.cards) out.push(`meld:${m.who}:${m.meld}:${c.id}`);
    if (m.kind === 'discard') out.push(`${m.back ? 'back' : 'discard'}:${m.who}:${m.card.faceDown ? 'facedown' : m.card.id}`);
  }
  return out;
}
const diffOf = (a, b) => said(TM.diff(F(a), F(b), 'p1'));

test('a bot turn in one state: stock draw, two new melds and the discard, in turn order', () => {
  const before = { phase: 'draw', pile: ['D4-0'], melds: [['b2', ['S5-0', 'S6-0', 'S7-0']]] };
  const after = { turn: 9, cur: 'b2', phase: 'draw', draw: 39, pile: ['C3-0', 'D4-0'],
    melds: [['b2', ['S5-0', 'S6-0', 'S7-0']], ['b1', ['H7-0', 'D7-0', 'J1']], ['b1', ['C10-0', 'CJ-0', 'CQ-0']]] };
  assert.deepEqual(diffOf(before, after), [
    'draw:b1', 'meld:b1:m1:H7-0', 'meld:b1:m1:D7-0', 'meld:b1:m1:J1',
    'meld:b1:m2:C10-0', 'meld:b1:m2:CJ-0', 'meld:b1:m2:CQ-0', 'discard:b1:C3-0',
  ]);
  const moves = TM.diff(F(before), F(after), 'p1');
  assert.deepEqual(moves.find((m) => m.kind === 'meld').cards.map((c) => c.slot), [0, 1, 2], 'slots name the card in its group');
  assert.deepEqual(moves.at(-1).card, { id: 'C3-0', rank: '3', suit: 'C', isJoker: false }, 'the discard carries its face');
});

test('a lay-off is a new card in an existing meld; a merged set keeps its old cards', () => {
  const before = { melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] };
  assert.deepEqual(diffOf(before, { melds: [['b1', ['H7-0', 'D7-0', 'C7-0', 'S7-1']]] }), ['meld:b1:m0:S7-1']);
  // The second set of sevens merges into the first: only the three new cards moved.
  assert.deepEqual(diffOf(before, { melds: [['b1', ['H7-0', 'D7-0', 'C7-0', 'H7-1', 'D7-1', 'C7-1']]] }),
    ['meld:b1:m0:H7-1', 'meld:b1:m0:D7-1', 'meld:b1:m0:C7-1']);
});

test('a joker swap: the real card is new, the joker leaving the table is no move', () => {
  const before = { melds: [['b1', ['H7-0', 'D7-0', 'J1']]] };
  assert.deepEqual(diffOf(before, { melds: [['b1', ['H7-0', 'D7-0', 'S7-0']]] }), ['meld:b1:m0:S7-0']);
});

test('the pile is a stack: take the top, the rest as a whole, a discard on top', () => {
  const P = ['A', 'B', 'C'];
  assert.deepEqual(TM.pileMoves(P, ['D', 'A', 'B', 'C'], true), { taken: [], placed: ['D'] });
  assert.deepEqual(TM.pileMoves(P, ['B', 'C'], false), { taken: ['A'], placed: [] }, 'phase 1: only the top card');
  assert.deepEqual(TM.pileMoves(P, [], false), { taken: P, placed: [] }, 'the rest followed');
  assert.deepEqual(TM.pileMoves(P, ['D'], true), { taken: P, placed: ['D'] });
  assert.deepEqual(TM.pileMoves(P, ['C'], true), { taken: P, placed: ['C'] }, 'the bottom card taken and thrown again');
  assert.deepEqual(TM.pileMoves(['A', 'C'], ['C'], true), { taken: ['A', 'C'], placed: ['C'] }, 'two cards, the lower one thrown again');
  assert.deepEqual(TM.pileMoves(['A', 'C'], ['C'], false), { taken: ['A'], placed: [] }, 'mid-turn the lower one simply stayed');
  assert.deepEqual(TM.pileMoves(P, ['D', 'B', 'C'], true), { taken: ['A'], placed: ['D'] }, 'stranded pickup: the rest stays');
  assert.deepEqual(TM.pileMoves(['B', 'C'], ['A', 'B', 'C'], false), { taken: [], placed: ['A'] }, '"Zurücklegen"');
  assert.deepEqual(TM.pileMoves([], ['D'], true), { taken: [], placed: ['D'] });
});

test('a human takes the pile in two states: the top card, then the rest with the meld', () => {
  const s0 = { phase: 'draw', pile: ['H7-0', 'C3-0', 'D4-0'] };
  const s1 = { phase: 'meld', pile: ['C3-0', 'D4-0'], mustLay: 'H7-0' };
  const s2 = { phase: 'meld', pile: [], melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] };
  const s3 = { turn: 9, cur: 'b2', phase: 'draw', pile: ['D4-0'], melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] };
  assert.deepEqual(diffOf(s0, s1), ['take:b1:H7-0']);
  assert.deepEqual(diffOf(s1, s2), ['take:b1:C3-0', 'take:b1:D4-0', 'meld:b1:m0:H7-0', 'meld:b1:m0:D7-0', 'meld:b1:m0:C7-0']);
  assert.deepEqual(diffOf(s2, s3), ['discard:b1:D4-0'], 'a card from the swallowed pile thrown again');
  // "Zurücklegen" right after the take: the card goes back on top.
  assert.deepEqual(diffOf(s1, { phase: 'draw', pile: ['H7-0', 'C3-0', 'D4-0'] }), ['back:b1:H7-0']);
});

test('a Zen bot: melds in one state, its discard a moment later in the next', () => {
  const s0 = { phase: 'draw', pile: ['D4-0'] };
  const s1 = { phase: 'meld', draw: 39, melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] };
  const s2 = { turn: 9, cur: 'b2', phase: 'draw', draw: 39, pile: ['C3-0', 'D4-0'], melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] };
  assert.deepEqual(diffOf(s0, s1), ['draw:b1', 'meld:b1:m0:H7-0', 'meld:b1:m0:D7-0', 'meld:b1:m0:C7-0']);
  assert.deepEqual(diffOf(s1, s2), ['discard:b1:C3-0']);
});

test('going out: the last card face down, the round ends in the same state', () => {
  const before = { phase: 'draw', pile: ['D4-0'] };
  const out = { phase: 'draw', state: 'roundEnd', draw: 39, pile: ['X1-0', 'D4-0'], faceDownTop: true, melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] };
  assert.deepEqual(diffOf(before, out), ['draw:b1', 'meld:b1:m0:H7-0', 'meld:b1:m0:D7-0', 'meld:b1:m0:C7-0', 'discard:b1:facedown']);
  // Game over is a round end too.
  assert.deepEqual(diffOf(before, { ...out, state: 'gameOver' }).at(-1), 'discard:b1:facedown');
});

test('nothing on: my own turn, a baseline, a new round, a jump, a vote, a stalemate', () => {
  const base = { phase: 'draw', pile: ['D4-0'] };
  const moved = { turn: 9, cur: 'b2', phase: 'draw', draw: 39, pile: ['C3-0', 'D4-0'] };
  assert.deepEqual(diffOf(base, moved), ['draw:b1', 'discard:b1:C3-0']);
  assert.deepEqual(diffOf({ ...base, cur: 'p1' }, { ...moved, cur: 'b1' }), [], 'my own moves fly from my taps');
  assert.deepEqual(TM.diff(null, F(moved), 'p1'), [], 'the first state is a baseline');
  assert.deepEqual(diffOf(base, { ...moved, roundNumber: 3 }), [], 'a new deal');
  assert.deepEqual(diffOf(base, { ...moved, turn: 10 }), [], 'two turns in one step: unsure, so nothing');
  assert.deepEqual(diffOf(base, base), [], 'a state that moved nothing (a vote, an emote)');
  assert.deepEqual(diffOf({ ...base, draw: 0 }, { ...base, draw: 0, state: 'roundEnd' }), [], 'stalemate: the round ends without a move');
  assert.deepEqual(diffOf(base, { ...base, state: 'cutting' }), []);
});

test('unsure is silent: impossible combinations never fly', () => {
  const base = { phase: 'draw', pile: ['D4-0', 'C3-0'] };
  // Two draws in one turn, or a draw and a take together.
  assert.deepEqual(diffOf(base, { ...base, phase: 'meld', draw: 38 }), []);
  assert.deepEqual(diffOf(base, { phase: 'meld', draw: 39, pile: ['C3-0'], mustLay: 'D4-0' }), []);
  // A new card on someone else's table during b1's turn.
  assert.deepEqual(diffOf(base, { ...base, phase: 'meld', draw: 39, melds: [['b2', ['H7-0', 'D7-0', 'C7-0']]] }), []);
  // A card on the pile mid-turn that b1 did not just take.
  assert.deepEqual(diffOf({ ...base, phase: 'meld' }, { phase: 'meld', pile: ['H9-0', 'D4-0', 'C3-0'] }), []);
  // The turn passed without a discard.
  assert.deepEqual(diffOf({ ...base, phase: 'meld' }, { ...base, turn: 9, cur: 'b2', phase: 'draw' }), []);
  // A face-down card while the round goes on.
  assert.deepEqual(diffOf(base, { turn: 9, cur: 'b2', phase: 'draw', draw: 39, pile: ['X1-0', 'D4-0', 'C3-0'], faceDownTop: true }), []);
  // A pile card ends in my hand.
  const mine = st({ phase: 'meld', pile: ['C3-0'], mustLay: 'D4-0' });
  mine.players[0].hand.push(C('D4-0'));
  assert.deepEqual(said(TM.diff(F(base), TM.facts(mine, 'p1'), 'p1')), []);
  // A broken state never throws.
  assert.strictEqual(TM.facts({ phase: 'playing' }, 'p1'), null);
  assert.deepEqual(TM.diff(F(base), null, 'p1'), []);
});

test('changed: a vote or an emote moves nothing, every location change counts', () => {
  const a = F({ pile: ['D4-0'], melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] });
  assert.strictEqual(TM.changed(a, F({ pile: ['D4-0'], melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] })), false);
  assert.strictEqual(TM.changed(a, F({ pile: ['C3-0', 'D4-0'], melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] })), true);
  assert.strictEqual(TM.changed(a, F({ pile: ['D4-0'], melds: [['b1', ['H7-0', 'D7-0', 'C7-0', 'S7-0']]] })), true);
  assert.strictEqual(TM.changed(a, F({ pile: ['D4-0'], draw: 39, melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] })), true);
  assert.strictEqual(TM.changed(a, F({ pile: ['D4-0'], turn: 9, melds: [['b1', ['H7-0', 'D7-0', 'C7-0']]] })), true);
});

test('plan: turn order, overlapping, and never longer than the next bot move', () => {
  const draw = { kind: 'draw', who: 'b1' };
  const take = { kind: 'take', who: 'b1', cards: ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id })) };
  const meld = (n) => ({ kind: 'meld', who: 'b1', meld: 'm0', cards: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, slot: i })) });
  const discard = { kind: 'discard', who: 'b1', card: { id: 'X' } };
  for (const budget of [300, 600]) {
    for (const moves of [[draw], [discard], [draw, discard], [draw, meld(3), discard], [take, meld(13), meld(4), discard], [take, discard]]) {
      const { flights } = TM.plan(moves, { budget });
      const end = Math.max(...flights.map((f) => f.start + f.dur));
      assert.ok(end <= budget + 1e-9, `${budget} ms: ${moves.map((m) => m.kind)} ends at ${end}`);
      const first = (kind) => Math.min(...flights.filter((f) => f.move.kind === kind).map((f) => f.start));
      if (moves.includes(discard) && moves.length > 1) assert.ok(first('discard') > first(moves[0].kind), 'the discard comes last');
      assert.ok(flights.every((f) => f.dur >= budget * 0.2), 'every flight stays visible');
    }
  }
  assert.strictEqual(TM.plan([take]).flights.length, 1, 'a swallowed pile: only its top card flies');
  assert.strictEqual(TM.TAKE_SHOWN, 1);
  assert.ok(TM.plan([draw, meld(3), discard], { budget: 300 }).flights.every((f) => f.start + f.dur <= 300), '"Schnell": all within 300 ms');
  // The Zen discard joins its turn behind the melds, in what is left of the budget.
  const head = TM.plan([draw, meld(3)], { budget: 600 });
  const tail = TM.plan([discard], { budget: 600, from: head.cursor });
  assert.ok(tail.flights[0].start >= head.cursor && tail.flights[0].start + tail.flights[0].dur <= 600 + 1e-9);
});

test('clearFlight: a pile card in the air never covers a pile, on the way out or in', () => {
  const W = 48;
  const H = 66;
  const box = (x, y, w = W, h = H) => ({ left: x, top: y, right: x + w, bottom: y + h });
  // Landscape: chip, stock, discard pile in a row - every straight way to the pile crosses the stock.
  const stock = box(755, 65);
  const pile = box(816, 65);
  const chip = { x: 506, y: 86, s: 0.5, deg: -8 };
  const onPile = { x: 840, y: 98, s: 1, deg: 0 };
  const onStock = { x: 779, y: 98, s: 1, deg: 0 };
  const covers = (q) => [stock, pile].some((b) => q.x - (W * q.s) / 2 < b.right && b.left < q.x + (W * q.s) / 2 && q.y - (H * q.s) / 2 < b.bottom && b.top < q.y + (H * q.s) / 2);
  const along = (way) => Array.from({ length: 101 }, (_, i) => {
    const p = i / 100;
    const k = (a, b) => a + (b - a) * p;
    return { x: k(way.from.x, way.to.x), y: k(way.from.y, way.to.y), s: k(way.from.s, way.to.s) };
  });
  const thrown = TM.clearFlight(chip, onPile, W, H, [stock, pile], false);
  assert.deepEqual(thrown.from, chip, 'it leaves the chip as before');
  assert.ok(thrown.to.x + (W * thrown.to.s) / 2 < stock.left, 'and is gone before the stock');
  const taken = TM.clearFlight(onPile, { ...chip, deg: 8 }, W, H, [stock, pile], true);
  assert.ok(taken.from.x + (W * taken.from.s) / 2 < stock.left, 'it appears only past the stock');
  assert.deepEqual(taken.to, { ...chip, deg: 8 }, 'and still ends at the chip');
  const drawn = TM.clearFlight(onStock, { ...chip, deg: 8 }, W, H, [stock, pile], true);
  for (const way of [thrown, taken, drawn]) assert.ok(!along(way).some(covers), 'never over a pile');
  // Portrait: the piles far below the chip - the way is only cut where it meets them.
  const far = TM.clearFlight({ x: 36, y: 86, s: 0.5, deg: -8 }, { x: 220, y: 553, s: 1, deg: 0 }, W, H, [box(140, 512, 56, 74), box(190, 512, 62, 82)], false);
  assert.ok(far.to.y > 400 && far.to.y + (H * far.to.s) / 2 < 512, 'it comes close, never onto it');
  // Nothing in the way: the whole way; no room left: no flight at all.
  assert.deepEqual(TM.clearFlight(chip, onPile, W, H, [], false), { from: chip, to: onPile });
  assert.strictEqual(TM.clearFlight({ x: 700, y: 98, s: 0.5, deg: 0 }, onPile, W, H, [stock, pile], false), null);
});

// --- Engine fuzz: every state p1 receives against what the engine did since the last ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
test('fuzz: real games - every state names exactly the moves the engine made, never more', async (t) => {
  const realRandom = Math.random;
  Math.random = mulberry32(20261028);
  t.after(() => { Math.random = realRandom; });
  // The Zen path as in production: the net answers a tick later, so melds and discard are two states.
  const OnnxPolicy = require('../game/OnnxPolicy');
  const real = { draw: OnnxPolicy.chooseDrawSource, discard: OnnxPolicy.chooseDiscardCard };
  const later = () => new Promise((r) => setImmediate(() => r(null))); // null = the heuristic decides
  OnnxPolicy.chooseDrawSource = later;
  OnnxPolicy.chooseDiscardCard = later;
  t.after(() => { OnnxPolicy.chooseDrawSource = real.draw; OnnxPolicy.chooseDiscardCard = real.discard; });
  const rnd = mulberry32(9);
  const mismatches = [];
  const counts = {};
  let states = 0;
  for (const seed of [11, 23, 47, 58, 61, 77, 85, 93, 101, 113, 127, 131]) {
    const inbox = [];
    // The engine's moves since the last state p1 got. An entry is written BEFORE its
    // action (a human's state leaves inside it) and settled after: dead if refused.
    let truth = [];
    const g = new GameManager((pid, msg) => {
      // As on the wire: serialised right away (publicState shares the engine's live arrays).
      if (pid === 'p1' && msg.type === 'state') inbox.push({ state: JSON.parse(JSON.stringify(msg.state)), entries: truth.splice(0) });
    }, { deckSeed: seed });
    t.after(() => g.destroy());
    g.maybeRunBotTurn = () => {}; // the test plays every seat itself
    g.addOrReconnectPlayer('p1', 'Flo');
    g.addOrReconnectPlayer('p2', 'Oma Gerda'); // a remote human: one state per action, undos included
    g.syncLobbyBots();
    const levels = ['easy', 'hard', 'medium', 'zen'];
    g.players.filter((p) => p.isBot).forEach((p, i) => { p.botDifficulty = levels[(seed + i) % levels.length]; });
    const wrap = (name, predict, settle = () => {}) => {
      const orig = g[name].bind(g);
      g[name] = (...args) => {
        const entries = predict(args).map((text) => ({ text }));
        truth.push(...entries);
        const r = orig(...args);
        if (!r || !r.ok) for (const e of entries) e.dead = true;
        else settle(entries, args, r);
        return r;
      };
    };
    const top = () => (g.discardPile[0] && !g.discardPile[0].faceDown ? g.discardPile[0].id : null);
    wrap('drawFromPile', ([pid]) => [`draw:${pid}`], (es, a, r) => { if (r.roundEnded) es[0].dead = true; });
    wrap('drawFromDiscard', ([pid]) => [`take:${pid}:${top()}`]);
    wrap('discard', ([pid, id]) => [`discard:${pid}:${id}`], (es, [pid], r) => { if (r.roundEnded) es[0].text = `discard:${pid}:facedown`; });
    wrap('undoPileTake', ([pid]) => [`back:${pid}:${g.mustLayOffCardId}`]);
    const laid = { layoutMeld: (a) => a[1], layOffCards: (a) => a[2], layOffCard: (a) => [a[2]], swapJoker: (a) => [a[2]] };
    for (const [name, ids] of Object.entries(laid)) {
      wrap(name, (args) => ids(args).map((id) => `meld:${args[0]}:${id}`), (es) => {
        for (const e of es) {
          const id = e.text.split(':')[2];
          const m = g.tableMelds.find((x) => x.slots.some((s) => (s.real || s.joker || {}).id === id));
          if (m) e.text += `:${m.id}`;
          else e.dead = true;
        }
      });
    }
    const resolve = g.resolvePendingDiscardPickup.bind(g);
    g.resolvePendingDiscardPickup = (player) => {
      if (g.pendingDiscardRest) truth.push(...g.discardPile.map((cd) => ({ text: `take:${player.id}:${cd.id}` })));
      return resolve(player);
    };
    // A human sends one action per state: the engine broadcasts each of them right away.
    const stepwise = (fn) => {
      const coalesced = g.broadcastState;
      g.broadcastState = (opts = {}) => coalesced.call(g, { ...opts, immediate: true });
      try { return fn(); } finally { g.broadcastState = coalesced; }
    };
    let prev = null;
    // A meld card counts if it lies on the table in that state (a swapped-in joker leaves it again).
    const shown = (state, pid, id) => (state.tableMelds || []).some((m) => m.ownerId === pid && m.slots.some((s) => (s.real || s.joker || {}).id === id));
    const check = () => {
      for (const { state, entries } of inbox.splice(0)) {
        states += 1;
        const want = entries.filter((e) => !e.dead).map((e) => e.text).filter((s) => {
          const [kind, who, id] = s.split(':');
          return who !== 'p1' && (kind !== 'meld' || shown(state, who, id));
        });
        const now = TM.facts(state, 'p1');
        const got = said(TM.diff(prev, now, 'p1')).map((s) => {
          const [kind, who, a, b] = s.split(':');
          return kind === 'meld' ? `meld:${who}:${b}:${a}` : s; // the truth names card, then meld
        });
        prev = now;
        const w = want.slice().sort();
        const gs = got.slice().sort();
        const count = (k) => { counts[k] = (counts[k] || 0) + 1; };
        for (const m of w) count(m.endsWith(':facedown') ? 'facedown' : m.split(':')[0]);
        // A discard alone in its state, after the draw and melds of the same turn (Zen, or a human).
        if (w.length === 1 && w[0].startsWith('discard:')) count('split');
        if (JSON.stringify(gs) !== JSON.stringify(w)) {
          mismatches.push(`seed ${seed} R${state.roundNumber} T${state.turnIndexInRound} ${state.phase}: engine ${w.join(',') || '-'} / client ${gs.join(',') || '-'}`);
        }
      }
    };
    const tick = async (fn) => {
      await fn();
      await new Promise((r) => setImmediate(r)); // the server's one coalesced broadcast per tick
      await new Promise((r) => setImmediate(r));
      check();
    };
    const humanTurn = async (pid) => {
      if (rnd() < 0.15) return tick(() => g.runBotTurn(pid, { forced: true })); // a timed-out turn: one state
      if (rnd() < 0.45) {
        await tick(() => stepwise(() => g.drawFromDiscard(pid)));
        if (g.pendingDiscardRest && rnd() < 0.35) await tick(() => stepwise(() => g.undoPileTake(pid)));
      }
      if (g.phase === 'playing' && g.turnPhase === 'draw') await tick(() => stepwise(() => g.drawFromPile(pid)));
      if (g.phase !== 'playing' || g.currentPlayer().id !== pid) return;
      // Sometimes a meld taken back ("Rückgängig") before the rest of the turn.
      const me = g.currentPlayer();
      const first = !g.mustLayOffCardId && Bot.planBotMelds(me.hand, g.tableMelds.filter((m) => m.ownerId === pid)).newMelds[0];
      if (first && me.hand.length > first.length + 1 && rnd() < 0.4) {
        await tick(() => stepwise(() => g.layoutMeld(pid, first.map((cd) => cd.id), {}, { byOrder: false })));
        if (g._undoStack && g._undoStack.length) {
          await tick(() => stepwise(() => { if (g.undoMeldAction(pid).ok) counts.undoMeld = (counts.undoMeld || 0) + 1; }));
        }
      }
      // The rest of the turn as a human plays it: every meld, lay-off and the discard a state of its own.
      await tick(() => stepwise(() => g.runBotTurn(pid, { forced: true })));
    };
    await tick(() => g.startNewRound());
    for (let guard = 0; guard < 5000 && g.roundNumber <= 5 && g.phase !== 'gameOver'; guard++) {
      if (g.phase === 'roundEnd') { await tick(() => g.startNewRound()); continue; }
      if (g.phase !== 'playing') break;
      const cp = g.currentPlayer();
      if (!cp.isBot) await humanTurn(cp.id);
      else if (cp.botDifficulty === 'zen' && rnd() < 0.7) await tick(() => g._runBotTurnWithOnnx(cp.id));
      else await tick(() => g.runBotTurn(cp.id));
    }
  }
  assert.deepEqual(mismatches, [], `client and engine disagree:\n  ${mismatches.slice(0, 12).join('\n  ')}`);
  // Not vacuous: every kind of move came up, the human paths and the Zen split too.
  for (const kind of ['draw', 'take', 'meld', 'discard', 'facedown', 'back', 'split', 'undoMeld']) {
    assert.ok(counts[kind] > 0, `no ${kind} in the fuzz games: ${JSON.stringify(counts)}`);
  }
  assert.ok(states > 2000, `only ${states} states`);
});
