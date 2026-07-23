const test = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');
const { makeStandardCard, makeJoker } = require('../game/Card');

// v1.67 interactive cutting: unit tests exercise the game AFTER the deal, so
// every locally constructed game auto-cuts. Dedicated cutting tests live in
// test/cutting.test.js and do NOT use this hook.
function __autoCutHook(g) {
  const orig = g.startNewRound.bind(g);
  g.startNewRound = (...a) => {
    orig(...a);
    if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  };
  return g;
}


function makeGame(playerCount = 4) {
  const sent = [];
  const game = __autoCutHook(new GameManager((playerId, message) => sent.push({ playerId, message })));
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

test('"Hand aus" verdoppelt, wenn der Gewinner vor seinem letzten Zug NICHTS liegen hatte', () => {
  const { game } = makeGame(2);
  game.setHouseRules({ handAusDoubles: true });
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  // Explicit turn-start snapshot as advanceTurn/startNewRound would set it:
  // the winner had nothing on the table when this turn began.
  game.players[0]._laidAtTurnStart = false;

  game.players[0].hand = [makeStandardCard('H', '7', 0)];
  game.players[0].laidOutCards = [makeStandardCard('H', 'A', 0)]; // 20 Punkte (in DIESEM Zug gelegt)
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

test('takeover grace: a disconnected human stays in control first, a bot takes over after the grace window', () => {
  const { game } = makeGame(2);
  game.startNewRound();
  const startingPlayer = game.currentPlayer();
  assert.equal(game.isBotControlled(startingPlayer), false);

  game.markDisconnected(startingPlayer.id);
  const p = game.players.find((pl) => pl.id === startingPlayer.id);
  assert.equal(p.connected, false);
  // Inside the grace window: NOT bot-controlled (brief app switches in
  // hosted mode must not cost the player their round)
  assert.equal(game.isBotControlled(p), false);
  // Reconnect cancels the takeover entirely
  game.addOrReconnectPlayer(p.id, p.name);
  assert.equal(p.connected, true);
  assert.equal(p.disconnectedAt, undefined);
  // Disconnect again, grace elapsed -> bot takes over
  game.markDisconnected(p.id);
  p.disconnectedAt = Date.now() - GameManager.TAKEOVER_GRACE_MS - 1000;
  assert.equal(game.isBotControlled(p), true);
});

test('publicState markiert getrennte Spieler nach Ablauf der Grace als controlledByBot', () => {
  const { game } = makeGame(2);
  game.startNewRound();
  game.markDisconnected('p1');
  // Inside the grace window the seat still belongs to the human
  assert.equal(game.publicState('p2').players.find((p) => p.id === 'p1').controlledByBot, false);
  // Grace elapsed -> visible bot takeover
  game.players.find((p) => p.id === 'p1').disconnectedAt = Date.now() - GameManager.TAKEOVER_GRACE_MS - 1000;
  assert.equal(game.publicState('p2').players.find((p) => p.id === 'p1').controlledByBot, true);
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

test('forfeit: erst wenn ALLE aktiven Spieler zustimmen, endet das ganze Spiel (Abbruch, kein Sieger)', () => {
  const { game } = makeGame(3);
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 1;
  game.turnIndexInRound = 3;
  game.totals = { p1: 120, p2: 340, p3: 90 }; // Zwischenstand aus Vorrunden

  // Ein einzelnes Votum beendet nichts.
  assert.equal(game.toggleForfeitVote('p1').ok, true);
  assert.equal(game.phase, 'playing', 'ein Votum reicht nicht');
  assert.equal(game.toggleForfeitVote('p2').ok, true);
  assert.equal(game.phase, 'playing', 'zwei von drei reichen nicht');
  // Votum lässt sich zurückziehen.
  game.toggleForfeitVote('p1');
  assert.equal(game.phase, 'playing');
  game.toggleForfeitVote('p1');
  // Jetzt stimmen alle drei zu -> ganzes Spiel endet.
  assert.equal(game.toggleForfeitVote('p3').ok, true);
  assert.equal(game.phase, 'gameOver');
  assert.equal(game.gameOverInfo.forfeited, true);
  assert.equal(game.gameOverInfo.winnerId, null, 'kein Sieger bei Abbruch');
  assert.deepEqual(game.gameOverInfo.finalTotals, { p1: 120, p2: 340, p3: 90 });
});

test('forfeit: ein einziger verbundener Mensch (Rest Bots) gibt das Spiel allein auf', () => {
  const game = __autoCutHook(new GameManager(() => {}));
  game.addOrReconnectPlayer('p1', 'Mensch');
  game.maxSeats = 4;
  game.fillWithBots();
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 0;
  game.turnIndexInRound = 2;
  const r = game.toggleForfeitVote('p1');
  assert.equal(r.ok, true);
  assert.equal(game.phase, 'gameOver', 'einziger Mensch -> sofortiger Spielabbruch');
  assert.equal(game.gameOverInfo.forfeited, true);
});

test('forfeit: ein aufgegebenes Spiel wird NICHT als abgeschlossene Partie gewertet (kein onGameOver)', () => {
  let recorded = false;
  const game = new GameManager(() => {}, {
    onGameOver: () => { recorded = true; },
  });
  game.addOrReconnectPlayer('p1', 'Mensch');
  game.maxSeats = 3;
  game.fillWithBots();
  game.phase = 'playing';
  game.turnPhase = 'draw';
  game.currentPlayerIndex = 0;
  game.toggleForfeitVote('p1');
  assert.equal(game.phase, 'gameOver');
  assert.equal(recorded, false, 'Abbruch darf keine Statistik/kein Ergebnis aufzeichnen');
});

test('forfeit außerhalb einer laufenden Partie liefert einen Fehler', () => {
  const { game } = makeGame(2);
  const result = game.toggleForfeitVote('p1');
  assert.ok(result.error);
});

test('forfeit: das Spiel kann auch am RUNDENENDE (Punkteuebersicht) aufgegeben werden', () => {
  const { game } = makeGame(2);
  game.startNewRound();
  game.finishRound('p1'); // regulaerer Rundenabschluss -> Phase roundEnd
  assert.equal(game.phase, 'roundEnd');
  assert.equal(game.toggleForfeitVote('p1').ok, true);
  assert.equal(game.phase, 'roundEnd', 'ein Votum reicht nicht');
  game.toggleForfeitVote('p2');
  assert.equal(game.phase, 'gameOver');
  assert.equal(game.gameOverInfo.forfeited, true);
});

test('forfeit mit unbekannter Spieler-ID liefert einen Fehler', () => {
  const { game } = makeGame(2);
  game.phase = 'playing';
  const result = game.toggleForfeitVote('unknown-id');
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
  game.players[0].hand = [five, seven, joker, makeStandardCard('C', '3', 1)];

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
  game.players[0].hand = [queen, j1, j2, makeStandardCard('C', '3', 1)];

  const first = game.layoutMeld('p1', [queen.id, j1.id, j2.id]);
  assert.equal(first.ambiguous, true);
  const setOption = first.options.find((o) => o.type === 'set');
  assert.ok(setOption);

  const second = game.layoutMeld('p1', [queen.id, j1.id, j2.id], setOption.jokerAssignments);
  assert.equal(second.ok, true);
  assert.equal(game.tableMelds[0].type, 'set');
  assert.equal(game.players[0].hand.length, 1); // die Füllkarte bleibt (Ausmach-Regel)
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
  game.players[0].hand = [joker, makeStandardCard('C', '3', 1)];

  const result = game.layOffCard('p1', 'meld-1', joker.id);
  assert.equal(result.ambiguous, true);
  assert.equal(result.options.length, 2);
  assert.equal(game.players[0].hand.length, 2); // unverändert (Joker + Füllkarte)
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
  game.players[0].hand = [joker, makeStandardCard('C', '3', 1)];

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
  game.players[0].hand = [h7, d7, c7, makeStandardCard('C', '3', 1)];

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
  game.players[0].hand = [h7, d7, c7, filler, makeStandardCard('C', '3', 1)];
  game.layoutMeld('p1', [h7.id, d7.id, c7.id]);

  // p2 versucht, eine vierte Farbe an p1s Auslage anzulegen -> verboten.
  game.currentPlayerIndex = 1;
  const s7 = makeStandardCard('S', '7', 0);
  game.players[1].hand = [s7, makeStandardCard('D', '2', 1)]; // 2. Karte: Ausmach-Guard soll hier nicht greifen
  const meldId = game.tableMelds[0].id;
  const r = game.layOffCard('p2', meldId, s7.id);

  assert.ok(r.error, 'fremdes Anlegen muss abgelehnt werden');
  assert.ok(r.error.includes('EIGENEN'), r.error);
  assert.equal(game.tableMelds[0].slots.length, 3, 'die fremde Auslage bleibt unverändert');
  assert.equal(game.players[1].hand.length, 2, 'die Karte bleibt auf der Hand');
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

// --- v1.53.1: second set of the same value is allowed (Doppel-Satz removed) --
test('layoutMeld: a second set of the same value is allowed', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.addOrReconnectPlayer('p2', 'B');
  g.phase = 'playing';
  g.turnPhase = 'meld';
  g.currentPlayerIndex = 0;
  const s7 = makeStandardCard('S', '7', 0), h7 = makeStandardCard('H', '7', 0), d7 = makeStandardCard('D', '7', 0);
  const c7 = makeStandardCard('C', '7', 0), s7b = makeStandardCard('S', '7', 1), h7b = makeStandardCard('H', '7', 1);
  g.players[0].hand = [s7, h7, d7, c7, s7b, h7b, makeStandardCard('C', '2', 0)];
  const r1 = g.layoutMeld('p1', [s7.id, h7.id, d7.id]);
  assert.ok(!r1.error, 'erster Satz muss klappen');
  const r2 = g.layoutMeld('p1', [c7.id, s7b.id, h7b.id]);
  assert.ok(!r2.error, 'zweiter Satz gleichen Werts ist jetzt erlaubt');
  assert.equal(g.tableMelds.filter((m) => m.type === 'set' && m.rank === '7').length, 2, 'zwei 7er-Saetze liegen');
  // Zweite FOLGE gleicher Farbe bleibt ebenfalls erlaubt
  const h3 = makeStandardCard('H', '3', 0), h4 = makeStandardCard('H', '4', 0), h5 = makeStandardCard('H', '5', 0);
  const h8 = makeStandardCard('H', '8', 0), h9 = makeStandardCard('H', '9', 0), h10 = makeStandardCard('H', '10', 0);
  g.players[0].hand.push(h3, h4, h5, h8, h9, h10);
  assert.ok(!g.layoutMeld('p1', [h3.id, h4.id, h5.id]).error);
  assert.ok(!g.layoutMeld('p1', [h8.id, h9.id, h10.id]).error, 'zweite Folge gleicher Farbe muss erlaubt sein');
});

test('houseRules: valid rules kept, garbage (incl. the removed botDifficulty) ignored', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.setHouseRules({ turnTimerSeconds: 60, handAusDoubles: true });
  assert.equal(g.houseRules.turnTimerSeconds, 60);
  assert.equal(g.houseRules.handAusDoubles, true);
  g.setHouseRules({ turnTimerSeconds: 999, evil: true, botDifficulty: 'zen' });
  assert.equal(g.houseRules.turnTimerSeconds, 60); // invalid value rejected -> keeps last
  assert.equal(g.houseRules.evil, undefined);
  assert.equal(g.houseRules.botDifficulty, undefined, 'bot difficulty is per-bot, not a house rule');
});

// --- v1.6.0: Ausmachen nur per Abwurf --------------------------------------
test('Ausmach-Regel: Auslegen aller Handkarten wird abgelehnt', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.addOrReconnectPlayer('p2', 'B');
  g.phase = 'playing'; g.turnPhase = 'meld'; g.currentPlayerIndex = 0;
  const s7 = makeStandardCard('S', '7', 0), h7 = makeStandardCard('H', '7', 0), d7 = makeStandardCard('D', '7', 0);
  g.players[0].hand = [s7, h7, d7]; // genau 3 Karten = kompletter Drilling
  const r = g.layoutMeld('p1', [s7.id, h7.id, d7.id]);
  assert.match(r.error, /letzte Karte abwerfen/);
  // Mit einer vierten Karte auf der Hand klappt derselbe Drilling
  g.players[0].hand.push(makeStandardCard('C', '2', 0));
  assert.ok(!g.layoutMeld('p1', [s7.id, h7.id, d7.id]).error);
});

test('Ausmach-Regel: letzte Handkarte darf nicht angelegt werden', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.addOrReconnectPlayer('p2', 'B');
  g.phase = 'playing'; g.turnPhase = 'meld'; g.currentPlayerIndex = 0;
  const s7 = makeStandardCard('S', '7', 0), h7 = makeStandardCard('H', '7', 0), d7 = makeStandardCard('D', '7', 0);
  const c7 = makeStandardCard('C', '7', 0), extra = makeStandardCard('C', '2', 0);
  g.players[0].hand = [s7, h7, d7, c7, extra];
  g.layoutMeld('p1', [s7.id, h7.id, d7.id]);
  const meldId = g.tableMelds[0].id;
  // extra abwerfen ist hier nicht noetig - wir simulieren: nur noch c7 auf der Hand
  g.players[0].hand = [c7];
  const r = g.layOffCard('p1', meldId, c7.id);
  assert.match(r.error, /letzte Karte abwerfen/);
});

test('Ausmach-Regel: Pflichtkarte darf trotzdem gelegt werden (keine Sackgasse)', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.addOrReconnectPlayer('p2', 'B');
  g.phase = 'playing'; g.turnPhase = 'meld'; g.currentPlayerIndex = 0;
  const s7 = makeStandardCard('S', '7', 0), h7 = makeStandardCard('H', '7', 0), d7 = makeStandardCard('D', '7', 0);
  g.players[0].hand = [s7, h7, d7];
  g.mustLayOffCardId = d7.id; // d7 kam gerade vom Ablagestapel (Rest leer)
  g.pendingDiscardRest = true;
  const r = g.layoutMeld('p1', [s7.id, h7.id, d7.id]);
  assert.ok(!r.error, 'Pflichtfall darf nicht blockieren: ' + JSON.stringify(r));
});

// --- v1.6.0: Bot-Emotes ------------------------------------------------------
test('maybeBotEmote: feuert den Hook, drosselt pro Bot, destroy raeumt Timer', async () => {
  const emotes = [];
  const g = __autoCutHook(new GameManager(() => {}, { onBotEmote: (id, e) => emotes.push([id, e]) }));
  g.addOrReconnectPlayer('p1', 'A');
  g.fillWithBots();
  const botId = g.players.find((p) => p.isBot).id;
  g._emoteDelayForTest = 0;
  g.maybeBotEmote(botId, '😤', 1);
  g.maybeBotEmote(botId, '🎉', 1); // innerhalb 5s -> gedrosselt
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(emotes, [[botId, '😤']]);
  // Menschen loesen nie Bot-Emotes aus
  g.maybeBotEmote('p1', '😤', 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(emotes.length, 1);
  // destroy raeumt pendende Timer ab
  g._lastBotEmote = {};
  g._emoteDelayForTest = 5000;
  g.maybeBotEmote(botId, '😱', 1);
  assert.equal(g._emoteTimers.size, 1);
  g.destroy();
  assert.equal(g._emoteTimers.size, 0);
});

// --- v1.8.1: Emote-Timer ueberleben Snapshot/Restore ------------------------
test('serialize/deserialize: Bot-Emotes funktionieren nach einem Server-Neustart', async () => {
  const emotes = [];
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.fillWithBots();
  g.startNewRound();

  // Snapshot wie im echten Betrieb: durch JSON hindurch (Set -> {} Gefahr)
  const snapshot = JSON.parse(JSON.stringify(g.serialize()));
  assert.equal(snapshot._emoteTimers, undefined, 'transiente Felder nicht im Snapshot');
  assert.equal(snapshot._lastBotEmote, undefined);

  const g2 = __autoCutHook(new GameManager(() => {}, { onBotEmote: (id, e) => emotes.push(e) }));
  g2.deserialize(snapshot);
  assert.ok(g2._emoteTimers instanceof Set, '_emoteTimers ist nach Restore ein Set');

  // Auch ALTE Snapshots (mit kaputtem {}-Feld) duerfen nicht crashen
  const legacy = { ...snapshot, _emoteTimers: {}, _lastBotEmote: {} };
  const g3 = __autoCutHook(new GameManager(() => {}, { onBotEmote: (id, e) => emotes.push(e) }));
  g3.deserialize(legacy);
  assert.ok(g3._emoteTimers instanceof Set, 'kaputtes Legacy-Feld wird repariert');
  const botId = g3.players.find((p) => p.isBot).id;
  g3._emoteDelayForTest = 0;
  assert.doesNotThrow(() => g3.maybeBotEmote(botId, '😤', 1));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(emotes.includes('😤'), 'Emote nach Restore gefeuert');
  g2.destroy(); g3.destroy();
});

// --- v1.15.0: endgame guard - bots avoid piles hiding a Queen of Spades ----
test('bot endgame guard: small hand + Queen of Spades below the top card -> draws from stock', () => {
  const { makeStandardCard, makeJoker } = require('../game/Card');
  for (const difficulty of ['medium', 'hard', 'zen']) {
    const g = __autoCutHook(new GameManager(() => {}));
    g.addOrReconnectPlayer('p1', 'A');
    g.setHouseRules({ botDifficulty: difficulty });
    g.fillWithBots();
    g.phase = 'playing'; g.turnPhase = 'draw';
    const botIdx = g.players.findIndex((p) => p.isBot);
    g.currentPlayerIndex = botIdx;
    const bot = g.players[botIdx];
    // Hand of 3 with a pair -> the top 7 completes a set, VERY attractive
    bot.hand = [makeStandardCard('H', '7', 0), makeStandardCard('D', '7', 0), makeStandardCard('C', '2', 0)];
    // Top card usable, but a Queen of Spades hides below it
    g.drawPile = [makeStandardCard('C', '9', 0), makeStandardCard('C', '10', 0)];
    g.discardPile = [makeStandardCard('S', '7', 0), makeStandardCard('S', 'Q', 0), makeStandardCard('H', '3', 0)];
    g.runBotTurn(bot.id);
    const tookPile = g.log.some((e) => /nimmt die oberste Ablagekarte/.test(e.text) && e.text.includes(bot.name));
    assert.equal(tookPile, false, `${difficulty}: bot must not swallow the pile`);
    g.destroy();
  }
});

test('bot endgame guard: Queen of Spades ON TOP stays attractive (meldable +100)', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.setHouseRules({ botDifficulty: 'hard' });
  g.fillWithBots();
  g.phase = 'playing'; g.turnPhase = 'draw';
  const botIdx = g.players.findIndex((p) => p.isBot);
  g.currentPlayerIndex = botIdx;
  const bot = g.players[botIdx];
  // Two queens in hand -> the Queen of Spades on top completes the set
  bot.hand = [makeStandardCard('H', 'Q', 0), makeStandardCard('D', 'Q', 0), makeStandardCard('C', '2', 0), makeStandardCard('C', '5', 0)];
  g.drawPile = [makeStandardCard('C', '9', 0)];
  g.discardPile = [makeStandardCard('S', 'Q', 0), makeStandardCard('H', '3', 0)];
  g.runBotTurn(bot.id);
  const tookTop = g.log.some((e) => /nimmt die oberste Ablagekarte/.test(e.text) && e.text.includes(bot.name));
  assert.equal(tookTop, true, 'a directly meldable Queen of Spades on top is worth +100');
  g.destroy();
});

// --- v1.16.0: guard also fires when an OPPONENT is close to going out -------
test('bot endgame guard: opponent with 3 cards + hidden Queen of Spades -> draws from stock', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.setHouseRules({ botDifficulty: 'medium' });
  g.fillWithBots();
  g.phase = 'playing'; g.turnPhase = 'draw';
  const botIdx = g.players.findIndex((p) => p.isBot);
  g.currentPlayerIndex = botIdx;
  const bot = g.players[botIdx];
  // Big own hand (guard would NOT fire on own-hand size alone) with a pair
  // matching the top card - taking the pile looks attractive
  bot.hand = [
    makeStandardCard('H', '7', 0), makeStandardCard('D', '7', 0),
    makeStandardCard('C', '2', 0), makeStandardCard('C', '4', 0),
    makeStandardCard('D', '9', 0), makeStandardCard('H', 'J', 0),
  ];
  // An opponent is about to go out
  g.players[0].hand = [makeStandardCard('S', '3', 0), makeStandardCard('S', '4', 0), makeStandardCard('S', '5', 0)];
  g.drawPile = [makeStandardCard('C', '9', 0)];
  g.discardPile = [makeStandardCard('S', '7', 0), makeStandardCard('S', 'Q', 0), makeStandardCard('H', '3', 0)];
  g.runBotTurn(bot.id);
  const tookPile = g.log.some((e) => /nimmt die oberste Ablagekarte/.test(e.text) && e.text.includes(bot.name));
  assert.equal(tookPile, false, 'opponent near going out -> do not swallow the pile');
  g.destroy();
});

// --- v1.20.0: round-end ready check ------------------------------------------
test('ready check: next round starts only after EVERY connected human confirmed', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Ben');
  g.fillWithBots();
  g.startNewRound();
  g.finishRound(g.players[0].id);
  assert.equal(g.phase, 'roundEnd');

  g.markNextRoundReady('p1');
  assert.equal(g.phase, 'roundEnd', 'one of two humans is not enough');
  assert.deepEqual(g.publicState('p1').nextRoundReady, ['p1']);

  g.markNextRoundReady('p2');
  assert.equal(g.phase, 'playing', 'both confirmed -> round starts');
  assert.deepEqual(g.publicState('p1').nextRoundReady, [], 'reset on round start');
  g.destroy();
});

