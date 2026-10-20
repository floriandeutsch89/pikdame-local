// Victory celebrations: ONE whitelist (game/Celebrations.js) the client
// mirrors, unlocked by the profile's level, picked only by the signed-in owner
// of the name, and shown to the whole table when its owner wins - as a band
// behind the round-end sheet that never takes a tap and cleans up after itself.
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { JSDOM } = require('jsdom');
const { CELEBRATION_DEFS, CELEBRATION_IDS, isCelebration, celebrationLevel } = require('../game/Celebrations');
const { createPlayerStore } = require('../game/PlayerStore');
const { xpForLevel } = require('../game/Progression');
const GameManager = require('../game/GameManager');

const ROOT = path.join(__dirname, '..');
const pub = path.join(ROOT, 'public');
let PORT = 0;

/** Total XP at the start of a level. */
function xpAt(level) {
  let xp = 0;
  for (let l = 1; l < level; l++) xp += xpForLevel(l);
  return xp;
}

test('whitelist: one list, ordered by level, mirrored by client, select and i18n', () => {
  assert.equal(CELEBRATION_IDS[0], 'standard');
  assert.equal(celebrationLevel('standard'), 1);
  assert.equal(new Set(CELEBRATION_IDS).size, CELEBRATION_IDS.length, 'ids unique');
  const levels = CELEBRATION_DEFS.map((c) => c.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'ordered by level');
  assert.ok(CELEBRATION_DEFS.length >= 5, 'standard plus at least four to unlock');
  assert.ok(CELEBRATION_IDS.every((id) => /^[a-z]+$/.test(id)), 'plain ids: they become CSS classes');
  for (const bad of ['nope', '', undefined, null, 42, {}, ['cats'], 'Cats']) {
    assert.equal(isCelebration(bad), false, `${JSON.stringify(bad)} is no celebration`);
  }
  assert.equal(celebrationLevel('nope'), Infinity, 'unknown ids never unlock');

  const client = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
  const block = client.match(/const CELEBRATIONS = \[([\s\S]*?)\n {2}\];/);
  assert.ok(block, 'CELEBRATIONS literal in client.js');
  const mirrored = [...block[1].matchAll(/\{ id: '([a-z]+)', level: (\d+), de: '([^']+)', en: '([^']+)' \}/g)]
    .map((m) => ({ id: m[1], level: Number(m[2]), de: m[3], en: m[4] }));
  assert.deepEqual(mirrored.map(({ id, level }) => ({ id, level })), CELEBRATION_DEFS, 'client mirrors ids and levels');

  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const select = html.match(/<select id="celebrationSelect"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'settings select exists');
  const options = [...select[1].matchAll(/<option value="([a-z]+)">([^<]+)<\/option>/g)].map((m) => ({ id: m[1], de: m[2] }));
  assert.deepEqual(options.map((o) => o.id), CELEBRATION_IDS, 'one option per celebration, same order');
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(pub, 'i18n.js'), 'utf8'), ctx);
  for (const o of options) {
    const c = mirrored.find((x) => x.id === o.id);
    assert.equal(o.de, c.de, `${o.id}: HTML name = client name`);
    assert.equal(ctx.window.I18N_STATIC[o.de], c.en, `${o.id}: I18N_STATIC gives the client's English name`);
  }
});

