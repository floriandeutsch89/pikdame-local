// game/Monitor.js
// Resource monitoring for the /admin page: samples the app container, the
// Node process and the host every 15 s and keeps a history like a hosting
// console does - full resolution for the last hour, 5-minute averages for a
// day, 30-minute averages for 30 days. Persisted in the data directory, so a
// deploy or restart does not wipe it.
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
const { createAtomicJsonFile } = require('./AtomicJsonFile');

const MB = 1024 * 1024;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Resolution tiers. "raw" holds the samples as taken; the others hold
// averages per bucket (plus the peak of the metrics where a short spike
// matters more than its average).
const TIERS = {
  raw: { step: 15 * 1000, keep: HOUR },
  m5: { step: 5 * MIN, keep: DAY },
  m30: { step: 30 * MIN, keep: 30 * DAY },
};
const PEAK_KEYS = ['cpuPct', 'lagMs', 'memMb'];

// Which tier each selectable range is drawn from.
const RANGES = {
  '1h': { span: HOUR, tier: 'raw', label: '1 Std' },
  '24h': { span: DAY, tier: 'm5', label: '24 Std' },
  '7d': { span: 7 * DAY, tier: 'm30', label: '7 Tage' },
  '30d': { span: 30 * DAY, tier: 'm30', label: '30 Tage' },
};

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

/** The flat numbers the charts are drawn from (one per sample/bucket). */
function pointOf(s) {
  return {
    at: s.at,
    memMb: s.container.memMb != null ? s.container.memMb : s.process.rssMb,
    memLimitMb: s.container.memLimitMb,
    cpuPct: s.container.cpuPct != null ? s.container.cpuPct : s.process.cpuPct,
    cpuLimitPct: s.container.cpuLimit ? s.container.cpuLimit * 100 : null,
    lagMs: s.process.loopLagMs,
    players: s.game.players,
    sessions: s.game.sessions,
    hostMemUsedMb: s.host.memUsedMb,
    hostMemTotalMb: s.host.memTotalMb,
    load1: s.host.load1,
    cores: s.host.cores,
  };
}

/** Average a bucket of points; peaks for PEAK_KEYS. */
function aggregate(points, at) {
  const out = { at };
  const keys = Object.keys(points[0]).filter((k) => k !== 'at' && !k.endsWith('Max'));
  for (const k of keys) {
    const vals = points.map((p) => p[k]).filter((v) => v != null && Number.isFinite(v));
    out[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    if (PEAK_KEYS.includes(k)) {
      const peaks = points.map((p) => (p[`${k}Max`] != null ? p[`${k}Max`] : p[k])).filter((v) => v != null && Number.isFinite(v));
      out[`${k}Max`] = peaks.length ? Math.max(...peaks) : null;
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir       data volume (disk numbers, history file)
 * @param {() => {sessions:number, players:number}} [opts.stats]
 * @param {number} [opts.intervalMs]  default 15 s
 * @param {string|null} [opts.historyFile] default <dataDir>/monitor-history.json, null = memory only
 * @param {string} [opts.cgroupRoot]  default: own cgroup under /sys/fs/cgroup (test seam)
 * @param {() => number} [opts.now]   clock (test seam)
 */
function createMonitor({
  dataDir,
  stats = () => ({ sessions: 0, players: 0 }),
  intervalMs = 15000,
  historyFile,
  cgroupRoot,
  now = Date.now,
} = {}) {
  cgroupRoot = cgroupRoot || ownCgroupDir('/sys/fs/cgroup');
  const file = historyFile === null ? null : createAtomicJsonFile(historyFile || path.join(dataDir, 'monitor-history.json'));
  const tiers = { raw: [], m5: [], m30: [] };
  // Open buckets of the aggregated tiers: points collected so far.
  const open = { m5: { start: null, points: [] }, m30: { start: null, points: [] } };
  if (file) {
    const saved = file.read();
    if (saved && saved.tiers) {
      for (const t of Object.keys(tiers)) if (Array.isArray(saved.tiers[t])) tiers[t] = saved.tiers[t];
    }
  }
  let lastSamples = []; // full samples (for the cards), last few only
  let lastPersist = 0;

  // The histogram reports the timer interval itself on top of any delay (an
  // idle loop reads exactly the resolution), so it is subtracted below.
  const LOOP_RESOLUTION_MS = 10;
  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loopDelay.enable();
  let last = { at: now(), cpu: process.cpuUsage(), cgroupUsec: readCgroup(cgroupRoot).cpuUsageUsec };
  let timer = null;

  function prune(t) {
    const cutoff = now() - TIERS[t].keep;
    while (tiers[t].length && tiers[t][0].at < cutoff) tiers[t].shift();
  }
  for (const t of Object.keys(tiers)) prune(t);

  function feed(point) {
    tiers.raw.push(point);
    prune('raw');
    for (const t of ['m5', 'm30']) {
      const step = TIERS[t].step;
      const start = Math.floor(point.at / step) * step;
      const o = open[t];
      if (o.start !== null && start !== o.start && o.points.length) {
        tiers[t].push(aggregate(o.points, o.start));
        prune(t);
        o.points = [];
      }
      o.start = start;
      o.points.push(point);
    }
  }

  function persist(force) {
    if (!file) return;
    if (!force && now() - lastPersist < MIN) return;
    lastPersist = now();
    file.write({ v: 1, tiers });
  }

  function sample() {
    const t = now();
    const wallUs = Math.max(1, (t - last.at) * 1000);
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
      at: t,
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
        externalMb: mem.external / MB,
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
    last = { at: t, cpu: process.cpuUsage(), cgroupUsec: cg.cpuUsageUsec };
    lastSamples.push(entry);
    if (lastSamples.length > 4) lastSamples = lastSamples.slice(-4);
    feed(pointOf(entry));
    persist(false);
    return entry;
  }

  /**
   * Points for one selectable range, oldest first, plus the bucket step (for
   * gap detection: a hole means the server was not running).
   * @param {'1h'|'24h'|'7d'|'30d'} range
   */
  function series(range) {
    const key = RANGES[range] ? range : '1h';
    const r = RANGES[key];
    const to = now();
    const from = to - r.span;
    const points = tiers[r.tier].filter((p) => p.at >= from);
    // Include the bucket that is still filling, so the newest data shows up.
    if (r.tier !== 'raw') {
      const o = open[r.tier];
      if (o.points.length) points.push(aggregate(o.points, o.start));
    }
    return { range: key, span: r.span, step: TIERS[r.tier].step, from, to, points };
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
    /** Write the history now (graceful shutdown). */
    flushSync() {
      if (!file) return;
      persist(true);
      file.flushSync();
    },
    sample,
    series,
    /** Latest full sample; takes one right away if none exists yet. */
    current() { return lastSamples.length ? lastSamples[lastSamples.length - 1] : sample(); },
    /** Raw tier (last hour). */
    history() { return tiers.raw.slice(); },
  };
}

module.exports = { createMonitor, readCgroup, RANGES, TIERS };
