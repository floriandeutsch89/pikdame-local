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
  for (const j of jokers) {
    const requested = jokerAssignments[j.id];
    if (requested !== undefined && !SUITS.includes(requested)) {
      // Die Zuweisung ist erkennbar NICHT für einen Satz gedacht (z. B. ein
      // Rang-Code aus einer Folgen-Interpretation) - keine Karte stillschweigend
      // als Satz fehlinterpretieren.
      return { valid: false, reason: 'Joker-Zuweisung passt nicht zu einem Satz.' };
    }
  }
  jokers.forEach((j, i) => {
    const assigned = jokerAssignments[j.id] || freeSlots[i];
    slots.push({ joker: j, representsRank: rank, representsSuit: assigned });
  });

  return { valid: true, type: 'set', rank, slots };
}

/**
 * FOLGEN SIND ZIRKULÄR: Die Werte bilden einen Ring 2,3,...,K,A,2,3,...
 * Das Ass verbindet König und 2, d.h. Q-K-A, A-2-3 und auch K-A-2 sind
 * gültige Folgen. Eine Folge ist ein zusammenhängendes Fenster im Ring
 * (mindestens 3, höchstens 13 Karten - Werte dürfen sich nicht wiederholen).
 */
const RING = RANKS.length; // 13
const ringRank = (idx) => RANKS[((idx % RING) + RING) % RING];

/**
 * Bestimmt für eine Menge distinkter Ring-Indizes das (eindeutige) minimale
 * zusammenhängende Fenster, das alle enthält. Liefert { start, length } oder
 * { ambiguous: true }, wenn mehrere gleich große Fenster möglich sind.
 */
function ringHull(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { ambiguous: true };
  if (n === 1) return { start: sorted[0], length: 1 };
  if (n === RING) return { start: 0, length: RING }; // alle Werte belegt: kanonisch 2..A
  let maxGap = -1;
  let maxGapCount = 0;
  let startAfterGap = sorted[0];
  for (let i = 0; i < n; i++) {
    const cur = sorted[i];
    const next = sorted[(i + 1) % n];
    const gap = i + 1 < n ? next - cur : next + RING - cur;
    if (gap > maxGap) {
      maxGap = gap;
      maxGapCount = 1;
      startAfterGap = (cur + gap) % RING; // = next
    } else if (gap === maxGap) {
      maxGapCount += 1;
    }
  }
  if (maxGapCount > 1) return { ambiguous: true };
  return { start: startAfterGap, length: RING - maxGap + 1 };
}

/**
 * Prüft, ob eine Menge von Karten eine gültige FOLGE bildet: mindestens 3
 * im Ring aufeinanderfolgende Werte derselben Farbe (K-A-2 ist gültig!).
 * Joker füllen Lücken/Enden.
 *
 * Standardverhalten OHNE explizite jokerAssignments: Joker füllen nur
 * LÜCKEN INNERHALB des minimalen Fensters der echten Karten (kein
 * automatisches Erweitern nach außen, da das bei "freien" Jokern mehrdeutig
 * wäre - siehe enumerateMeldOptions() für die explizite Auflösung).
 *
 * Wird für JEDEN Joker eine Rang-Zuweisung übergeben (jokerAssignments:
 * jokerCardId -> Rang), bestimmt das exakt das gewünschte Fenster.
 */
