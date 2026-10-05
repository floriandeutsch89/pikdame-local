// public/uplot-touch.js - touch support for uPlot charts (admin monitor,
// challenge graph). uPlot's cursor and drag-to-zoom are mouse-only. One
// finger: tap moves the cursor (legend shows the values), a horizontal drag
// selects a range and zooms on release, a double tap calls onReset.
// touch-action: pan-y leaves vertical page scrolling to the browser.
(function () {
  'use strict';
  const DRAG_PX = 8;
  const DOUBLE_TAP_MS = 350;

  function uplotTouch(opts) {
    const onReset = (opts && opts.onReset) || null;
    let lastTouchAt = 0;
    return {
      // After a tap the browser emulates mouse events and ends with a
      // mouseleave, which would hide the cursor (and the values) right away.
      opts(u, o) {
        const cursor = (o.cursor = o.cursor || {});
        const bind = (cursor.bind = cursor.bind || {});
        const prev = bind.mouseleave;
        bind.mouseleave = (self, targ, handler) => {
          const h = prev ? prev(self, targ, handler) : handler;
          return (e) => (Date.now() - lastTouchAt < 800 ? null : h(e));
        };
      },
      hooks: {
        init(u) {
          const over = u.over;
          over.style.touchAction = 'pan-y';
          let start = null; // {x, y} while a one-finger gesture is ours
          let dragging = false;
          let lastTap = 0;
          const pos = (t) => {
            const r = over.getBoundingClientRect();
            return {
              x: Math.min(Math.max(t.clientX - r.left, 0), r.width),
              y: Math.min(Math.max(t.clientY - r.top, 0), r.height),
            };
          };
          const clearSelect = () => u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);

          over.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) { start = null; return; }
            start = pos(e.touches[0]);
            dragging = false;
            u.setCursor({ left: start.x, top: start.y });
          }, { passive: true });

          over.addEventListener('touchmove', (e) => {
            if (!start || e.touches.length !== 1) return;
            const p = pos(e.touches[0]);
            const dx = Math.abs(p.x - start.x);
            if (!dragging) {
              // Mostly vertical: the page scrolls, the gesture is not ours.
              if (Math.abs(p.y - start.y) > dx) { if (Math.abs(p.y - start.y) > DRAG_PX) start = null; return; }
              if (dx < DRAG_PX) return;
              dragging = true;
            }
            if (e.cancelable) e.preventDefault();
            u.setSelect({ left: Math.min(start.x, p.x), width: dx, top: 0, height: over.clientHeight }, false);
            u.setCursor({ left: p.x, top: p.y });
          }, { passive: false });

          over.addEventListener('touchend', () => {
            lastTouchAt = Date.now();
            if (!start) return;
            if (dragging && u.select.width > DRAG_PX) {
              const min = u.posToVal(u.select.left, 'x');
              const max = u.posToVal(u.select.left + u.select.width, 'x');
              clearSelect();
              u.setScale('x', { min, max });
            } else if (!dragging) {
              const now = Date.now();
              if (now - lastTap < DOUBLE_TAP_MS) {
                lastTap = 0;
                if (onReset) onReset(u);
              } else {
                lastTap = now;
              }
            }
            start = null;
            dragging = false;
          });

          over.addEventListener('touchcancel', () => {
            lastTouchAt = Date.now();
            if (dragging) clearSelect();
            start = null;
            dragging = false;
          });
        },
      },
    };
  }

  window.uplotTouch = uplotTouch;
})();
