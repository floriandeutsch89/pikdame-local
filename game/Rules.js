// game/Rules.js
const { SUITS, rankIndex, RANKS } = require('./Card');

/**
 * Meld-Datenstruktur (so wird sie im GameManager / an Clients gehalten):
 * {
 *   id: string,
 *   type: 'set' | 'run',
 *   suit: string|null,        // bei 'run' fix, bei 'set' null (gemischte Farben)
 *   rank: string|null,        // bei 'set' fix, bei 'run' null (Folge von Rängen)
 *   slots: [
 *     { real: Card } |
 *     { joker: Card, representsSuit: string, representsRank: string }
 *   ]
 * }
 */

function isJokerCard(c) {
  return !!c.isJoker;
}

const MAX_PER_SUIT_IN_SET = 2; // 2 Decks im Spiel -> jede Farbe darf bis zu 2x vorkommen
const MAX_SET_SIZE = SUITS.length * MAX_PER_SUIT_IN_SET; // 4 Farben x 2 = 8

/**
 * Prüft, ob eine Menge von Karten (real, Joker erlaubt) einen gültigen SATZ
 * bildet: mindestens 3 Karten gleichen Wertes. Da mit 2 Decks gespielt wird,
 * darf jede Farbe bis zu 2x vorkommen (z. B. 2x Kreuz-Ass + 1x Herz-Ass ist
 * ein gültiger Satz) - es gibt KEINE "alle Farben unterschiedlich"-Pflicht
 * mehr, nur die physische Obergrenze von maximal 2 identischen Karten.
 * jokerAssignments: optionales Mapping jokerCardId -> gewünschte Farbe.
 */
function validateSet(cards, jokerAssignments = {}) {
  if (cards.length < 3 || cards.length > MAX_SET_SIZE) {
    return { valid: false, reason: `Ein Satz braucht 3 bis ${MAX_SET_SIZE} Karten.` };
  }
  const reals = cards.filter((c) => !isJokerCard(c));
  const jokers = cards.filter((c) => isJokerCard(c));

  if (reals.length === 0) {
    return { valid: false, reason: 'Ein Satz braucht mindestens eine echte Karte.' };
  }

  const rank = reals[0].rank;
  if (!reals.every((c) => c.rank === rank)) {
    return { valid: false, reason: 'Alle echten Karten im Satz müssen denselben Wert haben.' };
  }

  const countBySuit = {};
  for (const c of reals) {
    countBySuit[c.suit] = (countBySuit[c.suit] || 0) + 1;
    if (countBySuit[c.suit] > MAX_PER_SUIT_IN_SET) {
      return { valid: false, reason: 'Jede Farbe darf in einem Satz höchstens 2x vorkommen (2 Decks).' };
    }
  }

  // Verbleibende freie "Slots" für Joker: jede Farbe hat bis zu 2 Plätze,
  // abzüglich bereits verwendeter echter Karten dieser Farbe.
  const freeSlots = [];
  for (const suit of SUITS) {
    const remaining = MAX_PER_SUIT_IN_SET - (countBySuit[suit] || 0);
    for (let i = 0; i < remaining; i++) freeSlots.push(suit);
  }
  if (jokers.length > freeSlots.length) {
    return { valid: false, reason: 'Zu viele Joker für die verbleibenden Plätze in diesem Satz.' };
  }

  const slots = reals.map((c) => ({ real: c }));
  jokers.forEach((j, i) => {
    const assigned = jokerAssignments[j.id] || freeSlots[i];
    slots.push({ joker: j, representsRank: rank, representsSuit: assigned });
  });

  return { valid: true, type: 'set', rank, slots };
}

/**
 * Prüft, ob eine Menge von Karten eine gültige FOLGE bildet: mindestens 3
 * aufeinanderfolgende Werte derselben Farbe. Joker füllen Lücken/Enden.
 */
function validateRun(cards, jokerAssignments = {}) {
  if (cards.length < 3) {
    return { valid: false, reason: 'Eine Folge braucht mindestens 3 Karten.' };
  }
  const reals = cards.filter((c) => !isJokerCard(c));
  const jokers = cards.filter((c) => isJokerCard(c));

  if (reals.length === 0) {
    return { valid: false, reason: 'Eine Folge braucht mindestens eine echte Karte.' };
  }

  const suit = reals[0].suit;
  if (!reals.every((c) => c.suit === suit)) {
    return { valid: false, reason: 'Alle echten Karten in der Folge müssen dieselbe Farbe haben.' };
  }

  const indices = reals.map((c) => rankIndex(c.rank)).sort((a, b) => a - b);
  const uniqueIdx = new Set(indices);
  if (uniqueIdx.size !== indices.length) {
    return { valid: false, reason: 'Doppelte Werte in der Folge sind nicht erlaubt.' };
  }

  const minIdx = indices[0];
  const maxIdx = indices[indices.length - 1];
  const span = maxIdx - minIdx + 1;
  if (span > cards.length) {
    // Lücke ist größer als die Anzahl verfügbarer Joker kann schließen
    if (span - reals.length > jokers.length) {
      return { valid: false, reason: 'Lücke in der Folge kann nicht durch Joker geschlossen werden.' };
    }
  } else if (span < cards.length) {
    return { valid: false, reason: 'Zu viele Karten für die Spannweite der Folge.' };
  }

  // Baue komplette Slot-Liste von minIdx..maxIdx
  const slots = [];
  const realByIdx = {};
  reals.forEach((c) => (realByIdx[rankIndex(c.rank)] = c));
  const jokerQueue = jokers.slice();

  for (let idx = minIdx; idx <= maxIdx; idx++) {
    if (realByIdx[idx]) {
      slots.push({ real: realByIdx[idx] });
    } else {
      const j = jokerQueue.shift();
      if (!j) {
        return { valid: false, reason: 'Nicht genug Joker, um die Folge zu füllen.' };
      }
      slots.push({ joker: j, representsRank: RANKS[idx], representsSuit: suit });
    }
  }

  if (slots.length !== cards.length) {
    return { valid: false, reason: 'Ungültige Folge.' };
  }

  return { valid: true, type: 'run', suit, slots };
}

