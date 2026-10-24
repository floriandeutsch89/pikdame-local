'use strict';

/**
 * Headless reinforcement-learning environment server.
 *
 * Drives the REAL game engine (GameManager) so training matches production
 * rules exactly - no divergent Python reimplementation. Communicates with the
 * Python Gymnasium env over stdin/stdout, one JSON object per line:
 *
 *   <- {"cmd":"meta","obsVersion":2}
 *   -> {"obs_size":385,"action_size":54,"obs_version":2}
 *   <- {"cmd":"reset","opponentDifficulties":["self","hard","zen"],"teamMode":true,"seed":123}
 *   -> {"obs":[...],"mask":[true,...],"seat":0,"reward":0,"done":false,"phase":"draw"}
 *   <- {"cmd":"step","action":17}
 *   -> {"obs":[...],"mask":[...],"seat":1,"reward":0.0,"done":false,"phase":"discard"}
 *   ...
 *   -> {"obs":[...],"mask":[...],"seat":0,"reward":1.4,"done":true,"won":true,...}
 *
 * Seat 0 is the learning agent. A seat whose difficulty is "self" is answered
 * by the caller as well (self-play: Python plays it with a frozen snapshot);
 * every other seat plays the heuristic at its difficulty. `seat` names who
 * decides next; the reward is always the agent's. The caller controls ONLY
 * draw source and discard (melds stay heuristic); the action is a card-type
 * index (see StateEncoder). `meta` fixes the observation version (default 1).
 *
 * Reward, per finished round and at the end:
 *   normal:     (own round score - the opponents' mean) / 100, +1 / -1 for the match
 *   team mode:  (own team's round score - the other team's) / 200, +1 / -1 for the team
 * Team mode ("2 gegen 2") seats four: the agent's partner is seat 2.
 * PIKDAME_RL_REWARD=max measures a normal round against the best opponent instead.
 */

// stdout is the wire protocol: exactly one JSON object per line, nothing else.
// Any stray console.log (e.g. OnnxPolicy's "ONNX-Modell geladen") would be read
// by Python as a response and crash the training run with a JSONDecodeError.
// Diagnostics go to stderr instead.
console.log = console.error;
console.info = console.error;

// The env drives every turn itself and synchronously. The learned policy must
// never kick in here - it is async and would also make opponents diverge from
// the heuristic baseline the reward is measured against. Force it off even when
// onnxruntime-node and models are installed (auto mode would enable it).
process.env.PIKDAME_ONNX = '0';
// Training games are no human moves: never log them.
process.env.PIKDAME_LOG_GAMES = '0';

const readline = require('readline');
const GameManager = require('../game/GameManager');
const SE = require('../game/StateEncoder');
const Teams = require('../game/Teams');
const { canFormMeldWithCard } = require('../game/Rules');

const AGENT_ID = 'agent';
const SELF = 'self';

// The contract with python/ and every trained .onnx: these sizes ARE the model
// input/output. A change here needs retraining (test/state-encoder.test.js pins them too).
const CONTRACT = { obs: { 1: 377, 2: 385 }, actions: 54 };

function contractErrors() {
  const errors = [];
  for (const [v, size] of Object.entries(CONTRACT.obs)) {
    if (SE.obsSize(Number(v)) !== size) errors.push(`v${v} observation ${SE.obsSize(Number(v))} != ${size}`);
  }
  if (SE.ACTION_SIZE !== CONTRACT.actions) errors.push(`actions ${SE.ACTION_SIZE} != ${CONTRACT.actions}`);
  return errors;
}

// Which opponent baseline the round reward is measured against: 'mean' (default,
// low variance) or 'max' (the original, high variance). See _margin().
const REWARD_BASELINE = process.env.PIKDAME_RL_REWARD === 'max' ? 'max' : 'mean';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function seatOf(id, name, botDifficulty, external) {
  return {
    id, name, isBot: true, hand: [], connected: true, laidOutCards: [], botDifficulty,
    ...(external ? { externalDiscard: 'pause' } : {}),
    _everLaidThisRound: false, _laidAtTurnStart: false,
  };
}

class EnvSession {
  constructor() {
    this.game = null;
    this.obsVersion = 1;
    this.external = new Set(); // seat ids the caller answers (agent + self-play)
    this.decider = null; // the seat id whose decision is pending
    this._awaiting = null; // 'draw' | 'discard' | null
    this._pileTakeLegal = false;
    this._rewardedRound = 0;
  }

  setObsVersion(version) {
    SE.obsSize(version); // throws on an unknown version
    this.obsVersion = version;
  }

