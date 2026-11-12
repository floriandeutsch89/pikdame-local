// The debug view (public/debug-view.js + client.js): counters, pages, the copied
// report and the hook for browser checks (window.pikdameDebug).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const DebugView = require('../public/debug-view.js');
const GameManager = require('../game/GameManager');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const clientJs = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');

/** A running engine table as the first seat sees it, the way the wire carries it. */
function engineState() {
  const g = new GameManager(() => {}, { deckSeed: 7 });
  g.maybeRunBotTurn = () => {}; // no timer plays along (CLAUDE.md)
  g.addOrReconnectPlayer('p1', 'Flo');
  g.fillWithBots();
  g.startNewRound();
  const st = JSON.parse(JSON.stringify(g.publicState('p1')));
  g.destroy();
  return st;
}

test('meter: last, mean and maximum of the newest samples only', () => {
  const m = DebugView.meter(3);
  assert.deepStrictEqual(m.read(), { n: 0, last: null, avg: null, max: null });
  for (const v of [100, 2, 4, 6]) m.add(v);
  m.add(NaN);
  assert.deepStrictEqual(m.read(), { n: 3, last: 6, avg: 4, max: 6 });
});

test('stats: messages, bytes and types are counted, a pong closes the ping', () => {
  let now = 1000;
  const s = DebugView.createStats(() => now);
  s.opened();
  s.tx('{"type":"joinSession","code":"ABCD"}');
  s.tx('{"type":"ping"}');
  assert.strictEqual(s.pingOpen(), true);
  now += 40;
  s.rx('state', 5000);
  now += 2;
  s.rx('pong', 15);
  assert.strictEqual(s.pingOpen(), false);
  now += 500;
  const { net } = s.snapshot();
  assert.strictEqual(net.opens, 1);
  assert.strictEqual(net.txMsgs, 2);
  assert.strictEqual(net.txBytes, '{"type":"joinSession","code":"ABCD"}'.length + '{"type":"ping"}'.length);
  assert.strictEqual(net.rxMsgs, 2);
  assert.strictEqual(net.rxBytes, 5015);
  assert.deepStrictEqual(net.byType, { state: 1, pong: 1 });
  assert.deepStrictEqual(net.lastTypes, ['state', 'pong']);
  assert.strictEqual(net.stateBytes, 5000);
  assert.strictEqual(net.stateAgeMs, 502);
  assert.strictEqual(net.rxAgeMs, 500);
  assert.deepStrictEqual(net.rtt, { n: 1, last: 42, avg: 42, max: 42 });
});

test('stats: a second ping never restarts the round trip, a new socket drops it', () => {
  let now = 0;
  const s = DebugView.createStats(() => now);
  s.tx('{"type":"ping"}');
  now = 30;
  s.tx('{"type":"ping"}');
  now = 50;
  s.rx('pong', 15);
  assert.strictEqual(s.snapshot().net.rtt.last, 50);
  s.tx('{"type":"ping"}');
  s.closed();
  s.opened();
  s.rx('pong', 15); // the answer to a ping of the dead socket
  assert.strictEqual(s.snapshot().net.rtt.n, 1);
});

test('stats: frames give fps, a hidden tab is no slow frame', () => {
  const s = DebugView.createStats(() => 0);
  assert.strictEqual(s.snapshot().frames.fps, null);
  for (let t = 0; t <= 160; t += 16) s.frame(t);
  s.frame(160 + 60000); // back from the background
  s.frame(160 + 60000 + 32);
  const { frames } = s.snapshot();
  assert.strictEqual(frames.worstMs, 32);
  assert.ok(frames.fps > 55 && frames.fps < 63, `fps ${frames.fps}`);
  s.framesStopped();
  assert.strictEqual(s.snapshot().frames.n, 0);
});

test('stats: render timing, long tasks and the newest errors', () => {
  const s = DebugView.createStats(() => 0);
  assert.strictEqual(s.snapshot().longTasks, null, 'unknown where the browser cannot tell');
  s.longTasksWatched();
  assert.deepStrictEqual(s.snapshot().longTasks, { count: 0, maxMs: 0 });
  s.longTask(80);
  s.longTask(120);
  s.rendered(2);
  s.rendered(6);
  for (let i = 0; i < 14; i += 1) s.error(`boom ${i}`);
  const snap = s.snapshot();
  assert.deepStrictEqual(snap.longTasks, { count: 2, maxMs: 120 });
  assert.deepStrictEqual({ count: snap.render.count, last: snap.render.last, avg: snap.render.avg, max: snap.render.max }, { count: 2, last: 6, avg: 4, max: 6 });
  assert.strictEqual(snap.errors.length, 10);
  assert.strictEqual(snap.errors[9].msg, 'boom 13');
});