/**
 * Versucht, eine Kartenauswahl als Satz ODER Folge zu validieren.
 */
function validateMeld(cards, jokerAssignments = {}) {
  const asSet = validateSet(cards, jokerAssignments);
  if (asSet.valid) return asSet;
  const asRun = validateRun(cards, jokerAssignments);
  if (asRun.valid) return asRun;
  return { valid: false, reason: asRun.reason || asSet.reason || 'Ungültige Kombination.' };
}

/**
 * Prüft, ob eine einzelne Karte an eine bestehende Auslage angelegt werden kann,
 * und gibt das neue Meld-Objekt zurück (oder null wenn nicht möglich).
 */
function tryLayOff(meld, card, opts = {}) {
  if (meld.type === 'set') {
    const slotSuits = meld.slots.map((s) => (s.real ? s.real.suit : s.representsSuit));
    const countBySuit = {};
    for (const s of slotSuits) countBySuit[s] = (countBySuit[s] || 0) + 1;

    if (isJokerCard(card)) {
      // Joker kann nur angelegt werden, wenn noch ein freier Platz übrig ist
      // (jede Farbe darf insgesamt höchstens 2x vorkommen, 2 Decks im Spiel).
      if (meld.slots.length >= MAX_SET_SIZE) return null;
      const freeSuits = SUITS.filter((s) => (countBySuit[s] || 0) < MAX_PER_SUIT_IN_SET);
      if (freeSuits.length === 0) return null;
      const suit = opts.asSuit && freeSuits.includes(opts.asSuit) ? opts.asSuit : freeSuits[0];
      return {
        ...meld,
        slots: [...meld.slots, { joker: card, representsRank: meld.rank, representsSuit: suit }],
      };
    }
    if (card.rank !== meld.rank) return null;
    if (meld.slots.length >= MAX_SET_SIZE) return null;
    if ((countBySuit[card.suit] || 0) >= MAX_PER_SUIT_IN_SET) return null;
    return { ...meld, slots: [...meld.slots, { real: card }] };
  }

  if (meld.type === 'run') {
    const slotIdx = meld.slots.map((s) =>
      rankIndex(s.real ? s.real.rank : s.representsRank)
    );
    const minIdx = Math.min(...slotIdx);
    const maxIdx = Math.max(...slotIdx);

    const cardSuit = isJokerCard(card) ? meld.suit : card.suit;
    if (cardSuit !== meld.suit) return null;

    if (!isJokerCard(card)) {
      const cIdx = rankIndex(card.rank);
      if (cIdx === minIdx - 1) {
        return { ...meld, slots: [{ real: card }, ...meld.slots] };
      }
      if (cIdx === maxIdx + 1) {
        return { ...meld, slots: [...meld.slots, { real: card }] };
      }
      return null;
    } else {
      // Joker wird typischerweise an ein Ende angelegt (verlängert die Folge)
      if (maxIdx >= RANKS.length - 1) {
        // kann nicht weiter oben verlängert werden -> unten versuchen
        if (minIdx === 0) return null;
        return {
          ...meld,
          slots: [
            { joker: card, representsRank: RANKS[minIdx - 1], representsSuit: meld.suit },
            ...meld.slots,
          ],
        };
      }
      return {
        ...meld,
        slots: [
          ...meld.slots,
          { joker: card, representsRank: RANKS[maxIdx + 1], representsSuit: meld.suit },
        ],
      };
    }
  }

  return null;
}

/**
 * Prüft, ob eine Handkarte einen Joker in einer Auslage ersetzen kann, und
 * gibt ggf. das aktualisierte Meld + den freigewordenen Joker zurück.
 */
function tryJokerSwap(meld, handCard) {
  if (isJokerCard(handCard)) return null;
  const idx = meld.slots.findIndex(
    (s) => s.joker && s.representsRank === handCard.rank && s.representsSuit === handCard.suit
  );
  if (idx === -1) return null;
  const freedJoker = meld.slots[idx].joker;
  const newSlots = meld.slots.slice();
  newSlots[idx] = { real: handCard };
  return { meld: { ...meld, slots: newSlots }, freedJoker };
}

module.exports = {
  validateSet,
  validateRun,
  validateMeld,
  tryLayOff,
  tryJokerSwap,
  MAX_PER_SUIT_IN_SET,
  MAX_SET_SIZE,
};
