/** Sound effects (public/sfx.js): every take is audible, never clips and keeps its
 *  energy above 300 Hz (phone speakers); the client plays the right effect on the
 *  right moment, quietly where asked, never on a reload, and never throws. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const Sfx = require('../public/sfx.js');
const { analyze } = require('../scripts/render-sfx.js');

const pub = path.join(__dirname, '..', 'public');
const CLIENT = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const db = (x) => 20 * Math.log10(x);

test('every effect: audible, unclipped, its energy above 300 Hz, at 44.1 and 48 kHz', () => {
  assert.ok(Sfx.NAMES.length >= 12);
  for (const rate of [44100, 48000]) {
    for (const name of Sfx.NAMES) {
      const fx = Sfx.EFFECTS[name];
      assert.ok(fx.seconds > 0.05 && fx.seconds <= 2, `${name}: a short cue`);
      for (const seed of [1, 2, 3, 77]) {
        const x = Sfx.render(name, rate, { seed });
        const a = analyze(x, rate);
        const what = `${name} @${rate} seed ${seed}`;
        assert.strictEqual(x.length, Math.ceil(fx.seconds * rate), what);
        assert.ok(a.finite, `${what}: finite samples`);
        assert.ok(a.peak > 0 && a.peak <= Sfx.PEAK_MAX + 1e-6, `${what}: peak ${db(a.peak).toFixed(1)} dBFS`);
        // Normalised to its level: the peak guard never had to step in.
        assert.ok(Math.abs(db(a.rms) - fx.db) < 0.05, `${what}: rms ${db(a.rms).toFixed(2)} dBFS, wanted ${fx.db}`);
        assert.ok(fx.db > -48, `${what}: not too quiet to hear`);
        assert.ok(a.lowShare < 0.15, `${what}: ${(a.lowShare * 100).toFixed(1)} % of the energy below 300 Hz`);
        assert.ok(Math.abs(x[0]) < 1e-3 && x[x.length - 1] === 0, `${what}: starts and ends without a click`);
      }
    }
  }
});

test('card noises vary from take to take, a seed repeats exactly', () => {
  for (const name of ['draw', 'discard', 'meld', 'deal']) {
    const a = Sfx.render(name, 48000, { seed: 5 });
    assert.deepStrictEqual(a, Sfx.render(name, 48000, { seed: 5 }), `${name}: deterministic per seed`);
    assert.notDeepStrictEqual(a, Sfx.render(name, 48000, { seed: 6 }), `${name}: another take sounds a little different`);
  }
  assert.throws(() => Sfx.render('beep'), /unknown sound effect/);
});

test('balance: card noises sit below the turn bell, the Queen of Spades above them', () => {
  const loud = (name) => db(analyze(Sfx.render(name, 48000, { seed: 1 }), 48000).rmsA); // ear-weighted
  const bell = loud('turn');
  for (const name of ['draw', 'discard', 'meld', 'deal', 'error']) assert.ok(loud(name) < bell, `${name} is quieter than the bell`);
  assert.ok(loud('draw') < loud('discard'), 'taking a card is the softest');
  for (const name of ['pikdame', 'pikdameLost', 'pikdameCaught', 'lucky']) {
    assert.ok(loud(name) > loud('discard'), `${name} stands out from the card noises`);
  }
});

/** A Web Audio context that records what it was asked to play. */
class FakeContext {
  constructor({ state = 'running', sampleRate = 48000, resume = null } = {}) {
    this.state = state;
    this.sampleRate = sampleRate;
    this.currentTime = 2;
    this.destination = { id: 'out' };
    this.sources = [];
    this.resumeImpl = resume;
  }
  resume() {
    if (this.resumeImpl) return this.resumeImpl(this);
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
  }
  createBufferSource() {
    const src = { buffer: null, to: null, when: null, connect(n) { this.to = n; }, disconnect() {}, start(t) { this.when = t; } };
    this.sources.push(src);
    return src;
  }
  createGain() { return { gain: { value: 1 }, to: null, connect(n) { this.to = n; }, disconnect() {} }; }
}

test('play(): a fresh take at the context rate, through a gain at the asked volume, at its time', () => {
  const ctx = new FakeContext({ sampleRate: 44100 });
  const seconds = Sfx.play(ctx, 'discard', { volume: 0.4, when: 3.5 });
  const [src] = ctx.sources;
  assert.strictEqual(src.buffer.length, Math.ceil(Sfx.EFFECTS.discard.seconds * 44100));
  assert.strictEqual(src.buffer.sampleRate, 44100);
  assert.ok(Math.abs(seconds - src.buffer.duration) < 1e-9);
  assert.ok(src.buffer.getChannelData(0).some((v) => v !== 0), 'the samples are in the buffer');
  assert.strictEqual(src.when, 3.5);
  assert.strictEqual(src.to.gain.value, 0.4);
  assert.strictEqual(src.to.to, ctx.destination);
  assert.strictEqual(typeof src.onended, 'function', 'the nodes are released when it ends');
});

