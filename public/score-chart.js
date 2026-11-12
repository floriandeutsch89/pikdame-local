// public/score-chart.js
// The score chart draws itself on the game-over sheet: who took the lead in which
// round, and the reveal - a cover that shrinks off the finished lines while their
// heads move through the rounds at its pace. Only transform and opacity are animated.
// Loaded before client.js (which builds the chart); the tests require() it.
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
  const CAP = 4; // viewBox units right of the last round that a line's round cap may reach
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

  /** A head's keyframes, one per round, evenly spaced: every head passes a round at the same moment. */
  function headFrames(points) {
    const n = points.length;
    const [endX, endY] = points[n - 1];
    const r = (v) => Math.round(v * 100) / 100;
    return points.map((p, i) => ({ offset: n > 1 ? i / (n - 1) : 1, transform: `translate(${r(p[0] - endX)}px, ${r(p[1] - endY)}px)` }));
  }

  /**
   * The cover over the finished lines, in the sheet's colour: its body shrinks to the right
   * edge, its left edge on the heads' pace. It carries the grid lines it hides (a horizontal
   * line squeezed sideways stays where it is); the dashed goal line lies still on top, in
   * place of the chart's own. plot = { x0, x1, top, bottom } in viewBox units. Sits under the end dots.
   */
  function coverMarkup(plot, gridYs, goalY) {
    const w = plot.x1 - plot.x0;
    const h = plot.bottom - plot.top;
    const line = (cls, y) => `<line class="${cls}" x1="${-w}" y1="${y}" x2="0" y2="${y}"/>`;
    return `<g class="revealCoverBody"><rect x="${-w}" y="${plot.top}" width="${w}" height="${h}"/>${gridYs.map((y) => line('gridLine', y)).join('')}</g>` +
      // The round caps of the lines' last points, until their dots stand on them. It overlaps
      // the body: two edges meeting on one pixel column let the lines' ends shine through.
      `<rect x="-1" y="${plot.top}" width="${CAP + 1}" height="${h}"/>` +
      (goalY === null ? '' : line('goalLine', goalY));
  }

  /**
   * Plays the reveal on a built chart. spec = { lines: [{ id, color, points }], changes, plot }
   * in the DOM order of the chart's end dots, which follow all polylines. `elapsed`: a re-render of the
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
    const dots = svg.querySelectorAll('.endDot');
    if (dots[0] && spec.plot && elapsed < DELAY_MS + DRAW_MS) {
      const cover = document.createElementNS(SVG_NS, 'g');
      cover.setAttribute('class', 'revealCover');
      cover.setAttribute('transform', `translate(${spec.plot.x1} 0)`);
      cover.setAttribute('aria-hidden', 'true');
      const goal = svg.querySelector('.goalLine');
      cover.innerHTML = coverMarkup(spec.plot, [...svg.querySelectorAll('.gridLine')].map((l) => l.getAttribute('y1')), goal ? goal.getAttribute('y1') : null);
      svg.insertBefore(cover, dots[0]);
      try {
        // Kept at its end until it is taken off: a cover falling back to full size would hide the chart.
        run(cover.firstChild, [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: DRAW_MS, delay: DELAY_MS, fill: 'both' })
          .onfinish = () => cover.remove();
        // The chart's own goal line would show twice where the lines are drawn already.
        if (goal) run(goal, [{ opacity: 0 }, { opacity: 0 }], { duration: DRAW_MS, delay: DELAY_MS });
      } catch (e) { cover.remove(); }
    }
    spec.lines.forEach((l, i) => {
      if (dots[i]) run(dots[i], headFrames(l.points), { duration: DRAW_MS, delay: DELAY_MS });
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

  return { DELAY_MS, DRAW_MS, LABEL_MS, POP_MS, POP_R, TOTAL_MS, leadChanges, arrivalMs, headFrames, coverMarkup, play };
}));
