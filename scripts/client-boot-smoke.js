/** Boots the REAL client (index.html + i18n.js + client.js) inside jsdom,
 *  feeds it a lobby state and a playing state, and fails loudly on ANY
 *  uncaught error - the exact class of bug that bricks the PWA at
 *  "Connecting...". Run: node scripts/client-boot-smoke.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const errors = [];

const dom = new JSDOM(html, {
  url: 'https://play.example/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
window.navigator.vibrate = () => true;
// Tutorial vor dem Laden aktivieren: Der Client liest den Speicher beim Start,
// und die Ziel-Markierungen (Ziehstapel/Abwerfen) sollen NUR dann erscheinen.
try { window.localStorage.setItem('pikdame_tutorial', 'on'); } catch (e) { /* ohne Speicher egal */ }
// Bildwechsel SOFORT ausfuehren: Der Client setzt manche Effekte (u. a. die
// Tutorial-Markierungen) in requestAnimationFrame - im Rauchtest waere die
// Pruefung sonst schneller als die Anzeige. Tiefenbremse gegen Schleifen,
// die sich selbst neu einplanen.
let rafDepth = 0;
window.requestAnimationFrame = (cb) => {
  if (rafDepth > 4) return 0;
  rafDepth += 1;
  try { cb(Date.now()); } finally { rafDepth -= 1; }
  return 0;
};
window.scrollTo = () => {};
window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-smoke' }), text: () => Promise.resolve('') });
window.AudioContext = function () { return { createOscillator: () => ({ connect: (x) => x, start() {}, stop() {}, type: 'sine', frequency: { setValueAtTime() {}, value: 0 } }), createGain: () => ({ connect: (x) => x, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }), destination: { connect: (x) => x }, currentTime: 0, state: 'running', resume: () => Promise.resolve(), suspend: () => Promise.resolve() }; };
window.webkitAudioContext = window.AudioContext;

let wsInstance = null;
let wsConstructed = 0;   // zaehlt Verbindungsversuche (fuer den Backoff-Test)
window.WebSocket = class {
  constructor() {
    this._ls = {};
    wsInstance = this;
    wsConstructed += 1;
    this.readyState = 1;
    setTimeout(() => this._emit('open', {}), 0);
  }
  addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
  removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
  _emit(t, ev) {
    if (typeof this['on' + t] === 'function') this['on' + t](ev);
    for (const f of this._ls[t] || []) f(ev);
  }
  send(raw) { this._sent = this._sent || []; this._sent.push(raw); }
  close() {}
};
window.WebSocket.OPEN = 1;
window.WebSocket.CONNECTING = 0;
window.onerror = (msg) => { errors.push(String(msg)); };
window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));

for (const src of ['i18n.js', 'client.js']) {
  const code = fs.readFileSync(path.join(pub, src), 'utf8');
  try {
    window.eval(code);
  } catch (e) {
    console.error(`FATAL while evaluating ${src}:`, e.message);
    process.exit(1);
  }
}
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

function feed(state) {
  wsInstance._emit('message', { data: JSON.stringify({ type: 'state', state }) });
}