test('ready check: a disconnecting player never blocks the table', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Ben');
  g.fillWithBots();
  g.startNewRound();
  g.finishRound(g.players[0].id);
  g.markNextRoundReady('p1');
  assert.equal(g.phase, 'roundEnd');
  g.markDisconnected('p2'); // the missing confirmer leaves
  assert.equal(g.phase, 'playing', 'disconnect re-evaluates readiness');
  g.destroy();
});

// --- v1.20.0: hand-bloat guard ------------------------------------------------
test('pile-usability check: bot skips a big pile of dead weight...', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.setHouseRules({ botDifficulty: 'medium' });
  g.fillWithBots();
  g.phase = 'playing'; g.turnPhase = 'draw';
  const botIdx = g.players.findIndex((p) => p.isBot);
  g.currentPlayerIndex = botIdx;
  const bot = g.players[botIdx];
  // 15-card hand with a pair matching the top card (pile looks attractive)
  bot.hand = [makeStandardCard('H', '7', 0), makeStandardCard('D', '7', 0)];
  ['2', '4', '6', '8', '10', 'Q', 'A'].forEach((r) => bot.hand.push(makeStandardCard('S', r, 1)));
  ['3', '5', '9', 'J', 'K', 'A'].forEach((r) => bot.hand.push(makeStandardCard('C', r, 1)));
  g.drawPile = [makeStandardCard('C', '9', 0)];
  // 8-card pile: only the top seven is usable, the rest is combinable with
  // NOTHING (unique dead singles) -> mostly dead weight -> skip
  g.discardPile = [makeStandardCard('S', '7', 0)];
  // Each rank appears at most twice across hand+pile (no sets) and no
  // suit gets three neighbouring ranks (no runs) - verified dead weight.
  [['H', '3'], ['D', '5'], ['H', 'J'], ['D', '9'], ['H', 'Q'], ['D', 'K'], ['H', '6']].forEach(
    ([s, r], i) => g.discardPile.push(makeStandardCard(s, r, i % 2))
  );
  g.runBotTurn(bot.id);
  const tookPile = g.log.some((e) => /nimmt die oberste Ablagekarte/.test(e.text) && e.text.includes(bot.name));
  assert.equal(tookPile, false, 'a mostly-dead pile must be skipped');
  g.destroy();
});

