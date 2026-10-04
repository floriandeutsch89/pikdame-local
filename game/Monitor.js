// game/Monitor.js
// Resource monitoring for the /admin page: samples the app container, the
// Node process and the host every 15 s and keeps the last hour in memory.
//
// What the app can see without Docker access (which it deliberately does not
// have): its own container through cgroup v2 files, its own process, and the
// host totals that /proc and os.* report inside a container. Other containers
// (Postgres, Caddy, CrowdSec) are not visible individually.
//
// Every source is read defensively: outside Docker (no cgroup files) or on an
// old Node (no statfs) the value is null and the page shows "–".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const MB = 1024 * 1024;

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return null; }
}

/** This process's own cgroup v2 directory. Inside a container (cgroup
 *  namespace) /proc/self/cgroup says "0::/", i.e. the container itself;
 *  outside, it is the process's own scope - never the whole machine, which a
 *  bare /sys/fs/cgroup would be (that read 400 % CPU for the full host). */
function ownCgroupDir(mount) {
  const self = readText('/proc/self/cgroup');
  const m = self && /^0::(\/.*)$/m.exec(self);
  return m ? path.join(mount, m[1]) : mount;
}

/** cgroup v2 numbers of the container this process runs in, or nulls. */
function readCgroup(root) {
  const memCurrent = Number(readText(path.join(root, 'memory.current')));
  const memMaxRaw = readText(path.join(root, 'memory.max'));
  const memMax = memMaxRaw && memMaxRaw !== 'max' ? Number(memMaxRaw) : null;
  const cpuStat = readText(path.join(root, 'cpu.stat'));
  const usageMatch = cpuStat && /usage_usec (\d+)/.exec(cpuStat);
  // cpu.max: "<quota> <period>" or "max <period>" - the CPU limit in cores.
  const cpuMax = readText(path.join(root, 'cpu.max'));
  let cpuLimit = null;
  if (cpuMax) {
    const [quota, period] = cpuMax.split(/\s+/);
    if (quota !== 'max' && Number(period) > 0) cpuLimit = Number(quota) / Number(period);
  }
  return {
    memBytes: Number.isFinite(memCurrent) && memCurrent > 0 ? memCurrent : null,
    memLimitBytes: Number.isFinite(memMax) ? memMax : null,
    cpuUsageUsec: usageMatch ? Number(usageMatch[1]) : null,
    cpuLimit,
  };
}

/** Host memory. MemAvailable (not MemFree) is what "free" means on Linux. */
function readHostMemory() {
  const info = readText('/proc/meminfo');
  const total = os.totalmem();
  if (info) {
    const m = /MemAvailable:\s+(\d+) kB/.exec(info);
    if (m) return { totalBytes: total, availableBytes: Number(m[1]) * 1024 };
  }
  return { totalBytes: total, availableBytes: os.freemem() };
}

function readDisk(dir) {
  if (typeof fs.statfsSync !== 'function') return { freeBytes: null, totalBytes: null };
  try {
    const s = fs.statfsSync(dir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch (e) {
    return { freeBytes: null, totalBytes: null };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir      data volume, for the disk numbers
 * @param {() => {sessions:number, players:number}} [opts.stats]
 * @param {number} [opts.intervalMs] default 15 s
 * @param {number} [opts.keep]       samples kept, default 240 (= 1 h at 15 s)
 * @param {string} [opts.cgroupRoot] default: own cgroup under /sys/fs/cgroup (test seam)
 */
function createMonitor({ dataDir, stats = () => ({ sessions: 0, players: 0 }), intervalMs = 15000, keep = 240, cgroupRoot } = {}) {
  cgroupRoot = cgroupRoot || ownCgroupDir('/sys/fs/cgroup');
  const samples = [];
  // The histogram reports the timer interval itself on top of any delay (an
  // idle loop reads exactly the resolution), so it is subtracted below.
  const LOOP_RESOLUTION_MS = 10;
  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loopDelay.enable();
  let last = { at: Date.now(), cpu: process.cpuUsage(), cgroupUsec: readCgroup(cgroupRoot).cpuUsageUsec };
  let timer = null;

  function sample() {
    const now = Date.now();
    const wallUs = Math.max(1, (now - last.at) * 1000);
    const cg = readCgroup(cgroupRoot);
    const cpu = process.cpuUsage(last.cpu);
    const cores = os.cpus().length || 1;
    // Container CPU in % of ONE core (docker stats convention: 100 % = one
    // full core), from the cgroup counter when available, else the process.
    const containerCpuPct = cg.cpuUsageUsec != null && last.cgroupUsec != null
      ? ((cg.cpuUsageUsec - last.cgroupUsec) / wallUs) * 100
      : null;
    const processCpuPct = ((cpu.user + cpu.system) / wallUs) * 100;
    const mem = process.memoryUsage();
    const host = readHostMemory();
    const disk = readDisk(dataDir);
    const s = stats() || {};
    const entry = {
      at: now,
      container: {
        memMb: cg.memBytes != null ? cg.memBytes / MB : null,
        memLimitMb: cg.memLimitBytes != null ? cg.memLimitBytes / MB : null,
        cpuPct: containerCpuPct != null ? Math.max(0, containerCpuPct) : null,
        cpuLimit: cg.cpuLimit,
      },
      process: {
        rssMb: mem.rss / MB,
        heapUsedMb: mem.heapUsed / MB,
        heapTotalMb: mem.heapTotal / MB,
        cpuPct: Math.max(0, processCpuPct),
        // p99 of the event loop delay since the last sample: the time a
        // message may wait before the server even looks at it.
        loopLagMs: Math.max(0, loopDelay.percentile(99) / 1e6 - LOOP_RESOLUTION_MS),
      },
      host: {
        memUsedMb: (host.totalBytes - host.availableBytes) / MB,
        memTotalMb: host.totalBytes / MB,
        load1: os.loadavg()[0],
        load5: os.loadavg()[1],
        load15: os.loadavg()[2],
        cores,
      },
      disk: {
        freeMb: disk.freeBytes != null ? disk.freeBytes / MB : null,
        totalMb: disk.totalBytes != null ? disk.totalBytes / MB : null,
      },
      game: { sessions: s.sessions || 0, players: s.players || 0 },
      uptimeSeconds: Math.round(process.uptime()),
    };
    loopDelay.reset();
    last = { at: now, cpu: process.cpuUsage(), cgroupUsec: cg.cpuUsageUsec };
    samples.push(entry);
    while (samples.length > keep) samples.shift();
    return entry;
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { try { sample(); } catch (e) { /* monitoring never takes the server down */ } }, intervalMs);
      timer.unref(); // must not keep the process (or a test run) alive
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      loopDelay.disable();
    },
    sample,
    /** Latest sample; takes one right away if none exists yet. */
    current() { return samples.length ? samples[samples.length - 1] : sample(); },
    history() { return samples.slice(); },
  };
}

module.exports = { createMonitor, readCgroup };
