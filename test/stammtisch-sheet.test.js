/** Start-screen Stammtisch chips: the chip names who leads the overall record
 *  (not the best-of-3 series), a tap opens the record sheet, "Platz nehmen"
 *  joins. Boots the REAL markup and client in jsdom with a scripted WebSocket. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot(storage = {}) {
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
  window.localStorage.setItem('pikdame_stammtische', JSON.stringify([{ code: 'STHOME', name: 'Familie' }]));
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const ws = sockets[sockets.length - 1];
  ws.fire('open');
  const doc = window.document;
  const sent = (type) => ws.sent.filter((m) => m.type === type);
  const shown = (id) => !doc.getElementById(id).classList.contains('hidden');
  const chipText = () => doc.querySelector('#stammtischRecent button[data-code="STHOME"] .stChipInfo').textContent;
  const info = (over) => ws.fire('message', {
    type: 'stammtischInfo', exists: true, code: 'STHOME', name: 'Familie', gamesPlayed: 20,
    series: { no: 4, games: 1, wins: { flo: 1 }, bestOf: 3, needed: 2 }, pairwise: {},
    members: [{ name: 'Flo', wins: 12, games: 20, avg: 310 }, { name: 'Anna', wins: 8, games: 20, avg: 260 }],
    ...over,
  });
  return { window, doc, ws, sent, shown, chipText, info, errors };
}

test('the chip names who leads the record, never the series as "Serie 2:1"', () => {
  const t = boot();
  assert.strictEqual(t.sent('getStammtisch')[0].code, 'STHOME', 'asked for without a tap');
  t.info();
  assert.strictEqual(t.chipText(), 'Flo führt · 12 Siege');
  t.info({ members: [{ name: 'Flo', wins: 12, games: 20, avg: 310 }, { name: 'Anna', wins: 12, games: 20, avg: 300 }] });
  assert.strictEqual(t.chipText(), 'Gleichstand · je 12 Siege');
  t.info({ gamesPlayed: 0, members: [{ name: 'Flo', wins: 0, games: 0, avg: 0 }] });
  assert.strictEqual(t.chipText(), 'Noch keine Partie');
  t.info({ gamesPlayed: 1, members: [{ name: 'Flo', wins: 1, games: 1, avg: 900 }, { name: 'Anna', wins: 0, games: 0, avg: 0 }] });
  assert.strictEqual(t.chipText(), 'Flo · 1 Sieg', 'alone in the record: nobody to lead');
  t.info({ gamesPlayed: 3, members: [{ name: 'Flo', wins: 0, games: 3, avg: 200 }] });
  assert.strictEqual(t.chipText(), '3 Partien', 'only bots won so far');
  assert.doesNotMatch(t.doc.getElementById('stammtischRecent').textContent, /Serie/);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();

  const en = boot({ pikdame_lang: 'en' });
  en.info();
  assert.strictEqual(en.chipText(), 'Flo leads · 12 wins');
  en.window.close();
});

test('a tap opens the record sheet instead of joining; "Platz nehmen" joins', () => {
  const t = boot();
  t.info({
    members: [
      { name: 'Flo', wins: 12, games: 20, avg: 310 }, { name: 'Anna', wins: 8, games: 20, avg: 260 },
      { name: 'Uli', wins: 5, games: 15, avg: 240 }, { name: 'Bea', wins: 1, games: 9, avg: 180 },
    ],
    pairwise: {
      flo: { anna: { ahead: 11, behind: 9 }, uli: { ahead: 9, behind: 6 }, bea: { ahead: 8, behind: 1 } },
      anna: { flo: { ahead: 9, behind: 11 }, uli: { ahead: 7, behind: 7 }, bea: { ahead: 5, behind: 4 } },
      uli: { flo: { ahead: 6, behind: 9 }, anna: { ahead: 7, behind: 7 }, bea: { ahead: 3, behind: 6 } },
      bea: { flo: { ahead: 1, behind: 8 }, anna: { ahead: 4, behind: 5 }, uli: { ahead: 6, behind: 3 } },
    },
  });
  t.ws.sent.length = 0;
  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  assert.ok(t.shown('stammtischSheetOverlay'));
  assert.strictEqual(t.sent('joinSession').length, 0, 'no join behind the sheet');
  assert.strictEqual(t.sent('getStammtisch')[0].code, 'STHOME', 'fresh standings on open');
  assert.strictEqual(t.doc.getElementById('stammtischSheetName').textContent, 'Familie');
  assert.strictEqual(t.doc.getElementById('stammtischSheetMeta').textContent, 'Code STHOME · 20 Partien');
  const body = t.doc.getElementById('stammtischSheetBody');
  assert.deepStrictEqual([...body.querySelectorAll('.stTable tbody tr')].map((r) => r.firstChild.textContent), ['Flo', 'Anna', 'Uli', 'Bea']);
  assert.match(body.querySelector('.stSeries').textContent, /Serie 4 · Best of 3: Flo 1/);
  // Closest records first, at most three of the six pairs.
  assert.strictEqual(body.querySelector('.stPairs').textContent,
    'Direktvergleich: Anna 7:7 Uli · Anna 5:4 Bea · Flo 11:9 Anna');

  t.doc.getElementById('stammtischSheetJoinBtn').click();
  assert.ok(!t.shown('stammtischSheetOverlay'));
  const join = t.sent('joinSession')[0];
  assert.strictEqual(join.code, 'STHOME');
  assert.strictEqual(join.name, 'Ben');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('the sheet closes by button or a tap outside, waits for data, and goes when the table is gone', () => {
  const t = boot();
  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  assert.match(t.doc.getElementById('stammtischSheetBody').textContent, /Bilanz wird geladen/);
  t.info({ series: { no: 2, games: 3, wins: { anna: 2, flo: 1 }, bestOf: 3, needed: 2, winner: 'Anna' } });
  assert.ok(t.doc.querySelector('#stammtischSheetBody .stSeries svg use'), 'a sprite trophy, no emoji');
  assert.doesNotMatch(t.doc.getElementById('stammtischSheetBody').textContent, /🏆/);
  t.doc.getElementById('stammtischSheetCloseBtn').click();
  assert.ok(!t.shown('stammtischSheetOverlay'));

  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  const overlay = t.doc.getElementById('stammtischSheetOverlay');
  overlay.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true }));
  assert.ok(!t.shown('stammtischSheetOverlay'), 'tap outside closes');

  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  t.ws.fire('message', { type: 'stammtischInfo', exists: false, code: 'STHOME' });
  assert.ok(!t.shown('stammtischSheetOverlay'), 'a deleted table closes its sheet');
  assert.strictEqual(t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]'), null);
  assert.strictEqual(t.sent('joinSession').length, 0);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('the sheet shows the group goals: level, this week and the streak of reached weeks', () => {
  const t = boot();
  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  const week = (games, reached) => ({ start: '2026-10-12', games, goal: 5, reached });
  t.info({ goals: { level: 3, into: 20, need: 100, xp: 145, week: week(3, false), streak: 2, weeksReached: 5 } });
  const body = t.doc.getElementById('stammtischSheetBody');
  const goals = body.querySelector('.stGoals');
  assert.ok(goals, 'goals sit in the sheet');
  assert.strictEqual(body.firstElementChild, goals, 'above the series and the table');
  assert.match(goals.querySelector('.stGoalLevel').textContent, /^Stufe 3\s*20\/100 Punkte$/);
  assert.match(goals.querySelector('.stGoalWeek').textContent, /3\/5 Partien diese Woche\s*2 Wochen in Folge · 5× geschafft/);
  const bar = goals.querySelector('.stWeekBar');
  assert.deepStrictEqual([bar.getAttribute('role'), bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')], ['progressbar', '3', '5']);
  assert.strictEqual(bar.firstElementChild.style.width, '60%');
  assert.ok(goals.querySelector('use[href="#i-target"]'), 'sprite icons, no emoji');

  t.info({ goals: { level: 3, into: 40, need: 100, xp: 165, week: week(6, true), streak: 1, weeksReached: 1 } });
  const reached = t.doc.querySelector('#stammtischSheetBody .stGoalWeek');
  assert.ok(reached.classList.contains('reached'));
  assert.match(reached.textContent, /Wochenziel geschafft · 6\/5\s*1× geschafft/);
  assert.doesNotMatch(reached.textContent, /in Folge/, 'a streak of one week is not a streak yet');
  assert.ok(reached.querySelector('use[href="#i-check"]'));
  assert.strictEqual(reached.querySelector('.stWeekBar i').style.width, '100%', 'the bar never runs over');

  // Without goals (an older server) the sheet simply has none.
  t.info({ goals: undefined });
  assert.strictEqual(t.doc.querySelector('#stammtischSheetBody .stGoals'), null);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('the sheet lists the newest matches: a team match with its tag, both pairs and the totals, the note on what it counts for', () => {
  const t = boot();
  t.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  t.info();
  const body = t.doc.getElementById('stammtischSheetBody');
  assert.strictEqual(body.querySelector('.stGames'), null, 'an older server without matches: no list');
  assert.strictEqual(body.querySelector('.stTeamNote'), null);
  t.info({
    teamGames: 1, today: '2026-10-24',
    recent: [
      { day: '2026-10-24', teamMode: true, teamNames: ['Die Löwen', null], players: [
        { name: 'Flo', isBot: false, score: 1150, won: true, team: 0 }, { name: 'Anna', isBot: false, score: 960, won: false, team: 1 },
        { name: 'Ben', isBot: false, score: 930, won: true, team: 0 }, { name: 'Inge', isBot: true, score: 950, won: false, team: 1 }] },
      { day: '2026-10-23', players: [{ name: 'Anna', isBot: false, score: 760, won: false }, { name: 'Flo', isBot: false, score: 1040, won: true },
        { name: 'Uwe', isBot: true, score: 905, won: false }] },
      { day: '2026-10-17', teamMode: true, teamNames: [null, null], players: [
        { name: 'Flo', isBot: false, score: 800, won: false, team: 0 }, { name: 'Anna', isBot: false, score: 1100, won: true, team: 1 },
        { name: 'Ben', isBot: false, score: 900, won: false, team: 0 }, { name: 'Inge', isBot: true, score: 1000, won: true, team: 1 }] },
    ],
  });
  assert.strictEqual(body.querySelector('.stTeamNote').textContent,
    '„2 gegen 2“ zählt für Partien und Wochenziel, nicht für Siege, Serie und Direktvergleich.');
  assert.strictEqual(body.querySelector('.stGames h3').textContent, 'Letzte Partien');
  const rows = [...body.querySelectorAll('.stGames li')];
  const cell = (li, cls) => li.querySelector(`.${cls}`).textContent.replace(/\s+/g, ' ').trim();
  assert.deepStrictEqual(rows.map((li) => cell(li, 'stGameDay')), ['Heute', 'Gestern', 'Sa., 17.10.'], 'by the server\'s game day');
  // Today's team match: the tag, the winning team (named: its pair too) over the other pair, both totals.
  assert.strictEqual(cell(rows[0], 'stGameKind'), '2 gegen 2');
  assert.strictEqual(cell(rows[0], 'stGameWin'), 'Team Die Löwen Flo & Ben');
  assert.ok(rows[0].querySelector('.stGameWin use[href="#i-trophy"]'), 'the winners carry the trophy (a sprite, no emoji)');
  assert.strictEqual(cell(rows[0], 'stGameRest'), 'gegen Anna & Inge (Bot)');
  assert.deepStrictEqual([...rows[0].querySelectorAll('.stGameScore')].map((s) => s.textContent), ['2.080', '1.910']);
  // A solo match: the winner first, the rest by score.
  assert.strictEqual(cell(rows[1], 'stGameKind'), '');
  assert.strictEqual(cell(rows[1], 'stGameWin'), 'Flo');
  assert.strictEqual(cell(rows[1], 'stGameRest'), 'Uwe (Bot) 905 · Anna 760');
  assert.deepStrictEqual([...rows[1].querySelectorAll('.stGameScore')].map((s) => s.textContent), ['1.040', '']);
  // Team B won, neither team named: the winning pair first.
  assert.strictEqual(cell(rows[2], 'stGameWin'), 'Anna & Inge (Bot)');
  assert.strictEqual(cell(rows[2], 'stGameRest'), 'gegen Flo & Ben');
  assert.deepStrictEqual([...rows[2].querySelectorAll('.stGameScore')].map((s) => s.textContent), ['2.100', '1.700']);
  // Head to head and series stay as they are.
  assert.match(body.querySelector('.stSeries').textContent, /Serie 4 · Best of 3/);
  assert.ok(t.doc.querySelector('#stammtischSheetOverlay .stammtischSheetFoot #stammtischSheetJoinBtn'), 'the buttons sit in the pinned foot');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();

  const en = boot({ pikdame_lang: 'en' });
  en.doc.querySelector('#stammtischRecent button[data-code="STHOME"]').click();
  en.info({ teamGames: 1, today: '2026-10-24', recent: [{ day: '2026-10-23', teamMode: true, teamNames: [null, 'Kaffeeklatsch'], players: [
    { name: 'Flo', isBot: false, score: 800, won: false, team: 0 }, { name: 'Anna', isBot: false, score: 1100, won: true, team: 1 },
    { name: 'Ben', isBot: false, score: 900, won: false, team: 0 }, { name: 'Inge', isBot: true, score: 1000, won: true, team: 1 }] }] });
  const li = en.doc.querySelector('#stammtischSheetBody .stGames li');
  assert.deepStrictEqual(['stGameDay', 'stGameKind', 'stGameWin', 'stGameRest'].map((c) => li.querySelector(`.${c}`).textContent.replace(/\s+/g, ' ').trim()),
    ['Yesterday', '2 vs 2', 'Team Kaffeeklatsch Anna & Inge (Bot)', 'vs Flo & Ben']);
  assert.match(en.doc.querySelector('#stammtischSheetBody .stTeamNote').textContent, /^"2 vs 2" counts toward games and the weekly goal/);
  en.window.close();
});

test('a match that reaches the weekly goal or a new level says so in one toast, with the series', () => {
  const t = boot();
  t.ws.fire('message', {
    type: 'stammtisch',
    summary: { code: 'STHOME', name: 'Familie', gamesPlayed: 21, members: [], pairwise: {}, series: { no: 2, games: 2, wins: { anna: 2 }, bestOf: 3, needed: 2, winner: 'Anna' } },
    seriesEvent: { type: 'won', winner: 'Anna', no: 2 },
    goalEvents: [{ type: 'week', streak: 3, goal: 5 }, { type: 'level', level: 4 }],
  });
  assert.strictEqual(t.doc.getElementById('toastContainer').textContent,
    '🏆 Anna gewinnt die Serie 2:0! · Wochenziel geschafft – 3 Wochen in Folge! · Stammtisch-Stufe 4 erreicht!');
  t.ws.fire('message', { type: 'stammtisch', summary: null, seriesEvent: null, goalEvents: [{ type: 'week', streak: 1, goal: 5 }] });
  assert.strictEqual(t.doc.getElementById('toastContainer').textContent, 'Wochenziel geschafft: 5 Partien diese Woche!');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});
