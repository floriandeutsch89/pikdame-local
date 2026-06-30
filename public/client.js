// public/client.js
// Verbindet sich dynamisch über window.location.hostname, damit der Client
// im Hotspot-Netzwerk ohne Code-Änderung über die iPhone-IP funktioniert.

(function () {
  'use strict';

  const STORAGE_KEY = 'pikdame_player_id';
  const NAME_KEY = 'pikdame_player_name';

  let playerId = localStorage.getItem(STORAGE_KEY) || null;
  let myName = localStorage.getItem(NAME_KEY) || '';
  let ws = null;
  let lastState = null;
  let selectedCardIds = new Set();
  let lastRoundResultShownAt = 0;

  const el = (id) => document.getElementById(id);

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
    }
  }

  // --- Rendering ---------------------------------------------------------

  function suitSymbol(suit) {
    return { H: '♥', D: '♦', C: '♣', S: '♠' }[suit] || '?';
  }
  function suitColor(suit) {
    return suit === 'H' || suit === 'D' ? 'red' : 'black';
  }

  function cardEl(card, { selectable, selected, onClick } = {}) {
    const div = document.createElement('div');
    div.className = 'card';
    if (card.isJoker) {
      div.classList.add('joker');
      div.innerHTML = `<div class="suitMark">🃏</div><div>JOKER</div>`;
    } else {
      div.classList.add(suitColor(card.suit));
      div.innerHTML = `<div>${card.rank}</div><div class="suitMark">${suitSymbol(card.suit)}</div>`;
      if (card.rank === 'Q' && card.suit === 'S') {
        const tag = document.createElement('div');
        tag.className = 'pikdame-tag';
        tag.textContent = '100';
        div.appendChild(tag);
      }
    }
    if (selected) div.classList.add('selected');
    if (selectable) {
      div.addEventListener('click', () => onClick && onClick(card));
    }
    return div;
  }

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
  }

  function renderTable() {
    el('roundInfo').textContent = `Runde ${lastState.roundNumber}`;
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
        d.innerHTML = `<div class="opName">${p.name}${p.isBot ? ' 🤖' : ''}</div><div class="opCount">${p.handCount} Karten</div>`;
        opponentsDiv.appendChild(d);
      });

    // Auslagen
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
        });
        group.appendChild(cEl);
      });
      meldsDiv.appendChild(group);
    });

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
    }

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
      sorted.forEach((card) => {
        const cEl = cardEl(card, {
          selectable: isMyTurn && lastState.turnPhase === 'meld',
          selected: selectedCardIds.has(card.id),
          onClick: () => onHandCardClick(card),
        });
        handDiv.appendChild(cEl);
      });
    }

    const showMeldControls = isMyTurn && lastState.turnPhase === 'meld' && selectedCardIds.size >= 3;
    el('confirmMeldBtn').classList.toggle('hidden', !showMeldControls);
    el('clearSelectionBtn').classList.toggle('hidden', selectedCardIds.size === 0);

    if (lastState.mustLayOffCardId && isMyTurn) {
      showHint('Pflicht: Die aufgenommene Ablagekarte muss zuerst ausgelegt/angelegt werden.', false);
    } else if (isMyTurn && lastState.turnPhase === 'meld') {
      showHint('Karten auswählen zum Auslegen, auf eine Auslage tippen zum Anlegen, oder direkt eine Handkarte zum Abwerfen antippen (lange drücken).', false);
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
    el('hint').style.color = isError ? '#ff6b6b' : '#ffe08a';
    hintIsError = isError;
    if (isError) {
      setTimeout(() => {
        if (hintIsError) {
          el('hint').textContent = '';
          hintIsError = false;
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
    lastState.players.forEach((p) => {
      const r = lastState.lastRoundResult[p.id];
      const row = document.createElement('div');
      row.className = 'resultRow' + (r && r.breakdown.isWinner ? ' winner' : '');
      const total = lastState.totals[p.id] || 0;
      row.innerHTML = `<span>${p.name}${p.isBot ? ' 🤖' : ''}</span><span>${r ? r.roundScore : 0} Pkt (Gesamt: ${total})</span>`;
      body.appendChild(row);
    });

    if (isGameOver && lastState.gameOverInfo) {
      const winner = lastState.players.find((p) => p.id === lastState.gameOverInfo.winnerId);
      const winLine = document.createElement('p');
      winLine.innerHTML = `<strong>🏆 ${winner ? winner.name : '?'} gewinnt das Spiel!</strong>`;
      body.appendChild(winLine);
    }

    el('resultContinueBtn').textContent = isGameOver ? 'Neues Spiel' : 'Nächste Runde';
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

  el('joinBtn').addEventListener('click', () => {
    myName = el('nameInput').value.trim() || `Spieler${Math.floor(Math.random() * 1000)}`;
    localStorage.setItem(NAME_KEY, myName);
    send({ type: 'join', playerId, name: myName });
    el('joinBtn').disabled = true;
    el('joinBtn').textContent = 'Beigetreten ✓';
    el('startBtn').disabled = false;
  });

  el('startBtn').addEventListener('click', () => {
    send({ type: 'startGame' });
  });

  el('drawPile').addEventListener('click', () => {
    if (el('drawPile').classList.contains('disabled')) return;
    send({ type: 'drawFromPile' });
  });

  el('discardPile').addEventListener('click', () => {
    if (el('discardPile').classList.contains('disabled')) return;
    send({ type: 'drawFromDiscard' });
  });

  el('confirmMeldBtn').addEventListener('click', () => {
    if (selectedCardIds.size < 3) return;
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

  el('resultContinueBtn').addEventListener('click', () => {
    send({ type: 'nextRound' });
    el('resultOverlay').classList.add('hidden');
  });

  // Langes Drücken auf eine Handkarte = direkt abwerfen (Pflicht-Phase: meld)
  function setupLongPressDiscard() {
    let timer = null;
    el('hand').addEventListener('touchstart', (ev) => {
      const target = ev.target.closest('.card');
      if (!target) return;
      timer = setTimeout(() => {
        const idx = [...el('hand').children].indexOf(target);
        const myPlayer = lastState && lastState.players.find((p) => p.id === playerId);
        if (!myPlayer || !myPlayer.hand) return;
        const sorted = myPlayer.hand.slice().sort((a, b) => {
          if (a.isJoker && b.isJoker) return 0;
          if (a.isJoker) return 1;
          if (b.isJoker) return -1;
          if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
          return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
        });
        const card = sorted[idx];
        if (card && lastState.currentPlayerId === playerId && lastState.turnPhase === 'meld') {
          send({ type: 'discard', cardId: card.id });
          selectedCardIds.clear();
        }
      }, 550);
    });
    el('hand').addEventListener('touchend', () => clearTimeout(timer));
    el('hand').addEventListener('touchmove', () => clearTimeout(timer));
  }

  setupLongPressDiscard();
  connect();
})();
