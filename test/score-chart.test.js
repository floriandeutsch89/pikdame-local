// The score chart draws itself on the game-over sheet (public/score-chart.js + client.js):
// lead changes from the plotted totals, every line's head through the rounds at one pace,
// once per sheet, joined by a re-render, never at round end or in "Meine Partien".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const Chart = require('../public/score-chart.js');

const pub = path.join(__dirname, '..', 'public');
const h = (round, totals) => ({ round, totals });

test('lead changes: the round a new seat leads alone, the first leader is none', () => {
  const series = [
    h(1, { a: 120, b: 60, c: -20 }), // a leads: took it from nobody
    h(2, { a: 250, b: 330, c: 90 }), // b
    h(3, { a: 300, b: 520, c: 200 }),
    h(4, { a: 610, b: 580, c: 380 }), // a
    h(5, { a: 800, b: 760, c: 500 }),
    h(6, { a: 880, b: 1045, c: 610 }), // b, in the last round
  ];
  assert.deepEqual(Chart.leadChanges(series, ['a', 'b', 'c']), [{ index: 1, id: 'b' }, { index: 3, id: 'a' }, { index: 5, id: 'b' }]);
  assert.deepEqual(Chart.leadChanges(series.slice(0, 1), ['a', 'b', 'c']), []);
  assert.deepEqual(Chart.leadChanges([], ['a', 'b']), []);
  assert.deepEqual(Chart.leadChanges(series, []), []);
});

test('lead changes: a tie at the top leaves the lead where it was', () => {
  const ids = ['a', 'b', 'c'];
  // b draws level and falls back: a never lost the lead.
  assert.deepEqual(Chart.leadChanges([h(1, { a: 100, b: 50 }), h(2, { a: 200, b: 200 }), h(3, { a: 300, b: 250 })], ids), []);
  // b draws level, then leads alone: the change is the round b is alone at the top.
  assert.deepEqual(Chart.leadChanges([h(1, { a: 100, b: 50 }), h(2, { a: 200, b: 200 }), h(3, { a: 250, b: 300 })], ids), [{ index: 2, id: 'b' }]);
  // Level after round 1: the first seat alone at the top is the first leader, no change.
  assert.deepEqual(Chart.leadChanges([h(1, { a: 100, b: 100 }), h(2, { a: 100, b: 180 }), h(3, { a: 400, b: 200 })], ids), [{ index: 2, id: 'a' }]);
  // b and c pass a together: nobody leads alone until c does.
  assert.deepEqual(Chart.leadChanges([h(1, { a: 100 }), h(2, { a: 100, b: 150, c: 150 }), h(3, { a: 100, b: 150, c: 260 })], ids), [{ index: 2, id: 'c' }]);
  // Missing totals count as 0, like the chart plots them; everybody below zero: the least minus leads.
  assert.deepEqual(Chart.leadChanges([h(1, { a: -40, b: -10 }), h(2, { a: -20, b: -90 })], ['a', 'b']), [{ index: 1, id: 'a' }]);
});

test('head frames: one keyframe per round, evenly spaced, ending where the dot stands', () => {
  const f = Chart.headFrames([[0, 0], [30, 40], [60, 40], [90, 0]]);
  assert.deepEqual(f.map((k) => k.offset), [0, 1 / 3, 2 / 3, 1]);
  assert.deepEqual(f.map((k) => k.transform), ['translate(-90px, 0px)', 'translate(-60px, 40px)', 'translate(-30px, 40px)', 'translate(0px, 0px)']);
});

test('cover: as wide as the plot, anchored at its right edge, with the grid it hides', () => {
  const html = Chart.coverMarkup({ x0: 34, x1: 228, top: 0, bottom: 132 }, ['130', '99.5'], '8');
  assert.match(html, /^<g class="revealCoverBody"><rect x="-194" y="0" width="194" height="132"\/>/, 'the body reaches from the first round to the anchor');
  assert.equal(html.match(/class="gridLine" x1="-194" [^>]*x2="0"/g).length, 2, 'the grid lines travel with the body');
  assert.match(html, /<\/g><rect x="-1" y="0" width="5" height="132"\/><line class="goalLine" x1="-194" y1="8" x2="0" y2="8"\/>$/, 'cap strip (overlapping the body) and goal line lie still');
  assert.doesNotMatch(Chart.coverMarkup({ x0: 34, x1: 228, top: 0, bottom: 132 }, [], null), /goalLine/);
});

