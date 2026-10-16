// game/DailyPuzzle.js
// The daily puzzle: a seeded hand of cards, one question, and the REAL rules
// engine as the judge. Pure functions over the date, no I/O: the server keeps
// the attempts per player (PlayerStore), this module only builds and grades.
//
// Same trick as the daily challenge deck: seeded from the game date (GameDay), so
// everyone on the planet gets the identical hand and can talk about it.
// Jokers are left out on purpose - with them the best answer is ambiguous
// (a joker can stand for anything), and a puzzle needs one clear target.
//
// Three kinds rotate by weekday, easy on Monday, hard on Sunday:
//   meld - which cards form the most valuable single meld?
//   turn - lay out as many points as possible in one turn (several melds);
//          one card must stay in hand for the discard
//   out  - go out: lay out every card but one
// Days before ROTATION_START keep the single-meld puzzle they were served as,
// so the archive shows exactly the hand people played that day.

const { createDeck, shuffle, seededRandom } = require('./Deck');
const { validateMeld } = require('./Rules');
const { cardValue, makeStandardCard, SUITS, RANKS } = require('./Card');
const { weekdayIndex } = require('./GameDay');

const HAND_SIZE = 11; // the classic single-meld puzzle; 2^11 subsets - instant
const MIN_BEST_POINTS = 40; // below this the answer is too obvious
const MIN_VALID_MELDS = 4; // at least a few wrong-but-valid answers exist
const XP_FOR_SOLVED = 30;
const PUZZLE_EPOCH = '2026-09-26'; // first daily puzzle - the archive starts here
const ROTATION_START = '2026-10-19'; // a Monday; earlier days stay 'meld'
const KIND_BY_WEEKDAY = [ // Monday first
  { kind: 'meld', size: 11 },
  { kind: 'out', size: 9 },
  { kind: 'turn', size: 12 },
  { kind: 'meld', size: 13 },
  { kind: 'out', size: 11 },
  { kind: 'turn', size: 13 },
  { kind: 'out', size: 13 },
];
const MAX_ATTEMPTS = 300;

/** Stable seed from a string (djb2) - kept local so the puzzle cannot drift
 *  when the challenge store changes its own hashing. */
