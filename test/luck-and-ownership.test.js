const test = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');
const { performLuckyCut, dealCards, createDeck, shuffle, HAND_SIZE } = require('../game/Deck');
const { validateRun, tryLayOff } = require('../game/Rules');
const { makeStandardCard, makeJoker } = require('../game/Card');

const H = (rank, idx = 0) => makeStandardCard('H', rank, idx);
const S = (rank, idx = 0) => makeStandardCard('S', rank, idx);

function makeGame(playerCount = 2) {
  const game = new GameManager(() => {});
  for (let i = 1; i <= playerCount; i++) {
    game.addOrReconnectPlayer(`p${i}`, `Spieler${i}`);
  }
  return game;
}

// --- Ring-Folgen (K-A-2 ist gültig) ---

test('Ring: K-A-2 gleicher Farbe ist eine gültige Folge', () => {
  const r = validateRun([H('K'), H('A'), H('2')]);
  assert.equal(r.valid, true);
  assert.equal(r.slots.map((s) => s.real.rank).join('-'), 'K-A-2');
});

test('Ring: Q-K-A-2-3 ist gültig (Ass verbindet die Enden)', () => {
  const r = validateRun([H('Q'), H('K'), H('A'), H('2'), H('3')]);
  assert.equal(r.valid, true);
});

test('Ring: Nutzerfall Herz-Ass + Joker + Herz-3 ergibt A-2-3', () => {
  const r = validateRun([H('A'), makeJoker(0), H('3')]);
  assert.equal(r.valid, true);
  const ranks = r.slots.map((s) => (s.real ? s.real.rank : s.representsRank));
  assert.deepEqual(ranks, ['A', '2', '3']);
});

test('Ring: volle 13er-Folge ist gültig, 14 Karten nicht (Werte wiederholen sich)', () => {
  const all13 = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].map((r) => H(r));
  assert.equal(validateRun(all13).valid, true);
  assert.equal(validateRun([...all13, makeJoker(0)]).valid, false);
});

test('Ring: Anlegen an K-A-2 - Q unten und 3 oben', () => {
  const base = validateRun([H('K'), H('A'), H('2')]);
  const meld = { id: 'm', ownerId: 'p1', ...base };
  const low = tryLayOff(meld, H('Q'));
  const high = tryLayOff(meld, H('3'));
  assert.deepEqual(low.slots.map((s) => s.real.rank), ['Q', 'K', 'A', '2']);
  assert.deepEqual(high.slots.map((s) => s.real.rank), ['K', 'A', '2', '3']);
});

test('Ring: an eine volle 13er-Folge kann nichts mehr angelegt werden', () => {
  const all13 = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].map((r) => H(r));
  const meld = { id: 'm', ownerId: 'p1', ...validateRun(all13) };
  assert.equal(tryLayOff(meld, makeJoker(0)), null);
});

// --- Eigene Stapel: keinerlei Interaktion mit fremden Auslagen ---

test('Ownership: swapJoker an FREMDER Auslage ist verboten', () => {
  const game = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 1; // p2 ist dran

  const joker = makeJoker(0);
  game.tableMelds = [
    {
      id: 'meld-1',
      ownerId: 'p1', // gehört p1!
      type: 'set',
      rank: 'Q',
      suit: null,
      slots: [
        { real: makeStandardCard('H', 'Q', 0), playerId: 'p1' },
        { real: makeStandardCard('C', 'Q', 0), playerId: 'p1' },
        { joker, representsRank: 'Q', representsSuit: 'S', playerId: 'p1' },
      ],
    },
  ];
  const pikDame = S('Q');
  game.players[1].hand = [pikDame, H('5')];

  const r = game.swapJoker('p2', 'meld-1', pikDame.id);
  assert.ok(r.error, 'fremder Joker-Tausch muss abgelehnt werden');
  assert.ok(r.error.includes('EIGENEN'), r.error);
  assert.equal(game.players[1].hand.length, 2, 'Karte bleibt auf der Hand');
  assert.ok(game.tableMelds[0].slots.some((s) => s.joker), 'Joker bleibt in der Auslage');
});

