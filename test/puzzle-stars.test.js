/** Daily puzzle stars: graded by tries per kind, kept per day for the archive,
 *  a perfect run over game days and the three-star badge family. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { starsFor, perfectStreakOn, STAR_TRIES } = require('../game/DailyPuzzle');
const { createPlayerStore } = require('../game/PlayerStore');
const { BADGE_FAMILIES, familyBadges } = require('../game/Badges');
const { addDays } = require('../game/GameDay');
const { makeStandardCard } = require('../game/Card');

const pub = path.join(__dirname, '..', 'public');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikstars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createPlayerStore(path.join(dir, 'players.json'));
}

/** Solves `date` after `misses` wrong checks. */
function solve(store, name, date, kind, misses = 0) {
  for (let i = 0; i < misses; i++) store.recordPuzzleAttempt(name, date, false, kind);
  return store.recordPuzzleAttempt(name, date, true, kind);
}

test('starsFor: three on the first try; two for a second (meld) or up to a third try (turn, out)', () => {
  const grid = (kind) => [0, 1, 2, 3, 4, 9].map((tries) => starsFor(kind, tries));
  assert.deepStrictEqual(grid('meld'), [0, 3, 2, 1, 1, 1]);
  assert.deepStrictEqual(grid('turn'), [0, 3, 2, 2, 1, 1]);
  assert.deepStrictEqual(grid('out'), [0, 3, 2, 2, 1, 1]);
  assert.strictEqual(starsFor('unknown', 2), 2, 'an unknown kind grades like a meld');
  // The client previews the stars still possible: its table must match.
  const src = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
  const m = src.match(/const PUZZLE_STAR_TRIES = (\{[^}]*\});/);
  assert.ok(m, 'client.js mirrors STAR_TRIES');
  assert.deepStrictEqual(JSON.parse(m[1].replace(/(\w+):/g, '"$1":')), STAR_TRIES);
});

test('PlayerStore: stars are stored with the solve, kept for the archive, never after a reveal', (t) => {
  const store = tempStore(t);
  assert.strictEqual(solve(store, 'Ann', '2026-10-20', 'meld').stars, 3);
  assert.strictEqual(solve(store, 'Ann', '2026-10-21', 'meld', 1).stars, 2);
  assert.strictEqual(solve(store, 'Ann', '2026-10-22', 'turn', 2).stars, 2);
  assert.strictEqual(solve(store, 'Ann', '2026-10-23', 'out', 3).stars, 1);
  assert.strictEqual(store.puzzleStatus('Ann', '2026-10-21').stars, 2, 'the day status carries the stars');
  assert.strictEqual(store.puzzleStarsFor('Ann', '2026-10-20'), 3);
  assert.strictEqual(store.puzzleStarsFor('Ann', '2026-10-24'), 0, 'unplayed day');
  assert.strictEqual(store.puzzleStarsFor('Nobody', '2026-10-20'), 0);
  // A second solve the same day changes nothing.
  assert.strictEqual(store.recordPuzzleAttempt('Ann', '2026-10-20', true, 'meld').stars, 3);

  store.revealPuzzle('Bo', '2026-10-20');
  const after = store.recordPuzzleAttempt('Bo', '2026-10-20', true, 'meld');
  assert.strictEqual(after.solved, true);
  assert.strictEqual(after.stars, undefined, 'a revealed solution earns no stars');
  assert.strictEqual(store.puzzleStarsFor('Bo', '2026-10-20'), 0);

  // The archive history is capped; the 7-day status window stays as it was.
  let day = '2026-08-01';
  for (let i = 0; i < 65; i++, day = addDays(day, 1)) solve(store, 'Cy', day, 'meld');
  const p = store.getPlayerByName('Cy');
  assert.strictEqual(Object.keys(p.puzzleStars).length, 60);
  assert.strictEqual(store.puzzleStarsFor('Cy', '2026-08-01'), 0, 'the oldest days drop out');
  assert.strictEqual(store.puzzleStarsFor('Cy', addDays('2026-08-01', 64)), 3);
  assert.strictEqual(Object.keys(p.puzzles).length, 7);
});

test('perfect run: consecutive game days, across the DST change and a month end; a gap or a weaker solve ends it', (t) => {
  const store = tempStore(t);
  const run = () => store.getPlayerByName('Dee').perfectPuzzleStreak;
  for (const d of ['2026-10-24', '2026-10-25', '2026-10-26']) solve(store, 'Dee', d, 'meld'); // DST ends on the 25th
  assert.strictEqual(run(), 3);
  solve(store, 'Dee', '2026-10-27', 'meld', 1);
  assert.strictEqual(run(), 0, 'two stars end the run at once');
  solve(store, 'Dee', '2026-10-28', 'meld');
  assert.strictEqual(run(), 1);
  solve(store, 'Dee', '2026-10-30', 'out'); // the 29th was skipped
  assert.strictEqual(run(), 1, 'a skipped day starts over');
  solve(store, 'Dee', '2026-10-31', 'turn');
  solve(store, 'Dee', '2026-11-01', 'meld');
  const p = store.getPlayerByName('Dee');
  assert.strictEqual(p.perfectPuzzleStreak, 3, 'the month end is just the next day');
  assert.strictEqual(p.bestPerfectPuzzleStreak, 3);
  assert.strictEqual(p.totalPerfectPuzzles, 7);

  assert.deepStrictEqual(perfectStreakOn(p, '2026-11-01'), { current: 3, best: 3 });
  assert.deepStrictEqual(perfectStreakOn(p, '2026-11-02'), { current: 3, best: 3 }, 'today is still open');
  assert.deepStrictEqual(perfectStreakOn(p, '2026-11-03'), { current: 0, best: 3 }, 'a whole day missed');
  assert.deepStrictEqual(perfectStreakOn(null, '2026-11-03'), { current: 0, best: 0 });

  store.revealPuzzle('Dee', '2026-11-02');
  assert.strictEqual(perfectStreakOn(store.getPlayerByName('Dee'), '2026-11-02').current, 0, 'a reveal ends today\'s chance at once');
});

