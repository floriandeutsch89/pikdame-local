// public/client.js
// Verbindet sich dynamisch über window.location.hostname, damit der Client
// im Hotspot-Netzwerk ohne Code-Änderung über die iPhone-IP funktioniert.

(function () {
  'use strict';

  const STORAGE_KEY = 'pikdame_player_id';
  const NAME_KEY = 'pikdame_player_name';
  const THEME_KEY = 'pikdame_theme';
  const SOUND_KEY = 'pikdame_sound_enabled';

  let playerId = localStorage.getItem(STORAGE_KEY) || null;
  let myName = localStorage.getItem(NAME_KEY) || '';
  let soundEnabled = localStorage.getItem(SOUND_KEY) !== 'off';
  let ws = null;
  let lastState = null;
  let selectedCardIds = new Set();
  let lastRoundResultShownAt = 0;
  let knownTeams = [];
  let knownProfiles = [];

  const el = (id) => document.getElementById(id);

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
      ws.send(JSON.stringify({ type: 'join', playerId, name: myName }));
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
      localStorage.setItem(STORAGE_KEY, playerId);
      return;
    }
    if (msg.type === 'error') {
      showHint(msg.error, true);
      return;
    }
    if (msg.type === 'state') {
      lastState = msg.state;
      render();
      return;
    }
    if (msg.type === 'profiles') {
      knownProfiles = msg.players || [];
      knownTeams = msg.teams || [];
      renderTeamSelect();
      return;
    }
    if (msg.type === 'teamCreated') {
      showHint(`Team "${msg.team.name}" gespeichert.`, false);
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
      div.innerHTML = compact
        ? `<div class="suitMark">🃏</div>`
        : `<div class="suitMark">🃏</div><div>JOKER</div>`;
    } else {
      div.classList.add(suitColor(card.suit));
      div.innerHTML = `<div>${card.rank}</div><div class="suitMark">${suitSymbol(card.suit)}</div>`;
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
        ? '<br>' + lastState.players.map((p) => `${p.name}${p.isBot ? ' (Bot)' : ''}`).join(', ')
        : '');
    el('startBtn').disabled = humanCount === 0;

    const hasJoined = lastState.players.some((p) => p.id === playerId);
    el('seatCountSection').classList.toggle('hidden', !hasJoined);
    el('seatingSection').classList.toggle('hidden', !hasJoined || lastState.players.length === 0);
    el('teamSection').classList.toggle('hidden', !hasJoined);
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
        <span class="seatName">${p.name}${p.isBot ? ' 🤖' : ''}</span>
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

  function renderTeamSelect() {
    const select = el('teamSelect');
    const current = select.value;
    select.innerHTML = '<option value="">– Team wählen –</option>' +
      knownTeams.map((t) => `<option value="${t.id}">${t.name} (${t.memberNames.join(', ')})</option>`).join('');
    if (current) select.value = current;
  }

  function collectHouseRules() {
    return {
      handAusDoubles: el('ruleHandAus').checked,
      strictThreshold: el('ruleStrict1000').checked,
    };
  }

  function renderTable() {
    el('roundInfo').textContent = `Runde ${lastState.roundNumber}`;
    const dealer = lastState.players.find((p) => p.id === lastState.dealerId);
    el('dealerInfo').textContent = `Geber: ${dealer ? dealer.name : '–'}`;
    const cp = lastState.players.find((p) => p.id === lastState.currentPlayerId);
    const isMyTurn = lastState.currentPlayerId === playerId;
    el('turnInfo').textContent = isMyTurn
      ? `Du bist am Zug (${phaseLabel(lastState.turnPhase)})`
      : `${cp ? cp.name : '?'} ist am Zug`;

    // Gegner
    const opponentsDiv = el('opponents');
    opponentsDiv.innerHTML = '';
    lastState.players
      .filter((p) => p.id !== playerId)
      .forEach((p) => {
        const d = document.createElement('div');
        d.className = 'opponent' + (p.id === lastState.currentPlayerId ? ' active' : '');
        const reconnecting = !p.isBot && p.controlledByBot;
        d.innerHTML = `<div class="opName">${p.name}${p.isBot ? ' 🤖' : ''}${reconnecting ? ' <span class="reconnectTag">⏳ getrennt – Bot übernimmt</span>' : ''}</div><div class="opCount">${p.handCount} Karten</div>`;
        opponentsDiv.appendChild(d);
      });

    // Auslagen
    el('meldsLegend').classList.toggle('hidden', lastState.tableMelds.length === 0);
    const meldsDiv = el('melds');
    meldsDiv.innerHTML = '';
    lastState.tableMelds.forEach((meld) => {
      const group = document.createElement('div');
      group.className = 'meldGroup';
      meld.slots.forEach((slot) => {
        const card = slot.real || { isJoker: true, rank: slot.representsRank, suit: slot.representsSuit, _isJokerSlot: true };
        const cEl = cardEl(card, {
          selectable: isMyTurn && lastState.turnPhase === 'meld',
          onClick: () => onMeldCardClick(meld),
          compact: true,
        });
        if (slot.playerId === playerId) cEl.classList.add('mine');
        group.appendChild(cEl);
      });
      meldsDiv.appendChild(group);
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
    el('discardCount').textContent = lastState.discardPileCount > 0 ? `${lastState.discardPileCount} Karten` : '';

    const canDraw = isMyTurn && lastState.turnPhase === 'draw';
    el('drawPile').classList.toggle('disabled', !canDraw || lastState.drawPileCount === 0);
    el('discardPile').classList.toggle('disabled', !canDraw || !lastState.discardTop);

    // Hand
    const myPlayer = lastState.players.find((p) => p.id === playerId);
    const handDiv = el('hand');
    handDiv.innerHTML = '';
    if (myPlayer && myPlayer.hand) {
      // sortiere Hand: erst nach Farbe, dann Wert, Joker ans Ende
      const sorted = myPlayer.hand.slice().sort((a, b) => {
        if (a.isJoker && b.isJoker) return 0;
        if (a.isJoker) return 1;
        if (b.isJoker) return -1;
        if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
        return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
      });
      sorted.forEach((card, idx) => {
        const cEl = cardEl(card, {
          selectable: isMyTurn && lastState.turnPhase === 'meld',
          selected: selectedCardIds.has(card.id),
          onClick: () => onHandCardClick(card),
        });
        // Fächer-Optik: Karten leicht um die Mitte der Hand rotiert + angehoben
        const mid = (sorted.length - 1) / 2;
        const offset = idx - mid;
        const rotate = Math.max(-14, Math.min(14, offset * 3.5));
        const lift = Math.abs(offset) * 2.5;
        cEl.style.transform = `rotate(${rotate}deg) translateY(${lift}px)`;
        if (selectedCardIds.has(card.id)) {
          cEl.style.transform += ' translateY(-16px)';
        }
        handDiv.appendChild(cEl);
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
      row.innerHTML = `<span>${p.name}${p.isBot ? ' 🤖' : ''}</span><span>${r ? r.roundScore : 0} Pkt (Gesamt: ${total})</span>`;
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
              `<tr><td>${s.name}</td><td>${s.laidOutCount}</td><td>${s.handCount}</td><td>${s.pikDameCount}</td><td>${s.jokerInHandCount}</td></tr>`
          )
          .join('')}</tbody>`;
      body.appendChild(statsTable);
    }

    if (isGameOver && lastState.gameOverInfo) {
      const winner = lastState.players.find((p) => p.id === lastState.gameOverInfo.winnerId);
      const winLine = document.createElement('p');
      winLine.innerHTML = `<strong>🏆 ${winner ? winner.name : '?'} gewinnt das Spiel!</strong>`;
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
      send({ type: 'layOff', meldId: meld.id, cardId });
      selectedCardIds.clear();
    } else {
      showHint('Wähle genau eine Handkarte aus, um sie an diese Auslage anzulegen.', false);
    }
  }

  let hasJoinedOnce = false;

  el('nameInput').value = myName;

  el('joinBtn').addEventListener('click', () => {
    myName = el('nameInput').value.trim() || `Spieler${Math.floor(Math.random() * 1000)}`;
    localStorage.setItem(NAME_KEY, myName);
    send({ type: 'join', playerId, name: myName });
    hasJoinedOnce = true;
    el('joinBtn').textContent = 'Namen aktualisieren';
    el('startBtn').disabled = false;
  });

  el('startBtn').addEventListener('click', () => {
    send({ type: 'startGame', houseRules: collectHouseRules() });
  });

  el('applyTeamBtn').addEventListener('click', () => {
    const teamId = el('teamSelect').value;
    if (!teamId) {
      showHint('Bitte zuerst ein Team auswählen.', false);
      return;
    }
    send({ type: 'applyTeam', teamId });
  });

  el('saveTeamBtn').addEventListener('click', () => {
    const name = el('newTeamName').value.trim();
    const memberNames = el('newTeamMembers').value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (!name || memberNames.length === 0) {
      showHint('Bitte Team-Namen und mindestens einen Mitgliedsnamen angeben.', false);
      return;
    }
    send({ type: 'createTeam', name, memberNames });
    el('newTeamName').value = '';
    el('newTeamMembers').value = '';
  });

  el('drawPile').addEventListener('click', () => {
    if (el('drawPile').classList.contains('disabled')) return;
    sound.draw();
    send({ type: 'drawFromPile' });
  });

  el('discardPile').addEventListener('click', () => {
    if (el('discardPile').classList.contains('disabled')) return;
    sound.draw();
    send({ type: 'drawFromDiscard' });
  });

  el('discardBtn').addEventListener('click', () => {
    if (selectedCardIds.size !== 1) return;
    const cardId = [...selectedCardIds][0];
    sound.discard();
    send({ type: 'discard', cardId });
    selectedCardIds.clear();
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

  connect();
})();
