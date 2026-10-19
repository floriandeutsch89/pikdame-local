/** Follow the glow: the REAL client (jsdom) plays its first round by tapping
 *  only what the tutorial marks, against the REAL engine with the server's
 *  tutorial setup (seed 22). A lesson that marks nothing, marks a move the
 *  engine refuses or comes out of order breaks the run. Page and bots run on
 *  a virtual clock (pattern: lobby-hero.test.js), so no result depends on how
 *  fast the machine is. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const GameManager = require('../game/GameManager');
const { createDeck } = require('../game/Deck');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const ME = 'p1';
const BOT_MS = 1500; // virtual think time per bot move

// Card conservation (same census as card-conservation.test.js): the tutorial's
// stock swap must never create or lose a card.
const REFERENCE = (() => {
  const counts = new Map();
  for (const card of createDeck()) counts.set(card.id, (counts.get(card.id) || 0) + 1);
  return counts;
})();
function assertDeck(game, when) {
  const found = new Map();
  const add = (card) => { if (card && card.id) found.set(card.id, (found.get(card.id) || 0) + 1); };
  for (const p of game.players) (p.hand || []).forEach(add);
  for (const meld of game.tableMelds || []) for (const s of meld.slots || []) { add(s.real); add(s.joker); }
  for (const pile of [game.drawPile, game.discardPile, game.retiredJokers]) (pile || []).forEach(add);
  const errors = [];
  for (const [id, n] of REFERENCE) if ((found.get(id) || 0) !== n) errors.push(`${id}: ${found.get(id) || 0}x instead of ${n}x`);
  for (const id of found.keys()) if (!REFERENCE.has(id)) errors.push(`unknown card ${id}`);
  assert.deepStrictEqual(errors, [], `card conservation broken ${when}`);
}

function boot({ storage = {} } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  // The message handler catches render errors and only logs them: a log fails here.
  virtualConsole.on('error', (...args) => errors.push(args.map(String).join(' ')));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });

  // The virtual clock: Date and every timer of the page run on it, nothing else moves it.
  const RealDate = window.Date;
  let clock = new RealDate(2026, 9, 17, 10, 0, 0).getTime();
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  const queue = [];
  let seq = 0;
  window.setTimeout = (fn, ms = 0, ...args) => {
    queue.push({ id: ++seq, at: clock + Math.max(0, Number(ms) || 0), fn, args });
    return seq;
  };
  window.setInterval = (fn, ms = 0, ...args) => {
    const every = Math.max(1, Number(ms) || 0);
    queue.push({ id: ++seq, at: clock + every, fn, args, every });
    return seq;
  };
  window.clearTimeout = window.clearInterval = (id) => {
    const i = queue.findIndex((t) => t.id === id);
    if (i >= 0) queue.splice(i, 1);
  };
  // The engine broadcasts on setImmediate (real), promise chains settle on their own.
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
  const run = async (ms) => {
    const end = clock + ms;
    for (let fired = 0; ; fired++) {
      if (fired > 20000) throw new Error('timer loop');
      await settle();
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue[0];
      if (!next || next.at > end) break;
      queue.shift();
      clock = Math.max(clock, next.at);
      if (next.every) { next.at = clock + next.every; queue.push(next); }
      try { next.fn(...next.args); } catch (e) { errors.push(e); }
    }
    clock = Math.max(clock, end);
    await settle();
  };
  // A frame after the synchronous render, like a browser: the marks land on the new DOM.
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(clock), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`);
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const vibrations = [];
  window.navigator.vibrate = (pattern) => { vibrations.push(pattern); return true; };
  window.scrollTo = () => {};
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  window.AudioContext = function AudioContext() {
    const node = () => ({ connect: (x) => x, disconnect() {}, start() {}, stop() {}, type: 'sine', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, value: 0 }, Q: { value: 0 }, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } });
    return { createOscillator: node, createGain: node, createBiquadFilter: node, destination: node(), currentTime: 0, state: 'running', resume: () => Promise.resolve(), suspend: () => Promise.resolve() };
  };
  window.webkitAudioContext = window.AudioContext;

  // The server side: one socket, one engine, the same calls as server.js.
  let sock = null;
  const server = { game: null, joinName: null, code: 'TUT022' };
  const deliver = (message) => window.setTimeout(() => sock && sock._emit('message', { data: JSON.stringify(message) }), 0);
  server.deliver = deliver;
  const answer = (r) => {
    if (r && r.error) deliver({ type: 'error', error: r.error });
    return r;
  };
  server.receive = (msg) => {
    const g = server.game;
    switch (msg.type) {
      case 'ping': deliver({ type: 'pong' }); break;
      case 'startTutorial':
      case 'createSession': {
        server.joinName = msg.name;
        const game = new GameManager((pid, message) => { if (pid === ME) deliver(message); },
          msg.type === 'startTutorial' ? { deckSeed: GameManager.TUTORIAL_SEED, tutorialMode: true } : { deckSeed: GameManager.TUTORIAL_SEED });
        // Bots on the virtual clock (the engine's own timer runs on real time).
        game.maybeRunBotTurn = () => {
          const cp = game.phase === 'playing' && game.currentPlayer();
          if (!cp || !game.isBotControlled(cp)) return;
          window.setTimeout(() => { if (game.phase === 'playing' && game.currentPlayer() === cp) game.runBotTurn(cp.id); }, BOT_MS);
        };
        server.game = game;
        game.addOrReconnectPlayer(ME, msg.name);
        deliver({ type: 'joined', playerId: ME, playerToken: 'token', sessionCode: server.code });
        game.startTutorialRound(); // a normal game too: straight to the table, same deal
        game.broadcastState();
        break;
      }
      case 'joinSession':
        deliver({ type: 'joined', playerId: ME, playerToken: 'token', sessionCode: server.code });
        if (g) g.broadcastState();
        break;
      case 'drawFromPile': answer(g.drawFromPile(ME)); break;
      case 'drawFromDiscard': answer(g.drawFromDiscard(ME)); break;
      case 'layoutMeld': {
        const r = answer(g.layoutMeld(ME, msg.cardIds, msg.jokerAssignments || {}));
        if (r && r.ambiguous) deliver({ type: 'meldAmbiguous', cardIds: msg.cardIds, options: r.options });
        break;
      }
      case 'layOffMulti': answer(g.layOffCards(ME, msg.meldId, msg.cardIds)); break;
      case 'layOff': {
        const r = answer(g.layOffCard(ME, msg.meldId, msg.cardId, msg.asSuit, msg.side));
        if (r && r.ambiguous) deliver({ type: 'layOffAmbiguous', meldId: msg.meldId, cardId: msg.cardId, options: r.options });
        break;
      }
      case 'swapJoker': answer(g.swapJoker(ME, msg.meldId, msg.handCardId)); break;
      case 'discard': answer(g.discard(ME, msg.cardId)); break;
      case 'nextRound': answer(g.markNextRoundReady(ME)); break;
      default: break; // profiles, probes: nothing the table needs
    }
  };
  window.WebSocket = class {
    constructor() {
      this._ls = {};
      this.readyState = 1;
      sock = this;
      window.setTimeout(() => this._emit('open', {}), 0);
    }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) { for (const f of this._ls[t] || []) f(ev); }
    send(raw) {
      try { server.receive(JSON.parse(raw)); } catch (e) { errors.push(e); }
    }
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.CLOSED = 3;

  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  const toasts = [];
  new window.MutationObserver(() => {
    const text = doc.getElementById('toastContainer').textContent;
    if (text && toasts[toasts.length - 1] !== text) toasts.push(text);
  }).observe(doc.getElementById('toastContainer'), { childList: true, characterData: true, subtree: true });

  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const visible = (id) => { const n = doc.getElementById(id); return !!n && !n.classList.contains('hidden'); };
  const click = async (node) => {
    assert.ok(node, 'nothing to tap');
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await run(50);
  };
  const coach = () => {
    const card = doc.getElementById('tutorialCoach');
    if (card.classList.contains('hidden')) return null;
    return {
      step: card.dataset.step,
      title: doc.getElementById('coachTitle').textContent,
      text: doc.getElementById('tutorialText').textContent,
      count: doc.getElementById('coachCountText').textContent,
    };
  };
  const note = () => (visible('coachNote') ? { text: doc.getElementById('coachNoteText').textContent, error: $('#coachNote').classList.contains('error') } : null);
  const myTurn = () => server.game && server.game.phase === 'playing' && server.game.currentPlayer().id === ME;
  const hand = () => server.game.players.find((p) => p.id === ME).hand;
  const close = () => { sock = null; window.close(); };
  return { window, doc, server, run, click, $, $$, visible, coach, note, myTurn, hand, toasts, vibrations, errors, close };
}

/**
 * One tap along the marks, or time for the bots. Returns false when the
 * learner's turn marks nothing to tap - a dead end a beginner cannot leave.
 */