test('timing: the lines take 1 to 1.5 s, a round is reached in proportion', () => {
  assert.ok(Chart.DRAW_MS >= 1000 && Chart.DRAW_MS <= 1500);
  assert.equal(Chart.arrivalMs(0, 6), Chart.DELAY_MS);
  assert.equal(Chart.arrivalMs(5, 6), Chart.DELAY_MS + Chart.DRAW_MS);
  assert.equal(Chart.arrivalMs(2, 5), Chart.DELAY_MS + Chart.DRAW_MS / 2);
  assert.ok(Chart.POP_R < 8, 'a pop in the last round stays left of the end labels (8 units away)');
});

// --- The real client in jsdom, Web Animations stubbed -----------------------
function boot({ reduced = false, storage = {}, observer = false } = {}) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  const clock = { t: 5000 };
  window.performance.now = () => clock.t;
  window.matchMedia = (q) => ({ matches: reduced && /prefers-reduced-motion: reduce/.test(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.requestAnimationFrame = () => 0;
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.0.0-test' }), text: () => Promise.resolve('') });
  window.AudioContext = function () {
    return {
      createOscillator: () => ({ connect: (x) => x, start() {}, stop() {}, type: 'sine', frequency: { setValueAtTime() {}, value: 0 } }),
      createGain: () => ({ connect: (x) => x, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }),
      destination: { connect: (x) => x }, currentTime: 0, state: 'running',
      resume: () => Promise.resolve(), suspend: () => Promise.resolve(),
    };
  };
  window.webkitAudioContext = window.AudioContext;
  const anims = [];
  window.Element.prototype.animate = function animateStub(frames, opts) {
    const a = { el: this, frames, opts, currentTime: null, state: 'running', onfinish: null,
      pause() { this.state = 'paused'; }, play() { this.state = 'running'; },
      finish() { this.state = 'finished'; if (this.onfinish) this.onfinish(); }, cancel() { this.state = 'idle'; } };
    anims.push(a);
    return a;
  };
  const observers = [];
  if (observer) {
    window.IntersectionObserver = class {
      constructor(cb, opts) { this.cb = cb; this.opts = opts; this.live = true; observers.push(this); }
      observe(node) { this.node = node; }
      disconnect() { this.live = false; }
      see() { this.cb([{ isIntersecting: true, target: this.node }]); }
    };
  }
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
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const src of ['i18n.js', 'score-chart.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return { window, doc: window.document, errors, anims, clock, observers, ws: () => ws };
}

const mk = (score, win) => ({ roundScore: score, breakdown: { isWinner: !!win, multiplier: 1 } });
const PLAYERS = [
  { id: 'p1', name: 'Flo', isBot: false, connected: true, handCount: 9, hand: [] },
  { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 0, botDifficulty: 'zen' },
  { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 4, botDifficulty: 'zen' },
];
// Flo leads, Klaus takes over in round 2, Flo in round 3, Klaus in the last one.
const HISTORY = [
  h(1, { p1: 120, b1: 60, b2: -20 }), h(2, { p1: 250, b1: 330, b2: 90 }),
  h(3, { p1: 610, b1: 580, b2: 380 }), h(4, { p1: 880, b1: 1045, b2: 610 }),
];
const BASE = {
  roundNumber: 4, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1', discardTop: null, drawPileCount: 30, discardPileCount: 3,
  log: [], tableMelds: [], lobbyReady: [], nextRoundReady: [], houseRules: {}, players: PLAYERS, lastRoundWinnerId: 'b1',
  totals: HISTORY[3].totals, scoreHistory: HISTORY, lastRoundStats: [{ id: 'p1', name: 'Flo', laidOutCount: 3, handCount: 9 }],
  lastRoundResult: { p1: mk(270), b1: mk(465, true), b2: mk(230) },
};
const GAME_OVER = { ...BASE, phase: 'gameOver', gameOverInfo: { winnerId: 'b1', totalTurns: 90, totalRounds: 4, highlights: [] } };
const ROUND_END = { ...BASE, phase: 'roundEnd' };
const PROGRESS = { type: 'progress', gainedXp: 120, xp: 500, level: { level: 4 }, record: { played: 43, won: 17 } };

async function setup(t, opts) {
  const c = boot(opts);
  t.after(() => c.window.close());
  await new Promise((r) => setTimeout(r, 10));
  const msg = (m) => c.ws()._emit('message', { data: JSON.stringify(m) });
  msg({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'ABCD' });
  return { ...c, msg, feed: (state) => msg({ type: 'state', state }) };
}
/** The animations of the chart that is on the sheet now, by what they move. */
function onSheet(c) {
  const svg = c.doc.querySelector('#resultBody .scoreChartSvg');
  const live = c.anims.filter((a) => svg && svg.contains(a.el));
  return {
    svg, live,
    covers: live.filter((a) => a.el.classList.contains('revealCoverBody')),
    heads: live.filter((a) => a.el.classList.contains('endDot')),
    labels: live.filter((a) => a.el.classList.contains('endLabel')),
    pops: [...(svg ? svg.querySelectorAll('.leadPop') : [])],
  };
}

test('game over: every line, head and label is animated, the lead changes pop in their seat\'s colour', async (t) => {
  const c = await setup(t);
  c.feed(GAME_OVER);
  const s = onSheet(c);
  assert.equal(s.covers.length, 1);
  assert.equal(s.heads.length, 3);
  assert.equal(s.labels.length, 3);
  // One clock for the cover's edge and the heads: linear, same start, same length.
  assert.ok([...s.covers, ...s.heads].every((a) => a.opts.duration === Chart.DRAW_MS && a.opts.delay === Chart.DELAY_MS && a.opts.easing === 'linear'));
  assert.deepEqual(s.covers[0].frames.map((k) => k.transform), ['scaleX(1)', 'scaleX(0)']);
  assert.equal(s.covers[0].opts.fill, 'both', 'the cover never falls back over the chart');
  assert.ok(s.heads.every((a) => a.frames.length === 4));
  // The cover lies over every line and under every dot, exactly as wide as the rounds.
  const kids = [...s.svg.children];
  const cover = s.svg.querySelector('.revealCover');
  const lines = [...s.svg.querySelectorAll(':scope > polyline')];
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => kids.indexOf(l) < kids.indexOf(cover)));
  assert.ok([...s.svg.querySelectorAll('.endDot')].every((d) => kids.indexOf(d) > kids.indexOf(cover)));
  const xs = lines[0].getAttribute('points').split(' ').map((pt) => Number(pt.split(',')[0]));
  assert.equal(cover.getAttribute('transform'), `translate(${xs[3]} 0)`);
  assert.equal(Number(cover.querySelector('.revealCoverBody rect').getAttribute('width')), xs[3] - xs[0]);
  assert.equal(cover.querySelectorAll('.revealCoverBody .gridLine').length, s.svg.querySelectorAll(':scope > .gridLine').length);
  // One goal line at a time: the cover's own shows while the chart's is hidden, for the same span.
  const goal = s.live.find((a) => a.el.classList.contains('goalLine'));
  assert.equal(goal.el.parentNode, s.svg);
  assert.deepEqual([goal.frames.map((k) => k.opacity), goal.opts.duration, goal.opts.delay, goal.opts.fill], [[0, 0], Chart.DRAW_MS, Chart.DELAY_MS, 'backwards']);
  assert.equal(cover.querySelectorAll(':scope > .goalLine').length, 1);
  // Battery: nothing but transform and opacity is animated (CLAUDE.md 2c).
  for (const a of s.live) for (const k of a.frames) assert.deepEqual(Object.keys(k).filter((key) => !['transform', 'opacity', 'offset'].includes(key)), []);
  assert.ok(s.labels.every((a) => a.opts.delay >= Chart.DELAY_MS + Chart.DRAW_MS), 'the labels wait for their lines');
  assert.ok(s.live.every((a) => a.currentTime === 0 && a.state === 'running'));
  // Seat colours: Flo (seat 0) blue, Klaus (seat 1) orange.
  const colours = s.pops.map((g) => g.querySelector('.leadPopDot').getAttribute('fill'));
  assert.deepEqual(colours, ['#eb6834', '#2a78d6', '#eb6834']);
  const delays = s.live.filter((a) => a.el.classList.contains('leadPopDot')).map((a) => a.opts.delay);
  assert.deepEqual(delays, [1, 2, 3].map((i) => Chart.arrivalMs(i, 4)), 'each pops as the heads pass its round');
  // The pop sits on the new leader's line at that round: the same point the polyline has there.
  const klaus = lines.find((l) => l.getAttribute('stroke') === '#eb6834');
  assert.equal(s.pops[0].getAttribute('transform'), `translate(${klaus.getAttribute('points').split(' ')[1].replace(',', ' ')})`);
  // The chart itself is the finished one: nothing waits for the reveal.
  assert.equal(s.svg.querySelectorAll('.endLabel').length, 3);
  assert.ok(!c.doc.getElementById('resultContinueBtn').disabled);
  assert.deepEqual(c.errors, []);
});

test('once per sheet: a re-render joins by the clock, the tabs change nothing, a finished one stays finished', async (t) => {
  const c = await setup(t);
  c.feed(GAME_OVER);
  c.clock.t += 300;
  c.msg(PROGRESS); // re-renders the sheet
  let s = onSheet(c);
  assert.equal(s.covers.length, 1, 'the new chart goes on drawing');
  assert.equal(s.heads.length, 3);
  assert.ok(s.live.every((a) => a.currentTime === 300), 'at the moment the first one had reached');
  assert.equal(s.pops.length, 3);

  const count = c.anims.length;
  const tabs = c.doc.querySelectorAll('#resultBody .resultTabBtn');
  tabs[1].dispatchEvent(new c.window.MouseEvent('click', { bubbles: true }));
  tabs[0].dispatchEvent(new c.window.MouseEvent('click', { bubbles: true }));
  assert.equal(c.anims.length, count, '"Statistik" and back: the same chart, nothing replays');
  assert.equal(c.doc.querySelector('#resultBody .scoreChartSvg'), s.svg);

  c.clock.t += 1300; // 1600 ms in: the pops of rounds 2 and 3 are over
  c.msg({ type: 'badges', earned: [] });
  s = onSheet(c);
  assert.equal(s.pops.length, 1, 'only the last round\'s pop is still due');
  assert.equal(s.svg.querySelector('.revealCover'), null, 'the lines are drawn: no cover any more');
  assert.ok(s.live.every((a) => a.currentTime === 1600));

  c.clock.t += 5000;
  c.feed(GAME_OVER); // the same sheet again (reconnect, another state)
  s = onSheet(c);
  assert.equal(s.live.length, 0, 'drawn once: later renders show the finished chart');
  assert.equal(s.pops.length, 0);
  assert.equal(s.svg.querySelector('.revealCover'), null);

  // The next match ends in the same round: a new sheet, a new reveal.
  c.feed({ ...BASE, phase: 'playing' });
  c.feed(GAME_OVER);
  assert.equal(onSheet(c).covers.length, 1);
  assert.deepEqual(c.errors, []);
});

test('only at game over: no reveal at round end, in "Meine Partien", with reduced motion or switched off', async (t) => {
  const c = await setup(t);
  c.feed(ROUND_END);
  assert.ok(c.doc.querySelector('#resultBody .scoreChartSvg'), 'the round-end chart is there');
  assert.equal(c.anims.filter((a) => a.el.closest && a.el.closest('.scoreChart')).length, 0);

  const still = await setup(t, { reduced: true });
  still.feed(GAME_OVER);
  assert.equal(onSheet(still).live.length, 0, 'reduced motion: the finished chart at once');
  assert.equal(onSheet(still).pops.length, 0);
  assert.equal(onSheet(still).svg.querySelector('.revealCover'), null);

  const off = await setup(t, { storage: { pikdame_chart_reveal: 'off' } });
  assert.equal(off.doc.getElementById('chartRevealCheckbox').checked, false);
  off.feed(GAME_OVER);
  assert.equal(onSheet(off).live.length, 0, 'switched off in "Optionen"');
  assert.equal(onSheet(off).svg.querySelector('.revealCover'), null);
  assert.equal(c.doc.querySelector('#resultBody .revealCover'), null, 'no cover at round end');

  // The one caller sits behind the game-over branch; the stored game's chart is never played.
  const client = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
  assert.equal(client.match(/revealScoreChart\(/g).length, 2, 'its definition and one call');
  const call = client.indexOf('revealScoreChart(chart); }');
  assert.ok(call > client.indexOf('if (isGameOver && !forfeited && lastState.gameOverInfo) {') && call < client.indexOf('function renderTeamScoreChart'));
  assert.deepEqual([...c.errors, ...still.errors, ...off.errors], []);
});

test('"Punkteverlauf zeichnen": the switch is stored, off finishes a running reveal', async (t) => {
  const c = await setup(t);
  const box = c.doc.getElementById('chartRevealCheckbox');
  assert.equal(box.checked, true, 'on by default');
  assert.ok(box.closest('label.prefRow').querySelector('.prefSub'), 'label and what it does');
  assert.equal(box.closest('.prefGroup').querySelector('.prefGroupTitle').textContent, 'Darstellung');
  c.feed(GAME_OVER);
  const before = onSheet(c);
  box.checked = false;
  box.dispatchEvent(new c.window.Event('change', { bubbles: true }));
  assert.equal(c.window.localStorage.getItem('pikdame_chart_reveal'), 'off');
  assert.ok(before.live.every((a) => a.state === 'finished'));
  assert.equal(before.svg.querySelectorAll('.leadPop').length, 0, 'the pops leave with their animation');
  assert.equal(before.svg.querySelector('.revealCover'), null, 'and so does the cover');
  c.msg(PROGRESS);
  assert.equal(onSheet(c).live.length, 0, 'a re-render stays finished');
  box.checked = true;
  box.dispatchEvent(new c.window.Event('change', { bubbles: true }));
  assert.equal(c.window.localStorage.getItem('pikdame_chart_reveal'), 'on');
  assert.deepEqual(c.errors, []);
});

test('below the fold (landscape): the reveal waits at its first frame until the chart is seen', async (t) => {
  const c = await setup(t, { observer: true });
  c.feed(GAME_OVER);
  let s = onSheet(c);
  assert.ok(s.live.length > 0 && s.live.every((a) => a.state === 'paused' && a.currentTime === 0));
  c.clock.t += 4000; // the player reads the ranking first
  c.msg(PROGRESS);
  s = onSheet(c);
  assert.ok(s.live.every((a) => a.state === 'paused' && a.currentTime === 0), 'a re-render still waits');
  const io = c.observers.filter((o) => o.live);
  assert.equal(io.length, 1, 'one observer, on the chart of the sheet');
  assert.equal(io[0].node, s.svg);
  io[0].see();
  assert.ok(s.live.every((a) => a.state === 'running'));
  assert.equal(io[0].live, false);
  c.clock.t += 200;
  c.msg(PROGRESS);
  assert.ok(onSheet(c).live.every((a) => a.currentTime === 200 && a.state === 'running'), 'the clock starts when it is seen');
  assert.deepEqual(c.errors, []);
});

test('"2 gegen 2": the lead changes come from the team totals, in the team colours', async (t) => {
  const c = await setup(t);
  const TEAMS = [['p1', 'p2'], ['b1', 'b2']];
  const players = [PLAYERS[0], PLAYERS[1], { id: 'p2', name: 'Oma Gerda', isBot: false, connected: true, handCount: 4 }, { ...PLAYERS[2] }];
  const rows = [[270, 100], [550, 600], [1300, 1100], [1910, 2080]]; // B takes over, A, then B again
  c.feed({ ...GAME_OVER, players, teamMode: true, teams: TEAMS, targetScore: 2000, teamNames: [null, null], teamTotals: rows[3],
    // The seats alone would tell another story (Flo ahead throughout): only the team sums count.
    scoreHistory: rows.map((r, i) => ({ round: i + 1, totals: { p1: 5000, b1: 0, p2: 0, b2: 0 }, teamTotals: r })),
    totals: { p1: 1000, b1: 1100, p2: 910, b2: 980 }, lastRoundResult: { p1: mk(100), b1: mk(200, true), p2: mk(50), b2: mk(60) },
    gameOverInfo: { winnerId: null, teamMode: true, teams: TEAMS, winnerTeam: 1, winnerIds: TEAMS[1], teamTotals: rows[3], targetScore: 2000, totalTurns: 200, totalRounds: 4, highlights: [] } });
  const s = onSheet(c);
  assert.equal(s.heads.length, 2, 'two lines, one per team');
  assert.deepEqual(s.pops.map((g) => g.querySelector('.leadPopRing').getAttribute('stroke')), ['#eb6834', '#2a78d6', '#eb6834']);
  assert.deepEqual(c.errors, []);
});

test('contracts: loaded before client.js, cheap on battery, nothing shows without its animation', () => {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  const src = fs.readFileSync(path.join(pub, 'score-chart.js'), 'utf8');
  const at = html.indexOf('<script src="/score-chart.js" defer></script>');
  assert.ok(at > 0 && at < html.indexOf('<script src="/client.js" defer></script>'));
  assert.match(html, /id="chartRevealCheckbox"/, 'new animations can be switched off (CLAUDE.md 2c)');
  assert.match(css, /\.scoreChartSvg \.leadPop circle \{[^}]*opacity: 0/, 'a pop shows only while its animation runs');
  assert.match(css, /\.scoreChartSvg \.revealCover rect \{[^}]*fill: var\(--card-bg\)/, 'the cover is the sheet\'s own colour');
  assert.match(css, /\.scoreChartSvg \.(leadPop|revealCover) \{[^}]*pointer-events: none/);
  // The chart itself carries no reveal state: without the animation it is the finished chart,
  // on every sheet that shows one. Only transform and opacity move, once, without a timer.
  assert.doesNotMatch(css, /\.scoreChartSvg (polyline|\.endDot|\.endLabel)[^{]*\{[^}]*(opacity|transform|stroke-dash)/);
  assert.doesNotMatch(src, /stroke-?dash|clip-?path|will-?change/i, 'transform and opacity only, no layer kept');
  assert.doesNotMatch(src, /setTimeout|setInterval|requestAnimationFrame|iterations|getBoundingClientRect|getTotalLength/, 'one shot, no loop, no layout read');
});