test('PlayerStore.setCelebration: whitelist and level checked, standard clears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-cel-store-'));
  const store = createPlayerStore(path.join(dir, 'players.json'));
  store.upsertPlayerProfile('Flo');
  store.addProgress('Flo', { xp: xpAt(20) });

  assert.equal(store.setCelebration('Nobody', 'cats').error, 'Profil nicht gefunden.');
  assert.equal(store.setCelebration('Flo', 'nope').error, 'Diesen Siegesjubel gibt es nicht.');
  assert.equal(store.setCelebration('Flo', { id: 'cats' }).error, 'Diesen Siegesjubel gibt es nicht.');
  assert.equal(store.setCelebration('Flo', 'cardfan').error, 'Diesen Siegesjubel gibt es ab Stufe 35.');
  assert.equal(store.getPlayerByName('Flo').celebration, undefined, 'a refusal stores nothing');

  assert.deepEqual(store.setCelebration('flo', 'fireworks'), { celebration: 'fireworks' }, 'name is case-insensitive');
  assert.equal(store.getPlayerByName('Flo').celebration, 'fireworks');
  assert.deepEqual(store.setCelebration('Flo', 'standard'), { celebration: 'standard' });
  assert.equal(store.getPlayerByName('Flo').celebration, undefined, 'standard = no field');

  // Exactly at the threshold: level 35 unlocks the card fan.
  store.addProgress('Flo', { xp: xpAt(35) - xpAt(20) });
  assert.deepEqual(store.setCelebration('Flo', 'cardfan'), { celebration: 'cardfan' });
  assert.match(store.setCelebration('Flo', 'goldqueen').error, /ab Stufe 50/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GameManager: the seat carries it to everyone; bots, leavers, junk and a new owner do not', () => {
  const g = new GameManager(() => {});
  g.addOrReconnectPlayer('p1', 'Flo');
  g.addOrReconnectPlayer('p2', 'Anna');
  g.fillWithBots();
  const seat = (st, id) => st.players.find((p) => p.id === id);

  g.setPlayerCelebration('p1', 'fireworks');
  for (const viewer of ['p1', 'p2']) {
    assert.equal(seat(g.publicState(viewer), 'p1').celebration, 'fireworks', `${viewer} sees Flo's celebration`);
  }
  assert.equal(seat(g.publicState('p1'), 'p2').celebration, undefined);

  const bot = g.players.find((p) => p.isBot);
  g.setPlayerCelebration(bot.id, 'cats');
  assert.equal(bot.celebration, undefined, 'bots never celebrate');
  g.setPlayerCelebration('p2', 'nope');
  assert.equal(seat(g.publicState('p1'), 'p2').celebration, undefined, 'unknown id ignored');
  g.setPlayerCelebration('p2', 'cats');
  g.setPlayerCelebration('p2', 'standard');
  assert.equal(g.players.find((p) => p.id === 'p2').celebration, undefined, 'standard clears');

  // Restart: the snapshot keeps it (JSON roundtrip), a tampered one cannot smuggle junk onto the wire.
  const snap = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new GameManager(() => {});
  g2.deserialize(snap);
  assert.equal(seat(g2.publicState('p2'), 'p1').celebration, 'fireworks', 'survives a restart');
  snap.players.find((p) => p.id === 'p2').celebration = '<img src=x onerror=alert(1)>';
  const g3 = new GameManager(() => {});
  g3.deserialize(snap);
  assert.equal(seat(g3.publicState('p1'), 'p2').celebration, undefined, 'only whitelist ids reach the wire');

  // A seat given up for good: the bot plays it without the leaver's celebration,
  // and whoever takes it over later starts clean (the server sets their own).
  const flo = g.players.find((p) => p.id === 'p1');
  flo.leftGame = true;
  assert.equal(seat(g.publicState('p2'), 'p1').celebration, undefined, 'a leaver no longer celebrates');
  g._takeOverSeat(flo, 'Cara');
  assert.equal(flo.celebration, undefined, 'the newcomer does not inherit it');
});