test('client contract: every effect it plays exists, every effect is played; sfx.js loads before client.js', () => {
  const used = new Set([...CLIENT.matchAll(/(?:playSfx|cardSound)\('(\w+)'/g)].map((m) => m[1]));
  assert.deepStrictEqual([...used].sort(), [...Sfx.NAMES].sort());
  assert.doesNotMatch(CLIENT, /playTone\(|createOscillator\(\)[\s\S]{0,40}osc\.type = type/, 'no beeps left');
  const at = (src) => HTML.indexOf(`<script src="${src}" defer></script>`);
  assert.ok(at('/sfx.js') > 0 && at('/sfx.js') < at('/client.js'));
});

test('client: card noises take a volume for other seats\' moves, and only my own buzz', () => {
  const pick = (re) => { const m = CLIENT.match(re); assert.ok(m, `${re} in client.js`); return m[0]; };
  const src = pick(/\n {2}const SFX_QUIET = [^\n]*\n/) + pick(/\n {2}function sfxLevel\(opt\) \{[\s\S]*?\n {2}\}\n/)
    + pick(/\n {2}const cardSound = [\s\S]*?\n {2}\};\n/);
  const calls = [];
  const buzz = [];
  const ctx = { playSfx: (name, level) => calls.push([name, level]), vibrate: (p) => buzz.push(p) };
  vm.runInNewContext(`${src}\nthis.cardSound = cardSound;`, ctx);
  const draw = ctx.cardSound('draw', 8);
  draw();
  draw({ quiet: true });
  draw(0.25);
  draw({ volume: 0.5 });
  draw(true);
  draw(3);
  assert.deepStrictEqual(calls, [['draw', 1], ['draw', 0.4], ['draw', 0.25], ['draw', 0.5], ['draw', 0.4], ['draw', 1]]);
  assert.deepStrictEqual(buzz, [8, 8], 'quiet calls play without the buzz');
});

// --- the client in jsdom ------------------------------------------------------------
/** The real client with sfx.js and a recording AudioContext; `played` lists the effects asked for. */
function boot({ storage = {}, withSfx = true, context = {} } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  const vibrations = [];
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = (p) => { vibrations.push(p); return true; };
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.requestAnimationFrame = () => 0;
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  const contexts = [];
  window.AudioContext = function AudioContext() { const c = new FakeContext(context); contexts.push(c); return c; };
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
    send() {} close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.onerror = (msg) => errors.push(String(msg));
  window.console.error = (...a) => errors.push(a.map(String).join(' '));
  window.localStorage.setItem('pikdame_tip_seen', '9');
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const played = [];
  const scripts = withSfx ? ['i18n.js', 'sfx.js', 'client.js'] : ['i18n.js', 'client.js'];
  for (const src of scripts) {
    window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
    if (src === 'sfx.js') {
      const real = window.PikdameSfx.play;
      window.PikdameSfx.play = (ctx, name, opts) => { played.push({ name, ...opts }); return real(ctx, name, opts); };
    }
  }
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const send = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  const join = () => send({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'SOUND1' });
  const state = (s) => send({ type: 'state', state: s });
  const names = () => played.map((p) => p.name);
  return { window, doc: window.document, errors, vibrations, contexts, played, names, join, state };
}
const ready = () => new Promise((r) => setTimeout(r, 10));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const C = (id) => ({ id, suit: id[0], rank: id.slice(1, id.indexOf('-')), isJoker: false });
const HAND = ['H2-0', 'H5-0', 'C9-0', 'D10-0', 'SK-0'];
function st({ hand = HAND, pile = ['D4-0', 'C7-1'], melds = [], turn = 8, cur = 'p1', phase = 'meld', round = 2, ...rest } = {}) {
  const cards = pile.map(C);
  return {
    phase: 'playing', roundNumber: round, turnIndexInRound: turn, currentPlayerId: cur, turnPhase: phase, dealerId: 'b1',
    drawPileCount: 40, discardTop: cards[0] || null, discardPileCount: cards.length, discardCards: cards,
    tableMelds: melds.map(([ownerId, ids], i) => ({ id: `m${i}`, ownerId, type: 'set', slots: ids.map((id) => ({ real: C(id) })) })),
    log: [], houseRules: {}, lobbyReady: [], nextRoundReady: [], totals: { p1: 120, b1: 80, b2: 60 }, scoreHistory: [],
    players: [
      { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: hand.length, hand: hand.map(C) },
      { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 12, botDifficulty: 'medium' },
      { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 9, botDifficulty: 'medium' },
    ],
    ...rest,
  };
}
const lobby = () => ({ ...st(), phase: 'lobby', roundNumber: 0, isHost: true });
function roundEnd(over = {}) {
  const mk = (score, win) => ({ roundScore: score, breakdown: { isWinner: !!win, multiplier: 1 } });
  return {
    ...st({ cur: 'b1', phase: 'draw' }), phase: 'roundEnd', lastRoundWinnerId: 'b1',
    totals: { p1: 15, b1: 300, b2: 90 },
    lastRoundResult: { p1: mk(-105), b1: mk(180, true), b2: mk(30) },
    lastRoundStats: [
      { id: 'p1', name: 'Flo', laidOutCount: 3, handCount: 4, pikDameCount: 1, laidLines: [{ kind: 'low', count: 3, points: 15 }],
        handLines: [{ kind: 'pikdame', count: 1, points: 100 }, { kind: 'low', count: 3, points: 15 }] },
      { id: 'b1', name: 'Klaus', laidOutCount: 15, handCount: 0 },
      { id: 'b2', name: 'Horst', laidOutCount: 9, handCount: 4 },
    ],
    ...over,
  };
}
const QUEENS = ['SQ-0', 'HQ-0', 'CQ-0'];

test('round start: a new deal shuffles once - also after a cut - but never on a reload', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(lobby());
  c.state(st({ round: 1, turn: 0, cur: 'b1', phase: 'draw' }));
  assert.deepStrictEqual(c.names(), ['deal'], 'the game starts with a shuffle');
  c.state(st({ round: 1, turn: 1, cur: 'b2', phase: 'draw' }));
  assert.deepStrictEqual(c.names(), ['deal'], 'once per deal');
  c.state(roundEnd({ roundNumber: 1, lastRoundStats: roundEnd().lastRoundStats.map((s) => ({ ...s, pikDameCount: 0 })) }));
  c.state({ ...st({ round: 2 }), phase: 'cutting', cutterId: 'p1' });
  c.state(st({ round: 2, turn: 0, cur: 'b1', phase: 'draw' }));
  assert.deepStrictEqual(c.names(), ['deal', 'roundEnd', 'deal'], 'the next round: one shuffle, when the cut begins');
  assert.deepStrictEqual(c.errors, []);

  const reload = boot();
  t.after(() => reload.window.close());
  await ready();
  reload.join();
  reload.state(st({ round: 3, cur: 'b1', phase: 'draw' }));
  reload.state(st({ round: 3, turn: 9, cur: 'b2', phase: 'draw' }));
  assert.deepStrictEqual(reload.names(), [], 'joining a running round is no deal');
});