test('badges: the three-star family has its tiers at 10, 30 and 100', () => {
  const fam = BADGE_FAMILIES.find((f) => f.id === 'puzzlePerfect');
  assert.deepStrictEqual(fam, { id: 'puzzlePerfect', field: 'totalPerfectPuzzles', tiers: [['puzzle_perfect_10', 10], ['puzzle_perfect_30', 30], ['puzzle_perfect_100', 100]] });
  const perfect = (n) => familyBadges({ totalPerfectPuzzles: n }).filter((id) => id.startsWith('puzzle_perfect'));
  assert.deepStrictEqual(perfect(9), []);
  assert.deepStrictEqual(perfect(30), ['puzzle_perfect_10', 'puzzle_perfect_30']);
  assert.deepStrictEqual(perfect(100), ['puzzle_perfect_10', 'puzzle_perfect_30', 'puzzle_perfect_100']);
});

// --- Client: the real markup and client in jsdom with a scripted socket ------
function boot() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
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
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const ws = sockets[sockets.length - 1];
  ws.fire('open');
  return { window, doc: window.document, ws, errors };
}

test('client: possible stars before the solve, earned stars and the run after it, the archive shows the day itself', (t) => {
  const { window, doc, ws, errors } = boot();
  t.after(() => window.close());
  const today = '2026-10-20';
  ws.fire('message', { type: 'profiles', players: [], publicMode: false, quests: { date: today, ids: [] } });
  const hand = ['5', '6', '7'].map((r) => makeStandardCard('H', r, 0));
  const puzzle = (over) => ({ type: 'puzzle', date: today, kind: 'meld', hand, targetPoints: 15, archive: false, today, epoch: '2026-09-26', status: { tries: 0, solved: false, revealed: false }, dayStars: 0, perfectStreak: { current: 0, best: 0 }, ...over });
  const row = () => doc.getElementById('puzzleStars');
  const lit = () => row().querySelectorAll('.puzzleStars .icon.on').length;

  doc.getElementById('puzzleBtn').click();
  ws.fire('message', puzzle());
  assert.ok(!row().classList.contains('hidden'));
  assert.ok(row().querySelector('.puzzleStars.possible'), 'before the solve the stars are only possible');
  assert.strictEqual(lit(), 3);
  assert.match(row().textContent, /möglich/);

  ws.fire('message', { type: 'puzzleResult', date: today, valid: true, solved: false, points: 10, targetPoints: 15, status: { tries: 1, solved: false, revealed: false } });
  assert.strictEqual(lit(), 2, 'a miss on a meld puzzle leaves two');

  ws.fire('message', { type: 'puzzleResult', date: today, valid: true, solved: true, points: 15, targetPoints: 15, xp: 30, status: { tries: 2, solved: true, revealed: false, stars: 2 }, perfectStreak: { current: 0, best: 4 } });
  assert.ok(!row().querySelector('.puzzleStars.possible'), 'earned, not possible');
  assert.strictEqual(lit(), 2);
  assert.match(row().textContent, /Gut gelöst/);
  assert.strictEqual(doc.querySelectorAll('#puzzleTileStatus .puzzleStars .icon.on').length, 2, 'the Today tile shows them too');
  assert.match(doc.getElementById('puzzleTileStatus').textContent, /Gelöst/);
  assert.strictEqual(doc.querySelector('#puzzleTileStatus .puzzleStars').getAttribute('aria-label'), '2 von 3 Sternen');

  ws.fire('message', puzzle({ status: { tries: 1, solved: true, revealed: false, stars: 3 }, dayStars: 3, perfectStreak: { current: 4, best: 4 } }));
  assert.strictEqual(lit(), 3);
  assert.match(row().textContent, /Perfekt/);
  assert.match(row().textContent, /4 Tage in Folge perfekt/);

  ws.fire('message', puzzle({ date: '2026-10-12', archive: true, dayStars: 3 }));
  assert.match(row().textContent, /am Tag selbst/);
  assert.strictEqual(lit(), 3);
  ws.fire('message', puzzle({ date: '2026-10-11', archive: true, dayStars: 0 }));
  assert.ok(row().classList.contains('hidden'), 'an archive day without stars shows none');

  // Public mode / no name: the server sends no dayStars - no stars at all.
  const { dayStars, ...noProfile } = puzzle();
  ws.fire('message', noProfile);
  assert.ok(row().classList.contains('hidden'));
  assert.deepStrictEqual(errors, []);
});
