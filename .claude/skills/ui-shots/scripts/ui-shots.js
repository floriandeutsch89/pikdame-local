#!/usr/bin/env node
// Screenshots of the real client with mock data, in every layout.
// Starts its own server on a temp data dir (never touches data/), routes the
// WebSocket through Playwright and rewrites/injects messages per scene.
//
//   node .claude/skills/ui-shots/scripts/ui-shots.js [--out DIR] [--views a,b] [--scenes a,b] [--port N] [--audit] [--signed-in]
//
// --signed-in mocks a signed-in account (the /api/* answers below), season
// finale included: the start-up hint shows on the first start-screen shot.
//
// --audit also checks every shot for truncated text, tap targets < 44 px,
// icon buttons without a name and (start screen) content below the fold;
// the report goes to <out>/audit.md.
//
// Views: phone (393x852), land (874x402), desk (1440x900), se (375x667), max (440x956).
// Scenes: lobby, lobby-open, progress, stats, history, roundend, roundend-stats, gameover,
// table (needs --state <file>: a GameManager.publicState('p1') JSON in the playing phase),
// puzzle / puzzle-turn / puzzle-out (one meld laid), puzzle-solved (3 stars + the tile),
// challenge (intro, attempt used),
// gamelobby (seats + house rules), botdiff (the strength picker), gameover-challenge,
// settings / settings-aids (the start screen's "Mehr" sheet, top / play aids),
// account (the account sheet: level, season ladder; needs --signed-in).
// Start-screen scenes may follow table or result scenes in any order: the page
// is reloaded to the start screen first.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  throw new Error('playwright not found - set PLAYWRIGHT_MODULE to its path');
}

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const ROOT = path.resolve(__dirname, '../../../..');
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'pikdame-shots')));
const PORT = Number(arg('port', 3477));
const VIEWS = {
  phone: { width: 393, height: 852, mobile: true },
  land: { width: 874, height: 402, mobile: true },
  desk: { width: 1440, height: 900, mobile: false },
  se: { width: 375, height: 667, mobile: true },
  max: { width: 440, height: 956, mobile: true }, // iPhone Pro Max: 15 cards still fit one row
};
const views = arg('views', 'phone,land,desk').split(',');
const scenes = arg('scenes', 'lobby,stats,history,roundend,gameover').split(',');
const AUDIT = process.argv.includes('--audit');
const SIGNED_IN = process.argv.includes('--signed-in');
const TAP_MIN = 44; // CLAUDE.md --tap-min
// A normal UA: the server treats headless defaults as a crawler (no WebSocket).
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// --- mock data ---------------------------------------------------------------
// "Today" is the server's game day (Europe/Berlin), not UTC.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const NOW = Date.now();
const ME = 'Flo';
const PROFILES = [
  { name: ME, gamesPlayed: 43, gamesWon: 17, totalScore: 31000, bestGameScore: 1385, xp: 5320, dailyStreak: 6,
    daily: { streak: 6, best: 11, last: '2000-01-01', graceAt: null },
    badges: { first_win: NOW - 9e8, pd_laid: NOW - 5e8, marathon_10: NOW - 2e8 },
    puzzles: { [TODAY]: { tries: 1, solved: false } } },
  { name: 'Oma Gerda', gamesPlayed: 120, gamesWon: 61, totalScore: 99000, bestGameScore: 1610, xp: 18000, badges: { first_win: 1 } },
  { name: 'Klaus', gamesPlayed: 15, gamesWon: 3, totalScore: 8000, bestGameScore: 1040, xp: 1200, badges: {} },
];
// The start-screen Stammtisch chip and its sheet (answered by the script, see below).
const STAMMTISCH = {
  name: 'Familie Deutsch', gamesPlayed: 7,
  series: { no: 3, games: 2, wins: { 'oma gerda': 1, flo: 1 }, bestOf: 3, needed: 2 },
  goals: { level: 3, into: 40, need: 100, xp: 165, week: { start: '2026-10-12', games: 7, goal: 10, reached: false }, streak: 2, weeksReached: 4 },
  members: [
    { name: 'Oma Gerda', wins: 4, games: 7, avg: 612 }, { name: ME, wins: 2, games: 7, avg: 540 },
    { name: 'Klaus', wins: 1, games: 6, avg: 455 },
  ],
  pairwise: {
    'oma gerda': { flo: { ahead: 5, behind: 2 }, klaus: { ahead: 4, behind: 2 } },
    flo: { 'oma gerda': { ahead: 2, behind: 5 }, klaus: { ahead: 3, behind: 3 } },
    klaus: { 'oma gerda': { ahead: 2, behind: 4 }, flo: { ahead: 3, behind: 3 } },
  },
};
// --signed-in: account answers by path. Seasons are months counted back from today.
const monthsBack = (n) => {
  const d = new Date(`${TODAY.slice(0, 7)}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
};
const SEASON_RESULT = { season: monthsBack(1), place: 2, award: 'silver', seasonXp: 640, ranked: 14 };
const SEASON_AWARDS = [SEASON_RESULT,
  { season: monthsBack(2), place: 7, award: 'top10', seasonXp: 310, ranked: 12 },
  { season: monthsBack(3), place: 11, award: 'participant', seasonXp: 95, ranked: 12 }];
const ACCOUNT_API = {
  '/api/me': { ok: true, username: ME, seasonResult: SEASON_RESULT, lastSeason: SEASON_RESULT, seasonAwards: SEASON_AWARDS },
  '/api/ladder': { ok: true, season: TODAY.slice(0, 7), lastSeason: SEASON_RESULT, seasonAwards: SEASON_AWARDS,
    me: { username: ME, xp: 5320, seasonXp: 410, season: TODAY.slice(0, 7), games: 43, wins: 17, rank: 2 },
    board: [{ username: 'Oma Gerda', seasonXp: 520 }, { username: ME, seasonXp: 410 }, { username: 'Klaus', seasonXp: 150 }] },
  '/api/account/methods': { ok: true, hasPassword: false, passkeys: [{ id: 'pk1', name: 'iPhone', createdAt: NOW - 9e8, lastUsedAt: NOW - 3e6 }] },
};
const GLOBAL_STATS = { games: 8123, rounds: 61234, pikDamesLaidOut: 9001, pikDamesCaught: 4521, handAusRounds: 777 };
const HISTORY = [
  { id: 'g1', finishedAt: NOW - 3600e3, startedAt: NOW - 3600e3 - 41 * 60e3, rounds: 3, won: true, myScore: 1040, myId: 'p1', stammtisch: true,
    players: [{ id: 'p1', name: ME }, { id: 'p2', name: 'Oma Gerda' }, { id: 'b1', name: 'Klaus', isBot: true, botDifficulty: 'zen' }],
    finalTotals: { p1: 1040, p2: 760, b1: 905 },
    roundTotals: [{ p1: 300, p2: 250, b1: 330 }, { p1: 700, p2: 500, b1: 720 }, { p1: 1040, p2: 760, b1: 905 }] },
  { id: 'g2', finishedAt: NOW - 30 * 3600e3, startedAt: NOW - 30 * 3600e3 - 55 * 60e3, rounds: 8, won: false, myScore: 880, myId: 'p1', challengeDate: TODAY,
    players: [{ id: 'p1', name: ME }, { id: 'b1', name: 'Horst', isBot: true, botDifficulty: 'medium' }],
    finalTotals: { p1: 880, b1: 1010 }, roundTotals: [] },
];
const mk = (s, win) => ({ roundScore: s, breakdown: { isWinner: !!win, multiplier: 1 } });
const PLAYERS = [
  { id: 'p1', name: ME, isBot: false, connected: true, handCount: 9, hand: [] },
  { id: 'b1', name: 'Klaus', isBot: true, connected: true, handCount: 0, botDifficulty: 'zen' },
  { id: 'b2', name: 'Horst', isBot: true, connected: true, handCount: 4, botDifficulty: 'zen' },
  { id: 'b3', name: 'Maria', isBot: true, connected: true, handCount: 6, botDifficulty: 'zen' },
];
const SCORE_HISTORY = [
  { round: 1, totals: { p1: 120, b1: 60, b2: -20, b3: 40 } },
  { round: 2, totals: { p1: 250, b1: 330, b2: 90, b3: 75 } },
  { round: 3, totals: { p1: 205, b1: 600, b2: 200, b3: 40 } },
];
const BASE_STATE = {
  roundNumber: 3, currentPlayerId: 'p1', turnPhase: 'draw', dealerId: 'b1', discardTop: null, drawPileCount: 30,
  discardPileCount: 3, log: [], tableMelds: [], lobbyReady: [], nextRoundReady: [], houseRules: {}, players: PLAYERS,
  lastRoundWinnerId: 'b1', scoreHistory: SCORE_HISTORY,
  lastRoundStats: [
    { id: 'p1', name: ME, laidOutCount: 3, handCount: 9, pikDameLaidOut: 0, jokersLaidOut: 1,
      laidLines: [{ kind: 'joker', count: 1, points: 20 }, { kind: 'low', count: 2, points: 10 }],
      handLines: [{ kind: 'face', count: 3, points: 30 }, { kind: 'low', count: 6, points: 30 }, { kind: 'ace', count: 1, points: 20 }] },
    { id: 'b1', name: 'Klaus', laidOutCount: 15, handCount: 0, pikDameLaidOut: 1, jokersLaidOut: 2 },
    { id: 'b2', name: 'Horst', laidOutCount: 11, handCount: 4, pikDameLaidOut: 0, jokersLaidOut: 0 },
    { id: 'b3', name: 'Maria', laidOutCount: 9, handCount: 6, pikDameLaidOut: 0, jokersLaidOut: 1 },
  ],
};
const ROUND_END = { ...BASE_STATE, phase: 'roundEnd', totals: SCORE_HISTORY[2].totals,
  lastRoundResult: { p1: mk(-45), b1: mk(270, true), b2: mk(110), b3: mk(-35) } };
const GAME_OVER = { ...BASE_STATE, phase: 'gameOver', roundNumber: 6, totals: { p1: 880, b1: 1045, b2: 610, b3: 320 },
  scoreHistory: [...SCORE_HISTORY, { round: 4, totals: { p1: 480, b1: 700, b2: 380, b3: 190 } },
    { round: 5, totals: { p1: 700, b1: 820, b2: 500, b3: 260 } }, { round: 6, totals: { p1: 880, b1: 1045, b2: 610, b3: 320 } }],
  lastRoundResult: { p1: mk(180), b1: mk(225, true), b2: mk(110), b3: mk(60) },
  gameStatsTotals: { p1: { pikDames: 1, jokers: 4 }, b1: { pikDames: 2, jokers: 7 } }, hasExportableGame: true,
  gameOverInfo: { winnerId: 'b1', finalTotals: {}, totalTurns: 214, totalRounds: 6,
    highlights: [{ type: 'queenCaught', round: 2, name: 'Horst' }, { type: 'bestRound', round: 3, name: 'Klaus', score: 270 }],
    funTitle: { type: 'queenMagnet', name: 'Horst', count: 2 } } };

// Rewrite server -> client messages so the lobby shows the mock profile.
// --puzzle-kind turn|out: today's puzzle message carries a puzzle of that kind.
let puzzleKind = null;
let puzzleSolved = false; // scene puzzle-solved: today solved first try, a perfect run of 4
function kindPuzzle(kind) {
  const DP = require(path.join(ROOT, 'game', 'DailyPuzzle'));
  const { addDays } = require(path.join(ROOT, 'game', 'GameDay'));
  let date = DP.ROTATION_START;
  while (DP.kindForDate(date).kind !== kind) date = addDays(date, 1);
  return DP.puzzleForDate(date);
}
// stammtisch-lobby: the next join is shown as a seat at the mock Stammtisch.
let bindStammtisch = false;
function rewrite(msg) {
  if (msg.type === 'joined' && bindStammtisch) msg.stammtisch = { code: 'STMOCK1', name: STAMMTISCH.name };
  if (msg.type === 'profiles') { msg.players = PROFILES; msg.globalStats = GLOBAL_STATS; }
  if (msg.type === 'gameHistory') msg.games = HISTORY;
  if (msg.type === 'puzzle' && puzzleKind) {
    const DP = require(path.join(ROOT, 'game', 'DailyPuzzle'));
    Object.assign(msg, DP.publicPuzzle(kindPuzzle(puzzleKind)), { date: msg.today, archive: false });
  }
  if (msg.type === 'puzzle' && puzzleSolved) {
    Object.assign(msg, { status: { tries: 1, solved: true, revealed: false, stars: 3 }, dayStars: 3, perfectStreak: { current: 4, best: 6 } });
  }
  return msg;
}

// --- layout audit (runs in the page) ------------------------------------------
// Only the topmost open overlay counts when one is open: the blurred page
// behind it is not what the player can touch.
function auditPage(tapMin) {
  const overlays = [...document.querySelectorAll('.overlay:not(.hidden)')]
    .filter((o) => getComputedStyle(o).display !== 'none');
  const root = overlays.length ? overlays[overlays.length - 1] : document.body;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      if (n.tagName === 'DETAILS' && !n.open && n !== el && !n.querySelector('summary').contains(el)) return false;
    }
    return true;
  };
  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = !id && typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  };
  const out = { truncated: [], smallTargets: [], unnamed: [], fold: null };
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el) || el.closest('.seoIntro, .visuallyHidden')) continue;
    const cs = getComputedStyle(el);
    // Text clipped by its own box. Measure the text itself (a Range), not
    // scrollWidth: decorative pseudo-elements inflate scrollWidth.
    if ((cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden' || cs.overflowX === 'clip') &&
        (el.textContent || '').trim() && !el.querySelector('svg, canvas, img')) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const textW = range.getBoundingClientRect().width;
      const box = el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (textW > box + 1) out.truncated.push(label(el));
    }
    const interactive = el.matches('button, a[href], input:not([type=hidden]), select, summary, [role=button]');
    if (interactive) {
      const r = el.getBoundingClientRect();
      // Inline links in running text are exempt (WCAG 2.5.8 inline exception).
      const inline = el.tagName === 'A' && cs.display === 'inline';
      // A hit area stretched by an absolute ::after (e.g. .resultSortBtn) counts.
      const after = getComputedStyle(el, '::after');
      const stretched = after.content !== 'none' && after.position === 'absolute' && parseFloat(after.height) >= tapMin;
      // So does the <label> around (or for) an input: a switch row is the target.
      const lab = el.matches('input') && (el.closest('label') || (el.id && document.querySelector(`label[for="${el.id}"]`)));
      const lr = lab ? lab.getBoundingClientRect() : null;
      const labelled = !!lr && Math.min(lr.width, lr.height) >= tapMin;
      if (!inline && !stretched && !labelled && Math.min(r.width, r.height) < tapMin) out.smallTargets.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (el.matches('button, [role=button]') && !(el.textContent || '').trim() &&
          !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.getAttribute('title')) {
        out.unnamed.push(label(el));
      }
    }
  }
  // Start screen must fit a portrait phone without scrolling (landscape may
  // scroll): where do the tools end?
  const tools = document.querySelector('.lobbyTools');
  const portrait = window.innerHeight > window.innerWidth;
  // Only the start screen must fit; a game lobby (seats, house rules) scrolls.
  const start = document.getElementById('createGameBtn');
  if (portrait && !overlays.length && tools && visible(tools) && start && visible(start)) {
    const bottom = tools.getBoundingClientRect().bottom + window.scrollY;
    if (bottom > window.innerHeight) out.fold = `.lobbyTools ends at ${Math.round(bottom)} px, viewport ${window.innerHeight} px`;
  }
  return out;
}

// --- server ------------------------------------------------------------------
function waitForHttp(port, ms = 20000) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => http.get(`http://localhost:${port}/healthz`, (r) => { r.resume(); resolve(); })
      .on('error', () => (Date.now() > until ? reject(new Error(`server on ${port} did not start`)) : setTimeout(tick, 250)));
    tick();
  });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-shots-data-'));
  const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir }, stdio: 'ignore' });
  // The server flushes its snapshot on SIGTERM: wait for it before deleting.
  const exited = new Promise((r) => server.once('exit', r));
  const cleanup = async () => {
    if (server.exitCode === null) { server.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = loadPlaywright();
  const written = [];
  const audits = [];
  try {
    await waitForHttp(PORT);
    const browser = await chromium.launch();
    for (const vn of views) {
      const vp = VIEWS[vn];
      if (!vp) throw new Error(`unknown view ${vn}`);
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, userAgent: UA, deviceScaleFactor: 2, isMobile: vp.mobile, hasTouch: vp.mobile });
      await ctx.addInitScript(([me, theme]) => {
        try {
          localStorage.setItem('pikdame_player_name', me);
          if (theme) localStorage.setItem('pikdame_theme', theme); // --theme table|night|felt|love|bordeaux|kitchen
          localStorage.setItem('pikdame_splash_device', '1'); // skip the studio intro
          sessionStorage.setItem('pikdame_splash_seen', '1');
          localStorage.setItem('pikdame_stammtische', JSON.stringify([{ code: 'STMOCK1', name: 'Familie Deutsch' }]));
        } catch (e) { /* storage blocked */ }
      }, [ME, arg('theme', '')]);
      if (SIGNED_IN) {
        await ctx.addInitScript(() => { try { localStorage.setItem('pikdame_account_token', 'mock-token'); } catch (e) { /* blocked */ } });
        await ctx.route('**/api/**', (route) => route.fulfill({ contentType: 'application/json',
          body: JSON.stringify(ACCOUNT_API[new URL(route.request().url()).pathname] || { ok: true }) }));
        await ctx.route('**/statusz', async (route) => {
          const res = await route.fetch();
          route.fulfill({ response: res, body: JSON.stringify({ ...(await res.json()), accountsEnabled: true }) });
        });
      }
      const page = await ctx.newPage();
      let sock = null;
      await page.routeWebSocket(/.*/, (ws) => {
        sock = ws;
        const srv = ws.connectToServer();
        srv.onMessage((m) => { try { m = JSON.stringify(rewrite(JSON.parse(m))); } catch (e) { /* binary */ } ws.send(m); });
        // Answer Stammtisch probes here: the server counts an unknown code as a
        // failed join and blocks the IP after a few (it looked like throttling).
        ws.onMessage((m) => {
          let msg = null;
          try { msg = JSON.parse(m); } catch (e) { /* binary */ }
          if (msg && msg.type === 'getStammtisch') {
            ws.send(JSON.stringify({ type: 'stammtischInfo', code: msg.code, exists: true, ...STAMMTISCH }));
            return;
          }
          srv.send(m);
        });
      });
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      const shot = async (name) => {
        const file = path.join(OUT, `${vn}-${name}.png`);
        await page.screenshot({ path: file });
        written.push(file);
        if (AUDIT) audits.push({ view: vn, scene: name, ...(await page.evaluate(auditPage, TAP_MIN)) });
      };
      const inject = (obj) => sock.send(JSON.stringify(obj));
      // A table/result scene leaves the start screen, and its buttons are then
      // invisible (clicks time out). Reload without the mock session, so the
      // client neither rejoins nor probes an unknown code (that blocks the IP).
      const toStart = async () => {
        if (await page.isVisible('#createGameBtn')) return;
        await page.evaluate(() => { try { localStorage.removeItem('pikdame_last_session'); } catch (e) { /* blocked */ } });
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);
      };
      const LOBBY_SCENES = /^(lobby|lobby-open|progress|stats|history|settings|settings-aids|challenge|stammtisch|account|puzzle.*)$/;
      for (const sc of scenes) {
        if (LOBBY_SCENES.test(sc)) await toStart();
        if (sc === 'lobby') await shot('lobby');
        if (sc === 'stammtisch') {
          await page.click('#stammtischRecent button[data-code]'); await page.waitForTimeout(500);
          await shot('stammtisch');
          await page.click('#stammtischSheetCloseBtn');
        }
        if (sc === 'puzzle-solved') {
          // Solved with three stars; then the "Heute" tile shows them on the start screen.
          puzzleSolved = true;
          await page.click('#puzzleBtn'); await page.waitForTimeout(600);
          await shot(sc);
          await page.click('#puzzleCloseBtn'); await page.waitForTimeout(200);
          await shot('lobby-solved');
          puzzleSolved = false;
        } else if (sc.startsWith('puzzle')) {
          puzzleKind = sc === 'puzzle' ? null : sc.slice('puzzle-'.length);
          await page.click('#puzzleBtn'); await page.waitForTimeout(600);
          if (puzzleKind) {
            // Lay the first meld of the solution so the meld row shows.
            const p = kindPuzzle(puzzleKind);
            for (const id of p.best.melds[0]) {
              await page.evaluate((cid) => {
                const card = [...document.querySelectorAll('#puzzleHand .card')].find((c) => c.dataset.cardId === cid);
                if (card) card.click();
              }, id);
            }
            await page.click('#puzzleLayBtn'); await page.waitForTimeout(200);
          }
          await shot(sc);
          await page.click('#puzzleCloseBtn');
          puzzleKind = null;
        }
        if (sc === 'challenge') {
          await page.route('**/challengeboardz*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            date: TODAY, you: { rank: 3, score: 1120, queens: 1, players: 12 }, attempted: true, magnet: { name: 'Klaus', queens: 3 },
            board: [{ rank: 1, name: 'Oma Gerda', score: 1380 }, { rank: 2, name: 'Klaus', score: 1205 }, { rank: 3, name: ME, score: 1120 }],
            weekly: { week: TODAY, players: 3, top: [{ rank: 1, name: 'Oma Gerda', weekScore: 5400, days: 5 }] }, trend: { dates: [], me: null, top: [] },
          }) }));
          await page.click('#challengeBtn'); await page.waitForTimeout(700);
          await shot('challenge');
          await page.click('#challengeCancelBtn');
        }
        if (sc === 'stammtisch-lobby') {
          // A real game lobby whose join is rewritten to the mock Stammtisch:
          // the record panel (goals, series, standings) with mock numbers.
          await toStart();
          bindStammtisch = true;
          await page.click('#createGameBtn'); await page.waitForTimeout(900);
          inject({ type: 'stammtisch', summary: { code: 'STMOCK1', ...STAMMTISCH }, seriesEvent: null });
          await page.waitForTimeout(300);
          await page.evaluate(() => document.getElementById('stammtischSection').scrollIntoView({ block: 'start' }));
          await shot('stammtisch-lobby');
          bindStammtisch = false;
        }
        if (sc === 'gamelobby' || sc === 'botdiff') {
          if (!(await page.isVisible('#houseRulesSection'))) { await toStart(); await page.click('#createGameBtn'); await page.waitForTimeout(900); }
          if (sc === 'gamelobby') {
            await page.evaluate(() => document.getElementById('houseRulesSection').scrollIntoView({ block: 'center' }));
            await shot('gamelobby');
          }
          else {
            await page.click('.seatDiff'); await page.waitForTimeout(300);
            await shot('botdiff');
            await page.click('#botDiffCloseBtn');
          }
        }
        if (sc === 'lobby-open') {
          await page.evaluate(() => { const d = document.getElementById('questsSection'); if (d) d.open = true; });
          await shot('lobby-open');
        }
        if (sc === 'progress') {
          await page.click('#identityAvatarBtn'); await page.waitForTimeout(300);
          await shot('progress');
          await page.click('#progressCloseBtn');
        }
        if (sc === 'settings' || sc === 'settings-aids') {
          await page.click('#settingsBtnLobby'); await page.waitForTimeout(400);
          // settings-aids: scrolled to the play aids at the end of the sheet.
          if (sc === 'settings-aids') await page.evaluate(() => document.getElementById('aidLowCardsCheckbox').scrollIntoView({ block: 'center' }));
          await shot(sc);
          await page.click('#settingsOverlayCloseBtn');
        }
        if (sc === 'account') {
          await page.click('#accountBtn'); await page.waitForTimeout(700);
          await page.evaluate(() => document.getElementById('ladderBox').scrollIntoView({ block: 'center' }));
          await page.waitForTimeout(200);
          await shot('account');
          await page.click('#accountCloseBtn');
        }
        if (sc === 'stats' || sc === 'history') {
          await page.click('#statsBtn'); await page.waitForTimeout(500);
          if (sc === 'history') { await page.click('#statsTabHistoryBtn'); await page.waitForTimeout(600); }
          await shot(sc);
          await page.click('#statsCloseBtn');
        }
        if (sc === 'table') {
          // Live table: needs --state <file> with a publicState('p1') JSON (playing phase).
          const st = JSON.parse(fs.readFileSync(arg('state', ''), 'utf8'));
          inject({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
          inject({ type: 'state', state: st });
          await page.waitForTimeout(1200);
          // --css <file>: extra CSS for quick layout mockups (never shipped).
          if (arg('css', '')) await page.addStyleTag({ content: fs.readFileSync(arg('css', ''), 'utf8') });
          if (arg('js', '')) await page.evaluate(fs.readFileSync(arg('js', ''), 'utf8')); // --js <file>: DOM mockups
          await page.waitForTimeout(200);
          await shot('table');
        }
        if (sc.startsWith('roundend') || sc.startsWith('gameover')) {
          inject({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
          const challenge = sc === 'gameover-challenge';
          inject({ type: 'state', state: sc.startsWith('gameover') ? { ...GAME_OVER, challengeDate: challenge ? TODAY : null } : ROUND_END });
          if (challenge) {
            inject({ type: 'challengeBoard', date: TODAY, yourScore: 880, yourRank: 2, yourQueens: 1, players: 9,
              board: [{ rank: 1, name: 'Oma Gerda', score: 1210 }, { rank: 2, name: ME, score: 880 }], history: [], weekly: null });
          }
          if (sc.startsWith('gameover')) inject({ type: 'progress', gainedXp: 120, xp: 5440, level: { level: 14 }, record: { played: 43, won: 17 } });
          await page.waitForTimeout(1600); // count-up + winner animation
          if (sc === 'roundend-stats') { await page.click('#resultBody .resultTabBtn:nth-child(2)'); await page.waitForTimeout(300); }
          if (sc === 'gameover-challenge') {
            await page.evaluate(() => { const b = document.querySelector('.challengeBoardBox'); if (b) b.scrollIntoView({ block: 'center' }); });
            await page.waitForTimeout(200);
          }
          await shot(sc);
        }
      }
      await ctx.close();
    }
    await browser.close();
  } finally {
    await cleanup();
  }
  console.log(written.join('\n'));
  if (AUDIT) {
    const lines = ['# UI audit', ''];
    let findings = 0;
    for (const a of audits) {
      const items = [
        ...a.truncated.map((t) => `- **truncated** ${t}`),
        ...a.smallTargets.map((t) => `- **tap target < ${TAP_MIN}px** ${t}`),
        ...a.unnamed.map((t) => `- **icon button without a name** ${t}`),
        ...(a.fold ? [`- **below the fold** ${a.fold}`] : []),
      ];
      findings += items.length;
      lines.push(`## ${a.view} / ${a.scene}`, '', ...(items.length ? items : ['- nothing found']), '');
    }
    fs.writeFileSync(path.join(OUT, 'audit.md'), lines.join('\n'));
    console.log(`audit: ${findings} finding(s) -> ${path.join(OUT, 'audit.md')}`);
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
