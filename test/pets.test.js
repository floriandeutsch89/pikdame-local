'use strict';
// Table pets: ONE whitelist (game/Pets.js) the client mirrors, the choice on the
// profile by level, the seat's pet on the wire for everyone, and what the pet
// does (public/pet.js) read from the state alone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PET_DEFS, PET_IDS, isPet, petLevel } = require('../game/Pets');
const Pet = require('../public/pet.js');
const GameManager = require('../game/GameManager');
const { createPlayerStore } = require('../game/PlayerStore');
const { xpForLevel } = require('../game/Progression');
const { testPool } = require('./helpers/test-db');
const { JSDOM } = require('jsdom');

const PUB = path.join(__dirname, '..', 'public');
/** Total XP at which `level` is reached. */
function xpAt(level) {
  let xp = 0;
  for (let l = 1; l < level; l++) xp += xpForLevel(l);
  return xp;
}

test('Pets: the list, its levels, and nothing but listed strings', () => {
  assert.deepEqual(PET_IDS, ['none', 'cat']);
  assert.equal(petLevel('none'), 1);
  assert.equal(petLevel('cat'), 12);
  assert.equal(petLevel('dragon'), Infinity, 'unknown ids never unlock');
  for (const bad of ['', 'Cat', 'dragon', null, undefined, 3, {}, ['cat']]) assert.equal(isPet(bad), false, JSON.stringify(bad));
});

test('client mirror: pet.js, the options select and the script order follow game/Pets.js', () => {
  assert.deepEqual(Pet.PETS.map((p) => [p.id, p.level]), PET_DEFS.map((p) => [p.id, p.level]));
  for (const p of Pet.PETS) assert.ok(p.de && p.en, `${p.id} has both names`);
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const select = html.match(/<select id="petSelect"[^>]*>([\s\S]*?)<\/select>/);
  assert.deepEqual([...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]), PET_IDS, 'one option per pet, same order');
  assert.ok(html.indexOf('/pet.js') > 0 && html.indexOf('/pet.js') < html.indexOf('/client.js'), 'pet.js loads before client.js');
  assert.match(html, /<span id="myPet"><\/span>\s*<div id="handWrapper">/, 'my pet lives beside the tray, which clips its children');
  assert.match(html, /id="petsCheckbox"/, 'a new animation can be switched off');
});