async function tapTheGlow(t) {
  if (t.visible('tutorialNextBtn') && t.coach()) { await t.click(t.$('#tutorialNextBtn')); return true; }
  if (t.$('#drawPile.tutorialGlowTarget')) { await t.click(t.$('#drawPile')); return true; }
  if (t.$('#discardPile.tutorialGlowTarget')) { await t.click(t.$('#discardPile')); return true; }
  const stray = t.$('#hand .card.selected:not(.tutorialGlow)');
  if (stray) { await t.click(stray); return true; }
  const marked = t.$$('#hand .card.tutorialGlow');
  const next = marked.find((n) => !n.classList.contains('selected'));
  if (next) { await t.click(next); return true; }
  if (marked.length) {
    const meld = t.$('.meldGroup.tutorialGlowMeld .card');
    if (meld) { await t.click(meld); return true; }
    for (const id of ['confirmMeldBtn', 'discardBtn']) {
      if (t.$(`#${id}.tutorialGlowTarget`)) { await t.click(t.$(`#${id}`)); return true; }
    }
  }
  if (t.myTurn()) return false;
  await t.run(BOT_MS);
  return true;
}

/** Taps along the marks until "Tutorial geschafft"; returns what the run saw. */
async function playToTheEnd(t) {
  const seen = [];
  const notes = [];
  const counts = new Set();
  let resultLesson = null;
  for (let i = 0; i < 400 && !t.visible('tutorialDoneOverlay'); i++) {
    const c = t.coach();
    if (c && c.step !== 'passive' && !seen.includes(c.step)) seen.push(c.step);
    if (c) counts.add(c.count);
    const n = t.note();
    if (n && notes[notes.length - 1] !== n.text) notes.push(n.text);
    const g = t.server.game;
    if (g.mustLayOffCardId && t.myTurn()) assert.equal(c && c.step, 'pileDuty', 'an open pile duty outranks every lesson');
    if (t.visible('resultOverlay')) {
      if (t.visible('resultCoach')) resultLesson = t.$('#resultCoachTitle').textContent;
      assert.equal(c, null, 'the coach card never sits over the round sheet');
      assert.equal(t.$('#resultContinueBtn').textContent, 'Weiter', 'leads to the ending, not to round 2');
      await t.click(t.$('#resultContinueBtn'));
      continue;
    }
    if (!(await tapTheGlow(t))) assert.fail(`dead end: my turn, lesson ${c && c.step}, nothing marked`);
    assertDeck(t.server.game, `after step ${i} (${c && c.step})`);
  }
  return { seen, notes, counts, resultLesson };
}

