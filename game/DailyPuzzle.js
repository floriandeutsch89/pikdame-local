// game/DailyPuzzle.js
// The daily puzzle: a seeded hand of cards, one question - "which combination
// of these cards is worth the most points?" - and the REAL rules engine as
// the judge. Pure functions over the date, no I/O: the server keeps the
// attempts per player (PlayerStore), this module only builds and grades.
//
// Same trick as the daily challenge deck: seeded from the UTC date, so
// everyone on the planet gets the identical hand and can talk about it.
// Jokers are left out on purpose - with them the best answer is ambiguous
// (a joker can stand for anything), and a puzzle needs one right answer.

const { createDeck, shuffle } = require('./Deck');
const { validateMeld } = require('./Rules');
const { cardValue } = require('./Card');

const HAND_SIZE = 11; // 2^11 subsets - the search is instant
const MIN_BEST_POINTS = 40; // below this the answer is too obvious
const MIN_VALID_MELDS = 4; // at least a few wrong-but-valid answers exist
const XP_FOR_SOLVED = 30;

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

/**
 * Exhaustive search over all subsets of the hand: every valid set or run,
 * ranked by points. @returns {{best:{cardIds:string[],points:number,type:string}|null, validCount:number}}
 */
function searchMelds(hand) {
  let best = null;
  let validCount = 0;
  const n = hand.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const size = popcount(mask);
    if (size < 3) continue;
    const cards = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) cards.push(hand[i]);
    const v = validateMeld(cards);
    if (!v.valid) continue;
    validCount += 1;
    const points = meldPoints(cards);
    // Ties: the SMALLER meld wins - then a 4-card answer that only equals the
    // 3-card optimum still counts as solved (points compare equal).
    if (!best || points > best.points) {
      best = { cardIds: cards.map((c) => c.id), points, type: v.type };
    }
  }
  return { best, validCount };
}

function popcount(x) {
  let c = 0;
  while (x) { c += x & 1; x >>= 1; }
  return c;
}

/**
 * The puzzle for a "YYYY-MM-DD" date. Draws seeded hands until one has a
 * meaningful optimum (a few valid answers, a best worth at least 40 points).
 * Deterministic: the same date always yields the same hand.
 */
function puzzleForDate(date) {
  const base = createDeck().filter((c) => !c.isJoker);
  for (let attempt = 0; attempt < 200; attempt++) {
    const deck = shuffle(base, seedFor(`pikdame-puzzle-${date}-${attempt}`));
    const hand = deck.slice(0, HAND_SIZE);
    const { best, validCount } = searchMelds(hand);
    if (!best || best.points < MIN_BEST_POINTS || validCount < MIN_VALID_MELDS) continue;
    return { date, hand, best, validCount, attempt };
  }
  // Practically unreachable (the first few attempts always qualify); a plain
  // hand with whatever optimum it has beats a missing puzzle.
  const hand = shuffle(base, seedFor(`pikdame-puzzle-${date}-fallback`)).slice(0, HAND_SIZE);
  return { date, hand, ...searchMelds(hand), attempt: -1 };
}

/** What the client may see before solving: the hand and the target points. */
function publicPuzzle(puzzle) {
  return { date: puzzle.date, hand: puzzle.hand, targetPoints: puzzle.best ? puzzle.best.points : 0 };
}

/**
 * Grades an answer. Card ids must come from the puzzle hand, no duplicates.
 * @returns {{valid:boolean, reason?:string, points:number, targetPoints:number, solved:boolean, meldType?:string}}
 */
function checkAnswer(puzzle, cardIds) {
  const target = puzzle.best ? puzzle.best.points : 0;
  const ids = Array.isArray(cardIds) ? cardIds.map(String) : [];
  const unique = new Set(ids);
  const cards = [...unique].map((id) => puzzle.hand.find((c) => c.id === id)).filter(Boolean);
  if (cards.length !== unique.size || cards.length === 0) {
    return { valid: false, reason: 'Karte(n) nicht in der Hand gefunden.', points: 0, targetPoints: target, solved: false };
  }
  const v = validateMeld(cards);
  if (!v.valid) return { valid: false, reason: v.reason, points: 0, targetPoints: target, solved: false };
  const points = meldPoints(cards);
  // meldType, not `type`: the server spreads this object into a WebSocket
  // message whose own `type` field must survive.
  return { valid: true, points, targetPoints: target, solved: points >= target, meldType: v.type };
}

module.exports = { puzzleForDate, publicPuzzle, checkAnswer, searchMelds, HAND_SIZE, XP_FOR_SOLVED, MIN_BEST_POINTS };
