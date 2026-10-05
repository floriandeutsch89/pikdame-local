// public/admin-monitor.js - charts of the admin Monitoring tab.
// Loaded only by /admin/monitor (behind the admin login). Draws the history
// from /admin/monitor/data with uPlot (public/vendor-uplot.js): one chart per
// metric, cursors synced across all of them, drag (or swipe) to zoom,
// double-click (or double tap) to reset. Refreshes the data and the "Jetzt"
// cards every 15 s without a page reload, so a zoom survives the update. No
// inline script: the site's CSP only allows same-origin files.
(function () {
  'use strict';
  const root = document.getElementById('charts');
  if (!root || typeof uPlot !== 'function') return;
  const range = root.dataset.range || '1h';
  const REFRESH_MS = 15000;

  const css = getComputedStyle(document.documentElement);
  const C = {
    text: css.getPropertyValue('--muted').trim() || '#94a0ad',
    grid: css.getPropertyValue('--line').trim() || '#2a313c',
    accent: css.getPropertyValue('--accent').trim() || '#2fd6b0',
    warn: css.getPropertyValue('--warn').trim() || '#f5c542',
    error: css.getPropertyValue('--error').trim() || '#ff7d7d',
  };

  const de = (v, digits) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
  // uPlot formats dates the US way (9/28, 12am); German labels instead.
  const tsLabel = (ts, withDate, withTime) => new Date(ts * 1000).toLocaleString('de-DE', {
    ...(withDate ? { day: '2-digit', month: '2-digit' } : {}),
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  const xTicks = (u, splits) => {
    const span = (u.scales.x.max - u.scales.x.min) || 1;
    // Up to ~1.5 days: clock time (with the date where the day changes);
    // longer: dates.
    if (span <= 36 * 3600) {
      return splits.map((ts, i) => {
        const day = new Date(ts * 1000).getDate();
        const newDay = i === 0 || new Date(splits[i - 1] * 1000).getDate() !== day;
        return newDay && span > 6 * 3600 ? `${tsLabel(ts, false, true)}\n${tsLabel(ts, true, false)}` : tsLabel(ts, false, true);
      });
    }
    return splits.map((ts) => tsLabel(ts, true, false));
  };

  // value(d) reads a point, limit(lim) reads the current limits.
  const CHARTS = [
    { id: 'mem', title: 'App: Arbeitsspeicher', unit: 'MB', digits: 0, key: 'memMb', peak: 'memMbMax', limit: (l) => l.memLimitMb, limitLabel: 'Limit', minTop: 64 },
    { id: 'cpu', title: 'App: CPU', unit: '%', digits: 1, key: 'cpuPct', peak: 'cpuPctMax', limit: (l) => l.cpuLimitPct, limitLabel: 'Limit', minTop: 5 },
    { id: 'lag', title: 'Reaktionszeit (p99)', unit: 'ms', digits: 1, key: 'lagMs', peak: 'lagMsMax', minTop: 5 },
    { id: 'players', title: 'Verbundene Spieler', unit: '', digits: 0, key: 'players', minTop: 4 },
    { id: 'host', title: 'Server: Arbeitsspeicher', unit: 'GB', digits: 1, key: 'hostMemUsedMb', scale: 1024, limit: (l) => l.hostMemTotalMb, limitLabel: 'gesamt' },
    { id: 'load', title: 'Server: Last (1 min)', unit: '', digits: 2, key: 'load1', limit: (l) => l.cores, limitLabel: 'Kerne', minTop: 1 },
  ];

  const plots = {};
  root.pikdamePlots = plots; // test seam: lets a browser test read the scales
  let lastData = null;

  /** Column data for one chart: x in seconds, null where the server was off
   *  (uPlot breaks the line at null - a gap instead of a misleading ramp). */
  function columns(def, data) {
    const xs = []; const avg = []; const peak = []; const lim = [];
    const scale = def.scale || 1;
    const showPeak = def.peak && data.range !== '1h';
    const limit = def.limit ? def.limit(data.limits) : null;
    let prev = null;
    for (const p of data.points) {
      if (prev != null && p.at - prev > data.step * 2.5) {
        xs.push(Math.round((prev + data.step) / 1000)); avg.push(null); peak.push(null); lim.push(limit != null ? limit / scale : null);
      }
      xs.push(Math.round(p.at / 1000));
      avg.push(p[def.key] != null ? p[def.key] / scale : null);
      peak.push(showPeak && p[def.peak] != null ? p[def.peak] / scale : null);
      lim.push(limit != null ? limit / scale : null);
      prev = p.at;
    }
    const cols = [xs, avg];
    if (showPeak) cols.push(peak);
    if (limit != null) cols.push(lim);
    return { cols, showPeak, limit };
  }

  function summary(def, cols) {
    const vals = cols[1].filter((v) => v != null);
    if (!vals.length) return 'noch keine Daten in diesem Zeitraum';
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const peaks = (cols.length > 2 && def.peak ? cols[2] : cols[1]).filter((v) => v != null);
    const max = Math.max(...vals, ...peaks);
    return `Min ${de(Math.min(...vals), def.digits)} · Ø ${de(avg, def.digits)} · Max ${de(max, def.digits)} ${def.unit}`;
  }

  function build(def, data) {
    const { cols, showPeak, limit } = columns(def, data);
    const box = document.createElement('div');
    box.className = 'chart';
    box.innerHTML = '<div class="chead"><h3></h3><div class="sub"></div></div><div class="plot"></div>';
    box.querySelector('h3').textContent = def.title;
    box.querySelector('.sub').textContent = summary(def, cols);
    root.appendChild(box);
    const fmtVal = (u, v) => (v == null ? '–' : `${de(v, def.digits)} ${def.unit}`.trim());
    const series = [
      { label: 'Zeit', value: (u, ts) => (ts == null ? '–' : tsLabel(ts, true, true)) },
      { label: 'Ø', stroke: C.accent, width: 1.6, fill: 'rgba(47,214,176,0.12)', value: fmtVal, spanGaps: false },
    ];
    if (showPeak) series.push({ label: 'Spitze', stroke: 'rgba(47,214,176,0.55)', width: 1, value: fmtVal, spanGaps: false });
    if (limit != null) series.push({ label: def.limitLabel, stroke: C.warn, width: 1, dash: [5, 5], value: fmtVal, points: { show: false } });
    const width = box.querySelector('.plot').clientWidth || 560;
    const opts = {
      width,
      height: 190,
      cursor: { sync: { key: 'pikdame-monitor' }, drag: { x: true, y: false } },
      legend: { live: true },
      scales: {
        // No fixed range here: a static [from, to] pinned the axis to the
        // window of the FIRST load, so every refresh snapped back to it and new
        // points landed off the right edge - the charts looked frozen until F5.
        // The window is set with setScale below and moved on each refresh.
        x: { time: true, auto: false },
        y: { range: (u, min, max) => [0, Math.max(def.minTop || 1, max * 1.1)] },
      },
      axes: [
        { stroke: C.text, grid: { stroke: C.grid, width: 1 }, ticks: { stroke: C.grid }, values: xTicks, space: 60 },
        { stroke: C.text, grid: { stroke: C.grid, width: 1 }, ticks: { stroke: C.grid }, size: 54, values: (u, vals) => vals.map((v) => de(v, v < 10 && def.digits ? 1 : 0)) },
      ],
      series,
      // Touch (public/uplot-touch.js): swipe = zoom, double tap = reset.
      plugins: typeof window.uplotTouch === 'function' ? [window.uplotTouch({ onReset: () => resetZoom(def.id) })] : [],
    };
    const plot = new uPlot(opts, cols, box.querySelector('.plot'));
    const win = { min: Math.round(data.from / 1000), max: Math.round(data.to / 1000) };
    plot.setScale('x', win);
    plots[def.id] = { plot, box, shape: `${showPeak}|${limit != null}`, win };
    // Double-click resets to the current time window (uPlot's own reset would
    // go to the data extent, which the zoom check below reads as a zoom).
    plot.over.addEventListener('dblclick', () => resetZoom(def.id));
  }

  function resetZoom(id) {
    const pl = plots[id];
    if (pl) pl.plot.setScale('x', { ...pl.win });
  }

  function update(data) {
    for (const def of CHARTS) {
      const { cols, showPeak, limit } = columns(def, data);
      const p = plots[def.id];
      if (!p || p.shape !== `${showPeak}|${limit != null}`) {
        if (p) { p.plot.destroy(); p.box.remove(); }
        build(def, data);
        continue;
      }
      // Keep a zoom the user made (the scale differs from the window we set
      // last time); otherwise move the window along with the clock.
      const sx = p.plot.scales.x;
      const zoomed = Math.abs(sx.min - p.win.min) > 1 || Math.abs(sx.max - p.win.max) > 1;
      p.plot.setData(cols, false);
      p.win = { min: Math.round(data.from / 1000), max: Math.round(data.to / 1000) };
      // setScale on x also re-ranges the auto y axis for the visible data.
      p.plot.setScale('x', zoomed ? { min: sx.min, max: sx.max } : { ...p.win });
      p.box.querySelector('.sub').textContent = summary(def, cols);
    }
  }

  function updateCards(cur) {
    if (!cur) return;
    for (const el of document.querySelectorAll('[data-k]')) {
      const v = cur[el.dataset.k];
      el.textContent = de(v, Number(el.dataset.d || 0));
    }
    for (const el of document.querySelectorAll('[data-bar]')) {
      const [k, limK] = el.dataset.bar.split('/');
      const v = cur[k]; const lim = cur[limK];
      if (v == null || !lim) continue;
      const pct = Math.min(100, (v / lim) * 100);
      el.style.width = `${pct.toFixed(1)}%`;
      el.className = pct > 90 ? 'error' : pct > 75 ? 'warn' : '';
    }
    const stamp = document.getElementById('updated');
    if (stamp) stamp.textContent = new Date().toLocaleTimeString('de-DE');
  }

  async function load(first) {
    try {
      const res = await fetch(`/admin/monitor/data?range=${encodeURIComponent(range)}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      lastData = data;
      if (first) { root.textContent = ''; CHARTS.forEach((d) => build(d, data)); } else update(data);
      updateCards(data.current);
    } catch (e) {
      const stamp = document.getElementById('updated');
      if (stamp) stamp.textContent = `Fehler beim Laden (${e.message})`;
    }
  }

  // Resize with the window (uPlot draws at a fixed pixel width).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const p of Object.values(plots)) p.plot.setSize({ width: p.box.querySelector('.plot').clientWidth, height: 190 });
    }, 150);
  });

  load(true);
  setInterval(() => { if (!document.hidden) load(false); }, REFRESH_MS);
})();