const cardName = (cd) => (cd.isJoker ? 'JOKER' : `${cd.rank}${cd.suit}`);
const markedNames = (t) => t.$$('#hand .card.tutorialGlow')
  .map((n) => t.hand().find((cd) => String(cd.id) === n.dataset.cardId))
  .filter(Boolean).map(cardName).sort();

test('tutorial: following the marks plays round 1 to "Tutorial geschafft", lessons in order', async () => {
  const t = boot();
  try {
    await t.run(100);
    await t.click(t.$('#tutorialBtn'));
    assert.equal(t.server.joinName, 'Neuling', 'no "SpielerNNN" seat name for a learner');
    assert.equal(t.server.game.houseRules.botPace, 'slow');

    const { seen, notes, counts, resultLesson } = await playToTheEnd(t);

    assert.ok(t.visible('tutorialDoneOverlay'), `"Tutorial geschafft" after round 1 (lessons: ${seen.join(', ')})`);
    assert.equal(t.server.game.phase, 'roundEnd');
    assert.equal(t.server.game.roundNumber, 1, 'the tutorial ends with the scoring of round 1');
    assert.equal(t.server.game.lastRoundWinnerId, ME, 'following the marks wins the round');
    // Turn 1 leaves the 7♥ on the pile (it would cost the fives) and draws;
    // "Fast geschafft" comes with the last hand card, while the bots play;
    // turn 2 then lays off the drawn joker before going out.
    const order = ['welcome', 'draw', 'firstSet', 'pikdame', 'queenSet', 'joker', 'moreMelds', 'discard', 'endgame', 'layOff'];
    assert.deepStrictEqual(seen, order, 'every lesson once, in order');
    // One channel: the coach card answers own moves; the bots' moves stay news.
    assert.ok(!t.toasts.some((x) => x.startsWith('Neuling ')), `no echo of own moves (toasts: ${t.toasts.join(' | ')})`);
    assert.equal(resultLesson, 'So wird gewertet', 'the scoring lesson docks in the round sheet');
    assert.ok(notes.includes('Der Joker spielt jetzt eine Zehn.'), `the joker demo names its card (notes: ${notes.join(' | ')})`);
    assert.ok(t.vibrations.length > 0, 'a right move is felt, not only read');
    for (const count of counts) assert.match(count, /^\d+ \/ 10$/);
    assert.equal(t.coach(), null);

    // "Weiterspielen": round 2 without any hint.
    await t.click(t.$('#tutorialDoneStayBtn'));
    await t.run(BOT_MS);
    assert.equal(t.server.game.roundNumber, 2);
    assert.equal(t.coach(), null, 'no hints after the tutorial');
    assert.equal(t.$$('.tutorialGlow, .tutorialGlowMeld, .tutorialGlowTarget').length, 0);
    assert.ok(!t.visible('tutorialHintsBtn'), 'nothing to switch back on after the ending');
    assert.deepStrictEqual(t.errors, []);
  } finally {
    t.close();
  }
});

