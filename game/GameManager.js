// game/GameManager.js
const { createDeck, shuffle, dealWithGlucksgriff } = require('./Deck');
const { validateMeld, tryLayOff, tryJokerSwap } = require('./Rules');
const { scoreRound, applyRoundScores, checkGameOver } = require('./ScoreBoard');
const { cardLabel } = require('./Card');
const Bot = require('./Bot');

const MAX_SEATS = 4;
let meldCounter = 0;
function nextMeldId() {
  meldCounter += 1;
  return `meld-${meldCounter}`;
}

class GameManager {
  constructor(broadcastFn) {
    this.broadcast = broadcastFn; // (playerId, message) -> sendet an genau diesen Spieler
    this.players = []; // { id, name, isBot, hand, connected, laidOutCards }
    this.totals = {};
    this.reset();
  }

  reset() {
    this.phase = 'lobby'; // lobby | playing | roundEnd | gameOver
    this.drawPile = [];
    this.discardPile = [];
    this.tableMelds = [];
    this.currentPlayerIndex = 0;
    this.turnPhase = 'draw'; // draw | meld
    this.mustLayOffCardId = null; // gesetzt, wenn kompletter Ablagestapel gezogen wurde
    this.roundNumber = 0;
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

  // --- Rundenstart ---------------------------------------------------------

  startNewRound() {
    this.tableMelds = [];
    this.roundNumber += 1;
    const deck = shuffle(createDeck());
    const playerIds = this.players.map((p) => p.id);
    const { hands, drawPile, discardPile, luckyHits } = dealWithGlucksgriff(deck, playerIds);

    for (const p of this.players) {
      p.hand = hands[p.id];
      p.laidOutCards = []; // für Punkteabrechnung am Rundenende
    }
    this.drawPile = drawPile;
    this.discardPile = discardPile;
    this.currentPlayerIndex = (this.roundNumber - 1) % this.players.length;
    this.turnPhase = 'draw';
    this.mustLayOffCardId = null;
    this.phase = 'playing';

    for (const hit of luckyHits) {
      const p = this.players.find((pl) => pl.id === hit.playerId);
      this.addLog(`Glücksgriff: ${p ? p.name : hit.playerId} erhält sofort ${cardLabel(hit.card)}!`);
    }
    this.addLog(`Runde ${this.roundNumber} gestartet.`);
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

  drawFromDiscard(playerId) {
    const err = this.assertTurn(playerId, 'draw');
    if (err) return err;
    if (this.discardPile.length === 0) {
      return { error: 'Ablagestapel ist leer.' };
    }
    const topCard = this.discardPile[0]; // index 0 = oberste/zuletzt abgelegte Karte
    const taken = this.discardPile.splice(0, this.discardPile.length); // gesamter Stapel
    this.currentPlayer().hand.push(...taken);
    this.turnPhase = 'meld';
    this.mustLayOffCardId = topCard.id; // Pflicht: diese Karte muss sofort verwendet werden
    this.addLog(`${this.currentPlayer().name} nimmt den gesamten Ablagestapel (${taken.length} Karten) auf.`);
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
    player.hand.push(result.freedJoker);
    player.laidOutCards.push(handCard);

    this.addLog(`${player.name} tauscht ${cardLabel(handCard)} gegen einen Joker in einer Auslage.`);
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

  // --- Rundenende / Wertung ------------------------------------------------

  finishRound(winnerId) {
    this.phase = 'roundEnd';
    const playersData = {};
    for (const p of this.players) {
      playersData[p.id] = { laidOutCards: p.laidOutCards, handCards: p.hand };
    }
    const roundResult = scoreRound(winnerId, playersData);
    this.totals = applyRoundScores(this.totals, roundResult);
    this.lastRoundResult = roundResult;

    const over = checkGameOver(this.totals);
    if (over.gameOver) {
      this.phase = 'gameOver';
      this.gameOverInfo = over;
      this.addLog(`Spiel beendet! Gewinner: ${this.players.find((p) => p.id === over.winnerId)?.name}`);
    }
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
    if (!cp || !cp.isBot) return;
    setTimeout(() => this.runBotTurn(cp.id), 700 + Math.random() * 600);
  }

  runBotTurn(botId) {
    if (this.phase !== 'playing') return;
    const cp = this.currentPlayer();
    if (!cp || cp.id !== botId || !cp.isBot) return;

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
      turnPhase: this.turnPhase,
      mustLayOffCardId: this.mustLayOffCardId,
      drawPileCount: this.drawPile.length,
      discardTop: this.discardPile[0] || null,
      tableMelds: this.tableMelds,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        connected: p.connected,
        handCount: p.hand.length,
        hand: p.id === forPlayerId ? p.hand : undefined,
      })),
      totals: this.totals,
      lastRoundResult: this.lastRoundResult || null,
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