test('server: only the signed-in owner picks, only unlocked ids; the whole table sees it', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-cel-'));
  // Flo is level 20: fireworks yes, card fan (35) and golden queen (50) not yet.
  const seed = createPlayerStore(path.join(dataDir, 'players.json'));
  seed.upsertPlayerProfile('Flo');
  seed.addProgress('Flo', { xp: xpAt(20) + 30 });
  seed.flushSync();

  PORT = await freePort();

  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PIKDAME_PUBLIC_MODE: '0', PIKDAME_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.terminate();
    // SIGTERM writes the snapshot into dataDir - wait for the exit before removing it.
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const http = require('node:http');
  for (let up = false, i = 0; !up; i++) {
    if (i > 150) throw new Error(`server did not come up:\n${out}`);
    up = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 500 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  const post = (urlPath, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  assert.equal((await post('/api/register-passwordless', { username: 'Flo', email: 'flo@example.org' })).status, 200);
  let mailCode = null;
  for (let i = 0; i < 80 && !mailCode; i++) {
    const m = out.match(/Bestätigungscode (\d{6})/);
    if (m) mailCode = m[1]; else await new Promise((r) => setTimeout(r, 50));
  }
  const verified = await post('/api/verify-code', { email: 'flo@example.org', code: mailCode });
  assert.equal(verified.status, 200);
  const token = verified.json.token;
  assert.ok(token, 'signed in');

  const open = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    sockets.push(ws);
    ws.inbox = [];
    ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw)));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  /** Takes the first message that matches out of the inbox (later ones stay). */
  const take = (ws, pred, what) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const i = ws.inbox.findIndex(pred);
      if (i !== -1) return resolve(ws.inbox.splice(i, 1)[0]);
      if (Date.now() - started > 4000) return reject(new Error(`no ${what}; got ${JSON.stringify(ws.inbox.map((m) => m.error || m.type))}`));
      setTimeout(tick, 20);
    };
    tick();
  });
  const error = (ws) => take(ws, (m) => m.type === 'error', 'error').then((m) => m.error);
  const set = (ws, celebration, extra = {}) => ws.send(JSON.stringify({ type: 'setCelebration', name: 'Flo', celebration, accountToken: token, ...extra }));
  const floSeat = (m) => m.state.players.find((p) => p.name === 'Flo');
  const stateWhere = (ws, pred, what) => take(ws, (m) => m.type === 'state' && pred(m), what);

  const flo = await open();
  set(flo, 'fireworks', { accountToken: undefined });
  assert.match(await error(flo), /mit deinem Konto - bitte zuerst anmelden/, 'no token: refused');
  set(flo, 'fireworks', { accountToken: 'forged' });
  assert.match(await error(flo), /mit deinem Konto/, 'unknown token: refused');
  set(flo, 'cats', { name: 'Anna' });
  assert.match(await error(flo), /mit deinem Konto/, "Flo's account cannot pick for another name");
  set(flo, 'goldqueen');
  assert.equal(await error(flo), 'Diesen Siegesjubel gibt es ab Stufe 50.', 'locked: refused with the level');
  set(flo, 'cardfan');
  assert.equal(await error(flo), 'Diesen Siegesjubel gibt es ab Stufe 35.');
  set(flo, 'rainbow');
  assert.equal(await error(flo), 'Diesen Siegesjubel gibt es nicht.', 'unknown id: refused');
  set(flo, { toString: () => 'cats' });
  assert.equal(await error(flo), 'Diesen Siegesjubel gibt es nicht.', 'only strings');

  set(flo, 'fireworks');
  const profiles = await take(flo, (m) => m.type === 'profiles' && m.players.some((p) => p.name === 'Flo' && p.celebration), 'profiles');
  assert.equal(profiles.players.find((p) => p.name === 'Flo').celebration, 'fireworks', 'stored on the profile');

  // A registered name sits down only with its token, so the seat really is the owner's.
  flo.send(JSON.stringify({ type: 'createSession', name: 'Flo', accountToken: token }));
  const joined = await take(flo, (m) => m.type === 'joined', 'joined');
  assert.equal(floSeat(await stateWhere(flo, () => true, 'state')).celebration, 'fireworks', 'my seat carries it');

  const guest = await open();
  guest.send(JSON.stringify({ type: 'joinSession', code: joined.sessionCode, name: 'Gast' }));
  const guestView = await stateWhere(guest, (m) => m.state.players.some((p) => p.name === 'Gast'), 'guest state');
  assert.equal(floSeat(guestView).celebration, 'fireworks', 'the other player sees it too');
  assert.equal(guestView.state.players.find((p) => p.name === 'Gast').celebration, undefined, 'a guest has none');
  assert.ok(guestView.state.players.filter((p) => p.isBot).every((p) => p.celebration === undefined), 'bots have none');

  // Changed while seated: the table learns it right away.
  set(flo, 'cats');
  await stateWhere(guest, (m) => floSeat(m).celebration === 'cats', 'state with cats');
  set(flo, 'standard');
  await stateWhere(guest, (m) => floSeat(m).celebration === undefined, 'state without a celebration');
  // A refused pick changes nothing at the table.
  set(flo, 'goldqueen');
  assert.match(await error(flo), /ab Stufe 50/);
});

// --- Client (jsdom) -----------------------------------------------------------

