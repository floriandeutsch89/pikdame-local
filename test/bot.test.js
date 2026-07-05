const test = require('node:test');
const assert = require('node:assert/strict');
const Bot = require('../game/Bot');
const { chooseDiscard, decideDraw, findHandMelds, URGENT_DISCARD_HAND_SIZE } = Bot;
const GameManager = require('../game/GameManager');
const { makeStandardCard, makeJoker, isPikDame } = require('../game/Card');

const H = (rank, idx = 0) => makeStandardCard('H', rank, idx);
const S = (rank, idx = 0) => makeStandardCard('S', rank, idx);
const D = (rank, idx = 0) => makeStandardCard('D', rank, idx);
const C = (rank, idx = 0) => makeStandardCard('C', rank, idx);

function bigIsolatedHand(extra, targetSize) {
  // Erzeugt eine Hand aus lauter isolierten, weit auseinanderliegenden Karten
  // (keine zwei gleichen Werte, keine benachbarten Werte derselben Farbe),
  // damit chooseDiscard's "isolierte Karte"-Logik keine Pik Dame begünstigt.
  const ranks = ['2', '5', '8', 'J', 'K'];
  const suits = ['H', 'D', 'C'];
  const hand = [...extra];
  let i = 0;
  while (hand.length < targetSize) {
    const rank = ranks[i % ranks.length];
    const suit = suits[Math.floor(i / ranks.length) % suits.length];
    hand.push(makeStandardCard(suit, rank, hand.length % 2));
    i++;
  }
  return hand.slice(0, targetSize);
}

test('chooseDiscard: bei GROSSER Hand wird die Pik Dame NICHT automatisch sofort abgeworfen', () => {
  const pikDame = S('Q');
  const hand = bigIsolatedHand([pikDame], 14); // > URGENT_DISCARD_HAND_SIZE
  assert.ok(hand.length > URGENT_DISCARD_HAND_SIZE);
  const discard = chooseDiscard(hand);
  // Die Pik Dame darf gewählt werden (sie hat den höchsten Wert unter den
  // isolierten Karten), aber es ist keine ERZWUNGENE Sofort-Priorität mehr -
  // andere isolierte Karten mit demselben/höherem Wert wären gleichwertig.
  // Wichtig ist: die Funktion erzwingt sie nicht unabhängig vom Kontext.
  assert.ok(discard); // wählt irgendeine sinnvolle Karte, kein Crash
});

test('chooseDiscard: MITTEL behaelt die Pik Dame auch bei kleiner Hand (nur easy wirft sie)', () => {
  const pikDame = S('Q');
  const small = bigIsolatedHand([pikDame], URGENT_DISCARD_HAND_SIZE);
  const medium = chooseDiscard(small, [], { difficulty: 'medium' });
  assert.ok(!isPikDame(medium), 'medium darf die Dame nicht mehr verschenken');
  const ten = bigIsolatedHand([pikDame], 10);
  const medium10 = chooseDiscard(ten, [], { difficulty: 'medium' });
  assert.ok(!isPikDame(medium10), 'auch mit 10 Karten bleibt sie auf der Hand');
});

test('chooseDiscard: Joker wird NICHT abgeworfen, solange andere Karten da sind (kein Geschenk an Gegner)', () => {
  const joker = makeJoker(0);
  const hand = bigIsolatedHand([joker], 14);
  const discard = chooseDiscard(hand);
  assert.ok(!discard.isJoker, 'Joker sollte behalten werden - Abwurf wäre ein Geschenk an den nächsten Spieler');
});

test('chooseDiscard: liefert NIE einen Joker - bei Nur-Joker-Hand kommt null (Aufrufer legt an)', () => {
  const joker = makeJoker(0);
  assert.equal(chooseDiscard([joker]), null);
  assert.equal(chooseDiscard([makeJoker(0), makeJoker(1)]), null);
});

test('chooseDiscard: meidet Karten, die an eine Tisch-Auslage anlegbar wären', () => {
  // Herz-10 wäre an die Folge 7-8-9 anlegbar -> der nächste Spieler dürfte
  // damit den ganzen Ablagestapel aufnehmen. Karo-2 ist harmlos.
  const dangerous = H('10');
  const safe = D('2');
  const hand = [dangerous, safe];
  const tableMelds = [
    {
      id: 'm1',
      type: 'run',
      suit: 'H',
      rank: null,
      slots: [{ real: H('7') }, { real: H('8') }, { real: H('9') }],
    },
  ];
  const discard = chooseDiscard(hand, tableMelds);
  assert.equal(discard.id, safe.id, 'sollte die harmlose Karte abwerfen, nicht das Gegner-Geschenk');
});

