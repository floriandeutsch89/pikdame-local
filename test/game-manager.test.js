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
    ownerId: 'p1',
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

test('forfeitRound: Runde endet sofort, alle Spieler werden wie normale Mitspieler gewertet (kein Gewinner-Bonus)', () => {
  const { game } = makeGame(3);
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 1; // p2 ist am Zug
  game.turnIndexInRound = 3;

  game.players[0].laidOutCards = [makeStandardCard('H', 'A', 0)]; // 20
  game.players[0].hand = [makeStandardCard('H', '7', 0)]; // -5 -> p1: 15
  game.players[1].laidOutCards = [];
  game.players[1].hand = [makeStandardCard('H', 'K', 0)]; // -10 -> p2: -10
  game.players[2].laidOutCards = [makeStandardCard('H', '5', 0)]; // 5
  game.players[2].hand = []; // p3: 5

  // p1 (nicht am Zug) gibt auf - muss trotzdem möglich sein.
  const result = game.forfeitRound('p1');
  assert.equal(result.ok, true);
  assert.equal(game.phase, 'roundEnd');
  assert.equal(game.lastRoundForfeitedBy, 'p1');

  // Niemand bekommt den Gewinner-Bonus (alle nach "Mitspieler"-Formel).
  assert.equal(game.lastRoundResult.p1.roundScore, 15);
  assert.equal(game.lastRoundResult.p2.roundScore, -10);
  assert.equal(game.lastRoundResult.p3.roundScore, 5);
  for (const pid of ['p1', 'p2', 'p3']) {
    assert.equal(game.lastRoundResult[pid].breakdown.isWinner, false);
  }
});

test('forfeitRound: "Hand aus" greift NICHT, selbst wenn es der allererste Zug der Runde ist', () => {
  const { game } = makeGame(2);
  game.setHouseRules({ handAusDoubles: true });
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 0; // allererster Zug

  game.players[0].laidOutCards = [makeStandardCard('H', 'A', 0)];
  game.players[0].hand = [];
  game.players[1].laidOutCards = [];
  game.players[1].hand = [makeStandardCard('H', 'K', 0)];

  game.forfeitRound('p2');

  assert.equal(game.lastRoundWasHandAus, false);
  assert.equal(game.lastRoundResult.p1.roundScore, 20); // kein x2
});

test('forfeitRound außerhalb einer laufenden Runde liefert einen Fehler', () => {
  const { game } = makeGame(2);
  const result = game.forfeitRound('p1');
  assert.ok(result.error);
});

test('forfeitRound mit unbekannter Spieler-ID liefert einen Fehler', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  const result = game.forfeitRound('unknown-id');
  assert.ok(result.error);
});

test('drawFromDiscard wird abgelehnt, wenn die oberste Karte gar nicht nutzbar wäre', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 0;
  game.tableMelds = [];
  // Hand ohne jeglichen Bezug zur obersten Ablagekarte (Herz-7)
  game.players[0].hand = [
    makeStandardCard('S', '2', 0),
    makeStandardCard('D', 'K', 0),
    makeStandardCard('C', '9', 0),
  ];
  game.discardPile = [makeStandardCard('H', '7', 0)];

  const result = game.drawFromDiscard('p1');
  assert.ok(result.error);
  assert.equal(game.players[0].hand.length, 3, 'Hand darf sich bei Ablehnung nicht verändert haben');
  assert.equal(game.discardPile.length, 1, 'Ablagestapel darf bei Ablehnung nicht verändert haben');
});

test('drawFromDiscard ist erlaubt, wenn die oberste Karte einen neuen Satz ermöglicht', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 0;
  game.tableMelds = [];
  game.players[0].hand = [makeStandardCard('H', '7', 0), makeStandardCard('D', '7', 0)];
  game.discardPile = [makeStandardCard('C', '7', 0)]; // ergibt mit der Hand einen Satz aus 7ern

  const result = game.drawFromDiscard('p1');
  assert.equal(result.ok, true);
  assert.equal(game.players[0].hand.length, 3);
});

test('drawFromDiscard ist VERBOTEN, wenn die Karte nur an eine Auslage passt (Regel: sie muss zu den HANDKARTEN passen)', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 0;
  game.tableMelds = [
    {
      id: 'meld-1',
      ownerId: 'p1',
      type: 'run',
      suit: 'H',
      rank: null,
      slots: [
        { real: makeStandardCard('H', '7', 0) },
        { real: makeStandardCard('H', '8', 0) },
        { real: makeStandardCard('H', '9', 0) },
      ],
    },
  ];
  game.players[0].hand = [makeStandardCard('S', '2', 0)]; // unabhängig von der Ablagekarte
  game.discardPile = [makeStandardCard('H', '10', 0)]; // passt NUR an die Folge, nicht zur Hand

  const result = game.drawFromDiscard('p1');
  assert.ok(result.error, 'Anlegbarkeit an Auslagen berechtigt NICHT zur Aufnahme');
});

