// public/client.js
// Verbindet sich dynamisch über window.location.hostname, damit der Client
// im Hotspot-Netzwerk ohne Code-Änderung über die iPhone-IP funktioniert.

(function () {
  'use strict';

  const NAME_KEY = 'pikdame_player_name';
  const THEME_KEY = 'pikdame_theme';
  const SOUND_KEY = 'pikdame_sound_enabled';

  // Session-Code ggf. aus der URL übernehmen (geteilter Link: ?session=CODE)
  let sessionCode = (new URLSearchParams(window.location.search).get('session') || '').toUpperCase() || null;
  // Die playerId wird PRO SESSION gespeichert, damit Reconnects in das
  // richtige Spiel zurückführen und parallele Spiele sich nicht vermischen.
  const playerKeyFor = (code) => `pikdame_player_${code}`;
  let playerId = sessionCode ? localStorage.getItem(playerKeyFor(sessionCode)) : null;
  let myName = localStorage.getItem(NAME_KEY) || '';
  let soundEnabled = localStorage.getItem(SOUND_KEY) !== 'off';
  let ws = null;
  let lastState = null;
  let selectedCardIds = new Set();
  let lastRoundResultShownAt = 0;
  // Frisch gezogene/aufgenommene Karten hervorheben: Diff der Hand-IDs
  // zwischen zwei Renders. Bei Rundenwechsel (Erstverteilung) wird nichts
  // markiert.
  let prevHandIds = new Set();
  let prevTurnPlayerId = null;
  let prevDiscardTopId;
  // Auslagen-Filter: null = alle anzeigen; sonst nur die Auslagen dieses
  // Spielers (Toggle per Klick auf den Namen).
  let meldFilterPlayerId = null;
  // IDs aller Pik Damen, die bereits in den Auslagen liegen - taucht eine
  // NEUE auf, gibt es die große Ankündigung (Raid-Warning-Stil).
  let prevTablePikdameIds = null;
  let prevPikdameRound = null;
  const SORT_KEY = 'pikdame_hand_sort';
  let handSortMode = localStorage.getItem(SORT_KEY) === 'rank' ? 'rank' : 'suit';
  let prevHandRound = null;
  let freshCardIds = new Set();
  let knownProfiles = [];
  let publicMode = false;

  const el = (id) => document.getElementById(id);

  // Defense in Depth: Namen werden zwar bereits serverseitig auf harmlose
  // Zeichen begrenzt, aber alles, was per innerHTML gerendert wird, läuft
  // zusätzlich durch dieses Escaping - eine einzelne vergessene Stelle
  // wird so nicht zur XSS-Lücke auf einem öffentlichen Server.
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    document.querySelectorAll('.themeBtn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeChoice === theme);
    });
  }

  document.querySelectorAll('.themeBtn').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice));
  });
  applyTheme(localStorage.getItem(THEME_KEY) || 'table');

  document.querySelectorAll('.seatCountBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      send({ type: 'setMaxSeats', count: Number(btn.dataset.seatCount) });
    });
  });

  // --- Sound & Haptik (komplett offline: synthetisierte Töne, kein Audio-Download) ---

  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    return audioCtx;
  }

  function playTone(freqs, durationMs, type = 'sine', gainValue = 0.06) {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const start = now + i * (durationMs / 1000 / freqs.length);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(gainValue, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + durationMs / 1000 / freqs.length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + durationMs / 1000 / freqs.length + 0.02);
    });
  }

  function vibrate(pattern) {
    if (!soundEnabled) return;
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  const sound = {
    pikdame: () => { playTone([98, 147, 98], 520, 'sawtooth', 0.06); vibrate([60, 40, 60, 40, 120]); },
    turn: () => { playTone([523, 659], 180, 'sine', 0.06); vibrate([30, 60, 30]); },
    draw: () => { playTone([320], 90, 'triangle', 0.05); vibrate(8); },
    discard: () => { playTone([260, 180], 110, 'triangle', 0.05); vibrate(12); },
    meld: () => { playTone([440, 554, 660], 220, 'sine', 0.06); vibrate([10, 30, 10]); },
    error: () => { playTone([140], 160, 'square', 0.05); vibrate(40); },
    roundEnd: () => { playTone([392, 494, 587, 784], 420, 'sine', 0.07); vibrate([15, 40, 15, 40]); },
  };

  function setSoundEnabled(enabled) {
    soundEnabled = enabled;
    localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off');
    const toggleBtn = el('soundToggle');
    if (toggleBtn) toggleBtn.textContent = enabled ? '🔊' : '🔇';
    const ruleCheckbox = el('ruleSound');
    if (ruleCheckbox) ruleCheckbox.checked = enabled;
  }
  setSoundEnabled(soundEnabled);

  function wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = window.location.port ? `:${window.location.port}` : '';
    return `${proto}//${window.location.hostname}${port}`;
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    el('connStatus').textContent = 'Verbinde...';

    ws.addEventListener('open', () => {
      el('connStatus').textContent = 'Verbunden.';
      // Automatischer Wiedereintritt NUR, wenn wir bereits Teil einer
      // Session waren (Reconnect nach Verbindungsabbruch oder geteilter
      // Link mit gespeicherter playerId). Ohne Code entscheidet der Nutzer
      // im UI: neues Spiel erstellen oder Code eingeben.
      if (sessionCode && playerId) {
        ws.send(JSON.stringify({ type: 'joinSession', code: sessionCode, playerId, name: myName }));
      }
    });

    ws.addEventListener('close', () => {
      el('connStatus').textContent = 'Verbindung verloren - neuer Versuch in 2s...';
      setTimeout(connect, 2000);
    });

    ws.addEventListener('error', () => {
      el('connStatus').textContent = 'Verbindungsfehler.';
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      handleMessage(msg);
    });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function handleMessage(msg) {
    if (msg.type === 'joined') {
      playerId = msg.playerId;
      sessionCode = msg.sessionCode;
      localStorage.setItem(playerKeyFor(sessionCode), playerId);
      // URL aktualisieren, damit der Link direkt teilbar ist (?session=CODE)
      const url = new URL(window.location.href);
      url.searchParams.set('session', sessionCode);
      history.replaceState(null, '', url.toString());
      renderSessionBanner();
      return;
    }
    if (msg.type === 'error') {
      showHint(msg.error, true);
      return;
    }
    if (msg.type === 'state') {
      lastState = msg.state;
      // "Du bist dran"-Signal: Ton + Vibration + kurzer Puls der Statuszeile,
      // sobald der Zug auf mich wechselt (nicht beim allerersten Render).
      if (
        lastState.phase === 'playing' &&
        lastState.currentPlayerId === playerId &&
        prevTurnPlayerId !== null &&
        prevTurnPlayerId !== playerId
      ) {
        sound.turn();
        const bar = el('topBar');
        bar.classList.remove('yourTurnPulse');
        void bar.offsetWidth; // Animation neu starten
        bar.classList.add('yourTurnPulse');
      }
      prevTurnPlayerId = lastState.currentPlayerId;
      updateWakeLock();
      maybeShowActionToast();
      checkPikdameAnnouncement();
      render();
      return;
    }
    if (msg.type === 'profiles') {
      knownProfiles = msg.players || [];
      // Öffentlicher Server: Profile/Statistik sind deaktiviert.
      publicMode = !!msg.publicMode;
      el('statsBtn').classList.toggle('hidden', publicMode);
      if (!el('statsOverlay').classList.contains('hidden')) renderStats();
      return;
    }
    if (msg.type === 'emote') {
      showEmote(msg.playerId, msg.emoji);
      return;
    }
    if (msg.type === 'gameExport') {
      downloadJson(msg.record, `pikdame-spielverlauf-${new Date(msg.record.finishedAt).toISOString().slice(0, 19)}.json`);
      return;
    }
    if (msg.type === 'meldAmbiguous') {
      showJokerChoice('meld', msg.cardIds, msg.options);
      return;
    }
    if (msg.type === 'layOffAmbiguous') {
      showJokerChoice('layOff', { meldId: msg.meldId, cardId: msg.cardId }, msg.options);
      return;
    }
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- Joker-Mehrdeutigkeit: Nachfrage-Overlay ----------------------------

  function showJokerChoice(kind, context, options) {
    const optionsDiv = el('jokerChoiceOptions');
    optionsDiv.innerHTML = '';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        el('jokerChoiceOverlay').classList.add('hidden');
        sound.meld();
        if (kind === 'meld') {
          send({ type: 'layoutMeld', cardIds: context, jokerAssignments: opt.jokerAssignments });
        } else {
          send({ type: 'layOff', meldId: context.meldId, cardId: context.cardId, asSuit: opt.asSuit, side: opt.side });
        }
        selectedCardIds.clear();
      });
      optionsDiv.appendChild(btn);
    });
    el('jokerChoiceOverlay').classList.remove('hidden');
  }

  el('jokerChoiceCancelBtn').addEventListener('click', () => {
    el('jokerChoiceOverlay').classList.add('hidden');
  });

  // --- Rendering ---------------------------------------------------------

  function suitSymbol(suit) {
    return { H: '♥', D: '♦', C: '♣', S: '♠' }[suit] || '?';
  }
  function suitColor(suit) {
    return suit === 'H' || suit === 'D' ? 'red' : 'black';
  }

  function cardEl(card, { selectable, selected, onClick, compact } = {}) {
    const div = document.createElement('div');
    div.className = compact ? 'card card-compact' : 'card';
    if (card.isJoker) {
      div.classList.add('joker');
      // Ecken-Index oben links, damit der Joker auch bei starker
      // Überlappung im Fächer erkennbar bleibt.
      div.innerHTML = compact
        ? `<div class="corner">🃏</div>`
        : `<div class="corner">🃏</div><div class="suitMark">🃏</div>`;
    } else {
      div.classList.add(suitColor(card.suit));
      // Wie bei echten Spielkarten: Rang + Farbe klein in der linken oberen
      // Ecke - die bleibt bei überlappenden Karten immer sichtbar. Das große
      // Symbol in der Mitte dient der schnellen Orientierung.
      div.innerHTML = compact
        ? `<div class="corner"><span>${card.rank}</span><span>${suitSymbol(card.suit)}</span></div>`
        : `<div class="corner"><span>${card.rank}</span><span>${suitSymbol(card.suit)}</span></div><div class="suitMark">${suitSymbol(card.suit)}</div>`;
      if (card.rank === 'Q' && card.suit === 'S') {
        div.classList.add('pikdame-card');
        if (!compact) {
          const tag = document.createElement('div');
          tag.className = 'pikdame-tag';
          tag.textContent = '100';
          div.appendChild(tag);
        }
      }
    }
    if (selected) div.classList.add('selected');
    if (selectable) {
      div.addEventListener('click', () => onClick && onClick(card));
    }
    return div;
  }

  let soundedForRound = -1;

  function render() {
    if (!lastState) return;

    const inLobby = lastState.phase === 'lobby';
    el('lobby').classList.toggle('hidden', !inLobby);
    el('table').classList.toggle('hidden', inLobby);

    if (inLobby) {
      renderLobby();
      return;
    }

    renderTable();

    if (lastState.phase === 'roundEnd' || lastState.phase === 'gameOver') {
      if (soundedForRound !== lastState.roundNumber) {
        soundedForRound = lastState.roundNumber;
        sound.roundEnd();
      }
      renderResultOverlay();
    } else {
      el('resultOverlay').classList.add('hidden');
    }
  }

  function renderLobby() {
    const humanCount = lastState.players.filter((p) => !p.isBot).length;
    el('lobbyPlayers').innerHTML =
      `${lastState.players.length} Spieler am Tisch` +
      (lastState.players.length
        ? '<br>' + lastState.players.map((p) => `${escapeHtml(p.name)}${p.isBot ? ' (Bot)' : ''}`).join(', ')
        : '');
    el('startBtn').disabled = humanCount === 0;

    const hasJoined = lastState.players.some((p) => p.id === playerId);
    el('seatCountSection').classList.toggle('hidden', !hasJoined);
    el('seatingSection').classList.toggle('hidden', !hasJoined || lastState.players.length === 0);
    el('houseRulesSection').classList.toggle('hidden', !hasJoined);

    document.querySelectorAll('.seatCountBtn').forEach((btn) => {
      const count = Number(btn.dataset.seatCount);
      btn.classList.toggle('active', count === lastState.maxSeats);
      btn.disabled = count < humanCount; // kleiner als bereits beigetretene Spieler nicht wählbar
    });

    renderSeatingList();
  }

  function renderSeatingList() {
    const list = el('seatingList');
    list.innerHTML = '';
    lastState.players.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'seatRow';
      const isDealer = p.id === lastState.dealerId;
      row.innerHTML = `
        <span class="seatName">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>
        <span class="seatControls">
          <button class="btn-icon seatUp" ${idx === 0 ? 'disabled' : ''} title="Nach oben">▲</button>
          <button class="btn-icon seatDown" ${idx === lastState.players.length - 1 ? 'disabled' : ''} title="Nach unten">▼</button>
          <button class="btn-icon seatDealer ${isDealer ? 'active' : ''}" title="Als Geber festlegen">${isDealer ? '⭐' : '☆'}</button>
        </span>`;
      row.querySelector('.seatUp').addEventListener('click', () => moveSeat(idx, -1));
      row.querySelector('.seatDown').addEventListener('click', () => moveSeat(idx, 1));
      row.querySelector('.seatDealer').addEventListener('click', () => send({ type: 'setDealer', playerId: p.id }));
      list.appendChild(row);
    });
  }

  function moveSeat(idx, dir) {
    const order = lastState.players.map((p) => p.id);
    const target = idx + dir;
    if (target < 0 || target >= order.length) return;
    [order[idx], order[target]] = [order[target], order[idx]];
    send({ type: 'reorderSeats', order });
  }


  function collectHouseRules() {
    return {
      handAusDoubles: el('ruleHandAus').checked,
      strictThreshold: el('ruleStrict1000').checked,
    };
  }

  function renderTable() {
    el('roundInfo').textContent = `Runde ${lastState.roundNumber}`;
    const myTotal = (lastState.totals && lastState.totals[playerId]) || 0;
    el('myScore').textContent = `${myTotal} Pkt`;
    const dealer = lastState.players.find((p) => p.id === lastState.dealerId);
    const iAmDealer = dealer && dealer.id === playerId;
    el('dealerInfo').textContent = `Geber: ${iAmDealer ? 'du ⭐' : dealer ? dealer.name : '–'}`;
    const cp = lastState.players.find((p) => p.id === lastState.currentPlayerId);
    const isMyTurn = lastState.currentPlayerId === playerId;
    el('turnInfo').textContent = isMyTurn
      ? `Du bist am Zug (${phaseLabel(lastState.turnPhase)})`
      : `${cp ? cp.name : '?'} ist am Zug`;
    // Als Geber wird die Topbar-Zeile zu voll und "Du bist am Zug" wurde
    // abgeschnitten - dann rutscht der Text in eine eigene zweite Zeile.
    el('topBar').classList.toggle('dealerSelf', !!(iAmDealer && isMyTurn));

    // Gegner
    const opponentsDiv = el('opponents');
    opponentsDiv.innerHTML = '';
    lastState.players
      .filter((p) => p.id !== playerId)
      .forEach((p) => {
        const d = document.createElement('div');
        d.className =
          'opponent' +
          (p.id === lastState.currentPlayerId ? ' active' : '') +
          (p.id === meldFilterPlayerId ? ' meldFilterActive' : '');
        d.dataset.playerId = p.id;
        // Klick auf den Namen: nur die Auslagen dieses Spielers zeigen
        // (erneuter Klick: wieder alle).
        d.addEventListener('click', () => {
          meldFilterPlayerId = meldFilterPlayerId === p.id ? null : p.id;
          render();
        });
        const reconnecting = !p.isBot && p.controlledByBot;
        const opTotal = (lastState.totals && lastState.totals[p.id]) || 0;
        d.innerHTML = `<div class="opName">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}${reconnecting ? ' <span class="reconnectTag">⏳ getrennt – Bot übernimmt</span>' : ''}</div><div class="opCount">${p.handCount} Karten · ${opTotal} Pkt</div>`;
        opponentsDiv.appendChild(d);
      });

    // Auslagen
    const meldsDiv = el('melds');
    meldsDiv.innerHTML = '';
    // Auslagen nach BESITZER gruppiert (jeder Spieler hat seinen eigenen
    // Stapel!). Reihenfolge: eigene zuerst, danach die Mitspieler in
    // umgekehrter Zugrichtung - also der Spieler direkt VOR mir zuerst.
    // Der hat zuletzt gelegt und ist taktisch am relevantesten (liegen bei
    // ihm z.B. schon vier Sechsen, ist eine 6 gefahrloser abzuwerfen).
    const players = lastState.players;
    const myIdx = players.findIndex((p) => p.id === playerId);
    const ownerOrder = [];
    if (myIdx >= 0) {
      ownerOrder.push(players[myIdx]);
      for (let step = 1; step < players.length; step++) {
        ownerOrder.push(players[((myIdx - step) % players.length + players.length) % players.length]);
      }
    } else {
      ownerOrder.push(...players);
    }

    // Filter zurücksetzen, wenn der gefilterte Spieler nicht mehr existiert
    if (meldFilterPlayerId && !players.some((p) => p.id === meldFilterPlayerId)) {
      meldFilterPlayerId = null;
    }
    // Aktiver Filter: Hinweiszeile zum Zurücksetzen
    if (meldFilterPlayerId) {
      const filterOwner = players.find((p) => p.id === meldFilterPlayerId);
      const bar = document.createElement('div');
      bar.className = 'meldFilterBar';
      bar.textContent = `Nur Auslagen von ${filterOwner.id === playerId ? 'dir' : filterOwner.name} – tippen für alle`;
      bar.addEventListener('click', () => { meldFilterPlayerId = null; render(); });
      meldsDiv.appendChild(bar);
    }

    ownerOrder.forEach((owner) => {
      if (meldFilterPlayerId && owner.id !== meldFilterPlayerId) return;
      const ownerMelds = lastState.tableMelds.filter((m) => m.ownerId === owner.id);
      if (ownerMelds.length === 0) {
        if (meldFilterPlayerId === owner.id) {
          const empty = document.createElement('div');
          empty.className = 'meldOwnerHeader';
          empty.textContent = `${owner.id === playerId ? 'Du hast' : owner.name + ' hat'} noch nichts ausgelegt.`;
          meldsDiv.appendChild(empty);
        }
        return;
      }
      const isMine = owner.id === playerId;

      const section = document.createElement('div');
      section.className = 'meldOwnerGroup' + (isMine ? ' own' : '');
      const header = document.createElement('div');
      header.className = 'meldOwnerHeader';
      header.innerHTML = isMine
        ? 'Deine Auslagen'
        : `Auslagen von ${escapeHtml(owner.name)}${owner.isBot ? ' 🤖' : ''}`;
      header.addEventListener('click', () => {
        meldFilterPlayerId = meldFilterPlayerId === owner.id ? null : owner.id;
        render();
      });
      section.appendChild(header);

      // Kombinationen NEBENEINANDER anzeigen - umbrechen erst, wenn der
      // Platz nicht mehr reicht (flex-wrap im meldRow-Container).
      const row = document.createElement('div');
      row.className = 'meldRow';
      ownerMelds.forEach((meld) => {
        const group = document.createElement('div');
        group.className = 'meldGroup';
        meld.slots.forEach((slot) => {
          const card = slot.real || { isJoker: true, rank: slot.representsRank, suit: slot.representsSuit, _isJokerSlot: true };
          const cEl = cardEl(card, {
            // Nur die EIGENEN Auslagen sind interaktiv - mit fremden
            // Stapeln gibt es keinerlei Interaktion (weder Anlegen noch
            // Joker-Tausch).
            selectable: isMine && isMyTurn && lastState.turnPhase === 'meld',
            onClick: () => onMeldCardClick(meld),
            compact: true,
          });
          group.appendChild(cEl);
        });
        row.appendChild(group);
      });
      section.appendChild(row);
      meldsDiv.appendChild(section);
    });

    // Ausgetauschte Joker (dauerhaft aus dem Spiel, nur sichtbar liegend)
    const retiredDiv = el('retiredJokersBar');
    if (lastState.retiredJokers && lastState.retiredJokers.length > 0) {
      retiredDiv.innerHTML =
        `<span>Ausgeschiedene Joker:</span>` +
        lastState.retiredJokers.map(() => `<span class="joker-mini">🃏</span>`).join('');
    } else {
      retiredDiv.innerHTML = '';
    }

    // Stapel
    el('drawCount').textContent = lastState.drawPileCount;
    const drawCardDiv = el('drawPile').querySelector('.pile-card');
    drawCardDiv.classList.toggle('stacked-2', lastState.drawPileCount > 15);
    drawCardDiv.classList.toggle('stacked-1', lastState.drawPileCount > 1 && lastState.drawPileCount <= 15);

    const discardTopDiv = el('discardTopCard');
    discardTopDiv.innerHTML = '';
    discardTopDiv.className = 'pile-card';
    if (lastState.discardTop && !lastState.discardTop.faceDown) {
      const t = lastState.discardTop;
      discardTopDiv.classList.add(t.isJoker ? 'joker' : suitColor(t.suit));
      discardTopDiv.textContent = t.isJoker ? '🃏' : `${t.rank}${suitSymbol(t.suit)}`;
    } else if (lastState.discardTop) {
      discardTopDiv.classList.add('back');
    } else {
      discardTopDiv.classList.add('empty');
      discardTopDiv.textContent = 'leer';
    }
    // Stapel-Tiefe visuell: mehr Karten = mehr sichtbare Ebenen unter der obersten
    discardTopDiv.classList.toggle('stacked-2', lastState.discardPileCount > 6);
    discardTopDiv.classList.toggle(
      'stacked-1',
      lastState.discardPileCount > 1 && lastState.discardPileCount <= 6
    );
    el('discardCount').textContent = lastState.discardPileCount > 0 ? lastState.discardPileCount : '';
    // Pop-Animation, wenn eine neue Karte oben liegt (z.B. Gegner-Abwurf)
    const topId = lastState.discardTop ? lastState.discardTop.id || 'facedown' : null;
    if (topId && topId !== prevDiscardTopId && prevDiscardTopId !== undefined) {
      discardTopDiv.classList.remove('pop');
      void discardTopDiv.offsetWidth;
      discardTopDiv.classList.add('pop');
    }
    prevDiscardTopId = topId;

    const canDraw = isMyTurn && lastState.turnPhase === 'draw';
    el('drawPile').classList.toggle('disabled', !canDraw || lastState.drawPileCount === 0);
    el('discardPile').classList.toggle('disabled', !canDraw || !lastState.discardTop);
    // Sanfter Glow signalisiert: jetzt darfst du ziehen
    el('drawPile').classList.toggle('glow', canDraw && lastState.drawPileCount > 0);
    el('discardPile').classList.toggle('glow', canDraw && !!lastState.discardTop);

    // Hand
    const myPlayer = lastState.players.find((p) => p.id === playerId);
    const handDiv = el('hand');
    handDiv.innerHTML = '';
    if (myPlayer && myPlayer.hand) {
      // Neue Karten seit dem letzten Render ermitteln (Ziehen/Stapelaufnahme).
      const currentIds = new Set(myPlayer.hand.map((c) => c.id));
      const isNewRound = prevHandRound !== lastState.roundNumber;
      if (isNewRound || prevHandIds.size === 0) {
        freshCardIds = new Set(); // Erstverteilung nicht markieren
      } else {
        const added = myPlayer.hand.filter((c) => !prevHandIds.has(c.id)).map((c) => c.id);
        if (added.length > 0) freshCardIds = new Set(added);
        // Markierung erlischt, sobald die Karte die Hand verlässt
        for (const id of [...freshCardIds]) if (!currentIds.has(id)) freshCardIds.delete(id);
      }
      prevHandIds = currentIds;
      prevHandRound = lastState.roundNumber;
      // Hand sortieren - umschaltbar: nach Farbe (gut für Folgen) oder nach
      // Wert (gut für Sätze). Joker immer ans Ende.
      const sorted = myPlayer.hand.slice().sort((a, b) => {
        if (a.isJoker && b.isJoker) return 0;
        if (a.isJoker) return 1;
        if (b.isJoker) return -1;
        if (handSortMode === 'rank') {
          const dr = RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
          if (dr !== 0) return dr;
          return a.suit.localeCompare(b.suit);
        }
        if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
        return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
      });
      sorted.forEach((card, idx) => {
        const cEl = cardEl(card, {
          selectable: isMyTurn && lastState.turnPhase === 'meld',
          selected: selectedCardIds.has(card.id),
          onClick: () => onHandCardClick(card),
        });
        // Gerade gezogene/aufgenommene Karte sichtbar machen
        if (freshCardIds.has(card.id)) cEl.classList.add('just-drawn');
        // Fächer-Optik: Karten leicht um die Mitte der Hand rotiert + angehoben.
        // Rotation flacht bei vielen Karten ab, sonst wird der Fächer unleserlich.
        const mid = (sorted.length - 1) / 2;
        const offset = idx - mid;
        const rotFactor = Math.min(3.5, 42 / Math.max(sorted.length, 1));
        const rotate = Math.max(-10, Math.min(10, offset * rotFactor));
        const lift = Math.abs(offset) * 2;
        cEl.style.transform = `rotate(${rotate}deg) translateY(${lift}px)`;
        if (selectedCardIds.has(card.id)) {
          cEl.style.transform += ' translateY(-18px)';
        }
        handDiv.appendChild(cEl);
      });

      // Dynamische Überlappung: die gesamte Hand passt IMMER auf die
      // Bildschirmbreite - kein horizontales Scrollen. Je mehr Karten,
      // desto stärker überlappen sie; der Ecken-Index oben links bleibt
      // dabei stets sichtbar. Mindestens 14px sichtbarer Streifen.
      requestAnimationFrame(() => {
        const cards = [...handDiv.children];
        if (cards.length < 2) return;
        const cardWidth = cards[0].offsetWidth || 60;
        const available = handDiv.parentElement.clientWidth - 64; // Padding + Rotations-Überhang
        const naturalVisible = cardWidth * 0.62; // lockerer Fächer, wenn Platz da ist
        const fitVisible = (available - cardWidth) / (cards.length - 1);
        const visible = Math.max(14, Math.min(naturalVisible, fitVisible));
        const overlap = visible - cardWidth;
        cards.forEach((c, i) => {
          c.style.marginLeft = i === 0 ? '0' : `${overlap}px`;
        });
      });
    }

    const showMeldControls = isMyTurn && lastState.turnPhase === 'meld' && selectedCardIds.size >= 3;
    el('confirmMeldBtn').classList.toggle('hidden', !showMeldControls);

    const showDiscardBtn =
      isMyTurn && lastState.turnPhase === 'meld' && selectedCardIds.size === 1 && !lastState.mustLayOffCardId;
    el('discardBtn').classList.toggle('hidden', !showDiscardBtn);

    el('clearSelectionBtn').classList.toggle('hidden', selectedCardIds.size === 0);
    el('forfeitBtn').classList.toggle('hidden', lastState.phase !== 'playing');

    if (lastState.mustLayOffCardId && isMyTurn) {
      showHint('Pflicht: Die aufgenommene Ablagekarte muss zuerst ausgelegt/angelegt werden.', false);
    } else if (isMyTurn && lastState.turnPhase === 'meld') {
      showHint('Karte(n) wählen: 3+ auswählen zum Auslegen, 1 auswählen + "Abwerfen", oder auf eine Auslage tippen zum Anlegen.', false);
    } else {
      clearHintIfNotError();
    }

    // Platz sparen: die Action-Leiste komplett einklappen, wenn sie nichts
    // Sichtbares enthaelt (der Aufgeben-Button lebt jetzt ueber der Hand).
    // WICHTIG: erst NACH der Hint-Logik pruefen, sonst zaehlt der alte Text.
    const actionBarEmpty =
      !showMeldControls && !showDiscardBtn && selectedCardIds.size === 0 && !el('hint').textContent;
    el('actionBar').classList.toggle('collapsed', actionBarEmpty);

    // Log
    const logEntries = el('logEntries');
    logEntries.innerHTML = '';
    (lastState.log || [])
      .slice()
      .reverse()
      .forEach((entry) => {
        const d = document.createElement('div');
        d.textContent = entry.text;
        logEntries.appendChild(d);
      });
  }

  const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  function phaseLabel(phase) {
    return phase === 'draw' ? 'Karte ziehen' : 'Auslegen/Abwerfen';
  }

  let hintIsError = false;
  function showHint(text, isError) {
    el('hint').textContent = text;
    el('hint').classList.toggle('error', !!isError);
    hintIsError = isError;
    if (isError) {
      sound.error();
      setTimeout(() => {
        if (hintIsError) {
          el('hint').textContent = '';
          hintIsError = false;
          el('hint').classList.remove('error');
        }
      }, 3000);
    }
  }
  function clearHintIfNotError() {
    if (!hintIsError) el('hint').textContent = '';
  }

  function renderResultOverlay() {
    if (!lastState.lastRoundResult) return;
    el('resultOverlay').classList.remove('hidden');
    const isGameOver = lastState.phase === 'gameOver';
    el('resultTitle').textContent = isGameOver ? 'Spielende!' : 'Rundenende';

    const body = el('resultBody');
    body.innerHTML = '';

    if (lastState.lastRoundWasHandAus) {
      const handAusNote = document.createElement('p');
      handAusNote.className = 'handAusNote';
      handAusNote.textContent = '🎉 Hand aus! Die komplette Rundenwertung zählt doppelt.';
      body.appendChild(handAusNote);
    }
    if (lastState.lastRoundForfeitedBy) {
      const forfeiter = lastState.players.find((p) => p.id === lastState.lastRoundForfeitedBy);
      const forfeitNote = document.createElement('p');
      forfeitNote.className = 'handAusNote';
      forfeitNote.textContent = `🏳️ ${forfeiter ? forfeiter.name : 'Ein Spieler'} hat die Runde aufgegeben. Wertung wie ein normaler Mitspieler, kein Gewinner-Bonus.`;
      body.appendChild(forfeitNote);
    }

    lastState.players.forEach((p) => {
      const r = lastState.lastRoundResult[p.id];
      const row = document.createElement('div');
      row.className = 'resultRow' + (r && r.breakdown.isWinner ? ' winner' : '');
      const total = lastState.totals[p.id] || 0;
      row.innerHTML = `<span>${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span><span>${r ? r.roundScore : 0} Pkt (Gesamt: ${total})</span>`;
      body.appendChild(row);
    });

    // Rundenstatistiken (Details)
    if (lastState.lastRoundStats) {
      const statsTable = document.createElement('table');
      statsTable.className = 'statsTable';
      statsTable.innerHTML = `
        <thead><tr><th>Spieler</th><th>Ausgelegt</th><th>Auf Hand</th><th>♠Q</th><th>🃏</th></tr></thead>
        <tbody>${lastState.lastRoundStats
          .map(
            (s) =>
              `<tr><td>${escapeHtml(s.name)}</td><td>${s.laidOutCount}</td><td>${s.handCount}</td><td>${s.pikDameCount}</td><td>${s.jokerInHandCount}</td></tr>`
          )
          .join('')}</tbody>`;
      body.appendChild(statsTable);
    }

    // Punkteverlauf über alle Runden als kleines SVG-Chart (ab 2 Runden)
    const history = lastState.scoreHistory || [];
    if (history.length >= 2) {
      body.appendChild(renderScoreChart(history));
    }

    if (isGameOver && lastState.gameOverInfo) {
      const winner = lastState.players.find((p) => p.id === lastState.gameOverInfo.winnerId);
      const winLine = document.createElement('p');
      winLine.innerHTML = `<strong>🏆 ${escapeHtml(winner ? winner.name : '?')} gewinnt das Spiel!</strong>`;
      body.appendChild(winLine);
    }

    el('exportGameBtn').classList.toggle('hidden', !(isGameOver && lastState.hasExportableGame));
    el('resultContinueBtn').textContent = isGameOver ? 'Neue Partie (Rematch)' : 'Nächste Runde';
  }

  // --- Interaktion ---------------------------------------------------------

  function onHandCardClick(card) {
    if (!lastState) return;
    const isMyTurn = lastState.currentPlayerId === playerId;
    if (!isMyTurn || lastState.turnPhase !== 'meld') return;

    if (selectedCardIds.has(card.id)) {
      selectedCardIds.delete(card.id);
    } else {
      selectedCardIds.add(card.id);
    }
    render();
  }

  function onMeldCardClick(meld) {
    if (!lastState) return;
    const isMyTurn = lastState.currentPlayerId === playerId;
    if (!isMyTurn || lastState.turnPhase !== 'meld') return;

    if (selectedCardIds.size === 1) {
      const cardId = [...selectedCardIds][0];
      // Enthält die Auslage einen Joker, der GENAU die gewählte Handkarte
      // repräsentiert, ist der Joker-Tausch gemeint (exakt dieselbe Prüfung
      // wie tryJokerSwap auf dem Server). Andernfalls normales Anlegen.
      const myPlayer = lastState.players.find((p) => p.id === playerId);
      const card = myPlayer && myPlayer.hand ? myPlayer.hand.find((c) => c.id === cardId) : null;
      const matchesJokerSlot =
        card && !card.isJoker &&
        meld.slots.some((s) => s.joker && s.representsRank === card.rank && s.representsSuit === card.suit);
      if (matchesJokerSlot) {
        send({ type: 'swapJoker', meldId: meld.id, handCardId: cardId });
      } else {
        send({ type: 'layOff', meldId: meld.id, cardId });
      }
      selectedCardIds.clear();
    } else {
      showHint('Wähle genau eine Handkarte aus, um sie an diese Auslage anzulegen (oder gegen einen passenden Joker zu tauschen).', false);
    }
  }

  el('nameInput').value = myName;
  if (sessionCode) el('codeInput').value = sessionCode;

  function currentName() {
    myName = el('nameInput').value.trim() || `Spieler${Math.floor(Math.random() * 1000)}`;
    localStorage.setItem(NAME_KEY, myName);
    return myName;
  }

  el('createGameBtn').addEventListener('click', () => {
    send({ type: 'createSession', name: currentName() });
  });

  // Desktop-Tastatur: Enter im Code-Feld tritt bei, Enter im Namensfeld
  // erstellt ein Spiel (bzw. tritt bei, wenn schon ein Code eingegeben ist).
  el('codeInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('joinGameBtn').click();
  });
  el('nameInput').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (el('codeInput').value.trim()) el('joinGameBtn').click();
    else el('createGameBtn').click();
  });

  el('joinGameBtn').addEventListener('click', () => {
    const code = el('codeInput').value.trim().toUpperCase();
    if (!code) {
      showHint('Bitte den Spiel-Code eingeben.', true);
      return;
    }
    const storedId = localStorage.getItem(playerKeyFor(code));
    send({ type: 'joinSession', code, name: currentName(), playerId: storedId || undefined });
  });

  el('updateNameBtn').addEventListener('click', () => {
    if (!sessionCode || !playerId) return;
    send({ type: 'joinSession', code: sessionCode, playerId, name: currentName() });
  });

  el('shareCodeBtn').addEventListener('click', async () => {
    if (!sessionCode) return;
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionCode);
    const shareData = {
      title: 'Pik Dame',
      text: `Spiel mit! Code: ${sessionCode}`,
      url: url.toString(),
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (e) {
        /* Nutzer hat das Teilen abgebrochen */
      }
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(`${shareData.text} - ${shareData.url}`);
      showHint('Link kopiert!', false);
    }
  });

  function renderSessionBanner() {
    const inSession = !!sessionCode && !!playerId;
    el('sessionSetup').classList.toggle('hidden', inSession);
    el('sessionBanner').classList.toggle('hidden', !inSession);
    if (inSession) {
      el('sessionCodeText').textContent = sessionCode;
      el('startBtn').disabled = false;
    }
  }
  renderSessionBanner();

  el('startBtn').addEventListener('click', () => {
    send({ type: 'startGame', houseRules: collectHouseRules() });
  });


  el('sortToggleBtn').addEventListener('click', () => {
    handSortMode = handSortMode === 'suit' ? 'rank' : 'suit';
    localStorage.setItem(SORT_KEY, handSortMode);
    updateSortToggleLabel();
    render();
  });
  function updateSortToggleLabel() {
    el('sortToggleBtn').textContent = handSortMode === 'suit' ? '♠♥ Farbe' : '77 Wert';
    el('sortToggleBtn').title = handSortMode === 'suit'
      ? 'Sortiert nach Farbe (gut für Folgen) - tippen für Wert'
      : 'Sortiert nach Wert (gut für Sätze) - tippen für Farbe';
  }
  updateSortToggleLabel();

  el('drawPile').addEventListener('click', () => {
    if (el('drawPile').classList.contains('disabled')) return;
    sound.draw();
    flyCard(el('drawPile'), el('hand'), true);
    send({ type: 'drawFromPile' });
  });

  el('discardPile').addEventListener('click', () => {
    if (el('discardPile').classList.contains('disabled')) return;
    sound.draw();
    flyCard(el('discardPile'), el('hand'), false);
    send({ type: 'drawFromDiscard' });
  });

  function performDiscard(cardId) {
    sound.discard();
    const selectedEl = document.querySelector('#hand .card.selected');
    flyCard(selectedEl, el('discardPile'), false);
    send({ type: 'discard', cardId });
    selectedCardIds.clear();
    render();
  }

  el('discardBtn').addEventListener('click', () => {
    if (selectedCardIds.size !== 1) return;
    const cardId = [...selectedCardIds][0];
    // Abwurf-Schutz: Pik Dame (100 Punkte!) und Joker nicht aus Versehen
    // abwerfen - der Gegner würde sich freuen.
    const myPlayer = lastState && lastState.players.find((p) => p.id === playerId);
    const card = myPlayer && myPlayer.hand ? myPlayer.hand.find((cd) => cd.id === cardId) : null;
    const isPikDame = card && card.rank === 'Q' && card.suit === 'S';
    if (card && (isPikDame || card.isJoker)) {
      el('confirmDiscardTitle').textContent = isPikDame ? 'Pik Dame abwerfen?' : 'Joker abwerfen?';
      el('confirmDiscardText').textContent = isPikDame
        ? 'Die Pik Dame ist 100 Punkte wert - und der nächste Spieler könnte sie aufnehmen!'
        : 'Der Joker ist die flexibelste Karte im Spiel - und der nächste Spieler könnte ihn aufnehmen!';
      pendingConfirmDiscardId = cardId;
      el('confirmDiscardOverlay').classList.remove('hidden');
      return;
    }
    performDiscard(cardId);
  });

  let pendingConfirmDiscardId = null;
  el('confirmDiscardYesBtn').addEventListener('click', () => {
    el('confirmDiscardOverlay').classList.add('hidden');
    if (pendingConfirmDiscardId) performDiscard(pendingConfirmDiscardId);
    pendingConfirmDiscardId = null;
  });
  el('confirmDiscardNoBtn').addEventListener('click', () => {
    el('confirmDiscardOverlay').classList.add('hidden');
    pendingConfirmDiscardId = null;
  });

  el('forfeitBtn').addEventListener('click', () => {
    if (!lastState || lastState.phase !== 'playing') return;
    const confirmed = window.confirm(
      'Runde wirklich aufgeben? Du wirst wie ein normaler Mitspieler gewertet (Ausgelegtes minus Resthand) - ohne Gewinner-Bonus für irgendwen.'
    );
    if (confirmed) {
      sound.discard();
      send({ type: 'forfeitRound' });
    }
  });

  el('confirmMeldBtn').addEventListener('click', () => {
    if (selectedCardIds.size < 3) return;
    sound.meld();
    send({ type: 'layoutMeld', cardIds: [...selectedCardIds] });
    selectedCardIds.clear();
  });

  el('clearSelectionBtn').addEventListener('click', () => {
    selectedCardIds.clear();
    render();
  });

  el('logToggle').addEventListener('click', () => {
    el('logPanel').classList.toggle('hidden');
  });

  el('soundToggle').addEventListener('click', () => {
    setSoundEnabled(!soundEnabled);
  });

  el('ruleSound').addEventListener('change', () => {
    setSoundEnabled(el('ruleSound').checked);
  });

  el('resultContinueBtn').addEventListener('click', () => {
    const isGameOver = lastState && lastState.phase === 'gameOver';
    send({ type: isGameOver ? 'rematch' : 'nextRound' });
    el('resultOverlay').classList.add('hidden');
  });

  el('exportGameBtn').addEventListener('click', () => {
    send({ type: 'exportLastGame' });
  });

  // --- Ablagestapel-Vorschau -----------------------------------------------
  // Alle Karten des Ablagestapels wurden offen abgelegt - die Vorschau ist
  // eine Gedächtnishilfe (oberste zuerst). Der 👁-Button ist ein eigenes
  // Tap-Ziel, damit er nicht mit dem Ziehen kollidiert.
  el('discardPreviewBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    renderDiscardPreview();
    el('discardPreviewOverlay').classList.remove('hidden');
  });
  el('discardPreviewCloseBtn').addEventListener('click', () => {
    el('discardPreviewOverlay').classList.add('hidden');
  });
  el('discardPreviewOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('discardPreviewOverlay')) {
      el('discardPreviewOverlay').classList.add('hidden');
    }
  });

  function renderDiscardPreview() {
    const cardsDiv = el('discardPreviewCards');
    cardsDiv.innerHTML = '';
    const cards = (lastState && lastState.discardCards) || [];
    el('discardPreviewCount').textContent = `(${cards.length} ${cards.length === 1 ? 'Karte' : 'Karten'})`;
    if (cards.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'lobby-hint';
      empty.textContent = 'Der Ablagestapel ist leer.';
      cardsDiv.appendChild(empty);
      return;
    }
    cards.forEach((card, idx) => {
      if (card.faceDown) {
        const d = document.createElement('div');
        d.className = 'card card-compact';
        d.innerHTML = '<div class="corner">?</div>';
        cardsDiv.appendChild(d);
        return;
      }
      const cEl = cardEl(card, { compact: true });
      if (idx === 0) cEl.classList.add('previewTop');
      cardsDiv.appendChild(cEl);
    });
  }

  // --- Punkteverlauf-Chart ---------------------------------------------------
  const CHART_COLORS = ['#2fd6b0', '#8f90f8', '#ff9f5a', '#ff7d8c'];
  function renderScoreChart(history) {
    const wrap = document.createElement('div');
    wrap.className = 'scoreChart';
    const title = document.createElement('div');
    title.className = 'scoreChartTitle';
    title.textContent = 'Punkteverlauf';
    wrap.appendChild(title);

    const W = 300;
    const H = 130;
    const PAD = { l: 34, r: 8, t: 8, b: 18 };
    const players = lastState.players;
    const allValues = history.flatMap((h) => players.map((p) => h.totals[p.id] || 0));
    const maxV = Math.max(10, ...allValues);
    const minV = Math.min(0, ...allValues);
    const x = (i) => PAD.l + (i / Math.max(1, history.length - 1)) * (W - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - (v - minV) / (maxV - minV || 1)) * (H - PAD.t - PAD.b);

    const svgParts = [];
    // Nulllinie + Gitter (Min/Mitte/Max)
    for (const v of [minV, (minV + maxV) / 2, maxV]) {
      svgParts.push(`<line x1="${PAD.l}" y1="${y(v)}" x2="${W - PAD.r}" y2="${y(v)}" class="gridLine"/>`);
      svgParts.push(`<text x="${PAD.l - 5}" y="${y(v) + 3}" class="axisLabel" text-anchor="end">${Math.round(v)}</text>`);
    }
    players.forEach((p, pi) => {
      const color = CHART_COLORS[pi % CHART_COLORS.length];
      const points = history.map((h, i) => `${x(i).toFixed(1)},${y(h.totals[p.id] || 0).toFixed(1)}`).join(' ');
      svgParts.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
      const last = history[history.length - 1];
      svgParts.push(`<circle cx="${x(history.length - 1).toFixed(1)}" cy="${y(last.totals[p.id] || 0).toFixed(1)}" r="3.4" fill="${color}"/>`);
    });
    // Runden-Beschriftung (erste/letzte)
    svgParts.push(`<text x="${x(0)}" y="${H - 4}" class="axisLabel" text-anchor="middle">R${history[0].round}</text>`);
    svgParts.push(`<text x="${x(history.length - 1)}" y="${H - 4}" class="axisLabel" text-anchor="middle">R${history[history.length - 1].round}</text>`);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.classList.add('scoreChartSvg');
    svg.innerHTML = svgParts.join('');
    wrap.appendChild(svg);

    const legend = document.createElement('div');
    legend.className = 'scoreChartLegend';
    legend.innerHTML = players
      .map((p, pi) => `<span><i style="background:${CHART_COLORS[pi % CHART_COLORS.length]}"></i>${escapeHtml(p.name)}</span>`)
      .join('');
    wrap.appendChild(legend);
    return wrap;
  }

  // --- Karten-Flug-Animation -------------------------------------------------
  // Kleine "Geister-Karte", die vom Start- zum Zielrechteck fliegt. Nur
  // Deko - der echte Zustand kommt weiterhin vom Server-Broadcast.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function flyCard(fromEl, toEl, faceDown) {
    if (reducedMotion || !fromEl || !toEl) return;
    const from = fromEl.getBoundingClientRect();
    const to = toEl.getBoundingClientRect();
    if (!from.width || !to.width) return;
    const ghost = document.createElement('div');
    ghost.className = 'flyCard' + (faceDown ? ' back' : '');
    ghost.style.left = `${from.left + from.width / 2 - 26}px`;
    ghost.style.top = `${from.top + from.height / 2 - 36}px`;
    document.body.appendChild(ghost);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    requestAnimationFrame(() => {
      ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(8deg) scale(0.85)`;
      ghost.style.opacity = '0';
    });
    setTimeout(() => ghost.remove(), 480);
  }

  // --- Toast: letzte Aktion kurz einblenden ---------------------------------
  let seenLogLength = null;
  function maybeShowActionToast() {
    const log = (lastState && lastState.log) || [];
    if (seenLogLength === null) {
      seenLogLength = log.length; // erstes Render: nichts nachreichen
      return;
    }
    if (log.length > seenLogLength) {
      const latest = log[log.length - 1];
      seenLogLength = log.length;
      if (latest && latest.text) showToast(latest.text);
    } else {
      seenLogLength = log.length;
    }
  }
  let toastTimer = null;
  function showToast(text) {
    const container = el('toastContainer');
    container.textContent = text;
    container.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => container.classList.remove('visible'), 2600);
  }

  // --- Vollbild ("Kiosk-Modus" wie bei Videos) -------------------------------
  // Fullscreen-API gibt es auf Android/Desktop (Chrome/Edge/Firefox). iOS
  // Safari unterstützt sie für Webseiten nicht - dort bleibt der Button
  // verborgen (der PWA-Homescreen-Modus übernimmt das auf dem iPhone).
  const fsRoot = document.documentElement;
  if (fsRoot.requestFullscreen) {
    el('fullscreenBtn').classList.remove('hidden');
    el('fullscreenBtn').addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        fsRoot.requestFullscreen().catch(() => {});
      }
    });
    document.addEventListener('fullscreenchange', () => {
      el('fullscreenBtn').textContent = document.fullscreenElement ? '⛶✕' : '⛶';
      el('fullscreenBtn').title = document.fullscreenElement ? 'Vollbild verlassen' : 'Vollbild';
    });
  }

  // --- Wake Lock: Display bleibt während des Spielens an -------------------
  // (iOS ab 16.4; wo nicht unterstützt, passiert einfach nichts.)
  let wakeLock = null;
  async function updateWakeLock() {
    const wantLock = lastState && lastState.phase === 'playing' && document.visibilityState === 'visible';
    try {
      if (wantLock && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!wantLock && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) {
      wakeLock = null; // z.B. Energiesparmodus - kein Drama
    }
  }
  document.addEventListener('visibilitychange', updateWakeLock);

  // --- QR-Code zum Beitreten ------------------------------------------------
  el('showQrBtn').addEventListener('click', () => {
    if (!sessionCode || typeof qrcode !== 'function') return;
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionCode);
    const link = url.toString();
    const qr = qrcode(0, 'M'); // Version automatisch, Fehlerkorrektur M
    qr.addData(link);
    qr.make();
    // Als skalierbares SVG rendern (scharf auf jedem Display)
    el('qrCodeBox').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
    el('qrLinkText').textContent = link;
    el('qrOverlay').classList.remove('hidden');
  });
  el('qrCloseBtn').addEventListener('click', () => el('qrOverlay').classList.add('hidden'));
  el('qrOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('qrOverlay')) el('qrOverlay').classList.add('hidden');
  });

  // --- Pik-Dame-Ankündigung (Raid-Warning) -----------------------------------
  function collectTablePikdames() {
    const found = new Map(); // cardId -> ownerId
    for (const meld of lastState.tableMelds || []) {
      for (const slot of meld.slots || []) {
        if (slot.real && slot.real.rank === 'Q' && slot.real.suit === 'S') {
          found.set(slot.real.id, meld.ownerId);
        }
      }
    }
    return found;
  }

  function checkPikdameAnnouncement() {
    if (!lastState || lastState.phase !== 'playing') {
      prevTablePikdameIds = null;
      return;
    }
    const current = collectTablePikdames();
    const isNewRound = prevPikdameRound !== lastState.roundNumber;
    if (prevTablePikdameIds !== null && !isNewRound) {
      for (const [cardId, ownerId] of current) {
        if (!prevTablePikdameIds.has(cardId)) {
          const owner = lastState.players.find((p) => p.id === ownerId);
          const isMe = ownerId === playerId;
          showRaidWarning(
            '♠ PIK DAME! ♠',
            isMe ? 'Du sicherst dir 100 Punkte!' : `${owner ? owner.name : '?'} sichert sich 100 Punkte!`
          );
          break; // eine Ankündigung reicht, auch wenn beide PD gleichzeitig fallen
        }
      }
    }
    prevTablePikdameIds = new Set(current.keys());
    prevPikdameRound = lastState.roundNumber;
  }

  function showRaidWarning(title, sub) {
    document.querySelectorAll('.raidWarning').forEach((n) => n.remove());
    const w = document.createElement('div');
    w.className = 'raidWarning';
    const t = document.createElement('div');
    t.className = 'rwTitle';
    t.textContent = title;
    const s = document.createElement('div');
    s.className = 'rwSub';
    s.textContent = sub;
    w.appendChild(t);
    w.appendChild(s);
    document.body.appendChild(w);
    sound.pikdame();
    setTimeout(() => w.remove(), 2500);
  }

  // --- Emotes -----------------------------------------------------------------
  el('emoteBtn').addEventListener('click', () => {
    el('emoteBar').classList.toggle('hidden');
  });
  document.querySelectorAll('.emoteChoice').forEach((btn) => {
    btn.addEventListener('click', () => {
      send({ type: 'emote', emoji: btn.dataset.emote });
      el('emoteBar').classList.add('hidden');
    });
  });

  function showEmote(fromPlayerId, emoji) {
    // Ziel: der Chip des Absenders; eigene Emotes schweben über der Hand.
    let anchor = document.querySelector(`#opponents .opponent[data-player-id="${CSS.escape(fromPlayerId)}"]`);
    if (fromPlayerId === playerId) anchor = el('handWrapper');
    const rect = anchor ? anchor.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0 };
    const bubble = document.createElement('div');
    bubble.className = 'emoteFloat';
    if (emoji === 'pikdame') {
      // Es gibt kein Pik-Dame-Emoji - also eine kleine gestylte Spielkarte.
      bubble.innerHTML = '<span class="miniPikdame">♠<b>Q</b></span>';
    } else {
      bubble.textContent = emoji;
    }
    bubble.style.left = `${rect.left + rect.width / 2 - 18}px`;
    bubble.style.top = `${rect.top - 6}px`;
    document.body.appendChild(bubble);
    setTimeout(() => bubble.remove(), 1600);
  }

  // --- Statistik ---------------------------------------------------------------
  el('statsBtn').addEventListener('click', () => {
    send({ type: 'listProfiles' }); // frische Daten anfordern
    renderStats();
    el('statsOverlay').classList.remove('hidden');
  });
  el('statsCloseBtn').addEventListener('click', () => el('statsOverlay').classList.add('hidden'));
  el('statsOverlay').addEventListener('click', (ev) => {
    if (ev.target === el('statsOverlay')) el('statsOverlay').classList.add('hidden');
  });

  function renderStats() {
    const box = el('statsContent');
    const profiles = (knownProfiles || []).filter((p) => (p.gamesPlayed || 0) > 0);
    if (profiles.length === 0) {
      box.innerHTML = '<p class="lobby-hint">Noch keine abgeschlossenen Partien - spielt erstmal eine Runde! 🃏</p>';
      return;
    }
    const sorted = profiles.slice().sort((a, b) => (b.gamesWon || 0) - (a.gamesWon || 0) || (b.totalScore || 0) - (a.totalScore || 0));
    const rows = sorted
      .map((p) => {
        const played = p.gamesPlayed || 0;
        const won = p.gamesWon || 0;
        const rate = played > 0 ? Math.round((won / played) * 100) : 0;
        const best = p.bestGameScore !== undefined ? p.bestGameScore : '–';
        return `<tr><td>${escapeHtml(p.name)}</td><td>${played}</td><td>${won}</td><td>${rate}%</td><td>${best}</td></tr>`;
      })
      .join('');
    box.innerHTML = `<table class="statsPageTable"><thead><tr><th>Spieler</th><th>Spiele</th><th>Siege</th><th>Quote</th><th>Beste Partie</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // Bei Orientierungswechsel/Fenstergröße die Hand-Überlappung neu berechnen.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => render(), 150);
  });

  connect();
})();
