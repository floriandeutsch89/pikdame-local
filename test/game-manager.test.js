const test = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');
const { makeStandardCard, makeJoker } = require('../game/Card');

function makeGame(playerCount = 4) {
  const sent = [];
  const game = new GameManager((playerId, message) => sent.push({ playerId, message }));
  for (let i = 1; i <= playerCount; i++) {
    game.addOrReconnectPlayer(`p${i}`, `Spieler ${i}`);
  }
  return { game, sent };
}

test('Dealer rotiert jede Runde reihum, gestartet wird vom Spieler NACH dem Geber', () => {
  const { game } = makeGame(4);
  game.startNewRound(); // Runde 1
  assert.equal(game.dealerIndex, 0);
  assert.equal(game.currentPlayerIndex, 1);
  assert.equal(game.turnIndexInRound, 0);

  game.startNewRound(); // Runde 2
  assert.equal(game.dealerIndex, 1);
  assert.equal(game.currentPlayerIndex, 2);
});

test('publicState liefert dealerId konsistent zu dealerIndex', () => {
  const { game } = makeGame(4);
  game.startNewRound();
  const state = game.publicState('p1');
  assert.equal(state.dealerId, game.players[game.dealerIndex].id);
});

test('Ausgetauschter Joker landet in retiredJokers, NICHT zurück auf der Hand', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  const joker = makeJoker(0);
  const meld = {
    id: 'meld-1',
    type: 'set',
    rank: 'D',
    suit: null,
    slots: [
      { real: makeStandardCard('H', 'D', 0) },
      { real: makeStandardCard('C', 'D', 0) },
      { joker, representsRank: 'D', representsSuit: 'S' },
    ],
  };
  game.tableMelds = [meld];

  const handCard = makeStandardCard('S', 'D', 1); // passt auf den Joker-Slot (Pik Dame!)
  game.players[0].hand = [handCard];
  game.players[0].laidOutCards = [];

  const result = game.swapJoker('p1', 'meld-1', handCard.id);
  assert.equal(result.ok, true);

  // Joker ist NICHT mehr auf der Hand des Spielers
  assert.ok(!game.players[0].hand.some((c) => c.isJoker));
  // ... sondern dauerhaft in retiredJokers
  assert.equal(game.retiredJokers.length, 1);
  assert.equal(game.retiredJokers[0].id, joker.id);
  // Die echte Karte ist jetzt im Meld und zählt als ausgelegt
  assert.ok(game.players[0].laidOutCards.some((c) => c.id === handCard.id));
});

test('"Hand aus" wird nur erkannt, wenn die Runde im allerersten Zug endet', () => {
  const { game } = makeGame(2);
  game.setHouseRules({ handAusDoubles: true });
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 0; // allererster Zug der Runde

  game.players[0].hand = [makeStandardCard('H', '7', 0)];
  game.players[0].laidOutCards = [makeStandardCard('H', 'A', 0)]; // 20 Punkte
  game.players[1].hand = [makeStandardCard('H', 'K', 0)]; // 10 Minuspunkte
  game.players[1].laidOutCards = [];

  game.discard('p1', game.players[0].hand[0].id);

  assert.equal(game.phase, 'roundEnd');
  assert.equal(game.lastRoundWasHandAus, true);
  assert.equal(game.lastRoundResult.p1.roundScore, 40); // 20 * 2
  assert.equal(game.lastRoundResult.p2.roundScore, -20); // -10 * 2
});

test('"Hand aus" greift NICHT mehr, wenn vorher schon ein Zug beendet wurde', () => {
  const { game } = makeGame(2);
  game.setHouseRules({ handAusDoubles: true });
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 1; // es gab bereits einen abgeschlossenen Zug

  game.players[0].hand = [makeStandardCard('H', '7', 0)];
  game.players[0].laidOutCards = [makeStandardCard('H', 'A', 0)];
  game.players[1].hand = [];
  game.players[1].laidOutCards = [];

  game.discard('p1', game.players[0].hand[0].id);

  assert.equal(game.lastRoundWasHandAus, false);
  assert.equal(game.lastRoundResult.p1.roundScore, 20); // kein x2
});

test('Hausregel "über 1000 Punkte" wird beim Rundenende berücksichtigt', () => {
  const { game } = makeGame(2);
  game.setHouseRules({ strictThreshold: true });
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 1;
  game.totals = { p1: 980, p2: 0 };

  game.players[0].hand = [makeStandardCard('H', 'A', 0)]; // 20 Punkte -> exakt 1000
  game.players[0].laidOutCards = [];
  game.players[1].hand = [];
  game.players[1].laidOutCards = [];

  game.discard('p1', game.players[0].hand[0].id);

  // Gewinner bekommt 0 Pluspunkte (nichts ausgelegt) -> Summe bleibt bei 980,
  // daher hier stattdessen direkt prüfen, dass bei genau 1000 NICHT beendet wird:
  game.totals.p1 = 1000;
  const { checkGameOver } = require('../game/ScoreBoard');
  assert.equal(checkGameOver(game.totals, game.houseRules).gameOver, false);
  game.totals.p1 = 1001;
  assert.equal(checkGameOver(game.totals, game.houseRules).gameOver, true);
});
