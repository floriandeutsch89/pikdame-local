// public/debug-view.js
// The debug view's numbers ("Optionen" -> "Debug-Ansicht"): counters for the
// connection, render timing and frames, a short reading of the table state, the
// panel's pages and the report that gets copied. No DOM in here: client.js feeds
// it and draws the panel. Loaded before client.js; the tests require() it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PikdameDebugView = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const PAGES = ['layout', 'net', 'render', 'game'];
  const WIDTH = 33; // characters per panel line (#dbgBody in style.css): longer lines are cut
  const FRAME_GAP_MS = 1000; // a longer gap is a hidden tab, not a slow frame
  const ERRORS_KEPT = 10;
  const TYPES_KEPT = 12;
  const SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };

  /** The last `size` samples: last, mean and maximum. */
  function meter(size) {
    const buf = [];
    return {
      add(v) {
        if (!Number.isFinite(v)) return;
        buf.push(v);
        if (buf.length > size) buf.shift();
      },
      clear() { buf.length = 0; },
      read() {
        if (!buf.length) return { n: 0, last: null, avg: null, max: null };
        let sum = 0;
        let max = -Infinity;
        for (const v of buf) { sum += v; if (v > max) max = v; }
        return { n: buf.length, last: buf[buf.length - 1], avg: sum / buf.length, max };
      },
    };
  }

  const typeOf = (text) => {
    const m = /"type"\s*:\s*"([^"]{1,40})"/.exec(String(text).slice(0, 200));
    return m ? m[1] : '?';
  };

  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const readRounded = (m) => {
    const r = m.read();
    return { n: r.n, last: r1(r.last), avg: r1(r.avg), max: r1(r.max) };
  };

  /** Collects what the client reports; `clock` is a monotonic millisecond clock. */
  function createStats(clock) {
    const now = clock || (() => Date.now());
    const net = { opens: 0, closes: 0, rxMsgs: 0, rxBytes: 0, txMsgs: 0, txBytes: 0, byType: {}, lastTypes: [], stateBytes: 0, stateAt: null, rxAt: null, pingAt: null };
    const rtt = meter(20);
    const renderMs = meter(60);
    const frameMs = meter(60);
    const long = { seen: false, count: 0, maxMs: 0 };
    const errors = [];
    let renders = 0;
    let frameAt = null;

    return {
      opened() { net.opens += 1; net.pingAt = null; },
      closed() { net.closes += 1; net.pingAt = null; },
      /** A received message: its type and length. A pong closes the open ping. */
      rx(type, bytes) {
        const t = String(type || '?');
        net.rxMsgs += 1;
        net.rxBytes += bytes || 0;
        net.rxAt = now();
        net.byType[t] = (net.byType[t] || 0) + 1;
        net.lastTypes.push(t);
        if (net.lastTypes.length > TYPES_KEPT) net.lastTypes.shift();
        if (t === 'state') { net.stateBytes = bytes || 0; net.stateAt = net.rxAt; }
        if (t === 'pong' && net.pingAt != null) { rtt.add(net.rxAt - net.pingAt); net.pingAt = null; }
      },
      /** A sent frame (the raw text). The first open ping starts the round trip. */
      tx(text) {
        net.txMsgs += 1;
        net.txBytes += String(text).length;
        if (typeOf(text) === 'ping' && net.pingAt == null) net.pingAt = now();
      },
      pingOpen() { return net.pingAt != null; },
      rendered(ms) { renders += 1; renderMs.add(ms); },
      /** One animation frame at `t` (the rAF timestamp). */
      frame(t) {
        if (frameAt != null && t - frameAt < FRAME_GAP_MS) frameMs.add(t - frameAt);
        frameAt = t;
      },
      framesStopped() { frameAt = null; frameMs.clear(); },
      longTask(ms) { long.seen = true; long.count += 1; if (ms > long.maxMs) long.maxMs = ms; },
      longTasksWatched() { long.seen = true; },
      error(what) {
        errors.push({ at: new Date().toISOString(), msg: String(what).slice(0, 300) });
        if (errors.length > ERRORS_KEPT) errors.shift();
      },
      snapshot() {
        const t = now();
        const f = frameMs.read();
        return {
          net: {
            opens: net.opens, closes: net.closes,
            rxMsgs: net.rxMsgs, rxBytes: net.rxBytes, txMsgs: net.txMsgs, txBytes: net.txBytes,
            byType: { ...net.byType }, lastTypes: net.lastTypes.slice(),
            stateBytes: net.stateBytes,
            stateAgeMs: net.stateAt == null ? null : Math.round(t - net.stateAt),
            rxAgeMs: net.rxAt == null ? null : Math.round(t - net.rxAt),
            rtt: readRounded(rtt),
          },
          render: { count: renders, ...readRounded(renderMs) },
          frames: { n: f.n, fps: f.avg ? r1(1000 / f.avg) : null, worstMs: r1(f.max) },
          longTasks: long.seen ? { count: long.count, maxMs: r1(long.maxMs) } : null,
          errors: errors.slice(),
        };
      },
    };
  }

  const cardCode = (c) => {
    if (!c) return '-';
    if (c.faceDown) return '##';
    if (c.isJoker) return 'JK';
    return `${SUITS[c.suit] || '?'}${c.rank}`;
  };

  /** The table state in a few fields, from the viewer's own view (their hand only). */
  function summarizeState(state, playerId) {
    if (!state || typeof state !== 'object') return null;
    const players = Array.isArray(state.players) ? state.players : [];
    const totals = state.totals || {};
    const me = players.find((p) => p.id === playerId) || null;
    const onTurn = players.find((p) => p.id === state.currentPlayerId) || null;
    const melds = Array.isArray(state.tableMelds) ? state.tableMelds : [];
    let mode = 'normal';
    if (state.bossFight) mode = 'boss';
    else if (state.towerStage) mode = 'tower';
    else if (state.tutorialMode) mode = 'tutorial';
    else if (state.challengeDate) mode = 'challenge';
    else if (state.teamMode) mode = 'team';
    return {
      phase: state.phase || null,
      turnPhase: state.turnPhase || null,
      round: state.roundNumber == null ? null : state.roundNumber,
      turn: state.turnIndexInRound == null ? null : state.turnIndexInRound,
      mode,
      onTurn: onTurn ? onTurn.name : null,
      myTurn: !!(onTurn && onTurn.id === playerId),
      paused: !!state.paused,
      stock: state.drawPileCount == null ? null : state.drawPileCount,
      discard: state.discardPileCount == null ? null : state.discardPileCount,
      discardTop: cardCode(state.discardTop),
      discardTakeable: state.discardTakeable == null ? null : state.discardTakeable,
      mustLayOff: state.mustLayOffCardId || null,
      melds: melds.length,
      meldCards: melds.reduce((n, m) => n + ((m && Array.isArray(m.slots)) ? m.slots.length : 0), 0),
      hand: me && Array.isArray(me.hand) ? me.hand.map(cardCode) : null,
      players: players.map((p) => ({
        name: p.name,
        me: p.id === playerId,
        bot: p.isBot ? (p.botDifficulty || true) : false,
        connected: p.connected !== false,
        byBot: !!p.controlledByBot,
        cards: p.handCount == null ? null : p.handCount,
        total: totals[p.id] == null ? null : totals[p.id],
      })),
    };
  }

  const ms = (v, digits = 0) => (v == null ? '-' : `${v.toFixed(digits)}ms`);
  const num = (v, digits = 0) => (v == null ? '-' : v.toFixed(digits));
  const kb = (bytes) => (bytes == null ? '-' : bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}kB`);
  const age = (v) => (v == null ? '-' : v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`);
  const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

  /** The lines of one panel page from the client's report object, each at most WIDTH long. */
  function pageLines(page, r) {
    return r ? rawLines(page, r).map((line) => cut(line, WIDTH)) : [];
  }
  function rawLines(page, r) {
    if (page === 'layout') {
      const l = r.layout || {};
      return [
        `mode: ${l.mode}  dpr: ${l.dpr}`,
        `window: ${l.w}x${l.h}  vv.h: ${l.vvH == null ? '-' : l.vvH}`,
        `100dvh: ${l.dvh}  #app.h: ${l.appH == null ? '-' : l.appH}`,
        `--appvh: ${l.appVh || '-'}  delta: ${l.delta == null ? '-' : l.delta}px`,
        `safe t/b: ${l.safeTop} / ${l.safeBottom}`,
        `safe l/r: ${l.safeLeft} / ${l.safeRight}`,
        `standalone: ${l.standalone}  lang: ${r.lang}`,
        `uiscale: ${l.uiScale}  theme: ${l.theme}`,
        'outlines: app=red screen=orange',
        '  handWrap=cyan hand=yellow',
      ];
    }
    if (page === 'net') {
      const n = r.net || {};
      const rtt = n.rtt || {};
      return [
        `ws: ${n.ws}  online: ${n.online}`,
        `rtt ms: ${num(rtt.last)}  avg ${num(rtt.avg)}  max ${num(rtt.max)}`,
        `last rx: ${age(n.rxAgeMs)}  state: ${age(n.stateAgeMs)}`,
        `state size: ${kb(n.stateBytes)}`,
        `in:  ${n.rxMsgs} msgs  ${kb(n.rxBytes)}`,
        `out: ${n.txMsgs} msgs  ${kb(n.txBytes)}`,
        `connects: ${n.opens}  drops: ${n.closes}`,
        `retry step: ${n.reconnectAttempt}`,
      ];
    }
    if (page === 'render') {
      const d = r.render || {};
      const f = r.frames || {};
      const lt = r.longTasks;
      return [
        `fps: ${num(f.fps)}  worst frame: ${ms(f.worstMs)}`,
        `render(): ${ms(d.last, 1)}  avg ${ms(d.avg, 1)}`,
        `  max ${ms(d.max, 1)}  calls: ${d.count}`,
        `dom nodes: ${d.domNodes == null ? '-' : d.domNodes}`,
        `long tasks: ${lt ? `${lt.count}  max ${ms(lt.maxMs)}` : 'n/a'}`,
        `js heap: ${d.heapMb == null ? 'n/a' : `${d.heapMb.toFixed(1)}MB`}`,
        `js errors: ${(r.errors || []).length}`,
      ];
    }
    if (page === 'game') {
      const g = r.game || {};
      const s = g.state;
      const lines = [
        `screen: ${g.screen}  session: ${g.session || '-'}`,
        `overlays: ${(g.overlays || []).length ? cut(g.overlays.join(' '), 30) : '-'}`,
      ];
      if (!s) return lines.concat('no table state');
      lines.push(
        `phase: ${s.phase}/${s.turnPhase || '-'}  mode: ${s.mode}`,
        `round: ${s.round}  turn: ${s.turn}${s.paused ? '  PAUSED' : ''}`,
        `on turn: ${s.onTurn ? cut(s.onTurn, 14) : '-'}${s.myTurn ? ' (me)' : ''}`,
        `stock: ${s.stock}  discard: ${s.discard} top ${s.discardTop}`,
        `melds: ${s.melds} (${s.meldCards} cards)`,
      );
      for (const p of s.players) {
        const tag = p.me ? '*' : p.bot ? 'b' : p.connected ? ' ' : 'x';
        lines.push(`${tag} ${cut(p.name, 12).padEnd(12)} ${String(p.cards).padStart(2)}c ${String(p.total == null ? '-' : p.total).padStart(4)}`);
      }
      return lines;
    }
    return [];
  }

  /** The report as text for the clipboard: one heading line, then JSON. */
  function reportText(report) {
    return `Pik Dame debug report\n${JSON.stringify(report, null, 2)}\n`;
  }

  return { PAGES, WIDTH, meter, createStats, summarizeState, cardCode, pageLines, reportText };
}));