test('my moves: the turn bell, then the draw and the discard at full volume with a buzz', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ cur: 'b1', phase: 'draw' }));
  c.state(st({ cur: 'p1', turn: 9, phase: 'draw' }));
  assert.deepStrictEqual(c.names(), ['turn']);
  c.doc.getElementById('drawPile').click();
  c.state(st({ cur: 'p1', turn: 9, phase: 'meld', hand: [...HAND, 'D7-0'] }));
  c.doc.querySelector('#hand .card[data-card-id="H2-0"]').click();
  c.doc.getElementById('discardBtn').click();
  assert.deepStrictEqual(c.names(), ['turn', 'draw', 'discard']);
  assert.ok(c.played.every((p) => p.volume === 1), 'my own moves at full volume');
  assert.ok(c.vibrations.includes(8) && c.vibrations.includes(12), 'and they buzz');
  const ctx = c.contexts[0];
  assert.strictEqual(c.contexts.length, 1, 'one shared AudioContext');
  assert.strictEqual(ctx.sources.length, 3, 'three buffers went out');
  assert.ok(ctx.sources.every((s) => s.buffer && s.buffer.length > 0 && s.when >= ctx.currentTime));
  assert.deepStrictEqual(c.errors, []);
});

test('the Queen of Spades: mine is a fanfare, a bot\'s a "dun-dun", the Glücksgriff its own', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ hand: [...HAND, ...QUEENS] }));
  c.state(st({ melds: [['p1', QUEENS]] }));
  assert.deepStrictEqual(c.names(), ['pikdame']);
  c.state(st({ cur: 'b1', turn: 9, phase: 'draw', melds: [['p1', QUEENS]] }));
  c.state(st({ cur: 'b2', turn: 10, phase: 'draw', melds: [['p1', QUEENS], ['b1', ['SQ-1', 'HQ-1', 'DQ-1']]] }));
  assert.deepStrictEqual(c.names(), ['pikdame', 'pikdameLost']);
  // Two cues in a row: the second waits for the first instead of piling onto it.
  const [first, second] = c.played;
  assert.ok(second.when >= first.when + Sfx.EFFECTS.pikdame.seconds - 0.2, 'the "dun-dun" waits for the fanfare');
  // The cut of the next round reveals a joker for the cutter.
  c.contexts[0].currentTime += 5;
  c.state(st({ round: 3, turn: 0, cur: 'b1', phase: 'draw', lastCutReveal: { round: 3, cutterId: 'b1', cards: [{ id: 'J1', isJoker: true }, C('D3-0')], luckyCount: 1 } }));
  assert.deepStrictEqual(c.names().slice(2), ['deal', 'lucky']);
  assert.ok(c.doc.querySelector('.raidWarning.lucky'), 'with its banner');
  assert.deepStrictEqual(c.errors, []);
});

