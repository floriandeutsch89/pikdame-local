'use strict';

/**
 * Headless reinforcement-learning environment server.
 *
 * Drives the REAL game engine (GameManager) so training matches production
 * rules exactly - no divergent Python reimplementation. Communicates with the
 * Python Gymnasium env over stdin/stdout, one JSON object per line:
 *
 *   <- {"cmd":"reset","difficulty":"hard","opponents":3,"seed":123}
 *   -> {"obs":[...],"mask":[true,...],"done":false}
 *   <- {"cmd":"step","action":17}
 *   -> {"obs":[...],"mask":[...],"reward":0.0,"done":false}
 *   ...
 *   -> {"obs":[...],"mask":[...],"reward":1.4,"done":true}
 *
 * The agent controls ONLY the discard (draw + melds use the existing
 * heuristic); the action is a card-type index (see StateEncoder). Opponents
 * play with a configurable difficulty. Reward is sparse: 0 per step, and at
 * round end the agent's normalized score margin (own round score minus the
 * best opponent's, / 100).
 */

const readline = require('readline');
const GameManager = require('../game/GameManager');
const SE = require('../game/StateEncoder');
const { canFormMeldWithCard } = require('../game/Rules');

const AGENT_ID = 'agent';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

class EnvSession {
  constructor() {
    this.game = null;
    this.oppDifficulty = 'hard';
    this.roundStartTotalsMargin = 0;
  }

  reset(difficulty, opponents, seed, opponentDifficulties) {
    // Opponent seats: either an explicit per-seat list (mixed pool, e.g.
    // ['zen','hard','medium'] to anchor training against the zen master) or a
    // count of a single difficulty. The explicit list wins when provided.
    let oppDiffs;
    if (Array.isArray(opponentDifficulties) && opponentDifficulties.length > 0) {
      oppDiffs = opponentDifficulties.slice(0, 3);
    } else {
      const n = Math.max(2, Math.min(4, opponents || 3));
      oppDiffs = new Array(n - 1).fill(difficulty || 'hard');
    }
    this.oppDifficulty = difficulty || oppDiffs[0] || 'hard';
    if (this.game) this.game.destroy();
    const opts = typeof seed === 'number' ? { deckSeed: seed >>> 0 } : {};
    const g = new GameManager(() => {}, opts);
    g.addOrReconnectPlayer('host', 'Host');
    g.fillWithBots();
    g.players = [];
    // The agent's own seat difficulty only affects its heuristic fallback (draw
    // guards etc.); the learned policy overrides the discard. Anchor it to zen.
    g.players.push({
      id: AGENT_ID, name: 'Agent', isBot: true, hand: [], connected: true,
      laidOutCards: [], botDifficulty: 'zen', externalDiscard: 'pause',
      _everLaidThisRound: false, _laidAtTurnStart: false,
    });
    oppDiffs.forEach((diff, i) => {
      g.players.push({
        id: `opp${i + 1}`, name: `Opp${i + 1}`, isBot: true, hand: [], connected: true,
        laidOutCards: [], botDifficulty: diff,
        _everLaidThisRound: false, _laidAtTurnStart: false,
      });
    });
    g.maxSeats = g.players.length;
    this.game = g;
    this._awaiting = null;
    this._pileTakeLegal = false;
    g.startNewRound();
    return this._advanceToDecision();
  }

  /** Run one agent turn (draw already done) up to the discard pause. */
  _runAgentTurnToDiscard() {
    const g = this.game;
    g._agentAwaitingDiscard = null;
    g.runBotTurn(AGENT_ID);
    return !!g._agentAwaitingDiscard;
  }