function validateRun(cards, jokerAssignments = {}) {
  if (cards.length < 3) {
    return { valid: false, reason: 'Eine Folge braucht mindestens 3 Karten.' };
  }
  if (cards.length > RING) {
    return { valid: false, reason: 'Eine Folge kann höchstens 13 Karten umfassen (Werte dürfen sich nicht wiederholen).' };
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

  const realIdxs = reals.map((c) => rankIndex(c.rank));
  if (new Set(realIdxs).size !== realIdxs.length) {
    return { valid: false, reason: 'Doppelte Werte in der Folge sind nicht erlaubt.' };
  }

  const allJokersAssigned = jokers.length > 0 && jokers.every((j) => jokerAssignments[j.id]);

  if (jokers.some((j) => jokerAssignments[j.id] !== undefined && !RANKS.includes(jokerAssignments[j.id]))) {
    return { valid: false, reason: 'Joker-Zuweisung passt nicht zu einer Folge.' };
  }

  let start;

  if (allJokersAssigned) {
    const assignedIdxs = jokers.map((j) => rankIndex(jokerAssignments[j.id]));
    const allIdxs = [...realIdxs, ...assignedIdxs];
    if (new Set(allIdxs).size !== allIdxs.length) {
      return { valid: false, reason: 'Doppelte Werte in der Folge sind nicht erlaubt.' };
    }
    const hull = ringHull(allIdxs);
    if (hull.ambiguous || hull.length !== cards.length) {
      return { valid: false, reason: 'Die zugewiesenen Joker-Werte ergeben keine zusammenhängende Folge.' };
    }
    start = hull.start;
  } else {
    const hull = ringHull(realIdxs);
    if (hull.ambiguous || hull.length !== cards.length) {
      return {
        valid: false,
        reason:
          jokers.length > 0
            ? 'Mehrdeutige Joker-Platzierung - bitte eine Variante auswählen.'
            : 'Die Karten bilden keine zusammenhängende Folge.',
      };
    }
    start = hull.start;
  }

  // Slots in Ring-Reihenfolge ab start bauen
  const slots = [];
  const realByIdx = {};
  reals.forEach((c) => (realByIdx[rankIndex(c.rank)] = c));
  const jokerByIdx = {};
  if (allJokersAssigned) {
    jokers.forEach((j) => (jokerByIdx[rankIndex(jokerAssignments[j.id])] = j));
  }
  const jokerQueue = jokers.slice();

  for (let i = 0; i < cards.length; i++) {
    const idx = (start + i) % RING;
    if (realByIdx[idx]) {
      slots.push({ real: realByIdx[idx] });
    } else if (allJokersAssigned) {
      const j = jokerByIdx[idx];
      if (!j) return { valid: false, reason: 'Ungültige Folge.' };
      slots.push({ joker: j, representsRank: ringRank(idx), representsSuit: suit });
    } else {
      const j = jokerQueue.shift();
      if (!j) return { valid: false, reason: 'Nicht genug Joker, um die Folge zu füllen.' };
      slots.push({ joker: j, representsRank: ringRank(idx), representsSuit: suit });
    }
  }

  return { valid: true, type: 'run', suit, slots, startIdx: start };
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

const RANK_LABELS = { J: 'Bube', Q: 'Dame', K: 'König', A: 'Ass' };
function rankLabel(rank) {
  return RANK_LABELS[rank] || rank;
}
const SUIT_LABELS = { H: 'Herz', D: 'Karo', C: 'Kreuz', S: 'Pik' };

/**
 * Enumeriert ALLE gültigen Interpretationen einer Kartenauswahl (Satz und/
 * oder Folge, in allen möglichen Joker-Positionen). Wird benutzt, um bei
 * mehrdeutigen Joker-Kombinationen den Spieler explizit auswählen zu lassen,
 * statt eine Interpretation stillschweigend zu erraten.
 *
 * Beispiel: 1x Herz-Dame + 2 Joker kann sein:
 *   - Satz: 3x Dame (Joker = 2 andere Farben)
 *   - Folge: 10-J-Q, J-Q-K, ODER Q-K-A (je nachdem wo die "freien" Joker hin sollen)
 *
 * @returns {Array<{ id: string, type: 'set'|'run', label: string, jokerAssignments: Object }>}
 */
function enumerateMeldOptions(cards) {
  const options = [];
  const reals = cards.filter((c) => !isJokerCard(c));
  const jokers = cards.filter((c) => isJokerCard(c));

  if (reals.length === 0 || jokers.length === 0) {
    // Kein echter Joker im Spiel (oder gar keine reale Karte, ohnehin ungültig) ->
    // es gibt höchstens EINE Interpretation, keine Nachfrage nötig.
    const v = validateMeld(cards);
    if (v.valid) {
      options.push({
        id: 'only',
        type: v.type,
        label: v.type === 'set' ? `Satz: ${v.slots.length}x ${rankLabel(v.rank)}` : `Folge: ${v.slots.length} Karten (${SUIT_LABELS[v.suit] || v.suit})`,
        jokerAssignments: {},
      });
    }
    return options;
  }

  // --- Satz-Interpretation (höchstens eine sinnvolle: alle echten Karten
  // müssen denselben Wert haben; WELCHE freien Farben die Joker bekommen,
  // ist für die Gültigkeit irrelevant und wird automatisch kanonisch vergeben) ---
  if (reals.every((c) => c.rank === reals[0].rank)) {
    const rank = reals[0].rank;
    const countBySuit = {};
    let suitOverflow = false;
    for (const c of reals) {
      countBySuit[c.suit] = (countBySuit[c.suit] || 0) + 1;
      if (countBySuit[c.suit] > MAX_PER_SUIT_IN_SET) suitOverflow = true;
    }
    if (!suitOverflow) {
      const freeSlots = [];
      for (const suit of SUITS) {
        const remaining = MAX_PER_SUIT_IN_SET - (countBySuit[suit] || 0);
        for (let i = 0; i < remaining; i++) freeSlots.push(suit);
      }
      if (jokers.length <= freeSlots.length && cards.length >= 3 && cards.length <= MAX_SET_SIZE) {
        const assignment = {};
        jokers.forEach((j, i) => {
          assignment[j.id] = freeSlots[i];
        });
        const v = validateSet(cards, assignment);
        if (v.valid) {
          options.push({
            id: `set-${rank}`,
            type: 'set',
            label: `Satz: ${cards.length}x ${rankLabel(rank)}`,
            jokerAssignments: assignment,
          });
        }
      }
    }
  }

  // --- Folge-Interpretationen: alle Ring-Fenster durchprobieren ---
  // (Folgen sind zirkulär: K-A-2 ist gültig, daher alle 13 Startpositionen.)
  if (reals.every((c) => c.suit === reals[0].suit)) {
    const suit = reals[0].suit;
    const realIdxSet = new Set(reals.map((c) => rankIndex(c.rank)));
    if (realIdxSet.size === reals.length && cards.length <= RING) {
      const L = cards.length;
      for (let start = 0; start < RING; start++) {
        const windowIdxs = [];
        for (let i = 0; i < L; i++) windowIdxs.push((start + i) % RING);
        const windowSet = new Set(windowIdxs);
        // Alle echten Karten müssen im Fenster liegen
        if (![...realIdxSet].every((idx) => windowSet.has(idx))) continue;

        const assignment = {};
        const jokerQueue = jokers.slice();
        let ok = true;
        for (const idx of windowIdxs) {
          if (!realIdxSet.has(idx)) {
            const j = jokerQueue.shift();
            if (!j) { ok = false; break; }
            assignment[j.id] = ringRank(idx);
          }
        }
        if (!ok || jokerQueue.length > 0) continue;

        const v = validateRun(cards, assignment);
        if (v.valid) {
          const endIdx = (start + L - 1) % RING;
          const label = `Folge: ${rankLabel(ringRank(start))}-${rankLabel(ringRank(endIdx))} (${SUIT_LABELS[suit] || suit})`;
          if (!options.some((o) => o.label === label)) {
            options.push({ id: `run-${start}-${L}`, type: 'run', label, jokerAssignments: assignment });
          }
        }
      }
    }
  }

  return options;
}

/**
 * Enumeriert alle gültigen Möglichkeiten, eine einzelne (Joker-)Karte an
 * eine BESTEHENDE Auslage anzulegen, falls mehr als eine sinnvoll ist
 * (z. B. ein Joker könnte bei einem Satz mehrere freie Farben annehmen,
 * oder bei einer Folge an beiden Enden angelegt werden).
 * Bei echten (Nicht-Joker-)Karten oder eindeutigen Fällen liefert die
 * Funktion ein Array mit höchstens einem Eintrag.
 */
function enumerateLayOffOptions(meld, card) {
  if (!isJokerCard(card)) {
    const result = tryLayOff(meld, card);
    return result ? [{ id: 'only', label: 'Anlegen', asSuit: undefined, meld: result }] : [];
  }

  const options = [];
  if (meld.type === 'set') {
    const slotSuits = meld.slots.map((s) => (s.real ? s.real.suit : s.representsSuit));
    const countBySuit = {};
    for (const s of slotSuits) countBySuit[s] = (countBySuit[s] || 0) + 1;
    if (meld.slots.length < MAX_SET_SIZE) {
      // REGEL-VEREINFACHUNG: Bei einem SATZ ist es egal, welche Farbe der
      // Joker vertritt - es wird KANONISCH die erste freie Farbe vergeben
      // (gleiche Logik wie beim Auslegen eines Satzes mit Joker), statt den
      // Spieler mit einer irrelevanten Farb-Rückfrage zu nerven. Genau EINE
      // Option -> das Nachfrage-Overlay erscheint nicht mehr.
      const freeSuits = SUITS.filter((s) => (countBySuit[s] || 0) < MAX_PER_SUIT_IN_SET);
      for (const suit of freeSuits) {
        const result = tryLayOff(meld, card, { asSuit: suit });
        if (result) {
          options.push({ id: `suit-${suit}`, label: `als ${SUIT_LABELS[suit] || suit}-${rankLabel(meld.rank)}`, asSuit: suit, meld: result });
          break; // erste funktionierende Farbe = Default, fertig
        }
      }
    }
  } else if (meld.type === 'run') {
    // Ring: solange die Folge kürzer als 13 ist, sind beide Enden offen.
    // Bei Länge 12 wäre unten und oben derselbe (letzte fehlende) Wert -
    // dann gibt es nur EINE sinnvolle Option.
    const len = meld.slots.length;
    if (len < RING) {
      const firstRank = meld.slots[0].real ? meld.slots[0].real.rank : meld.slots[0].representsRank;
      const start = rankIndex(firstRank);
      const lowRank = ringRank(start - 1);
      const highRank = ringRank(start + len);
      const high = tryLayOff(meld, card, { side: 'high' });
      if (high) options.push({ id: 'extend-high', label: `oben anlegen als ${rankLabel(highRank)}`, side: 'high', meld: high });
      if (lowRank !== highRank) {
        const low = tryLayOff(meld, card, { side: 'low' });
        if (low) options.push({ id: 'extend-low', label: `unten anlegen als ${rankLabel(lowRank)}`, side: 'low', meld: low });
      }
    }
  }
  return options;
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
    // Ring-Arithmetik: Start-Index aus dem ersten Slot ableiten (slots sind
    // in Folgen-Reihenfolge geordnet), alles Weitere ergibt sich modulo 13.
    // K-A-2 ist eine gültige Folge; Anlegen ist möglich, solange die Folge
    // kürzer als 13 Karten ist (danach würden sich Werte wiederholen).
    const len = meld.slots.length;
    if (len >= RING) return null;
    const firstRank = meld.slots[0].real ? meld.slots[0].real.rank : meld.slots[0].representsRank;
    const start = rankIndex(firstRank);
    const lowRank = ringRank(start - 1); // Wert, der unten anschließen würde
    const highRank = ringRank(start + len); // Wert, der oben anschließen würde

    const cardSuit = isJokerCard(card) ? meld.suit : card.suit;
    if (cardSuit !== meld.suit) return null;

    if (!isJokerCard(card)) {
      // Bei len === 12 sind lowRank und highRank derselbe (letzte fehlende)
      // Wert - dann oben anlegen (Position ist spielerisch gleichwertig).
      if (card.rank === highRank) {
        return { ...meld, slots: [...meld.slots, { real: card }] };
      }
      if (card.rank === lowRank) {
        return { ...meld, slots: [{ real: card }, ...meld.slots] };
      }
      return null;
    } else {
      // Joker verlängert die Folge an einem Ende. Bei mehrdeutigen Fällen
      // (beide Enden frei) wählt opts.side; sonst bevorzugt oben.
      const useHigh = opts.side === 'low' ? false : true;
      if (useHigh) {
        return {
          ...meld,
          slots: [...meld.slots, { joker: card, representsRank: highRank, representsSuit: meld.suit }],
        };
      }
      return {
        ...meld,
        slots: [{ joker: card, representsRank: lowRank, representsSuit: meld.suit }, ...meld.slots],
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

/**
 * Prüft (ohne eine exakte Kombination festzulegen), ob `card` zusammen mit
 * Karten aus `hand` IRGENDEINEN gültigen neuen Satz oder eine neue Folge
 * bilden könnte. Wird genutzt, um zu entscheiden, ob der Ablagestapel
 * überhaupt aufgenommen werden darf bzw. ob ein Bot ihn aufnehmen sollte.
 *
 * Bewusst KEINE Brute-Force-Suche über alle Teilmengen der Hand (das wäre
 * bei 15+ Handkarten kombinatorisch explosiv, 2^15 = 32768 Teilmengen).
 * Stattdessen wird die Suche anhand der Spielregeln eingegrenzt: Sätze
 * brauchen nur Karten DESSELBEN Rangs, Folgen nur Karten DERSELBEN Farbe.
 * Das reduziert den Kandidatenraum auf wenige relevante Karten (meist <5)
 * und macht die Prüfung sehr günstig (höchstens ein paar hundert einfache
 * Vergleiche, unabhängig von der Handgröße).
 */
function canFormMeldWithCard(card, hand) {
  if (isJokerCard(card)) {
    return canFormSetAsJoker(hand) || canFormRunAsJoker(hand);
  }
  return canFormSetWithRealCard(card, hand) || canFormRunWithRealCard(card, hand);
}

function canFormSetWithRealCard(card, hand) {
  const sameRank = hand.filter((c) => !isJokerCard(c) && c.rank === card.rank);
  const jokers = hand.filter((c) => isJokerCard(c));
  const countBySuit = { [card.suit]: 1 };
  let usable = 1; // card selbst zählt schon
  for (const c of sameRank) {
    countBySuit[c.suit] = (countBySuit[c.suit] || 0) + 1;
    if (countBySuit[c.suit] <= MAX_PER_SUIT_IN_SET) usable++;
  }
  return usable + jokers.length >= 3;
}

function canFormRunWithRealCard(card, hand) {
  const sameSuitIdx = hand.filter((c) => !isJokerCard(c) && c.suit === card.suit).map((c) => rankIndex(c.rank));
  const jokerCount = hand.filter((c) => isJokerCard(c)).length;
  const cardIdx = rankIndex(card.rank);
  const allIdx = new Set([cardIdx, ...sameSuitIdx]);

  // Ring-Fenster: alle Startpositionen und Längen durchprobieren; das
  // Fenster muss die Karte enthalten, Lücken füllen Joker.
  const maxSpan = Math.min(RING, allIdx.size + jokerCount);
  for (let span = 3; span <= maxSpan; span++) {
    for (let start = 0; start < RING; start++) {
      let containsCard = false;
      let covered = 0;
      for (let i = 0; i < span; i++) {
        const idx = (start + i) % RING;
        if (idx === cardIdx) containsCard = true;
        if (allIdx.has(idx)) covered++;
      }
      if (!containsCard) continue;
      if (span - covered <= jokerCount) return true;
    }
  }
  return false;
}

function canFormSetAsJoker(hand) {
  const byRank = {};
  for (const c of hand) {
    if (!isJokerCard(c)) byRank[c.rank] = (byRank[c.rank] || 0) + 1;
  }
  const otherJokers = hand.filter((c) => isJokerCard(c)).length;
  for (const rank of Object.keys(byRank)) {
    if (byRank[rank] + otherJokers + 1 >= 3) return true; // dieser Joker + Hand-Karten/-Joker
  }
  return false;
}

function canFormRunAsJoker(hand) {
  const bySuit = {};
  for (const c of hand) {
    if (!isJokerCard(c)) {
      bySuit[c.suit] = bySuit[c.suit] || new Set();
      bySuit[c.suit].add(rankIndex(c.rank));
    }
  }
  const otherJokers = hand.filter((c) => isJokerCard(c)).length;
  for (const suit of Object.keys(bySuit)) {
    const idxs = bySuit[suit];
    const maxSpan = Math.min(RING, idxs.size + 1 + otherJokers);
    for (let span = 3; span <= maxSpan; span++) {
      for (let start = 0; start < RING; start++) {
        let covered = 0;
        for (let i = 0; i < span; i++) {
          if (idxs.has((start + i) % RING)) covered++;
        }
        if (covered === 0) continue; // mind. 1 echte Karte dieser Farbe im Fenster nötig
        const gaps = span - covered - 1; // -1 für diesen Joker selbst
        if (gaps >= 0 && gaps <= otherJokers) return true;
      }
    }
  }
  return false;
}

module.exports = {
  validateSet,
  validateRun,
  validateMeld,
  tryLayOff,
  tryJokerSwap,
  enumerateMeldOptions,
  enumerateLayOffOptions,
  canFormMeldWithCard,
  MAX_PER_SUIT_IN_SET,
  MAX_SET_SIZE,
};
