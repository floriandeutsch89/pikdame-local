// public/turn-light.js
// The turn light's geometry: where the pool of light lies for the seat on turn and
// which felt it may fall on. Pure (rectangles in, numbers out): client.js reads the
// DOM and writes the styles, style.css ("TURN LIGHT") owns colour and strength.
// Loaded before client.js; the tests require() it. Docs: docs/developer/table-light.md.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PikdameTurnLight = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const BASE = 200; // the pool's unscaled box in px (style.css: #turnLight i)
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const px = (n) => Math.round(n * 100) / 100;
  const boxed = (r) => !!r && r.width > 0 && r.height > 0;

  /**
   * The light for the seat on turn. Rectangles are viewport boxes ({ left, top, width, height }):
   * `table`, `layer` (the light's own box; it starts below the opponents in the grid layouts),
   * `seats` (the opponents' row), `hand` (my hand's panel) and `seat` (the chip, the boss field
   * or my hand). The result:
   * - `band`: the felt the light may fall on, as a box inside `layer`: from below the seats to
   *   the hand's upper edge, the table's full width. The top bar, the chips and the hand carry
   *   text with little or no contrast to spare, so no light reaches under them.
   * - `cx`, `cy`, `w`, `h`: the pool's centre and size inside the band. An opponent's pool hangs
   *   from the band's upper edge under the chip, mine rises from its lower edge: half an
   *   ellipse on the felt in front of the seat. `transform` moves the BASE box there.
   * Null when there is nothing to light (no seat, no room).
   */
  function plan({ table, layer, seats, hand, seat, mine = false } = {}) {
    if (!boxed(table) || !boxed(seat)) return null;
    const W = table.width;
    const H = table.height;
    const top = boxed(seats) ? clamp(seats.top + seats.height - table.top, 0, H) : 0;
    const bottom = boxed(hand) ? clamp(hand.top - table.top, top, H) : H;
    const room = bottom - top;
    if (room < 24) return null;
    const origin = boxed(layer) ? layer : table;
    const band = { left: px(table.left - origin.left), top: px(table.top + top - origin.top), width: px(W), height: px(room) };
    // Half the ellipse shows: wide and low, never higher than the band.
    const w = mine ? Math.min(W * 0.96, Math.max(340, W * 0.6)) : clamp(seat.width * 2.6, 260, W * 0.96);
    const h = 2 * Math.min(room, clamp(H * 0.16, 96, 150));
    const cx = clamp(seat.left + seat.width / 2 - table.left, 0, W);
    const cy = mine ? room : 0;
    const transform = `translate(${px(cx - BASE / 2)}px, ${px(cy - BASE / 2)}px) scale(${(w / BASE).toFixed(4)}, ${(h / BASE).toFixed(4)})`;
    return { cx, cy, w, h, band, transform };
  }

  /** Whose seat the light marks: the player on turn while a round is played, else nobody. */
  function seatOf(state, shownTurnId) {
    if (!state || state.phase !== 'playing') return null;
    return shownTurnId || state.currentPlayerId || null;
  }

  return { BASE, plan, seatOf };
}));