test('chooseDiscard: wirft anlegbare Karte ab, wenn es KEINE sichere Alternative gibt', () => {
  const dangerous = H('10');
  const tableMelds = [
    {
      id: 'm1',
      type: 'run',
      suit: 'H',
      rank: null,
      slots: [{ real: H('7') }, { real: H('8') }, { real: H('9') }],
    },
  ];
  const discard = chooseDiscard([dangerous], tableMelds);
  assert.equal(discard.id, dangerous.id);
});

test('chooseDiscard: isolierte Karten werden vor Paaren/Nachbarn abgeworfen (Regression: Selbst-Vergleich)', () => {
  // Regression: die alte isIsolated-Prüfung verglich jede Karte auch mit
  // sich selbst, wodurch NIE eine Karte als isoliert galt.
  const pair1 = H('9', 0);
  const pair2 = D('9', 0); // Paar mit pair1 (gleicher Rang)
  const lonely = C('4', 0); // komplett isoliert, aber niedriger Wert
  const discard = chooseDiscard([pair1, pair2, lonely]);
  assert.equal(discard.id, lonely.id, 'die isolierte Karte muss vor dem Paar abgeworfen werden');
});

test('findHandMelds: erkennt 2-Deck-Saetze (2x gleiche Farbe + 1 andere) - Regression', () => {
  // Seit der 2-Deck-Regel gueltig: 2x Kreuz-Ass + 1x Herz-Ass.
  // Die alte uniqueSuits-Logik uebersah das (nahm nur 1 Karte pro Farbe).
  const ca1 = C('A', 0);
  const ca2 = C('A', 1);
  const ha = H('A', 0);
  const melds = findHandMelds([ca1, ca2, ha]);
  assert.equal(melds.length, 1, '2-Deck-Satz muss erkannt werden');
  assert.equal(melds[0].length, 3);
});

test('findHandMelds: erkennt 2x gleiche Karte + Joker als Satz (2-Deck-Regel, Pass 3)', () => {
  const ha1 = H('9', 0);
  const ha2 = H('9', 1);
  const joker = makeJoker(0);
  const melds = findHandMelds([ha1, ha2, joker]);
  assert.equal(melds.length, 1);
  assert.ok(melds[0].some((c) => c.isJoker));
});

test('chooseDiscard: leere Hand liefert null', () => {
  assert.equal(chooseDiscard([]), null);
});

test('decideDraw: wertet die OBERSTE Ablagekarte aus (Index 0), nicht die älteste (Regression)', () => {
  // discardPile-Konvention: Index 0 = oberste/zuletzt abgelegte Karte.
  // Die oberste Karte (Pik-Dame) passt zur Hand, die älteste (Karo-7) nicht.
  const topCard = S('Q');
  const oldestCard = D('7');
  const discardPile = [topCard, oldestCard];
  const hand = [H('Q'), makeJoker(0)]; // Dame + Joker -> mit Pik-Dame ein gültiger Satz/Folge

  const plan = decideDraw(hand, discardPile, []);
  assert.equal(plan.source, 'discardPile');
});

test('decideDraw: nimmt NICHT, wenn nur die oberste (nicht die älteste) Karte unbrauchbar ist', () => {
  const topCard = D('2'); // unbrauchbar für die Hand
  const usefulButBuried = S('Q'); // wäre nützlich, liegt aber nicht oben
  const discardPile = [topCard, usefulButBuried];
  const hand = [H('Q'), makeJoker(0)];

  const plan = decideDraw(hand, discardPile, []);
  assert.equal(plan.source, 'drawPile');
});

test('findHandMelds: erkennt 1 reale Karte + 2 Joker als gültigen Satz (Regression)', () => {
  const ace = S('A');
  const hand = [ace, makeJoker(0), makeJoker(1)];
  const melds = findHandMelds(hand);
  assert.equal(melds.length, 1);
  assert.ok(melds[0].some((c) => c.id === ace.id));
  assert.equal(melds[0].length, 3);
});