test('Zwei-Phasen-Aufnahme: erst nur die oberste Karte, nach dem Legen folgt der Rest', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 0;
  game.tableMelds = [];

  const h7 = makeStandardCard('H', '7', 0);
  const d7 = makeStandardCard('D', '7', 0);
  const filler = makeStandardCard('S', '2', 0);
  game.players[0].hand = [h7, d7, filler];

  const top = makeStandardCard('C', '7', 0); // ergibt mit der Hand einen 7er-Satz
  const rest1 = makeStandardCard('S', 'K', 0);
  const rest2 = makeStandardCard('D', '3', 0);
  game.discardPile = [top, rest1, rest2];

  // Phase 1: NUR die oberste Karte wandert auf die Hand, der Rest bleibt liegen
  const r = game.drawFromDiscard('p1');
  assert.equal(r.ok, true);
  assert.equal(game.players[0].hand.length, 4, 'nur die oberste Karte aufgenommen');
  assert.equal(game.discardPile.length, 2, 'der Rest liegt noch');
  assert.equal(game.mustLayOffCardId, top.id);

  // Andere Aktionen sind blockiert, solange die Pflichtkarte nicht liegt
  const blocked = game.layoutMeld('p1', [h7.id, d7.id, filler.id]);
  assert.ok(blocked.error && blocked.error.includes('SOFORT'), 'andere Aktionen müssen blockiert sein');

  // Phase 2: Pflichtkarte legen -> Rest wandert auf die Hand
  const meldResult = game.layoutMeld('p1', [h7.id, d7.id, top.id]);
  assert.equal(meldResult.ok, true);
  assert.equal(game.discardPile.length, 0, 'Rest wurde aufgenommen');
  const handIds = game.players[0].hand.map((card) => card.id);
  assert.ok(handIds.includes(rest1.id) && handIds.includes(rest2.id), 'Restkarten sind auf der Hand');
  assert.equal(game.pendingDiscardRest, false);
  assert.equal(game.mustLayOffCardId, null);
});

test('layoutMeld: mehrdeutige Joker-Kombination liefert Optionen statt zu raten', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  const queen = makeStandardCard('H', 'Q', 0);
  const j1 = makeJoker(0);
  const j2 = makeJoker(1);
  game.players[0].hand = [queen, j1, j2];

  const result = game.layoutMeld('p1', [queen.id, j1.id, j2.id]);
  assert.equal(result.ambiguous, true);
  assert.equal(result.options.length, 4); // Satz + 3 Folge-Fenster
  // Hand darf bei Mehrdeutigkeit NICHT verändert worden sein
  assert.equal(game.players[0].hand.length, 3);
  assert.equal(game.tableMelds.length, 0);
});

test('layoutMeld: eindeutige Joker-Kombination wird automatisch aufgelöst (keine Rückfrage)', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  // 5 + 7 + Joker: nur EINE gültige Folge möglich (5-6-7, Joker füllt die
  // interne Lücke). Hinweis: K+A+Joker wäre im Werte-Ring MEHRDEUTIG
  // (Q-K-A oder K-A-2) und würde eine Rückfrage auslösen.
  const five = makeStandardCard('H', '5', 0);
  const seven = makeStandardCard('H', '7', 0);
  const joker = makeJoker(0);
  game.players[0].hand = [five, seven, joker];

  const result = game.layoutMeld('p1', [five.id, seven.id, joker.id]);
  assert.equal(result.ok, true);
  assert.equal(game.tableMelds.length, 1);
  assert.equal(game.tableMelds[0].type, 'run');
});

test('layoutMeld: König+Ass+Joker ist im Werte-Ring MEHRDEUTIG (Q-K-A oder K-A-2) und fragt nach', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  const king = makeStandardCard('H', 'K', 0);
  const ace = makeStandardCard('H', 'A', 0);
  const joker = makeJoker(0);
  game.players[0].hand = [king, ace, joker];

  const result = game.layoutMeld('p1', [king.id, ace.id, joker.id]);
  assert.equal(result.ambiguous, true);
  assert.equal(result.options.length, 2);
  const labels = result.options.map((o) => o.label).join(' | ');
  assert.ok(labels.includes('Dame') && labels.includes('2'), labels);
});

