// PIKDAME_ONNX is now three-valued: unset = AUTO (use the learned bots when
// this installation can actually run them), 1 = force on, 0 = force off.
// The AUTO branch is what keeps the hotspot/CodeApp mode safe: no native
// runtime there, so it resolves to false and stays silent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** Ask a FRESH node process, so the module-level cache cannot leak between cases. */
function enabledWith(value) {
  const env = { ...process.env };
  if (value === null) delete env.PIKDAME_ONNX;
  else env.PIKDAME_ONNX = value;
  const out = execFileSync(
    process.execPath,
    ['-e', 'console.log(require(process.argv[1]).enabled())', path.join(ROOT, 'game', 'OnnxPolicy.js')],
    { env, encoding: 'utf8' }
  );
  return out.trim() === 'true';
}

/** The same question the module asks itself, answered independently. */
function runtimeAndModelsPresent() {
  try {
    require.resolve('onnxruntime-node');
  } catch (e) {
    return false;
  }
  const dir = process.env.PIKDAME_MODELS_DIR || path.join(ROOT, 'models');
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.onnx'));
  } catch (e) {
    return false;
  }
}

test('ONNX: PIKDAME_ONNX=1 forces the learned path on', () => {
  assert.equal(enabledWith('1'), true);
  assert.equal(enabledWith('true'), true);
});

test('ONNX: PIKDAME_ONNX=0 forces the heuristic, even with models present', () => {
  assert.equal(enabledWith('0'), false);
  assert.equal(enabledWith('false'), false);
});

test('ONNX: unset means AUTO - on exactly when runtime AND models are available', () => {
  // The point of the default: `node server.js` picks up the learned bots
  // without an env var, but only where they can really run.
  assert.equal(enabledWith(null), runtimeAndModelsPresent());
});

test('ONNX: AUTO never warns - only an explicit PIKDAME_ONNX=1 may complain', () => {
  // A stray warning on every plain start would be noise on the hotspot path,
  // where the runtime is absent BY DESIGN.
  const res = execFileSync(
    process.execPath,
    ['-e', 'require(process.argv[1]).enabled()', path.join(ROOT, 'game', 'OnnxPolicy.js')],
    { env: { ...process.env, PIKDAME_ONNX: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  assert.equal(String(res).trim(), '', 'AUTO mode must print nothing');
});

test('ONNX: the models folder ships at least one committed model', () => {
  // Models are committed on purpose (public repo) - without them AUTO can
  // never turn itself on, however the runtime is installed.
  const dir = path.join(ROOT, 'models');
  const models = fs.readdirSync(dir).filter((f) => f.endsWith('.onnx'));
  assert.ok(models.length >= 1, `expected committed .onnx models, found: ${models.join(', ') || 'none'}`);
});