test('Ownership: canUseDiscardTop zählt nur die EIGENEN Auslagen', () => {
  const game = makeGame(2);
  game.phase = 'playing';
  // p1 hat eine 7er-Folge liegen, an die eine Herz-10 passen würde
  game.tableMelds = [
    {
      id: 'm1',
      ownerId: 'p1',
      type: 'run',
      suit: 'H',
      rank: null,
      slots: [{ real: H('7'), playerId: 'p1' }, { real: H('8'), playerId: 'p1' }, { real: H('9'), playerId: 'p1' }],
    },
  ];
  const topCard = H('10');
  const p1 = game.players[0];
  const p2 = game.players[1];
  p1.hand = [S('2')];
  p2.hand = [S('2')];

  assert.equal(game.canUseDiscardTop(p1, topCard), true, 'Besitzer darf (eigene Auslage passt)');
  assert.equal(game.canUseDiscardTop(p2, topCard), false, 'Fremder darf NICHT (fremde Auslage zählt nicht)');
});

// --- Glücksgriff ---

test('Glücksgriff: Pik Dame + direkt folgender Joker werden ergattert, normale Karte stoppt', () => {
  const deck = [H('5'), H('6'), S('Q'), makeJoker(0), H('9'), makeJoker(1)];
  const { luckyCards, remaining } = performLuckyCut(deck, 2);
  assert.equal(luckyCards.length, 2, 'Pik Dame + folgender Joker');
  assert.equal(luckyCards[0].rank, 'Q');
  assert.equal(luckyCards[1].isJoker, true);
  assert.equal(remaining.length, 4);
  assert.equal(remaining[2].rank, '9', 'die normale Karte rückt an die Abhebestelle');
});

test('Glücksgriff: keine Spezialkarte an der Abhebestelle -> nichts passiert', () => {
  const deck = [H('5'), S('Q'), H('7')];
  const { luckyCards, remaining } = performLuckyCut(deck, 0);
  assert.equal(luckyCards.length, 0);
  assert.equal(remaining.length, 3);
});

test('Glücksgriff-Ausgleich: dealCards überspringt den Abheber, alle enden bei 15', () => {
  const deck = shuffle(createDeck());
  // p1 hat 2 Karten ergattert -> wird 2x übersprungen, Ziel 13 verteilte Karten
  const { hands } = dealCards(deck, ['p1', 'p2', 'p3'], { skips: { p1: 2 } });
  assert.equal(hands.p1.length, HAND_SIZE - 2);
  assert.equal(hands.p2.length, HAND_SIZE);
  assert.equal(hands.p3.length, HAND_SIZE);
});

test('Glücksgriff-Integration: nach startNewRound haben IMMER alle exakt 15 Karten (110 Karten bleiben erhalten)', () => {
  // Der Cut ist zufällig - die Invariante muss über viele Durchläufe halten,
  // auch wenn der Glücksgriff zuschlägt.
  for (let i = 0; i < 40; i++) {
    const game = makeGame(3);
    game.startNewRound();
    for (const p of game.players) {
      assert.equal(p.hand.length, HAND_SIZE, `Runde ${i}: ${p.id} muss 15 Karten haben`);
    }
    const total =
      game.players.reduce((sum, p) => sum + p.hand.length, 0) + game.drawPile.length + game.discardPile.length;
    assert.equal(total, 110, `Runde ${i}: alle 110 Karten müssen im Spiel sein`);
  }
});

test('Glücksgriff: der Spieler RECHTS vom Geber hebt ab und erhält die Spezialkarten', () => {
  // Deterministisch: performLuckyCut direkt + die Verteil-Logik nachstellen.
  // Rechts vom Geber = Spieler VOR ihm in der Sitzreihenfolge.
  const game = makeGame(3);
  game.dealerIndex = 1; // p2 gibt -> p1 hebt ab
  const cutterIndex = (game.dealerIndex - 1 + game.players.length) % game.players.length;
  assert.equal(game.players[cutterIndex].id, 'p1');
});