test('pile-usability check: ...but happily takes a big pile it can put to work', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.setHouseRules({ botDifficulty: 'medium' });
  g.fillWithBots();
  g.phase = 'playing'; g.turnPhase = 'draw';
  const botIdx = g.players.findIndex((p) => p.isBot);
  g.currentPlayerIndex = botIdx;
  const bot = g.players[botIdx];
  // 10-card hand, 10-card pile: two complete sets ride along - "10 in hand
  // + 10 usable from the pile is a power move, not a problem"
  bot.hand = [makeStandardCard('H', '7', 0), makeStandardCard('D', '7', 0)];
  ['2', '4', '6', '9', 'J', 'Q', 'K', 'A'].forEach((r) => bot.hand.push(makeStandardCard('S', r, 1)));
  g.drawPile = [makeStandardCard('C', '9', 0)];
  g.discardPile = [makeStandardCard('S', '7', 0)];
  [['H', '5'], ['D', '5'], ['C', '5'], ['H', '10'], ['D', '10'], ['C', '10'], ['H', '3'], ['D', '8'], ['C', 'J']].forEach(
    ([s, r]) => g.discardPile.push(makeStandardCard(s, r, 0))
  );
  g.runBotTurn(bot.id);
  const tookPile = g.log.some((e) => /nimmt die oberste Ablagekarte/.test(e.text) && e.text.includes(bot.name));
  assert.equal(tookPile, true, 'a usable pile is worth taking, size be damned');
  g.destroy();
});

// --- v1.20.0: cumulative game totals -----------------------------------------
test('gameStatsTotals accumulate melded Queens/jokers across rounds', () => {
  const { makeStandardCard, makeJoker } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'Anna');
  g.fillWithBots();
  g.startNewRound();
  const p = g.players.find((pl) => pl.id === 'p1');
  p.laidOutCards = [makeStandardCard('S', 'Q', 0), makeJoker(0)];
  g.finishRound('p1');
  g.startNewRound();
  const p2 = g.players.find((pl) => pl.id === 'p1');
  p2.laidOutCards = [makeStandardCard('S', 'Q', 1)];
  g.finishRound('p1');
  const totals = g.publicState('p1').gameStatsTotals['p1'];
  assert.equal(totals.pikDames, 2);
  assert.equal(totals.jokers, 1);
  g.destroy();
});

// --- v1.22.0: per-bot difficulty ----------------------------------------------
test('setBotDifficulty: validation, effect and per-bot resolution in guards', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'Anna');
  g.fillWithBots();

  const bot = g.players.find((p) => p.isBot);
  assert.equal(bot.botDifficulty, 'zen', 'bots default to Zen (no global setting)');

  assert.match(g.setBotDifficulty('p1', bot.id, 'brutal').error, /Unbekannte/);
  assert.match(g.setBotDifficulty('p1', bot.id, 'hard').error, /Unbekannte/, "'hard' no longer exists");
  assert.match(g.setBotDifficulty(bot.id, bot.id, 'easy').error, /Nur Spieler/, 'bots cannot request');
  assert.match(g.setBotDifficulty('p1', 'p1', 'easy').error, /Bot gibt es nicht/);

  assert.equal(g.setBotDifficulty('p1', bot.id, 'easy').ok, true);
  assert.equal(bot.botDifficulty, 'easy');
  assert.ok(g.log.some((e) => e.text.includes('stellt') && e.text.includes('Anfänger')));
  const pub = g.publicState('p1').players.find((p) => p.id === bot.id);
  assert.equal(pub.botDifficulty, 'easy', 'visible in the public state');

  // Per-bot resolution: this EASY bot ignores the endgame guard and takes
  // a pile hiding a Queen of Spades - even though the HOUSE rule is stronger.
  g.phase = 'playing'; g.turnPhase = 'draw';
  g.currentPlayerIndex = g.players.findIndex((p) => p.id === bot.id);
  bot.hand = [makeStandardCard('H', '7', 0), makeStandardCard('D', '7', 0), makeStandardCard('C', '2', 0)];
  g.drawPile = [makeStandardCard('C', '9', 0)];
  g.discardPile = [makeStandardCard('S', '7', 0), makeStandardCard('S', 'Q', 0), makeStandardCard('H', '3', 0)];
  // easy bots randomly skip the pile 60% of the time - force determinism
  const origRandom = Math.random;
  Math.random = () => 0.99;
  try {
    g.runBotTurn(bot.id);
  } finally {
    Math.random = origRandom;
  }
  const tookPile = g.log.some((e) => /nimmt die oberste Ablagekarte/.test(e.text) && e.text.includes(bot.name));
  assert.equal(tookPile, true, 'easy override beats the hard house default');
  g.destroy();
});

// --- v1.27.0: multi lay-off ---------------------------------------------------
function setupLayOffScene() {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Ben');
  g.startNewRound();
  g.currentPlayerIndex = g.players.findIndex((p) => p.id === 'p1');
  g.turnPhase = 'meld';
  const me = g.players.find((p) => p.id === 'p1');
  return { g, me, mk: makeStandardCard };
}

test('multi lay-off: two tens join the ten set in one action', () => {
  const { g, me, mk } = setupLayOffScene();
  me.hand = [mk('H', '10', 0), mk('D', '10', 0), mk('C', '2', 0)];
  const set = [mk('S', '10', 0), mk('C', '10', 0), mk('H', '10', 1)];
  me.hand.push(...set);
  const meldRes = g.layoutMeld('p1', set.map((c) => c.id));
  assert.equal(meldRes.error, undefined);
  const meldId = g.tableMelds.find((m) => m.ownerId === 'p1').id;

  const r = g.layOffCards('p1', meldId, [me.hand[0].id, me.hand[1].id]);
  assert.equal(r.error, undefined);
  assert.equal(g.tableMelds.find((m) => m.id === meldId).slots.length, 5);
  assert.equal(me.hand.length, 1, 'both tens left the hand');
  g.destroy();
});

