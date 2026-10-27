/** Multi-meld puzzles: "Auslegen" asks the server to check the laid meld.
 *  The check is pure rules - no try, star or attempt is recorded. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { testDatabaseUrl } = require('./helpers/test-db');
const WebSocket = require('ws');
const { JSDOM, VirtualConsole } = require('jsdom');
const { puzzleForDate, checkMeld, checkAnswer, ROTATION_START } = require('../game/DailyPuzzle');
const { gameDay, addDays } = require('../game/GameDay');
const { validateMeld } = require('../game/Rules');
const { freePort } = require('./helpers/free-port');

const ROOT = path.join(__dirname, '..');
const pub = path.join(ROOT, 'public');

/** Latest day (up to today) of the given kind whose best answer has 2+ melds. */
function multiMeldDay(kind) {
  const today = gameDay();
  for (let i = 0; i < 40; i++) {
    const date = addDays(today, -i);
    if (date < ROTATION_START) break;
    const p = puzzleForDate(date);
    if (p.kind === kind && p.best.melds && p.best.melds.length >= 2) return { date, puzzle: p };
  }
  throw new Error(`no ${kind} day with 2+ melds`);
}

/** A selection across two melds that the rules reject (a fixed pick can be legal, e.g. H9 D9 + D9). */
function mixedGroup(puzzle) {
  const card = (id) => puzzle.hand.find((c) => c.id === id);
  const [a, b] = puzzle.best.melds;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      for (const x of b) {
        const ids = [a[i], a[j], x];
        if (!validateMeld(ids.map(card)).valid) return ids;
      }
    }
  }
  throw new Error('no illegal mixed group');
}

test('checkMeld: valid group, rules reason, foreign and duplicate ids', () => {
  const { puzzle } = multiMeldDay('out');
  const good = puzzle.best.melds[0];
  const ok = checkMeld(puzzle, good);
  assert.deepStrictEqual(ok, { valid: true });
  assert.ok(!('type' in ok), 'spread into a WS message: no `type` key');
  const bad = checkMeld(puzzle, mixedGroup(puzzle));
  assert.strictEqual(bad.valid, false);
  assert.ok(bad.reason);
  assert.strictEqual(checkMeld(puzzle, [...good.slice(0, 2), 'nope']).valid, false);
  assert.strictEqual(checkMeld(puzzle, [good[0], good[0], good[1]]).valid, false);
  assert.strictEqual(checkMeld(puzzle, 'x').valid, false);
  // Same verdict as the final grading of that single group.
  assert.strictEqual(checkMeld(puzzle, mixedGroup(puzzle)).reason, checkAnswer(puzzle, [mixedGroup(puzzle)]).reason);
});

test('checkPuzzleMeld over the wire: reason without a counted try', async (t) => {
  const { date } = multiMeldDay('out');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-lay-'));
  const port = await freePort();
  const server = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('puzzle_lay'), PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_PUBLIC_MODE: '' }, stdio: 'ignore',
  });
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const ws = await new Promise((resolve, reject) => {
    const attempt = (n) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`);
      s.inbox = [];
      s.on('message', (raw) => s.inbox.push(JSON.parse(raw)));
      s.once('open', () => resolve(s));
      s.once('error', () => (n > 100 ? reject(new Error('server did not come up')) : setTimeout(() => attempt(n + 1), 100)));
    };
    attempt(0);
  });
  t.after(() => ws.close());
  const ask = async (msg, type) => {
    const before = ws.inbox.length;
    ws.send(JSON.stringify(msg));
    for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
      const hit = ws.inbox.slice(before).find((m) => m.type === type);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no ${type}`);
  };
  const today = gameDay();
  // Today's profile is the one that stores tries; check against the live day when it is multi-meld, else the archive date.
  const live = puzzleForDate(today).kind !== 'meld' ? today : date;
  const livePuzzle = puzzleForDate(live);
  const group = livePuzzle.best.melds[0];
  const mixed = mixedGroup(livePuzzle);
  const before = (await ask({ type: 'getPuzzle', name: 'Lena', date: live }, 'puzzle')).status;

  const good = await ask({ type: 'checkPuzzleMeld', name: 'Lena', date: live, cardIds: group }, 'puzzleMeldCheck');
  assert.deepStrictEqual({ valid: good.valid, date: good.date }, { valid: true, date: live });
  const bad = await ask({ type: 'checkPuzzleMeld', name: 'Lena', date: live, cardIds: mixed }, 'puzzleMeldCheck');
  assert.strictEqual(bad.valid, false);
  assert.ok(bad.reason);
  const foreign = await ask({ type: 'checkPuzzleMeld', name: 'Lena', date: live, cardIds: [group[0], group[1], 'zz-1'] }, 'puzzleMeldCheck');
  assert.strictEqual(foreign.valid, false);
  const junk = await ask({ type: 'checkPuzzleMeld', name: 'Lena', date: live, cardIds: 'x' }, 'puzzleMeldCheck');
  assert.strictEqual(junk.valid, false);

  const after = (await ask({ type: 'getPuzzle', name: 'Lena', date: live }, 'puzzle')).status;
  assert.deepStrictEqual(after, before, 'no try, no solve recorded');
  assert.strictEqual(after.tries, 0);
});