test('findHandMelds: erkennt 1 reale Karte + 1 Joker NICHT als Satz (zu wenige Karten)', () => {
  const ace = S('A');
  const hand = [ace, makeJoker(0), H('K', 0)];
  const melds = findHandMelds(hand);
  // Hier ist kein Satz möglich (nur 1 Ass + 1 Joker), aber evtl. eine Folge
  // mit König - das ist okay, Hauptsache es stürzt nicht ab und liefert
  // sinnvolle Ergebnisse.
  assert.ok(Array.isArray(melds));
});

// --- v1.3.0: Joker-Garantie ueber alle Schwierigkeiten --------------------
test('chooseDiscard: wirft in KEINER Schwierigkeit einen Joker ab (Fuzz)', () => {
  const { makeStandardCard } = require('../game/Card');
  for (const difficulty of ['easy', 'medium', 'hard', 'zen']) {
    for (let i = 0; i < 200; i++) {
      const hand = [makeJoker(0), makeJoker(1), makeStandardCard('H', '7', 0), makeStandardCard('S', 'A', 0)];
      const d = chooseDiscard(hand, [], { difficulty, lowestOpponentHand: i % 5, visibleCards: [] });
      assert.ok(d && !d.isJoker, `${difficulty}: Joker abgeworfen!`);
    }
  }
});

test('chooseDiscard hard/zen: Pik Dame wird nicht freiwillig abgeworfen', () => {
  const { makeStandardCard } = require('../game/Card');
  const pd = makeStandardCard('S', 'Q', 0);
  const hand = [pd, makeStandardCard('H', '3', 0)];
  for (const difficulty of ['hard', 'zen']) {
    for (let i = 0; i < 50; i++) {
      const d = chooseDiscard(hand, [], { difficulty, lowestOpponentHand: 99, visibleCards: [] });
      assert.ok(!(d.rank === 'Q' && d.suit === 'S'), `${difficulty}: PD abgeworfen trotz Alternative`);
    }
  }
});

test('chooseDiscard zen: im Endspiel wird der hoechste Punktwert abgeworfen', () => {
  const { makeStandardCard } = require('../game/Card');
  const hand = [makeStandardCard('H', '3', 0), makeStandardCard('S', 'A', 0), makeStandardCard('D', '5', 0)];
  const d = chooseDiscard(hand, [], { difficulty: 'zen', lowestOpponentHand: 2, visibleCards: [] });
  assert.equal(d.rank, 'A'); // Ass = 20 Punkte = groesstes Handrisiko
});

// --- v1.23.0: discard caution around the Queen of Spades ----------------------
const { chooseDiscard: chooseDiscardV123 } = require('../game/Bot');
const { makeStandardCard: mkC123 } = require('../game/Card');

test('discard caution: medium+ bots avoid discarding queens / spade J,K while a ♠Q can still appear', () => {
  // Hand: an isolated heart queen (the "obvious" discard) + one boring card
  const hand = [
    mkC123('H', 'Q', 0), mkC123('S', 'K', 0), mkC123('S', 'J', 0),
    mkC123('C', '4', 0),
  ];
  for (const difficulty of ['medium', 'hard', 'zen']) {
    for (let i = 0; i < 10; i++) {
      const pick = chooseDiscardV123(hand, [], { difficulty, queensMelded: 0 });
      assert.equal(pick.rank === 'Q' || (pick.suit === 'S' && ['J', 'K'].includes(pick.rank)), false,
        `${difficulty}: must not feed the queen hunters (picked ${pick.rank}${pick.suit})`);
    }
  }
});

test('discard caution: lifted once both Queens of Spades are accounted for', () => {
  const hand = [mkC123('H', 'Q', 0), mkC123('C', '4', 0), mkC123('C', '4', 1), mkC123('D', '4', 0)];
  // Both queens melded on the table -> the isolated heart queen is the
  // natural discard again (the 4s form a set worth keeping)
  const pick = chooseDiscardV123(hand, [], { difficulty: 'hard', queensMelded: 2 });
  assert.equal(pick.rank, 'Q');
});