test('multi lay-off: run order is found automatically (J before Q onto 8-9-10)', () => {
  const { g, me, mk } = setupLayOffScene();
  const run = [mk('H', '8', 0), mk('H', '9', 0), mk('H', '10', 0)];
  const jack = mk('H', 'J', 0);
  const queen = mk('H', 'Q', 0);
  me.hand = [...run, queen, jack, mk('C', '2', 0)];
  assert.equal(g.layoutMeld('p1', run.map((c) => c.id)).error, undefined);
  const meldId = g.tableMelds.find((m) => m.ownerId === 'p1').id;

  // Selected in the "wrong" order (queen first) - the server must sort it out
  const r = g.layOffCards('p1', meldId, [queen.id, jack.id]);
  assert.equal(r.error, undefined);
  assert.equal(g.tableMelds.find((m) => m.id === meldId).slots.length, 5);
  g.destroy();
});

test('multi lay-off: all-or-nothing when one card does not fit', () => {
  const { g, me, mk } = setupLayOffScene();
  const ten1 = mk('H', '10', 0);
  const misfit = mk('C', '3', 0);
  const set = [mk('S', '10', 0), mk('C', '10', 0), mk('D', '10', 0)];
  me.hand = [ten1, misfit, ...set, mk('C', '2', 0)];
  assert.equal(g.layoutMeld('p1', set.map((c) => c.id)).error, undefined);
  const meldId = g.tableMelds.find((m) => m.ownerId === 'p1').id;
  const handBefore = me.hand.length;
  const slotsBefore = g.tableMelds.find((m) => m.id === meldId).slots.length;

  const r = g.layOffCards('p1', meldId, [ten1.id, misfit.id]);
  assert.match(r.error, /passen zusammen/);
  assert.equal(me.hand.length, handBefore, 'hand untouched');
  assert.equal(g.tableMelds.find((m) => m.id === meldId).slots.length, slotsBefore, 'meld untouched');
  g.destroy();
});

test('multi lay-off: going-out rule blocks emptying the hand via lay-off', () => {
  const { g, me, mk } = setupLayOffScene();
  const t1 = mk('H', '10', 0);
  const t2 = mk('D', '10', 0);
  const set = [mk('S', '10', 0), mk('C', '10', 0), mk('H', '10', 1)];
  me.hand = [t1, t2, ...set];
  assert.equal(g.layoutMeld('p1', set.map((c) => c.id)).error, undefined);
  const meldId = g.tableMelds.find((m) => m.ownerId === 'p1').id;
  const r = g.layOffCards('p1', meldId, [t1.id, t2.id]);
  assert.match(r.error, /letzte Karte abwerfen/);
  g.destroy();
});

// --- v1.28.0: public memory (fair-play card tracking) --------------------------
test('public memory: pile pickups are remembered, face-down draws NEVER (fairness guard)', () => {
  const { makeStandardCard } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'Anna');
  g.addOrReconnectPlayer('p2', 'Ben');
  g.startNewRound();
  g.currentPlayerIndex = g.players.findIndex((p) => p.id === 'p1');
  g.turnPhase = 'draw';
  const p1 = g.players.find((p) => p.id === 'p1');

  // Face-down draw: memory must stay EMPTY - nobody saw that card.
  const before = g.drawPile.length;
  g.drawFromPile('p1');
  assert.equal(g.drawPile.length, before - 1);
  assert.deepEqual(g.publicKnownHands['p1'] || [], [], 'face-down draws are never recorded');
  g.discard('p1', p1.hand[0].id);

  // Pile pickup: the whole table watched those cards - they enter memory.
  g.currentPlayerIndex = g.players.findIndex((p) => p.id === 'p1');
  g.turnPhase = 'draw';
  p1.hand = [makeStandardCard('H', '7', 0), makeStandardCard('D', '7', 0), makeStandardCard('C', '2', 0)];
  g.discardPile = [makeStandardCard('S', '7', 0), makeStandardCard('H', '3', 1), makeStandardCard('C', '9', 1)];
  const pileIds = g.discardPile.map((cd) => cd.id);
  assert.equal(g.drawFromDiscard('p1').ok, true);
  // must-lay the seven, then the rest arrives
  const meldRes = g.layoutMeld('p1', [p1.hand.find((c) => c.rank === '7' && c.suit === 'S').id,
    p1.hand.find((c) => c.rank === '7' && c.suit === 'H').id,
    p1.hand.find((c) => c.rank === '7' && c.suit === 'D').id]);
  assert.equal(meldRes.error, undefined);
  const knownIds = (g.publicKnownHands['p1'] || []).map((cd) => cd.id);
  assert.ok(knownIds.includes(pileIds[1]) && knownIds.includes(pileIds[2]), 'rest of the pile is remembered');
  assert.ok(!knownIds.includes(pileIds[0]), 'the melded seven visibly left the hand again');

  // Discarding a known card removes it from memory
  const knownCard = (g.publicKnownHands['p1'] || [])[0];
  g.discard('p1', knownCard.id);
  assert.ok(!(g.publicKnownHands['p1'] || []).some((cd) => cd.id === knownCard.id));
  g.destroy();
});

test('zen discard: avoids feeding a rank an opponent is publicly known to collect', () => {
  const { chooseDiscard } = require('../game/Bot');
  const { makeStandardCard: mk } = require('../game/Card');
  // Two near-equal value candidates: a ten and a nine (both isolated).
  const hand = [mk('H', '10', 0), mk('C', '9', 0), mk('S', '2', 0), mk('S', '2', 1), mk('D', '2', 0)];
  // Opponent visibly swallowed two tens with the pile:
  const known = [mk('S', '10', 1), mk('D', '10', 1)];
  for (let i = 0; i < 10; i++) {
    const pick = chooseDiscard(hand, [], {
      difficulty: 'zen',
      opponentKnownCards: known,
      visibleCards: known,
    });
    assert.notEqual(pick.rank, '10', `must not feed the ten collector (picked ${pick.rank}${pick.suit})`);
  }
});

// --- v1.31.0: turn timer house rule --------------------------------------------
test('turn timer: deadline armed for humans, expiry auto-finishes the turn once', () => {
  const { game } = makeGame(2);
  game.setHouseRules({ turnTimerSeconds: 60 });
  game.startNewRound();
  // FLAKE FIX: with a random initial dealer the cutter can be a human, which
  // leaves the round in the 'cutting' phase - the simulated timeout then has
  // no turn to finish and the turn never passes on (seen as a rare red CI).
  if (game.phase === 'cutting') game.performCut(game.cutterId, 0.5);
  // Force a HUMAN to be the current player
  game.currentPlayerIndex = game.players.findIndex((p) => p.id === 'p1');
  game.turnPhase = 'draw';
  game._armTurnTimer();
  assert.ok(game.turnDeadline > Date.now(), 'deadline exposed for the client countdown');
  assert.equal(typeof game.publicState('p1').turnDeadline, 'number');

  const handBefore = game.players.find((p) => p.id === 'p1').hand.length;
  game._onTurnTimeout('p1'); // simulate expiry (no real waiting in tests)
  assert.ok(game.log.some((e) => e.text.startsWith('⏰ Zeit abgelaufen')), 'transparent log line');
  assert.notEqual(game.currentPlayer().id, 'p1', 'turn was finished and passed on');

  // Invalid values are rejected by the whitelist
  game.setHouseRules({ turnTimerSeconds: 45 });
  assert.notEqual(game.houseRules.turnTimerSeconds, 45);
  game.destroy();
});

// --- v1.33.0: daily challenge -----------------------------------------------
test('daily challenge: identical seed deals identical hands, different days differ', () => {
  const { seedForDate } = require('../game/ChallengeStore');
  const seed = seedForDate('2026-07-04');
  const mk = () => {
    const g = __autoCutHook(new GameManager(() => {}, { deckSeed: seed }));
    g.addOrReconnectPlayer('p1', 'Anna');
    g.fillWithBots();
    g.startNewRound();
    const hand = g.players.find((p) => p.id === 'p1').hand.map((c) => c.id).join(',');
    g.destroy();
    return hand;
  };
  assert.equal(mk(), mk(), 'same seed = same deal for everyone');
  const g2 = __autoCutHook(new GameManager(() => {}, { deckSeed: seedForDate('2026-07-05') }));
  g2.addOrReconnectPlayer('p1', 'Anna');
  g2.fillWithBots();
  g2.startNewRound();
  const other = g2.players.find((p) => p.id === 'p1').hand.map((c) => c.id).join(',');
  g2.destroy();
  assert.notEqual(mk(), other, 'a new day deals a new deck');
});

test('challenge store: best score per name, ranked board, 7-day cleanup', () => {
  const { createChallengeStore } = require('../game/ChallengeStore');
  const file = require('path').join(require('os').tmpdir(), `pikdame-chal-${Date.now()}.json`);
  const store = createChallengeStore(file);
  // Dates must be RELATIVE to today: the 7-day retention is measured against the
  // current date, so hard-coded days silently expire and made this test a time
  // bomb (it started failing once the fixed date fell out of the window).
  const dayStr = (offsetDays) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - offsetDays);
    return d.toISOString().slice(0, 10);
  };
  const today = dayStr(0);
  const longAgo = dayStr(40); // safely outside the 7-day window
  store.submit(today, 'Anna', 480);
  store.submit(today, 'anna', 350); // worse + case-insensitive: ignored
  store.submit(today, 'Ben', 620);
  const board = store.getBoard(today);
  assert.equal(board[0].name, 'Ben');
  assert.equal(board[1].score, 480, 'best score kept, worse retry ignored');
  assert.equal(store.rankOf(today, 'ANNA'), 2);
  // Old day vanishes on the next submit (7-day retention)
  store.submit(longAgo, 'Old', 100);
  store.submit(today, 'Cleo', 10);
  assert.deepEqual(store.getBoard(longAgo), [], 'entries older than 7 days are dropped');
  try { require('fs').unlinkSync(file); } catch (e) { /* lazy write */ }
});

