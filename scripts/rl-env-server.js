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

  reset(difficulty, opponents, seed) {
    this.oppDifficulty = difficulty || 'hard';
    const n = Math.max(2, Math.min(4, opponents || 3));
    if (this.game) this.game.destroy();
    const opts = typeof seed === 'number' ? { deckSeed: seed >>> 0 } : {};
    const g = new GameManager(() => {}, opts);
    g.addOrReconnectPlayer('host', 'Host');
    g.fillWithBots();
    g.players = [];
    // seat 0 = the learning agent (external discard), the rest are heuristic bots
    g.players.push({
      id: AGENT_ID, name: 'Agent', isBot: true, hand: [], connected: true,
      laidOutCards: [], botDifficulty: this.oppDifficulty, externalDiscard: 'pause',
      _everLaidThisRound: false, _laidAtTurnStart: false,
    });
    for (let i = 1; i < n; i++) {
      g.players.push({
        id: `opp${i}`, name: `Opp${i}`, isBot: true, hand: [], connected: true,
        laidOutCards: [], botDifficulty: this.oppDifficulty,
        _everLaidThisRound: false, _laidAtTurnStart: false,
      });
    }
    g.maxSeats = n;
    this.game = g;
    g.startNewRound();
    return this._advanceToAgentDecision();
  }

  /** Run the game forward until the agent must discard, or the game ends. */
  _advanceToAgentDecision() {
    const g = this.game;
    let guard = 0;
    while (g.phase !== 'gameOver' && guard < 5000) {
      guard += 1;
      if (g.phase === 'roundEnd') {
        g.startNewRound();
        continue;
      }
      if (g.phase !== 'playing') break;
      const cp = g.currentPlayer();
      if (!cp) break;
      if (cp.id === AGENT_ID) {
        g._agentAwaitingDiscard = null;
        g.runBotTurn(AGENT_ID); // pauses before the free discard (externalDiscard='pause')
        if (g._agentAwaitingDiscard) {
          return { done: false };
        }
        // Turn resolved without a free discard (e.g. went out / forced card):
        // nothing for the agent to decide, keep advancing.
        continue;
      }
      const before = g.turnIndexInRound;
      const beforeId = cp.id;
      g.runBotTurn(cp.id);
      if (g.phase === 'playing' && g.turnIndexInRound === before && g.currentPlayer().id === beforeId) {
        g.finishRound(null); // no-progress guard
      }
    }
    return { done: true };
  }

  _observation(done, reward) {
    const g = this.game;
    if (done) {
      return { obs: Array.from(new Float32Array(SE.OBS_SIZE)), mask: new Array(SE.ACTION_SIZE).fill(false), reward: reward || 0, done: true };
    }
    return {
      obs: Array.from(SE.encode(g, AGENT_ID)),
      mask: SE.actionMask(g, AGENT_ID),
      reward: reward || 0,
      done: false,
    };
  }

  resetAndObserve(difficulty, opponents, seed) {
    const r = this.reset(difficulty, opponents, seed);
    return this._observation(r.done, 0);
  }

  step(action) {
    const g = this.game;
    if (!g || g.phase === 'gameOver') return this._observation(true, 0);

    const pending = g._agentAwaitingDiscard;
    let chosen = null;
    if (pending) {
      chosen = SE.cardForAction(g, AGENT_ID, action);
      // Illegal action -> fall back to a legal card (mask should prevent this).
      if (!chosen) {
        const agent = g.players.find((p) => p.id === AGENT_ID);
        chosen = agent.hand.find((c) => !c.isJoker) || agent.hand[0];
      }
      g._agentAwaitingDiscard = null;
      if (chosen) g.discard(AGENT_ID, chosen.id);
    }

    // Detect round transition to hand out the sparse reward.
    const prevRound = g.roundNumber;
    const res = this._advanceToAgentDecision();
    let reward = 0;
    if (g.lastRoundResult && g.roundNumber !== prevRound) {
      const rr = g.lastRoundResult;
      const mine = rr[AGENT_ID] ? rr[AGENT_ID].roundScore : 0;
      const others = Object.entries(rr).filter(([pid]) => pid !== AGENT_ID).map(([, r]) => r.roundScore);
      reward = (mine - (others.length ? Math.max(...others) : 0)) / 100;
    }
    if (g.phase === 'gameOver') {
      // Terminal bonus: +1 for winning the whole game, -1 otherwise.
      const ranked = Object.entries(g.totals).sort((a, b) => b[1] - a[1]);
      reward += ranked[0][0] === AGENT_ID ? 1 : -1;
      return this._observation(true, reward);
    }
    return this._observation(res.done, reward);
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
        send(session.resetAndObserve(msg.difficulty, msg.opponents, msg.seed));
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