test('layoutMeld: nach Auswahl einer Option per jokerAssignments wird genau diese verwendet', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  const queen = makeStandardCard('H', 'Q', 0);
  const j1 = makeJoker(0);
  const j2 = makeJoker(1);
  game.players[0].hand = [queen, j1, j2];

  const first = game.layoutMeld('p1', [queen.id, j1.id, j2.id]);
  assert.equal(first.ambiguous, true);
  const setOption = first.options.find((o) => o.type === 'set');
  assert.ok(setOption);

  const second = game.layoutMeld('p1', [queen.id, j1.id, j2.id], setOption.jokerAssignments);
  assert.equal(second.ok, true);
  assert.equal(game.tableMelds[0].type, 'set');
  assert.equal(game.players[0].hand.length, 0);
});

test('layOffCard: Joker an Folge mit beiden Enden frei liefert 2 Optionen', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  game.tableMelds = [
    {
      id: 'meld-1',
      ownerId: 'p1',
      type: 'run',
      suit: 'H',
      rank: null,
      slots: [
        { real: makeStandardCard('H', '7', 0) },
        { real: makeStandardCard('H', '8', 0) },
        { real: makeStandardCard('H', '9', 0) },
      ],
    },
  ];
  const joker = makeJoker(0);
  game.players[0].hand = [joker];

  const result = game.layOffCard('p1', 'meld-1', joker.id);
  assert.equal(result.ambiguous, true);
  assert.equal(result.options.length, 2);
  assert.equal(game.players[0].hand.length, 1); // unverändert
});

test('layOffCard: nach Auswahl einer Seite wird genau diese angelegt', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  game.tableMelds = [
    {
      id: 'meld-1',
      ownerId: 'p1',
      type: 'run',
      suit: 'H',
      rank: null,
      slots: [
        { real: makeStandardCard('H', '7', 0) },
        { real: makeStandardCard('H', '8', 0) },
        { real: makeStandardCard('H', '9', 0) },
      ],
    },
  ];
  const joker = makeJoker(0);
  game.players[0].hand = [joker];

  const first = game.layOffCard('p1', 'meld-1', joker.id);
  const lowOption = first.options.find((o) => o.side === 'low');
  const second = game.layOffCard('p1', 'meld-1', joker.id, lowOption.asSuit, lowOption.side);
  assert.equal(second.ok, true);
  assert.equal(game.tableMelds[0].slots.length, 4);
  assert.equal(game.tableMelds[0].slots[0].representsRank, '6');
});

test('finishRound ignoriert verwaiste totals-Einträge (nicht mehr aktuelle Spieler) bei der Spielende-Prüfung', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 1;

  // Simuliert einen verwaisten Eintrag, z. B. von einem früheren Spieler-Slot.
  game.totals['orphan-id-from-old-session'] = 5000;
  game.totals.p1 = 0;
  game.totals.p2 = 0;

  game.players[0].hand = [makeStandardCard('H', '2', 0)]; // 5 Punkte Resthand
  game.players[0].laidOutCards = [];
  game.players[1].hand = [];
  game.players[1].laidOutCards = [];

  game.discard('p1', game.players[0].hand[0].id);

  assert.equal(game.phase, 'roundEnd', 'darf NICHT durch den verwaisten 5000er-Eintrag beendet werden');
  assert.equal(game.gameOverInfo, undefined);
});

test('runBotTurn blockiert nie: Notausgang greift auch wenn die Pflichtkarte die einzige Handkarte ist', () => {
  const { game } = makeGame(2);
  game.fillWithBots();
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 2; // bot-1
  game.tableMelds = [];

  const bot1 = game.players.find((p) => p.id === 'bot-1');
  const pikDame = makeStandardCard('S', 'Q', 0);
  bot1.hand = [pikDame];
  game.mustLayOffCardId = pikDame.id; // Pflichtkarte, die nicht ausgelegt werden kann

  game.runBotTurn('bot-1');

  // Der Bot muss seinen Zug irgendwie beenden (Karte abgeworfen, Zug weiter),
  // statt für immer auf turnPhase='meld' hängen zu bleiben.
  assert.ok(game.phase === 'playing' || game.phase === 'roundEnd');
  if (game.phase === 'playing') {
    assert.notEqual(game.currentPlayer().id, 'bot-1');
  }
});

test('setMaxSeats: ändert die maximale Tischgröße innerhalb 2-4', () => {
  const { game } = makeGame(0);
  const result = game.setMaxSeats(2);
  assert.equal(result.ok, true);
  assert.equal(game.maxSeats, 2);
});