// --- v1.33.2: turn timer vs. takeover grace -----------------------------------
test('turn timer never fires for a disconnected human (grace owns the seat)', () => {
  const { game } = makeGame(2);
  game.setHouseRules({ turnTimerSeconds: 30 });
  game.startNewRound();
  game.currentPlayerIndex = game.players.findIndex((p) => p.id === 'p1');
  game.turnPhase = 'draw';
  game._armTurnTimer();
  assert.ok(game.turnDeadline, 'connected human gets a countdown');

  game.markDisconnected('p1');
  game._armTurnTimer();
  assert.equal(game.turnDeadline, null, 'no countdown for a grace-protected seat');

  // A stale timeout from before the disconnect is a no-op
  const logLen = game.log.length;
  game._onTurnTimeout('p1');
  assert.equal(game.log.length, logLen, 'stale timeout must not auto-play the turn');
  assert.equal(game.currentPlayer().id, 'p1', 'seat untouched');

  // Reconnect re-arms a FRESH full countdown
  game.addOrReconnectPlayer('p1', 'Anna');
  // Threshold is generous on purpose: CI runners can stall several seconds
  // between arming (30s) and asserting - 15s still proves a FRESH deadline
  // (the disconnect had nulled it entirely).
  assert.ok(game.turnDeadline > Date.now() + 15 * 1000, 'fresh countdown after reconnect');
  game.destroy();
});

// --- v1.37.1: hand-aus definition + bot melds after pile pickup -----------------
test('hand aus: whole hand down in ONE later turn doubles; earlier meld does not', () => {
  const { makeStandardCard: mk } = require('../game/Card');
  const build = (winnerLaidEarlier) => {
    const g = __autoCutHook(new GameManager(() => {}));
    g.addOrReconnectPlayer('p1', 'A');
    g.addOrReconnectPlayer('p2', 'B');
    g.setHouseRules({ handAusDoubles: true });
    g.startNewRound();
    // simulate a few completed turns so we are far from turn 0
    g.currentPlayerIndex = g.players.findIndex((p) => p.id === 'p2');
    g.advanceTurn(); // -> p1's turn, snapshot taken with current flags
    const p1 = g.players.find((p) => p.id === 'p1');
    if (winnerLaidEarlier) {
      p1._everLaidThisRound = true; // laid a set in an earlier turn
      g.advanceTurn(); g.currentPlayerIndex = g.players.findIndex((p) => p.id === 'p1');
      g.advanceTurn(); // fresh snapshot now sees the earlier meld
      while (g.currentPlayer().id !== 'p1') g.advanceTurn();
    }
    g.turnPhase = 'meld';
    p1.hand = [mk('H', '5', 0), mk('S', '5', 0), mk('C', '5', 1), mk('D', '9', 0)];
    p1.laidOutCards = winnerLaidEarlier ? [mk('H', 'A', 0)] : [];
    const meld = g.layoutMeld('p1', p1.hand.slice(0, 3).map((cd) => cd.id));
    assert.equal(meld.error, undefined);
    g.discard('p1', p1.hand[0].id);
    return g;
  };
  const handAus = build(false);
  assert.equal(handAus.lastRoundWasHandAus, true, 'first-and-only meld turn = hand aus');
  assert.equal(handAus.lastRoundResult.p1.breakdown.multiplier, 2, 'doubling applied');
  handAus.destroy();
  const normal = build(true);
  assert.equal(normal.lastRoundWasHandAus, false, 'earlier meld disqualifies');
  normal.destroy();
});

test('bot melds cards that arrive with the pile REST in the same turn (three aces)', () => {
  const { makeStandardCard: mk } = require('../game/Card');
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.setHouseRules({ botDifficulty: 'medium' });
  g.fillWithBots();
  g.phase = 'playing'; g.turnPhase = 'draw';
  const botIdx = g.players.findIndex((p) => p.isBot);
  g.currentPlayerIndex = botIdx;
  const bot = g.players[botIdx];
  bot.hand = [mk('H', '7', 0), mk('D', '7', 0), mk('S', '2', 0), mk('C', '9', 1)];
  g.drawPile = [mk('C', '3', 0)];
  // top seven forces the meld; the REST carries three aces
  g.discardPile = [mk('S', '7', 0), mk('C', 'A', 0), mk('D', 'A', 0), mk('H', 'A', 0), mk('S', '10', 1)];
  g.runBotTurn(bot.id);
  const aceMeld = g.tableMelds.find(
    (m) => m.ownerId === bot.id && m.slots.some((s) => s.real && s.real.rank === 'A')
  );
  assert.ok(aceMeld, 'aces from the pickup must hit the table in the SAME turn');
  assert.ok(!bot.hand.some((cd) => cd.rank === 'A'), 'no ace left on the hand');
  g.destroy();
});

// --- v1.39.0: lobby ready check + canonical meld order ---------------------------
test('lobby ready gate: 2+ humans must all confirm; solo and rematch flows covered', () => {
  const { game } = makeGame(2);
  // two humans, nobody ready -> blocked
  assert.match(game.lobbyStartGate().error || '', /1\/2|0\/2/);
  game.markLobbyReady('p1');
  assert.match(game.lobbyStartGate().error, /1\/2/);
  game.markLobbyReady('p2');
  assert.equal(game.lobbyStartGate().error, undefined, 'all ready -> gate open');
  // toggle back off blocks again
  game.markLobbyReady('p2');
  assert.match(game.lobbyStartGate().error, /1\/2/);
  game.markLobbyReady('p2');
  game.startNewRound();
  assert.equal(game.phase, 'playing');
  // rematch resets readiness - everyone confirms afresh
  game.phase = 'gameOver';
  game.prepareRematch();
  assert.equal(game.phase, 'lobby');
  assert.match(game.lobbyStartGate().error, /0\/2/, 'rematch requires fresh readiness');
  game.destroy();
});

test('lobby ready gate: a single human starts without any ceremony', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'Solo');
  assert.equal(g.lobbyStartGate().error, undefined);
  g.destroy();
});

test('table melds sort canonically: by leading rank, sets before runs, stable', () => {
  const { makeStandardCard: mk } = require('../game/Card');
  const { game } = makeGame(1);
  game.phase = 'playing';
  game.turnPhase = 'meld';
  game.currentPlayerIndex = 0;
  const p1 = game.players[0];
  p1.hand = [
    mk('C', 'K', 0), mk('H', 'K', 0), mk('S', 'K', 0),
    mk('C', '3', 0), mk('H', '3', 0), mk('S', '3', 0),
    mk('D', '5', 0), mk('D', '6', 0), mk('D', '7', 1),
    mk('H', '9', 0),
  ];
  assert.equal(game.layoutMeld('p1', p1.hand.slice(0, 3).map((c) => c.id)).error, undefined); // K set first
  assert.equal(game.layoutMeld('p1', p1.hand.slice(0, 3).map((c) => c.id)).error, undefined); // 3 set
  assert.equal(game.layoutMeld('p1', p1.hand.slice(0, 3).map((c) => c.id)).error, undefined); // 5-6-7 run
  game.broadcastState(); // canonical sort happens here
  const leads = game.tableMelds.map((m) =>
    m.type === 'set' ? `set-${m.rank}` : `run-${m.slots[0].real.rank}`
  );
  assert.deepEqual(leads, ['set-3', 'run-5', 'set-K'], `got ${leads.join(',')}`);
  game.destroy();
});

// --- v1.45.1: external-control fields cannot be smuggled in (anti-cheat) ---------
test('deserialize strips forced*/external*/mcts* control fields from all seats', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  // a tampered snapshot trying to inject control fields onto seats + game
  const tampered = {
    phase: 'playing',
    players: [
      { id: 'p1', name: 'A', isBot: false, connected: true, hand: [], laidOutCards: [],
        forcedDrawSource: 'discardPile', externalDiscard: 'pause', mctsEnabled: true },
      { id: 'b1', name: 'B', isBot: true, connected: true, hand: [], laidOutCards: [],
        mctsForceOff: true, mcEnabled: true },
    ],
    _agentAwaitingDiscard: { botId: 'p1', legalIds: ['x'] },
    _noMcts: true,
    totals: { p1: 0, b1: 0 },
  };
  g.deserialize(tampered);
  for (const p of g.players) {
    assert.equal(p.forcedDrawSource, undefined);
    assert.equal(p.externalDiscard, undefined);
    assert.equal(p.mctsEnabled, undefined);
    assert.equal(p.mctsForceOff, undefined);
    assert.equal(p.mcEnabled, undefined);
  }
  assert.equal(g._agentAwaitingDiscard, null);
  assert.equal(g._noMcts, false);
  g.destroy();
});

test('serialize never persists external-control fields', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('p1', 'A');
  g.fillWithBots();
  // set control fields as the training/inference code would
  g.players[0].externalDiscard = 'pause';
  g.players[0].forcedDrawSource = 'discardPile';
  const bot = g.players.find((p) => p.isBot);
  if (bot) bot.mctsEnabled = true;
  g._noMcts = true;
  const snap = g.serialize();
  for (const p of snap.players) {
    assert.equal(p.forcedDrawSource, undefined);
    assert.equal(p.externalDiscard, undefined);
    assert.equal(p.mctsEnabled, undefined);
  }
  assert.equal('_noMcts' in snap, false);
  assert.equal('_agentAwaitingDiscard' in snap, false);
  g.destroy();
});

// --- v1.48: lobby shows/sorts bots; joining replaces a bot -------------------
test('lobby tops up empty seats with bots so they are visible and sortable', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.maxSeats = 4;
  g.addOrReconnectPlayer('h1', 'Anna');
  g.syncLobbyBots();
  assert.equal(g.players.length, 4, 'table shows all seats');
  assert.equal(g.players.filter((p) => p.isBot).length, 3, 'three bot seats');
  const ids = g.players.map((p) => p.id);
  assert.equal(ids.length, new Set(ids).size, 'no duplicate seat ids');
});

