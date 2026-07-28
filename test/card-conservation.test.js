// Kartenerhaltung: DIE Integritätsgarantie des Spiels.
//
// Anlass (v1.84.5): Ein Spieler meldete drei Pik Damen in einer Partie,
// obwohl das Deck genau zwei enthält. Ursache war die Bot-PLANUNG: sie
// schrieb ihren Arbeitsstand in die übergebenen Auslagen zurück - und bekam
// vom Ziehpfad die ECHTEN Tisch-Objekte samt einer hypothetischen "Hand",
// die den kompletten Ablagestapel enthielt. Dadurch landeten Karten auf dem
// Tisch, ohne Hand oder Ablage je zu verlassen: Duplikate.
//
// Diese Tests spielen vollständige Partien und prüfen nach JEDEM Zug, dass
// die Menge aller Karten im Spiel exakt dem Ausgangsdeck entspricht - in der
// Tages-Challenge (geseedet) wie im regulären Spiel.
const test = require('node:test');
const assert = require('node:assert');
const GameManager = require('../game/GameManager');
const Bot = require('../game/Bot');
const { createDeck } = require('../game/Deck');

const REFERENCE = (() => {
  const counts = new Map();
  for (const card of createDeck()) counts.set(card.id, (counts.get(card.id) || 0) + 1);
  return counts;
})();

/** Alle Orte, an denen eine Karte im Spiel liegen kann. */
function census(game) {
  const found = new Map();
  const add = (card, where) => {
    if (!card || !card.id) return;
    found.set(card.id, (found.get(card.id) || []).concat(where));
  };
  for (const p of game.players) for (const c of p.hand || []) add(c, `hand:${p.id}`);
  for (const meld of game.tableMelds || []) {
    for (const slot of meld.slots || []) {
      if (slot.real) add(slot.real, `meld:${meld.id}`);
      if (slot.joker) add(slot.joker, `meldJoker:${meld.id}`);
    }
  }
  for (const c of game.drawPile || []) add(c, 'draw');
  for (const c of game.discardPile || []) add(c, 'discard');
  for (const c of game.retiredJokers || []) add(c, 'retired');
  for (const c of game._pendingDeck || []) add(c, 'pendingDeck');
  return found;
}

function conservationErrors(game) {
  const found = census(game);
  const errors = [];
  for (const [id, expected] of REFERENCE) {
    const places = found.get(id) || [];
    if (places.length !== expected) {
      errors.push(`${id}: ${places.length}x statt ${expected}x (${places.join(' + ') || 'nirgends'})`);
    }
  }
  for (const [id, places] of found) {
    if (!REFERENCE.has(id)) errors.push(`unbekannte Karte ${id} @ ${places.join(' + ')}`);
  }
  return errors;
}

function playFullGame(options) {
  const game = new GameManager(() => {}, options);
  for (let i = 1; i <= 4; i++) game.addOrReconnectPlayer(`p${i}`, `P${i}`);
  for (const p of game.players) { p.isBot = true; p.botDifficulty = 'zen'; }
  game.startNewRound();

  let guard = 0;
  let queensSeenAtOnce = 0;
  while (game.phase !== 'gameOver' && guard++ < 20000) {
    if (game.phase === 'roundEnd') { game.startNewRound(); continue; }
    if (game.phase === 'cutting') { game.performCut(game.cutterId, 0.5); continue; }
    if (game.phase !== 'playing') break;
    const cp = game.currentPlayer();
    if (!cp) break;
    game.runBotTurn(cp.id);

    const errors = conservationErrors(game);
    assert.deepEqual(errors, [], `Kartenerhaltung verletzt nach Zug ${guard}:\n  ${errors.join('\n  ')}`);

    // Explizit die gemeldete Beobachtung: nie mehr als zwei Pik Damen.
    const found = census(game);
    queensSeenAtOnce = Math.max(
      queensSeenAtOnce,
      (found.get('SQ-0') || []).length + (found.get('SQ-1') || []).length
    );
  }
  game.destroy();
  return { rounds: game.roundNumber, queensSeenAtOnce };
}

test('card conservation holds through a full daily-challenge game (seeded deck)', () => {
  const r = playFullGame({ deckSeed: 20260726 });
  assert.ok(r.rounds >= 1, 'game actually played');
  assert.equal(r.queensSeenAtOnce, 2, 'exactly two Queens of Spades exist at all times');
});

test('card conservation holds through a full regular game (random deck)', () => {
  const r = playFullGame({});
  assert.ok(r.rounds >= 1, 'game actually played');
  assert.equal(r.queensSeenAtOnce, 2, 'exactly two Queens of Spades exist at all times');
});

test('bot planning never mutates the melds it is given (root cause of duplicated cards)', () => {
  // Echte Meld-Struktur (aus Rules.js): Slots sind {real} oder
  // {joker, representsRank, representsSuit}.
  const meld = {
    id: 'm1',
    ownerId: 'bot',
    type: 'run',
    suit: 'H',
    slots: [
      { real: { id: 'H5-0', suit: 'H', rank: '5', isJoker: false } },
      { real: { id: 'H6-0', suit: 'H', rank: '6', isJoker: false } },
      { joker: { id: 'JOKER-0', isJoker: true }, representsRank: '7', representsSuit: 'H' },
    ],
  };
  const before = JSON.stringify(meld);
  const hand = [
    { id: 'H8-0', suit: 'H', rank: '8', isJoker: false }, // passt zum Anlegen
    { id: 'H7-1', suit: 'H', rank: '7', isJoker: false }, // würde den Joker tauschen
  ];

  const layOffs = Bot.findLayOffs ? Bot.findLayOffs(hand, [meld]) : null;
  const swaps = Bot.findJokerSwaps ? Bot.findJokerSwaps(hand, [meld]) : null;
  // Mindestens eine der beiden Planungen muss etwas gefunden haben, sonst
  // prüft der Test nichts Substanzielles.
  const foundSomething = (layOffs && layOffs.layOffs.length > 0) || (swaps && swaps.swaps.length > 0);
  assert.ok(foundSomething, 'planner found a lay-off or swap to work with');
  assert.equal(JSON.stringify(meld), before, 'the caller-owned meld must be untouched by planning');

  // Und der komplette Planer ebenso (er ruft beide Helfer auf).
  const plan = Bot.planBotMelds(hand, [meld]);
  assert.ok(plan, 'planner returned a plan');
  assert.equal(JSON.stringify(meld), before, 'planBotMelds must not mutate the melds it is given');
});
