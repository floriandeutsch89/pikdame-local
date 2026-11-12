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
  assert.match(html, /<span class="handLead"><button id="handToggleBtn"[\s\S]*?<\/button><span id="myPet"><\/span><\/span>/, 'its fallback home is beside the fold button');
  assert.match(html, /id="petsCheckbox"/, 'a new animation can be switched off');
  assert.match(html, /<span id="tablePet"><\/span>\s*<\/div>/, 'its first home is in the piles strip, out of the flow');
});

test('pet.js: markup only from the list, a safe collar colour and mood, the age as a negative delay', () => {
  assert.equal(Pet.html('dragon'), '');
  assert.equal(Pet.html('none'), '');
  const h = Pet.html('cat', { mood: 'cheer', collar: '#2a78d6', born: 1000, now: 13400 });
  assert.match(h, /^<span class="pet pet-cat pose-sit mood-cheer" style="--pet-collar:#2a78d6;--pet-t:-12\.40s"><svg /);
  const odd = Pet.html('cat', { mood: 'x" onclick="alert(1)', collar: 'red;background:url(x)' });
  assert.match(odd, /class="pet pet-cat pose-lie mood-idle" style="--pet-collar:#e8454f;/, 'unknown mood and colour fall back');
  assert.doesNotMatch(odd, /onclick|url\(/);
  for (const part of ['petSit', 'petLie', 'petTail', 'petEyes', 'petEyesShut', 'petEyesHappy', 'petYawn', 'petHeart', 'petZ', 'petCollar', 'petTag']) {
    assert.ok(Pet.CAT_SVG.includes(part), `the cat has its ${part}`);
  }
});

test('pet.js stroked: it purrs in the pose it has, whatever the mood', () => {
  for (const mood of Pet.MOODS) {
    const out = Pet.html('cat', { mood, petted: true });
    assert.match(out, new RegExp(`class="pet pet-cat pose-${Pet.poseOf(mood)} mood-${mood} petPetted"`));
    assert.doesNotMatch(Pet.html('cat', { mood }), /petPetted/);
  }
  assert.ok(Pet.PET_MS >= 1500 && Pet.PET_MS <= 4000);
});

test('pet.js pose: at rest and asleep it lies, everything else gets it up; getting up is marked once', () => {
  assert.deepEqual(Pet.MOODS.map((m) => [m, Pet.poseOf(m)]), [['idle', 'lie'], ['alert', 'sit'], ['sleep', 'lie'], ['happy', 'sit'], ['cheer', 'sit'], ['scared', 'sit'], ['yawn', 'sit']]);
  assert.match(Pet.html('cat', { mood: 'sleep' }), /class="pet pet-cat pose-lie mood-sleep"/);
  assert.match(Pet.html('cat', { mood: 'alert', rose: true }), /class="pet pet-cat pose-sit mood-alert petRose"/);
  assert.doesNotMatch(Pet.html('cat', { mood: 'idle', rose: true }), /petRose/, 'lying down again is no rise');
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

function boot(storage = {}, { account = '' } = {}) {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.requestAnimationFrame = () => 0;
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: !!account, username: account || undefined, accountsEnabled: !!account, version: '0.0.0-test' }), text: () => Promise.resolve('') });
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

test('client: only my own pet is drawn - lying at rest, up on my turn; a tap or a stroke makes it purr; the switch hides it', async (t) => {
  const app = boot();
  t.after(() => app.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const { doc } = app;
  app.emit({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' });
  // Not my turn: it lies. (jsdom has no layout, so the pet takes its fallback home in the tray's row.)
  app.emit({ type: 'state', state: table({ pets: { p1: 'cat', p2: 'cat', b1: 'cat' }, turn: 'p2' }) });
  const mine = () => doc.querySelector('#myPet > .pet.pet-cat, #tablePet > .pet.pet-cat');
  const atTable = () => doc.querySelectorAll('#table .pet').length;
  assert.equal(doc.querySelector('#opponents .pet'), null, 'the other seats\' pets stay away for now');
  assert.equal(atTable(), 1);
  assert.ok(mine().classList.contains('pose-lie') && mine().classList.contains('mood-idle'));
  assert.ok(!mine().classList.contains('petRose'));

  // Stroked while it lies: it purrs and stays lying. No toast, nothing is re-drawn under the finger.
  const lying = mine();
  lying.dispatchEvent(new app.window.Event('pointerdown', { bubbles: true }));
  assert.ok(mine() === lying && lying.classList.contains('petPetted') && lying.classList.contains('pose-lie'));
  assert.doesNotMatch(doc.getElementById('toastContainer').textContent, /Katze/);

  // My turn: it gets up, once with the little stretch.
  app.emit({ type: 'state', state: table({ pets: { p1: 'cat', p2: 'cat' }, turn: 'p1' }) });
  assert.ok(mine().classList.contains('pose-sit') && mine().classList.contains('mood-alert') && mine().classList.contains('petRose'));

  // Still purring after the re-draw; a finger running over it (pressed) keeps it going, a hovering mouse does not.
  assert.ok(mine().classList.contains('petPetted'), 'the purr survives a new mood');
  const realNow = app.window.Date.now;
  let ahead = Pet.PET_MS + 50;
  app.window.Date.now = () => realNow() + ahead;
  app.emit({ type: 'state', state: table({ pets: { p1: 'cat' }, turn: 'p1' }) });
  assert.ok(!mine().classList.contains('petPetted'), 'it runs out after the last stroke');
  const move = (init) => { const ev = new app.window.Event('pointermove', { bubbles: true }); Object.assign(ev, init); mine().dispatchEvent(ev); };
  move({ pointerType: 'mouse', buttons: 0 });
  assert.ok(!mine().classList.contains('petPetted'));
  move({ pointerType: 'touch', buttons: 0 });
  assert.ok(mine().classList.contains('petPetted'));
  ahead = (Pet.PET_MS + 50) * 2;
  app.emit({ type: 'state', state: table({ pets: { p1: 'cat' }, turn: 'p1' }) });
  mine().dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  assert.ok(mine().classList.contains('petPetted'), 'a plain click strokes too');
  app.window.Date.now = realNow;

  // I meld the Queen of Spades: hearts.
  const queens = [{ id: 'm1', ownerId: 'p1', type: 'set', rank: 'Q', slots: [{ real: { id: 1, rank: 'Q', suit: 'S' } }, { real: { id: 2, rank: 'Q', suit: 'H' } }, { real: { id: 3, rank: 'Q', suit: 'D' } }] }];
  app.emit({ type: 'state', state: table({ pets: { p1: 'cat' }, melds: queens, turn: 'p1' }) });
  assert.ok(mine().classList.contains('mood-happy'));

  // A seat without a pet of its own shows none, whatever the others have.
  app.emit({ type: 'state', state: table({ pets: { p2: 'cat' }, turn: 'p1' }) });
  assert.equal(atTable(), 0);
  app.emit({ type: 'state', state: table({ pets: { p1: 'cat' }, turn: 'p1' }) });
  assert.equal(atTable(), 1);

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
  app.emit({ type: 'state', state: table({ pets: { p1: 'cat' } }) });
  assert.equal(doc.querySelector('#table .pet'), null);
  assert.deepEqual(app.errors, []);
});

test('client: who already has the level and no pet hears of it once - a card that leads to the choice', async (t) => {
  const flo = (over = {}) => ({ name: 'Flo', gamesPlayed: 80, gamesWon: 30, xp: 4000, ...over });
  const start = (storage, profile, account = 'Flo') => {
    const app = boot({ pikdame_player_name: 'Flo', pikdame_account_token: 'tok', ...storage }, { account });
    t.after(() => app.window.close());
    return app;
  };
  const cards = (app) => [...app.doc.querySelectorAll('#unlockLayer .unlockCard:not(.leaving)')];
  const settle = () => new Promise((r) => setTimeout(r, 30));

  const app = start({});
  await settle();
  app.doc.getElementById('studioSplash')?.remove(); // a card waits out the intro
  app.emit({ type: 'profiles', players: [flo()] });
  await settle();
  assert.equal(cards(app).length, 1);
  const card = cards(app)[0];
  assert.ok(card.querySelector('.unlockArt .pet.pet-cat'), 'the cat itself is on the card');
  assert.match(card.textContent, /Neu ab Stufe 12/);
  assert.match(card.textContent, /Eine Katze wartet auf dich/);
  assert.equal(app.window.localStorage.getItem('pikdame_pet_news'), '1');
  // A tap leads to the choice.
  card.querySelector('.unlockMain').click();
  assert.ok(!app.doc.getElementById('settingsOverlay').classList.contains('hidden'));
  assert.equal(cards(app).length, 0);
  // Never twice, not on this page ...
  app.emit({ type: 'profiles', players: [flo()] });
  await settle();
  assert.equal(cards(app).length, 0);
  assert.deepEqual(app.errors, []);

  // Queued on the start screen but due at the table (joined right away): it waits, unsaid, for the start screen.
  const late = start({});
  await settle();
  late.emit({ type: 'profiles', players: [flo()] }); // the intro still plays: the card is queued, not shown
  late.emit({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' });
  late.emit({ type: 'state', state: { ...table({}), log: [{ text: 'Anna legt aus.' }] } }); // mid-round: no round quote holds the cards back
  late.doc.getElementById('studioSplash')?.remove();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(cards(late).length, 0);
  assert.equal(late.window.localStorage.getItem('pikdame_pet_news'), null, 'still to be said');
  assert.deepEqual(late.errors, []);

  // ... nor after a reload; not below the level, not with a pet, not without the account that may choose.
  for (const [storage, profile, account] of [
    [{ pikdame_pet_news: '1' }, flo(), 'Flo'],
    [{}, flo({ xp: 3000 }), 'Flo'],
    [{}, flo({ pet: 'cat' }), 'Flo'],
    [{}, flo(), ''],
  ]) {
    const other = start(storage, profile, account);
    await settle();
    other.doc.getElementById('studioSplash')?.remove();
    other.emit({ type: 'profiles', players: [profile] });
    await settle();
    assert.equal(cards(other).length, 0, JSON.stringify([storage, profile.xp, profile.pet, account]));
    assert.deepEqual(other.errors, []);
  }
});