test('a joining human replaces a bot in place (order preserved), not appended', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.maxSeats = 4;
  g.addOrReconnectPlayer('h1', 'Anna');
  g.syncLobbyBots();
  const beforeBotSeat = g.players.findIndex((p) => p.isBot); // first bot index
  g.addOrReconnectPlayer('h2', 'Ben');
  g.syncLobbyBots();
  assert.equal(g.players.length, 4, 'still exactly maxSeats seats');
  assert.equal(g.players.filter((p) => !p.isBot).length, 2, 'two humans now');
  assert.equal(g.players[beforeBotSeat].id, 'h2', 'human took the bot seat position');
});

test('table is full only when maxSeats HUMANS have joined', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.maxSeats = 2;
  assert.ok(g.addOrReconnectPlayer('h1', 'A'));
  g.syncLobbyBots();
  assert.ok(g.addOrReconnectPlayer('h2', 'B'), 'second human replaces the bot');
  g.syncLobbyBots();
  assert.equal(g.addOrReconnectPlayer('h3', 'C'), null, 'third human rejected - table full');
});

test('lowering maxSeats trims bots but keeps the humans', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.maxSeats = 4;
  g.addOrReconnectPlayer('h1', 'Anna');
  g.addOrReconnectPlayer('h2', 'Ben');
  g.syncLobbyBots();
  assert.equal(g.setMaxSeats(2).ok, true);
  assert.equal(g.players.length, 2);
  assert.equal(g.players.filter((p) => !p.isBot).length, 2, 'both humans kept');
});

// --- v1.48.1: richer situational bot reactions ------------------------------
test('a dragging round (many turns without a meld) makes a bot yawn', () => {
  const emotes = [];
  const g = __autoCutHook(new GameManager(() => {}, { onBotEmote: (id, e) => emotes.push(e) }));
  g._emoteDelayForTest = 0;
  g.addOrReconnectPlayer('h', 'H');
  g.maxSeats = 4;
  g.fillWithBots();
  g.phase = 'playing';
  g.players.forEach((p) => { if (p.isBot) g._lastBotEmote[p.id] = 0; });
  const rnd = Math.random;
  Math.random = () => 0.1; // pass the chance gate + deterministic bot pick
  g._turnsWithoutMeld = 23;
  g.advanceTurn(); // crosses 24 -> yawn
  Math.random = rnd;
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.ok(emotes.includes('😴'), 'a bot yawned on the dragging round');
      g.destroy();
      resolve();
    }, 20);
  });
});

// --- v1.49: only the organizer (host) may change lobby settings -------------
test('the first human to join is the host; later joiners are not', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.maxSeats = 4;
  g.addOrReconnectPlayer('h1', 'Anna');
  g.syncLobbyBots();
  g.addOrReconnectPlayer('h2', 'Ben');
  assert.equal(g.isHost('h1'), true, 'first human is host');
  assert.equal(g.isHost('h2'), false, 'second human is not host');
  assert.equal(g.isHost('bot-1'), false, 'a bot is never host');
  const st = g.publicState('h2');
  assert.equal(st.hostId, 'h1');
  assert.equal(st.isHost, false, 'publicState.isHost reflects the recipient');
  assert.equal(g.publicState('h1').isHost, true);
});

test('host role falls back to a connected human if the host disconnects', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.maxSeats = 4;
  g.addOrReconnectPlayer('h1', 'Anna');
  g.addOrReconnectPlayer('h2', 'Ben');
  assert.equal(g.effectiveHostId(), 'h1');
  g.markDisconnected('h1');
  assert.equal(g.effectiveHostId(), 'h2', 'a connected human takes over settings');
  assert.equal(g.isHost('h2'), true);
  g.addOrReconnectPlayer('h1', 'Anna'); // reconnect
  assert.equal(g.effectiveHostId(), 'h1', 'original host reclaims on reconnect');
});

// --- v1.49.1: auto-end a deadlocked round; ready gate counts seated humans ---
test('a deadlocked round (no draw, cannot take the single discard) ends itself', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('a', 'A');
  g.addOrReconnectPlayer('b', 'B');
  g.maxSeats = 2;
  g.phase = 'playing';
  g.roundNumber = 1;
  g.currentPlayerIndex = 0;
  g.turnPhase = 'meld';
  g.players[0].hand = [makeStandardCard('H', 'K', 0)];
  g.players[1].hand = [makeStandardCard('D', '3', 0)];
  g.players.forEach((p) => { p.laidOutCards = []; });
  g.tableMelds = [];
  g.drawPile = [];
  g.discardPile = [makeStandardCard('S', '2', 0)]; // empty draw + a single unusable discard
  g.advanceTurn(); // B cannot draw and cannot take the 2 of spades
  assert.ok(g.phase === 'roundEnd' || g.phase === 'gameOver', 'round ended automatically');
  assert.equal(g.totals.a, -10, 'K on hand counts negative as usual');
  assert.equal(g.totals.b, -5, 'the 3 on hand counts negative');
});

test('start gate counts seated humans; a minimised player still blocks the start', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('h1', 'Anna');
  g.addOrReconnectPlayer('h2', 'Ben');
  g.maxSeats = 2;
  g.phase = 'lobby';
  g.markLobbyReady('h1'); // only Anna ready
  assert.match(g.lobbyStartGate().error, /1\/2/, 'blocked while Ben is not ready');
  g.markDisconnected('h2'); // Ben minimises -> disconnect
  assert.match(g.lobbyStartGate().error, /1\/2/, 'still blocked - Ben counts even while away');
  assert.equal(g._lobbyReady.has('h2'), false, 'disconnect clears the ready flag');
});

// --- v1.52.0: per-bot difficulty in the lobby (no global setting) -----------
test('bots default to Zen and are configured PER bot in the lobby', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.maxSeats = 4;
  g.addOrReconnectPlayer('h', 'Host');
  g.syncLobbyBots();
  const bots = g.players.filter((p) => p.isBot);
  assert.ok(bots.every((b) => b.botDifficulty === 'zen'), 'every bot defaults to Zen');
  // setting one bot does not touch the others (per-bot, in the lobby)
  assert.equal(g.setBotDifficulty('h', bots[0].id, 'easy').ok, true);
  assert.equal(g.players.find((p) => p.id === bots[0].id).botDifficulty, 'easy');
  assert.ok(bots.slice(1).every((b) => g.players.find((p) => p.id === b.id).botDifficulty === 'zen'), 'others unchanged');
  // botDifficulty is no longer a house rule
  assert.equal(g.houseRules.botDifficulty, undefined);
});

test('in-game pause needs unanimous consent and freezes turn actions', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('a', 'A');
  g.addOrReconnectPlayer('b', 'B');
  g.maxSeats = 2;
  g.fillWithBots();
  g.phase = 'playing';
  g.currentPlayerIndex = 0;
  g.turnPhase = 'draw';
  assert.equal(g.togglePauseVote('a').ok, true);
  assert.ok(!g.paused, 'one vote does not pause');
  assert.equal(g.publicState('a').pauseVotes.length, 1);
  g.togglePauseVote('b');
  assert.equal(g.paused, true, 'unanimous -> paused');
  assert.match(g.assertTurn('a', 'draw').error, /pausiert/, 'actions frozen while paused');
  // resume also needs everyone
  g.togglePauseVote('a');
  assert.equal(g.paused, true, 'still paused with one resume vote');
  g.togglePauseVote('b');
  assert.equal(g.paused, false, 'unanimous resume');
  assert.equal(g.publicState('a').paused, false);
});

test('a disconnect must not keep the table paused-blocked', () => {
  const g = __autoCutHook(new GameManager(() => {}));
  g.addOrReconnectPlayer('a', 'A');
  g.addOrReconnectPlayer('b', 'B');
  g.maxSeats = 2;
  g.fillWithBots();
  g.phase = 'playing';
  g.togglePauseVote('a'); // A wants to pause
  g.markDisconnected('b'); // B leaves -> only A remains, A already voted -> pauses
  assert.equal(g.paused, true, 'remaining humans all agree -> pause resolves');
});

// --- v1.53: a bot must lay a taken discard card (no rule break) -------------
test('a bot never takes the discard unless it will actually lay that card', () => {
  const orig = GameManager.prototype.drawFromDiscard;
  let takes = 0;
  let violations = 0;
  let pending = null;
  GameManager.prototype.drawFromDiscard = function patched(id) {
    const top = this.discardPile[0];
    const r = orig.call(this, id);
    if (r && !r.error) { pending = { botId: id, cardId: top && top.id }; takes += 1; }
    return r;
  };
  try {
    for (let i = 0; i < 25; i++) {
      const g = __autoCutHook(new GameManager(() => {}));
      g.addOrReconnectPlayer('x', 'X');
      g.maxSeats = 4;
      g.players = ['zen', 'medium', 'zen', 'easy'].map((d, k) => ({
        id: `b${k}`, name: `B${k}`, isBot: true, hand: [], connected: true, laidOutCards: [], botDifficulty: d,
      }));
      g.startNewRound();
      let s = 0;
      while (g.phase !== 'gameOver' && s < 3000) {
        if (g.phase === 'playing') {
          const bot = g.currentPlayer();
          pending = null;
          g.runBotTurn(bot.id);
          if (pending && pending.cardId) {
            const b = g.players.find((p) => p.id === pending.botId);
            if (b && b.hand.some((c) => c.id === pending.cardId)) violations += 1;
          }
        } else if (g.phase === 'roundEnd') g.startNewRound();
        else break;
        s += 1;
      }
      g.destroy();
    }
  } finally {
    GameManager.prototype.drawFromDiscard = orig;
  }
  assert.ok(takes > 100, `sanity: bots did take the pile (${takes} times)`);
  assert.equal(violations, 0, 'a taken discard card is always laid this turn');
});