test('tutorial: "Zum Hauptmenü" ends on a plain start screen', async () => {
  const t = boot();
  try {
    await t.run(100);
    await t.click(t.$('#tutorialBtn'));
    await playToTheEnd(t);
    assert.ok(t.visible('tutorialDoneOverlay'));
    const store = t.window.localStorage;
    assert.equal(store.getItem('pikdame_last_session'), t.server.code, 'until then the tutorial is the open game');
    await t.click(t.$('#tutorialDoneMenuBtn'));
    assert.equal(store.getItem('pikdame_last_session'), null, 'no open game to resume on the start screen');
    assert.equal(store.getItem('pikdame_after_tutorial'), null, 'no follow-up game');
    // jsdom cannot navigate: the only error is the reload to the start page.
    const errors = t.errors.map((e) => String((e && e.message) || e));
    assert.equal(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /^Not implemented: navigation/);
  } finally {
    t.close();
  }
});

test('tutorial: the first draw explains why the fitting 7♥ stays on the pile; taken anyway, it is settled first', async () => {
  const t = boot();
  try {
    await t.run(100);
    await t.click(t.$('#tutorialBtn'));
    await t.click(t.$('#tutorialNextBtn')); // welcome
    assert.deepStrictEqual(t.coach(), {
      step: 'draw',
      title: 'Karte ziehen',
      text: 'Die 7♥ passt zu 5♥ 6♥ – aber dann fehlt dir die 5♥ für deine drei Fünfen. Zieh lieber vom Stapel.',
      count: '2 / 10',
    }, 'the fitting 7♥ is not ignored silently');
    assert.ok(t.$('#drawPile.tutorialGlowTarget'), 'the stock is the marked target');
    assert.ok(!t.$('#discardPile.tutorialGlowTarget'), 'the pile is not');
    assert.equal(t.$$('#hand .card.tutorialGlow').length, 0, 'no hand card marked: marks mean "tap me"');
    await t.click(t.$('#discardPile')); // off the marked path on purpose
    assert.ok(t.server.game.mustLayOffCardId, 'the pile was taken');
    assert.equal(t.coach().step, 'pileDuty');
    assert.equal(t.coach().text, 'Leg die 7♥ jetzt aus – zusammen mit 5♥ und 6♥.');
    assert.deepStrictEqual(markedNames(t), ['5H', '6H', '7H']);
    assert.ok(!/Pflicht/.test(t.$('#hint').textContent), 'one channel: no duty line under the table');

    // Refused by the engine: the coach card says why, in plain words.
    const three = t.hand().find((cd) => cd.rank === '3');
    t.server.receive({ type: 'discard', cardId: three.id });
    await t.run(50);
    assert.deepStrictEqual(t.note(), {
      text: 'Wer die Ablage nimmt, legt deren oberste Karte zuerst aus – in einer neuen Kombination mit Handkarten. Erst danach geht alles andere.',
      error: true,
    });

    for (let i = 0; i < 20 && t.server.game.mustLayOffCardId; i++) {
      assert.equal(t.coach().step, 'pileDuty', 'no other lesson while the duty is open');
      assert.ok(await tapTheGlow(t), 'the duty marks a way out');
    }
    assert.equal(t.server.game.mustLayOffCardId, null, 'settled by following the marks');
    assert.match(t.note().text, /^Erledigt/);
    // A run is not a set: the four threes still get their lesson.
    assert.equal(t.coach().step, 'firstSet');
    assert.equal(t.coach().text, 'Tippe die vier Dreien an und dann auf „Auslegen“.');
    for (let i = 0; i < 40 && t.myTurn(); i++) {
      const c = t.coach();
      assert.ok(!c || c.step !== 'pileDuty', 'the duty stays settled');
      assert.ok(await tapTheGlow(t), `dead end at ${c && c.step}`);
      assertDeck(t.server.game, `after ${c && c.step}`);
    }
    assert.ok(!t.myTurn(), 'turn 1 ends by following the marks');
    assert.deepStrictEqual(t.errors, []);
  } finally {
    t.close();
  }
});

