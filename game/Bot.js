// game/Bot.js
const { rankIndex, isPikDame, cardValue, RANKS, SUITS } = require('./Card');
const { validateMeld, tryLayOff } = require('./Rules');

/**
 * Die Bot-KI ist heuristisch (kein perfekter Solver), aber regelkonform und
 * verfolgt klar priorisierte Ziele:
 *   1. Niemals Pik-Dame oder Joker unnötig am Ende der Runde auf der Hand
 *      behalten (Prio 1 laut Vorgabe) -> werden bevorzugt ausgelegt/abgeworfen.
 *   2. Gültige Sätze/Folgen erkennen und auslegen.
 *   3. Karten an bestehende Auslagen anlegen, wenn möglich.
 *   4. Sinnvoll abwerfen (keine Karte abwerfen, die dem nächsten Spieler
 *      offensichtlich nutzt, sofern eine Alternative existiert).
 */

function groupByRank(cards) {
  const map = {};
  for (const c of cards) {
    if (c.isJoker) continue;
    map[c.rank] = map[c.rank] || [];
    map[c.rank].push(c);
  }
  return map;
}

function groupBySuit(cards) {
  const map = {};
  for (const c of cards) {
    if (c.isJoker) continue;
    map[c.suit] = map[c.suit] || [];
    map[c.suit].push(c);
  }
  return map;
}

/**
 * Findet greedy mögliche neue Auslagen (Sätze + Folgen) in der Hand.
 * Gibt eine Liste von Karten-Arrays zurück, jede Karte wird höchstens
 * einmal verwendet. Joker werden bevorzugt eingesetzt, um Pik-Dame los-
 * zuwerden, falls dadurch ein Satz/Folge entsteht (Prio 1).
 */
function findHandMelds(hand) {
  let pool = hand.slice();
  const jokers = pool.filter((c) => c.isJoker);
  const melds = [];

  const removeFromPool = (cards) => {
    for (const c of cards) {
      const idx = pool.findIndex((p) => p.id === c.id);
      if (idx !== -1) pool.splice(idx, 1);
    }
  };

  // 1) Sätze: gleiche Werte, verschiedene Farben (3-4 Karten)
  let byRank = groupByRank(pool);
  for (const rank of Object.keys(byRank)) {
    const sameRank = byRank[rank];
    const uniqueSuits = [];
    const seen = new Set();
    for (const c of sameRank) {
      if (!seen.has(c.suit)) {
        seen.add(c.suit);
        uniqueSuits.push(c);
      }
    }
    if (uniqueSuits.length >= 3) {
      const chosen = uniqueSuits.slice(0, 4);
      const v = validateMeld(chosen);
      if (v.valid) {
        melds.push(chosen);
        removeFromPool(chosen);
      }
    }
  }

  // 2) Folgen: mind. 3 aufeinanderfolgende Werte derselben Farbe
  let bySuit = groupBySuit(pool);
  for (const suit of Object.keys(bySuit)) {
    const cards = bySuit[suit].slice().sort((a, b) => rankIndex(a.rank) - rankIndex(b.rank));
    let run = [];
    const flushRun = () => {
      if (run.length >= 3) {
        const v = validateMeld(run);
        if (v.valid) {
          melds.push(run.slice());
          removeFromPool(run);
        }
      }
      run = [];
    };
    for (let i = 0; i < cards.length; i++) {
      if (run.length === 0) {
        run.push(cards[i]);
      } else {
        const prevIdx = rankIndex(run[run.length - 1].rank);
        const curIdx = rankIndex(cards[i].rank);
        if (curIdx === prevIdx + 1) {
          run.push(cards[i]);
        } else if (curIdx === prevIdx) {
          // Duplikat (zweites Deck) - überspringen für diese Folge
          continue;
        } else {
          flushRun();
          run.push(cards[i]);
        }
      }
    }
    flushRun();
  }

  // 3) Joker-Einsatz: versuche, mit verbliebenen Jokern (insbesondere wenn der
  // Bot eine Pik-Dame oder Joker loswerden will) "fast fertige" Zweiergruppen
  // zu vervollständigen.
  if (jokers.length > 0) {
    byRank = groupByRank(pool);
    for (const rank of Object.keys(byRank)) {
      if (jokers.length === 0) break;
      const sameRank = byRank[rank];
      const uniqueSuits = [];
      const seen = new Set();
      for (const c of sameRank) {
        if (!seen.has(c.suit)) {
          seen.add(c.suit);
          uniqueSuits.push(c);
        }
      }
      if (uniqueSuits.length === 2) {
        const joker = jokers.find((j) => pool.some((p) => p.id === j.id));
        if (joker) {
          const chosen = [...uniqueSuits, joker];
          const v = validateMeld(chosen);
          if (v.valid) {
            melds.push(chosen);
            removeFromPool(chosen);
            jokers.splice(jokers.indexOf(joker), 1);
          }
        }
      }
    }
  }

  return melds;
}

/**
 * Versucht, einzelne Handkarten an bestehende Tisch-Auslagen anzulegen.
 * tableMelds: Array von Meld-Objekten (siehe Rules.js)
 * Gibt { layOffs: [{meldId, card}], updatedHand } zurück.
 */