// --- v1.53.2: no Pik-Dame emote from bots with fewer than 3 cards ------------
test('a bot with fewer than 3 cards does not use the Pik-Dame emote', async () => {
  let smallEmoted = 0;
  let bigEmoted = 0;
  for (let trial = 0; trial < 200; trial++) {
    const g = __autoCutHook(new GameManager(() => {}));
    const seen = new Set();
    g.onBotEmote = (id) => seen.add(id);
    g._emoteDelayForTest = 0;
    g.addOrReconnectPlayer('h', 'M');
    g.maxSeats = 4;
    g.fillWithBots();
    const bots = g.players.filter((p) => p.isBot);
    bots[0].hand = [1, 2, 3, 4, 5].map((i) => ({ id: `a${trial}_${i}` })); // 5 cards (celebrant)
    bots[1].hand = [{ id: `x${trial}` }, { id: `y${trial}` }]; // 2 cards (must stay quiet)
    g._celebratePikDame(bots[0].id);
    await new Promise((r) => setTimeout(r, 1));
    if (seen.has(bots[1].id)) smallEmoted += 1;
    if (seen.has(bots[0].id)) bigEmoted += 1;
    g.destroy();
  }
  assert.equal(smallEmoted, 0, 'a bot with 2 cards never emits the Pik-Dame emote');
  assert.ok(bigEmoted > 0, 'a bot with >= 3 cards still emotes at the normal rate');
});

// --- v1.70: Ablagestapel-Aufnahme zurücknehmen ---------------------------------
test('undoPileTake: puts the top card back, resets duty + memory, allows a fresh draw', () => {
  const { game: g } = makeGame(2);
  g.startNewRound();
  g.turnPhase = 'draw';
  const me = g.currentPlayer();
  const { makeStandardCard } = require('../game/Card');
  // Konstruierte Lage: oberste Ablagekarte passt sicher (Drilling)
  const c1 = makeStandardCard('H', '9', 900);
  const c2 = makeStandardCard('S', '9', 901);
  const top = makeStandardCard('D', '9', 902);
  me.hand.push(c1, c2);
  g.discardPile.unshift(top);
  const pileBefore = g.discardPile.map((c) => c.id).join(',');

  const r = g.drawFromDiscard(me.id);
  assert.equal(r.ok, true);
  assert.equal(g.publicState(me.id).canUndoPileTake, true, 'undo offered to me');
  assert.equal(g.publicState(g.players.find((p) => p.id !== me.id).id).canUndoPileTake, false);

  const u = g.undoPileTake(me.id);
  assert.equal(u.ok, true);
  assert.equal(g.turnPhase, 'draw', 'back to drawing');
  assert.equal(g.mustLayOffCardId, null);
  assert.equal(g.pendingDiscardRest, false);
  assert.equal(g.discardPile.map((c) => c.id).join(','), pileBefore, 'pile exactly restored');
  assert.ok(!me.hand.some((c) => c.id === top.id), 'card left the hand');
  assert.ok(!(g.publicKnownHands[me.id] || []).some((c) => c.id === top.id), 'public memory reverted');
  // und neu ziehen geht
  const d = g.drawFromPile(me.id);
  assert.equal(d.ok, true);
  g.destroy();
});

test('undoPileTake: rejected once the mandatory card has been played (phase 2)', () => {
  const { game: g } = makeGame(2);
  g.startNewRound();
  g.turnPhase = 'draw';
  const me = g.currentPlayer();
  const { makeStandardCard } = require('../game/Card');
  const c1 = makeStandardCard('H', '9', 910);
  const c2 = makeStandardCard('S', '9', 911);
  const top = makeStandardCard('D', '9', 912);
  me.hand.push(c1, c2);
  g.discardPile.unshift(top);
  g.drawFromDiscard(me.id);
  const m = g.layoutMeld(me.id, [c1.id, c2.id, top.id]);
  assert.equal(m.ok, true, 'mandatory card played');
  const u = g.undoPileTake(me.id);
  assert.ok(u.error, 'no take-back after playing');
  assert.equal(g.publicState(me.id).canUndoPileTake, false);
  g.destroy();
});

test('undoPileTake: rejected for the wrong player and outside the window', () => {
  const { game: g } = makeGame(2);
  g.startNewRound();
  g.turnPhase = 'draw';
  const me = g.currentPlayer();
  const other = g.players.find((p) => p.id !== me.id);
  assert.ok(g.undoPileTake(me.id).error, 'nothing to undo yet');
  const { makeStandardCard } = require('../game/Card');
  me.hand.push(makeStandardCard('H', '7', 920), makeStandardCard('S', '7', 921));
  g.discardPile.unshift(makeStandardCard('D', '7', 922));
  g.drawFromDiscard(me.id);
  assert.ok(g.undoPileTake(other.id).error, 'not your turn');
  g.destroy();
});

// --- v1.73: Rundenende statt Ablage-Recycling (Screenshot-Bug) ------------------
test('empty pile + unusable discard top ends the round with normal scoring (regression: player was stuck)', () => {
  const { game: g } = makeGame(2);
  g.startNewRound();
  const me = g.currentPlayer();
  const { makeStandardCard } = require('../game/Card');
  // Exakt die Screenshot-Lage: Stapel leer, Packen aufgebraucht, volle
  // Ablage, oberste Karte für den Spieler unbrauchbar.
  g.turnPhase = 'draw';
  g.drawPile.length = 0;
  g.discardPile.unshift(makeStandardCard('C', 'K', 990)); // passt zu nichts Konstruiertem
  me.hand = [makeStandardCard('D', '10', 991), makeStandardCard('H', '10', 992), makeStandardCard('H', 'K', 993)];
  me.laidOutCards = [
    makeStandardCard('C', '8', 994), makeStandardCard('S', '8', 995), makeStandardCard('H', '8', 996),
  ];
  assert.ok(g.discardPile.length > 1 || g.discardPile.length === 1, 'discard pile present');

  const r = g.drawFromPile(me.id);
  assert.equal(r.roundEnded, true, 'the round ends instead of trapping the player');
  assert.equal(g.phase, 'roundEnd');
  // Wertung: Auslagen plus, Hand minus, kein Gewinner-Bonus.
  const mine = g.lastRoundResult[me.id];
  assert.equal(mine.breakdown.laidOutValue, 15, 'laid-out cards count plus (three 8s at 5 points each)');
  assert.equal(mine.roundScore, mine.breakdown.laidOutValue - mine.breakdown.handValue,
    'score = laid out minus hand');
  assert.ok(mine.breakdown.handValue > 0, 'hand cards were counted against the player');
  assert.equal(g.lastRoundWinnerId, null, 'no winner, no bonus');
  g.destroy();
});

test('empty pile but usable discard top: NO round end - the pickup is the move', () => {
  const { game: g } = makeGame(2);
  g.startNewRound();
  const me = g.currentPlayer();
  const { makeStandardCard } = require('../game/Card');
  g.turnPhase = 'draw';
  g.drawPile.length = 0;
  const top = makeStandardCard('D', '9', 980);
  g.discardPile.unshift(top);
  me.hand = [makeStandardCard('H', '9', 981), makeStandardCard('S', '9', 982)];

  const r = g.drawFromPile(me.id);
  assert.ok(r.error, 'draw refused with a pointer to the discard pickup');
  assert.equal(g.phase, 'playing', 'round continues');
  const p = g.drawFromDiscard(me.id);
  assert.equal(p.ok, true, 'the pickup works');
  g.destroy();
});

test('turn-change auto-end fires even with a BIG discard pile (the old check treated it as reshufflable)', () => {
  const { game: g } = makeGame(2);
  g.startNewRound();
  const { makeStandardCard } = require('../game/Card');
  g.drawPile.length = 0;
  // grosse Ablage - früher hiess das fälschlich "reshuffle still possible"
  g.discardPile = [makeStandardCard('C', 'K', 970)];
  for (let i = 0; i < 15; i++) g.discardPile.push(makeStandardCard('D', '4', 971 + i));
  for (const p of g.players) p.hand = [makeStandardCard('H', '2', 960 + g.players.indexOf(p))];
  assert.equal(g._roundIsDeadlocked(), true, 'deadlock recognised despite 16 discard cards');
  g.destroy();
});

// --- v1.75.1: Pause-Button (Regression: Felder fehlten im publicState) ----------
test('pause: votes and paused flag are visible in publicState; solo human pauses instantly', () => {
  const { game: g } = makeGame(1); // 1 Mensch + Bots
  g.fillWithBots();
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  const human = g.players.find((p) => !p.isBot);
  const r = g.togglePauseVote(human.id);
  assert.equal(r.ok, true);
  let st = g.publicState(human.id);
  assert.equal(st.paused, true, 'single human => instant pause, visible to the client');
  assert.deepEqual(st.pauseVotes, [], 'votes reset after the toggle');
  // Züge sind blockiert, der Client kann das jetzt auch ERKLÄREN
  g.turnPhase = 'draw';
  const mv = g.drawFromPile(g.currentPlayer().id);
  assert.ok(mv.error && /pausiert/.test(mv.error));
  // Fortsetzen
  g.togglePauseVote(human.id);
  st = g.publicState(human.id);
  assert.equal(st.paused, false);
  g.destroy();
});

test('pause: with two humans the first vote shows up in pauseVotes and does NOT pause yet', () => {
  const { game: g } = makeGame(2);
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  const [h1, h2] = g.players.filter((p) => !p.isBot);
  g.togglePauseVote(h1.id);
  let st = g.publicState(h2.id);
  assert.equal(st.paused, false, 'one of two votes: not paused');
  assert.deepEqual(st.pauseVotes, [h1.id], 'the vote is visible (button badge, 1/2 counter)');
  g.togglePauseVote(h2.id);
  st = g.publicState(h2.id);
  assert.equal(st.paused, true, 'second vote pauses');
  g.destroy();
});