test('pet.js: markup only from the list, a safe collar colour and mood, the age as a negative delay', () => {
  assert.equal(Pet.html('dragon'), '');
  assert.equal(Pet.html('none'), '');
  const h = Pet.html('cat', { mood: 'cheer', collar: '#2a78d6', born: 1000, now: 13400 });
  assert.match(h, /^<span class="pet pet-cat mood-cheer" style="--pet-collar:#2a78d6;--pet-t:-12\.40s"><svg /);
  const odd = Pet.html('cat', { mood: 'x" onclick="alert(1)', collar: 'red;background:url(x)' });
  assert.match(odd, /class="pet pet-cat mood-idle" style="--pet-collar:#e8454f;/, 'unknown mood and colour fall back');
  assert.doesNotMatch(odd, /onclick|url\(/);
  for (const part of ['petTail', 'petEyes', 'petEyesShut', 'petEyesHappy', 'petYawn', 'petHeart', 'petZ', 'petCollar', 'petTag']) {
    assert.ok(Pet.CAT_SVG.includes(part), `the cat has its ${part}`);
  }
});

const seat = (id, extra = {}) => ({ id, name: id, isBot: false, connected: true, ...extra });
const queen = { real: { rank: 'Q', suit: 'S' } };
const state = (extra = {}) => ({ phase: 'playing', roundNumber: 2, currentPlayerId: 'a', players: [seat('a'), seat('b')], tableMelds: [], ...extra });

test('pet.js mood: on turn alert, a long turn yawns, away asleep, round end cheers or cowers', () => {
  const st = state();
  assert.equal(Pet.mood(st, 'a'), 'alert');
  assert.equal(Pet.mood(st, 'b'), 'idle');
  assert.equal(Pet.mood(st, 'a', { turnMs: Pet.YAWN_EVERY_MS + 100 }), 'yawn');
  assert.equal(Pet.mood(st, 'a', { turnMs: Pet.YAWN_EVERY_MS + Pet.YAWN_MS + 100 }), 'alert', 'one yawn per stretch');
  assert.equal(Pet.mood(st, 'b', { turnMs: Pet.YAWN_EVERY_MS + 100 }), 'idle', 'only its owner\'s turn bores it');
  assert.equal(Pet.mood(state({ players: [seat('a', { controlledByBot: true }), seat('b')] }), 'a'), 'sleep');
  assert.equal(Pet.mood(st, 'b', { fx: { mood: 'happy', until: 2000 }, now: 1000 }), 'happy');
  assert.equal(Pet.mood(st, 'b', { fx: { mood: 'happy', until: 2000 }, now: 3000 }), 'idle', 'a reaction runs out');
  assert.equal(Pet.mood(st, 'nobody'), 'idle');
  assert.equal(Pet.mood(null, 'a'), 'idle');
  const end = state({ phase: 'roundEnd', lastRoundWinnerId: 'b', lastRoundResult: { a: { breakdown: { pikDameCount: 1 } }, b: { breakdown: { pikDameCount: 0 } } } });
  assert.equal(Pet.mood(end, 'b'), 'cheer');
  assert.equal(Pet.mood(end, 'a'), 'scared', 'caught with the Queen of Spades');
  const over = state({ phase: 'gameOver', lastRoundWinnerId: 'a', gameOverInfo: { winnerId: null, winnerIds: ['b'] }, lastRoundResult: {} });
  assert.equal(Pet.mood(over, 'b'), 'cheer', 'the match winner, also as one of a team');
  assert.equal(Pet.mood(over, 'a'), 'idle', 'the last round alone is no match win');
});

test('pet.js events: a Queen of Spades newly in a seat\'s melds makes its pet happy - read from the table, not a counter', () => {
  const before = state({ tableMelds: [{ ownerId: 'a', slots: [{ real: { rank: 'Q', suit: 'H' } }] }] });
  const after = state({ tableMelds: [{ ownerId: 'a', slots: [{ real: { rank: 'Q', suit: 'H' } }, queen] }] });
  assert.deepEqual(Pet.eventsBetween(before, after, 500), { a: { mood: 'happy', until: 500 + Pet.HAPPY_MS } });
  assert.deepEqual(Pet.eventsBetween(after, after, 500), {}, 'nothing new, nothing happens');
  const joker = state({ tableMelds: [{ ownerId: 'a', slots: [{ joker: {}, representsRank: 'Q', representsSuit: 'S' }] }] });
  assert.deepEqual(Pet.eventsBetween(before, joker, 500), {}, 'a joker standing in for her is not her');
  assert.deepEqual(Pet.eventsBetween(null, after, 500), {}, 'a first state (reload) is no event');
  assert.deepEqual(Pet.eventsBetween(state({ roundNumber: 1 }), after, 500), {}, 'nor a new round');
});

test('PlayerStore.setPet: by level, cleared with "none", unknown ids refused', async (t) => {
  const store = createPlayerStore(testPool(t, 'pets'), { legacyFile: null });
  await store.upsertPlayerProfile('Flo');
  assert.deepEqual(await store.setPet('Flo', 'cat'), { error: 'Dieses Haustier gibt es ab Stufe 12.' });
  assert.equal((await store.getPlayerByName('Flo')).pet, undefined, 'a refusal stores nothing');
  await store.addProgress('Flo', { xp: xpAt(12) + 5 });
  assert.deepEqual(await store.setPet('flo', 'cat'), { pet: 'cat' }, 'the name is case-insensitive');
  assert.equal((await store.getPlayerByName('Flo')).pet, 'cat');
  assert.deepEqual(await store.setPet('Flo', 'dragon'), { error: 'Dieses Haustier gibt es nicht.' });
  assert.deepEqual(await store.setPet('Flo', 'none'), { pet: 'none' });
  assert.equal((await store.getPlayerByName('Flo')).pet, undefined, 'none = no field');
  assert.deepEqual(await store.setPet('Nobody', 'cat'), { error: 'Profil nicht gefunden.' });
});

test('engine: a seat\'s pet reaches every viewer, only from the list, survives a restart, never a bot or a leaver', () => {
  const g = new GameManager(() => {});
  g.maybeRunBotTurn = () => {};
  g.addOrReconnectPlayer('p1', 'Flo');
  g.addOrReconnectPlayer('p2', 'Anna');
  const petOf = (game, viewer, id) => game.publicState(viewer).players.find((p) => p.id === id).pet;
  g.setPlayerPet('p1', 'cat');
  for (const viewer of ['p1', 'p2']) assert.equal(petOf(g, viewer, 'p1'), 'cat', `${viewer} sees Flo's cat`);
  assert.equal(petOf(g, 'p1', 'p2'), undefined);
  g.setPlayerPet('p2', 'dragon');
  assert.equal(petOf(g, 'p1', 'p2'), undefined, 'unknown id ignored');
  g.setPlayerPet('p2', 'cat');
  g.setPlayerPet('p2', 'none');
  assert.equal(g.players.find((p) => p.id === 'p2').pet, undefined, 'none clears');

  const snap = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new GameManager(() => {});
  g2.deserialize(snap);
  assert.equal(petOf(g2, 'p2', 'p1'), 'cat', 'survives a restart');
  snap.players.find((p) => p.id === 'p2').pet = '<img src=x onerror=alert(1)>';
  const g3 = new GameManager(() => {});
  g3.deserialize(snap);
  assert.equal(petOf(g3, 'p1', 'p2'), undefined, 'only listed ids reach the wire');
  g.destroy(); g2.destroy(); g3.destroy();
});

// --- Client (jsdom) -----------------------------------------------------------

function boot(storage = {}) {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.requestAnimationFrame = () => 0;
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-test' }), text: () => Promise.resolve('') });
  window.AudioContext = function () {
    return {
      createOscillator: () => ({ connect: (x) => x, start() {}, stop() {}, type: 'sine', frequency: { setValueAtTime() {}, value: 0 } }),
      createGain: () => ({ connect: (x) => x, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }),
      destination: { connect: (x) => x }, currentTime: 0, state: 'running', resume: () => Promise.resolve(), suspend: () => Promise.resolve(),
    };
  };
  window.webkitAudioContext = window.AudioContext;
  let ws = null;
  window.WebSocket = class {
    constructor() { this._ls = {}; ws = this; this.readyState = 1; setTimeout(() => this._emit('open', {}), 0); }
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); }
    removeEventListener() {}
    _emit(t, ev) { for (const f of this._ls[t] || []) f(ev); }
    send() {}
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'pet.js', 'client.js']) window.eval(fs.readFileSync(path.join(PUB, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const emit = (msg) => ws._emit('message', { data: JSON.stringify(msg) });
  return { window, doc: window.document, errors, emit };
}

/** A running round: Flo (p1, me) on turn, Anna (p2) and a bot; pets as given. */
function table({ pets = {}, melds = [], turn = 'p1' } = {}) {
  const human = (id, name) => ({ id, name, isBot: false, connected: true, handCount: 5, hand: id === 'p1' ? [] : undefined, pet: pets[id] });
  return {
    phase: 'playing', roundNumber: 1, currentPlayerId: turn, turnPhase: 'draw', dealerId: 'b1',
    discardTop: null, drawPileCount: 30, discardPileCount: 3, log: [], tableMelds: melds, lobbyReady: [], nextRoundReady: [],
    houseRules: {}, totals: { p1: 0, p2: 0, b1: 0 },
    players: [human('p1', 'Flo'), human('p2', 'Anna'), { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 4, botDifficulty: 'medium', pet: pets.b1 }],
  };
}

test('client: a pet sits at its owner\'s seat, mine on the tray; a tap explains it; the switch hides them all', async (t) => {
  const app = boot();
  t.after(() => app.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const { doc } = app;
  app.emit({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' });
  app.emit({ type: 'state', state: table({ pets: { p1: 'cat', p2: 'cat', b1: 'cat' } }) });
  const chip = (id) => [...doc.getElementById('opponents').children].find((c) => c.dataset.playerId === id);
  const annas = chip('p2').querySelector('.opName > .pet.pet-cat');
  assert.ok(annas, 'Anna\'s cat is on her chip\'s name row');
  assert.ok(annas.classList.contains('mood-idle'), 'not her turn');
  assert.equal(chip('b1').querySelector('.pet'), null, 'a bot has none, whatever a state says');
  const mine = doc.querySelector('#myPet > .pet.pet-cat');
  assert.ok(mine && mine.classList.contains('mood-alert'), 'mine watches my turn');
  const atTable = () => doc.querySelectorAll('#opponents .pet, #myPet .pet').length;
  assert.equal(atTable(), 2);

  // A tap on her cat: whose it is, on the toast - and the chip's own tap (the meld filter) does not fire.
  annas.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  const toast = doc.getElementById('toastContainer');
  assert.ok(toast.classList.contains('petCard') && toast.classList.contains('visible'));
  assert.match(toast.textContent, /Katze von Anna/);
  assert.ok(toast.querySelector('.pet.pet-cat'), 'the figure large');
  assert.ok(!chip('p2').classList.contains('meldFilterActive'));

  // She melds the Queen of Spades: her cat is happy, mine is not on turn any more.
  const queens = [{ id: 'm1', ownerId: 'p2', type: 'set', rank: 'Q', slots: [{ real: { id: 1, rank: 'Q', suit: 'S' } }, { real: { id: 2, rank: 'Q', suit: 'H' } }, { real: { id: 3, rank: 'Q', suit: 'D' } }] }];
  app.emit({ type: 'state', state: table({ pets: { p1: 'cat', p2: 'cat' }, melds: queens, turn: 'p2' }) });
  assert.ok(chip('p2').querySelector('.pet').classList.contains('mood-happy'));
  assert.ok(doc.querySelector('#myPet > .pet').classList.contains('mood-idle'));

  // "Haustiere am Tisch" off: none is drawn, and the device remembers.
  const box = doc.getElementById('petsCheckbox');
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(atTable(), 0);
  assert.equal(app.window.localStorage.getItem('pikdame_pets'), 'off');
  assert.deepEqual(app.errors, []);
});

test('client: the options show the pet choice with its level and a preview; pets off from the start stays off', async (t) => {
  const app = boot({ pikdame_pets: 'off' });
  t.after(() => app.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const { doc } = app;
  const options = [...doc.getElementById('petSelect').options];
  assert.deepEqual(options.map((o) => o.value), ['none', 'cat']);
  assert.match(options[1].textContent, /Katze · ab Stufe 12/, 'locked for a fresh name, with the level it needs');
  assert.equal(options[1].disabled, true);
  assert.ok(doc.querySelector('#petPreview .pet.pet-cat'), 'something to look forward to');
  assert.equal(doc.getElementById('petsCheckbox').checked, false);
  app.emit({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' });
  app.emit({ type: 'state', state: table({ pets: { p2: 'cat' } }) });
  assert.equal(doc.querySelector('#opponents .pet'), null);
  assert.deepEqual(app.errors, []);
});