function seedFor(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

function meldPoints(cards) {
  return cards.reduce((sum, c) => sum + cardValue(c), 0);
}

function popcount(x) {
  let c = 0;
  while (x) { c += x & 1; x >>>= 1; }
  return c;
}

/** Every valid set or run among the hand's subsets, as bitmasks over the hand
 *  (ascending, like a plain subset loop). Without jokers a meld is one rank or
 *  one suit, so only subsets inside those groups go to the engine. */
function enumerateMelds(hand) {
  const groups = new Map();
  hand.forEach((c, i) => {
    for (const key of [`r${c.rank}`, `s${c.suit}`]) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
  });
  const seen = new Set();
  const melds = [];
  for (const idx of groups.values()) {
    if (idx.length < 3) continue;
    for (let sub = 1; sub < 1 << idx.length; sub++) {
      if (popcount(sub) < 3) continue;
      let mask = 0;
      idx.forEach((handIdx, j) => { if (sub & (1 << j)) mask |= 1 << handIdx; });
      if (seen.has(mask)) continue;
      seen.add(mask);
      const cards = hand.filter((_, i) => mask & (1 << i));
      const v = validateMeld(cards);
      if (v.valid) melds.push({ mask, points: meldPoints(cards), type: v.type });
    }
  }
  return melds.sort((a, b) => a.mask - b.mask);
}

/**
 * Exhaustive search over all subsets of the hand: every valid set or run,
 * ranked by points. @returns {{best:{cardIds:string[],points:number,type:string}|null, validCount:number}}
 */
function searchMelds(hand) {
  let best = null;
  const melds = enumerateMelds(hand);
  for (const m of melds) {
    // Ties: the first (smaller mask) wins - a 4-card answer that only equals
    // the 3-card optimum still counts as solved (points compare equal).
    if (!best || m.points > best.points) best = m;
  }
  return {
    best: best ? { cardIds: idsOf(hand, best.mask), points: best.points, type: best.type } : null,
    validCount: melds.length,
  };
}

function idsOf(hand, mask) {
  return hand.filter((_, i) => mask & (1 << i)).map((c) => c.id);
}

/** Most points from disjoint melds that leave at least one card for the discard. */
function bestPacking(melds, handSize) {
  const sorted = melds.slice().sort((a, b) => b.points - a.points);
  let best = { points: 0, masks: [] };
  const walk = (start, used, points, chosen) => {
    if (points > best.points) best = { points, masks: chosen.slice() };
    for (let i = start; i < sorted.length; i++) {
      const m = sorted[i];
      if (m.mask & used) continue;
      if (popcount(used | m.mask) > handSize - 1) continue;
      chosen.push(m.mask);
      walk(i + 1, used | m.mask, points + m.points, chosen);
      chosen.pop();
    }
  };
  walk(0, 0, 0, []);
  return best;
}

/** Points a greedy player gets: always the most valuable meld that still fits. */
function greedyPacking(melds, handSize) {
  let used = 0;
  let points = 0;
  for (const m of melds.slice().sort((a, b) => b.points - a.points)) {
    if (m.mask & used || popcount(used | m.mask) > handSize - 1) continue;
    used |= m.mask;
    points += m.points;
  }
  return points;
}

/**
 * Ways to go out: disjoint melds covering every card but exactly one.
 * Counts up to `cap` and remembers the first solution and every meld that
 * appears in any solution (the rest are decoys).
 */
function countCovers(melds, handSize, cap = 50) {
  const full = (1 << handSize) - 1;
  const byCard = Array.from({ length: handSize }, (_, i) => melds.filter((m) => m.mask & (1 << i)));
  const used = new Set();
  let count = 0;
  let first = null;
  const walk = (covered, leftOut, chosen) => {
    if (count >= cap) return;
    if (covered === full) {
      if (leftOut === -1) return; // all cards laid - no card left to discard
      count += 1;
      if (!first) first = chosen.slice();
      for (const m of chosen) used.add(m);
      return;
    }
    let i = 0;
    while (covered & (1 << i)) i++;
    if (leftOut === -1) walk(covered | (1 << i), i, chosen); // this card is the discard
    for (const m of byCard[i]) {
      if (m.mask & covered) continue;
      chosen.push(m);
      walk(covered | m.mask, leftOut, chosen);
      chosen.pop();
    }
  };
  walk(0, -1, []);
  return { count, first, used };
}

/** Which kind and hand size a date gets. */
function kindForDate(date) {
  if (String(date) < ROTATION_START) return { kind: 'meld', size: HAND_SIZE };
  return KIND_BY_WEEKDAY[weekdayIndex(date)];
}

// --- generators ------------------------------------------------------------

function meldPuzzle(date, size) {
  const base = createDeck().filter((c) => !c.isJoker);
  // The 11-card seeds are the original ones, so old days stay identical.
  const prefix = size === HAND_SIZE ? 'pikdame-puzzle' : `pikdame-puzzle-meld${size}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    const hand = shuffle(base, seedFor(`${prefix}-${date}-${attempt}`)).slice(0, size);
    const { best, validCount } = searchMelds(hand);
    if (!best || best.points < MIN_BEST_POINTS || validCount < MIN_VALID_MELDS) continue;
    return { date, kind: 'meld', hand, best: { ...best, melds: [best.cardIds] }, validCount, attempt };
  }
  // Practically unreachable (the first few attempts always qualify); a plain
  // hand with whatever optimum it has beats a missing puzzle.
  const hand = shuffle(base, seedFor(`${prefix}-${date}-fallback`)).slice(0, size);
  const { best, validCount } = searchMelds(hand);
  return { date, kind: 'meld', hand, best: best && { ...best, melds: [best.cardIds] }, validCount, attempt: -1 };
}

function turnPuzzle(date, size) {
  const base = createDeck().filter((c) => !c.isJoker);
  let fallback = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const hand = shuffle(base, seedFor(`pikdame-puzzle-turn-${date}-${attempt}`)).slice(0, size);
    const melds = enumerateMelds(hand);
    const packing = bestPacking(melds, size);
    if (packing.masks.length < 2 || packing.points < 50) continue;
    const puzzle = {
      date, kind: 'turn', hand, validCount: melds.length, attempt,
      best: { points: packing.points, melds: packing.masks.map((m) => idsOf(hand, m)), cardIds: packing.masks.flatMap((m) => idsOf(hand, m)) },
    };
    // The harder (13-card) day wants a hand where grabbing the biggest meld first fails.
    if (size < 13 || greedyPacking(melds, size) < packing.points) return puzzle;
    fallback = fallback || puzzle;
  }
  return fallback || meldPuzzle(date, size);
}

// Builds a hand that can go out by construction: planned melds around a
// central rank (so they compete for cards) plus one loose card.
function plannedOutHand(rnd, size) {
  const sizes = [];
  let sum = 0;
  while (sum < size - 1) {
    const k = [3, 3, 4, 4, 5][Math.floor(rnd() * 5)];
    if (sum + k > size - 1) {
      if (size - 1 - sum >= 3) { sizes.push(size - 1 - sum); sum = size - 1; break; }
      sizes.length = 0; sum = 0; continue; // overshoot: plan again
    }
    sizes.push(k);
    sum += k;
  }
  const taken = new Set();
  const center = Math.floor(rnd() * RANKS.length);
  const near = () => (center + Math.floor(rnd() * 5) - 2 + RANKS.length) % RANKS.length;
  const take = (suit, rankIdx) => {
    const rank = RANKS[(rankIdx + RANKS.length) % RANKS.length];
    for (const d of rnd() < 0.5 ? [0, 1] : [1, 0]) {
      const card = makeStandardCard(suit, rank, d);
      if (!taken.has(card.id)) { taken.add(card.id); return card; }
    }
    return null;
  };
  const hand = [];
  for (const k of sizes) {
    let meld = null;
    for (let tries = 0; tries < 20 && !meld; tries++) {
      const cards = [];
      if (k <= 4 && rnd() < 0.45) {
        // Set: k cards of one rank, every suit at most twice (two decks).
        const r = near();
        const suits = SUITS.flatMap((s) => [s, s]).sort(() => rnd() - 0.5).slice(0, k);
        for (const s of suits) cards.push(take(s, r));
      } else {
        const s = SUITS[Math.floor(rnd() * SUITS.length)];
        const start = near() - Math.floor(rnd() * k);
        for (let i = 0; i < k; i++) cards.push(take(s, start + i));
      }
      if (cards.every(Boolean) && validateMeld(cards).valid) meld = cards;
      else for (const c of cards) if (c) taken.delete(c.id);
    }
    if (!meld) return null;
    hand.push(...meld);
  }
  const loose = take(SUITS[Math.floor(rnd() * SUITS.length)], near());
  if (!loose) return null;
  hand.push(loose);
  // Deal order, not plan order: the melds must not sit side by side.
  return shuffle(hand, Math.floor(rnd() * 2 ** 31));
}

function outPuzzle(date, size) {
  let fallback = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rnd = seededRandom(seedFor(`pikdame-puzzle-out-${date}-${attempt}`));
    const hand = plannedOutHand(rnd, size);
    if (!hand) continue;
    const melds = enumerateMelds(hand);
    const covers = countCovers(melds, size);
    if (covers.count === 0) continue;
    const puzzle = {
      date, kind: 'out', hand, validCount: melds.length, attempt,
      best: {
        points: covers.first.reduce((n, m) => n + m.points, 0),
        melds: covers.first.map((m) => idsOf(hand, m.mask)),
        cardIds: covers.first.flatMap((m) => idsOf(hand, m.mask)),
      },
    };
    // Interesting = few ways out and valid melds that lead nowhere.
    const decoys = melds.filter((m) => !covers.used.has(m)).length;
    if (covers.count <= 4 && decoys >= Math.max(2, size - 9)) return puzzle;
    fallback = fallback || puzzle;
  }
  return fallback || meldPuzzle(date, size);
}

/**
 * The puzzle for a "YYYY-MM-DD" date. Deterministic: the same date always
 * yields the same hand and the same target.
 */
function puzzleForDate(date) {
  const { kind, size } = kindForDate(date);
  if (kind === 'turn') return turnPuzzle(date, size);
  if (kind === 'out') return outPuzzle(date, size);
  return meldPuzzle(date, size);
}

/** What the client may see before solving: the hand and the target. */
function publicPuzzle(puzzle) {
  return {
    date: puzzle.date,
    kind: puzzle.kind || 'meld',
    hand: puzzle.hand,
    targetPoints: puzzle.kind === 'out' ? 0 : puzzle.best ? puzzle.best.points : 0,
  };
}

/**
 * Grades an answer: a list of card ids (one meld) or a list of melds. Card ids
 * must come from the puzzle hand, every card in at most one meld.
 * @returns {{valid:boolean, reason?:string, badMeld?:number, points:number, targetPoints:number, solved:boolean, meldType?:string, left:number}}
 */
function checkAnswer(puzzle, answer) {
  const kind = puzzle.kind || 'meld';
  const target = kind === 'out' ? 0 : puzzle.best ? puzzle.best.points : 0;
  const groups = Array.isArray(answer) && Array.isArray(answer[0]) ? answer : [answer];
  const fail = (reason, extra = {}) => ({ valid: false, reason, points: 0, targetPoints: target, solved: false, left: puzzle.hand.length, ...extra });
  if (kind === 'meld' && groups.length !== 1) return fail('Hier ist genau eine Auslage gefragt.');
  // Client input: never more groups or ids than the hand has cards.
  if (groups.length > puzzle.hand.length || groups.some((g) => Array.isArray(g) && g.length > puzzle.hand.length)) {
    return fail('Karte(n) nicht in der Hand gefunden.');
  }
  const seen = new Set();
  let points = 0;
  let meldType;
  for (let g = 0; g < groups.length; g++) {
    const ids = Array.isArray(groups[g]) ? groups[g].map(String) : [];
    const unique = new Set(ids);
    const cards = [...unique].map((id) => puzzle.hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== unique.size || cards.length === 0) return fail('Karte(n) nicht in der Hand gefunden.');
    if (cards.some((c) => seen.has(c.id))) return fail('Jede Karte darf nur in einer Auslage liegen.');
    cards.forEach((c) => seen.add(c.id));
    const v = validateMeld(cards);
    if (!v.valid) return fail(v.reason, groups.length > 1 ? { badMeld: g + 1 } : {});
    points += meldPoints(cards);
    meldType = v.type;
  }
  const left = puzzle.hand.length - seen.size;
  if (kind !== 'meld' && left < 1) return fail('Eine Karte muss zum Abwerfen übrig bleiben.');
  const solved = kind === 'out' ? left === 1 : points >= target;
  // meldType, not `type`: the server spreads this object into a WebSocket
  // message whose own `type` field must survive.
  const result = { valid: true, points, targetPoints: target, solved, left };
  if (kind === 'meld') result.meldType = meldType;
  return result;
}

module.exports = {
  puzzleForDate, publicPuzzle, checkAnswer, searchMelds, kindForDate,
  enumerateMelds, bestPacking, countCovers,
  HAND_SIZE, XP_FOR_SOLVED, MIN_BEST_POINTS, PUZZLE_EPOCH, ROTATION_START,
};
