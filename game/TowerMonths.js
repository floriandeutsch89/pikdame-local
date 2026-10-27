// game/TowerMonths.js - the Kartenhaus months from 2027-01: the server picks their
// deals itself (TowerGen.js in a throttled worker, TowerWorker.js) and keeps them in
// data/tower-months.json. The pick is deterministic (candidates from the month,
// TowerRule.candidateSeed), so every replica and every restart computes the same
// deals: plain atomic writes are enough, no lock between replicas.
//
// - From the 15th: the NEXT month in the background (full rule).
// - On start: Zen's proofs of this and next month are replayed; a floor Zen no
//   longer wins (bots or net changed) is picked again (plus the floor above if
//   the staircase needs it).
// - This month incomplete (e.g. the 1st, nothing ready): emergency pick right
//   away, smaller search, the medium band may relax - Zen's proof never. A floor
//   without any proven deal stays locked. An unproven deal is never served.
// - Without onnxruntime nothing is generated (Zen would play the heuristic: no
//   proof); whatever data/ holds is used.
// - generate: false (PIKDAME_TOWER_GEN=0): this instance only reads the file
//   (again on every pass, a generator instance may write it) and replays the
//   proofs on start; a broken floor is only logged.
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { createAtomicJsonFile } = require('./AtomicJsonFile');
const { gameDay } = require('./GameDay');
const R = require('./TowerRule');
const { proven } = require('./TowerGen');

const STATIC_END = '2026-12'; // TowerSeeds.js covers the months up to here
const FLOORS = 20;

const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthAt = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const nextMonth = (m) => monthAt(monthIndex(m) + 1);

