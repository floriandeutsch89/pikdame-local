// public/score-chart.js
// The score chart draws itself on the game-over sheet: who took the lead in
// which round, and the keyframes that move every line's head through the rounds
// at the same pace. Loaded before client.js (which builds the chart); the tests require() it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PikdameScoreChart = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const DELAY_MS = 120; // the sheet is up before the first stroke
  const DRAW_MS = 1200;
  const LABEL_MS = 200;
  const LABEL_STAGGER_MS = 50;
  const POP_MS = 640;
  const POP_R = 6.5; // viewBox units: stays left of the end labels (8 units right of the last round)
  const TOTAL_MS = DELAY_MS + DRAW_MS + POP_MS;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * Lead changes of a match: [{ index, id }] = after round `index` (0-based) `id` leads
   * alone, and someone else led before. A tie at the top leaves the lead where it was;
   * the first leader of the match took it from nobody and is no change.
   */
  function leadChanges(series, ids) {
    const out = [];
    let leader = null;
    (series || []).forEach((h, index) => {
      let best = -Infinity;
      let top = null;
      let tied = false;
      for (const id of ids || []) {
        const v = (h && h.totals && h.totals[id]) || 0;
        if (v > best) { best = v; top = id; tied = false; } else if (v === best) tied = true;
      }
      if (tied || top === null || top === leader) return;
      if (leader !== null) out.push({ index, id: top });
      leader = top;
    });
    return out;
  }

  /** When the heads reach round `index` of `rounds` (ms after the start; they move evenly in x). */
  function arrivalMs(index, rounds) {
    return DELAY_MS + DRAW_MS * (rounds > 1 ? index / (rounds - 1) : 1);
  }

  /** One line's keyframes, one per round: the dash that hides its rest, and its head's way there. */
  function lineFrames(points) {
    const n = points.length;
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    const len = cum[n - 1];
    const [endX, endY] = points[n - 1];
    const r = (v) => Math.round(v * 100) / 100;
    // The gap is longer than the line: no second dash ever starts on it.
    const dash = `${r(len)} ${r(len + 10)}`;
    return {
      length: len,
      line: points.map((p, i) => ({ offset: n > 1 ? i / (n - 1) : 1, strokeDasharray: dash, strokeDashoffset: String(r(len - cum[i])) })),
      head: points.map((p, i) => ({ offset: n > 1 ? i / (n - 1) : 1, transform: `translate(${r(p[0] - endX)}px, ${r(p[1] - endY)}px)` })),
    };
  }

  /**
   * Plays the reveal on a built chart. spec = { lines: [{ id, color, points }], changes }
   * in the DOM order of the chart's polylines and end dots. `elapsed`: a re-render of the
   * sheet joins the running reveal instead of starting over. `paused`: held at its first
   * frame until the caller plays the returned animations (a chart below the fold). Returns
   * none without Web Animations: the chart then simply stands there, finished.
   */
  function play(svg, spec, elapsed = 0, { paused = false } = {}) {
    if (!svg || typeof svg.animate !== 'function' || !spec || !spec.lines.length || elapsed >= TOTAL_MS) return [];
    const rounds = spec.lines[0].points.length;
    if (rounds < 2) return [];
    const anims = [];
    const run = (el, frames, opts) => {
      const a = el.animate(frames, { easing: 'linear', fill: 'backwards', ...opts });
      try {
        if (paused) a.pause();
        a.currentTime = elapsed;
      } catch (e) { /* cosmetic */ }
      anims.push(a);
      return a;
    };
    const lines = svg.querySelectorAll('polyline');
    const dots = svg.querySelectorAll('.endDot');
    spec.lines.forEach((l, i) => {
      const f = lineFrames(l.points);
      if (lines[i] && f.length > 0) run(lines[i], f.line, { duration: DRAW_MS, delay: DELAY_MS });
      if (dots[i]) run(dots[i], f.head, { duration: DRAW_MS, delay: DELAY_MS });
    });
    // The names and totals show up when their lines arrive, top to bottom.
    svg.querySelectorAll('.endLabel').forEach((label, i) => {
      run(label, [{ opacity: 0 }, { opacity: 1 }], { duration: LABEL_MS, delay: DELAY_MS + DRAW_MS + i * LABEL_STAGGER_MS, easing: 'ease-out' });
    });
    // A lead change pops on the new leader's line as the heads pass that round, then it is gone.
    for (const c of spec.changes || []) {
      const l = spec.lines.find((x) => x.id === c.id);
      const at = arrivalMs(c.index, rounds);
      if (!l || !l.points[c.index] || elapsed >= at + POP_MS) continue;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'leadPop');
      g.setAttribute('transform', `translate(${l.points[c.index][0].toFixed(1)} ${l.points[c.index][1].toFixed(1)})`);
      g.setAttribute('aria-hidden', 'true');
      g.innerHTML = `<circle class="leadPopRing" r="${POP_R}" stroke="${l.color}"/><circle class="leadPopDot" r="3.4" fill="${l.color}"/>`;
      svg.appendChild(g);
      const ring = run(g.firstChild, [
        { transform: 'scale(0.4)', opacity: 0 },
        { transform: 'scale(0.55)', opacity: 1, offset: 0.12 },
        { transform: 'scale(0.88)', opacity: 0.7, offset: 0.6 },
        { transform: 'scale(1)', opacity: 0 },
      ], { duration: POP_MS, delay: at, fill: 'both', easing: 'ease-out' });
      run(g.lastChild, [
        { transform: 'scale(0.6)', opacity: 0 },
        { transform: 'scale(1.5)', opacity: 1, offset: 0.2 },
        { transform: 'scale(1)', opacity: 1, offset: 0.55 },
        { transform: 'scale(1)', opacity: 0 },
      ], { duration: POP_MS, delay: at, fill: 'both', easing: 'ease-out' });
      ring.onfinish = () => g.remove();
    }
    return anims;
  }

  return { DELAY_MS, DRAW_MS, LABEL_MS, POP_MS, POP_R, TOTAL_MS, leadChanges, arrivalMs, lineFrames, play };
}));