// --- client (jsdom) -------------------------------------------------------

function bootClient(date, puzzle) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  const sent = [];
  let socket = null;
  window.WebSocket = class {
    constructor() { this.readyState = 1; this.l = {}; socket = this; }
    addEventListener(ev, fn) { (this.l[ev] = this.l[ev] || []).push(fn); }
    removeEventListener() {}
    send(raw) { sent.push(JSON.parse(raw)); }
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.WebSocket.CONNECTING = 0;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Ada');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const emit = (msg) => (socket.l.message || []).forEach((fn) => fn({ data: JSON.stringify(msg) }));
  const doc = window.document;
  (socket.l.open || []).forEach((fn) => fn({}));
  emit({
    type: 'puzzle', date, kind: puzzle.kind, hand: puzzle.hand, targetPoints: 0, archive: false, today: date, epoch: date, status: { tries: 0, solved: false, revealed: false },
  });
  return { window, doc, sent, emit, errors };
}

test('client: an invalid lay is refused with the rule reason and keeps the selection; a valid one is laid', () => {
  const { date, puzzle } = multiMeldDay('out');
  const c = bootClient(date, puzzle);
  const hand = c.doc.getElementById('puzzleHand');
  assert.strictEqual(hand.children.length, puzzle.hand.length);
  const pick = (list) => list.forEach((id) => hand.querySelector(`[data-card-id="${id}"]`).click());
  const lay = c.doc.getElementById('puzzleLayBtn');
  const groups = () => c.doc.querySelectorAll('#puzzleMelds .puzzleMeld').length;

  const mixed = mixedGroup(puzzle);
  pick(mixed);
  lay.click();
  const req = c.sent.filter((m) => m.type === 'checkPuzzleMeld');
  assert.strictEqual(req.length, 1);
  assert.deepStrictEqual({ date: req[0].date, ids: [...req[0].cardIds].sort() }, { date, ids: [...mixed].sort() });
  const before = groups();
  c.emit({ type: 'puzzleMeldCheck', date, valid: false, reason: 'Alle echten Karten in der Folge müssen dieselbe Farbe haben.' });
  const status = c.doc.getElementById('puzzleStatus');
  assert.match(status.textContent, /Alle echten Karten in der Folge müssen dieselbe Farbe haben\./);
  assert.ok(status.classList.contains('bad'));
  assert.strictEqual(groups(), before, 'no group added');
  assert.ok(c.doc.getElementById('puzzleCheckBtn').disabled, 'still nothing to submit');
  assert.strictEqual(hand.querySelectorAll('.selected').length, mixed.length, 'selection kept');
  assert.strictEqual(c.sent.filter((m) => m.type === 'solvePuzzle').length, 0, 'no try sent');

  // Valid: deselect the mixed cards, pick a real meld, lay it.
  pick(mixed);
  const good = puzzle.best.melds[0];
  pick(good);
  lay.click();
  assert.strictEqual(c.sent.filter((m) => m.type === 'checkPuzzleMeld').length, 2);
  c.emit({ type: 'puzzleMeldCheck', date, valid: true });
  assert.strictEqual(c.doc.getElementById('puzzleCheckBtn').disabled, false, 'a laid group can be submitted');
  assert.strictEqual(c.doc.getElementById('puzzleStatus').textContent, '');
  assert.deepStrictEqual(c.errors, []);
  c.window.close();
});