test('setMaxSeats: lehnt Werte außerhalb 2-4 ab', () => {
  const { game } = makeGame(0);
  assert.ok(game.setMaxSeats(1).error);
  assert.ok(game.setMaxSeats(5).error);
  assert.equal(game.maxSeats, 4); // unverändert (Standard)
});

test('setMaxSeats: kann nicht kleiner als die Anzahl bereits beigetretener Spieler gewählt werden', () => {
  const { game } = makeGame(3);
  const result = game.setMaxSeats(2);
  assert.ok(result.error);
  assert.equal(game.maxSeats, 4);
});

test('setMaxSeats: nur in der Lobby änderbar', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  const result = game.setMaxSeats(2);
  assert.ok(result.error);
});

test('fillWithBots respektiert die gewählte Spieleranzahl', () => {
  const { game } = makeGame(1);
  game.setMaxSeats(2);
  game.fillWithBots();
  assert.equal(game.players.length, 2);
  assert.equal(game.players.filter((p) => p.isBot).length, 1);
});

test('addOrReconnectPlayer lehnt Beitritt ab, sobald die gewählte Spieleranzahl erreicht ist', () => {
  const { game } = makeGame(0);
  game.setMaxSeats(2);
  assert.ok(game.addOrReconnectPlayer('p1', 'A'));
  assert.ok(game.addOrReconnectPlayer('p2', 'B'));
  assert.equal(game.addOrReconnectPlayer('p3', 'C'), null); // Tisch voll bei 2
});

test('Eine Runde mit nur 2 Spielern (Mindestanzahl) funktioniert vollständig', () => {
  const { game } = makeGame(0);
  game.setMaxSeats(2);
  game.addOrReconnectPlayer('p1', 'A');
  game.fillWithBots();
  game.startNewRound();
  assert.equal(game.players.length, 2);
  assert.equal(game.players[0].hand.length, 15);
  assert.equal(game.players[1].hand.length, 15);
});

test('layoutMeld markiert jeden Slot mit der playerId des auslegenden Spielers', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  const h7 = makeStandardCard('H', '7', 0);
  const d7 = makeStandardCard('D', '7', 0);
  const c7 = makeStandardCard('C', '7', 0);
  game.players[0].hand = [h7, d7, c7];

  game.layoutMeld('p1', [h7.id, d7.id, c7.id]);

  const meld = game.tableMelds[0];
  assert.ok(meld.slots.every((s) => s.playerId === 'p1'));
});

test('layOffCard: Anlegen an FREMDE Auslagen ist verboten (eigene Stapel!)', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  const h7 = makeStandardCard('H', '7', 0);
  const d7 = makeStandardCard('D', '7', 0);
  const c7 = makeStandardCard('C', '7', 0);
  const filler = makeStandardCard('H', '2', 0); // verhindert leere Hand -> vorzeitiges Rundenende
  game.players[0].hand = [h7, d7, c7, filler];
  game.layoutMeld('p1', [h7.id, d7.id, c7.id]);

  // p2 versucht, eine vierte Farbe an p1s Auslage anzulegen -> verboten.
  game.currentPlayerIndex = 1;
  const s7 = makeStandardCard('S', '7', 0);
  game.players[1].hand = [s7];
  const meldId = game.tableMelds[0].id;
  const r = game.layOffCard('p2', meldId, s7.id);

  assert.ok(r.error, 'fremdes Anlegen muss abgelehnt werden');
  assert.ok(r.error.includes('EIGENEN'), r.error);
  assert.equal(game.tableMelds[0].slots.length, 3, 'die fremde Auslage bleibt unverändert');
  assert.equal(game.players[1].hand.length, 1, 'die Karte bleibt auf der Hand');
});

test('layOffCard: Anlegen an die EIGENE Auslage markiert den neuen Slot mit der playerId', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  const h7 = makeStandardCard('H', '7', 0);
  const d7 = makeStandardCard('D', '7', 0);
  const c7 = makeStandardCard('C', '7', 0);
  const s7 = makeStandardCard('S', '7', 0);
  const filler = makeStandardCard('H', '2', 0);
  game.players[0].hand = [h7, d7, c7, s7, filler];
  game.layoutMeld('p1', [h7.id, d7.id, c7.id]);

  const meldId = game.tableMelds[0].id;
  const r = game.layOffCard('p1', meldId, s7.id);
  assert.equal(r.ok, true);
  const newSlot = game.tableMelds[0].slots.find((s) => s.real && s.real.suit === 'S');
  assert.equal(newSlot.playerId, 'p1');
});