setTimeout(() => {
  try {
    const base = {
      phase: 'lobby', players: [
        { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 0 },
        { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 0, botDifficulty: 'zen' },
      ],
      lobbyReady: [], log: [], tableMelds: [], discardCount: 0, drawCount: 0,
      roundNumber: 0, totals: { p1: 0, b1: 0 }, houseRules: {}, nextRoundReady: [],
    };
    // Eigene Spielhistorie: Reiterwechsel fragt einmalig an, zeigt die
    // Antwort an, und ein Sprachwechsel darf die schon geladene Liste nicht
    // in der alten Sprache stehen lassen (gleiche Fehlerklasse wie bei den
    // Tagesaufgaben - deshalb hier gleich mitgeprueft statt erst spaeter
    // gemeldet zu werden).
    {
      const doc = window.document;
      doc.getElementById('nameInput').value = 'Flodex';
      const statsOpenBtn = doc.getElementById('statsBtn');
      if (statsOpenBtn) statsOpenBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      const boardBtn = doc.getElementById('statsTabBoardBtn');
      const historyBtn = doc.getElementById('statsTabHistoryBtn');
      if (!boardBtn || !historyBtn) errors.push('stats tabs missing');
      else {
        historyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const sentRaw = (wsInstance._sent || []).map((r) => JSON.parse(r));
        const asked = sentRaw.find((m) => m.type === 'getGameHistory');
        if (!asked) errors.push('switching to the history tab must request it from the server');
        else if (asked.name !== 'Flodex') errors.push(`getGameHistory must send the current name, got: ${asked.name}`);

        wsInstance._emit('message', { data: JSON.stringify({
          type: 'gameHistory',
          games: [{
            id: 'g1', finishedAt: Date.now(), challengeDate: null, rounds: 5,
            players: [{ name: 'Flodex', isBot: false }, { name: 'Gisela', isBot: true }],
            finalTotals: { p1: 1040 }, winnerId: 'p1', won: true, myScore: 1040,
          }],
        }) });
        const historyBox = doc.getElementById('historyContent');
        if (!historyBox || !/1040/.test(historyBox.textContent)) {
          errors.push(`history did not render the received game: ${historyBox ? historyBox.textContent.slice(0, 80) : 'missing'}`);
        }
        // Sprachwechsel darf die geladene Historie nicht in der alten
        // Sprache stehen lassen.
        doc.getElementById('langBtnLobby').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const afterSwitch = historyBox.textContent;
        if (!/pts/.test(afterSwitch)) errors.push(`history did not follow the language switch: ${afterSwitch.slice(0, 80)}`);
        doc.getElementById('langBtnLobby').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // zurueck auf Deutsch

        boardBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // aufraeumen fuer folgende Pruefungen
      }
    }

    // Wiederverbindung: Bei fehlendem Netz darf NICHT sofort weiterprobiert
    // werden (Nutzer-Report: Fehlerflut ERR_NAME_NOT_RESOLVED), und bei
    // Netz-Rueckkehr muss es SOFORT gehen statt den Wartezeitgeber abzusitzen.
    {
      const doc = window.document;
      const before = wsConstructed;
      let online = true;
      Object.defineProperty(window.navigator, 'onLine', { get: () => online, configurable: true });

      online = false;
      wsInstance.readyState = 3;   // CLOSED - sonst haelt reconnectNow die alte Verbindung fuer aktiv
      wsInstance._emit('close', {});
      if (wsConstructed !== before) errors.push('offline must not trigger an immediate reconnect');
      const status = doc.getElementById('connStatus').textContent;
      if (!/Offline|offline/.test(status)) errors.push(`offline status not shown, got: ${status}`);

      online = true;
      window.dispatchEvent(new window.Event('online'));
      if (wsConstructed <= before) errors.push('coming back online must reconnect right away');
    }

    // Tagesaufgaben: Ihre Texte kommen aus dem Code (L()), nicht aus dem
    // HTML - beim Sprachwechsel blieben sie deshalb stehen (Nutzer-Report).
    {
      const doc = window.document;
      wsInstance._emit('message', {
        data: JSON.stringify({
          type: 'profiles',
          players: [{ name: 'Flo', gamesPlayed: 3, gamesWon: 1, quests: {} }],
          publicMode: false,
          quests: { date: '2026-08-09', ids: ['finish_game', 'meld_queen'] },
        }),
      });
      const list = doc.getElementById('questList');
      const langBtn = doc.getElementById('langBtnLobby');
      if (!list || !langBtn) errors.push('quest list or language toggle missing');
      else if (!/Partie/.test(list.textContent)) {
        errors.push(`quest list did not render in German: ${list.textContent.slice(0, 60)}`);
      } else {
        langBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));   // -> Englisch
        if (!/Finish one match/.test(list.textContent)) {
          errors.push(`daily quests did not follow the language switch: ${list.textContent.slice(0, 80)}`);
        }
        langBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));   // -> Deutsch
        if (!/Partie zu Ende spielen/.test(list.textContent)) {
          errors.push(`daily quests did not switch back: ${list.textContent.slice(0, 80)}`);
        }
      }
    }

    // Sprachwechsel muss auch DYNAMISCHE Beschriftungen mitnehmen. Der
    // "Weiterspielen (CODE)"-Knopf wurde frueher einmalig gesetzt und blieb
    // danach in der alten Sprache stehen (Nutzer-Report).
    {
      const doc = window.document;
      window.localStorage.setItem('pikdame_last_session', 'AQM93Q');
      wsInstance._emit('message', {
        data: JSON.stringify({ type: 'sessionStatus', exists: true, code: 'AQM93Q' }),
      });
      const resume = doc.getElementById('resumeBtn');
      const langBtn = doc.getElementById('langBtnLobby');
      if (!resume || !langBtn) errors.push('resume button or language toggle missing');
      else {
        if (!/Weiterspielen/.test(resume.textContent)) {
          errors.push(`resume button should start in German: ${resume.textContent}`);
        }
        langBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));   // -> Englisch
        if (!/Resume game/.test(resume.textContent)) {
          errors.push(`resume button did not follow the switch to English: ${resume.textContent}`);
        }
        langBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));   // -> Deutsch
        if (!/Weiterspielen/.test(resume.textContent)) {
          errors.push(`resume button did not follow the switch back to German: ${resume.textContent}`);
        }
        if (!/AQM93Q/.test(resume.textContent)) errors.push('resume button lost the session code');
      }
    }

    wsInstance._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
    feed(base);
    // Tutorial-Markierungen: Im Tutorial muss das ZIEL des naechsten Schritts
    // markiert sein (hier: der Ziehstapel), im normalen Spiel NIE.
    {
      const doc = window.document;
      const tutorialState = {
        ...base, phase: 'playing', roundNumber: 1, tutorialMode: true,
        currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1', turnDeadline: null,
        discardTop: { id: 'dt', suit: 'H', rank: '7' }, drawCount: 49, discardCount: 1,
        players: base.players.map((p) =>
          p.id === 'p1'
            ? { ...p, handCount: 3, hand: [
                { id: 't1', suit: 'D', rank: '3' }, { id: 't2', suit: 'H', rank: '3' },
                { id: 't3', suit: 'C', rank: '3' },
              ] }
            : { ...p, handCount: 15 }
        ),
      };
      feed(tutorialState);
      // The welcome step now also covers the opening draw of a tutorial round
      // (phase 'lobby' never reaches the client there - the tutorial session
      // starts its round immediately). Confirm it like a player would, THEN
      // the draw step and its target highlight are due.
      const welcome = doc.getElementById('tutorialText').textContent;
      if (!/Willkommen|Welcome/.test(welcome)) {
        errors.push(`tutorial must open with the welcome step, got: ${welcome}`);
      }
      doc.getElementById('tutorialNextBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      const drawPile = doc.getElementById('drawPile');
      if (!drawPile) errors.push('draw pile missing');
      else if (!drawPile.classList.contains('tutorialGlowTarget')) {
        errors.push('tutorial must highlight the draw pile during the draw step');
      }
      // Singular/Plural im Kartenzaehler: bei genau einer Karte stand hier
      // "1 Karten" - ausgerechnet im spannendsten Moment der Runde.
      {
        const one = {
          ...tutorialState,
          players: tutorialState.players.map((p) =>
            p.id === 'p1' ? { ...p, handCount: 1, hand: [{ id: 't1', suit: 'D', rank: '3' }] } : p
          ),
        };
        feed(one);
        const label = doc.getElementById('handCount').textContent;
        if (label !== '1 Karte') errors.push(`hand counter must read "1 Karte" for a single card, got: ${label}`);
        feed(tutorialState);
        const many = doc.getElementById('handCount').textContent;
        if (many !== '3 Karten') errors.push(`hand counter must read "3 Karten" for three cards, got: ${many}`);
      }
      // Gegenprobe im selben Lauf: ohne Tutorial-Kennzeichnung keine Markierung.
      feed({ ...tutorialState, tutorialMode: false, turnPhase: 'meld' });
      if (doc.querySelectorAll('.tutorialGlowTarget').length > 0) {
        const leaked = [...doc.querySelectorAll('.tutorialGlowTarget')].map((n) => n.id).join(',');
        errors.push(`target highlights must not appear outside the draw step: ${leaked}`);
      }
    }

    feed({
      ...base, phase: 'playing', currentPlayerId: 'p1', turnPhase: 'draw', roundNumber: 1,
      dealerId: 'b1', turnDeadline: null, discardTop: null, drawCount: 60, discardCount: 1,
      hand: [
        { id: 'c1', suit: 'H', rank: '7' }, { id: 'c2', suit: 'S', rank: '9' },
        { id: 'c3', suit: 'C', rank: 'K' },
      ],
      players: base.players.map((p) => ({ ...p, handCount: 15 })),
    });
    // Rundenende mit 4 Spielern: das Ergebnis-Overlay muss in Reitern
    // rendern - Reiter 1 (Ergebnis) aktiv, Reiter 2 (Statistik) versteckt.
    const four = [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 3 },
      { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 5, botDifficulty: 'zen' },
      { id: 'b2', name: 'Uwe', isBot: true, connected: true, handCount: 8, botDifficulty: 'zen' },
      { id: 'b3', name: 'Horst', isBot: true, connected: true, handCount: 0, botDifficulty: 'zen' },
    ];
    // Joker-Geister-Beschriftung: Meld mit Joker-Slot -> das Label der
    // vertretenen Karte muss im DOM stehen (Spieler-Report: [Joker,B,Joker]
    // war nicht mehr als Satz vs. Folge unterscheidbar).
    feed({
      ...base,
      phase: 'playing', players: base.players, roundNumber: 1,
      currentPlayerId: 'p1', turnPhase: 'meld', dealerId: 'p1',
      discardTop: { id: 'dx', suit: 'H', rank: '4' }, drawCount: 10, discardCount: 3,
      hand: [{ id: 'hx', suit: 'S', rank: '9' }],
      tableMelds: [{
        id: 'm1', ownerId: 'p1', type: 'run',
        slots: [
          { real: { id: 'r1', suit: 'D', rank: '10' } },
          { real: null, joker: { id: 'j1', isJoker: true }, representsRank: 'J', representsSuit: 'D' },
          { real: { id: 'r2', suit: 'D', rank: 'Q' } },
        ],
      }, {
        // Nutzerfrage: gilt das Label für ALLE Ränge (2 bis Ass)? Beweis:
        // generisch aus representsRank/Suit - hier 2, 10 und Ass.
        id: 'm2', ownerId: 'p1', type: 'run',
        slots: [
          { real: null, joker: { id: 'j2', isJoker: true }, representsRank: '2', representsSuit: 'C' },
          { real: { id: 'r3', suit: 'C', rank: '3' } },
          { real: null, joker: { id: 'j3', isJoker: true }, representsRank: 'A', representsSuit: 'C' },
        ],
      }],
    });
    // Einstellungs-Menue: Zugang oeffnet das Overlay, die Bedienelemente
    // spiegeln die gespeicherten Werte (frueher waren es Durchklick-Knoepfe).
    {
      const doc = window.document;
      const openBtn = doc.getElementById('settingsBtnLobby');
      const overlay = doc.getElementById('settingsOverlay');
      if (!openBtn || !overlay) errors.push('settings entry or overlay missing');
      else {
        openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        if (overlay.classList.contains('hidden')) errors.push('settings overlay did not open');
        for (const id of ['uiScaleSelect', 'studioLogoSelect', 'cardbackBtn', 'debugCheckbox']) {
          if (!doc.getElementById(id)) errors.push(`settings control ${id} missing`);
        }
        const scale = doc.getElementById('uiScaleSelect');
        if (scale && !['normal', 'large', 'xlarge'].includes(scale.value)) {
          errors.push(`uiScaleSelect shows an unknown value: ${scale.value}`);
        }
        doc.getElementById('settingsOverlayCloseBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        if (!overlay.classList.contains('hidden')) errors.push('settings overlay did not close');
      }
    }

    // Aufgeben-Knopf darf NICHT neben den Zug-Knoepfen liegen: eine
    // endgueltige Aktion gehoert nicht an die Handleiste, wo jeden Zug
    // "Abwerfen" gedrueckt wird (Nutzer-Report).
    {
      const doc = window.document;
      const forfeit = doc.getElementById('forfeitBtn');
      if (!forfeit) errors.push('forfeit button missing');
      else {
        if (forfeit.closest('.handToolbar')) errors.push('forfeit button must not sit in the hand toolbar');
        if (!forfeit.closest('#gameSettingsOverlay')) errors.push('forfeit button should live in the settings sheet');
      }
    }

    // Studio-Vorspann: Er liegt ueber allem und darf das Spiel NIE blockieren.
    // Geprueft wird: er startet, das Antippen beendet ihn, und der Boot hat
    // trotzdem connect() erreicht (siehe Ende des Rauchtests).
    {
      const sp = window.document.getElementById('studioSplash');
      if (!sp) {
        errors.push('studio splash missing after boot');
      } else {
        if (!sp.classList.contains('play')) errors.push('studio splash did not start');
        if (sp.classList.contains('hidden')) errors.push('studio splash stayed hidden');
        sp.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        if (!sp.classList.contains('done')) errors.push('tapping the splash must dismiss it');
      }
    }

    {
      const ghosts = [...window.document.querySelectorAll('#melds .jokerGhost')].map((g) => g.textContent);
      if (ghosts.length !== 3) errors.push(`expected 3 ghost labels (J, 2, A), got ${ghosts.length}`);
      for (const want of ['J', '2', 'A']) {
        if (!ghosts.some((t) => t.startsWith(want))) errors.push(`ghost label for rank ${want} missing (${ghosts.join(',')})`);
      }
      const handGhost = window.document.querySelector('#hand .jokerGhost');
      if (handGhost) errors.push('hand jokers must NOT carry a ghost label');
    }

    // Zwei Joker in der Hand: ihre Reihenfolge im Faecher darf sich beim
    // erneuten Rendern NICHT aendern (Spieler-Report: "einer der beiden
    // Joker war ploetzlich was anderes" - tatsaechlich vertauschten zwei
    // ununterscheidbare Joker ihren Platz, weil der Sortierer sie als
    // gleich behandelte). Zweimal mit der GLEICHEN Hand rendern, DOM-
    // Reihenfolge muss identisch bleiben.
    {
      const doc = window.document;
      const twoJokerHand = {
        ...base, phase: 'playing', roundNumber: 1, currentPlayerId: 'p1',
        turnPhase: 'meld', dealerId: 'b1', turnDeadline: null,
        discardTop: { id: 'j1', suit: 'H', rank: '4' }, drawCount: 30, discardCount: 1,
        players: base.players.map((p) =>
          p.id === 'p1'
            ? { ...p, handCount: 3, hand: [
                { id: 'jokA', isJoker: true }, { id: 'S3', suit: 'S', rank: '3' }, { id: 'jokB', isJoker: true },
              ] }
            : { ...p, handCount: 8 }
        ),
      };
      const order = () => [...doc.querySelectorAll('#hand [data-card-id]')].map((n) => n.dataset.cardId).filter((id) => id.startsWith('jok'));
      feed(twoJokerHand);
      const first = order();
      feed({ ...twoJokerHand });   // erneut derselbe Zustand, wie ein Folge-Update
      const second = order();
      if (first.length !== 2 || second.length !== 2) {
        errors.push(`expected 2 jokers in the hand, got ${first.length} then ${second.length}`);
      } else if (first[0] !== second[0] || first[1] !== second[1]) {
        errors.push(`joker order must stay stable across renders: ${first.join(',')} -> ${second.join(',')}`);
      }
      // Ehrlicher Hinweis: node --test sortiert bereits stabil, ein
      // "return 0" faellt hier NICHT auf, weil die Engine ohnehin die
      // Einfuegereihenfolge beibehaelt. Der eigentliche Beweis steht im
      // Quelltext-Vertrag direkt darunter - er prueft, dass '0' fuer zwei
      // Joker gar nicht mehr zurueckgegeben werden KANN, unabhaengig von
      // der Sortier-Implementierung der jeweiligen Browser-Engine.
      const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
      if (/if \(a\.isJoker && b\.isJoker\) return 0;/.test(clientSrc)) {
        errors.push('hand sort must not return 0 for two jokers - order becomes engine-dependent');
      }
    }

    // Joker-Auswahl markiert ALLE moeglichen Auslagen - auch Folgen, wo er
    // an beide Enden passt (Spieler-Report: nur Saetze leuchteten). Der
    // Server fragt dort per Auswahldialog nach, lehnt also nicht ab.
    {
      const doc = window.document;
      feed({
        ...base, phase: 'playing', roundNumber: 1, currentPlayerId: 'p1',
        turnPhase: 'meld', dealerId: 'b1', turnDeadline: null,
        discardTop: { id: 'j0', suit: 'H', rank: '4' }, drawCount: 30, discardCount: 1,
        players: base.players.map((p) =>
          p.id === 'p1'
            ? { ...p, handCount: 2, hand: [{ id: 'jok9', isJoker: true }, { id: 'S2', suit: 'S', rank: '2' }] }
            : { ...p, handCount: 8 }
        ),
        tableMelds: [
          { id: 'set6', ownerId: 'p1', type: 'set', rank: '6',
            slots: [{ real: { id: 'C6', suit: 'C', rank: '6' } }, { real: { id: 'H6', suit: 'H', rank: '6' } }, { real: { id: 'S6', suit: 'S', rank: '6' } }] },
          { id: 'runD', ownerId: 'p1', type: 'run', suit: 'D',
            slots: [{ real: { id: 'D10', suit: 'D', rank: '10' } }, { real: { id: 'DJ', suit: 'D', rank: 'J' } }, { real: { id: 'DQ', suit: 'D', rank: 'Q' } }] },
        ],
      });
      const jokerCard = doc.querySelector('#hand [data-card-id="jok9"]');
      if (!jokerCard) errors.push('joker not rendered in hand');
      else {
        jokerCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const lit = (id) => {
          const g = doc.querySelector(`#melds [data-meld-id="${id}"]`);
          return !!g && g.classList.contains('layOffTarget');
        };
        if (!lit('set6')) errors.push('a joker must highlight a set it can join');
        if (!lit('runD')) errors.push('a joker must ALSO highlight a run (the server asks which end)');
      }
    }

    // Pflichtkarte (gerade vom Ablagestapel genommen): einfaches Anlegen an
    // eine bestehende eigene Auslage darf NICHT mehr gruen markiert werden -
    // der Server lehnt genau das jetzt ab (Spieler-Report: Herz Dame durfte
    // nicht an den bestehenden Damen-Drilling angelegt werden, wenn sie
    // stattdessen mit Handkarten eine neue Folge bilden sollte). Zwei Faelle:
    // (1) Auslage aus echten Karten -> KEIN Ziel mehr. (2) Auslage mit einem
    // passenden JOKER -> bleibt Ziel (Tausch ist weiterhin erlaubt).
    {
      const doc = window.document;
      const mustCardState = {
        ...base, phase: 'playing', roundNumber: 1, currentPlayerId: 'p1',
        turnPhase: 'meld', dealerId: 'b1', turnDeadline: null,
        discardTop: null, drawCount: 30, discardCount: 0,
        mustLayOffCardId: 'HQ_must', pendingDiscardRest: true,
        players: base.players.map((p) =>
          p.id === 'p1'
            ? { ...p, handCount: 3, hand: [
                { id: 'HQ_must', suit: 'H', rank: 'Q' },
                { id: 'HK_hand', suit: 'H', rank: 'K' },
                { id: 'jok_hand', isJoker: true },
              ] }
            : { ...p, handCount: 8 }
        ),
        tableMelds: [{
          id: 'queenSet', ownerId: 'p1', type: 'set', rank: 'Q',
          slots: [
            { real: { id: 'SQ0', suit: 'S', rank: 'Q' } },
            { real: { id: 'CQ0', suit: 'C', rank: 'Q' } },
            { real: { id: 'DQ0', suit: 'D', rank: 'Q' } },
          ],
        }],
      };
      feed(mustCardState);
      const mustCard = doc.querySelector('#hand [data-card-id="HQ_must"]');
      if (!mustCard) errors.push('mandatory card not rendered in hand');
      else {
        mustCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const queenSetLit = doc.querySelector('#melds [data-meld-id="queenSet"]');
        if (queenSetLit && queenSetLit.classList.contains('layOffTarget')) {
          errors.push('mandatory card must NOT highlight a plain-attach meld (real cards only, no joker)');
        }
      }

      // Fall (2): dieselbe Pflichtkarte, aber die eigene Auslage traegt jetzt
      // einen Joker, der GENAU Herz-Koenig vertritt - Tausch bleibt erlaubt
      // und muss weiterhin leuchten.
      feed({
        ...mustCardState,
        tableMelds: [{
          id: 'kingSwap', ownerId: 'p1', type: 'set', rank: 'K',
          slots: [
            { real: { id: 'SK0', suit: 'S', rank: 'K' } },
            { real: { id: 'CK0', suit: 'C', rank: 'K' } },
            { joker: { id: 'jok_table', isJoker: true }, representsRank: 'Q', representsSuit: 'H' },
          ],
        }],
      });
      // Auswahl bleibt clientseitig ueber feed()-Aufrufe hinweg bestehen -
      // ein erneuter Klick koennte die bereits ausgewaehlte Karte wieder
      // ABWAEHLEN (Umschalt-Verhalten). Deshalb pruefen statt blind klicken.
      const mustCard2 = doc.querySelector('#hand [data-card-id="HQ_must"]');
      if (mustCard2 && !mustCard2.classList.contains('selected')) {
        mustCard2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      }
      const swapLit = doc.querySelector('#melds [data-meld-id="kingSwap"]');
      if (!swapLit || !swapLit.classList.contains('layOffTarget')) {
        errors.push('mandatory card must still highlight a meld it can be JOKER-SWAPPED into');
      }
    }

    // Auslagen-Filter: Beim Filtern auf einen MITSPIELER muessen die eigenen
    // Auslagen sichtbar bleiben - man wirft ja genau danach ab, was der
    // Nachbar brauchen koennte und was die eigene Auslage aufnimmt.
    {
      const doc = window.document;
      feed({
        ...base, phase: 'playing', roundNumber: 1, currentPlayerId: 'p1',
        turnPhase: 'meld', dealerId: 'b1', turnDeadline: null,
        discardTop: { id: 'f0', suit: 'H', rank: '4' }, drawCount: 20, discardCount: 1,
        players: base.players.map((p) => ({ ...p, handCount: 5 })),
        tableMelds: [
          { id: 'mine', ownerId: 'p1', type: 'set', rank: '6',
            slots: [{ real: { id: 'C6', suit: 'C', rank: '6' } }, { real: { id: 'H6', suit: 'H', rank: '6' } }, { real: { id: 'S6', suit: 'S', rank: '6' } }] },
          { id: 'theirs', ownerId: 'b1', type: 'set', rank: '9',
            slots: [{ real: { id: 'C9', suit: 'C', rank: '9' } }, { real: { id: 'H9', suit: 'H', rank: '9' } }, { real: { id: 'S9', suit: 'S', rank: '9' } }] },
        ],
      });
      const meldIds = () => [...doc.querySelectorAll('#melds [data-meld-id]')].map((n) => n.dataset.meldId);
      if (!meldIds().includes('mine') || !meldIds().includes('theirs')) {
        errors.push(`unfiltered view should show both melds, got: ${meldIds().join(',')}`);
      }
      // Auf den Mitspieler filtern (Klick auf dessen Ueberschrift).
      const headers = [...doc.querySelectorAll('#melds .meldOwnerHeader')];
      const theirHeader = headers.find((h) => /Gisela/.test(h.textContent));
      if (!theirHeader) errors.push('opponent meld header not found');
      else {
        theirHeader.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const shown = meldIds();
        if (!shown.includes('theirs')) errors.push('filtering must show the filtered player');
        if (!shown.includes('mine')) errors.push('own melds must stay visible while filtering an opponent');
        const bar = doc.querySelector('#melds .meldFilterBar');
        if (!bar || !/und dir/.test(bar.textContent)) {
          errors.push(`filter bar should say both are shown, got: ${bar ? bar.textContent : 'missing'}`);
        }
      }
      // Auf sich selbst filtern: dann NUR die eigenen.
      // Auf sich selbst filtern: EIN Klick auf die eigene Ueberschrift setzt
      // den Filter direkt um (ein zweiter wuerde ihn wieder loesen).
      const myHeader = [...doc.querySelectorAll('#melds .meldOwnerHeader')].find((h) => /Deine Auslagen/.test(h.textContent));
      if (!myHeader) errors.push('own meld header not found while filtering');
      else {
        myHeader.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const shown = meldIds();
        if (shown.includes('theirs')) errors.push('filtering yourself must hide the opponent melds');
        if (!shown.includes('mine')) errors.push('filtering yourself must still show your own melds');
      }
    }

    // Zwei Pik Damen in EINEM Zug ausgelegt: die Ankuendigung muss 200
    // Punkte nennen (Spieler-Report: sie sagte 100, weil sie nach der ersten
    // Karte abbrach). Die Wertung war immer korrekt.
    {
      const doc = window.document;
      const pdBase = {
        ...base, phase: 'playing', roundNumber: 1, currentPlayerId: 'p1',
        turnPhase: 'meld', dealerId: 'b1', turnDeadline: null,
        discardTop: { id: 'pd0', suit: 'H', rank: '4' }, drawCount: 20, discardCount: 1,
        players: base.players.map((p) => ({ ...p, handCount: 5 })),
      };
      feed({ ...pdBase, tableMelds: [] });          // Ausgangslage: keine Dame am Tisch
      feed({
        ...pdBase,
        tableMelds: [{
          id: 'mq', ownerId: 'p1', type: 'set', rank: 'Q',
          slots: [
            { real: { id: 'SQ-0', suit: 'S', rank: 'Q' } },
            { real: { id: 'SQ-1', suit: 'S', rank: 'Q' } },
            { real: { id: 'HQ-0', suit: 'H', rank: 'Q' } },
          ],
        }],
      });
      const warn = doc.querySelector('.raidWarning');
      if (!warn) errors.push('queen announcement missing');
      else {
        const text = warn.textContent || '';
        if (!/200/.test(text)) errors.push(`two queens at once must announce 200 points, got: ${text}`);
      }
      doc.querySelectorAll('.raidWarning').forEach((n) => n.remove());
    }

    // Gruener Rahmen bei Joker-Auswahl: An 7d-8d-9d koennen Joker + Bube nur
    // Joker=10d heissen - der Hinweis muss das genauso erkennen wie der
    // Server, sonst wirkt ein gueltiger Zug unmoeglich (Spieler-Report).
    feed({
      ...base,
      phase: 'playing', roundNumber: 1,
      currentPlayerId: 'p1', turnPhase: 'meld', dealerId: 'p1', turnDeadline: null,
      discardTop: { id: 'dj', suit: 'H', rank: '4' }, drawCount: 12, discardCount: 2,
      // Handkarten haengen am SPIELER-Eintrag (dort liest der Client sie),
      // nicht am obersten Zustandsfeld.
      players: base.players.map((p) =>
        p.id === 'p1'
          ? { ...p, handCount: 3, hand: [
              { id: 'jok1', isJoker: true },
              { id: 'JD', suit: 'D', rank: 'J' },
              { id: 'C3', suit: 'C', rank: '3' },
            ] }
          : { ...p, handCount: 5 }
      ),
      tableMelds: [{
        id: 'mrun', ownerId: 'p1', type: 'run', suit: 'D',
        slots: [
          { real: { id: 'D7', suit: 'D', rank: '7' } },
          { real: { id: 'D8', suit: 'D', rank: '8' } },
          { real: { id: 'D9', suit: 'D', rank: '9' } },
        ],
      }],
    });
    {
      const doc = window.document;
      const tap = (id) => {
        const elCard = doc.querySelector(`#hand [data-card-id="${id}"]`);
        if (!elCard) { errors.push(`hand card ${id} not rendered`); return; }
        elCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      };
      tap('jok1');
      tap('JD');
      const group = doc.querySelector('#melds [data-meld-id="mrun"]');
      if (!group) errors.push('own meld not rendered');
      else if (!group.classList.contains('layOffTarget')) {
        errors.push('joker + jack onto 7-8-9 must be highlighted as a lay-off target');
      }
    }

    const roundEndState = {
      ...base, phase: 'roundEnd', players: four, roundNumber: 2,
      currentPlayerId: 'b3', turnPhase: 'draw', dealerId: 'b1', turnDeadline: null,
      discardTop: { id: 'd1', suit: 'H', rank: '4' }, drawCount: 0, discardCount: 20,
      hand: [{ id: 'c1', suit: 'H', rank: '7' }, { id: 'c2', suit: 'S', rank: '9' }, { id: 'c3', suit: 'C', rank: 'K' }],
      nextRoundReady: [],
      totals: { p1: 120, b1: 80, b2: -40, b3: 210 },
      lastRoundWinnerId: 'b3',
      lastRoundResult: {
        p1: { roundScore: 20, breakdown: { isWinner: false, laidOutValue: 50, handValue: 30 } },
        b1: { roundScore: 10, breakdown: { isWinner: false, laidOutValue: 30, handValue: 20 } },
        b2: { roundScore: -40, breakdown: { isWinner: false, laidOutValue: 0, handValue: 40 } },
        b3: { roundScore: 90, breakdown: { isWinner: true, laidOutValue: 90, handValue: 0 } },
      },
      lastRoundStats: four.map((p) => ({ id: p.id, name: p.name, laidOutCount: 6, handCount: p.handCount, pikDameLaidOut: 0, jokersLaidOut: 1 })),
      scoreHistory: [
        { round: 1, totals: { p1: 100, b1: 70, b2: 0, b3: 120 } },
        { round: 2, totals: { p1: 120, b1: 80, b2: -40, b3: 210 } },
      ],
      lastRoundWasHandAus: true,
    };

    // "Hand aus" ist eine Leistung, die Doppelwertung aber eine OPTIONALE
    // Hausregel. Derselbe Zustand, zwei Regelstände - die Notiz darf nur mit
    // aktiver Regel erscheinen (Spieler-Report: sie erschien immer, obwohl
    // die Wertung korrekt nur mit Regel verdoppelte).
    feed({ ...roundEndState, houseRules: { handAusDoubles: false } });
    {
      const note = window.document.querySelector('#resultBody .handAusNote');
      if (note) errors.push(`handAusNote must stay hidden without the house rule (found: "${note.textContent}")`);
    }
    feed({ ...roundEndState, houseRules: { handAusDoubles: true } });
    {
      const note = window.document.querySelector('#resultBody .handAusNote');
      if (!note) errors.push('handAusNote must appear when the house rule is active');
      else if (!/doppelt|double/i.test(note.textContent)) errors.push(`handAusNote text unexpected: ${note.textContent}`);
    }
    // Partie-Ende (nicht nur Rundenende): der PARTIE-Gewinn zeigt den neuen
    // Pokal statt der Krone, die weiterhin jeden Rundengewinn markiert.
    // Feature-Wunsch, nach dem Vorbild von Codenames - ohne eigenes Symbol
    // sahen "Runde gewonnen" und "Partie gewonnen" optisch identisch aus.
    {
      feed({
        ...roundEndState,
        phase: 'gameOver',
        houseRules: {},
        gameOverInfo: { winnerId: 'b3', finalTotals: { p1: 120, b1: 80, b2: -40, b3: 1010 }, highlights: [] },
        totals: { p1: 120, b1: 80, b2: -40, b3: 1010 },
      });
      const doc = window.document;
      const winnerBox = doc.querySelector('#resultBody .resultWinnerGame');
      if (!winnerBox) errors.push('game-over must render the match-winner banner');
      else {
        if (!winnerBox.querySelector('.trophyMark')) errors.push('match win must show the TROPHY icon');
        if (winnerBox.querySelector('.jokerMark')) errors.push('match win must NOT reuse the round-win crown icon');
      }
    }
    setTimeout(() => {
      const doc = window.document;
      const tabs = doc.querySelectorAll('#resultBody .resultTabBtn');
      if (tabs.length !== 2) errors.push(`resultTabs: expected 2 tab buttons, got ${tabs.length}`);
      const panes = doc.querySelectorAll('#resultBody .resultPane');
      if (panes.length !== 2) errors.push(`resultPanes: expected 2, got ${panes.length}`);
      if (panes.length === 2) {
        if (panes[0].classList.contains('hidden')) errors.push('result pane (tab 1) must be visible by default');
        if (!panes[1].classList.contains('hidden')) errors.push('stats pane (tab 2) must start hidden');
        if (!panes[0].querySelector('.resultRow')) errors.push('tab 1 must contain the tabular result rows');
        if (!panes[1].querySelector('.statsTable')) errors.push('tab 2 must contain the stats table');
        if (!panes[1].querySelector('.scoreChart')) errors.push('tab 2 must contain the score chart');
      }
      // Reiter-Wechsel per Klick
      if (tabs.length === 2) {
        tabs[1].dispatchEvent(new window.Event('click', { bubbles: true }));
        if (panes[1].classList.contains('hidden')) errors.push('clicking tab 2 must reveal the stats pane');
        if (!panes[0].classList.contains('hidden')) errors.push('clicking tab 2 must hide the result pane');
      }
      if (errors.length) {
        console.error('CLIENT BOOT SMOKE: FAILED');
        for (const e of errors) console.error('  -', e);
        process.exit(1);
      }
      // ZWEITER LAUF - 'Cache-Versatz': NEUES client.js auf ALTEM Markup.
      // Live-Ausfall v1.79.0: iOS kombinierte gecachtes HTML (ohne Debug-
      // Elemente) mit frischem Script; ein null-Zugriff im optionalen
      // Debug-Init brach den Boot VOR connect() ab - alle Menü-Buttons tot.
      // Der Boot muss auch ohne neu eingeführte DOM-Elemente durchlaufen
      // und die WebSocket-Verbindung erreichen.
      const dom2 = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
      const w2 = dom2.window;
      for (const id of ['debugGrid', 'debugPanel', 'debugBtnLobby', 'debugBtn']) {
        const n = w2.document.getElementById(id);
        if (n) n.remove();
      }
      w2.matchMedia = window.matchMedia;
      w2.navigator.vibrate = () => true;
      w2.scrollTo = () => {};
      w2.fetch = window.fetch;
      w2.AudioContext = window.AudioContext;
      w2.webkitAudioContext = window.AudioContext;
      let ws2 = null;
      w2.WebSocket = class {
        constructor() { ws2 = this; this._ls = {}; this.readyState = 1; }
        addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
        removeEventListener() {}
        send() {}
        close() {}
      };
      const errors2 = [];
      w2.onerror = (msg) => errors2.push(String(msg));
      for (const src of ['i18n.js', 'client.js']) {
        try {
          w2.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
        } catch (e) {
          errors2.push(`stale-markup boot threw in ${src}: ${e.message}`);
        }
      }
      if (errors2.length) {
        console.error('CLIENT BOOT SMOKE: FAILED (stale-markup run)');
        for (const e of errors2) console.error('  -', e);
        process.exit(1);
      }
      if (!ws2) {
        console.error('CLIENT BOOT SMOKE: FAILED (stale-markup run) - connect() was never reached, WebSocket not created');
        process.exit(1);
      }
      console.log('CLIENT BOOT SMOKE: OK (lobby + playing + roundEnd tabs + stale-markup boot reached connect())');
      process.exit(0);
    }, 120);
  } catch (e) {
    console.error('CLIENT BOOT SMOKE: THREW:', e.stack || e.message);
    process.exit(1);
  }
}, 30);