test('tutorial: with no fitting top discard the first lesson is the stock', async () => {
  const t = boot();
  try {
    await t.run(100);
    await t.click(t.$('#tutorialBtn'));
    // Swap the 7♥ for a stock card the hand cannot use (a swap keeps the deck whole).
    const g = t.server.game;
    const me = g.players.find((p) => p.id === ME);
    let swapped = false;
    for (let i = 0; i < g.drawPile.length && !swapped; i++) {
      [g.discardPile[0], g.drawPile[i]] = [g.drawPile[i], g.discardPile[0]];
      swapped = !g.discardPile[0].isJoker && !g.canTakeDiscardTop(me, g.discardPile[0]);
      if (!swapped) [g.discardPile[0], g.drawPile[i]] = [g.drawPile[i], g.discardPile[0]];
    }
    assert.ok(swapped, 'a stock card that does not fit');
    assertDeck(g, 'after the swap');
    g.broadcastState();
    await t.run(50);
    await t.click(t.$('#tutorialNextBtn')); // welcome
    assert.deepStrictEqual(t.coach(), {
      step: 'draw', title: 'Karte ziehen', text: 'Tippe auf den verdeckten Stapel und zieh eine Karte.', count: '2 / 10',
    });
    assert.ok(t.$('#drawPile.tutorialGlowTarget'));
    assert.ok(!t.$('#discardPile.tutorialGlowTarget'));
    assert.equal(t.$$('#hand .card.tutorialGlow').length, 0, 'no hand card to join');
    await t.click(t.$('#drawPile'));
    assert.equal(g.turnPhase, 'meld');
    assert.equal(t.coach().step, 'firstSet');
    assert.deepStrictEqual(t.errors, []);
  } finally {
    t.close();
  }
});