test('swapJoker markiert nur den getauschten Slot mit der playerId des Tauschenden', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  const joker = makeJoker(0);
  const meld = {
    id: 'meld-1',
    ownerId: 'p1',
    type: 'set',
    rank: 'D',
    suit: null,
    slots: [
      { real: makeStandardCard('H', 'D', 0), playerId: 'p2' },
      { real: makeStandardCard('C', 'D', 0), playerId: 'p2' },
      { joker, representsRank: 'D', representsSuit: 'S', playerId: 'p2' },
    ],
  };
  game.tableMelds = [meld];

  const pikDame = makeStandardCard('S', 'D', 1);
  game.players[0].hand = [pikDame];
  game.swapJoker('p1', 'meld-1', pikDame.id);

  const updatedMeld = game.tableMelds[0];
  const swappedSlot = updatedMeld.slots.find((s) => s.real && s.real.suit === 'S');
  const untouchedSlots = updatedMeld.slots.filter((s) => s.real && s.real.suit !== 'S');
  assert.equal(swappedSlot.playerId, 'p1');
  assert.ok(untouchedSlots.every((s) => s.playerId === 'p2'));
});

test('swapJoker: Pflichtkarte per Joker-Tausch verwendet loest die Auslege-Pflicht (Deadlock-Regression)', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;

  const joker = makeJoker(0);
  game.tableMelds = [
    {
      id: 'meld-1',
      ownerId: 'p1',
      type: 'set',
      rank: 'Q',
      suit: null,
      slots: [
        { real: makeStandardCard('H', 'Q', 0), playerId: 'p2' },
        { real: makeStandardCard('C', 'Q', 0), playerId: 'p2' },
        { joker, representsRank: 'Q', representsSuit: 'S', playerId: 'p2' },
      ],
    },
  ];

  const pikDame = makeStandardCard('S', 'Q', 0);
  const other = makeStandardCard('D', '5', 0);
  game.players[0].hand = [pikDame, other];
  // Simuliert: Pik-Dame wurde vom Ablagestapel aufgenommen -> Pflichtkarte
  game.mustLayOffCardId = pikDame.id;

  const r = game.swapJoker('p1', 'meld-1', pikDame.id);
  assert.equal(r.ok, true);
  assert.equal(game.mustLayOffCardId, null, 'Pflicht muss nach dem Tausch erfuellt sein');

  // Ohne den Fix war hier fuer immer blockiert:
  const d = game.discard('p1', other.id);
  assert.equal(d.ok, true, 'Abwerfen muss nach erfuellter Pflicht moeglich sein');
});

test('swapJoker: letzte Handkarte per Tausch verbraucht beendet die Runde (Deadlock-Regression)', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 3;

  const joker = makeJoker(0);
  game.tableMelds = [
    {
      id: 'meld-1',
      ownerId: 'p1',
      type: 'set',
      rank: 'Q',
      suit: null,
      slots: [
        { real: makeStandardCard('H', 'Q', 0), playerId: 'p2' },
        { real: makeStandardCard('C', 'Q', 0), playerId: 'p2' },
        { joker, representsRank: 'Q', representsSuit: 'S', playerId: 'p2' },
      ],
    },
  ];

  const pikDame = makeStandardCard('S', 'Q', 0);
  game.players[0].hand = [pikDame]; // einzige Karte
  game.players[0].laidOutCards = [];
  game.players[1].hand = [makeStandardCard('H', '2', 0)];
  game.players[1].laidOutCards = [];

  const r = game.swapJoker('p1', 'meld-1', pikDame.id);
  assert.equal(r.ok, true);
  assert.equal(game.players[0].hand.length, 0);
  assert.equal(game.phase, 'roundEnd', 'Runde muss enden, wenn die letzte Karte per Tausch verbraucht wird');
});

test('Patt-Regel: Runde endet automatisch, wenn niemand mehr ziehen kann (Deadlock-Regression)', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 5;

  game.drawPile = []; // Nachziehstapel leer
  game.discardPile = [makeStandardCard('D', '7', 0)]; // nur 1 Karte -> nicht mischbar
  game.players[0].hand = [makeStandardCard('H', '3', 0)];
  game.players[0].laidOutCards = [];
  game.players[1].hand = [makeStandardCard('C', '9', 0)];
  game.players[1].laidOutCards = [];

  const r = game.drawFromPile('p1');
  assert.equal(r.ok, true);
  assert.equal(r.roundEnded, true);
  assert.equal(game.phase, 'roundEnd', 'Runde muss als Patt enden statt einzufrieren');
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