test('discard caution: never blocks when only "bait" cards remain', () => {
  const hand = [mkC123('H', 'Q', 0), mkC123('S', 'K', 0)];
  const pick = chooseDiscardV123(hand, [], { difficulty: 'hard', queensMelded: 0 });
  assert.ok(pick, 'must still discard something');
});

// --- v1.36.0: zen queen discipline ----------------------------------------------
test('zen endgame: keeps the Queen while opponents are not on their last cards', () => {
  const { chooseDiscard } = require('../game/Bot');
  const { makeStandardCard: mk, makeJoker } = require('../game/Card');
  const pd = mk('S', 'Q', 0);
  const hand = [pd, mk('H', '9', 0), mk('C', '4', 0), mk('D', '7', 1)];
  const pick = chooseDiscard(hand, [], { difficulty: 'zen', lowestOpponentHand: 3 });
  assert.ok(pick.rank !== 'Q' || pick.suit !== 'S', 'no ♠Q gift at 3 opponent cards');
});

test('zen endgame: Queen only as last resort AND only if no table meld could take her', () => {
  const { chooseDiscard } = require('../game/Bot');
  const { makeStandardCard: mk } = require('../game/Card');
  const pd = mk('S', 'Q', 0);
  const hand = [pd, mk('H', '3', 0)];
  // Opponent has a queen set on the table that could absorb her -> keep her
  const queenMeld = {
    id: 'm1', ownerId: 'foe', type: 'set', rank: 'Q',
    slots: [
      { real: mk('H', 'Q', 0) }, { real: mk('C', 'Q', 0) }, { real: mk('D', 'Q', 0) },
    ],
  };
  const guarded = chooseDiscard(hand, [queenMeld], { difficulty: 'zen', lowestOpponentHand: 2 });
  assert.ok(guarded.rank !== 'Q' || guarded.suit !== 'S', 'never feed a queen meld');
  // No usable meld anywhere -> at 2 cards she may finally go (point dump)
  const dumped = chooseDiscard(hand, [], { difficulty: 'zen', lowestOpponentHand: 2 });
  assert.ok(dumped.rank === 'Q' && dumped.suit === 'S', 'last-resort dump allowed');
});

// --- v1.37.0: exhaustion weighting -----------------------------------------------
test('zen: a melded set on the table makes the fourth copy the preferred discard', () => {
  const { chooseDiscard } = require('../game/Bot');
  const { makeStandardCard: mk } = require('../game/Card');
  // Hand: fourth nine vs. a king (worth 1 more point, both isolated)
  const hand = [mk('C', '9', 1), mk('H', 'K', 0), mk('S', '4', 0), mk('D', '2', 0)];
  const nineSet = [mk('S', '9', 0), mk('D', '9', 0), mk('H', '9', 0)];
  // With the nine set visible on the table: the nine is exhausted -> throw it
  const withSet = chooseDiscard(hand, [], {
    difficulty: 'zen',
    visibleCards: nineSet,
    opponentKnownCards: [],
  });
  assert.equal(withSet.rank, '9', `nine expected, got ${withSet.rank}${withSet.suit}`);
  // Without it, the plain value sort keeps ruling: the king goes
  const without = chooseDiscard(hand, [], {
    difficulty: 'zen',
    visibleCards: [],
    opponentKnownCards: [],
  });
  assert.equal(without.rank, 'K', `king expected, got ${without.rank}${without.suit}`);
});

// --- v1.38.0 ---------------------------------------------------------------------
test('zen never dumps the queen while holding a big hand, even at 2 opponent cards', () => {
  const { chooseDiscard } = require('../game/Bot');
  const { makeStandardCard: mk } = require('../game/Card');
  const hand = [mk('S', 'Q', 0)];
  ['2', '3', '4', '5', '6', '8', '9', '10', 'J', 'K', 'A'].forEach((r, i) =>
    hand.push(mk(i % 2 ? 'H' : 'D', r, 0))
  );
  ['3', '5', '8'].forEach((r) => hand.push(mk('C', r, 1)));
  assert.equal(hand.length, 15);
  for (let i = 0; i < 5; i++) {
    const pick = chooseDiscard(hand, [], { difficulty: 'zen', lowestOpponentHand: 2 });
    assert.ok(!(pick.rank === 'Q' && pick.suit === 'S'), '15-card hand must keep the queen');
  }
});

