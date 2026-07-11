// game/GameManager.js
const { seededRandom, createDeck, shuffle, dealCards, performLuckyCut } = require('./Deck');
const { validateMeld, tryLayOff, tryJokerSwap, enumerateMeldOptions, enumerateLayOffOptions, canFormMeldWithCard } = require('./Rules');
const { scoreRound, applyRoundScores, checkGameOver, DEFAULT_HOUSE_RULES } = require('./ScoreBoard');
const { rankIndex, cardLabel, isPikDame, cardValue } = require('./Card');
const Bot = require('./Bot');
const StateEncoder = require('./StateEncoder');
const MoveLogger = require('./MoveLogger');

/** A bot's difficulty, defaulting to Zen (single source for the fallback). */
function botDifficultyOf(player) {
  return (player && player.botDifficulty) || 'zen';
}

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
    this.deckSeed = typeof options.deckSeed === 'number' ? options.deckSeed : null; // daily challenge
    this.challengeDate = options.challengeDate || null;
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
    this.turnPhase = 'draw';
    {
      const np = this.currentPlayer();
      if (np) np._laidAtTurnStart = !!np._everLaidThisRound;
    } // draw | meld
    this.turnIndexInRound = 0; // 0 = allererster Zug der laufenden Runde (für "Hand aus")
    this.mustLayOffCardId = null; // gesetzt, wenn die oberste Ablagekarte aufgenommen wurde
    this.pendingDiscardRest = false; // Phase 2 der Ablagestapel-Aufnahme steht noch aus
    this._botTimer = null; // Handle des pendenden Bot-Zug-Timers (fuer destroy)
    this.roundNumber = 0;
    this.gameTurnCount = 0; // Gesamtzahl gespielter Züge in dieser Partie (über alle Runden)
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
    // (reconnect path below clears disconnectedAt via the connected flag)
    let p = this.players.find((pl) => pl.id === id);
    if (p) {
      p.connected = true;
      delete p.disconnectedAt; // back in time - cancel the bot takeover
      if (this.phase === 'playing' && this.currentPlayer()?.id === id) this._armTurnTimer();
      if (this._takeoverTimers) {
        clearTimeout(this._takeoverTimers.get(id));
        this._takeoverTimers.delete(id);
      }
      if (name) p.name = name;
      if (!this.hostId && !p.isBot) this.hostId = id;
      return p;
    }
    if (this.players.filter((pl) => !pl.isBot).length >= this.maxSeats) {
      return null; // Tisch voll (nach Menschen)
    }
    p = { id, name: name || `Spieler ${this.players.length + 1}`, isBot: false, hand: [], connected: true, laidOutCards: [] };
    // In der Lobby sind freie Plätze mit Bots vorbelegt - ein Beitritt ersetzt
    // den ersten Bot AN SEINEM PLATZ, damit die Sitzordnung erhalten bleibt.
    const botIdx = this.players.findIndex((pl) => pl.isBot);
    if (botIdx !== -1) {
      const removed = this.players[botIdx];
      this.players[botIdx] = p;
      if (removed) delete this.totals[removed.id];
    } else {
      this.players.push(p);
    }
    this.totals[id] = this.totals[id] || 0;
    if (!this.hostId) this.hostId = id; // first human to join is the organizer
    return p;
  }

  /** The effective organizer: the stored host if still present & connected,
   *  otherwise the first connected human (so a brief host disconnect does not
   *  lock the lobby, and the host reclaims on reconnect). */
  effectiveHostId() {
    const host = this.players.find((p) => p.id === this.hostId && !p.isBot && p.connected);
    if (host) return this.hostId;
    const firstConnected = this._connectedHumans()[0];
    return firstConnected ? firstConnected.id : this.hostId || null;
  }

  /** Only the organizer may change lobby settings. */
  isHost(playerId) {
    return !!playerId && playerId === this.effectiveHostId();
  }

  markDisconnected(id) {
    const p = this.players.find((pl) => pl.id === id);
    if (p) {
      p.connected = false;
      // In der Lobby zaehlt nur aktives Bereitmelden: Wer sich (durch
      // Minimieren) trennt, verliert seine Bereitschaft und muss nach der
      // Rueckkehr erneut druecken.
      if (this.phase === 'lobby' && this._lobbyReady) this._lobbyReady.delete(id);
      if (this._pauseVotes) {
        this._pauseVotes.delete(id);
        this._evaluatePauseVotes(); // connected-human set changed -> re-check
      }
      if (this._forfeitVotes) {
        this._forfeitVotes.delete(id);
        this._evaluateForfeitVotes(); // connected-human set changed -> re-check
      }
      // GRACE PERIOD before a bot takes over: in hosted mode a player who
      // briefly switches apps (message, call) loses the websocket - the
      // old instant takeover meant a bot happily played (and sometimes
      // finished) their round in the meantime. The table now waits a bit;
      // reconnecting cancels the takeover.
      p.disconnectedAt = Date.now();
      this._scheduleTakeover(id);
      if (this.phase === 'playing' && this.currentPlayer()?.id === id) {
        this.addLog(`${p.name} ist getrennt - kehrt ${p.name} nicht zurück, übernimmt gleich ein Bot.`);
        this.broadcastState();
      }
    }
    // Waiting on the round-end ready check? A leaver must not block it.
    if (this.phase === 'roundEnd') this._maybeStartNextRound();
  }

  _scheduleTakeover(id) {
    if (!this._takeoverTimers) this._takeoverTimers = new Map();
    clearTimeout(this._takeoverTimers.get(id));
    this._takeoverTimers.set(
      id,
      setTimeout(() => {
        this._takeoverTimers.delete(id);
        const p = this.players.find((pl) => pl.id === id);
        if (!p || p.connected) return; // came back in time
        if (this.phase === 'lobby') {
          // Lobby: a human who never came back gives up their seat (a bot
          // takes it), so the ready gate isn't blocked indefinitely.
          if (!p.isBot) {
            this.players = this.players.filter((pl) => pl.id !== id);
            delete this.totals[id];
            if (this._lobbyReady) this._lobbyReady.delete(id);
            this.syncLobbyBots();
            this.broadcastState();
          }
          return;
        }
        this.broadcastState(); // chip now shows 'bot takes over'
        if (this.phase === 'playing' && this.currentPlayer()?.id === id) {
          this.maybeRunBotTurn();
        }
      }, GameManager.TAKEOVER_GRACE_MS)
    );
  }

  fillWithBots() {
    // Menschliche Namen statt 'Bot 1/2/3' - fuehlt sich am Tisch lebendiger
    // an. Das 🤖-Symbol am Gegner-Chip kennzeichnet Bots weiterhin klar.
    const BOT_NAMES = [
      'Uwe', 'Inge', 'Maria', 'Heinz', 'Gisela', 'Klaus', 'Renate', 'Dieter',
      'Helga', 'Manfred', 'Erika', 'Horst', 'Waltraud', 'Bernd', 'Ursel', 'Kurt',
    ];
    const taken = new Set(this.players.map((p) => p.name.toLowerCase()));
    const free = BOT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
    // Zufaellige Auswahl ohne Duplikate; Fallback auf 'Bot N', falls jemand
    // tatsaechlich alle 16 Namen als Spieler belegt hat.
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    let botIndex = 1;
    while (this.players.length < this.maxSeats) {
      while (this.players.some((p) => p.id === `bot-${botIndex}`)) botIndex += 1;
      const id = `bot-${botIndex}`;
      const name = free.pop() || `Bot ${botIndex}`;
      this.players.push({
        id, name, isBot: true, hand: [], connected: true, laidOutCards: [],
        botDifficulty: 'zen', // per-bot; adjustable in the lobby, defaults to Zen
      });
      this.totals[id] = this.totals[id] || 0;
      botIndex += 1;
    }
  }

  /** Lobby only: keep the table topped up to maxSeats with bots so empty seats
   *  are visible and sortable, and trim surplus bots when maxSeats shrinks.
   *  Humans and the existing seat order are preserved (bots trimmed from the
   *  end). Joining humans replace a bot in place (see addOrReconnectPlayer). */
  syncLobbyBots() {
    if (this.phase !== 'lobby') return;
    // Trim surplus bots from the end first (e.g. after lowering maxSeats).
    while (this.players.length > this.maxSeats) {
      const idx = [...this.players].map((p, i) => [p, i]).reverse().find(([p]) => p.isBot)?.[1];
      if (idx === undefined) break; // only humans left - nothing to trim
      const [removed] = this.players.splice(idx, 1);
      if (removed) delete this.totals[removed.id];
    }
    this.fillWithBots();
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
    this.syncLobbyBots(); // Bots an neue Platzzahl anpassen (auffüllen/kürzen)
    this.broadcastState();
    return { ok: true };
  }

  setHouseRules(partial = {}) {
    // Nur bekannte Regeln übernehmen (Client-Eingaben nie blind spreaden).
    const clean = {};
    if (typeof partial.handAusDoubles === 'boolean') clean.handAusDoubles = partial.handAusDoubles;
    if (typeof partial.strictThreshold === 'boolean') clean.strictThreshold = partial.strictThreshold;
    if ([0, 30, 60, 90].includes(Number(partial.turnTimerSeconds))) clean.turnTimerSeconds = Number(partial.turnTimerSeconds);
    this.houseRules = {
      ...DEFAULT_HOUSE_RULES,
      ...this.houseRules,
      ...clean,
    };
    // Bot difficulty is NOT a house rule - it is set PER BOT via
    // setBotDifficulty (adjustable in the lobby), defaulting to Zen.
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

  /** Change a single bot's difficulty mid-game (any human at the table may;
   *  the log entry keeps it transparent). The lobby house rule stays the
   *  default for bots created later (e.g. after a rematch). */
  setBotDifficulty(requesterId, botId, difficulty) {
    const LABELS = { easy: 'Anfänger', medium: 'Fortgeschritten', zen: 'Zen-Meister' };
    if (!LABELS[difficulty]) return { error: 'Unbekannte Schwierigkeit.' };
    const requester = this.players.find((p) => p.id === requesterId && !p.isBot);
    if (!requester) return { error: 'Nur Spieler am Tisch können das ändern.' };
    const bot = this.players.find((p) => p.id === botId && p.isBot);
    if (!bot) return { error: 'Diesen Bot gibt es nicht.' };
    if (bot.botDifficulty === difficulty) return { ok: true };
    bot.botDifficulty = difficulty;
    this.addLog(`${requester.name} stellt ${bot.name} auf ${LABELS[difficulty]}.`);
    this.broadcastState();
    return { ok: true };
  }

  /** Round-end ready check: the next round only starts once EVERY connected
   *  human has confirmed - nobody gets rushed past the round statistics.
   *  Bots and disconnected players never block; a disconnect while waiting
   *  re-evaluates readiness. */
  markNextRoundReady(playerId) {
    if (this.phase !== 'roundEnd') return { error: 'Gerade läuft keine Rundenauswertung.' };
    if (!this._nextRoundReady) this._nextRoundReady = new Set();
    this._nextRoundReady.add(playerId);
    this._maybeStartNextRound();
    // broadcastState (per-player states) - NOT this.broadcast(), which is
    // the low-level (playerId, message) hook and would send nothing here.
    this.broadcastState();
    return { ok: true };
  }

  _maybeStartNextRound() {
    if (this.phase !== 'roundEnd' || !this._nextRoundReady) return;
    const waitingFor = this.players.filter(
      (p) => !p.isBot && p.connected && !this._nextRoundReady.has(p.id)
    );
    if (waitingFor.length === 0) this.startNewRound();
  }

  startNewRound() {
    this._nextRoundReady = new Set();
    this._lobbyReady = new Set();
    this._forfeitVotes = new Set();
    this.publicKnownHands = {};
    this.declinedByPlayer = {};
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

    // Daily challenge: identical decks for everyone. Round number goes
    // into the seed so every round differs but stays deterministic.
    const roundSeed =
      typeof this.deckSeed === 'number' ? (this.deckSeed + this.roundNumber * 7919) >>> 0 : undefined;
    let deck = shuffle(createDeck(), roundSeed);
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
      // Daily challenge: the CUT must be seeded too, or it silently
      // reshuffles part of the deterministic deck (found via a flaky
      // determinism test - everyone got slightly different hands!).
      const cutRnd =
        typeof roundSeed === 'number' ? seededRandom((roundSeed ^ 0x5f3759df) >>> 0) : Math.random;
      const cutIndex = 10 + Math.floor(cutRnd() * (deck.length - 20));
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
      p.laidOutCards = [];
      p._everLaidThisRound = false;
      p._laidAtTurnStart = false; // für Punkteabrechnung am Rundenende
    }
    if (cutter && luckyCards.length > 0) {
      cutter.hand.push(...luckyCards);
    }
    this.drawPile = drawPile;
    this.discardPile = discardPile;
    this.currentPlayerIndex = this.players.length > 0 ? (this.dealerIndex + 1) % this.players.length : 0;
    this.turnPhase = 'draw';
    {
      const np = this.currentPlayer();
      if (np) np._laidAtTurnStart = !!np._everLaidThisRound;
    }
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
    // Stalemate watchdog: with the reshuffle mechanic, cards can circle
    // forever when no player is able (or willing) to meld anymore - the
    // empty-pile stalemate below never triggers because the piles refill
    // each other. 160 consecutive turns without a single successful meld
    // or lay-off (~40 full table rotations) is far beyond anything a real
    // round produces - end it as a draw, scored like the empty-pile case.
    this._turnsWithoutMeld = (this._turnsWithoutMeld || 0) + 1;
    // Zieht sich die Runde (24 Zuege ohne neue Auslage ~ 6 Runden), gaehnt
    // gelegentlich ein zufaelliger Bot - der Tisch wird langsam muede.
    if (this._turnsWithoutMeld === 24 && this.phase === 'playing') {
      const bots = this.players.filter((p) => p.isBot);
      if (bots.length) this.maybeBotEmote(bots[Math.floor(Math.random() * bots.length)].id, '😴', 0.5);
    }
    if (this._turnsWithoutMeld > 160 && this.phase === 'playing') {
      this.addLog('Lange Zeit keine neue Auslage - die Runde endet unentschieden.');
      this.finishRound(null, { stalemate: true });
      return;
    }
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    this.turnPhase = 'draw';
    // Deadlock am Zuganfang: Nachziehstapel leer UND nicht nachmischbar
    // (Ablage <= 1) UND der Spieler kann die oberste Ablagekarte nicht nehmen
    // -> niemand kann mehr etwas tun. Die Runde endet automatisch und wird
    // ganz normal gewertet (Auslagen minus Resthand), ohne Gewinner-Bonus.
    // Wichtig, weil einem Menschen die (unmögliche) Zieh-Aktion sonst gar
    // nicht angeboten wird und der Tisch endlos wartet.
    if (this.phase === 'playing' && this._roundIsDeadlocked()) {
      this.addLog('Niemand kann mehr ziehen oder aufnehmen - die Runde endet.');
      this.finishRound(null, { stalemate: true });
      return;
    }
    {
      const np = this.currentPlayer();
      if (np) np._laidAtTurnStart = !!np._everLaidThisRound;
    }
    this.mustLayOffCardId = null;
    this.pendingDiscardRest = false;
    this.turnIndexInRound += 1;
    this.gameTurnCount = (this.gameTurnCount || 0) + 1;
    this.broadcastState();
    this.maybeRunBotTurn();
  }

  // --- Aktion: Ziehen -------------------------------------------------------

  drawFromPile(playerId) {
    const err = this.assertTurn(playerId, 'draw');
    if (err) return err;
    MoveLogger.record(this, playerId, 'draw', StateEncoder.ACTION_DRAW_PILE);

    // Public inference material: drawing face-down means the visible top
    // discard was SPURNED - this player probably has no use for that rank
    // right now (or is bluffing, which is why it is only a weak signal).
    const spurned = this.discardPile[0];
    if (spurned && !spurned.faceDown && !spurned.isJoker) {
      if (!this.declinedByPlayer) this.declinedByPlayer = {};
      const list = this.declinedByPlayer[playerId] || [];
      list.push({ rank: spurned.rank, suit: spurned.suit });
      this.declinedByPlayer[playerId] = list.slice(-8);
    }

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

  /** True when no player can make any move: the draw pile is empty and cannot
   *  be refilled (discard has <= 1 card) and the current player cannot take the
   *  single discard top. Used to auto-end a deadlocked round. */
  _roundIsDeadlocked() {
    if (this.drawPile.length > 0) return false;
    if (this.discardPile.length > 1) return false; // reshuffle still possible
    const cp = this.currentPlayer();
    const top = this.discardPile[0];
    if (cp && top && !top.faceDown && this.canUseDiscardTop(cp, top)) return false;
    return true;
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

  /** PUBLIC memory (fair play by construction): tracks only cards every
   *  player at the table has SEEN enter a hand - discard-pile pickups and
   *  the returned joker of a swap. Face-down draws are never recorded, so
   *  this can never know more than an attentive human opponent. Cards are
   *  removed the moment they visibly leave the hand again (discard, meld,
   *  lay-off). Zen bots use it for card counting and discard safety. */
  _publicMemoryAdd(playerId, cards) {
    if (!this.publicKnownHands) this.publicKnownHands = {};
    const arr = this.publicKnownHands[playerId] || [];
    this.publicKnownHands[playerId] = arr.concat(cards);
  }

  _publicMemoryRemove(playerId, cardId) {
    const arr = this.publicKnownHands && this.publicKnownHands[playerId];
    if (arr) this.publicKnownHands[playerId] = arr.filter((cd) => cd.id !== cardId);
  }

  drawFromDiscard(playerId) {
    const err = this.assertTurn(playerId, 'draw');
    if (err) return err;
    if (this.discardPile.length === 0) {
      return { error: 'Ablagestapel ist leer.' };
    }
    MoveLogger.record(this, playerId, 'draw', StateEncoder.ACTION_TAKE_PILE);
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
    this._publicMemoryAdd(player.id, [topCard]);
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
      this._publicMemoryAdd(player.id, rest);
      this.addLog(`${player.name} nimmt die restlichen ${rest.length} Karten des Ablagestapels auf.`);
      // Einen dicken Stapel zu schlucken, entlockt selbst dem Bot ein Seufzen.
      if (rest.length >= 4) this.maybeBotEmote(player.id, '😅', 0.55);
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

    // Jeder Slot bekommt vermerkt, welcher Spieler diese konkrete Karte
    // dort platziert hat - so kann das Frontend "meine" Karten in Auslagen
    // optisch hervorheben (auch wenn andere Spieler später weitere Karten
    // an dieselbe Auslage anlegen).
    const taggedSlots = result.slots.map((slot) => ({ ...slot, playerId: player.id }));
    // ownerId: Auslagen gehören ihrem Ersteller - NUR er darf anlegen/tauschen.
    const meld = { id: nextMeldId(), ownerId: player.id, type: result.type, suit: result.suit || null, rank: result.rank || null, slots: taggedSlots };
    this.tableMelds.push(meld);

    player.hand = player.hand.filter((c) => !cardIds.includes(c.id));
    for (const cid of cardIds) this._publicMemoryRemove(player.id, cid);
    player._everLaidThisRound = true;
    player.laidOutCards.push(...cards);

    if (this.mustLayOffCardId && cardIds.includes(this.mustLayOffCardId)) {
      this.mustLayOffCardId = null;
      this.resolvePendingDiscardPickup(player);
    }

    this.addLog(`${player.name} legt eine neue ${result.type === 'set' ? 'Satz' : 'Folge'}-Auslage aus.`);
    this._turnsWithoutMeld = 0;
    // Eine ausgelegte Pik Dame elektrisiert den Tisch.
    if (meld.slots.some((s) => s.real && isPikDame(s.real))) {
      this._celebratePikDame(player.id);
    } else {
      // Eine dicke Auslage (viele Punkte auf einmal) - kleiner Stolz-Moment.
      const meldValue = meld.slots.reduce((sum, s) => sum + (s.real ? cardValue(s.real) : 0), 0);
      if (meldValue >= 25) this.maybeBotEmote(player.id, '😎', 0.3);
    }
    this.checkRoundEnd(player);
    this.broadcastState();
    return { ok: true };
  }

  /** Lay off SEVERAL hand cards onto one own meld in a single action
   *  ("two tens onto the ten set with one tap"). All-or-nothing: a greedy
   *  simulation on a copy (tryLayOff is pure) finds a working order first -
   *  runs may require it (J before Q onto 8-9-10) - and only then are the
   *  cards applied through the audited single-card path, so every guard
   *  (turn, ownership, forced lay-off, going-out rule) keeps applying. */
  layOffCards(playerId, meldId, cardIds) {
    const err = this.assertTurn(playerId, 'meld');
    if (err) return err;
    if (!Array.isArray(cardIds) || cardIds.length === 0) return { error: 'Keine Karten gewählt.' };
    if (cardIds.length === 1) return this.layOffCard(playerId, meldId, cardIds[0]);

    const player = this.currentPlayer();
    const meld = this.tableMelds.find((m) => m.id === meldId);
    if (!meld) return { error: 'Auslage nicht gefunden.' };
    if (meld.ownerId !== player.id) {
      return { error: 'Du kannst nur an deine EIGENEN Auslagen anlegen - jeder Spieler hat seinen eigenen Stapel.' };
    }
    const cards = cardIds.map((id) => player.hand.find((cd) => cd.id === id));
    if (cards.some((cd) => !cd)) return { error: 'Karte nicht auf der Hand.' };
    if (cards.some((cd) => cd.isJoker)) {
      return { error: 'Joker bitte einzeln anlegen (der Platz will gewählt sein).' };
    }
    // Going-out rule: at least one hand card must remain for the final discard
    const restIncoming = this.pendingDiscardRest && this.discardPile.length > 0;
    if (player.hand.length - cards.length < 1 && !restIncoming) {
      return { error: 'Zum Ausmachen musst du deine letzte Karte abwerfen - mindestens eine Handkarte muss übrig bleiben.' };
    }
    if (this.pendingDiscardRest && !cardIds.includes(this.mustLayOffCardId)) {
      return { error: 'Die aufgenommene Ablagekarte muss SOFORT gelegt werden, bevor etwas anderes passiert.' };
    }

    // Simulation: find an order in which every card fits (tryLayOff is
    // pure, so the table meld is never touched). The forced card - if any -
    // must lead the order to satisfy the single-card guard on application.
    let simMeld = meld;
    const remaining = cards.slice().sort((a, b) => {
      const aForced = a.id === this.mustLayOffCardId ? 0 : 1;
      const bForced = b.id === this.mustLayOffCardId ? 0 : 1;
      return aForced - bForced;
    });
    const order = [];
    while (remaining.length > 0) {
      const idx = remaining.findIndex((cd, i) => {
        if (order.length === 0 && this.mustLayOffCardId && remaining.some((r) => r.id === this.mustLayOffCardId)) {
          // first slot is reserved for the forced card
          if (cd.id !== this.mustLayOffCardId) return false;
        }
        return tryLayOff(simMeld, cd) !== null;
      });
      if (idx === -1) {
        return { error: 'Nicht alle gewählten Karten passen zusammen an diese Auslage.' };
      }
      simMeld = tryLayOff(simMeld, remaining[idx]);
      order.push(remaining[idx]);
      remaining.splice(idx, 1);
    }

    // Apply in the proven order through the audited single-card path.
    for (const cd of order) {
      const r = this.layOffCard(playerId, meldId, cd.id);
      if (r && r.error) return r; // unreachable after the simulation
      if (r && r.options) return { error: 'Diese Kombination bitte einzeln anlegen.' };
    }
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
    this._publicMemoryRemove(player.id, cardId);
    player.laidOutCards.push(card);

    if (this.mustLayOffCardId === cardId) {
      this.mustLayOffCardId = null;
      this.resolvePendingDiscardPickup(player);
    }

    this.addLog(`${player.name} legt ${cardLabel(card)} an eine Auslage an.`);
    this._turnsWithoutMeld = 0;
    if (isPikDame(card)) {
      this._celebratePikDame(player.id);
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
    this._publicMemoryRemove(player.id, handCardId);
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
    if (card) {
      MoveLogger.record(this, playerId, 'discard', StateEncoder.typeIndex(card), card);
    }
    if (!card) return { error: 'Karte nicht in der Hand gefunden.' };

    player.hand = player.hand.filter((c) => c.id !== cardId);
    this._publicMemoryRemove(player.id, cardId);

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
   * Aufgeben per Konsens: Ein Spieler stimmt fürs Aufgeben der laufenden Runde
   * (Toggle). Erst wenn ALLE verbundenen Menschen zustimmen, endet die Runde -
   * SOFORT für alle. Es gibt keinen Gewinner-Bonus für irgendwen; alle Spieler
   * werden wie normale Mitspieler gewertet (Ausgelegtes minus Resthand). So kann
   * niemand die Runde im Alleingang beenden - alle aktiven Spieler werden gefragt.
   */
  toggleForfeitVote(playerId) {
    if (this.phase !== 'playing') return { error: 'Es läuft gerade keine Runde.' };
    const p = this.players.find((x) => x.id === playerId && !x.isBot);
    if (!p) return { error: 'Nur Mitspieler am Tisch können aufgeben.' };
    if (!this._forfeitVotes) this._forfeitVotes = new Set();
    if (this._forfeitVotes.has(playerId)) this._forfeitVotes.delete(playerId);
    else this._forfeitVotes.add(playerId);
    const humans = this._connectedHumans();
    if (this._forfeitVotes.has(playerId)) {
      this.addLog(`${p.name} möchte die Runde aufgeben (${this._forfeitVotes.size}/${humans.length}).`);
    }
    this._evaluateForfeitVotes();
    this.broadcastState();
    return { ok: true };
  }

  _evaluateForfeitVotes() {
    if (!this._forfeitVotes) this._forfeitVotes = new Set();
    const humans = this._connectedHumans();
    if (humans.length === 0 || !humans.every((h) => this._forfeitVotes.has(h.id))) return;
    const voters = [...this._forfeitVotes];
    this._forfeitVotes = new Set();
    this.addLog('🏳️ Runde einvernehmlich aufgegeben - alle waren einverstanden.');
    this.finishRound(null, { forfeitedBy: voters[0] || null, byConsensus: true });
  }

  /** Kompatibilität: alter Direkt-Aufruf leitet jetzt auf die Abstimmung um. */
  forfeitRound(playerId) {
    return this.toggleForfeitVote(playerId);
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
    // "Hand aus": the winner had NOTHING laid out before this very turn -
    // the whole hand went down in one go. The old check (turnIndexInRound
    // === 0 = round ends on the very first turn of the round) was
    // practically never true, so the doubling rule and the hand-aus badge
    // never fired (player report).
    const winnerPlayer = winnerId ? this.players.find((p) => p.id === winnerId) : null;
    // Strict === false: the snapshot is guaranteed in real play (set at
    // round start and every turn change); anything undefined (hand-built
    // states) conservatively gives NO doubling.
    const isHandAus = !!(winnerPlayer && winnerPlayer._laidAtTurnStart === false);
    const roundResult = scoreRound(winnerId, playersData, { isHandAus, houseRules: this.houseRules });
    this.totals = applyRoundScores(this.totals, roundResult);
    this.lastRoundResult = roundResult;
    this.lastRoundWinnerId = winnerId || null; // for the winner highlight
    this.lastRoundWasHandAus = isHandAus;
    this.lastRoundForfeitedBy = options.forfeitedBy || null;
    this.lastRoundForfeitByConsensus = !!options.byConsensus;

    // Cumulative per-game totals (shown as a toggle at game over)
    if (!this.gameStatsTotals) this.gameStatsTotals = {};
    for (const p of this.players) {
      const t = this.gameStatsTotals[p.id] || { pikDames: 0, jokers: 0 };
      t.pikDames += p.laidOutCards.filter((cd) => isPikDame(cd)).length;
      t.jokers += p.laidOutCards.filter((cd) => cd.isJoker).length;
      this.gameStatsTotals[p.id] = t;
    }

    // Statistiken für die Rundenanzeige (siehe publicState -> roundStats)
    this.lastRoundStats = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      laidOutCount: p.laidOutCards.length,
      handCount: p.hand.length,
      // AUF DER HAND erwischt (Minuspunkte) - am Rundenende meist 0:
      pikDameCount: p.hand.filter((c) => c.rank === 'Q' && c.suit === 'S').length,
      jokerInHandCount: p.hand.filter((c) => c.isJoker).length,
      // AUSGELEGT (die interessante Zahl fuer die Runden-Tabelle):
      pikDameLaidOut: p.laidOutCards.filter((c) => isPikDame(c)).length,
      jokersLaidOut: p.laidOutCards.filter((c) => c.isJoker).length,
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
      // Ein Hand-aus (im allerersten Zug ausgemacht) verblüfft den Tisch.
      if (this.lastRoundWasHandAus) {
        this.botsReact(winnerId, '😲', 0.6, { force: true });
      } else {
        for (const p of this.players) {
          if (p.isBot && p.id !== winnerId) {
            this.maybeBotEmote(p.id, Math.random() < 0.5 ? '😤' : '😂', 0.25, { force: true });
          }
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
      this.gameOverInfo = { ...over, totalTurns: this.gameTurnCount || 0, totalRounds: this.roundNumber || 0 };
      MoveLogger.flush(this); // persist human moves for imitation learning
      this.addLog(`Spiel beendet! Gewinner: ${this.players.find((p) => p.id === over.winnerId)?.name}`);

      this.lastGameRecord = {
        challengeDate: this.challengeDate || undefined,
        players: this.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, botDifficulty: p.isBot ? p.botDifficulty : undefined })),
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
          .map((p) => {
            // Per-player facts for records & cumulative badge counters -
            // computed here because roundHistory lives in the manager.
            const facts = { bestRound: 0, pdLaid: 0, pdCaught: 0, jokersLaid: 0, handAusWins: 0 };
            for (const round of this.roundHistory) {
              const r = round.results && round.results[p.id];
              const b = r && r.breakdown;
              if (r && r.roundScore > facts.bestRound) facts.bestRound = r.roundScore;
              if (b) {
                facts.pdLaid += b.pikDameLaidOut || 0;
                facts.pdCaught += b.pikDameCount || 0;
                facts.jokersLaid += b.jokersLaidOut || 0;
              }
              if (round.isHandAus && round.winnerId === p.id) facts.handAusWins += 1;
            }
            return { id: p.id, name: p.name, score: this.totals[p.id] || 0, won: p.id === over.winnerId, facts };
          });
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
  /** Lobby readiness (game start AND rematch): toggles the caller's flag.
   *  With more than one connected human at the table, the game only starts
   *  once everyone confirmed - nobody gets yanked into round 1 mid-coffee. */
  markLobbyReady(playerId) {
    if (this.phase !== 'lobby') return { error: 'Bereitschaft gibt es nur in der Lobby.' };
    const p = this.players.find((x) => x.id === playerId && !x.isBot);
    if (!p) return { error: 'Nur Mitspieler am Tisch können sich bereit melden.' };
    if (!this._lobbyReady) this._lobbyReady = new Set();
    if (this._lobbyReady.has(playerId)) {
      this._lobbyReady.delete(playerId);
      this.addLog(`${p.name} ist doch noch nicht bereit.`);
    } else {
      this._lobbyReady.add(playerId);
      this.addLog(`${p.name} ist bereit.`);
    }
    this.broadcastState();
    return { ok: true };
  }

  /** Start gate: with 2+ connected humans everyone must be ready. */
  lobbyStartGate() {
    if (this.phase !== 'lobby') return {};
    // Count SEATED humans, not just connected ones: a player who minimised the
    // app (and thus dropped the socket) must still actively press 'ready' -
    // the game does not start behind their back. If they never return, the
    // lobby takeover below frees their seat so the table is not stuck forever.
    const humans = this.players.filter((p) => !p.isBot);
    if (humans.length <= 1) return {};
    const ready = humans.filter((h) => this._lobbyReady && this._lobbyReady.has(h.id)).length;
    if (ready < humans.length) {
      return { error: `Noch nicht alle bereit (${ready}/${humans.length}).` };
    }
    return {};
  }

  prepareRematch() {
    this._lobbyReady = new Set(); // Revanche: alle melden sich frisch bereit
    this.gameStatsTotals = {};
    this.totals = {};
    for (const p of this.players) this.totals[p.id] = 0;
    this.gameOverInfo = null;
    this.gameTurnCount = 0;
    this.lastRoundResult = null;
    this.lastRoundStats = null;
    this._turnsWithoutMeld = 0;
    this.lastRoundWasHandAus = false;
    this.lastRoundForfeitedBy = null;
    this.lastRoundForfeitByConsensus = false;
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

  /** Bots on the table that belong to a connected human? No - just the humans
   *  who are currently connected. Shared by the host, pause and ready gates. */
  _connectedHumans() {
    return this.players.filter((p) => !p.isBot && p.connected);
  }

  /** A laid/attached Pik Dame electrifies the table (same reaction wherever it
   *  happens - melded or laid off). */
  _celebratePikDame(playerId) {
    this.maybeBotEmote(playerId, '🎉', 0.3, { force: true, minHand: 3 });
    this.botsReact(playerId, '😱', 0.4, { force: true, minHand: 3 });
  }

  /** In-game pause by unanimous consent. Toggling a vote; once every CONNECTED
   *  human agrees the game pauses (or, while paused, resumes). Bots, the turn
   *  timer and all turn actions are frozen while paused. */
  togglePauseVote(playerId) {
    if (this.phase !== 'playing') return { error: 'Pause gibt es nur im laufenden Spiel.' };
    const p = this.players.find((x) => x.id === playerId && !x.isBot);
    if (!p) return { error: 'Nur Mitspieler am Tisch können pausieren.' };
    if (!this._pauseVotes) this._pauseVotes = new Set();
    if (this._pauseVotes.has(playerId)) this._pauseVotes.delete(playerId);
    else this._pauseVotes.add(playerId);
    this._evaluatePauseVotes();
    this.broadcastState();
    return { ok: true };
  }

  _evaluatePauseVotes() {
    if (!this._pauseVotes) this._pauseVotes = new Set();
    const humans = this._connectedHumans();
    if (humans.length === 0 || !humans.every((h) => this._pauseVotes.has(h.id))) return;
    this.paused = !this.paused;
    this._pauseVotes = new Set();
    if (this.paused) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
      this.turnDeadline = null;
      clearTimeout(this._botTimer);
      this.addLog('⏸️ Spiel pausiert - alle waren einverstanden.');
    } else {
      this.addLog('▶️ Spiel fortgesetzt.');
      this.maybeRunBotTurn(); // re-arms the timer and continues a bot turn if due
    }
  }

  assertTurn(playerId, expectedPhase) {
    if (this.phase !== 'playing') return { error: 'Es läuft gerade keine Runde.' };
    if (this.paused) return { error: 'Das Spiel ist pausiert.' };
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

  /** Optional house rule: a per-turn countdown for HUMANS. When it runs
   *  out, the bot logic finishes that one turn (transparent log line);
   *  the table never stalls on a daydreamer. Bots are untouched - they
   *  act on their own timer anyway. Zero server ticks: one timeout per
   *  turn, the deadline is broadcast for the client-side countdown. */
  _armTurnTimer() {
    clearTimeout(this._turnTimer);
    this._turnTimer = null;
    this.turnDeadline = null;
    const secs = (this.houseRules && this.houseRules.turnTimerSeconds) || 0;
    if (!secs || this.phase !== 'playing' || this.paused) return;
    const cp = this.currentPlayer();
    // No countdown for bots, bot-controlled seats OR disconnected humans:
    // during the takeover grace the seat is protected by ITS clock - a
    // 30/60s turn timer must never fire before the 75s grace does.
    if (!cp || cp.isBot || !cp.connected || this.isBotControlled(cp)) return;
    this.turnDeadline = Date.now() + secs * 1000;
    const forId = cp.id;
    this._turnTimer = setTimeout(() => this._onTurnTimeout(forId), secs * 1000);
  }

  _onTurnTimeout(playerId) {
    this._turnTimer = null;
    this.turnDeadline = null;
    if (this.phase !== 'playing') return;
    const cp = this.currentPlayer();
    if (!cp || cp.id !== playerId || cp.isBot) return;
    // A stale timer from before a disconnect must not preempt the grace
    // window - the takeover logic owns disconnected seats.
    if (!cp.connected) return;
    this.addLog(`⏰ Zeit abgelaufen - der Zug von ${cp.name} wird automatisch zu Ende gespielt.`);
    this.runBotTurn(playerId, { forced: true });
  }

  maybeRunBotTurn() {
    if (this.paused) return; // frozen while paused
    this._armTurnTimer();
    if (this.phase !== 'playing') return;
    const cp = this.currentPlayer();
    if (!cp || !this.isBotControlled(cp)) return;
    // Immer nur EIN pendender Timer pro Spiel - und beim Loeschen der
    // Session wird er via destroy() abgebrochen, damit keine Referenzen
    // auf verwaiste Spiele haengen bleiben (RAM-Hygiene bei vielen Sessions).
    clearTimeout(this._botTimer);
    this._botTimer = setTimeout(() => {
      // ONNX runtime path is opt-in (PIKDAME_ONNX=1) and fully guarded: any
      // failure falls back to the normal synchronous heuristic turn. With the
      // flag off this is byte-for-byte the previous behaviour.
      const OnnxPolicy = require('./OnnxPolicy');
      if (OnnxPolicy.enabled()) {
        this._runBotTurnWithOnnx(cp.id).catch(() => {
          try { this.runBotTurn(cp.id); } catch (e) { /* swallow */ }
        });
      } else {
        this.runBotTurn(cp.id);
      }
    }, 700 + Math.random() * 600);
  }

  /**
   * ONNX-assisted bot turn: reuses the externalDiscard='pause' seam so the
   * (async) model can choose the discard, then resumes. Guarded end to end;
   * on any miss it falls through to the heuristic discard. Only ever invoked
   * when PIKDAME_ONNX is set.
   */
  async _runBotTurnWithOnnx(botId) {
    const cp = this.players.find((p) => p.id === botId);
    if (!cp) return;
    const OnnxPolicy = require('./OnnxPolicy');
    const difficulty =
      botDifficultyOf(cp);
    // Draw-source decision via the model (only when taking the pile is legal).
    try {
      const SE = StateEncoder;
      if (SE.pileTakeLegal(this, botId)) {
        const src = await OnnxPolicy.chooseDrawSource(this, botId, difficulty);
        if (src === 'drawPile' || src === 'discardPile') cp.forcedDrawSource = src;
      }
    } catch (e) {
      // heuristic draw
    }
    const prev = cp.externalDiscard;
    cp.externalDiscard = 'pause';
    this._agentAwaitingDiscard = null;
    try {
      this.runBotTurn(botId);
    } finally {
      cp.externalDiscard = prev;
    }
    const pending = this._agentAwaitingDiscard;
    this._agentAwaitingDiscard = null;
    if (!pending || pending.botId !== botId) return; // turn already resolved (went out etc.)
    let chosen = null;
    try {
      chosen = await OnnxPolicy.chooseDiscardCard(this, botId, difficulty);
    } catch (e) {
      chosen = null;
    }
    if (!chosen) {
      // Heuristic fallback for the discard among the legal ids.
      const legal = pending.legalIds
        .map((id) => cp.hand.find((c) => c.id === id))
        .filter(Boolean);
      chosen = require('./Bot').chooseDiscard(cp.hand, this.tableMelds.filter((m) => m.ownerId !== botId), {
        difficulty,
      }) || legal[0];
    }
    if (chosen && cp.hand.find((c) => c.id === chosen.id)) {
      this.discard(botId, chosen.id);
    }
  }

  /** Bricht pendende Timer ab - wird beim Entfernen der Session aufgerufen. */
  destroy() {
    clearTimeout(this._botTimer);
    clearTimeout(this._turnTimer);
    if (this._takeoverTimers) {
      for (const t of this._takeoverTimers.values()) clearTimeout(t);
      this._takeoverTimers.clear();
    }
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
    // A bot on the verge of going out (fewer than opts.minHand cards) stays
    // quiet - used for Pik-Dame highlights, where a near-winning bot
    // celebrating or gasping looks off.
    if (opts.minHand && (bot.hand ? bot.hand.length : 0) < opts.minHand) return;
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
  /**
   * SECURITY: remove all external-control fields from a game and its seats.
   * These fields (forcedDrawSource, externalDiscard, mcts* flags) may only be
   * set by the server's own training/inference code. They only ever choose
   * among LEGAL actions and never expose hidden state, but to be safe they are
   * scrubbed on restore and never persisted, so no crafted snapshot can inject
   * them. Used by deserialize().
   */
  static _sanitizeControlFields(game) {
    const SEAT_FIELDS = [
      'forcedDrawSource', 'externalDiscard', 'mctsEnabled', 'mctsForceOff',
      'mctsDeterminizations', 'mctsEndgameAt', 'mctsMaxHand', 'mcEnabled', 'earlyDrawBiasTurns', 'queenDumpMaxHand', 'relaxQueenBaitOnJoker', 'preferDrawOnRedundantSet',
    ];
    for (const p of game.players || []) {
      for (const f of SEAT_FIELDS) delete p[f];
    }
    game._agentAwaitingDiscard = null;
    game._noMcts = false;
  }

  serialize() {
    const state = {};
    for (const [key, value] of Object.entries(this)) {
      // Transiente Laufzeit-Felder gehören NICHT in den Snapshot:
      // _emoteTimers ist ein Set (würde in JSON zu {} degenerieren und nach
      // dem Restore '.add is not a function' werfen), _lastBotEmote ist nur
      // eine Drossel-Uhr, onBotEmote ein Hook.
      if (
        key === 'broadcast' ||
        key === 'onGameOver' ||
        key === 'onBotEmote' ||
        key === '_botTimer' ||
        key === '_turnTimer' ||
        key === '_emoteTimers' ||
        key === '_takeoverTimers' ||
        key === '_nextRoundReady' ||
        key === '_lobbyReady' ||
        key === '_pauseVotes' ||
        key === '_forfeitVotes' ||
        key === '_agentAwaitingDiscard' ||
        key === '_noMcts' ||
        key === '_moveLog' ||
        key === '_lastBotEmote'
      ) continue;
      if (typeof value === 'function') continue;
      state[key] = value;
    }
    // Never persist per-seat external-control fields either.
    if (Array.isArray(state.players)) {
      const SEAT_FIELDS = [
        'forcedDrawSource', 'externalDiscard', 'mctsEnabled', 'mctsForceOff',
        'mctsDeterminizations', 'mctsEndgameAt', 'mctsMaxHand', 'mcEnabled', 'earlyDrawBiasTurns', 'queenDumpMaxHand', 'relaxQueenBaitOnJoker', 'preferDrawOnRedundantSet',
      ];
      state.players = state.players.map((p) => {
        const clean = { ...p };
        for (const f of SEAT_FIELDS) delete clean[f];
        return clean;
      });
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
    // SECURITY: strip every external-control field that could otherwise be
    // smuggled in via a tampered/persisted snapshot. These fields let an
    // external policy PICK among legal actions (they never expose hidden
    // cards, so they cannot reveal information), but they must only ever be
    // set by the server's own training/inference code - never survive a
    // restore. We wipe them from all seats and clear the game-level flags.
    GameManager._sanitizeControlFields(this);
    // Disconnected players from before the restart: re-arm their takeover
    // timers, otherwise a table whose current player never returns would
    // wait forever (the timer itself did not survive the restart).
    for (const p of this.players || []) {
      if (!p.isBot && !p.connected) this._scheduleTakeover(p.id);
    }
    this._armTurnTimer(); // fresh deadline for a restored running turn
    // Transiente Felder IMMER frisch initialisieren: bereits gespeicherte
    // Snapshots (vor diesem Fix) enthalten _emoteTimers als {} - ohne diese
    // Zeilen wuerde der erste Bot-Emote nach einem Server-Neustart mit
    // '_emoteTimers.add is not a function' scheitern.
    this._emoteTimers = new Set();
    this._lastBotEmote = {};
    this._botTimer = null;
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
    if (!player) return false;
    if (player.isBot) return true;
    if (player.connected) return false;
    // Disconnected humans stay in control during the grace window.
    return !player.disconnectedAt || Date.now() - player.disconnectedAt >= GameManager.TAKEOVER_GRACE_MS;
  }

  /** One plan-and-execute pass of the bot's meld phase. Returns the number
   *  of cards that left the hand, or -1 if the round ended mid-pass. Called
   *  in a loop by runBotTurn: a discard-pile pickup lands the REST of the
   *  pile on the hand only AFTER the forced meld resolves, so a single
   *  pass missed freshly arrived combos (player report: three aces from a
   *  swallowed pile sat on the zen bot's hand until the round ended). */
  _runBotMeldPass(cp, botId, difficulty, passIndex) {
    let actions = 0;
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
    if (passIndex === 0 && difficulty === 'easy' && !this.mustLayOffCardId && Math.random() < 0.4) {
      meldPlan.newMelds = [];
      meldPlan.layOffs = [];
    }

    for (const meldCards of meldPlan.newMelds) {
      const ids = meldCards.map((c) => c.id);
      let r = this.layoutMeld(botId, ids);
      if (r && r.ambiguous) {
        // Bots brauchen keinen UI-Prompt - sie nehmen einfach die erste
        // (kanonische) Interpretation.
        r = this.layoutMeld(botId, ids, r.options[0].jokerAssignments);
      }
      if (r && !r.error) actions += ids.length;
      if (this.phase !== 'playing') return -1;
    }

    for (const lo of meldPlan.layOffs) {
      const stillHas = cp.hand.find((c) => c.id === lo.card.id);
      if (!stillHas) continue;
      let r = this.layOffCard(botId, lo.meldId, lo.card.id);
      if (r && r.ambiguous) {
        const choice = r.options[0];
        r = this.layOffCard(botId, lo.meldId, lo.card.id, choice.asSuit, choice.side);
      }
      if (r && !r.error) actions += 1;
      if (this.phase !== 'playing') return -1;
    }

    // Joker-Ausstieg: eigene Handkarten, die exakt einen Joker in einer
    // EIGENEN Auslage vertreten, werden getauscht - der Joker scheidet aus,
    // die Handkarte gilt als gelegt. Ist es die letzte Handkarte, endet die
    // Runde sofort (swapJoker kennt die "eine Karte fuer den Abwurf muss
    // bleiben"-Sperre nicht - das ist genau die dokumentierte Ausnahme).
    for (const js of meldPlan.jokerSwaps || []) {
      const stillHas = cp.hand.find((c) => c.id === js.card.id);
      if (!stillHas) continue;
      const r = this.swapJoker(botId, js.meldId, js.card.id);
      if (r && !r.error) actions += 1;
      if (this.phase !== 'playing') return -1;
    }

    if (this.phase !== 'playing') return -1;
    return actions;
  }

  /** Guarantee the mandatory discard-pickup card gets laid this turn. Tries a
   *  lay-off onto any existing meld, then a fresh meld built from the card plus
   *  a few hand cards (a valid meld provably exists - canUseDiscardTop checked
   *  it before the pickup). Returns true once it is laid. Only invoked in the
   *  rare case the greedy meld passes stranded it. */
  _forceLayMustCard(cp, botId) {
    const cardId = this.mustLayOffCardId;
    if (!cardId) return true;
    if (!cp.hand.some((c) => c.id === cardId)) return true; // already laid
    // (a) lay off onto any existing meld
    for (const meld of this.tableMelds) {
      let lr = this.layOffCard(botId, meld.id, cardId);
      if (lr && lr.ambiguous && lr.options && lr.options[0]) {
        lr = this.layOffCard(botId, meld.id, cardId, lr.options[0].asSuit, lr.options[0].side);
      }
      if (lr && lr.ok) return true;
    }
    // (b) build a fresh meld: the card plus 2-3 other hand cards. Any valid
    // 3-card run/set through the card is enough (longer runs contain one), and
    // layoutMeld only mutates on success, so failed tries are free.
    const tryMeld = (ids) => {
      let r = this.layoutMeld(botId, ids);
      if (r && r.ambiguous && r.options && r.options[0]) {
        r = this.layoutMeld(botId, ids, r.options[0].jokerAssignments || {});
      }
      return !!(r && r.ok);
    };
    const others = cp.hand.filter((c) => c.id !== cardId).map((c) => c.id);
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        if (tryMeld([cardId, others[i], others[j]])) return true;
        for (let k = j + 1; k < others.length; k++) {
          if (tryMeld([cardId, others[i], others[j], others[k]])) return true;
        }
      }
    }
    return false;
  }

  runBotTurn(botId, opts = {}) {
    if (this.phase !== 'playing') return;
    const cp = this.currentPlayer();
    if (!cp || cp.id !== botId) return;
    // opts.forced: turn-timer expiry lets the bot logic finish a HUMAN's
    // turn once - every rule check downstream still applies unchanged.
    if (!opts.forced && !this.isBotControlled(cp)) return;

    // Per-bot difficulty (adjustable in-game) with the house rule as default
    // Default (and thus also the stand-in for a temporarily replaced
    // human or a timed-out turn): the zen master - the strongest fair bot.
    const difficulty = botDifficultyOf(cp);
    const ownMelds = this.tableMelds.filter((m) => m.ownerId === botId);
    const plan = Bot.decideDraw(cp.hand, this.discardPile, ownMelds, {
      earlyDrawBiasTurns: cp.earlyDrawBiasTurns || 0,
      turnInRound: this.turnIndexInRound,
      preferDrawOnRedundantSet: cp.preferDrawOnRedundantSet || false,
    });
    // Leichte Bots übersehen die Ablage-Chance meistens (wie Anfänger).
    if (difficulty === 'easy' && plan.source === 'discardPile' && Math.random() < 0.6) {
      plan.source = 'drawPile';
    }
    // Pile-usability check (medium and up), replacing the old blunt
    // "never exceed ~20 hand cards" cap: a big pickup is FINE when the bot
    // can actually put the cards to work (10 in hand + 10 usable from the
    // pile is a power move, not a problem). One extra meld-planning pass
    // on the hypothetical hand decides - only for piles > 4 cards, so the
    // cost is a rare O(hand²) lookahead, no measurable load. Skipped only
    // when the pile would mostly become dead weight.
    if (plan.source === 'discardPile' && difficulty !== 'easy' && this.discardPile.length > 4) {
      const hypothetical = [...cp.hand, ...this.discardPile];
      const lookahead = Bot.planBotMelds(hypothetical, ownMelds);
      const usable =
        lookahead.newMelds.reduce((n, m) => n + m.length, 0) + lookahead.layOffs.length;
      const leftover = hypothetical.length - usable;
      const worthIt =
        usable >= Math.ceil(this.discardPile.length / 2) || leftover <= cp.hand.length + 3;
      if (!worthIt) plan.source = 'drawPile';
    }
    // Endgame guard (medium and up): taking the discard pile means taking
    // ALL of it. If a Queen of Spades hides BELOW the top card, swallowing
    // the pile is a -100 liability whenever the round is about to end -
    // either because the bot itself is close to going out (small own hand)
    // OR because any opponent is (<= 3 cards: the Queen would very likely
    // still be stuck in hand at scoring time). A Queen ON TOP stays
    // attractive: it must be melded immediately (+100).
    if (plan.source === 'discardPile' && difficulty !== 'easy') {
      const roundNearlyOver =
        cp.hand.length <= 4 ||
        this.players.some((p) => p.id !== botId && p.hand.length <= 3);
      if (roundNearlyOver && this.discardPile.slice(1).some((card) => isPikDame(card))) {
        plan.source = 'drawPile';
      }
    }
    // General value-exposure risk (medium and up): the Queen check above
    // only ever caught HER specifically. Any other buried point pile (two
    // kings, a stray ace) is just as costly if the round ends before the
    // bot gets a chance to unload them. Compares the point value the bot
    // would be LEFT holding (after a full meld-planning lookahead) WITH
    // vs WITHOUT the pickup - only relevant once the round could end soon.
    if (plan.source === 'discardPile' && difficulty !== 'easy') {
      const roundNearlyOver =
        cp.hand.length <= 4 ||
        this.players.some((p) => p.id !== botId && p.hand.length <= 3);
      if (roundNearlyOver) {
        const withPickup = Bot.planBotMelds([...cp.hand, ...this.discardPile], ownMelds);
        const withoutPickup = Bot.planBotMelds(cp.hand, ownMelds);
        const valueOf = (cards) => cards.reduce((sum, cd) => sum + cardValue(cd), 0);
        const exposureDelta = valueOf(withPickup.finalHand) - valueOf(withoutPickup.finalHand);
        // A stray face card or two (~10-15 points) is normal noise; a
        // buried double-digit swing is the kind of gift that costs rounds.
        if (exposureDelta > 15) plan.source = 'drawPile';
      }
    }
    // Gelegentlicher Bluff: kurz vor dem Ziehen das Pik-Dame-Emote zeigen -
    // selten genug, dass niemand weiß, ob es etwas bedeutet.
    // The 'hoping for the Queen' bluff only makes sense while at least one
    // of the two Queens of Spades could still show up - once both are laid
    // out on the table, the wish would just look silly.
    const queensOnTable = this.tableMelds.reduce(
      (n, m) => n + m.slots.filter((s) => s.real && isPikDame(s.real)).length,
      0
    );
    if (plan.source !== 'discardPile' && queensOnTable < 2) this.maybeBotEmote(botId, 'pikdame', 0.08);
    // External draw decision (RL agent / ONNX): a forced source set before the
    // turn overrides the heuristic AND its guards. 'discardPile' only takes
    // effect when the pile is non-empty and the take is rule-legal (the caller
    // guarantees legality; we still guard here).
    if (cp.forcedDrawSource === 'drawPile' || cp.forcedDrawSource === 'discardPile') {
      plan.source = cp.forcedDrawSource;
      cp.forcedDrawSource = null;
    }
    if (plan.source === 'discardPile' && this.discardPile.length > 0) {
      this.drawFromDiscard(botId);
    } else {
      this.drawFromPile(botId);
    }
    if (this.phase !== 'playing') return; // Sicherheitscheck, falls die Runde inzwischen endete

    // Plan/execute in passes until nothing new fits (max 4 as a hard cap):
    // pass 1 lays the forced meld and triggers the pile pickup, pass 2 puts
    // the freshly arrived cards to work, pass 3 confirms exhaustion.
    for (let pass = 0; pass < 4; pass++) {
      const acted = this._runBotMeldPass(cp, botId, difficulty, pass);
      if (acted < 0) return; // round ended mid-pass
      if (acted === 0) break;
    }

    // RULE GUARANTEE: a card taken from the discard pile MUST be laid this turn
    // (canUseDiscardTop already verified a lay exists). The greedy meld passes
    // occasionally don't lay it (their planner may spend the needed cards/joker
    // elsewhere) - so if it is still stranded, lay it explicitly here. Without
    // this the bot used to discard a DIFFERENT card and keep the taken one,
    // breaking the rule.
    if (this.mustLayOffCardId) {
      if (this._forceLayMustCard(cp, botId)) {
        // Laying it releases the rest of the pile - work those cards too.
        for (let pass = 0; pass < 4; pass++) {
          const acted = this._runBotMeldPass(cp, botId, difficulty, pass);
          if (acted < 0) return;
          if (acted === 0) break;
        }
      }
    }


    // Prio 1 für Bots: Pik-Dame/Joker niemals unnötig auf der Hand behalten.
    const foreignMelds = this.tableMelds.filter((m) => m.ownerId !== botId);
    // Kontext für kluge Bots: alle sichtbaren Karten (Auslagen + offene
    // Ablage) für die Kartenzählung, kleinste Gegnerhand fürs Endspiel.
    // Public memory of OTHER hands: cards the whole table watched enter a
    // hand (pile pickups) and that have not visibly left it yet. Never
    // contains face-down draws - fair play by construction.
    const opponentKnownCards = Object.entries(this.publicKnownHands || {})
      .filter(([pid]) => pid !== botId)
      .flatMap(([, cards]) => cards);
    const visibleCards = [
      ...this.tableMelds.flatMap((m) => m.slots.map((s) => s.real || { isJoker: true })),
      ...this.discardPile.filter((cd) => !cd.faceDown),
      ...opponentKnownCards,
    ];
    const lowestOpponentHand = Math.min(
      99,
      ...this.players.filter((p) => p.id !== botId).map((p) => p.hand.length)
    );
    // Punktestand-Kontext fuers Risikoprofil (nur Zen wertet ihn, siehe
    // Bot.chooseDiscard): Vorsprung/Rueckstand gegenueber dem staerksten
    // Gegner in der laufenden Partie (this.totals), nicht der Runde.
    const myTotal = this.totals[botId] || 0;
    const opponentTotalsArr = this.players.filter((p) => p.id !== botId).map((p) => this.totals[p.id] || 0);
    const scoreLead = myTotal - (opponentTotalsArr.length ? Math.max(...opponentTotalsArr) : 0);
    // Experimental Monte-Carlo discard risk (only when the seat opts in via
    // cp.mcEnabled - set by the self-play harness, never in production). In
    // the endgame it samples the next player's hidden hand and estimates the
    // chance each candidate discard hands them a fresh meld. Engine stays
    // pure: Bot.chooseDiscard merely blends the returned map.
    let mcRisk;
    let mcWeight;
    if (cp.mcEnabled && lowestOpponentHand <= 4) {
      const MonteCarlo = require('./MonteCarlo');
      const next = this.players[(this.currentPlayerIndex + 1) % this.players.length];
      if (next && next.id !== botId) {
        mcRisk = MonteCarlo.discardMeldRisk({
          ownHand: cp.hand,
          visibleCards,
          nextHandSize: next.hand.length,
          nextKnownCards: (this.publicKnownHands && this.publicKnownHands[next.id]) || [],
          candidates: cp.hand.filter((c) => !c.isJoker),
          samples: cp.mcSamples || 200,
        });
        mcWeight = typeof cp.mcWeight === 'number' ? cp.mcWeight : 6;
      }
    }
    let discardCard = Bot.chooseDiscard(cp.hand, foreignMelds, {
      difficulty,
      scoreLead,
      visibleCards,
      opponentKnownCards,
      mcRisk,
      mcWeight,
      // What the NEXT player recently spurned from the pile top: those
      // ranks are (probably) safe to throw at them.
      nextPlayerDeclined: (() => {
        const next = this.players[(this.currentPlayerIndex + 1) % this.players.length];
        return (next && this.declinedByPlayer && this.declinedByPlayer[next.id]) || [];
      })(),
      lowestOpponentHand,
      queenDumpMaxHand: cp.queenDumpMaxHand || 6,
      // A/B seam (off by default): does an OPPONENT already have a joker laid?
      relaxQueenBaitOnJoker: cp.relaxQueenBaitOnJoker || false,
      opponentHasLaidJoker: this.tableMelds.some(
        (m) => m.ownerId !== botId && m.slots.some((s) => s.joker || (s.real && s.real.isJoker))
      ),
      queensMelded: this.tableMelds.reduce(
        (n, m) => n + m.slots.filter((s) => s.real && isPikDame(s.real)).length,
        0
      ),
    });

    // Determinized-rollout discard: kept as opt-in only (cp.mctsEnabled, set
    // by the self-play harness). A batched A/B measured a small, statistically
    // INCONCLUSIVE effect (~+2 win-rate points at ~0.8 sigma) at a real ~500ms
    // per-decision cost, so it is NOT enabled for production zen; the learned
    // ONNX policy (PIKDAME_ONNX) is the path forward instead.
    const mctsActive = !this._noMcts && !cp.mctsForceOff && cp.mctsEnabled;
    if (
      mctsActive &&
      lowestOpponentHand <= (cp.mctsEndgameAt || 5) &&
      cp.hand.length <= (cp.mctsMaxHand || 9) &&
      discardCard
    ) {
      try {
        const Rollout = require('./Rollout');
        const shortlist = cp.hand.filter((c) => !c.isJoker && !isPikDame(c));
        const pool = shortlist.length > 0 ? shortlist : cp.hand.filter((c) => !c.isJoker);
        if (pool.length > 1) {
          const picked = Rollout.chooseDiscardByRollout(this.constructor, this, botId, pool, {
            determinizations: cp.mctsDeterminizations || 8,
            difficulty: 'zen',
          });
          if (picked) discardCard = picked;
        }
      } catch (e) {
        // Fall back to the heuristic discard already chosen above.
      }
    }

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

    // External discard decision maker (RL env server during training, ONNX
    // policy at runtime). Only for a FREE discard - forced pickup cards are
    // resolved by the logic above. When the seat pauses for an external
    // agent, we leave the state in meld phase and return; the caller supplies
    // the discard via discard(). When it decides synchronously (ONNX), it
    // returns a card id to throw.
    if (discardCard && !this.mustLayOffCardId && cp.externalDiscard) {
      const legal = cp.hand.filter((c) => !c.isJoker);
      if (legal.length > 0) {
        if (cp.externalDiscard === 'pause') {
          this._agentAwaitingDiscard = { botId, legalIds: legal.map((c) => c.id) };
          return; // env will call discard(botId, chosenId)
        }
        if (typeof cp.externalDiscard === 'function') {
          try {
            const chosenId = cp.externalDiscard(this, cp, legal);
            const chosen = chosenId && cp.hand.find((c) => c.id === chosenId);
            if (chosen) discardCard = chosen;
          } catch (e) {
            // fall back to the heuristic discardCard
          }
        }
      }
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
      hostId: this.effectiveHostId(),
      isHost: this.isHost(forPlayerId),
      paused: !!this.paused,
      pauseVotes: this._pauseVotes ? [...this._pauseVotes] : [],
      forfeitVotes: this._forfeitVotes ? [...this._forfeitVotes] : [],
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        botDifficulty: p.isBot ? botDifficultyOf(p) : undefined,
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
      lastRoundForfeitByConsensus: !!this.lastRoundForfeitByConsensus,
      lastRoundStats: this.lastRoundStats || null,
      nextRoundReady: this._nextRoundReady ? [...this._nextRoundReady] : [],
      lastRoundWinnerId: this.lastRoundWinnerId || null,
      lobbyReady: this._lobbyReady ? [...this._lobbyReady] : [],
      turnDeadline: this.turnDeadline || null,
      gameStatsTotals: this.gameStatsTotals || {},
      hasExportableGame: !!this.lastGameRecord,
      gameOverInfo: this.gameOverInfo || null,
      log: this.log.slice(-20),
    };
  }

  /** Canonical, identical-for-everyone order of the table melds: sorted by
   *  the leading rank (a set's rank / a run's start card, jokers count as
   *  what they represent), sets narrowly before runs of the same rank, id
   *  as the stable tie-break so nothing ever jumps around. Called once per
   *  broadcast - idempotent and cheap, and it covers every mutation path. */
  _sortTableMelds() {
    const leadKey = (meld) => {
      if (meld.type === 'set') return rankIndex(meld.rank) * 10;
      const s0 = meld.slots[0];
      const r0 = s0 && (s0.real ? s0.real.rank : s0.representsRank);
      return rankIndex(r0) * 10 + 5;
    };
    this.tableMelds.sort(
      (a, b) => leadKey(a) - leadKey(b) || String(a.id).localeCompare(String(b.id))
    );
  }

  broadcastState() {
    this._sortTableMelds();
    for (const p of this.players) {
      if (!p.isBot) {
        this.broadcast(p.id, { type: 'state', state: this.publicState(p.id) });
      }
    }
  }
}

// Grace before a bot takes over a disconnected human's seat (hosted mode:
// a quick app switch must not cost anyone their round).
GameManager.TAKEOVER_GRACE_MS = 75 * 1000;
GameManager.MIN_SEATS = MIN_SEATS;
GameManager.MAX_SEATS_LIMIT = MAX_SEATS_LIMIT;
GameManager.DEFAULT_MAX_SEATS = DEFAULT_MAX_SEATS;

module.exports = GameManager;
