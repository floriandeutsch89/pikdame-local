// game/TowerWorker.js - a worker thread that picks Kartenhaus deals (TowerGen.js)
// for TowerMonths.js, off the main thread so live games keep their pace.
// Throttled: lowest priority for this thread (and the ONNX threads it starts),
// one ONNX thread, a yield between candidates. Simulated seats never log moves.
'use strict';
const { parentPort, workerData } = require('worker_threads');

try { require('os').setPriority(19); } catch (e) { /* not allowed here: run at normal priority */ }
process.env.PIKDAME_ONNX_THREADS = '1'; // this worker's copy of the env only

const policy = require((workerData && workerData.policy) || './TowerPlay');
const TowerGen = require('./TowerGen');

// Stopping: never end this thread inside an ONNX run (that aborts the whole
// process, measured); the next game sees the flag and the job ends cleanly.
let stopping = false;
let busy = false;
class Stopped extends Error {}
const check = () => { if (stopping) throw new Stopped('stopped'); };
const play = async (o) => { check(); return policy.playFloor(o); };
const rate = async (o) => { check(); return policy.slipRate({ ...o, beforeGame: check }); };
// setImmediate is a real yield here: the worker's loop runs its own message handling in between.
const pause = () => new Promise((resolve) => setImmediate(resolve));

parentPort.on('message', async (job) => {
  if (job.type === 'stop') {
    stopping = true;
    if (!busy) process.exit(0);
    return;
  }
  busy = true;
  try {
    if (job.type === 'verify') {
      const bad = await TowerGen.staleFloors({ month: job.month, floors: job.floors, play, pause });
      parentPort.postMessage({ type: 'verified', id: job.id, month: job.month, bad });
    } else if (job.type === 'generate') {
      // This thread's CPU (Node >= 23.9; older: the whole process).
      const cpuNow = () => (process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage());
      const t0 = cpuNow();
      const w0 = Date.now();
      const { failed } = await TowerGen.generateMonth({
        month: job.month, floors: job.floors, mode: job.mode, emergency: job.emergency,
        maxTries: job.maxTries, play, rate, pause,
        onFloor: (stage, entry) => parentPort.postMessage({ type: 'floor', id: job.id, month: job.month, stage, entry }),
        log: (line) => parentPort.postMessage({ type: 'log', line }),
      });
      const t1 = cpuNow();
      parentPort.postMessage({ type: 'done', id: job.id, month: job.month, failed,
        cpuMs: Math.round((t1.user - t0.user + t1.system - t0.system) / 1000), wallMs: Date.now() - w0 });
    }
  } catch (e) {
    if (!(e instanceof Stopped)) parentPort.postMessage({ type: 'error', id: job.id, month: job.month, message: e && e.message });
  } finally {
    busy = false;
  }
  if (stopping) process.exit(0); // between games: no ONNX run in flight
});