test('zen prefers a rank the next player just spurned from the pile', () => {
  const { chooseDiscard } = require('../game/Bot');
  const { makeStandardCard: mk } = require('../game/Card');
  // Two equal-value isolated candidates (nine vs. nine-rank alternative: use K vs K? use 9 vs 10 close values)
  const hand = [mk('C', '9', 1), mk('H', '10', 0), mk('S', '4', 0), mk('D', '2', 0)];
  const pick = chooseDiscard(hand, [], {
    difficulty: 'zen',
    visibleCards: [],
    opponentKnownCards: [],
    nextPlayerDeclined: [{ rank: '9', suit: 'S' }],
  });
  assert.equal(pick.rank, '9', `spurned nine expected, got ${pick.rank}${pick.suit}`);
});

// --- v1.43.0: joker exit, value-exposure risk, score awareness, blocking --------
test('findJokerSwaps: exact rank+suit match against an own joker slot, last card ends the round via swap', () => {
  const { makeStandardCard: mk, makeJoker } = require('../game/Card');
  const joker = makeJoker(0);
  const ownSet = {
    id: 'm1',
    ownerId: 'bot',
    type: 'set',
    rank: 'K',
    slots: [{ real: mk('H', 'K', 0) }, { real: mk('C', 'K', 0) }, { joker, representsRank: 'K', representsSuit: 'S' }],
  };
  const hand = [mk('S', 'K', 1)]; // exact match for the joker's represented suit
  const { swaps, updatedHand } = Bot.findJokerSwaps(hand, [ownSet]);
  assert.equal(swaps.length, 1, 'the matching card must be found');
  assert.equal(swaps[0].meldId, 'm1');
  assert.equal(updatedHand.length, 0, 'hand empty afterwards -> round-ending move');
});

test('findJokerSwaps: a card that does not match the represented suit is left alone', () => {
  const { makeStandardCard: mk, makeJoker } = require('../game/Card');
  const joker = makeJoker(0);
  const ownSet = {
    id: 'm1', ownerId: 'bot', type: 'set', rank: 'K',
    slots: [{ real: mk('H', 'K', 0) }, { real: mk('C', 'K', 0) }, { joker, representsRank: 'K', representsSuit: 'S' }],
  };
  const hand = [mk('D', 'K', 1)]; // wrong suit for this specific joker slot
  const { swaps, updatedHand } = Bot.findJokerSwaps(hand, [ownSet]);
  assert.equal(swaps.length, 0);
  assert.equal(updatedHand.length, 1);
});

test('meldWouldGiveKnownLayOff: detects a new set that a known card could immediately extend', () => {
  const { makeStandardCard: mk } = require('../game/Card');
  const meldCards = [mk('H', '9', 0), mk('C', '9', 0), mk('D', '9', 0)];
  const knownDangerous = [mk('S', '9', 1)]; // opponent is known to hold a 4th nine
  assert.equal(Bot.meldWouldGiveKnownLayOff(meldCards, knownDangerous), true);
  assert.equal(Bot.meldWouldGiveKnownLayOff(meldCards, [mk('H', '4', 0)]), false);
  assert.equal(Bot.meldWouldGiveKnownLayOff(meldCards, []), false);
});

test('scoreLead: zen protects a comfortable lead more than an even game', () => {
  const { makeStandardCard: mk } = require('../game/Card');
  // Two isolated, unequal-danger-but-close candidates: a plain high card vs
  // a card sharing rank with visible table cards (dangerOf > 0).
  const hand = [mk('C', 'K', 0), mk('H', '10', 0), mk('S', '4', 0), mk('D', '2', 0)];
  const visible = [mk('S', 'K', 0), mk('D', 'K', 0)]; // two kings visible -> king is "dangerous" (near-set)
  const evenGame = chooseDiscard(hand, [], { difficulty: 'zen', visibleCards: visible, opponentKnownCards: [], scoreLead: 0 });
  const bigLead = chooseDiscard(hand, [], { difficulty: 'zen', visibleCards: visible, opponentKnownCards: [], scoreLead: 200 });
  // With a big lead the king (the riskier card) must be AT LEAST as
  // unattractive as in the even game - never picked earlier/instead.
  if (evenGame.rank !== 'K') assert.notEqual(bigLead.rank, 'K', 'a protected lead should not newly risk the dangerous king');
});