// --- v1.77.1: Lobby verlassen (Regression: kein Rückweg ins Hauptmenü) -----------
test('leaveLobby frees the seat, cleans ready gate and re-syncs bots; blocked mid-game', () => {
  const { game: g } = makeGame(2);
  const [h1, h2] = g.players.filter((p) => !p.isBot);
  g.setMaxSeats ? g.setMaxSeats(3) : null;
  const before = g.players.length;
  const r = g.leaveLobby(h2.id);
  assert.equal(r.ok, true);
  assert.ok(!g.players.some((p) => p.id === h2.id), 'seat freed');
  assert.ok(g.players.length >= before - 1, 'bots re-synced to fill the table');
  assert.ok(g.isHost(h1.id), 'remaining human is (still) host');
  // im laufenden Spiel gesperrt
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  const r2 = g.leaveLobby(h1.id);
  assert.ok(r2.error && /Lobby/.test(r2.error), 'mid-game leaving is refused');
  g.destroy();
});

// --- v1.78.2: Challenge-Verlauf ('7 Tage sichtbar' wörtlich genommen) -----------
test('challenge history lists past days with winner and own rank; empty past days skipped', () => {
  const os = require('node:os');
  const path = require('node:path');
  const { createChallengeStore, todayUTC } = require('../game/ChallengeStore');
  const store = createChallengeStore(path.join(os.tmpdir(), `ch-${Date.now()}.json`));
  const now = Date.now();
  const d0 = todayUTC(now), d1 = todayUTC(now - 86400000), d3 = todayUTC(now - 3 * 86400000);
  store.submit(d3, 'Flo', 500, now - 3 * 86400000);
  store.submit(d3, 'Anna', 800, now - 3 * 86400000);
  store.submit(d1, 'Flo', 650, now - 86400000);
  store.submit(d0, 'Flo', 700, now);
  const h = store.getHistory('Flo', 3, now);
  assert.equal(h[0].date, d0, 'today first');
  const day1 = h.find((d) => d.date === d1);
  const day3 = h.find((d) => d.date === d3);
  assert.ok(day1 && day3, 'past days with entries are listed');
  assert.equal(day3.top[0].name, 'Anna', 'daily winner shown');
  assert.equal(day3.yourRank, 2, 'own rank per day');
  assert.equal(day1.yourScore, 650);
  // Tage ohne Einträge (z. B. vorgestern) erscheinen nicht
  assert.ok(!h.some((d) => d.players === 0 && d.date !== d0), 'empty past days skipped');
});

// --- v1.80.0: Soziale Bots (Antworten auf menschliche Emotes) --------------------
test('a human emote gets at most ONE bot reply; bots and cooldown stay silent', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const { game: g } = makeGame(2);
  const human = g.players.find((p) => !p.isBot);
  g.fillWithBots();
  g._emoteDelayForTest = 0;
  const sent = [];
  g.onBotEmote = (botId, emoji) => sent.push({ botId, emoji });
  const withForcedRoll = (fn) => { const r = Math.random; Math.random = () => 0.01; try { fn(); } finally { Math.random = r; } };
  withForcedRoll(() => g.respondToHumanEmote(human.id, '🎉'));
  await tick();
  assert.equal(sent.length, 1, 'exactly one bot replied');
  assert.ok(['🎉', '👍'].includes(sent[0].emoji), 'reply from the 🎉 mapping');
  // Tisch-Cooldown: direkt danach bleibt es still
  withForcedRoll(() => g.respondToHumanEmote(human.id, '👍'));
  await tick();
  assert.equal(sent.length, 1, 'table-wide reply cooldown holds');
  // Bots lösen niemals Antworten aus (keine Kaskaden)
  g._lastEmoteReplyAt = 0;
  const bot = g.players.find((p) => p.isBot);
  withForcedRoll(() => g.respondToHumanEmote(bot.id, '🎉'));
  await tick();
  assert.equal(sent.length, 1, 'bot senders never trigger replies');
  g.destroy();
});

test('hourglass while a bot is to move pokes exactly that bot', async () => {
  const { game: g } = makeGame(1);
  const human = g.players.find((p) => !p.isBot);
  g.fillWithBots();
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  // Zug an einen Bot geben
  while (g.phase === 'playing' && !g.currentPlayer().isBot) g.runBotTurn ? g.currentPlayerIndex++ : null;
  if (g.phase !== 'playing' || !g.currentPlayer().isBot) { g.destroy(); return; }
  const rushed = g.currentPlayer().id;
  g._emoteDelayForTest = 0;
  g._lastEmoteReplyAt = 0;
  const sent = [];
  g.onBotEmote = (botId, emoji) => sent.push({ botId, emoji });
  const r = Math.random; Math.random = () => 0.01;
  try { g.respondToHumanEmote(human.id, '⏳'); } finally { Math.random = r; }
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].botId, rushed, 'the bot being rushed answers itself');
  assert.ok(['😤', '⏳'].includes(sent[0].emoji));
  g.destroy();
});

// --- v1.81.0: Wochenwertung (beste 5 Tage, Mo-So UTC) -----------------------------
test('weekly challenge board sums the best 5 daily scores of the current week', () => {
  const os = require('node:os');
  const path = require('node:path');
  const { createChallengeStore, todayUTC } = require('../game/ChallengeStore');
  const store = createChallengeStore(path.join(os.tmpdir(), `wk-${Date.now()}.json`));
  // "now" = ein Sonntag, damit alle 7 Wochentage in der Woche liegen
  const sunday = Date.UTC(2026, 6, 19, 12); // 2026-07-19 ist ein Sonntag
  for (let i = 0; i < 7; i++) {
    const t = sunday - i * 86400000;
    store.submit(todayUTC(t), 'Flo', 100 + i * 10, t); // 100..160 über Mo..So
  }
  store.submit(todayUTC(sunday), 'Anna', 500, sunday); // 1 Tag, hoher Score
  const w = store.getWeekly('Flo', 5, sunday);
  // Flo: beste 5 von {100..160} = 160+150+140+130+120 = 700
  assert.equal(w.top[0].name, 'Flo');
  assert.equal(w.top[0].weekScore, 700, 'best 5 of 7 days count');
  assert.equal(w.top[0].days, 7);
  assert.equal(w.top[1].name, 'Anna');
  assert.equal(w.top[1].weekScore, 500, 'a single big day does not beat a steady week');
  assert.equal(w.yourRank, 1);
});

// --- v1.81.0: Schlüsselmomente ----------------------------------------------------
test('match highlights pick caught queen, hand-aus and best round, ordered by round', () => {
  const { game: g } = makeGame(2);
  const [a, b] = g.players;
  g.roundHistory = [
    { round: 1, results: { [a.id]: { roundScore: 80, breakdown: {} }, [b.id]: { roundScore: 60, breakdown: {} } } },
    { round: 2, results: { [a.id]: { roundScore: -40, breakdown: { pikDameCount: 1 } }, [b.id]: { roundScore: 220, breakdown: { pikDameLaidOut: 1 } } } },
    { round: 3, isHandAus: true, winnerId: b.id, results: { [b.id]: { roundScore: 150, breakdown: {} }, [a.id]: { roundScore: 10, breakdown: {} } } },
  ];
  const hl = g._collectHighlights();
  assert.equal(hl.length, 3, 'max three moments');
  assert.deepEqual(hl.map((h) => h.type), ['queenCaught', 'queenLaid', 'handAus'], 'drama picks: caught > handAus > laid; best round drops');
  assert.equal(hl[0].round, 2);
  assert.equal(hl[0].name, a.name);
  assert.equal(hl[2].name, b.name);
  g.destroy();
});

// --- v1.82.0: Feel-Ereignisse (kosmetisch) ---------------------------------------
test('layoutMeld emits a points event and gameOver carries the queen-magnet title', () => {
  const { game: g } = makeGame(2);
  const [a] = g.players;
  g._pointsEvent(a.id, 50, false);
  const st = g.publicState(a.id);
  assert.ok(st.lastPointsEvent, 'event in public state (positivliste!)');
  assert.equal(st.lastPointsEvent.points, 50);
  assert.equal(st.lastPointsEvent.seq, 1);
  g._pointsEvent(a.id, 100, true);
  assert.equal(g.publicState(a.id).lastPointsEvent.seq, 2, 'seq increments');
  // funTitle
  const [x, y] = g.players;
  g.roundHistory = [
    { round: 1, results: { [x.id]: { roundScore: 0, breakdown: { pikDameCount: 2 } }, [y.id]: { roundScore: 0, breakdown: { pikDameCount: 1 } } } },
  ];
  const ft = g._collectFunTitle();
  assert.equal(ft.name, x.name);
  assert.equal(ft.count, 2);
  g.destroy();
});

// --- v1.82.1: Popup-Wert == Rundenwertung, auch mit Joker -------------------------
test('points popup uses the official scoring - a joker counts 20 like in the round score', () => {
  const { game: g } = makeGame(2);
  const [a] = g.players;
  const { makeStandardCard: mk, makeJoker } = require('../game/Card');
  const { cardValue } = require('../game/Card');
  g.startNewRound();
  if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
  // Hand präparieren: Q♦ + Joker + A♦ und Zug erzwingen
  const qd = mk('D', 'Q'), jk = makeJoker(0), ad = mk('D', 'A');
  a.hand = [qd, jk, ad, mk('S', '7'), mk('C', '9')];
  g.currentPlayerIndex = g.players.indexOf(a);
  g.turnPhase = 'meld';
  let r = g.layoutMeld(a.id, [qd.id, jk.id, ad.id]);
  if (r && r.ambiguous) r = g.layoutMeld(a.id, [qd.id, jk.id, ad.id], r.options[0].jokerAssignments);
  assert.ok(r && r.ok, r && r.error);
  const ev = g.publicState(a.id).lastPointsEvent;
  assert.equal(ev.points, cardValue(qd) + cardValue(jk) + cardValue(ad), 'popup equals official sum');
  assert.equal(ev.points, 50, 'Q(10) + Joker(20) + A(20) = 50 - the round score truth');
  g.destroy();
});