test('caught holding her: the trombone with her chip, behind the round-end cue, once', async (t) => {
  const c = boot();
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ cur: 'b1', phase: 'meld', hand: ['SQ-0', 'H2-0', 'H5-0', 'C9-0'] }));
  c.state(roundEnd());
  assert.deepStrictEqual(c.names(), ['roundEnd', 'pikdameCaught']);
  const [end, caught] = c.played;
  assert.ok(caught.when >= end.when + 0.6, 'after the sheet has landed and the round-end cue played');
  c.state(roundEnd({ log: [{ text: 'x' }] })); // the sheet re-renders
  assert.deepStrictEqual(c.names(), ['roundEnd', 'pikdameCaught'], 'no second trombone');
  // A reload into the result sheet: no moment, no trombone.
  const reload = boot();
  t.after(() => reload.window.close());
  await ready();
  reload.join();
  reload.state(roundEnd());
  assert.ok(!reload.names().includes('pikdameCaught'));
  assert.deepStrictEqual(c.errors, []);
});

test('iOS: a context that is not running yet plays once it resumes, never long after its moment', async (t) => {
  const c = boot({ context: { state: 'suspended' } });
  t.after(() => c.window.close());
  await ready();
  c.join();
  c.state(st({ cur: 'b1', phase: 'draw' }));
  c.state(st({ cur: 'p1', turn: 9, phase: 'draw' }));
  assert.deepStrictEqual(c.names(), [], 'nothing is scheduled on a suspended clock');
  await flush();
  assert.deepStrictEqual(c.names(), ['turn'], 'it rings once the context runs');

  let finish = null;
  const late = boot({ context: { state: 'suspended', resume: (ctx) => new Promise((r) => { finish = () => { ctx.state = 'running'; r(); }; }) } });
  t.after(() => late.window.close());
  await ready();
  late.join();
  late.state(st({ cur: 'b1', phase: 'draw' }));
  late.state(st({ cur: 'p1', turn: 9, phase: 'draw' }));
  const now = late.window.Date.now;
  late.window.Date.now = () => now() + 5000; // the first tap comes five seconds later
  finish();
  await flush();
  assert.deepStrictEqual(late.names(), [], 'the bell does not ring at the next tap');
  assert.deepStrictEqual(c.errors, []);
  assert.deepStrictEqual(late.errors, []);
});

test('sound off, or no sfx.js: silence without errors', async (t) => {
  const off = boot({ storage: { pikdame_sound_enabled: 'off' } });
  t.after(() => off.window.close());
  await ready();
  off.join();
  off.state(lobby());
  off.state(st({ round: 1, cur: 'b1', phase: 'draw' }));
  off.state(st({ round: 1, cur: 'p1', turn: 1, phase: 'draw' }));
  off.doc.getElementById('drawPile').click();
  assert.deepStrictEqual(off.names(), []);
  assert.deepStrictEqual(off.contexts, [], 'no AudioContext at all');
  assert.deepStrictEqual(off.vibrations, []);
  assert.deepStrictEqual(off.errors, []);

  const bare = boot({ withSfx: false });
  t.after(() => bare.window.close());
  await ready();
  bare.join();
  bare.state(lobby());
  bare.state(st({ round: 1, cur: 'p1', phase: 'draw' }));
  bare.doc.getElementById('drawPile').click();
  assert.deepStrictEqual(bare.errors, []);
  assert.ok(bare.vibrations.includes(8), 'the buzz does not need the effects');
});