test('tutorial: a top discard that fits for free gets the pile lesson', async () => {
  const t = boot();
  try {
    await t.run(100);
    await t.click(t.$('#tutorialBtn'));
    // Swap the 7♥ for a ten the hand's 10♠ 10♣ take - a pair, no combination to lose.
    const g = t.server.game;
    const me = g.players.find((p) => p.id === ME);
    const i = g.drawPile.findIndex((cd) => cd.rank === '10' && (cd.suit === 'D' || cd.suit === 'H'));
    assert.ok(i >= 0, 'a red ten in the stock');
    [g.discardPile[0], g.drawPile[i]] = [g.drawPile[i], g.discardPile[0]];
    assert.ok(g.canTakeDiscardTop(me, g.discardPile[0]));
    assertDeck(g, 'after the swap');
    const ten = cardName(g.discardPile[0]).replace('D', '♦').replace('H', '♥');
    g.broadcastState();
    await t.run(50);
    await t.click(t.$('#tutorialNextBtn')); // welcome
    assert.deepStrictEqual(t.coach(), {
      step: 'draw',
      title: 'Die Ablage',
      text: `Die ${ten} auf der Ablage passt zu deiner 10♠ und 10♣. Tippe auf die Ablage – dann legst du sie sofort mit beiden aus.`,
      count: '2 / 10',
    });
    assert.ok(t.$('#discardPile.tutorialGlowTarget'), 'the pile is the marked target');
    assert.ok(!t.$('#drawPile.tutorialGlowTarget'));
    assert.deepStrictEqual(markedNames(t), ['10C', '10S'], 'the cards it joins are marked');
    assert.ok(await tapTheGlow(t));
    assert.equal(t.coach().step, 'pileDuty');
    for (let n = 0; n < 20 && g.mustLayOffCardId; n++) assert.ok(await tapTheGlow(t), 'the duty marks a way out');
    assert.equal(g.mustLayOffCardId, null, 'settled by following the marks');
    assertDeck(g, 'after the duty');
    assert.deepStrictEqual(t.errors, []);
  } finally {
    t.close();
  }
});

test('tutorial: refused moves get the rule behind them, in the engine\'s own words', async () => {
  const t = boot();
  const tryMeld = async (...names) => {
    for (const name of names) {
      const cd = t.hand().find((x) => cardName(x) === name);
      await t.click(t.$(`#hand .card[data-card-id="${cd.id}"]`));
    }
    await t.click(t.$('#confirmMeldBtn'));
    const n = t.note();
    await t.click(t.$('#clearSelectionBtn'));
    return n;
  };
  try {
    await t.run(100);
    await t.click(t.$('#tutorialBtn'));
    await t.click(t.$('#tutorialNextBtn'));
    await t.click(t.$('#drawPile'));
    const run = 'Eine Folge läuft lückenlos in einer Farbe, etwa 5♥ 6♥ 7♥. Gleiche Werte in verschiedenen Farben sind ein Satz.';
    assert.deepStrictEqual(await tryMeld('3D', '5H', '6H'), { text: run, error: true }, 'mixed suits');
    assert.deepStrictEqual(await tryMeld('3S', '5S', '10S'), { text: run, error: true }, 'a gap');
    assert.ok(!t.toasts.some((x) => /Folge/.test(x)), `one channel: no toast over the card (toasts: ${t.toasts.join(' | ')})`);
    assert.ok(!/Folge/.test(t.$('#hint').textContent), 'and no second line under it');
    for (let i = 0; i < 40 && t.myTurn(); i++) assert.ok(await tapTheGlow(t));
    t.server.receive({ type: 'drawFromPile' });
    await t.run(50);
    assert.match(t.note().text, /^Warte, bis du dran bist/);
    assert.deepStrictEqual(t.errors, []);
  } finally {
    t.close();
  }
});

