// game/GameManager.js
const { createDeck, shuffle, dealCards } = require('./Deck');
const { validateMeld, tryLayOff, tryJokerSwap } = require('./Rules');
const { scoreRound, applyRoundScores, checkGameOver, DEFAULT_HOUSE_RULES } = require('./ScoreBoard');
const { cardLabel } = require('./Card');
const Bot = require('./Bot');

const MAX_SEATS = 4;
let meldCounter = 0;
function nextMeldId() {
  meldCounter += 1;
  return `meld-${meldCounter}`;
}

class GameManager {
  constructor(broadcastFn, options = {}) {
    this.broadcast = broadcastFn; // (playerId, message) -> sendet an genau diesen Spieler
    this.onGameOver = options.onGameOver || null; // (results: {name, score, won}[]) => void
    this.players = []; // { id, name, isBot, hand, connected, laidOutCards }
    this.totals = {};
    this.houseRules = { ...DEFAULT_HOUSE_RULES };
    this.reset();
  }

  reset() {
    this.phase = 'lobby'; // lobby | playing | roundEnd | gameOver
    this.drawPile = [];
    this.discardPile = [];
    this.tableMelds = [];
    this.retiredJokers = []; // ausgetauschte Joker: dauerhaft raus aus dem Spiel
    this.currentPlayerIndex = 0;
    this.dealerIndex = 0;
    this.explicitDealerSet = false;
    this.turnPhase = 'draw'; // draw | meld
    this.turnIndexInRound = 0; // 0 = allererster Zug der laufenden Runde (für "Hand aus")
    this.mustLayOffCardId = null; // gesetzt, wenn kompletter Ablagestapel gezogen wurde
    this.roundNumber = 0;
    this.roundHistory = []; // vollständige Runde-für-Runde-Aufzeichnung der laufenden Partie
    this.gameStartedAt = null;
    this.log = [];
  }

  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 200) this.log.shift();
  }

  // --- Spielerverwaltung -------------------------------------------------

  addOrReconnectPlayer(id, name) {
    let p = this.players.find((pl) => pl.id === id);
    if (p) {
      p.connected = true;
      if (name) p.name = name;
      return p;
    }
    if (this.players.filter((pl) => !pl.isBot).length >= MAX_SEATS) {
      return null; // Tisch voll
    }
    p = { id, name: name || `Spieler ${this.players.length + 1}`, isBot: false, hand: [], connected: true, laidOutCards: [] };
    this.players.push(p);
    this.totals[id] = this.totals[id] || 0;
    return p;
  }

  markDisconnected(id) {
    const p = this.players.find((pl) => pl.id === id);
    if (p) p.connected = false;
    // Wenn der getrennte Spieler gerade am Zug ist, übernimmt sofort die
    // Bot-Logik, statt dass der Tisch blockiert (Reconnect-Robustheit für
    // wackelige Hotspot-Verbindungen).
    if (this.phase === 'playing' && this.currentPlayer()?.id === id) {
      this.maybeRunBotTurn();
    }
  }

  fillWithBots() {
    let botIndex = 1;
    while (this.players.length < MAX_SEATS) {
      const id = `bot-${botIndex}`;
      this.players.push({ id, name: `Bot ${botIndex}`, isBot: true, hand: [], connected: true, laidOutCards: [] });
      this.totals[id] = this.totals[id] || 0;
      botIndex += 1;
    }
  }

  setHouseRules(partial = {}) {
    this.houseRules = {
      ...DEFAULT_HOUSE_RULES,
      ...this.houseRules,
      ...partial,
    };
  }

  /**
   * Legt die Sitz-/Zugreihenfolge der aktuellen Spieler frei fest. Nur in der
   * Lobby möglich (vor dem ersten Rundenstart). orderedIds muss exakt die
   * Menge der aktuell vorhandenen Spieler-IDs enthalten (Menschen + ggf.
   * bereits aufgefüllte Bots).
   */
  reorderPlayers(orderedIds) {
    if (this.phase !== 'lobby') {
      return { error: 'Die Sitzordnung kann nur vor Rundenbeginn geändert werden.' };
    }
    if (!Array.isArray(orderedIds) || orderedIds.length !== this.players.length) {
      return { error: 'Die neue Reihenfolge muss alle aktuellen Plätze enthalten.' };
    }
    const byId = new Map(this.players.map((p) => [p.id, p]));
    const reordered = [];
    for (const id of orderedIds) {
      const p = byId.get(id);
      if (!p) return { error: `Unbekannte Spieler-ID in der Sitzordnung: ${id}` };
      reordered.push(p);
    }
    this.players = reordered;
    this.broadcastState();
    return { ok: true };
  }

  /**
   * Bestimmt explizit, wer in der nächsten Runde Geber ist (statt der
   * automatischen Rotation ab Platz 0). Wirkt sich erst auf den nächsten
   * Aufruf von startNewRound() aus.
   */
  setExplicitDealer(playerId) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return { error: 'Spieler nicht gefunden.' };
    this.dealerIndex = idx;
    this.explicitDealerSet = true;
    this.broadcastState();
    return { ok: true };
  }

  /**
   * Benennt freie Bot-Plätze der Reihe nach mit den Namen eines gespeicherten
   * Teams um (reale, verbundene Mitspieler werden nicht angefasst). So lässt
   * sich eine gespeicherte Spielergruppe für eine Solo-Session mit Bots
   * wiederverwenden.
   */
  applyTeamNames(memberNames) {
    let i = 0;
    for (const p of this.players) {
      if (p.isBot && i < memberNames.length) {
        p.name = memberNames[i];
        i += 1;
      }
    }
    this.broadcastState();
    return { ok: true };
  }

  // --- Rundenstart ---------------------------------------------------------

  startNewRound() {
    this.tableMelds = [];
    this.retiredJokers = [];
    this.roundNumber += 1;
    if (this.roundNumber === 1) this.gameStartedAt = Date.now();
    const deck = shuffle(createDeck());
    const playerIds = this.players.map((p) => p.id);
    const { hands, drawPile, discardPile } = dealCards(deck, playerIds);

    for (const p of this.players) {
      p.hand = hands[p.id];
      p.laidOutCards = []; // für Punkteabrechnung am Rundenende
    }
    this.drawPile = drawPile;
    this.discardPile = discardPile;
    // Der Geber rotiert jede Runde reihum, beginnend beim explizit gewählten
    // (oder sonst Platz 0). Gestartet wird vom Spieler NACH dem Geber.
    if (this.roundNumber > 1) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    }
    this.currentPlayerIndex = this.players.length > 0 ? (this.dealerIndex + 1) % this.players.length : 0;
    this.turnPhase = 'draw';
    this.turnIndexInRound = 0;
    this.mustLayOffCardId = null;
    this.phase = 'playing';

    const dealer = this.players[this.dealerIndex];
    this.addLog(`Runde ${this.roundNumber} gestartet. Geber: ${dealer ? dealer.name : '?'}.`);
    this.broadcastState();
    this.maybeRunBotTurn();
  }

  currentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  advanceTurn() {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    this.turnPhase = 'draw';
    this.mustLayOffCardId = null;
    this.turnIndexInRound += 1;
    this.broadcastState();
    this.maybeRunBotTurn();
  }

  // --- Aktion: Ziehen -------------------------------------------------------

  drawFromPile(playerId) {
    const err = this.assertTurn(playerId, 'draw');
    if (err) return err;

    if (this.drawPile.length === 0) {
      this.reshuffleDiscardIntoDrawPile();
    }
    if (this.drawPile.length === 0) {
      return { error: 'Nachziehstapel ist leer.' };
    }
    const card = this.drawPile.shift();
    this.currentPlayer().hand.push(card);
    this.turnPhase = 'meld';
    this.addLog(`${this.currentPlayer().name} zieht eine Karte vom Stapel.`);
    this.broadcastState();
    return { ok: true };
  }

  reshuffleDiscardIntoDrawPile() {
    if (this.discardPile.length <= 1) return;
    const top = this.discardPile.shift();
    this.drawPile = shuffle(this.discardPile);
    this.discardPile = [top];
    this.addLog('Nachziehstapel war leer - Ablagestapel (außer oberster Karte) wurde gemischt und neu aufgelegt.');
  }

  /**
   * Prüft, ob die oberste Ablagekarte überhaupt sinnvoll verwendbar wäre -
   * entweder direkt an eine bestehende Auslage angelegt, oder zusammen mit
   * der eigenen Hand zu einer neuen Kombination kombiniert. Nutzt dieselbe
   * Erkennungslogik wie die Bot-KI (Bot.decideDraw), damit Mensch und Bot
   * konsistent bewertet werden. Ist beides nicht möglich, darf der gesamte
   * Ablagestapel gar nicht erst aufgenommen werden (sonst droht ein
   * unlösbarer Zwang, eine nicht nutzbare Pflichtkarte auslegen zu müssen).
   */
  canUseDiscardTop(hand, topCard) {
    const plan = Bot.decideDraw(hand, [topCard], this.tableMelds);
    return plan.source === 'discardPile';
  }

  drawFromDiscard(playerId) {
    const err = this.assertTurn(playerId, 'draw');
    if (err) return err;
    if (this.discardPile.length === 0) {
      return { error: 'Ablagestapel ist leer.' };
    }
    const topCard = this.discardPile[0]; // index 0 = oberste/zuletzt abgelegte Karte
    const player = this.currentPlayer();

    if (!this.canUseDiscardTop(player.hand, topCard)) {
      return {
        error:
          'Die oberste Ablagekarte passt weder an eine bestehende Auslage noch in eine neue Kombination mit deiner Hand - der Ablagestapel kann so nicht aufgenommen werden.',
      };
    }

    const taken = this.discardPile.splice(0, this.discardPile.length); // gesamter Stapel
    player.hand.push(...taken);
    this.turnPhase = 'meld';
    this.mustLayOffCardId = topCard.id; // Pflicht: diese Karte muss sofort verwendet werden
    this.addLog(`${player.name} nimmt den gesamten Ablagestapel (${taken.length} Karten) auf.`);
    this.broadcastState();
    return { ok: true, mustUseCardId: topCard.id };
  }

  // --- Aktion: Auslegen / Anlegen -------------------------------------------

  layoutMeld(playerId, cardIds, jokerAssignments = {}) {
    const err = this.assertTurn(playerId, 'meld');
    if (err) return err;
    const player = this.currentPlayer();
    const cards = cardIds.map((id) => player.hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length) return { error: 'Karte(n) nicht in der Hand gefunden.' };

    const result = validateMeld(cards, jokerAssignments);
    if (!result.valid) return { error: result.reason };

    const meld = { id: nextMeldId(), type: result.type, suit: result.suit || null, rank: result.rank || null, slots: result.slots };
    this.tableMelds.push(meld);

    player.hand = player.hand.filter((c) => !cardIds.includes(c.id));
    player.laidOutCards.push(...cards);

    if (this.mustLayOffCardId && cardIds.includes(this.mustLayOffCardId)) {
      this.mustLayOffCardId = null;
    }

    this.addLog(`${player.name} legt eine neue ${result.type === 'set' ? 'Satz' : 'Folge'}-Auslage aus.`);
    this.checkRoundEnd(player);
    this.broadcastState();
    return { ok: true };
  }

  layOffCard(playerId, meldId, cardId, asSuit) {
    const err = this.assertTurn(playerId, 'meld');
    if (err) return err;
    const player = this.currentPlayer();
    const meld = this.tableMelds.find((m) => m.id === meldId);
    if (!meld) return { error: 'Auslage nicht gefunden.' };
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) return { error: 'Karte nicht in der Hand gefunden.' };

    const result = tryLayOff(meld, card, { asSuit });
    if (!result) return { error: 'Karte passt nicht an diese Auslage.' };

    meld.slots = result.slots;
    player.hand = player.hand.filter((c) => c.id !== cardId);
    player.laidOutCards.push(card);

    if (this.mustLayOffCardId === cardId) this.mustLayOffCardId = null;

    this.addLog(`${player.name} legt ${cardLabel(card)} an eine Auslage an.`);
    this.checkRoundEnd(player);
    this.broadcastState();
    return { ok: true };
  }

  swapJoker(playerId, meldId, handCardId) {
    const err = this.assertTurn(playerId, 'meld');
    if (err) return err;
    const player = this.currentPlayer();
    const meld = this.tableMelds.find((m) => m.id === meldId);
    if (!meld) return { error: 'Auslage nicht gefunden.' };
    const handCard = player.hand.find((c) => c.id === handCardId);
    if (!handCard) return { error: 'Karte nicht in der Hand gefunden.' };

    const result = tryJokerSwap(meld, handCard);
    if (!result) return { error: 'Diese Karte passt nicht auf einen Joker in dieser Auslage.' };

    meld.slots = result.meld.slots;
    player.hand = player.hand.filter((c) => c.id !== handCardId);
    // Der ausgetauschte Joker darf NICHT wieder aufgenommen werden - er bleibt
    // sichtbar in einem eigenen Ablagebereich liegen und ist für den Rest der
    // Runde aus dem Spiel.
    this.retiredJokers.push(result.freedJoker);
    player.laidOutCards.push(handCard);

    this.addLog(`${player.name} tauscht ${cardLabel(handCard)} gegen einen Joker in einer Auslage. Der Joker scheidet aus dem Spiel aus.`);
    this.broadcastState();
    return { ok: true };
  }

  // --- Aktion: Abwerfen -------------------------------------------------------

  discard(playerId, cardId) {
    const err = this.assertTurn(playerId, 'meld'); // Abwerfen ist erst nach dem Ziehen erlaubt
    if (err) return err;
    if (this.mustLayOffCardId) {
      return { error: 'Die aufgenommene Ablagekarte muss zuerst ausgelegt/angelegt werden.' };
    }
    const player = this.currentPlayer();
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) return { error: 'Karte nicht in der Hand gefunden.' };

    player.hand = player.hand.filter((c) => c.id !== cardId);

    if (player.hand.length === 0) {
      // Letzte Karte wird VERDECKT abgelegt und Runde endet sofort
      this.discardPile.unshift({ ...card, faceDown: true });
      this.addLog(`${player.name} legt die letzte Karte verdeckt ab und beendet die Runde!`);
      this.finishRound(player.id);
      return { ok: true, roundEnded: true };
    }

    this.discardPile.unshift(card);
    this.addLog(`${player.name} wirft ${cardLabel(card)} ab.`);
    this.advanceTurn();
    return { ok: true };
  }

  checkRoundEnd(player) {
    if (player.hand.length === 0) {
      this.addLog(`${player.name} hat alle Karten ausgelegt - Runde endet!`);
      this.finishRound(player.id);
    }
  }

  /**
   * Ein Spieler gibt die laufende Runde auf. Die Runde endet SOFORT für alle
   * (unabhängig davon, wer gerade am Zug ist). Es gibt keinen Gewinner-Bonus
   * für irgendwen - alle Spieler (inkl. des Aufgebenden) werden wie normale
   * Mitspieler gewertet: Pluspunkte (Ausgelegtes) minus Minuspunkte (Resthand).
   */
  forfeitRound(playerId) {
    if (this.phase !== 'playing') return { error: 'Es läuft gerade keine Runde.' };
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return { error: 'Spieler nicht gefunden.' };

    this.addLog(`${player.name} gibt die Runde auf.`);
    this.finishRound(null, { forfeitedBy: playerId });
    return { ok: true };
  }

  // --- Rundenende / Wertung ------------------------------------------------

  finishRound(winnerId, options = {}) {
    this.phase = 'roundEnd';
    const playersData = {};
    for (const p of this.players) {
      playersData[p.id] = { laidOutCards: p.laidOutCards, handCards: p.hand };
    }
    // "Hand aus": Der Gewinner hat im allerersten Zug der Runde (turnIndexInRound
    // war noch nie erhöht worden) seine komplette Hand ausgelegt und abgeworfen.
    // Gilt nur, wenn es überhaupt einen echten Gewinner gibt (nicht bei "Aufgeben").
    const isHandAus = !!winnerId && this.turnIndexInRound === 0;
    const roundResult = scoreRound(winnerId, playersData, { isHandAus, houseRules: this.houseRules });
    this.totals = applyRoundScores(this.totals, roundResult);
    this.lastRoundResult = roundResult;
    this.lastRoundWasHandAus = isHandAus;
    this.lastRoundForfeitedBy = options.forfeitedBy || null;

    // Statistiken für die Rundenanzeige (siehe publicState -> roundStats)
    this.lastRoundStats = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      laidOutCount: p.laidOutCards.length,
      handCount: p.hand.length,
      pikDameCount: p.hand.filter((c) => c.rank === 'Q' && c.suit === 'S').length,
      jokerInHandCount: p.hand.filter((c) => c.isJoker).length,
      meldsLaidOut: this.tableMelds.filter((m) =>
        m.slots.some((s) => p.laidOutCards.some((c) => (s.real ? s.real.id : s.joker.id) === c.id))
      ).length,
    }));

    const over = checkGameOver(this.totals, this.houseRules);

    // Runde in die Verlaufsaufzeichnung der laufenden Partie aufnehmen.
    this.roundHistory.push({
      roundNumber: this.roundNumber,
      dealerId: this.players[this.dealerIndex]?.id || null,
      winnerId,
      isHandAus,
      results: Object.fromEntries(
        Object.entries(roundResult).map(([pid, r]) => [pid, { roundScore: r.roundScore, breakdown: r.breakdown }])
      ),
      totalsAfter: { ...this.totals },
    });

    if (over.gameOver) {
      this.phase = 'gameOver';
      this.gameOverInfo = over;
      this.addLog(`Spiel beendet! Gewinner: ${this.players.find((p) => p.id === over.winnerId)?.name}`);

      this.lastGameRecord = {
        players: this.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot })),
        rounds: this.roundHistory,
        finalTotals: this.totals,
        winnerId: over.winnerId,
        houseRules: this.houseRules,
        startedAt: this.gameStartedAt,
        finishedAt: Date.now(),
      };

      if (this.onGameOver) {
        const results = this.players
          .filter((p) => !p.isBot) // nur echte Spielerprofile persistieren
          .map((p) => ({ name: p.name, score: this.totals[p.id] || 0, won: p.id === over.winnerId }));
        try {
          this.onGameOver(results, this.lastGameRecord);
        } catch (e) {
          this.addLog(`Statistik konnte nicht gespeichert werden: ${e.message}`);
        }
      }
    } else if (isHandAus) {
      this.addLog(`Hand aus! Die komplette Rundenwertung wird verdoppelt.`);
    }
    this.broadcastState();
  }

  /**
   * Startet eine neue Partie mit denselben (noch vorhandenen) Spielern:
   * Gesamtpunkte, Rundenzählung und Verlaufsaufzeichnung werden
   * zurückgesetzt, Sitzplätze/Namen bleiben erhalten.
   */
  prepareRematch() {
    this.totals = {};
    for (const p of this.players) this.totals[p.id] = 0;
    this.gameOverInfo = null;
    this.lastRoundResult = null;
    this.lastRoundStats = null;
    this.lastRoundWasHandAus = false;
    this.lastRoundForfeitedBy = null;
    this.roundHistory = [];
    this.lastGameRecord = null;
    this.gameStartedAt = null;
    this.phase = 'lobby';
    this.roundNumber = 0;
    this.dealerIndex = 0;
    this.explicitDealerSet = false;
    this.broadcastState();
  }

  // --- Validierung -----------------------------------------------------------

  assertTurn(playerId, expectedPhase) {
    if (this.phase !== 'playing') return { error: 'Es läuft gerade keine Runde.' };
    const cp = this.currentPlayer();
    if (!cp || cp.id !== playerId) return { error: 'Du bist nicht am Zug.' };
    if (expectedPhase === 'draw' && this.turnPhase !== 'draw') {
      return { error: 'Du hast bereits gezogen.' };
    }
    if (expectedPhase === 'meld' && this.turnPhase !== 'meld') {
      return { error: 'Du musst zuerst eine Karte ziehen.' };
    }
    return null;
  }

  // --- Bot-Steuerung -----------------------------------------------------------

  maybeRunBotTurn() {
    if (this.phase !== 'playing') return;
    const cp = this.currentPlayer();
    if (!cp || !this.isBotControlled(cp)) return;
    setTimeout(() => this.runBotTurn(cp.id), 700 + Math.random() * 600);
  }

  /**
   * Ein Platz wird von der Bot-Logik gesteuert, wenn es entweder ein echter
   * Bot ist, ODER ein menschlicher Spieler gerade die Verbindung verloren hat
   * (Reconnect-Robustheit: der Tisch blockiert nicht, bis er zurückkehrt).
   */
  isBotControlled(player) {
    return !!player && (player.isBot || !player.connected);
  }

  runBotTurn(botId) {
    if (this.phase !== 'playing') return;
    const cp = this.currentPlayer();
    if (!cp || cp.id !== botId || !this.isBotControlled(cp)) return;

    const plan = Bot.decideDraw(cp.hand, this.discardPile, this.tableMelds);
    if (plan.source === 'discardPile' && this.discardPile.length > 0) {
      this.drawFromDiscard(botId);
    } else {
      this.drawFromPile(botId);
    }
    if (this.phase !== 'playing') return; // Sicherheitscheck, falls die Runde inzwischen endete

    const meldPlan = Bot.planBotMelds(
      cp.hand,
      this.tableMelds.map((m) => ({ ...m, slots: m.slots.slice() }))
    );

    for (const meldCards of meldPlan.newMelds) {
      const ids = meldCards.map((c) => c.id);
      this.layoutMeld(botId, ids);
      if (this.phase !== 'playing') return;
    }

    for (const lo of meldPlan.layOffs) {
      const stillHas = cp.hand.find((c) => c.id === lo.card.id);
      if (!stillHas) continue;
      this.layOffCard(botId, lo.meldId, lo.card.id);
      if (this.phase !== 'playing') return;
    }

    if (this.phase !== 'playing') return;

    // Prio 1 für Bots: Pik-Dame/Joker niemals unnötig auf der Hand behalten.
    let discardCard = Bot.chooseDiscard(cp.hand);
    if (this.mustLayOffCardId) {
      const forced = cp.hand.find((c) => c.id === this.mustLayOffCardId);
      if (forced) discardCard = null; // Pflichtkarte zuerst lösen, kann nicht abwerfen
    }

    if (discardCard) {
      this.discard(botId, discardCard.id);
    } else {
      // Sehr seltener Edge Case: Bot konnte Pflichtkarte nicht auslegen/anlegen.
      const fallback = cp.hand.find((c) => c.id !== this.mustLayOffCardId);
      if (fallback) {
        this.mustLayOffCardId = null; // Notausgang, um die Partie nicht zu blockieren
        this.discard(botId, fallback.id);
      }
    }
  }

  // --- Zustand für Clients -----------------------------------------------------

  publicState(forPlayerId) {
    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      currentPlayerId: this.players[this.currentPlayerIndex]?.id || null,
      dealerId: this.players[this.dealerIndex]?.id || null,
      turnPhase: this.turnPhase,
      mustLayOffCardId: this.mustLayOffCardId,
      drawPileCount: this.drawPile.length,
      discardTop: this.discardPile[0] || null,
      tableMelds: this.tableMelds,
      retiredJokers: this.retiredJokers,
      houseRules: this.houseRules,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        connected: p.connected,
        controlledByBot: this.isBotControlled(p),
        handCount: p.hand.length,
        hand: p.id === forPlayerId ? p.hand : undefined,
      })),
      totals: this.totals,
      lastRoundResult: this.lastRoundResult || null,
      lastRoundWasHandAus: this.lastRoundWasHandAus || false,
      lastRoundForfeitedBy: this.lastRoundForfeitedBy || null,
      lastRoundStats: this.lastRoundStats || null,
      hasExportableGame: !!this.lastGameRecord,
      gameOverInfo: this.gameOverInfo || null,
      log: this.log.slice(-20),
    };
  }

  broadcastState() {
    for (const p of this.players) {
      if (!p.isBot) {
        this.broadcast(p.id, { type: 'state', state: this.publicState(p.id) });
      }
    }
  }
}

module.exports = GameManager;
