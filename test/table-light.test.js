/** Table light clock (public/table-light.js) and its wiring in client.js: German
 *  wall time, phase weights with smooth ramps, one step a minute, and the tick runs
 *  only while the table shows. The colours: test/table-light-css.test.js. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const TL = require('../public/table-light.js');

const pub = path.join(__dirname, '..', 'public');
const at = (iso) => Date.parse(iso);
const H = (h, m = 0) => h * 60 + m;
const rounded = (w) => ['m', 'd', 'e', 'n'].map((k) => +w[k].toFixed(4));
const NIGHT = { '--tod-m': '0.0000', '--tod-d': '0.0000', '--tod-e': '0.0000', '--tod-n': '1.0000' };

test('table light: German wall time in summer and winter, whatever the device zone', () => {
  assert.strictEqual(TL.berlinMinutes(at('2026-07-01T10:00:00Z')), H(12)); // CEST
  assert.strictEqual(TL.berlinMinutes(at('2026-01-15T10:00:00Z')), H(11)); // CET
  assert.strictEqual(TL.berlinMinutes(at('2026-01-15T23:30:30Z')), H(0, 30.5)); // the next day
});

test('table light: plateaus and ramps at the designed times', () => {
  const cases = [
    [H(0, 30), [0, 0, 0, 1]], [H(5), [0, 0, 0, 1]], [H(6), [0.5, 0, 0, 0.5]], [H(7), [1, 0, 0, 0]],
    [H(9, 30), [1, 0, 0, 0]], [H(10, 15), [0.5, 0.5, 0, 0]], [H(11), [0, 1, 0, 0]], [H(13), [0, 1, 0, 0]],
    [H(16, 30), [0, 1, 0, 0]], [H(17, 30), [0, 0.5, 0.5, 0]], [H(18, 30), [0, 0, 1, 0]], [H(22), [0, 0, 1, 0]],
    [H(22, 45), [0, 0, 0.5, 0.5]], [H(23, 30), [0, 0, 0, 1]],
  ];
  for (const [minutes, want] of cases) assert.deepStrictEqual(rounded(TL.phaseWeights(minutes)), want, `${Math.floor(minutes / 60)}:${minutes % 60}`);
});

test('table light: the weights always sum to 1 and one minute moves them below 1/60', () => {
  let prev = null;
  let maxStep = 0;
  for (let s = 0; s <= 24 * 3600; s += 20) {
    const w = TL.phaseWeights(s / 60);
    assert.ok(Math.abs(w.m + w.d + w.e + w.n - 1) < 1e-12, `sum at ${s} s`);
    for (const k of ['m', 'd', 'e', 'n']) assert.ok(w[k] >= 0 && w[k] <= 1, `${k} in range at ${s} s`);
    if (prev) for (const k of ['m', 'd', 'e', 'n']) maxStep = Math.max(maxStep, Math.abs(w[k] - prev[k]) * 3);
    prev = w;
  }
  // Smoothstep peaks at 1.5x the mean slope; the shortest ramps take 90 minutes.
  assert.ok(maxStep <= 1.5 / 90 + 1e-6, `max change per minute ${maxStep}`);
  assert.strictEqual(TL.UPDATE_MS, 60 * 1000);
});

test('table light: both DST switches fall into the night, so they never show', () => {
  for (const iso of [
    '2026-03-29T00:00:00Z', '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-03-29T02:00:00Z',
    '2026-10-25T00:00:00Z', '2026-10-25T00:59:59Z', '2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z',
  ]) assert.deepStrictEqual(TL.cssWeights(at(iso)), NIGHT, iso);
});

test('table light: the weights as #table properties, noon exactly the day', () => {
  assert.deepStrictEqual(TL.cssWeights(at('2026-10-22T11:00:00Z')), { '--tod-m': '0.0000', '--tod-d': '1.0000', '--tod-e': '0.0000', '--tod-n': '0.0000' });
  assert.deepStrictEqual(TL.cssWeights(at('2026-10-22T15:30:00Z')), { '--tod-m': '0.0000', '--tod-d': '0.5000', '--tod-e': '0.5000', '--tod-n': '0.0000' });
});

test('table light: without time zone data the clock falls back to UTC, like GameDay', () => {
  const sandbox = { module: { exports: {} }, Intl: { DateTimeFormat() { throw new RangeError('no time zone data'); } } };
  vm.runInNewContext(fs.readFileSync(path.join(pub, 'table-light.js'), 'utf8'), sandbox);
  assert.strictEqual(sandbox.module.exports.berlinMinutes(at('2026-07-01T10:15:30Z')), H(10, 15.5));
});

// --- client.js: the minute tick, only while the table is visible ------------------
function boot(scripts) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  window.requestAnimationFrame = (cb) => { cb(0); return 0; };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-test' }), text: () => Promise.resolve('') });
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) { if (typeof this['on' + t] === 'function') this['on' + t](ev); for (const f of this._ls[t] || []) f(ev); }
    send() {}
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  // The clock and the page's visibility are ours; minute ticks are recorded, not waited for.
  const clock = { now: at('2026-10-22T18:00:00Z') }; // 20:00 in Berlin: evening
  window.Date.now = () => clock.now;
  const ticks = new Map();
  let nextId = 1;
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    if (ms !== TL.UPDATE_MS) return realSetInterval(fn, ms, ...rest);
    const id = `light-${nextId++}`;
    ticks.set(id, fn);
    return id;
  };
  const realClearInterval = window.clearInterval.bind(window);
  window.clearInterval = (id) => { if (!ticks.delete(id)) realClearInterval(id); };
  let hidden = false;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  for (const src of scripts) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const setHidden = (h) => { hidden = h; window.document.dispatchEvent(new window.Event('visibilitychange')); };
  return { window, errors, clock, ticks, setHidden, ws: () => ws };
}
const playing = {
  phase: 'playing', roundNumber: 1, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1', turnDeadline: null,
  discardTop: { id: 'dt', suit: 'H', rank: '7' }, drawPileCount: 40, discardPileCount: 1, log: [], tableMelds: [],
  lobbyReady: [], nextRoundReady: [], houseRules: {}, totals: { p1: 0, b1: 0 },
  players: [
    { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 1, hand: [{ id: 'h1', suit: 'S', rank: '2' }] },
    { id: 'b1', name: 'Gisela', isBot: true, connected: true, handCount: 15, botDifficulty: 'medium' },
  ],
};
const lobby = { ...playing, phase: 'lobby', players: playing.players.map((p) => ({ ...p, hand: undefined, handCount: 0 })) };

test('table light: client.js lights the table only while it shows, a step a minute', async (t) => {
  const c = boot(['i18n.js', 'table-light.js', 'client.js']);
  t.after(() => c.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = c.ws();
  const feed = (s) => sock._emit('message', { data: JSON.stringify({ type: 'state', state: s }) });
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  const table = c.window.document.getElementById('table');
  const weights = () => ['m', 'd', 'e', 'n'].map((k) => table.style.getPropertyValue(`--tod-${k}`)).join(' ');

  feed(lobby);
  assert.strictEqual(c.ticks.size, 0, 'no tick on the start screen');
  feed(playing);
  assert.strictEqual(weights(), '0.0000 0.0000 1.0000 0.0000', 'evening weights before the first paint of the table');
  assert.strictEqual(c.ticks.size, 1, 'one minute tick while the table shows');
  feed(playing);
  assert.strictEqual(c.ticks.size, 1, 'a re-render keeps the one tick');

  c.clock.now = at('2026-10-22T20:15:00Z'); // 22:15: the night ramp
  [...c.ticks.values()][0]();
  assert.strictEqual(weights(), rounded(TL.phaseWeights(H(22, 15))).map((x) => x.toFixed(4)).join(' '), 'the tick follows the clock');

  c.setHidden(true);
  assert.strictEqual(c.ticks.size, 0, 'a hidden page does not tick');
  c.clock.now = at('2026-10-23T05:00:00Z'); // 07:00 the next morning
  c.setHidden(false);
  assert.strictEqual(weights(), '1.0000 0.0000 0.0000 0.0000', 'back in front: the light of now, at once');
  assert.strictEqual(c.ticks.size, 1, 'and ticking again');

  feed(lobby);
  assert.strictEqual(c.ticks.size, 0, 'the start screen stops the tick');
  assert.deepStrictEqual(c.errors, []);
});

test('table light: without the module the table keeps the day and nothing throws', async (t) => {
  const c = boot(['i18n.js', 'client.js']);
  t.after(() => c.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const sock = c.ws();
  sock._emit('message', { data: JSON.stringify({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' }) });
  sock._emit('message', { data: JSON.stringify({ type: 'state', state: playing }) });
  assert.strictEqual(c.window.document.getElementById('table').style.getPropertyValue('--tod-d'), '');
  assert.strictEqual(c.ticks.size, 0);
  c.setHidden(true);
  c.setHidden(false);
  assert.deepStrictEqual(c.errors, []);
});

test('table light: index.html loads the module before client.js', () => {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const order = ['/music-player.js', '/table-light.js', '/client.js'].map((s) => html.indexOf(`<script src="${s}" defer></script>`));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], `script order ${order}`);
});