  reset({ difficulty, opponents, seed, opponentDifficulties, teamMode } = {}) {
    // Opponent seats: either an explicit per-seat list (mixed pool, e.g.
    // ['zen','medium','easy'] to anchor training against the zen master) or a
    // count of a single difficulty. The explicit list wins when provided.
    let oppDiffs;
    if (Array.isArray(opponentDifficulties) && opponentDifficulties.length > 0) {
      oppDiffs = opponentDifficulties.slice(0, 3).map(String);
    } else {
      const n = Math.max(2, Math.min(4, opponents || 3));
      oppDiffs = new Array(n - 1).fill(difficulty || 'medium');
    }
    if (teamMode) while (oppDiffs.length < Teams.TEAM_SEATS - 1) oppDiffs.push(oppDiffs[oppDiffs.length - 1]);
    if (this.game) this.game.destroy();
    const opts = {};
    if (typeof seed === 'number') opts.deckSeed = seed >>> 0;
    if (teamMode) opts.teamMode = true;
    const g = new GameManager(() => {}, opts);
    // No background bot timers: while Python is busy (PPO update phase takes
    // seconds) a 700-1300 ms timer would otherwise fire and play turns - even
    // the paused agent's - behind the env's back. _advanceToDecision() runs
    // every turn explicitly.
    g.maybeRunBotTurn = () => {};
    // A seat the caller plays keeps 'zen' for its heuristic parts (draw guards,
    // melds), like the net's seat at runtime; the policy overrides draw and discard.
    g.players = [seatOf(AGENT_ID, 'Agent', 'zen', true)];
    oppDiffs.forEach((diff, i) => {
      g.players.push(seatOf(`opp${i + 1}`, `Opp${i + 1}`, diff === SELF ? 'zen' : diff, diff === SELF));
    });
    g.totals = {};
    for (const p of g.players) g.totals[p.id] = 0;
    g.maxSeats = g.players.length;
    this.game = g;
    this.external = new Set(g.players.filter((p) => p.externalDiscard === 'pause').map((p) => p.id));
    this.decider = null;
    this._awaiting = null;
    this._pileTakeLegal = false;
    g.startNewRound();
    const res = this._advanceToDecision();
    // Rounds over before the agent's first decision are not its doing.
    this._rewardedRound = g.roundHistory.length ? g.roundHistory[g.roundHistory.length - 1].roundNumber : 0;
    return res;
  }

  /** Run a caller-played seat's turn (draw already decided) up to its discard pause. */
  _runTurnToDiscard(seatId) {
    const g = this.game;
    g._agentAwaitingDiscard = null;
    g.runBotTurn(seatId);
    return !!(g._agentAwaitingDiscard && g._agentAwaitingDiscard.botId === seatId);
  }

  /** A turn that changed nothing would loop forever: end the round instead. */
  _guardProgress(beforeTurn, beforeId) {
    const g = this.game;
    if (g.phase === 'playing' && g.turnIndexInRound === beforeTurn && g.currentPlayer().id === beforeId) {
      g.finishRound(null);
    }
  }

  /**
   * Advance the game until a caller-played seat faces a decision (draw or
   * discard) or the game ends. Sets this.decider and this._awaiting.
   */
  _advanceToDecision() {
    const g = this.game;
    let guard = 0;
    while (g.phase !== 'gameOver' && guard < 8000) {
      guard += 1;
      if (g.phase === 'roundEnd') { g.startNewRound(); continue; }
      // Defensive: with an all-bot table the cutting phase never engages
      // (bots auto-cut synchronously), but if that invariant ever changes,
      // cut here instead of silently breaking the training loop.
      if (g.phase === 'cutting') { g.performCut(g.cutterId, Math.random()); continue; }
      if (g.phase !== 'playing') break;
      const cp = g.currentPlayer();
      if (!cp) break;
      const before = g.turnIndexInRound;
      if (this.external.has(cp.id)) {
        this.decider = cp.id;
        if (g.turnPhase === 'draw') {
          // Draw decision - only a real choice when taking the pile is legal.
          const top = g.discardPile[0];
          const legal = top && !top.faceDown && canFormMeldWithCard(top, cp.hand);
          this._pileTakeLegal = !!legal;
          if (legal) { this._awaiting = 'draw'; return { done: false }; }
          // No choice: draw pile heuristically and go to the discard decision.
          cp.forcedDrawSource = 'drawPile';
        }
        if (this._runTurnToDiscard(cp.id)) { this._awaiting = 'discard'; return { done: false }; }
        // Turn resolved without a free discard (went out / forced card) - keep going.
        this._guardProgress(before, cp.id);
        continue;
      }
      g.runBotTurn(cp.id);
      this._guardProgress(before, cp.id);
    }
    this._awaiting = null;
    this.decider = null;
    return { done: true };
  }

  _agentWon() {
    const g = this.game;
    if (g.teamMode) return !!g.gameOverInfo && g.gameOverInfo.winnerTeam === g.teamOf(AGENT_ID);
    const ranked = Object.entries(g.totals || {}).sort((a, b) => b[1] - a[1]);
    return !!(ranked[0] && ranked[0][0] === AGENT_ID);
  }

