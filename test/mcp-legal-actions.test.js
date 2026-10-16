/**
 * mcp/LegalActions.js lists the moves an LLM seat may pick. Every listed move
 * must be accepted by the REAL game (no false positives), and the list must
 * never leave the seat stuck (a pickup duty always has a meld to fulfil it).
 * Fuzzed over whole games: one seat plays random listed moves, three zen bots.
 */
const test = require('node:test');
const assert = require('node:assert');
const GameManager = require('../game/GameManager');
const { legalActions } = require('../mcp/LegalActions');

const ME = 'p1';

function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Same method mapping as server.js's message handler.
function apply(game, msg) {
  switch (msg.type) {
    case 'drawFromPile': return game.drawFromPile(ME);
    case 'drawFromDiscard': return game.drawFromDiscard(ME);
    case 'layoutMeld': return game.layoutMeld(ME, msg.cardIds, msg.jokerAssignments || {});
    case 'layOff': return game.layOffCard(ME, msg.meldId, msg.cardId, msg.asSuit, msg.side);
    case 'swapJoker': return game.swapJoker(ME, msg.meldId, msg.handCardId);
    case 'discard': return game.discard(ME, msg.cardId);
    case 'undoPileTake': return game.undoPileTake(ME);
    case 'undoMeld': return game.undoMeldAction(ME);
    default: throw new Error(`unexpected ${msg.type}`);
  }
}

function cloneOf(game) {
  const c = new GameManager(() => {});
  c.deserialize(JSON.parse(JSON.stringify(game.serialize())));
  for (const p of c.players) if (!p.isBot) p.connected = true;
  return c;
}

function playOneGame(seed, maxDecisions) {
  const rng = seededRng(seed);
  const game = new GameManager(() => {}, { deckSeed: seed });
  for (let i = 1; i <= 4; i++) game.addOrReconnectPlayer(`p${i}`, `P${i}`);
  for (const p of game.players.slice(1)) { p.isBot = true; p.botDifficulty = 'zen'; }
  game.startNewRound();
  let decisions = 0;
  let checked = 0;
  let guard = 0;
  try {
    while (game.phase !== 'gameOver' && decisions < maxDecisions && guard++ < 20000) {
      if (game.phase === 'roundEnd') { game.startNewRound(); continue; }
      if (game.phase === 'cutting') { game.performCut(game.cutterId, 0.5); continue; }
      const cp = game.currentPlayer();
      if (cp.id !== ME) { game.runBotTurn(cp.id); continue; }

      const state = game.publicState(ME);
      const actions = legalActions(state, ME);
      assert.ok(actions.length > 0, `seat stuck: phase ${state.turnPhase}, must ${state.mustLayOffCardId}`);
      if (state.mustLayOffCardId) {
        assert.ok(actions.some((a) => a.msg.type === 'layoutMeld'), 'a pickup duty always has a meld that fulfils it');
      }
      for (const a of actions) {
        if (a.msg.type === 'undoMeld') continue; // a restored clone has no undo history
        const clone = cloneOf(game);
        try {
          const r = apply(clone, a.msg);
          assert.ok(r && r.ok, `engine rejected listed action "${a.label}": ${JSON.stringify(r)}`);
        } finally {
          clone.destroy();
        }
        checked++;
      }
      // Prefer progress over undo so random play still reaches round ends.
      const pool = actions.filter((a) => !a.msg.type.startsWith('undo'));
      const pick = pool[Math.floor(rng() * pool.length)];
      const r = apply(game, pick.msg);
      assert.ok(r && r.ok, `real game rejected "${pick.label}"`);
      decisions++;
    }
  } finally {
    game.destroy();
  }
  return { decisions, checked };
}

test('every listed action is accepted by the real engine (fuzzed games)', () => {
  let checked = 0;
  for (const seed of [11, 23, 42, 77, 101, 2024]) {
    checked += playOneGame(seed, 400).checked;
  }
  assert.ok(checked > 1000, `too few actions checked (${checked})`);
});

test('no actions outside your own turn, draw phase offers only draw/take', () => {
  const game = new GameManager(() => {}, { deckSeed: 5 });
  for (let i = 1; i <= 2; i++) game.addOrReconnectPlayer(`p${i}`, `P${i}`);
  game.players[1].isBot = true;
  game.startNewRound();
  if (game.phase === 'cutting') game.performCut(game.cutterId, 0.5);
  while (game.currentPlayer().id !== ME) game.runBotTurn(game.currentPlayer().id);
  const other = legalActions(game.publicState('p2'), 'p2');
  assert.deepEqual(other, []);
  const mine = legalActions(game.publicState(ME), ME);
  assert.ok(mine.every((a) => a.msg.type === 'drawFromPile' || a.msg.type === 'drawFromDiscard'));
  game.destroy();
});
