'use strict';

/**
 * Runtime ONNX inference for the learned discard policy.
 *
 * Activated by the env var PIKDAME_ONNX=1. For each difficulty it lazily loads
 * models/pikdame-<difficulty>.onnx (via onnxruntime-node, an optional
 * dependency); only Zen is routed here (GameManager._botTurnUsesOnnx). Given a
 * live game it encodes the state with the SAME StateEncoder used during
 * training, runs the model, applies the legal-action mask, and returns the
 * chosen discard card. Any problem (flag off, runtime not installed, model
 * file missing, inference error) makes it return null so the caller
 * transparently keeps the heuristic discard.
 *
 * The model's input size picks the StateEncoder version (377 = v1, 385 = v2).
 * Only a v2 model reads the team features, so only it plays "2 gegen 2"
 * (supportsTeams); a v1 model leaves team tables to the heuristic.
 */

const fs = require('fs');
const path = require('path');
const SE = require('./StateEncoder');

// Where the .onnx files live. Overridable so operators can mount models on a
// volume (e.g. PIKDAME_MODELS_DIR=/app/data/models) and swap them WITHOUT
// rebuilding the image. Default: the models/ folder baked into the image.
const MODELS_DIR = process.env.PIKDAME_MODELS_DIR || path.join(__dirname, '..', 'models');

let ortModule; // cached onnxruntime-node module (or false if unavailable)
const sessions = new Map(); // difficulty -> Promise<{ session, version } | null>
const loaded = new Map(); // difficulty -> the settled entry, for synchronous checks

// Explicit operator choice, or null when the variable is not set at all.
function explicitChoice() {
  const v = process.env.PIKDAME_ONNX;
  if (v === undefined || v === '') return null;
  return v === '1' || v === 'true';
}

let autoAvailable; // cached probe result

/**
 * Can THIS installation actually run the learned bots? Both halves must be
 * present: the native runtime and at least one model file.
 */
function probeAvailable() {
  try {
    require.resolve('onnxruntime-node');
  } catch (e) {
    return false; // e.g. the iPhone/CodeApp path - no native modules there
  }
  try {
    return fs.readdirSync(MODELS_DIR).some((f) => f.endsWith('.onnx'));
  } catch (e) {
    return false;
  }
}

/**
 * Default is now AUTO: a plain `node server.js` uses the learned bots whenever
 * the runtime and the models are both there, instead of needing PIKDAME_ONNX=1.
 * PIKDAME_ONNX=0 forces the heuristic, PIKDAME_ONNX=1 forces the learned path
 * (and complains loudly if it cannot be honoured). Where the runtime is absent
 * - the hotspot/CodeApp mode - auto stays off and says nothing, so that path is
 * completely unchanged.
 */
function enabled() {
  const choice = explicitChoice();
  if (choice !== null) return choice;
  if (autoAvailable === undefined) autoAvailable = probeAvailable();
  return autoAvailable;
}

function loadRuntime() {
  if (ortModule !== undefined) return ortModule;
  try {
    // eslint-disable-next-line global-require
    ortModule = require('onnxruntime-node');
  } catch (e) {
    ortModule = false;
    // Falling back is safe, but a SILENT fallback is a trap: you set
    // PIKDAME_ONNX=1, nothing happens, and you never find out why.
    // In AUTO mode there is nothing to warn about - the absence of the
    // runtime IS the decision, and the hotspot path must stay quiet.
    if (explicitChoice() === true) {
      console.error('');
      console.error('*** ⚠️  PIKDAME_ONNX ist aktiv, aber onnxruntime-node fehlt. ***');
      console.error('***     Die Bots spielen weiter mit der HEURISTIK (kein Ausfall).');
      console.error('***     Das Standard-Image enthält die Laufzeit bewusst nicht.');
      console.error('***     Abhilfe: Image mit `npm i onnxruntime-node` bauen.');
      console.error('');
    }
  }
  return ortModule;
}

/**
 * Encoder version of a loaded model from its input size: the declared shape
 * where the runtime exposes it (onnxruntime >= 1.22), else a zero-input probe
 * per version (a wrong size is rejected by the runtime). null = no match.
 */