function boot(storage = {}, { fetch, reducedMotion = false } = {}) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  const sent = [];
  window.matchMedia = (q) => ({
    matches: reducedMotion && /prefers-reduced-motion/.test(q), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  let rafDepth = 0;
  window.requestAnimationFrame = (cb) => {
    if (rafDepth > 4) return 0;
    rafDepth += 1;
    try { cb(Date.now()); } finally { rafDepth -= 1; }
    return 0;
  };
  window.fetch = fetch || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-test' }), text: () => Promise.resolve('') }));
  window.AudioContext = function () {
    return {
      createOscillator: () => ({ connect: (x) => x, start() {}, stop() {}, type: 'sine', frequency: { setValueAtTime() {}, value: 0 } }),
      createGain: () => ({ connect: (x) => x, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }),
      destination: { connect: (x) => x }, currentTime: 0, state: 'running',
      resume: () => Promise.resolve(), suspend: () => Promise.resolve(),
    };
  };
  window.webkitAudioContext = window.AudioContext;
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
    _emit(t, ev) {
      if (typeof this['on' + t] === 'function') this['on' + t](ev);
      for (const f of this._ls[t] || []) f(ev);
    }
    send(data) { try { sent.push(JSON.parse(data)); } catch (e) { /* not JSON */ } }
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const emit = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  return { window, doc: window.document, errors, sent, emit };
}

/** Round end at a table of two humans (Flo = p1, Anna = p2) and two bots. */
function roundEnd({ winner = 'p2', celebrations = {}, phase = 'roundEnd', gameOverInfo } = {}) {
  const res = (id, score) => ({ roundScore: score, breakdown: { isWinner: id === winner, multiplier: 1 } });
  const scores = { p1: -45, p2: 270, b1: 110, b2: -35 };
  if (winner !== 'p2') { scores[winner] = 300; scores.p2 = 20; }
  const human = (id, name) => ({ id, name, isBot: false, connected: true, handCount: id === winner ? 0 : 5, hand: [], celebration: celebrations[id] });
  return {
    phase, roundNumber: 1, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1',
    discardTop: null, drawPileCount: 30, discardPileCount: 3, log: [], tableMelds: [], lobbyReady: [],
    nextRoundReady: [], houseRules: {}, totals: { ...scores },
    lastRoundWinnerId: winner,
    lastRoundResult: Object.fromEntries(Object.entries(scores).map(([id, s]) => [id, res(id, s)])),
    lastRoundStats: [{ id: 'p1', name: 'Flo', laidOutCount: 3, handCount: 5, laidLines: [], handLines: [] }],
    gameOverInfo,
    players: [
      human('p1', 'Flo'),
      human('p2', 'Anna'),
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 4, botDifficulty: 'medium', celebration: celebrations.b1 },
      { id: 'b2', name: 'Maria', isBot: true, connected: true, handCount: 6, botDifficulty: 'medium' },
    ],
  };
}

async function atTable(me, state, opts) {
  const app = boot({}, opts);
  await new Promise((r) => setTimeout(r, 10));
  app.emit({ type: 'joined', playerId: me, playerToken: 't', sessionCode: 'ABCD' });
  app.emit({ type: 'state', state });
  app.card = app.doc.querySelector('#resultOverlay .overlay-card');
  app.bands = () => [...app.card.children].filter((c) => c.classList.contains('celebrationBand'));
  return app;
}

test('round end: the others see the winner\'s celebration behind the sheet, once per round', async (t) => {
  const app = await atTable('p1', roundEnd({ winner: 'p2', celebrations: { p2: 'cats' } }));
  t.after(() => app.window.close());
  const [band] = app.bands();
  assert.ok(band, 'band in the result card');
  assert.ok(band.classList.contains('fx-cats'));
  assert.equal(band.getAttribute('aria-hidden'), 'true');
  assert.equal(band.querySelectorAll('.fxCat').length, 16);
  assert.ok(app.card.classList.contains('celebrating'));
  assert.ok(!band.classList.contains('still'));
  assert.equal(app.doc.querySelectorAll('.confetti, .spadeRainPiece').length, 0, 'no winner confetti for me');
  assert.ok(!app.doc.getElementById('resultOverlay').classList.contains('hidden'), 'the sheet itself is shown');

  // The next state (someone taps "ready") re-renders the sheet: same band, no restart.
  app.emit({ type: 'state', state: { ...roundEnd({ winner: 'p2', celebrations: { p2: 'cats' } }), nextRoundReady: ['p2'] } });
  assert.deepEqual(app.bands(), [band]);
  assert.deepEqual(app.errors, [], `Client-Fehler: ${app.errors.join(' | ')}`);
});

test('round end: the winner sees their own celebration instead of the classic confetti', async (t) => {
  for (const id of CELEBRATION_IDS.filter((c) => c !== 'standard')) {
    const app = await atTable('p2', roundEnd({ winner: 'p2', celebrations: { p2: id } }));
    t.after(() => app.window.close());
    const bands = app.bands();
    assert.equal(bands.length, 1, id);
    assert.ok(bands[0].classList.contains(`fx-${id}`));
    assert.ok(bands[0].children.length > 0, `${id} draws something`);
    assert.equal(app.doc.querySelectorAll('.confetti').length, 0, `${id}: not both`);
    assert.deepEqual(app.errors, [], `Client-Fehler (${id}): ${app.errors.join(' | ')}`);
  }
});