  /**
   * Advance the game until the AGENT faces a decision (draw or discard) or the
   * game ends. Sets this._awaiting accordingly.
   */
  _advanceToDecision() {
    const g = this.game;
    let guard = 0;
    while (g.phase !== 'gameOver' && guard < 8000) {
      guard += 1;
      if (g.phase === 'roundEnd') { g.startNewRound(); continue; }
      if (g.phase !== 'playing') break;
      const cp = g.currentPlayer();
      if (!cp) break;
      if (cp.id === AGENT_ID) {
        if (g.turnPhase === 'draw') {
          // Draw decision - only a real choice when taking the pile is legal.
          const top = g.discardPile[0];
          const legal = top && !top.faceDown && canFormMeldWithCard(top, cp.hand);
          this._pileTakeLegal = !!legal;
          if (legal) { this._awaiting = 'draw'; return { done: false }; }
          // No choice: draw pile heuristically and go to the discard decision.
          cp.forcedDrawSource = 'drawPile';
        }
        if (this._runAgentTurnToDiscard()) { this._awaiting = 'discard'; return { done: false }; }
        // Turn resolved without a free discard (went out / forced card) - keep going.
        continue;
      }
      const before = g.turnIndexInRound;
      const beforeId = cp.id;
      g.runBotTurn(cp.id);
      if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === beforeId) {
        g.finishRound(null);
      }
    }
    this._awaiting = null;
    return { done: true };
  }

  _observation(done, reward) {
    const g = this.game;
    const phase = this._awaiting === 'draw' ? 'draw' : 'discard';
    if (done) {
      return {
        obs: Array.from(new Float32Array(SE.OBS_SIZE)),
        mask: new Array(SE.ACTION_SIZE).fill(false),
        reward: reward || 0, done: true, phase,
      };
    }
    return {
      obs: Array.from(SE.encode(g, AGENT_ID, { phase })),
      mask: SE.actionMask(g, AGENT_ID, { phase, pileTakeLegal: this._pileTakeLegal }),
      reward: reward || 0, done: false, phase,
    };
  }

  resetAndObserve(difficulty, opponents, seed, opponentDifficulties) {
    const r = this.reset(difficulty, opponents, seed, opponentDifficulties);
    return this._observation(r.done, 0);
  }

  step(action) {
    const g = this.game;
    if (!g || g.phase === 'gameOver') return this._observation(true, 0);
    const agent = g.players.find((p) => p.id === AGENT_ID);
    const prevRound = g.roundNumber;

    if (this._awaiting === 'draw') {
      agent.forcedDrawSource = action === SE.ACTION_TAKE_PILE && this._pileTakeLegal ? 'discardPile' : 'drawPile';
      this._awaiting = null;
      if (this._runAgentTurnToDiscard()) {
        this._awaiting = 'discard';
        return this._observation(false, 0);
      }
      // resolved without discard -> advance
      const res = this._advanceToDecision();
      return this._observation(res.done, this._roundReward(prevRound));
    }

    // discard decision
    const pending = g._agentAwaitingDiscard;
    if (pending) {
      let chosen = SE.cardForAction(g, AGENT_ID, action);
      if (!chosen) chosen = agent.hand.find((c) => !c.isJoker) || agent.hand[0];
      g._agentAwaitingDiscard = null;
      this._awaiting = null;
      if (chosen) g.discard(AGENT_ID, chosen.id);
    }
    const res = this._advanceToDecision();
    let reward = this._roundReward(prevRound);
    if (g.phase === 'gameOver') {
      const ranked = Object.entries(g.totals).sort((a, b) => b[1] - a[1]);
      reward += ranked[0][0] === AGENT_ID ? 1 : -1;
      return this._observation(true, reward);
    }
    return this._observation(res.done, reward);
  }

  _roundReward(prevRound) {
    const g = this.game;
    if (g.lastRoundResult && g.roundNumber !== prevRound) {
      const rr = g.lastRoundResult;
      const mine = rr[AGENT_ID] ? rr[AGENT_ID].roundScore : 0;
      const others = Object.entries(rr).filter(([pid]) => pid !== AGENT_ID).map(([, r]) => r.roundScore);
      return (mine - (others.length ? Math.max(...others) : 0)) / 100;
    }
    return 0;
  }
}

function main() {
  const session = new EnvSession();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      send({ error: 'bad json' });
      return;
    }
    try {
      if (msg.cmd === 'reset') {
        send(session.resetAndObserve(msg.difficulty, msg.opponents, msg.seed, msg.opponentDifficulties));
      } else if (msg.cmd === 'step') {
        send(session.step(msg.action | 0));
      } else if (msg.cmd === 'meta') {
        send({ obs_size: SE.OBS_SIZE, action_size: SE.ACTION_SIZE });
      } else if (msg.cmd === 'close') {
        if (session.game) session.game.destroy();
        rl.close();
        process.exit(0);
      } else {
        send({ error: 'unknown cmd' });
      }
    } catch (e) {
      send({ error: String((e && e.message) || e) });
    }
  });
}

main();