function createTowerMonths({
  file,
  today = () => gameDay(),
  netReady = () => { const O = require('./OnnxPolicy'); return O.enabled() && O.available(); },
  policy = null, // module path for the worker's play/rate (tests: a stub)
  maxTries = R.MAX_TRIES,
  emergencyTries = 2000,
  startDay = 15,
  generate: builds = true, // false: read and check only (a separate generator instance builds)
  log = (line) => console.log(line),
  warn = (line) => console.warn(line),
} = {}) {
  const store = createAtomicJsonFile(file);
  const valid = (d) => !!(d && typeof d.months === 'object' && d.months);
  let data = store.read();
  if (!valid(data)) data = { months: {} };
  /** Read-only instance: the generator instance's latest file. */
  function reload() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (valid(d)) data = d;
    } catch (e) { /* missing or mid-write: keep what we have */ }
  }

  let worker = null;
  let jobSeq = 0;
  const waiting = new Map(); // job id -> { resolve, reject }
  let running = null; // the tick in progress
  let timer = null;
  let verified = false;
  let warned = false;
  let stopping = false;
  const ruledThisBoot = new Set(); // next month: one full-rule pass per boot (it is deterministic)

  const generated = (month) => month > STATIC_END;
  const record = (month) => {
    if (!data.months[month]) data.months[month] = { version: R.GEN_VERSION, floors: Array(FLOORS).fill(null) };
    return data.months[month];
  };
  const persist = () => store.write(data);

  /** The month's seeds for BotTower (null = no proven deal on that floor). */
  function seedsFor(month) {
    const m = data.months[month];
    if (!m || !Array.isArray(m.floors)) return null;
    return m.floors.map((f) => (proven(f) ? f.seed : null));
  }

  /** Floors without a deal: { stage: 'building' | 'locked' } (static months: none). */
  function closedFloors(month) {
    if (!generated(month)) return {};
    const floors = (data.months[month] && data.months[month].floors) || [];
    const out = {};
    for (let i = 0; i < FLOORS; i++) {
      const f = floors[i];
      if (proven(f)) continue;
      out[i + 1] = f && f.locked ? 'locked' : 'building';
    }
    return out;
  }

  function onMessage(msg) {
    if (msg.type === 'floor') {
      const rec = record(msg.month);
      rec.floors[msg.stage - 1] = msg.entry;
      rec.version = R.GEN_VERSION;
      // After stop() a late floor is written at once: a delayed write would land after the next instance's.
      if (stopping) store.flushSync(); else persist(); // per floor: a restart resumes where this stopped
      return;
    }
    if (msg.type === 'log') { log(`Kartenhaus: ${msg.line}`); return; }
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.type === 'error') w.reject(new Error(msg.message));
    else w.resolve(msg);
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, 'TowerWorker.js'), { workerData: { policy } });
    worker.unref(); // never keeps the process alive
    worker.on('message', onMessage);
    const fail = (e) => {
      worker = null;
      for (const w of waiting.values()) w.reject(e || new Error('tower worker stopped'));
      waiting.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`tower worker exited (${code})`)));
    return worker;
  }

  function run(job) {
    const id = ++jobSeq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      ensureWorker().postMessage({ ...job, id });
    });
  }

  const missing = (month) => {
    const m = data.months[month];
    return !m || m.floors.some((f) => f == null);
  };

  async function verifyOnce(months) {
    for (const month of months) {
      const m = data.months[month];
      if (!m) continue;
      const { bad } = await run({ type: 'verify', month, floors: m.floors });
      if (!builds) {
        if (bad.length) warn(`Kartenhaus ${month}: Zen no longer wins floor(s) ${bad.join(', ')} - not picked again here (PIKDAME_TOWER_GEN=0)`);
        continue;
      }
      let dirty = false;
      m.floors.forEach((f, i) => {
        // Stale proofs go; a locked floor gets one new try per start.
        if (bad.includes(i + 1) || (f && f.locked)) { m.floors[i] = null; dirty = true; }
      });
      if (bad.length) warn(`Kartenhaus ${month}: Zen no longer wins floor(s) ${bad.join(', ')} - picking them again`);
      if (dirty) persist();
    }
  }

  async function generate(month, mode, emergency) {
    const m = record(month);
    const res = await run({ type: 'generate', month, floors: m.floors, mode, emergency, maxTries: emergency ? emergencyTries : maxTries });
    const done = data.months[month].floors.filter(proven).length;
    log(`Kartenhaus ${month}: ${done}/${FLOORS} floors proven (${mode}${emergency ? ', emergency' : ''}), `
      + `${Math.round(res.wallMs / 1000)} s, CPU ${Math.round(res.cpuMs / 1000)} s`);
    if (res.failed && res.failed.length) warn(`Kartenhaus ${month}: no deal by the rule for floor(s) ${res.failed.map((f) => f.stage).join(', ')}`);
    return res;
  }

  /** One pass of the schedule (serialized; resolves when its work is done). */
  function tick() {
    if (running) return running;
    running = (async () => {
      if (stopping) return;
      if (!builds) reload();
      if (!netReady()) {
        if (!warned) warn('Kartenhaus: no onnxruntime - new months are not generated, data/tower-months.json is used as it is');
        warned = true;
        return;
      }
      const day = today();
      const cur = day.slice(0, 7);
      const next = nextMonth(cur);
      if (!verified) {
        await verifyOnce([cur, next].filter(generated));
        verified = true;
      }
      if (!builds) return;
      if (generated(cur) && missing(cur)) await generate(cur, 'missing', true);
      if (generated(next) && Number(day.slice(8, 10)) >= startDay && !ruledThisBoot.has(next)) {
        await generate(next, 'rule', false);
        ruledThisBoot.add(next);
      }
    })().catch((e) => { if (!stopping) warn(`Kartenhaus: generation failed - ${e && e.message}`); }).finally(() => { running = null; });
    return running;
  }

  function start({ everyMs = 60 * 60 * 1000 } = {}) {
    tick();
    timer = setInterval(tick, everyMs);
    if (timer.unref) timer.unref();
  }

  /** Flushes at once, then asks the worker to end between two games (ending it
   *  inside an ONNX run aborts the process); terminate() only as a last resort. */
  function stop({ graceMs = 5000 } = {}) {
    clearInterval(timer);
    timer = null;
    stopping = true;
    store.flushSync();
    const w = worker;
    worker = null;
    if (!w) return Promise.resolve();
    return new Promise((resolve) => {
      // Both stay referenced: the process waits for the worker (or the grace) to end.
      const last = setTimeout(() => { w.terminate().catch(() => {}).finally(resolve); }, graceMs);
      w.ref();
      w.once('exit', () => { clearTimeout(last); resolve(); });
      w.postMessage({ type: 'stop' });
    });
  }

  return { seedsFor, closedFloors, tick, start, stop, data: () => data, STATIC_END };
}

module.exports = { createTowerMonths, nextMonth, STATIC_END };