test('tutorial: "Überspringen" asks first, the menu brings the hints back; bots stay quiet meanwhile', async () => {
  const t = boot();
  try {
    await t.run(100);
    await t.click(t.$('#tutorialBtn'));
    // One channel: no bot line, no bot emote while the coach talks.
    const bot = t.server.game.players.find((p) => p.isBot);
    t.server.deliver({ type: 'quip', playerId: bot.id, moment: 'queen_laid' });
    t.server.deliver({ type: 'emote', playerId: bot.id, emoji: '👍' });
    await t.run(50);
    assert.equal(t.$$('.quipBubble, .emoteFloat').length, 0);
    assert.equal(t.coach().step, 'welcome');

    const skip = t.$('#tutorialOffBtn');
    await t.click(skip);
    assert.ok(t.coach(), 'one tap only asks');
    assert.equal(skip.textContent.trim(), 'Tutorial beenden?');
    await t.click(skip);
    assert.equal(t.coach(), null, 'the second tap ends the hints');
    assert.ok(t.toasts.some((x) => /Tutorial beendet/.test(x)), `says so (toasts: ${t.toasts.join(' | ')})`);
    assert.ok(t.visible('tutorialHintsBtn'), 'the way back sits in the game menu');

    await t.click(t.$('#tutorialHintsBtn'));
    assert.equal(t.coach().step, 'welcome', 'back where it stopped');
    assert.ok(!t.visible('tutorialHintsBtn'));
    assert.deepStrictEqual(t.errors, []);
  } finally {
    t.close();
  }
});

test('a normal game has no tutorial hints, whatever an older version stored', async () => {
  const t = boot({
    storage: {
      pikdame_tutorial: 'on',
      pikdame_tutorial_seen: '1',
      pikdame_tutorial_progress: JSON.stringify({ code: 'OLD123', done: ['welcome'], skipped: [], off: false, finished: false }),
      pikdame_bot_quips: 'on',
    },
  });
  try {
    await t.run(100);
    await t.click(t.$('#createGameBtn'));
    await t.run(50);
    assert.equal(t.server.game.tutorialMode, false);
    assert.equal(t.server.game.phase, 'playing');
    assert.equal(t.coach(), null, 'no coach card');
    assert.equal(t.$$('.tutorialGlow, .tutorialGlowMeld, .tutorialGlowTarget, #hand.coachSpot').length, 0, 'no marks');
    assert.equal(t.window.localStorage.getItem('pikdame_tutorial'), null, 'the old global switch is gone');
    // Duty line and bot lines belong to normal games: only the tutorial quiets them.
    await t.click(t.$('#discardPile'));
    assert.match(t.$('#hint').textContent, /^Pflicht/);
    const bot = t.server.game.players.find((p) => p.isBot);
    t.server.deliver({ type: 'quip', playerId: bot.id, moment: 'queen_laid' });
    await t.run(50);
    assert.equal(t.$$('.quipBubble').length, 1);
    assert.deepStrictEqual(t.errors, []);
  } finally {
    t.close();
  }
});

test('bot lines are off by default; switched on they show', async () => {
  const t = boot();
  try {
    await t.run(100);
    await t.click(t.$('#createGameBtn'));
    await t.run(50);
    const bot = t.server.game.players.find((p) => p.isBot);
    t.server.deliver({ type: 'quip', playerId: bot.id, moment: 'queen_laid' });
    await t.run(50);
    assert.equal(t.$$('.quipBubble').length, 0, 'no line without a choice');
    assert.equal(t.$('#botQuipsCheckbox').checked, false);
    await t.click(t.$('#botQuipsCheckbox'));
    assert.equal(t.window.localStorage.getItem('pikdame_bot_quips'), 'on');
    t.server.deliver({ type: 'quip', playerId: bot.id, moment: 'queen_laid' });
    await t.run(50);
    assert.equal(t.$$('.quipBubble').length, 1);
    assert.deepStrictEqual(t.errors, []);
  } finally {
    t.close();
  }
});
