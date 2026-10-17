/** The lobby remembers the host's difficulty and rules per device and sends
 *  them along when this device opens its next table (the server applies them,
 *  see table-prefs.test.js). Boots the REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const GameManager = require('../game/GameManager');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const KEY = 'pikdame_table_prefs';

function boot({ storage = {} } = {}) {
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
  class FakeSocket {
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
    fire(type, payload) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners[type] || []) fn(payload === undefined ? {} : { data: JSON.stringify(payload) });
    }
  }
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  window.WebSocket = FakeSocket;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Ben');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const ws = sockets[sockets.length - 1];
  ws.fire('open');
  const doc = window.document;
  const sent = (type) => ws.sent.filter((m) => m.type === type);
  return { window, doc, ws, sent, errors };
}

/** A lobby as seen by p1; p1 is host unless someone sat down first. */
function lobby(t, { hostFirst = false, challengeDate } = {}) {
  const g = new GameManager(() => {}, challengeDate ? { challengeDate } : {});
  if (hostFirst) g.addOrReconnectPlayer('p0', 'Anna');
  g.addOrReconnectPlayer('p1', 'Ben');
  g.syncLobbyBots();
  t.ws.fire('message', { type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
  t.ws.fire('message', { type: 'state', state: g.publicState('p1') });
  g.destroy();
}
const segment = (t, select, value) => t.doc.querySelector(`.segmented[data-select="${select}"] .segBtn[data-value="${value}"]`).click();
const stored = (t) => JSON.parse(t.window.localStorage.getItem(KEY));

test('the host\'s lobby choices are remembered and ride along with the next new table', () => {
  const t = boot();
  t.doc.getElementById('createGameBtn').click();
  assert.strictEqual(t.sent('createSession')[0].tablePrefs, undefined, 'nothing remembered yet');
  lobby(t);
  segment(t, 'ruleBotLevel', 'hard');
  segment(t, 'ruleTurnTimer', '60');
  t.doc.getElementById('ruleHandAus').click();
  assert.strictEqual(t.sent('setAllBotDifficulty')[0].difficulty, 'hard', 'the live control still works');
  assert.deepStrictEqual(stored(t), {
    botLevel: 'hard',
    houseRules: { handAusDoubles: true, strictThreshold: false, turnTimerSeconds: 60, botPace: 'normal' },
  });
  assert.deepStrictEqual(t.errors, []);
  t.window.close();

  const next = boot({ storage: { [KEY]: JSON.stringify(stored(t)) } });
  next.doc.getElementById('createGameBtn').click();
  assert.deepStrictEqual(next.sent('createSession')[0].tablePrefs, stored(t));
  next.window.close();
});

test('a guest at someone else\'s table and the daily challenge remember nothing', () => {
  for (const opts of [{ hostFirst: true }, { challengeDate: '2026-10-17' }]) {
    const t = boot();
    lobby(t, opts);
    const sel = t.doc.getElementById('ruleBotLevel');
    sel.value = 'zen';
    sel.dispatchEvent(new t.window.Event('change'));
    const timer = t.doc.getElementById('ruleTurnTimer');
    timer.value = '90';
    timer.dispatchEvent(new t.window.Event('change'));
    assert.strictEqual(t.window.localStorage.getItem(KEY), null, `stored for ${JSON.stringify(opts)}`);
    t.window.close();
  }
});

test('broken stored prefs never break opening a table', () => {
  const t = boot({ storage: { [KEY]: '{not json' } });
  t.doc.getElementById('createGameBtn').click();
  const msg = t.sent('createSession')[0];
  assert.ok(msg, 'the table is still requested');
  assert.strictEqual(msg.tablePrefs, undefined);
  t.window.close();
});
