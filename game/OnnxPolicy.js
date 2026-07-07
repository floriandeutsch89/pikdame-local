'use strict';

/**
 * Runtime ONNX inference for the learned discard policy.
 *
 * Activated by the env var PIKDAME_ONNX=1. For each difficulty it lazily loads
 * models/pikdame-<difficulty>.onnx (via onnxruntime-node, an optional
 * dependency). Given a live game it encodes the state with the SAME
 * StateEncoder used during training, runs the model, applies the legal-action
 * mask, and returns the chosen discard card. Any problem (flag off, runtime
 * not installed, model file missing, inference error) makes it return null so
 * the caller transparently keeps the heuristic discard.
 */

const fs = require('fs');
const path = require('path');
const SE = require('./StateEncoder');

const MODELS_DIR = path.join(__dirname, '..', 'models');

let ortModule; // cached onnxruntime-node module (or false if unavailable)
const sessions = new Map(); // difficulty -> InferenceSession | null

function enabled() {
  return process.env.PIKDAME_ONNX === '1' || process.env.PIKDAME_ONNX === 'true';
}

function loadRuntime() {
  if (ortModule !== undefined) return ortModule;
  try {
    // eslint-disable-next-line global-require
    ortModule = require('onnxruntime-node');
  } catch (e) {
    ortModule = false; // not installed -> silently disabled
  }
  return ortModule;
}

async function getSession(difficulty) {
  if (sessions.has(difficulty)) return sessions.get(difficulty);
  const ort = loadRuntime();
  if (!ort) {
    sessions.set(difficulty, null);
    return null;
  }
  const file = path.join(MODELS_DIR, `pikdame-${difficulty}.onnx`);
  if (!fs.existsSync(file)) {
    sessions.set(difficulty, null);
    return null;
  }
  try {
    const session = await ort.InferenceSession.create(file);
    sessions.set(difficulty, session);
    return session;
  } catch (e) {
    sessions.set(difficulty, null);
    return null;
  }
}

/**
 * Synchronous-friendly wrapper: onnxruntime inference is async, but the bot
 * turn is synchronous. We pre-warm sessions and run inference synchronously
 * via the runtime's run() which returns a promise; callers that cannot await
 * should use chooseDiscardCardSync only after warmup() has resolved. To keep
 * the engine simple we expose an async chooser and a cached last-decision
 * fast path used by GameManager (which awaits at the seam).
 */
async function chooseDiscardCard(game, playerId, difficulty) {
  return runPolicy(game, playerId, difficulty, { phase: 'discard' });
}

/**
 * Draw-source decision: returns 'discardPile' (take the pile) or 'drawPile',
 * or null to let the caller keep the heuristic. Only meaningful when taking
 * the pile is legal; the caller checks that first.
 */
async function chooseDrawSource(game, playerId, difficulty) {
  const action = await runPolicyAction(game, playerId, difficulty, {
    phase: 'draw',
    pileTakeLegal: true,
  });
  if (action === null) return null;
  return action === SE.ACTION_TAKE_PILE ? 'discardPile' : 'drawPile';
}

/** Shared inference: returns the argmax legal action index, or null. */
async function runPolicyAction(game, playerId, difficulty, ctx) {
  if (!enabled()) return null;
  const session = await getSession(difficulty);
  if (!session) return null;
  try {
    const ort = loadRuntime();
    const obs = SE.encode(game, playerId, ctx);
    const tensor = new ort.Tensor('float32', obs, [1, SE.OBS_SIZE]);
    const inputName = session.inputNames ? session.inputNames[0] : 'obs';
    const out = await session.run({ [inputName]: tensor });
    const outName = session.outputNames ? session.outputNames[0] : 'logits';
    const logits = out[outName].data;
    const mask = SE.actionMask(game, playerId, ctx);
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < SE.ACTION_SIZE; i++) {
      if (!mask[i]) continue;
      if (logits[i] > bestVal) {
        bestVal = logits[i];
        bestIdx = i;
      }
    }
    return bestIdx >= 0 ? bestIdx : null;
  } catch (e) {
    return null;
  }
}

async function runPolicy(game, playerId, difficulty, ctx) {
  const action = await runPolicyAction(game, playerId, difficulty, ctx);
  if (action === null) return null;
  return SE.cardForAction(game, playerId, action);
}

/** Pre-load a difficulty's session (call once at startup to avoid first-turn lag). */
async function warmup(difficulties = ['medium', 'zen']) {
  if (!enabled()) return;
  await Promise.all(difficulties.map((d) => getSession(d)));
}

module.exports = {
  enabled,
  warmup,
  chooseDiscardCard,
  chooseDrawSource,
};