test('round end: standard stays the winner-only confetti; bots and unknown ids show nothing', async (t) => {
  const mine = await atTable('p1', roundEnd({ winner: 'p1' }));
  t.after(() => mine.window.close());
  assert.ok(mine.doc.querySelectorAll('.confetti').length > 0, 'my standard win: classic confetti');
  assert.equal(mine.bands().length, 0);

  const theirs = await atTable('p1', roundEnd({ winner: 'p2' }));
  t.after(() => theirs.window.close());
  assert.equal(theirs.doc.querySelectorAll('.confetti').length + theirs.bands().length, 0, 'Anna\'s standard win: nothing for me');

  const bot = await atTable('p1', roundEnd({ winner: 'b1', celebrations: { b1: 'goldqueen' } }));
  t.after(() => bot.window.close());
  assert.equal(bot.bands().length, 0, 'a bot never celebrates');

  const junk = await atTable('p1', roundEnd({ winner: 'p2', celebrations: { p2: 'x" onmouseover="alert(1)' } }));
  t.after(() => junk.window.close());
  assert.equal(junk.bands().length, 0, 'only whitelist ids play');
  for (const app of [mine, theirs, bot, junk]) assert.deepEqual(app.errors, [], `Client-Fehler: ${app.errors.join(' | ')}`);
});

test('game over: the game winner celebrates; a forfeit does not', async (t) => {
  const over = await atTable('p1', roundEnd({
    winner: 'p1', phase: 'gameOver', celebrations: { p2: 'goldqueen' },
    gameOverInfo: { winnerId: 'p2', totalTurns: 80, totalRounds: 4, highlights: [] },
  }));
  t.after(() => over.window.close());
  assert.ok(over.bands()[0] && over.bands()[0].classList.contains('fx-goldqueen'), 'the match winner, not the last round\'s');
  assert.ok(over.bands()[0].querySelector('.fxQueen use[href="#i-crown"]'), 'crown from the sprite, no emoji');

  const forfeit = await atTable('p1', roundEnd({
    winner: 'p2', phase: 'gameOver', celebrations: { p2: 'goldqueen' },
    gameOverInfo: { winnerId: null, forfeited: true, totalTurns: 20, totalRounds: 1, highlights: [] },
  }));
  t.after(() => forfeit.window.close());
  assert.equal(forfeit.bands().length, 0);
  for (const app of [over, forfeit]) assert.deepEqual(app.errors, [], `Client-Fehler: ${app.errors.join(' | ')}`);
});

