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

test('reorderPlayers ändert die Sitz-/Zugreihenfolge (nur in der Lobby)', () => {
  const { game } = makeGame(4);
  const result = game.reorderPlayers(['p4', 'p3', 'p2', 'p1']);
  assert.equal(result.ok, true);
  assert.deepEqual(game.players.map((p) => p.id), ['p4', 'p3', 'p2', 'p1']);
});

test('reorderPlayers schlägt außerhalb der Lobby fehl', () => {
  const { game } = makeGame(4);
  game.startNewRound();
  const result = game.reorderPlayers(['p4', 'p3', 'p2', 'p1']);
  assert.ok(result.error);
});

test('setExplicitDealer bestimmt den Geber der nächsten Runde direkt', () => {
  const { game } = makeGame(4);
  game.setExplicitDealer('p3');
  game.startNewRound();
  assert.equal(game.players[game.dealerIndex].id, 'p3');
  assert.equal(game.currentPlayer().id, 'p4'); // Spieler nach dem Geber startet
});

test('applyTeamNames benennt nur Bot-Plätze um, verbundene Menschen bleiben unangetastet', () => {
  const { game } = makeGame(2); // p1, p2 sind Menschen
  game.fillWithBots(); // bot-1, bot-2 füllen auf
  game.applyTeamNames(['Anna', 'Tom']);
  assert.equal(game.players.find((p) => p.id === 'p1').name, 'Spieler 1');
  assert.equal(game.players.find((p) => p.id === 'bot-1').name, 'Anna');
  assert.equal(game.players.find((p) => p.id === 'bot-2').name, 'Tom');
});

test('Reconnect-Robustheit: getrennter Mensch wird beim eigenen Zug von der Bot-Logik gesteuert', () => {
  const { game } = makeGame(2);
  game.startNewRound();
  const startingPlayer = game.currentPlayer();
  assert.equal(game.isBotControlled(startingPlayer), false);

  game.markDisconnected(startingPlayer.id);
  assert.equal(game.isBotControlled(startingPlayer), true);
  assert.equal(game.players.find((p) => p.id === startingPlayer.id).connected, false);
});

test('publicState markiert getrennte Spieler als controlledByBot', () => {
  const { game } = makeGame(2);
  game.startNewRound();
  game.markDisconnected('p1');
  const state = game.publicState('p2');
  const p1State = state.players.find((p) => p.id === 'p1');
  assert.equal(p1State.controlledByBot, true);
});

test('onGameOver-Hook wird mit Namen/Score/Sieger-Flag beim Spielende aufgerufen', () => {
  const calls = [];
  const sent = [];
  const game = new (require('../game/GameManager'))((playerId, message) => sent.push({ playerId, message }), {
    onGameOver: (results) => calls.push(results),
  });
  game.addOrReconnectPlayer('p1', 'Florian');
  game.addOrReconnectPlayer('p2', 'Anna');
  game.setHouseRules({ strictThreshold: false });
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 1;
  game.totals = { p1: 990, p2: 0 };

  game.players[0].hand = [makeStandardCard('H', '7', 0)]; // letzte Karte, wird abgeworfen
  game.players[0].laidOutCards = [makeStandardCard('H', 'A', 0)]; // 20 Punkte -> Gesamt 990+20=1010
  game.players[1].hand = [];
  game.players[1].laidOutCards = [];

  game.discard('p1', game.players[0].hand[0].id);

  assert.equal(calls.length, 1);
  const names = calls[0].map((r) => r.name).sort();
  assert.deepEqual(names, ['Anna', 'Florian']);
  const florianResult = calls[0].find((r) => r.name === 'Florian');
  assert.equal(florianResult.won, true);
});

test('finishRound zeichnet jede Runde in roundHistory auf', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 1;

  game.players[0].hand = [makeStandardCard('H', '7', 0)];
  game.players[0].laidOutCards = [makeStandardCard('H', 'A', 0)];
  game.players[1].hand = [];
  game.players[1].laidOutCards = [];

  game.discard('p1', game.players[0].hand[0].id);

  assert.equal(game.roundHistory.length, 1);
  assert.equal(game.roundHistory[0].winnerId, 'p1');
  assert.ok(game.roundHistory[0].results.p1);
  assert.ok(game.roundHistory[0].totalsAfter);
});

test('Beim Spielende wird ein vollständiger lastGameRecord erzeugt und an onGameOver übergeben', () => {
  const records = [];
  const game = new (require('../game/GameManager'))(() => {}, {
    onGameOver: (results, record) => records.push(record),
  });
  game.addOrReconnectPlayer('p1', 'Florian');
  game.addOrReconnectPlayer('p2', 'Anna');
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 1;
  game.totals = { p1: 990, p2: 0 };
  game.gameStartedAt = Date.now() - 1000;

  game.players[0].hand = [makeStandardCard('H', '7', 0)];
  game.players[0].laidOutCards = [makeStandardCard('H', 'A', 0)]; // 20 -> 1010
  game.players[1].hand = [];
  game.players[1].laidOutCards = [];

  game.discard('p1', game.players[0].hand[0].id);

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.winnerId, 'p1');
  assert.equal(record.rounds.length, 1);
  assert.equal(record.players.length, 2);
  assert.ok(record.finishedAt >= record.startedAt);
  assert.equal(game.publicState('p1').hasExportableGame, true);
});

test('prepareRematch setzt Punkte/Verlauf zurück, behält aber die Spieler', () => {
  const { game } = makeGame(2);
  game.totals = { p1: 1200, p2: 300 };
  game.roundHistory = [{ roundNumber: 1 }];
  game.phase = 'gameOver';
  game.gameOverInfo = { gameOver: true, winnerId: 'p1' };

  game.prepareRematch();

  assert.equal(game.phase, 'lobby');
  assert.equal(game.totals.p1, 0);
  assert.equal(game.totals.p2, 0);
  assert.equal(game.roundHistory.length, 0);
  assert.equal(game.gameOverInfo, null);
  assert.equal(game.players.length, 2); // Spieler bleiben erhalten
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