function findLayOffs(hand, tableMelds) {
  let pool = hand.slice();
  const layOffs = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const card of pool.slice()) {
      for (const meld of tableMelds) {
        const result = tryLayOff(meld, card);
        if (result) {
          layOffs.push({ meldId: meld.id, card });
          pool = pool.filter((c) => c.id !== card.id);
          // Tisch-Meld-Snapshot aktualisieren, damit Folgekarten korrekt geprüft werden
          meld.slots = result.slots;
          changed = true;
          break;
        }
      }
    }
  }

  return { layOffs, updatedHand: pool };
}

/**
 * Entscheidet, ob der Bot den Nachziehstapel zieht oder den gesamten
 * Ablagestapel aufnimmt. Der Ablagestapel wird nur genommen, wenn die
 * oberste Karte sofort sinnvoll ausgelegt/angelegt werden kann (Pflicht-
 * bedingung der Regel).
 */
function decideDraw(hand, discardPile, tableMelds) {
  if (discardPile.length === 0) return { source: 'drawPile' };

  const topCard = discardPile[discardPile.length - 1];

  // Kann die oberste Ablagekarte sofort angelegt werden?
  for (const meld of tableMelds) {
    if (tryLayOff(meld, topCard)) {
      return { source: 'discardPile', immediateUse: { type: 'layoff', meldId: meld.id } };
    }
  }

  // Kann die oberste Ablagekarte zusammen mit Handkarten einen neuen Satz/Folge bilden?
  const simulatedHand = [...hand, topCard];
  const melds = findHandMelds(simulatedHand);
  const usesTop = melds.find((m) => m.some((c) => c.id === topCard.id));
  if (usesTop) {
    return { source: 'discardPile', immediateUse: { type: 'newMeld', cards: usesTop } };
  }

  return { source: 'drawPile' };
}

// Ab dieser Handgröße wird die Pik Dame dringend losgeworden (Runde nähert
// sich dem Ende, Risiko der -100-Strafe steigt). Vorher verhält sie sich wie
// eine normale (sehr wertvolle) Karte und wird nicht bei jeder Gelegenheit
// sofort abgeworfen - ein Bot darf sie also auch mal kurz halten.
const URGENT_DISCARD_HAND_SIZE = 8;

/**
 * Wählt die Karte, die am Zugende abgeworfen wird.
 * Prio 1 (ab URGENT_DISCARD_HAND_SIZE): Pik-Dame loswerden, wenn sie nicht
 * ausgelegt werden konnte. Joker werden weiterhin grundsätzlich priorisiert.
 * Danach: höchstwertige "nutzlose" Karte (keine Teilfolge/-satz-Beziehung zu
 * anderen Handkarten), um das eigene Punkterisiko zu minimieren.
 */
function chooseDiscard(hand) {
  if (hand.length === 0) return null;

  const pikDame = hand.find((c) => isPikDame(c));
  if (pikDame && hand.length <= URGENT_DISCARD_HAND_SIZE) return pikDame;

  const joker = hand.find((c) => c.isJoker);
  if (joker) return joker;

  // Karten, die zu keiner potenziellen Gruppe (gleicher Rang oder
  // benachbarter Wert gleicher Farbe) gehören, sind "isoliert" -> bevorzugt abwerfen.
  const isIsolated = (card, others) => {
    const sameRank = others.some((c) => !c.isJoker && c.rank === card.rank);
    const sameSuitNeighbor = others.some(
      (c) =>
        !c.isJoker &&
        c.suit === card.suit &&
        Math.abs(rankIndex(c.rank) - rankIndex(card.rank)) <= 2
    );
    return !sameRank && !sameSuitNeighbor;
  };

  const candidates = hand.filter((c) => !c.isJoker);
  const isolated = candidates.filter((c) => isIsolated(c, candidates));
  const pool = isolated.length > 0 ? isolated : candidates;

  // höchster Punktwert zuerst abwerfen (reduziert Verlustrisiko am Rundenende)
  pool.sort((a, b) => cardValue(b) - cardValue(a));
  return pool[0] || hand[0];
}

/**
 * Führt einen kompletten Bot-Zug aus (reine Entscheidungslogik, keine
 * Zustandsmutation außerhalb der übergebenen Kopien). Der GameManager wendet
 * die zurückgegebenen Aktionen auf den echten State an.
 */
function planBotTurn({ hand, discardPile, tableMelds }) {
  const draw = decideDraw(hand, discardPile, tableMelds);

  let workingHand = hand.slice();
  if (draw.source === 'drawPile') {
    // Karte wird vom GameManager tatsächlich gezogen und workingHand ergänzt -
    // hier nur die Entscheidung zurückgeben.
  } else {
    workingHand = [...workingHand, ...discardPile]; // gesamten Stapel aufnehmen
  }

  return { draw }; // Der GameManager führt Draw aus, ruft danach planBotMelds() mit echter Hand auf
}

function planBotMelds(hand, tableMeldsSnapshot) {
  const newMelds = findHandMelds(hand);
  let remainingHand = hand.slice();
  for (const m of newMelds) {
    remainingHand = remainingHand.filter((c) => !m.some((mc) => mc.id === c.id));
  }

  const { layOffs, updatedHand } = findLayOffs(remainingHand, tableMeldsSnapshot);

  const discard = chooseDiscard(updatedHand);

  return { newMelds, layOffs, discard, finalHand: updatedHand };
}

module.exports = {
  findHandMelds,
  findLayOffs,
  decideDraw,
  chooseDiscard,
  planBotTurn,
  planBotMelds,
  URGENT_DISCARD_HAND_SIZE,
};
