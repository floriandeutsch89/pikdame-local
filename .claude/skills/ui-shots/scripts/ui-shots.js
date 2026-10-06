#!/usr/bin/env node
// Screenshots of the real client with mock data, in every layout.
// Starts its own server on a temp data dir (never touches data/), routes the
// WebSocket through Playwright and rewrites/injects messages per scene.
//
//   node .claude/skills/ui-shots/scripts/ui-shots.js [--out DIR] [--views a,b] [--scenes a,b] [--port N] [--audit]
//
// --audit also checks every shot for truncated text, tap targets < 44 px,
// icon buttons without a name and (start screen) content below the fold;
// the report goes to <out>/audit.md.
//
// Views: phone (393x852), land (874x402), desk (1440x900), se (375x667).
// Scenes: lobby, lobby-open, progress, stats, history, roundend, roundend-stats, gameover.
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
};
const views = arg('views', 'phone,land,desk').split(',');
const scenes = arg('scenes', 'lobby,stats,history,roundend,gameover').split(',');
const AUDIT = process.argv.includes('--audit');
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
function rewrite(msg) {
  if (msg.type === 'profiles') { msg.players = PROFILES; msg.globalStats = GLOBAL_STATS; }
  if (msg.type === 'gameHistory') msg.games = HISTORY;
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
    if (!visible(el) || el.closest('.seoIntro')) continue;
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
      if (!inline && !stretched && Math.min(r.width, r.height) < tapMin) out.smallTargets.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
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
  if (portrait && !overlays.length && tools && visible(tools)) {
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
      await ctx.addInitScript(([me]) => {
        try {
          localStorage.setItem('pikdame_player_name', me);
          localStorage.setItem('pikdame_splash_device', '1'); // skip the studio intro
          sessionStorage.setItem('pikdame_splash_seen', '1');
          localStorage.setItem('pikdame_stammtische', JSON.stringify([{ code: 'STMOCK1', name: 'Familie Deutsch' }]));
        } catch (e) { /* storage blocked */ }
      }, [ME]);
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
            ws.send(JSON.stringify({ type: 'stammtischInfo', code: msg.code, exists: true, name: 'Familie Deutsch',
              gamesPlayed: 7, series: { games: 2, wins: { a: 1, b: 1 } } }));
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
      for (const sc of scenes) {
        if (sc === 'lobby') await shot('lobby');
        if (sc === 'lobby-open') {
          await page.evaluate(() => { const d = document.getElementById('questsSection'); if (d) d.open = true; });
          await shot('lobby-open');
        }
        if (sc === 'progress') {
          await page.click('#identityAvatarBtn'); await page.waitForTimeout(300);
          await shot('progress');
          await page.click('#progressCloseBtn');
        }
        if (sc === 'stats' || sc === 'history') {
          await page.click('#statsBtn'); await page.waitForTimeout(500);
          if (sc === 'history') { await page.click('#statsTabHistoryBtn'); await page.waitForTimeout(600); }
          await shot(sc);
          await page.click('#statsCloseBtn');
        }
        if (sc.startsWith('roundend') || sc === 'gameover') {
          inject({ type: 'joined', playerId: 'p1', playerToken: 't', sessionCode: 'MOCK01' });
          inject({ type: 'state', state: sc === 'gameover' ? GAME_OVER : ROUND_END });
          if (sc === 'gameover') inject({ type: 'progress', gainedXp: 120, xp: 5440, level: { level: 14 }, record: { played: 43, won: 17 } });
          await page.waitForTimeout(1600); // count-up + winner animation
          if (sc === 'roundend-stats') { await page.click('#resultBody .resultTabBtn:nth-child(2)'); await page.waitForTimeout(300); }
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