test('summarizeState: an engine table in a few fields, only the own hand', () => {
  const st = engineState();
  const sum = DebugView.summarizeState(st, 'p1');
  assert.strictEqual(sum.phase, 'playing');
  assert.strictEqual(sum.round, 1);
  assert.strictEqual(sum.players.length, 4);
  assert.strictEqual(sum.players.filter((p) => p.me).length, 1);
  assert.strictEqual(sum.players.filter((p) => p.bot).length, 3);
  assert.strictEqual(sum.hand.length, st.players.find((p) => p.id === 'p1').hand.length);
  for (const code of sum.hand) assert.match(code, /^(JK|[♠♥♦♣](10|[2-9JQKA]))$/);
  assert.strictEqual(sum.stock, st.drawPileCount);
  assert.strictEqual(sum.onTurn, st.players.find((p) => p.id === st.currentPlayerId).name);
  assert.strictEqual(DebugView.summarizeState(null, 'p1'), null);
  assert.strictEqual(DebugView.summarizeState(st, 'nobody').hand, null);
});

test('cardCode: joker, face-down and plain cards', () => {
  assert.strictEqual(DebugView.cardCode({ suit: 'S', rank: 'Q' }), '♠Q');
  assert.strictEqual(DebugView.cardCode({ isJoker: true }), 'JK');
  assert.strictEqual(DebugView.cardCode({ faceDown: true }), '##');
  assert.strictEqual(DebugView.cardCode(null), '-');
});

/** Boots the client with the debug module, like index.html loads it. */
function boot(opts = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  const sockets = [];
  window.WebSocket = class {
    constructor() { this.readyState = 1; this.sent = []; this.on = {}; sockets.push(this); }
    addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); }
    removeEventListener() {}
    send(raw) { this.sent.push(raw); }
    close() {}
    emit(type, ev = {}) { for (const fn of this.on[type] || []) fn(ev); }
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  if (opts.debugOn) window.localStorage.setItem('pikdame_debug', 'on');
  for (const src of ['i18n.js', 'table-moves.js', 'debug-view.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return { window, doc: window.document, errors, sockets };
}

test('index.html loads debug-view.js before client.js', () => {
  assert.ok(html.indexOf('/debug-view.js') > 0 && html.indexOf('/debug-view.js') < html.indexOf('/client.js'));
});

test('panel: pages turn, fold, move; the choice survives a reload', () => {
  const { window, doc, errors } = boot();
  try {
    const panel = doc.getElementById('debugPanel');
    assert.ok(panel.classList.contains('hidden'));
    assert.strictEqual(doc.getElementById('dbgBody').textContent, '', 'nothing is painted while the view is off');
    doc.getElementById('debugCheckbox').click();
    assert.ok(!panel.classList.contains('hidden'));
    const body = doc.getElementById('dbgBody');
    const name = doc.getElementById('dbgPageName');
    assert.strictEqual(name.textContent, 'Layout 1/4');
    assert.match(body.textContent, /^Pik Dame .*\nmode: portrait/);
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      doc.getElementById('dbgPageBtn').click();
      seen.push(name.textContent);
    }
    assert.deepStrictEqual(seen, ['Netz 2/4', 'Render 3/4', 'Spiel 4/4', 'Layout 1/4']);
    doc.getElementById('dbgPageBtn').click();
    assert.match(body.textContent, /\nws: open {2}online: true\n/);
    assert.strictEqual(window.localStorage.getItem('pikdame_debug_page'), 'net');

    doc.getElementById('dbgFoldBtn').click();
    assert.ok(panel.classList.contains('folded'));
    assert.strictEqual(window.localStorage.getItem('pikdame_debug_fold'), 'on');
    doc.getElementById('dbgFoldBtn').click();
    assert.ok(!panel.classList.contains('folded'));

    const docks = [panel.dataset.dock];
    for (let i = 0; i < 4; i += 1) { body.click(); docks.push(panel.dataset.dock); }
    assert.deepStrictEqual(docks, ['tr', 'br', 'bl', 'tl', 'tr'], 'a tap on the values moves the panel on, corner by corner');
    body.click();
    assert.strictEqual(window.localStorage.getItem('pikdame_debug_dock'), 'br');
    for (const dock of ['br', 'bl', 'tl']) assert.ok(css.includes(`#debugPanel[data-dock="${dock}"]`), `corner ${dock} is styled`);
    for (const id of ['dbgPageBtn', 'dbgCopyBtn', 'dbgFoldBtn']) {
      assert.ok(doc.getElementById(id).getAttribute('aria-label'), `#${id} has a name`);
      assert.ok(doc.getElementById(id).querySelector('svg.icon use'), `#${id} carries a sprite icon`);
    }
    assert.deepStrictEqual(errors, []);
  } finally { window.close(); }

  const again = boot({ debugOn: true });
  try {
    again.window.localStorage.setItem('pikdame_debug_page', 'game');
    again.doc.getElementById('debugCheckbox').click();
    again.doc.getElementById('debugCheckbox').click();
    assert.strictEqual(again.doc.getElementById('dbgPageName').textContent, 'Spiel 4/4');
    assert.deepStrictEqual(again.errors, []);
  } finally { again.window.close(); }
});

