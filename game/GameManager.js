// game/GameManager.js
const { createDeck, shuffle, dealCards, performLuckyCut } = require('./Deck');
const { validateMeld, tryLayOff, tryJokerSwap, enumerateMeldOptions, enumerateLayOffOptions, canFormMeldWithCard } = require('./Rules');
const { scoreRound, applyRoundScores, checkGameOver, DEFAULT_HOUSE_RULES } = require('./ScoreBoard');
const { cardLabel, isPikDame } = require('./Card');
const Bot = require('./Bot');

const MIN_SEATS = 2;
const MAX_SEATS_LIMIT = 4; // Spielmaterial (Kartenanzahl, Joker) ist auf max. 4 Spieler ausgelegt
const DEFAULT_MAX_SEATS = 4;
let meldCounter = 0;
function nextMeldId() {
  meldCounter += 1;
  return `meld-${meldCounter}`;
}

class GameManager {
  constructor(broadcastFn, options = {}) {
    this.broadcast = broadcastFn; // (playerId, message) -> sendet an genau diesen Spieler
    this.onGameOver = options.onGameOver || null; // (results: {name, score, won}[]) => void
    this.onBotEmote = options.onBotEmote || null; // (botId, emoji) => void - Bot-Reaktionen an den Tisch
    this._emoteTimers = new Set(); // pendende Emote-Timeouts (destroy räumt auf)
    this._lastBotEmote = {}; // botId -> Zeitstempel (Eigen-Drosselung)
    this.players = []; // { id, name, isBot, hand, connected, laidOutCards }
    this.totals = {};
    this.houseRules = { ...DEFAULT_HOUSE_RULES };
    this.maxSeats = DEFAULT_MAX_SEATS; // wählbar (2-4), siehe setMaxSeats()
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
    this.mustLayOffCardId = null; // gesetzt, wenn die oberste Ablagekarte aufgenommen wurde
    this.pendingDiscardRest = false; // Phase 2 der Ablagestapel-Aufnahme steht noch aus
    this._botTimer = null; // Handle des pendenden Bot-Zug-Timers (fuer destroy)
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
    if (this.players.filter((pl) => !pl.isBot).length >= this.maxSeats) {
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
    while (this.players.length < this.maxSeats) {
      const id = `bot-${botIndex}`;
      this.players.push({ id, name: `Bot ${botIndex}`, isBot: true, hand: [], connected: true, laidOutCards: [] });
      this.totals[id] = this.totals[id] || 0;
      botIndex += 1;
    }
  }

  /**
   * Legt fest, wie viele Plätze der Tisch insgesamt hat (2-4). Davon
   * abhängig ist auch die Anzahl der Bots, die fillWithBots() zum Auffüllen
   * erzeugt. Nur in der Lobby änderbar, und nicht kleiner als die Anzahl
   * bereits beigetretener echter Spieler.
   */
  setMaxSeats(count) {
    if (this.phase !== 'lobby') {
      return { error: 'Die Spieleranzahl kann nur vor Rundenbeginn geändert werden.' };
    }
    const n = Math.round(Number(count));
    if (!Number.isFinite(n) || n < MIN_SEATS || n > MAX_SEATS_LIMIT) {
      return { error: `Die Spieleranzahl muss zwischen ${MIN_SEATS} und ${MAX_SEATS_LIMIT} liegen.` };
    }
    const humanCount = this.players.filter((pl) => !pl.isBot).length;
    if (n < humanCount) {
      return { error: `Es sind bereits ${humanCount} Spieler beigetreten - die Anzahl kann nicht kleiner gewählt werden.` };
    }
    this.maxSeats = n;
    this.broadcastState();
    return { ok: true };
  }

  setHouseRules(partial = {}) {
    // Nur bekannte Regeln übernehmen (Client-Eingaben nie blind spreaden).
    const clean = {};
    if (typeof partial.handAusDoubles === 'boolean') clean.handAusDoubles = partial.handAusDoubles;
    if (typeof partial.strictThreshold === 'boolean') clean.strictThreshold = partial.strictThreshold;
    if (['easy', 'medium', 'hard', 'zen'].includes(partial.botDifficulty)) clean.botDifficulty = partial.botDifficulty;
    this.houseRules = {
      ...DEFAULT_HOUSE_RULES,
      ...this.houseRules,
      ...clean,
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


  // --- Rundenstart ---------------------------------------------------------

  startNewRound() {
    this.tableMelds = [];
    this.retiredJokers = [];
    this.roundNumber += 1;
    if (this.roundNumber === 1) this.gameStartedAt = Date.now();

    // Der Geber rotiert jede Runde reihum, beginnend beim explizit gewählten
    // (oder sonst Platz 0). WICHTIG: Rotation VOR dem Abheben, damit der
    // richtige Spieler (rechts vom aktuellen Geber) abhebt.
    if (this.roundNumber > 1 && this.players.length > 0) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    }

    let deck = shuffle(createDeck());
    const playerIds = this.players.map((p) => p.id);

    // --- Glücksgriff beim Abheben ---
    // Der Geber mischt, der Spieler zu seiner RECHTEN hebt ab (= der Spieler
    // VOR ihm in der Sitzreihenfolge, da diese im Uhrzeigersinn läuft).
    // Findet er dabei Pik Dame oder Joker, wandern diese Karten sofort auf
    // seine Hand - beim Verteilen wird er dafür entsprechend oft übersprungen,
    // sodass am Ende alle exakt 15 Karten haben.
    const skips = {};
    let luckyCards = [];
    let cutter = null;
    if (this.players.length >= 2) {
      cutter = this.players[(this.dealerIndex - 1 + this.players.length) % this.players.length];
      const cutIndex = 10 + Math.floor(Math.random() * (deck.length - 20));
      const cut = performLuckyCut(deck, cutIndex);
      luckyCards = cut.luckyCards;
      deck = cut.remaining;
      if (luckyCards.length > 0) {
        skips[cutter.id] = luckyCards.length;
      }
    }

    const { hands, drawPile, discardPile } = dealCards(deck, playerIds, { skips });

    for (const p of this.players) {
      p.hand = hands[p.id];
      p.laidOutCards = []; // für Punkteabrechnung am Rundenende
    }
    if (cutter && luckyCards.length > 0) {
      cutter.hand.push(...luckyCards);
    }
    this.drawPile = drawPile;
    this.discardPile = discardPile;
    this.currentPlayerIndex = this.players.length > 0 ? (this.dealerIndex + 1) % this.players.length : 0;
    this.turnPhase = 'draw';
    this.turnIndexInRound = 0;
    this.mustLayOffCardId = null;
    this.pendingDiscardRest = false;
    this.phase = 'playing';

    const dealer = this.players[this.dealerIndex];
    this.addLog(`Runde ${this.roundNumber} gestartet. Geber: ${dealer ? dealer.name : '?'}.`);

    // "Letzte Runde?"-Ansage: Steht jemand kurz vor der 1000er-Schwelle,
    // wissen alle am Tisch, dass es jetzt um alles geht.
    const leader = this.players
      .map((p) => ({ name: p.name, total: this.totals[p.id] || 0 }))
      .sort((a, b) => b.total - a.total)[0];
    if (leader && leader.total >= 800) {
      const strict = !!(this.houseRules && this.houseRules.strictThreshold);
      this.addLog(
        strict
          ? `⚠️ Endspurt! ${leader.name} steht bei ${leader.total} Punkten - über 1000 endet das Spiel.`
          : `⚠️ Endspurt! ${leader.name} steht bei ${leader.total} Punkten - ab 1000 endet das Spiel.`
      );
    }
    if (cutter && luckyCards.length > 0) {
      const labels = luckyCards.map((card) => (card.isJoker ? 'Joker' : 'Pik Dame')).join(' + ');
      this.addLog(`🍀 Glücksgriff beim Abheben! ${cutter.name} nimmt vor dem Verteilen sofort auf die Hand: ${labels}.`);
    }
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
    this.pendingDiscardRest = false;
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
      // Weder Nachziehstapel noch mischbarer Ablagestapel übrig - niemand
      // kann mehr ziehen. Ohne diese Regel stünde das Spiel für immer still
      // (Abwerfen/Auslegen verlangen die meld-Phase, die ohne Ziehen nie
      // erreicht wird). Stattdessen endet die Runde als Patt: alle Spieler
      // werden ganz normal gewertet (Auslagen minus Resthand), niemand
      // erhält einen Gewinner-Bonus.
      this.addLog('Keine Karten mehr zum Ziehen - die Runde endet unentschieden.');
      this.finishRound(null, { stalemate: true });
      return { ok: true, roundEnded: true };
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
   * der eigenen Hand zu einer neuen Kombination kombiniert (Rules.js'
   * canFormMeldWithCard durchsucht dafür gezielt nur die relevanten
   * Kandidaten - keine Brute-Force-Suche über alle Handkarten-Teilmengen).
   * Ist beides nicht möglich, darf der gesamte Ablagestapel gar nicht erst
   * aufgenommen werden (sonst droht ein unlösbarer Zwang, eine nicht
   * nutzbare Pflichtkarte auslegen zu müssen).
   */
  canUseDiscardTop(player, topCard) {
    // REGEL: Die oberste Ablagekarte darf NUR genommen werden, wenn sie
    // zusammen mit den HANDKARTEN eine neue Kombination bilden kann.
    // Die Anlegbarkeit an bestehende Auslagen berechtigt NICHT zur Aufnahme.
    return canFormMeldWithCard(topCard, player.hand);
  }

  drawFromDiscard(playerId) {
    const err = this.assertTurn(playerId, 'draw');
    if (err) return err;
    if (this.discardPile.length === 0) {
      return { error: 'Ablagestapel ist leer.' };
    }
    const topCard = this.discardPile[0]; // index 0 = oberste/zuletzt abgelegte Karte
    const player = this.currentPlayer();

    if (!this.canUseDiscardTop(player, topCard)) {
      return {
        error:
          'Die oberste Ablagekarte passt zu keiner Kombination mit deinen Handkarten - der Ablagestapel kann so nicht aufgenommen werden.',
      };
    }

    // ZWEI-PHASEN-AUFNAHME: Zuerst wandert NUR die oberste Karte auf die
    // Hand und muss sofort in einer Kombination gelegt werden. Erst DANACH
    // erhält der Spieler den gesamten Rest des Ablagestapels
    // (siehe resolvePendingDiscardPickup).
    this.discardPile.shift();
    player.hand.push(topCard);
    this.turnPhase = 'meld';
    this.mustLayOffCardId = topCard.id;
    this.pendingDiscardRest = true;
    this.addLog(
      `${player.name} nimmt die oberste Ablagekarte (${cardLabel(topCard)}) - sie muss sofort gelegt werden, danach folgt der Rest des Stapels.`
    );
    // Der Stapel-Raub ärgert die Bots (mal mehr, mal weniger, nie sicher).
    this.botsReact(player.id, '😤', 0.35);
    this.broadcastState();
    return { ok: true, mustUseCardId: topCard.id };
  }

  /**
   * Phase 2 der Ablagestapel-Aufnahme: Nachdem die oberste Karte regelkonform
   * gelegt wurde, erhält der Spieler alle restlichen Karten des Stapels.
   * Wird VOR checkRoundEnd aufgerufen, damit die Runde nicht fälschlich
   * endet, obwohl noch Karten zustehen.
   */
  resolvePendingDiscardPickup(player) {
    if (!this.pendingDiscardRest) return;
    this.pendingDiscardRest = false;
    const rest = this.discardPile.splice(0, this.discardPile.length);
    if (rest.length > 0) {
      player.hand.push(...rest);
      this.addLog(`${player.name} nimmt die restlichen ${rest.length} Karten des Ablagestapels auf.`);
    }
  }

  // --- Aktion: Auslegen / Anlegen -------------------------------------------

  layoutMeld(playerId, cardIds, jokerAssignments = {}) {
    const err = this.assertTurn(playerId, 'meld');
    if (err) return err;
    if (this.pendingDiscardRest && !cardIds.includes(this.mustLayOffCardId)) {
      return { error: 'Die aufgenommene Ablagekarte muss SOFORT gelegt werden, bevor etwas anderes passiert.' };
    }
    const player = this.currentPlayer();
    const cards = cardIds.map((id) => player.hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length) return { error: 'Karte(n) nicht in der Hand gefunden.' };

    const hasJokers = cards.some((c) => c.isJoker);
    let result;

    if (hasJokers && Object.keys(jokerAssignments).length === 0) {
      // Noch keine explizite Zuweisung vom Client -> prüfen, ob die Auswahl
      // mehrdeutig ist (z. B. 1 Dame + 2 Joker: Satz ODER mehrere mögliche
      // Folge-Fenster). Bei mehr als einer gültigen Interpretation muss der
      // Spieler explizit wählen, statt dass wir eine davon erraten.
      const options = enumerateMeldOptions(cards);
      if (options.length === 0) {
        return { error: 'Diese Kombination ergibt keinen gültigen Satz oder keine gültige Folge.' };
      }
      if (options.length > 1) {
        return {
          ambiguous: true,
          options: options.map((o) => ({ id: o.id, type: o.type, label: o.label, jokerAssignments: o.jokerAssignments })),
        };
      }
      result = validateMeld(cards, options[0].jokerAssignments);
    } else {
      result = validateMeld(cards, jokerAssignments);
    }

    if (!result.valid) return { error: result.reason };

    // AUSMACH-REGEL: Die Runde darf nur durch ABWERFEN der letzten Karte
    // enden. Eine Auslage, die die Hand komplett leeren würde, ist deshalb
    // verboten - mindestens eine Karte muss für den Abwurf übrig bleiben.
    // Ausnahmen: (a) Es kommt gleich Nachschub (Phase 2 der Ablage-Aufnahme
    // füllt die Hand mit dem Reststapel), (b) die PFLICHTKARTE ist dabei -
    // deren Zwang darf nie in eine Sackgasse führen.
    {
      const usingCount = player.hand.filter((cd) => cardIds.includes(cd.id)).length;
      const restIncoming = this.pendingDiscardRest && this.discardPile.length > 0;
      const containsMustCard = this.mustLayOffCardId && cardIds.includes(this.mustLayOffCardId);
      if (usingCount >= player.hand.length && !restIncoming && !containsMustCard) {
        return { error: 'Zum Ausmachen musst du deine letzte Karte abwerfen - mindestens eine Handkarte muss übrig bleiben.' };
      }
    }

    // FAMILIENREGEL: Pro Spieler nur EIN Satz je Kartenwert. Wer schon
    // einen 7er-Satz liegen hat, legt weitere 7er dort AN, statt einen
    // zweiten Stapel zu eröffnen. Folgen (Straßen) sind davon nicht
    // betroffen - mehrere parallele Folgen sind erlaubt.
    if (result.type === 'set') {
      const existingSet = this.tableMelds.find(
        (m) => m.ownerId === player.id && m.type === 'set' && m.rank === result.rank
      );
      if (existingSet) {
        return { error: 'Du hast bereits einen Satz mit diesem Wert - lege die Karte(n) dort an statt einen neuen Stapel zu eröffnen.' };
      }
    }

    // Jeder Slot bekommt vermerkt, welcher Spieler diese konkrete Karte
    // dort platziert hat - so kann das Frontend "meine" Karten in Auslagen
    // optisch hervorheben (auch wenn andere Spieler später weitere Karten
    // an dieselbe Auslage anlegen).
    const taggedSlots = result.slots.map((slot) => ({ ...slot, playerId: player.id }));
    // ownerId: Auslagen gehören ihrem Ersteller - NUR er darf anlegen/tauschen.
    const meld = { id: nextMeldId(), ownerId: player.id, type: result.type, suit: result.suit || null, rank: result.rank || null, slots: taggedSlots };
    this.tableMelds.push(meld);

    player.hand = player.hand.filter((c) => !cardIds.includes(c.id));
    player.laidOutCards.push(...cards);

    if (this.mustLayOffCardId && cardIds.includes(this.mustLayOffCardId)) {
      this.mustLayOffCardId = null;
      this.resolvePendingDiscardPickup(player);
    }

    this.addLog(`${player.name} legt eine neue ${result.type === 'set' ? 'Satz' : 'Folge'}-Auslage aus.`);
    // Eine ausgelegte Pik Dame elektrisiert den Tisch.
    if (meld.slots.some((s) => s.real && isPikDame(s.real))) {
      this.maybeBotEmote(player.id, '🎉', 0.3, { force: true });
      this.botsReact(player.id, '😱', 0.4, { force: true });
    }
    this.checkRoundEnd(player);
    this.broadcastState();
    return { ok: true };
  }

  layOffCard(playerId, meldId, cardId, asSuit, side) {
    const err = this.assertTurn(playerId, 'meld');
    if (err) return err;
    {
      const p = this.currentPlayer();
      const restIncoming = this.pendingDiscardRest && this.discardPile.length > 0;
      const isMustCard = this.mustLayOffCardId && cardId === this.mustLayOffCardId;
      if (p.hand.length <= 1 && !restIncoming && !isMustCard) {
        return { error: 'Zum Ausmachen musst du deine letzte Karte abwerfen - mindestens eine Handkarte muss übrig bleiben.' };
      }
    }
    if (this.pendingDiscardRest && cardId !== this.mustLayOffCardId) {
      return { error: 'Die aufgenommene Ablagekarte muss SOFORT gelegt werden, bevor etwas anderes passiert.' };
    }
    const player = this.currentPlayer();
    const meld = this.tableMelds.find((m) => m.id === meldId);
    if (!meld) return { error: 'Auslage nicht gefunden.' };
    if (meld.ownerId !== player.id) {
      return { error: 'Du kannst nur an deine EIGENEN Auslagen anlegen - jeder Spieler hat seinen eigenen Stapel.' };
    }
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) return { error: 'Karte nicht in der Hand gefunden.' };

    let result;
    if (card.isJoker && !asSuit && !side) {
      // Noch keine explizite Wahl vom Client -> prüfen, ob mehrere Anlege-
      // Möglichkeiten existieren (z. B. Joker an Folge: oben ODER unten;
      // Joker an Satz: mehrere freie Farben).
      const options = enumerateLayOffOptions(meld, card);
      if (options.length === 0) {
        return { error: 'Karte passt nicht an diese Auslage.' };
      }
      if (options.length > 1) {
        return {
          ambiguous: true,
          options: options.map((o) => ({ id: o.id, label: o.label, asSuit: o.asSuit, side: o.side })),
        };
      }
      result = options[0].meld;
    } else {
      result = tryLayOff(meld, card, { asSuit, side });
    }
    if (!result) return { error: 'Karte passt nicht an diese Auslage.' };

    // Nur der NEU hinzugekommene Slot bekommt den aktuellen Spieler markiert;
    // bereits vorhandene Slots (result.slots enthält sie unverändert) behalten
    // ihre ursprüngliche playerId.
    meld.slots = result.slots.map((slot) => (slot.playerId ? slot : { ...slot, playerId: player.id }));
    player.hand = player.hand.filter((c) => c.id !== cardId);
    player.laidOutCards.push(card);

    if (this.mustLayOffCardId === cardId) {
      this.mustLayOffCardId = null;
      this.resolvePendingDiscardPickup(player);
    }

    this.addLog(`${player.name} legt ${cardLabel(card)} an eine Auslage an.`);
    if (isPikDame(card)) {
      this.maybeBotEmote(player.id, '🎉', 0.3, { force: true });
      this.botsReact(player.id, '😱', 0.4, { force: true });
    }
    this.checkRoundEnd(player);
    this.broadcastState();
    return { ok: true };
  }

  swapJoker(playerId, meldId, handCardId) {
    const err = this.assertTurn(playerId, 'meld');
    if (err) return err;
    if (this.pendingDiscardRest && handCardId !== this.mustLayOffCardId) {
      return { error: 'Die aufgenommene Ablagekarte muss SOFORT gelegt werden, bevor etwas anderes passiert.' };
    }
    const player = this.currentPlayer();
    const meld = this.tableMelds.find((m) => m.id === meldId);
    if (!meld) return { error: 'Auslage nicht gefunden.' };
    if (meld.ownerId !== player.id) {
      return { error: 'Du kannst nur Joker aus deinen EIGENEN Auslagen tauschen - fremde Stapel sind tabu.' };
    }
    const handCard = player.hand.find((c) => c.id === handCardId);
    if (!handCard) return { error: 'Karte nicht in der Hand gefunden.' };

    const result = tryJokerSwap(meld, handCard);
    if (!result) return { error: 'Diese Karte passt nicht auf einen Joker in dieser Auslage.' };

    // Der Slot, in dem jetzt die echte Karte liegt, gehört jetzt diesem
    // Spieler (er hat den Joker dort ausgetauscht) - alle anderen Slots
    // behalten ihre bisherige playerId.
    meld.slots = result.meld.slots.map((slot) =>
      slot.real && slot.real.id === handCard.id ? { ...slot, playerId: player.id } : slot
    );
    player.hand = player.hand.filter((c) => c.id !== handCardId);
    // Der ausgetauschte Joker darf NICHT wieder aufgenommen werden - er bleibt
    // sichtbar in einem eigenen Ablagebereich liegen und ist für den Rest der
    // Runde aus dem Spiel.
    this.retiredJokers.push(result.freedJoker);
    player.laidOutCards.push(handCard);

    // Der Tausch legt die Karte in eine Auslage - das erfüllt die Pflicht
    // einer aufgenommenen Ablagekarte genauso wie layoutMeld/layOffCard.
    // Ohne diesen Reset zeigte mustLayOffCardId auf eine Karte, die gar
    // nicht mehr auf der Hand ist, und discard() blockierte den Zug für
    // immer (Deadlock).
    if (this.mustLayOffCardId === handCardId) {
      this.mustLayOffCardId = null;
      this.resolvePendingDiscardPickup(player);
    }

    this.addLog(`${player.name} tauscht ${cardLabel(handCard)} gegen einen Joker in einer Auslage. Der Joker scheidet aus dem Spiel aus.`);
    // Verbraucht der Tausch die letzte Handkarte, endet die Runde sofort -
    // exakt wie beim Auslegen/Anlegen. Ohne diese Prüfung stand der Spieler
    // mit leerer Hand in der Abwurf-Pflicht und konnte den Zug nie beenden.
    this.checkRoundEnd(player);
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

    // Defensive Absicherung: checkGameOver bekommt NUR die Gesamtpunkte der
    // aktuell am Tisch sitzenden Spieler übergeben (nicht das komplette
    // this.totals-Objekt), damit niemals ein veralteter/verwaister Eintrag
    // (z. B. von einem Spieler, der das Spiel verlassen hat) versehentlich
    // ein vorzeitiges Spielende auslösen kann.
    const currentPlayerIds = new Set(this.players.map((p) => p.id));
    const totalsForGameOverCheck = {};
    for (const [pid, score] of Object.entries(this.totals)) {
      if (currentPlayerIds.has(pid)) totalsForGameOverCheck[pid] = score;
    }
    this.addLog(
      `Rundenwertung: ${Object.entries(totalsForGameOverCheck)
        .map(([pid, score]) => `${this.players.find((p) => p.id === pid)?.name || pid}=${score}`)
        .join(', ')}`
    );
    const over = checkGameOver(totalsForGameOverCheck, this.houseRules);

    // Bots reagieren aufs Rundenende: der Sieger jubelt, der Rest grummelt
    // oder nimmt's mit Humor - alles dem Zufall überlassen.
    if (winnerId) {
      this.maybeBotEmote(winnerId, '🎉', 0.5, { force: true });
      for (const p of this.players) {
        if (p.isBot && p.id !== winnerId) {
          this.maybeBotEmote(p.id, Math.random() < 0.5 ? '😤' : '😂', 0.25, { force: true });
        }
      }
    }

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
    // Immer nur EIN pendender Timer pro Spiel - und beim Loeschen der
    // Session wird er via destroy() abgebrochen, damit keine Referenzen
    // auf verwaiste Spiele haengen bleiben (RAM-Hygiene bei vielen Sessions).
    clearTimeout(this._botTimer);
    this._botTimer = setTimeout(() => this.runBotTurn(cp.id), 700 + Math.random() * 600);
  }

  /** Bricht pendende Timer ab - wird beim Entfernen der Session aufgerufen. */
  destroy() {
    clearTimeout(this._botTimer);
    this._botTimer = null;
    for (const t of this._emoteTimers) clearTimeout(t);
    this._emoteTimers.clear();
  }

  /**
   * Bots reagieren mit Emotes auf das Spielgeschehen - aber unberechenbar:
   * nur mit gegebener Wahrscheinlichkeit, leicht zeitversetzt (300-1800ms,
   * wie echtes Zögern) und pro Bot höchstens alle 5 Sekunden.
   */
  maybeBotEmote(botId, emoji, chance, opts = {}) {
    if (!this.onBotEmote) return;
    const bot = this.players.find((p) => p.id === botId);
    if (!bot || !bot.isBot) return;
    if (Math.random() > chance) return;
    const now = Date.now();
    // Highlights (Pik Dame! Rundenende!) duerfen die Drosselung durchbrechen,
    // Alltags-Reaktionen (Grummeln, Bluff) bleiben auf max. 1 pro 5s je Bot.
    if (!opts.force && now - (this._lastBotEmote[botId] || 0) < 5000) return;
    this._lastBotEmote[botId] = now;
    const delay = this._emoteDelayForTest !== undefined ? this._emoteDelayForTest : 300 + Math.random() * 1500;
    const t = setTimeout(() => {
      this._emoteTimers.delete(t);
      this.onBotEmote(botId, emoji);
    }, delay);
    this._emoteTimers.add(t);
  }

  /** Alle Bots AUSSER excludeId reagieren mit gegebener Chance. */
  botsReact(excludeId, emoji, chance, opts = {}) {
    for (const p of this.players) {
      if (p.isBot && p.id !== excludeId) this.maybeBotEmote(p.id, emoji, chance, opts);
    }
  }

  /**
   * Serialisiert den kompletten Spielzustand als plain JSON (alle Felder
   * sind bewusst reine Datenobjekte - Karten, Slots, Melds). Transiente
   * Felder (Callbacks, Timer) werden ausgelassen.
   */
  serialize() {
    const state = {};
    for (const [key, value] of Object.entries(this)) {
      if (key === 'broadcast' || key === 'onGameOver' || key === '_botTimer') continue;
      if (typeof value === 'function') continue;
      state[key] = value;
    }
    return state;
  }

  /**
   * Spielt einen serialisierten Zustand in eine frische Instanz ein
   * (Deployment-Neustart). Alle Spieler gelten danach als getrennt - Bots
   * übernehmen, bis die Menschen per Reconnect zurückkommen; ein evtl.
   * laufender Bot-Zug wird wieder angestoßen.
   */
  deserialize(state) {
    Object.assign(this, state);
    for (const p of this.players) {
      if (!p.isBot) p.connected = false;
    }
    this.maybeRunBotTurn();
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

    const difficulty = (this.houseRules && this.houseRules.botDifficulty) || 'medium';
    const ownMelds = this.tableMelds.filter((m) => m.ownerId === botId);
    const plan = Bot.decideDraw(cp.hand, this.discardPile, ownMelds);
    // Leichte Bots übersehen die Ablage-Chance meistens (wie Anfänger).
    if (difficulty === 'easy' && plan.source === 'discardPile' && Math.random() < 0.6) {
      plan.source = 'drawPile';
    }
    // Gelegentlicher Bluff: kurz vor dem Ziehen das Pik-Dame-Emote zeigen -
    // selten genug, dass niemand weiß, ob es etwas bedeutet.
    if (plan.source !== 'discardPile') this.maybeBotEmote(botId, 'pikdame', 0.08);
    if (plan.source === 'discardPile' && this.discardPile.length > 0) {
      this.drawFromDiscard(botId);
    } else {
      this.drawFromPile(botId);
    }
    if (this.phase !== 'playing') return; // Sicherheitscheck, falls die Runde inzwischen endete

    const meldPlan = Bot.planBotMelds(
      cp.hand,
      this.tableMelds.filter((m) => m.ownerId === botId).map((m) => ({ ...m, slots: m.slots.slice() }))
    );

    // SOFORT-Regel: Enthält ein geplantes Meld die Pflichtkarte aus der
    // Ablagestapel-Aufnahme, muss es als ERSTES gelegt werden - sonst
    // blockiert der Guard alle anderen Aktionen.
    if (this.mustLayOffCardId) {
      meldPlan.newMelds.sort((a, b) => {
        const aHas = a.some((card) => card.id === this.mustLayOffCardId) ? 0 : 1;
        const bHas = b.some((card) => card.id === this.mustLayOffCardId) ? 0 : 1;
        return aHas - bHas;
      });
    }

    // Leichte Bots schieben das Auslegen oft auf (wie zögerliche Anfänger) -
    // außer eine Pflichtkarte MUSS gelegt werden.
    if (difficulty === 'easy' && !this.mustLayOffCardId && Math.random() < 0.4) {
      meldPlan.newMelds = [];
      meldPlan.layOffs = [];
    }

    for (const meldCards of meldPlan.newMelds) {
      // Doppel-Satz-Regel: Plant der Bot einen Satz, dessen Wert er schon
      // als Satz liegen hat, legt er die Karten stattdessen dort AN.
      const realRanks = [...new Set(meldCards.filter((cd) => !cd.isJoker).map((cd) => cd.rank))];
      if (realRanks.length === 1) {
        const existingSet = this.tableMelds.find(
          (m) => m.ownerId === botId && m.type === 'set' && m.rank === realRanks[0]
        );
        if (existingSet) {
          for (const cd of meldCards) {
            if (!cp.hand.find((h) => h.id === cd.id)) continue;
            let lr = this.layOffCard(botId, existingSet.id, cd.id);
            if (lr && lr.ambiguous) {
              const choice = lr.options[0];
              this.layOffCard(botId, existingSet.id, cd.id, choice.asSuit, choice.side);
            }
            if (this.phase !== 'playing') return;
          }
          continue;
        }
      }
      const ids = meldCards.map((c) => c.id);
      let r = this.layoutMeld(botId, ids);
      if (r && r.ambiguous) {
        // Bots brauchen keinen UI-Prompt - sie nehmen einfach die erste
        // (kanonische) Interpretation.
        r = this.layoutMeld(botId, ids, r.options[0].jokerAssignments);
      }
      if (this.phase !== 'playing') return;
    }

    for (const lo of meldPlan.layOffs) {
      const stillHas = cp.hand.find((c) => c.id === lo.card.id);
      if (!stillHas) continue;
      let r = this.layOffCard(botId, lo.meldId, lo.card.id);
      if (r && r.ambiguous) {
        const choice = r.options[0];
        r = this.layOffCard(botId, lo.meldId, lo.card.id, choice.asSuit, choice.side);
      }
      if (this.phase !== 'playing') return;
    }

    if (this.phase !== 'playing') return;

    // Prio 1 für Bots: Pik-Dame/Joker niemals unnötig auf der Hand behalten.
    const foreignMelds = this.tableMelds.filter((m) => m.ownerId !== botId);
    // Kontext für kluge Bots: alle sichtbaren Karten (Auslagen + offene
    // Ablage) für die Kartenzählung, kleinste Gegnerhand fürs Endspiel.
    const visibleCards = [
      ...this.tableMelds.flatMap((m) => m.slots.map((s) => s.real || { isJoker: true })),
      ...this.discardPile.filter((cd) => !cd.faceDown),
    ];
    const lowestOpponentHand = Math.min(
      99,
      ...this.players.filter((p) => p.id !== botId).map((p) => p.hand.length)
    );
    let discardCard = Bot.chooseDiscard(cp.hand, foreignMelds, {
      difficulty,
      visibleCards,
      lowestOpponentHand,
    });

    // JOKER-GARANTIE: chooseDiscard liefert null, wenn die Hand nur noch
    // aus Jokern besteht. Dann werden die Joker an EIGENE Auslagen
    // angelegt, statt sie zu verschenken. Nur wenn wirklich keine Anlage
    // möglich ist (keine eigene Auslage / alles voll), bleibt regelbedingt
    // nur der Abwurf.
    if (!discardCard && !this.mustLayOffCardId && cp.hand.length > 0) {
      let placed = true;
      while (placed && cp.hand.length > 0 && this.phase === 'playing') {
        placed = false;
        const joker = cp.hand.find((cd) => cd.isJoker);
        if (!joker) break;
        for (const meld of this.tableMelds.filter((m) => m.ownerId === botId)) {
          let lr = this.layOffCard(botId, meld.id, joker.id);
          if (lr && lr.ambiguous) {
            const choice = lr.options[0];
            lr = this.layOffCard(botId, meld.id, joker.id, choice.asSuit, choice.side);
          }
          if (lr && lr.ok) { placed = true; break; }
        }
      }
      if (this.phase !== 'playing') return;
      if (cp.hand.length > 0) discardCard = cp.hand[0]; // unvermeidbarer Rest
    }
    if (this.mustLayOffCardId) {
      const forced = cp.hand.find((c) => c.id === this.mustLayOffCardId);
      if (forced) discardCard = null; // Pflichtkarte zuerst lösen, kann nicht abwerfen
    }

    if (discardCard) {
      this.discard(botId, discardCard.id);
    } else {
      // Sehr seltener Edge Case: Bot konnte Pflichtkarte nicht auslegen/anlegen.
      const fallback =
        cp.hand.find((c) => !c.isJoker && c.id !== this.mustLayOffCardId) ||
        cp.hand.find((c) => c.id !== this.mustLayOffCardId);
      if (fallback) {
        this.mustLayOffCardId = null; // Notausgang, um die Partie nicht zu blockieren
        this.pendingDiscardRest = false; // Rest bleibt einfach als Ablagestapel liegen
        this.discard(botId, fallback.id);
      } else if (cp.hand.length > 0) {
        // Die Pflichtkarte ist die einzige verbliebene Handkarte und konnte
        // nicht ausgelegt werden - auch dann muss der Zug zu Ende gehen,
        // sonst bleibt der Tisch für immer stehen.
        this.mustLayOffCardId = null;
        this.discard(botId, cp.hand[0].id);
      }
    }
  }

  // --- Zustand für Clients -----------------------------------------------------

  publicState(forPlayerId) {
    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      turnIndexInRound: this.turnIndexInRound,
      currentPlayerId: this.players[this.currentPlayerIndex]?.id || null,
      dealerId: this.players[this.dealerIndex]?.id || null,
      turnPhase: this.turnPhase,
      mustLayOffCardId: this.mustLayOffCardId,
      drawPileCount: this.drawPile.length,
      discardTop: this.discardPile[0] || null,
      discardPileCount: this.discardPile.length,
      tableMelds: this.tableMelds,
      retiredJokers: this.retiredJokers,
      houseRules: this.houseRules,
      maxSeats: this.maxSeats,
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
      // Punkteverlauf pro Runde (fuer das Chart im Ergebnis-Overlay)
      scoreHistory: this.roundHistory.map((r) => ({ round: r.roundNumber, totals: r.totalsAfter })),
      // Alle offen abgelegten Karten (fuer die Ablage-Vorschau im Client);
      // eine verdeckt abgelegte Schlusskarte bleibt verdeckt.
      discardCards: this.discardPile.map((card) =>
        card.faceDown ? { faceDown: true } : { id: card.id, rank: card.rank, suit: card.suit, isJoker: !!card.isJoker }
      ),
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

GameManager.MIN_SEATS = MIN_SEATS;
GameManager.MAX_SEATS_LIMIT = MAX_SEATS_LIMIT;
GameManager.DEFAULT_MAX_SEATS = DEFAULT_MAX_SEATS;

module.exports = GameManager;
