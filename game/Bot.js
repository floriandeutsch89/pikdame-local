// game/Bot.js
const { rankIndex, isPikDame, cardValue, RANKS, SUITS } = require('./Card');
const { validateMeld, tryLayOff, canFormMeldWithCard, enumerateMeldOptions } = require('./Rules');

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

  // 1) Sätze: gleiche Werte, jede Farbe darf bis zu 2x vorkommen (2 Decks!).
  // Frühere Version nahm nur eine Karte pro Farbe und übersah dadurch
  // gültige Sätze wie 2x Kreuz-Ass + 1x Herz-Ass.
  let byRank = groupByRank(pool);
  for (const rank of Object.keys(byRank)) {
    const sameRank = byRank[rank];
    const countBySuit = {};
    const usable = [];
    for (const c of sameRank) {
      countBySuit[c.suit] = (countBySuit[c.suit] || 0) + 1;
      if (countBySuit[c.suit] <= 2) usable.push(c);
    }
    if (usable.length >= 3) {
      const chosen = usable.slice(0, 8); // max. 8 Karten pro Satz (4 Farben x 2)
      const v = validateMeld(chosen);
      if (v.valid) {
        melds.push(chosen);
        removeFromPool(chosen);
      }
    }
  }

  // 2) Folgen: mind. 3 im Ring aufeinanderfolgende Werte derselben Farbe.
  // Der Werte-Ring (2..K,A,2..) macht auch K-A-2 gültig - dafür wird die
  // Kartenliste an der größten zyklischen Lücke rotiert und dann linear
  // mit modularer Nachbarschaft ((prev+1) % 13) nach Ketten gesucht.
  const RING = RANKS.length;
  let bySuit = groupBySuit(pool);
  for (const suit of Object.keys(bySuit)) {
    let cards = bySuit[suit].slice().sort((a, b) => rankIndex(a.rank) - rankIndex(b.rank));

    // Rotationspunkt: größte zyklische Lücke zwischen den distinkten Werten
    const distinctIdxs = [...new Set(cards.map((c) => rankIndex(c.rank)))].sort((a, b) => a - b);
    if (distinctIdxs.length >= 2 && distinctIdxs.length < RING) {
      let maxGap = -1;
      let rotateToIdx = distinctIdxs[0];
      for (let i = 0; i < distinctIdxs.length; i++) {
        const cur = distinctIdxs[i];
        const next = distinctIdxs[(i + 1) % distinctIdxs.length];
        const gap = i + 1 < distinctIdxs.length ? next - cur : next + RING - cur;
        if (gap > maxGap) {
          maxGap = gap;
          rotateToIdx = (cur + gap) % RING;
        }
      }
      const cut = cards.findIndex((c) => rankIndex(c.rank) === rotateToIdx);
      if (cut > 0) cards = [...cards.slice(cut), ...cards.slice(0, cut)];
    }

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
        if (curIdx === (prevIdx + 1) % RING) {
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
  // zu vervollständigen. Auch 2x dieselbe Farbe (2 Decks) + Joker ist gültig.
  if (jokers.length > 0) {
    byRank = groupByRank(pool);
    for (const rank of Object.keys(byRank)) {
      if (jokers.length === 0) break;
      const sameRank = byRank[rank];
      const countBySuit = {};
      const usable = [];
      for (const c of sameRank) {
        countBySuit[c.suit] = (countBySuit[c.suit] || 0) + 1;
        if (countBySuit[c.suit] <= 2) usable.push(c);
      }
      if (usable.length === 2) {
        const joker = jokers.find((j) => pool.some((p) => p.id === j.id));
        if (joker) {
          const chosen = [...usable, joker];
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

  // 4) Einzelne reale Karte + mehrere Joker (z. B. 1 Ass + 2 Joker -> Satz
  // ODER Folge). Die obigen Durchgänge erkennen das nicht (Durchgang 1
  // braucht 3+ echte Karten, Durchgang 3 nur exakt 2 echte + 1 Joker).
  // Nutzt enumerateMeldOptions(), das beide Meld-Typen samt aller
  // Joker-Fenster prüft.
  if (jokers.length >= 2) {
    for (const card of pool.filter((c) => !c.isJoker)) {
      const availableJokers = jokers.filter((j) => pool.some((p) => p.id === j.id));
      if (availableJokers.length < 2) continue;
      const candidate = [card, availableJokers[0], availableJokers[1]];
      const options = enumerateMeldOptions(candidate);
      if (options.length > 0) {
        melds.push(candidate);
        removeFromPool(candidate);
        jokers.splice(jokers.indexOf(availableJokers[0]), 1);
        jokers.splice(jokers.indexOf(availableJokers[1]), 1);
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

  // WICHTIG: Index 0 ist die oberste/zuletzt abgelegte Karte (siehe
  // GameManager.discardPile-Konvention). Bei mehr als einer Karte im Stapel
  // wäre das letzte Element die ÄLTESTE Karte, nicht die oberste!
  const topCard = discardPile[0];

  // REGEL: Aufnahme nur, wenn die oberste Karte mit den HANDKARTEN eine
  // neue Kombination bilden kann (Anlegbarkeit an Auslagen zählt nicht).
  if (canFormMeldWithCard(topCard, hand)) {
    return { source: 'discardPile', immediateUse: { type: 'newMeld' } };
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
 * Strategie (in dieser Reihenfolge):
 * 1. Pik Dame ab kleiner Hand (Rundenende naht) dringend loswerden.
 * 2. Joker werden NICHT abgeworfen (außer es gibt keine andere Karte):
 *    ein abgeworfener Joker ist ein doppeltes Geschenk an den nächsten
 *    Spieler - er darf den Stapel damit fast immer aufnehmen UND bekommt
 *    die flexibelste Karte des Spiels.
 * 3. Keine Karte abwerfen, die an eine bestehende Tisch-Auslage anlegbar
 *    ist - der nächste Spieler dürfte den Ablagestapel damit sofort
 *    aufnehmen (sofern es sichere Alternativen gibt).
 * 4. Unter den verbleibenden Kandidaten: isolierte Karten (kein Paar,
 *    kein Farb-Nachbar in der Hand) zuerst, davon die punkthöchste.
 */
/**
 * Wählt die Abwurfkarte des Bots.
 *
 * HARTE GARANTIE: Es wird NIEMALS ein Joker zurückgegeben. Besteht die Hand
 * ausschließlich aus Jokern, kommt null zurück - der Aufrufer (runBotTurn)
 * legt die Joker dann an eigene Auslagen an, statt sie abzuwerfen.
 *
 * opts.difficulty steuert die Spielstärke:
 * - 'easy':   wirft eine zufällige Nicht-Joker-Karte ab (auch mal die
 *             Pik Dame) - spielt wie ein unbekümmerter Anfänger.
 * - 'medium': bisheriges Verhalten (isolierte hohe Karten zuerst, Tisch-
 *             bewusstes Abwerfen, Pik Dame bei kleiner Hand loswerden).
 * - 'hard':   wie medium, aber die Pik Dame wird nie freiwillig abgeworfen,
 *             solange es Alternativen gibt (100 Punkte verschenkt man nicht).
 * - 'zen':    wie hard, plus Kartenzählung über opts.visibleCards: Karten,
 *             deren Kombinationspartner nachweislich nicht mehr im Umlauf
 *             sind ("tote Duos"), gelten als isoliert. Im Endspiel
 *             (opts.lowestOpponentHand <= 3) zählt nur noch Schadens-
 *             begrenzung: die höchsten Punktwerte fliegen zuerst,
 *             notfalls auch die Pik Dame.
 */
function chooseDiscard(hand, tableMelds = [], opts = {}) {
  if (hand.length === 0) return null;
  const difficulty = opts.difficulty || 'medium';

  // GARANTIE: nie einen Joker abwerfen. Nur-Joker-Hand -> null (Aufrufer
  // legt die Joker an, statt sie zu verschenken).
  const nonJokers = hand.filter((c) => !c.isJoker);
  if (nonJokers.length === 0) return null;

  if (difficulty === 'easy') {
    return nonJokers[Math.floor(Math.random() * nonJokers.length)];
  }

  // One turn earlier than before (<=4): measured in self-play, waiting for
  // <=3 often reacted only AFTER an opponent had already gone out.
  const endgame = difficulty === 'zen' && (opts.lowestOpponentHand || 99) <= 4;

  let candidates = nonJokers;
  if (difficulty !== 'easy') {
    // Die Pik Dame nie freiwillig hergeben, solange etwas anderes da ist -
    // ab MITTEL. Der alte "Notabwurf ab 8 Handkarten" fuer medium hat sie
    // regelrecht verschenkt (Spieler-Feedback mit Q♠ auf der Ablage als
    // Beweisfoto); nur EASY darf sie noch sorglos werfen.
    const withoutPd = candidates.filter((c) => !isPikDame(c));
    if (withoutPd.length > 0) candidates = withoutPd;
  }

  // Karten meiden, die der nächste Spieler direkt an eine Auslage anlegen
  // könnte (= Erlaubnis, den gesamten Ablagestapel aufzunehmen).
  const safeCandidates = candidates.filter(
    (card) => !tableMelds.some((meld) => tryLayOff(meld, card))
  );
  if (safeCandidates.length > 0) candidates = safeCandidates;

  // Never feed the queen hunters (medium and up - the easy branch returned
  // earlier): while a Queen of Spades can still show up (melded queens plus
  // own queens in hand < 2), a discarded queen of ANY suit may complete an
  // opponent's queen set - handing them the slot to meld their ♠Q for +100.
  // The same goes for ♠J and ♠K: they are the run neighbours the ♠Q embeds
  // into. Only holds while alternatives exist.
  const queensAccounted = (opts.queensMelded || 0) + hand.filter((c) => isPikDame(c)).length;
  if (queensAccounted < 2) {
    const isQueenBait = (card) =>
      !card.isJoker && (card.rank === 'Q' || (card.suit === 'S' && (card.rank === 'J' || card.rank === 'K')));
    const cautious = candidates.filter((card) => !isQueenBait(card));
    if (cautious.length > 0) candidates = cautious;
  }

  // Karten, die zu keiner potenziellen Gruppe (gleicher Rang oder
  // benachbarter Wert gleicher Farbe) gehören, sind "isoliert" -> bevorzugt abwerfen.
  const isIsolated = (card, others) => {
    const sameRank = others.some((c) => !c.isJoker && c.id !== card.id && c.rank === card.rank);
    const sameSuitNeighbor = others.some(
      (c) =>
        !c.isJoker &&
        c.id !== card.id &&
        c.suit === card.suit &&
        Math.abs(rankIndex(c.rank) - rankIndex(card.rank)) <= 2
    );
    return !sameRank && !sameSuitNeighbor;
  };

  const allReal = hand.filter((c) => !c.isJoker);
  let isolated = candidates.filter((c) => isIsolated(c, allReal));

  if (difficulty === 'zen' && Array.isArray(opts.visibleCards)) {
    // Kartenzählung: Wie viele Exemplare eines Rangs/einer Karte sind noch
    // "unsichtbar" (weder in Auslagen noch offen abgelegt noch in der
    // eigenen Hand)? Ein Duo, dessen fehlende Partner komplett verbraucht
    // sind, ist wertlos - die Karten gelten als isoliert.
    const seen = new Map(); // key -> Anzahl gesehen
    const keyOf = (card) => `${card.rank}|${card.suit}`;
    for (const v of opts.visibleCards) {
      if (v.isJoker) continue;
      seen.set(keyOf(v), (seen.get(keyOf(v)) || 0) + 1);
    }
    for (const h of hand) {
      if (h.isJoker) continue;
      seen.set(keyOf(h), (seen.get(keyOf(h)) || 0) + 1);
    }
    const unseen = (rank, suit) => Math.max(0, 2 - (seen.get(`${rank}|${suit}`) || 0)); // 2 Decks
    const SUITS_ALL = ['S', 'H', 'D', 'C'];
    const RANKS_ALL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const ri = (r) => RANKS_ALL.indexOf(r);

    const isDead = (card) => {
      // Satz-Potenzial: gibt es noch unsichtbare Karten gleichen Rangs?
      const setPartnersLeft = SUITS_ALL.reduce((sum, s) => sum + unseen(card.rank, s), 0);
      const handSetPartner = allReal.some((c) => c.id !== card.id && c.rank === card.rank);
      // Folgen-Potenzial: Nachbar-Ränge (+-1/+-2 im Ring) gleicher Farbe
      // in der Hand oder noch unsichtbar?
      const neighborRanks = [-2, -1, 1, 2].map((d) => RANKS_ALL[(ri(card.rank) + d + 13) % 13]);
      const handRunPartner = allReal.some(
        (c) => c.id !== card.id && c.suit === card.suit && neighborRanks.includes(c.rank)
      );
      const unseenRunPartner = neighborRanks.some((r) => unseen(r, card.suit) > 0);
      return !handSetPartner && !handRunPartner && setPartnersLeft === 0 && !unseenRunPartner;
    };
    const dead = candidates.filter((c) => !isolated.includes(c) && isDead(c));
    isolated = isolated.concat(dead);

    // Expose a potential score for the final ranking below: how many
    // unseen set partners + unseen run neighbours does this card still have?
    opts._zenPotential = (card) => {
      const setLeft = SUITS_ALL.reduce((sum, s) => sum + unseen(card.rank, s), 0);
      const neighborRanks = [-2, -1, 1, 2].map((d) => RANKS_ALL[(ri(card.rank) + d + 13) % 13]);
      const runLeft = neighborRanks.reduce((sum, r) => sum + unseen(r, card.suit), 0);
      return setLeft + runLeft;
    };
  }

  if (endgame) {
    // Ein Gegner steht kurz vor dem Ausmachen: Handpunkte minimieren -
    // aber KOMBINATIONEN NICHT ZERREISSEN (früher flog hier blind die
    // teuerste Karte, auch aus fast fertigen Sätzen). Höchster Wert aus
    // den ungeschützten Kandidaten zuerst, die Pik Dame ausnahmsweise
    // eingeschlossen (auf der Hand kostet sie sicher 100 Punkte).
    // isolated (keine Kombi-Partner) zuerst pluendern, sonst candidates
    const panicPool = (isolated.length > 0 ? isolated : candidates.length > 0 ? candidates : nonJokers).slice();
    const withPd = hand.find((cd) => isPikDame(cd));
    if (withPd && !panicPool.includes(withPd)) {
      // Queen discipline: the 100 points on hand hurt, but GIFTING her
      // hurts more - a discarded ♠Q makes the pile irresistible and can
      // hand an opponent an instant +100 lay-off. She only becomes
      // expendable as the VERY last resort: an opponent is one discard
      // from going out (<=2 cards) AND nobody could attach her to a meld
      // on the table (checked with the real rule simulation - open
      // information, no cheating).
      const opponentCanUseHer = tableMelds.some((meld) => tryLayOff(meld, withPd));
      const lastResort = (opts.lowestOpponentHand || 99) <= 2;
      if (lastResort && !opponentCanUseHer) panicPool.push(withPd);
    }
    const panicPotential =
      typeof opts._zenPotential === 'function' ? opts._zenPotential : () => 0;
    return panicPool.sort(
      (a, b) => cardValue(b) - cardValue(a) || panicPotential(a) - panicPotential(b)
    )[0];
  }

  const pool = isolated.length > 0 ? isolated : candidates;

  // höchster Punktwert zuerst abwerfen (reduziert Verlustrisiko am Rundenende)
  pool.sort((a, b) => cardValue(b) - cardValue(a));

  if (difficulty === 'zen') {
    // Card counting, part 2: among the top-value candidates (within 5
    // points of the best), prefer the SAFEST discard. Danger first: how
    // well does this card combine with cards an opponent is publicly
    // known to hold (watched pile pickups)? A ten is a bad discard when
    // someone visibly swallowed two tens with the pile. Tie-break: least
    // combination potential still unseen anywhere.
    const known = Array.isArray(opts.opponentKnownCards) ? opts.opponentKnownCards : [];
    const dangerOf = (card) =>
      known.filter(
        (k) =>
          !k.isJoker &&
          (k.rank === card.rank ||
            (k.suit === card.suit && Math.abs(rankIndex(k.rank) - rankIndex(card.rank)) <= 2))
      ).length;
    const potentialOf = typeof opts._zenPotential === 'function' ? opts._zenPotential : () => 0;
    const best = cardValue(pool[0]);
    const contenders = pool.filter((cd) => best - cardValue(cd) <= 5);
    // Weighted risk instead of strict lexicographic order: KNOWN opponent
    // cards (watched pickups) are hard evidence and weigh triple, but the
    // exhaustion count always contributes - a fourth nine is a safe throw
    // once the nine set lies on the table (only 4 of 8 copies remain in
    // circulation), even if it costs a couple more points than the king.
    const riskOf = (card) => dangerOf(card) * 3 + potentialOf(card);
    contenders.sort((a, b) => riskOf(a) - riskOf(b));
    return contenders[0] || pool[0] || hand.find((cd) => !isPikDame(cd) && !cd.isJoker) || hand[0];
  }
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