test('report: counts the socket, reads the table, carries no secret', () => {
  const { window, doc, errors, sockets } = boot();
  try {
    window.localStorage.setItem('pikdame_token_ABCD', 'seat-secret-token');
    window.localStorage.setItem('pikdame_account_token', 'account-secret-token');
    const sock = sockets[0];
    sock.emit('open');
    sock.emit('message', { data: JSON.stringify({ type: 'joined', sessionCode: 'ABCD', playerId: 'p1', playerToken: 'seat-secret-token' }) });
    const state = JSON.stringify({ type: 'state', state: engineState() });
    sock.emit('message', { data: state });

    const report = window.pikdameDebug.report();
    assert.strictEqual(report.app, 'Pik Dame');
    assert.strictEqual(report.net.ws, 'open');
    assert.strictEqual(report.net.opens, 1);
    assert.strictEqual(report.net.byType.state, 1);
    assert.strictEqual(report.net.stateBytes, state.length);
    assert.strictEqual(report.net.txMsgs, sock.sent.length, 'every frame of the socket is counted');
    assert.ok(report.net.txMsgs >= 1);
    assert.ok(report.render.count >= 1, 'render() is timed');
    assert.strictEqual(report.game.screen, 'table');
    assert.strictEqual(report.game.session, 'ABCD');
    assert.strictEqual(report.game.state.phase, 'playing');
    assert.strictEqual(report.game.state.players.length, 4);
    assert.strictEqual(report.layout.mode, 'portrait');

    const text = window.pikdameDebug.text();
    assert.ok(text.startsWith('Pik Dame debug report\n{'));
    assert.deepStrictEqual(Object.keys(JSON.parse(text.slice(text.indexOf('\n')))), Object.keys(report));
    assert.ok(!/secret-token/.test(text), 'no seat or account token');
    assert.ok(!/"p1"/.test(text), 'no player id');

    assert.strictEqual(window.pikdameDebug.page('game'), 'game');
    assert.strictEqual(window.pikdameDebug.page('nonsense'), 'layout');
    assert.strictEqual(doc.documentElement.classList.contains('debugMode'), false, 'the hook works with the view off');
    assert.deepStrictEqual(errors, []);
  } finally { window.close(); }
});

test('pages: every line fits the panel, with a full table and large values', () => {
  const { window, sockets } = boot({ debugOn: true });
  try {
    const st = engineState();
    st.players[1].name = 'Großmutter Wilhelmine von Hohenstein';
    const sock = sockets[0];
    sock.emit('open');
    sock.emit('message', { data: JSON.stringify({ type: 'joined', sessionCode: 'ABCD', playerId: 'p1' }) });
    sock.emit('message', { data: JSON.stringify({ type: 'state', state: st }) });
    const report = window.pikdameDebug.report();
    report.net.rxBytes = 987654321;
    report.net.rtt = { n: 20, last: 1234.5, avg: 999.9, max: 4321 };
    report.render.max = 1234.56;
    report.game.overlays = ['settingsOverlay', 'rulesOverlay', 'accountOverlay'];
    for (const page of DebugView.PAGES) {
      const lines = DebugView.pageLines(page, report);
      assert.ok(lines.length >= 5, `${page} has content`);
      for (const line of lines) {
        assert.ok([...line].length <= DebugView.WIDTH, `${page}: "${line}" is ${[...line].length} long`);
        // Cut lines end in "…": with realistic values only a long name or a pile of sheets may be cut.
        assert.ok(!line.endsWith('…') || /Großmutter|overlays/.test(line), `${page}: "${line}" was cut`);
      }
    }
    assert.match(css, new RegExp(`#dbgBody \\{[^}]*width: ${DebugView.WIDTH}ch`));
    assert.deepStrictEqual(DebugView.pageLines('game', { game: { screen: 'lobby', overlays: [] } }).slice(-1), ['no table state']);
  } finally { window.close(); }
});

test('the view on: a round-trip ping goes out, switching it off stops the probe', async () => {
  const { window, doc, sockets, errors } = boot({ debugOn: true });
  try {
    const sock = sockets[0];
    sock.emit('open');
    const pings = () => sock.sent.filter((raw) => raw === '{"type":"ping"}').length;
    // The view was on at load, before the socket opened: switching it again probes at once.
    doc.getElementById('debugCheckbox').click();
    doc.getElementById('debugCheckbox').click();
    assert.strictEqual(pings(), 1);
    sock.emit('message', { data: '{"type":"pong"}' });
    assert.strictEqual(window.pikdameDebug.report().net.rtt.n, 1);
    assert.deepStrictEqual(errors, []);
  } finally { window.close(); }
});

test('client: tap targets from the scale, no once-a-second timer', () => {
  assert.match(css, /#debugPanel \.dbgBtn \{[^}]*min-width: var\(--tap-min\); min-height: var\(--tap-min\)/);
  assert.ok(!/setInterval\(updateDebugPanel/.test(clientJs), 'the once-a-second timer is gone');
});