test('cleanup: the band is gone after a few seconds; reduced motion gets a still, shorter picture', async (t) => {
  for (const reducedMotion of [false, true]) {
    const app = boot({}, { reducedMotion });
    t.after(() => app.window.close());
    await new Promise((r) => setTimeout(r, 10));
    const later = [];
    const realTimeout = app.window.setTimeout.bind(app.window);
    app.window.setTimeout = (fn, ms, ...rest) => (ms === 2400 || ms === 3400 ? later.push({ fn, ms }) : realTimeout(fn, ms, ...rest));
    app.emit({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' });
    app.emit({ type: 'state', state: roundEnd({ winner: 'p2', celebrations: { p2: 'cats' } }) });
    const card = app.doc.querySelector('#resultOverlay .overlay-card');
    const band = card.querySelector('.celebrationBand');
    assert.ok(band);
    assert.equal(band.classList.contains('still'), reducedMotion);
    if (reducedMotion) assert.equal(band.querySelectorAll('.fxCat').length, 5, 'a calm row instead of a rain');
    assert.deepEqual(later.map((x) => x.ms), [reducedMotion ? 2400 : 3400], 'one cleanup timer');
    later[0].fn();
    assert.equal(card.querySelector('.celebrationBand'), null, 'removed');
    assert.ok(!card.classList.contains('celebrating'));
    assert.deepEqual(app.errors, [], `Client-Fehler: ${app.errors.join(' | ')}`);
  }

  // Never in the way: behind the content, no taps, and the still variant animates nothing.
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  assert.match(css, /#resultOverlay \.overlay-card \{ isolation: isolate; \}/);
  const band = css.match(/\n\.celebrationBand \{([^}]*)\}/);
  assert.ok(band, '.celebrationBand rule');
  assert.match(band[1], /z-index: -1/);
  assert.match(band[1], /pointer-events: none/);
  assert.match(css, /\.celebrationBand\.still \*, \.still \.fxQueen::after \{ animation: none; \}/);
});

const signedInFetch = (url) => Promise.resolve({
  ok: true,
  json: () => Promise.resolve(
    String(url).startsWith('/statusz') ? { version: '0.0.0-test', accountsEnabled: true }
      : String(url).startsWith('/api/me') ? { ok: true, username: 'Flo' }
        : { version: '0.0.0-test' }
  ),
  text: () => Promise.resolve(''),
});

test('settings: locked choices name their level; a pick sends only the id with the account token', async (t) => {
  const app = boot({ pikdame_player_name: 'Flo', pikdame_account_token: 'tok' }, { fetch: signedInFetch });
  t.after(() => app.window.close());
  await new Promise((r) => setTimeout(r, 30)); // /statusz -> /api/me -> signed in
  app.emit({ type: 'profiles', publicMode: false, globalStats: null, players: [{ name: 'Flo', xp: xpAt(20) + 30, celebration: 'cats' }] });
  const { doc } = app;
  const select = doc.getElementById('celebrationSelect');
  assert.ok(!doc.getElementById('celebrationItem').classList.contains('hidden'));
  assert.equal(select.value, 'cats', 'shows the stored choice');
  assert.equal(select.disabled, false);
  const opt = (id) => select.querySelector(`option[value="${id}"]`);
  for (const id of ['standard', 'cats', 'fireworks']) assert.equal(opt(id).disabled, false, `${id} unlocked at level 20`);
  assert.equal(opt('cardfan').disabled, true);
  assert.equal(opt('cardfan').textContent, 'Kartenfächer · ab Stufe 35');
  assert.equal(opt('goldqueen').textContent, 'Goldene Pik Dame · ab Stufe 50');
  assert.equal(doc.getElementById('celebrationHint').textContent, 'Alle am Tisch sehen ihn');

  select.value = 'fireworks';
  select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.deepEqual(app.sent.filter((m) => m.type === 'setCelebration'),
    [{ type: 'setCelebration', name: 'Flo', celebration: 'fireworks', accountToken: 'tok' }]);

  // Refused (e.g. stale level): the select falls back to what the profile holds.
  app.emit({ type: 'error', error: 'Diesen Siegesjubel gibt es ab Stufe 35.' });
  assert.equal(select.value, 'cats');

  doc.getElementById('celebrationPreviewBtn').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  const preview = doc.getElementById('celebrationPreview');
  assert.ok(preview.querySelector('.celebrationBand.fx-cats'), 'preview plays the selected one');
  assert.ok(preview.classList.contains('celebrating'), 'the preview box opens while it plays');

  doc.getElementById('langBtn').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  assert.equal(opt('cardfan').textContent, 'Card fan · level 35');
  assert.equal(opt('cats').textContent, 'Cat confetti');
  assert.equal(doc.getElementById('celebrationHint').textContent, 'Everyone at the table sees it');
  assert.deepEqual(app.errors, [], `Client-Fehler: ${app.errors.join(' | ')}`);
});

test('settings: without an account the choice is shown but locked; public servers hide it', async (t) => {
  const guest = boot({ pikdame_player_name: 'Flo' });
  t.after(() => guest.window.close());
  await new Promise((r) => setTimeout(r, 10));
  guest.emit({ type: 'profiles', publicMode: false, globalStats: null, players: [{ name: 'Flo', xp: xpAt(50) }] });
  const select = guest.doc.getElementById('celebrationSelect');
  assert.equal(select.disabled, true, 'a name alone is spoofable');
  assert.equal(guest.doc.getElementById('celebrationHint').textContent, 'Mit Konto wählbar');
  select.dispatchEvent(new guest.window.Event('change', { bubbles: true }));
  assert.equal(guest.sent.filter((m) => m.type === 'setCelebration').length, 0);

  const open = boot({ pikdame_player_name: 'Flo' });
  t.after(() => open.window.close());
  await new Promise((r) => setTimeout(r, 10));
  open.emit({ type: 'profiles', publicMode: true, players: [], globalStats: null });
  assert.ok(open.doc.getElementById('celebrationItem').classList.contains('hidden'), 'no profiles, no celebration');
  for (const app of [guest, open]) assert.deepEqual(app.errors, [], `Client-Fehler: ${app.errors.join(' | ')}`);
});
