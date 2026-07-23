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
window.scrollTo = () => {};
window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-smoke' }), text: () => Promise.resolve('') });
window.AudioContext = function () { return { createOscillator: () => ({ connect: (x) => x, start() {}, stop() {}, type: 'sine', frequency: { setValueAtTime() {}, value: 0 } }), createGain: () => ({ connect: (x) => x, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }), destination: { connect: (x) => x }, currentTime: 0, state: 'running', resume: () => Promise.resolve(), suspend: () => Promise.resolve() }; };
window.webkitAudioContext = window.AudioContext;

let wsInstance = null;
window.WebSocket = class {
  constructor() {
    this._ls = {};
    wsInstance = this;
    this.readyState = 1;
    setTimeout(() => this._emit('open', {}), 0);
  }
  addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
  removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
  _emit(t, ev) {
    if (typeof this['on' + t] === 'function') this['on' + t](ev);
    for (const f of this._ls[t] || []) f(ev);
  }
  send() {}
  close() {}
};
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
    wsInstance._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
    feed(base);
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
      }],
    });
    {
      const ghost = window.document.querySelector('#melds .jokerGhost');
      if (!ghost) errors.push('joker ghost label missing in melds');
      else if (!/J/.test(ghost.textContent)) errors.push(`ghost label wrong: ${ghost.textContent}`);
      const handGhost = window.document.querySelector('#hand .jokerGhost');
      if (handGhost) errors.push('hand jokers must NOT carry a ghost label');
    }

    feed({
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
    });
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