  _observation(done, reward) {
    const g = this.game;
    const phase = this._awaiting === 'draw' ? 'draw' : 'discard';
    if (done) {
      // Report the OUTCOME too. The scalar reward alone cannot tell you whether
      // the agent actually won (it is a relative margin), so evaluation would
      // otherwise have no way to compute a win rate - the only metric that is
      // meaningful on its own.
      return {
        obs: new Array(SE.obsSize(this.obsVersion)).fill(0),
        mask: new Array(SE.ACTION_SIZE).fill(false),
        seat: 0, reward: reward || 0, done: true, phase,
        won: g.phase === 'gameOver' && this._agentWon(),
        totals: g.totals || {},
        ...(g.teamMode ? { teamMode: true, teamTotals: g.teamTotals() } : {}),
      };
    }
    return {
      obs: Array.from(SE.encode(g, this.decider, { phase, version: this.obsVersion })),
      mask: SE.actionMask(g, this.decider, { phase, pileTakeLegal: this._pileTakeLegal }),
      seat: g.players.findIndex((p) => p.id === this.decider),
      reward: reward || 0, done: false, phase,
    };
  }

  resetAndObserve(msg) {
    const r = this.reset(msg);
    return this._observation(r.done, 0);
  }

  step(action) {
    const g = this.game;
    if (!g || g.phase === 'gameOver' || !this.decider) return this._observation(true, 0);
    const cp = g.players.find((p) => p.id === this.decider);

    if (this._awaiting === 'draw') {
      cp.forcedDrawSource = action === SE.ACTION_TAKE_PILE && this._pileTakeLegal ? 'discardPile' : 'drawPile';
      this._awaiting = null;
      const before = g.turnIndexInRound;
      if (this._runTurnToDiscard(cp.id)) {
        this._awaiting = 'discard';
        return this._observation(false, 0);
      }
      // resolved without discard -> advance
      this._guardProgress(before, cp.id);
      return this._settle(this._advanceToDecision());
    }

    // discard decision
    const pending = g._agentAwaitingDiscard;
    if (pending && pending.botId === cp.id) {
      let chosen = SE.cardForAction(g, cp.id, action);
      if (!chosen) chosen = cp.hand.find((c) => !c.isJoker) || cp.hand[0];
      g._agentAwaitingDiscard = null;
      this._awaiting = null;
      if (chosen) g.discard(cp.id, chosen.id);
    }
    return this._settle(this._advanceToDecision());
  }

  /** Observation after a step: round rewards, plus the match result at the end. */
  _settle(res) {
    const g = this.game;
    let reward = this._roundRewards();
    if (g.phase === 'gameOver') {
      reward += this._agentWon() ? 1 : -1;
      return this._observation(true, reward);
    }
    return this._observation(res.done, reward);
  }

  /** Every round finished since the last reward, the match's final one included. */
  _roundRewards() {
    let reward = 0;
    for (const r of this.game.roundHistory || []) {
      if (r.roundNumber <= this._rewardedRound) continue;
      this._rewardedRound = r.roundNumber;
      reward += this._margin(r.results || {});
    }
    return reward;
  }

  _margin(results) {
    const g = this.game;
    const score = (pid) => (results[pid] ? results[pid].roundScore : 0);
    if (g.teamMode) {
      const sums = Teams.teamSums(g.teams(), Object.fromEntries(g.players.map((p) => [p.id, score(p.id)])));
      const mine = g.teamOf(AGENT_ID);
      // Per seat on both sides, so a team round weighs like a normal one.
      return (sums[mine] - sums[1 - mine]) / 200;
    }
    const others = g.players.filter((p) => p.id !== AGENT_ID).map((p) => score(p.id));
    if (!others.length) return 0;
    // Baseline the agent is scored against.
    //
    // 'mean' (default): compare against the AVERAGE opponent. This measures
    // "am I better than this table", which is what we actually want, and it
    // is a much lower-variance signal.
    //
    // 'max' (the original): compare against the BEST of three. That makes the
    // reward depend heavily on whichever opponent happened to draw a lucky
    // hand - noise the agent cannot influence. Noise in the target is exactly
    // what stops the critic from learning (it shows up as a poor
    // explained_variance), so the actor ends up learning from a signal that
    // is largely luck. Kept behind the env var so the old objective can be
    // reproduced and the two compared.
    const baseline = REWARD_BASELINE === 'max'
      ? Math.max(...others)
      : others.reduce((a, b) => a + b, 0) / others.length;
    return (score(AGENT_ID) - baseline) / 100;
  }
}

function main() {
  const broken = contractErrors();
  if (broken.length) {
    console.error(`StateEncoder broke the training contract (${broken.join('; ')}): retrain, then update CONTRACT.`);
    process.exit(1);
  }
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
        send(session.resetAndObserve(msg));
      } else if (msg.cmd === 'step') {
        send(session.step(msg.action | 0));
      } else if (msg.cmd === 'meta') {
        if (msg.obsVersion !== undefined) session.setObsVersion(Number(msg.obsVersion));
        send({ obs_size: SE.obsSize(session.obsVersion), action_size: SE.ACTION_SIZE, obs_version: session.obsVersion });
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