async function obsVersionOf(ort, session) {
  const meta = session.inputMetadata && session.inputMetadata[0];
  const declared = meta && Array.isArray(meta.shape) ? meta.shape[meta.shape.length - 1] : undefined;
  if (typeof declared === 'number') return { version: SE.versionForSize(declared), size: declared };
  const inputName = session.inputNames ? session.inputNames[0] : 'obs';
  for (const version of [2, 1]) {
    const size = SE.obsSize(version);
    try {
      await session.run({ [inputName]: new ort.Tensor('float32', new Float32Array(size), [1, size]) });
      return { version, size };
    } catch (e) {
      // not this size
    }
  }
  return { version: null, size: '?' };
}

async function loadSession(difficulty) {
  const ort = loadRuntime();
  if (!ort) return null;
  const file = path.join(MODELS_DIR, `pikdame-${difficulty}.onnx`);
  if (!fs.existsSync(file)) {
    console.error(
      `⚠️  PIKDAME_ONNX aktiv, aber Modell fehlt: ${file} - ` +
      `Schwierigkeit "${difficulty}" spielt weiter mit der Heuristik. ` +
      '(Modelle ins Image kopieren oder PIKDAME_MODELS_DIR auf ein Volume zeigen lassen.)'
    );
    return null;
  }
  try {
    // PIKDAME_ONNX_THREADS: the Kartenhaus deal worker runs on one thread (throttled).
    const threads = Number(process.env.PIKDAME_ONNX_THREADS) || 0;
    const session = threads > 0
      ? await ort.InferenceSession.create(file, { intraOpNumThreads: threads, interOpNumThreads: 1 })
      : await ort.InferenceSession.create(file);
    const { version, size } = await obsVersionOf(ort, session);
    if (!version) {
      console.error(
        `⚠️  ONNX-Modell ${file} passt zu keiner Kodierung (Eingabe ${size}, erwartet ` +
        `${SE.OBS_SIZE_V1} oder ${SE.OBS_SIZE_V2}) - Schwierigkeit "${difficulty}" spielt mit der Heuristik.`
      );
      return null;
    }
    console.log(
      `ONNX-Modell geladen: ${file} (Schwierigkeit "${difficulty}", Kodierung v${version}` +
      `${version >= 2 ? ', spielt auch „2 gegen 2“' : ''})`
    );
    return { session, version };
  } catch (e) {
    return null;
  }
}

/** The difficulty's model (once per process; concurrent callers share the load). */
function getSession(difficulty) {
  if (!sessions.has(difficulty)) {
    sessions.set(difficulty, loadSession(difficulty).then((entry) => {
      loaded.set(difficulty, entry);
      return entry;
    }));
  }
  return sessions.get(difficulty);
}

/**
 * Synchronous: does the loaded model read the team features (v2)? False until
 * it has loaded - the first call starts the load (the server warms up at start).
 */
function supportsTeams(difficulty = 'zen') {
  if (!enabled()) return false;
  if (!sessions.has(difficulty)) getSession(difficulty);
  const entry = loaded.get(difficulty);
  return !!(entry && entry.version >= 2);
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
  const entry = await getSession(difficulty);
  if (!entry) return null;
  // A v1 model never saw a team table: the caller keeps the heuristic.
  if (game.teamMode && entry.version < 2) return null;
  const { session, version } = entry;
  try {
    const ort = loadRuntime();
    const obs = SE.encode(game, playerId, { ...ctx, version });
    const tensor = new ort.Tensor('float32', obs, [1, obs.length]);
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
async function warmup(difficulties = ['zen']) {
  if (!enabled()) return;
  await Promise.all(difficulties.map((d) => getSession(d)));
}

// For the config report: does the runtime + model pair actually exist?
// enabled() alone says yes to a forced PIKDAME_ONNX=1 even when it cannot work.
function available() {
  if (autoAvailable === undefined) autoAvailable = probeAvailable();
  return autoAvailable;
}

module.exports = {
  enabled,
  available,
  warmup,
  supportsTeams,
  chooseDiscardCard,
  chooseDrawSource,
  // Test seam: a fake onnxruntime (no native module in the repo) and fresh caches.
  _test: {
    setRuntime(ort) { ortModule = ort; },
    reset() { ortModule = undefined; autoAvailable = undefined; sessions.clear(); loaded.clear(); },
  },
};
