#!/usr/bin/env node
// The README's screenshot strip (docs/img/readme-hero.png): three iPhone screens of the real
// client - start screen, the Kartenhaus, a mid-match table - laid out by scripts/readme-hero.html.
//
//   npm run readme:hero [-- --shots DIR --out FILE]
//
// Needs what the ui-shots skill needs: Playwright with Chromium and PostgreSQL
// (PIKDAME_TEST_PG_URL or PIKDAME_DATABASE_URL). The shots come from that skill's script with
// its mock data, at 3x. --shots DIR keeps them in DIR and reuses them on the next run (layout tuning).
'use strict';
process.env.PIKDAME_LOG_GAMES = '0'; // the engine plays the table below: no human moves to log
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { freePort } = require('../test/helpers/free-port');

const ROOT = path.resolve(__dirname, '..');
const UI_SHOTS = path.join(ROOT, '.claude', 'skills', 'ui-shots', 'scripts', 'ui-shots.js');
const TEMPLATE = path.join(__dirname, 'readme-hero.html');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const OUT = path.resolve(arg('out', path.join(ROOT, 'docs', 'img', 'readme-hero.png')));
const NAME = 'Dieter'; // a bot name the mocks do not use: no real person in a public picture
const SCREENS = ['lobby', 'tower', 'table']; // the template's {{placeholders}}

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  throw new Error('playwright not found - set PLAYWRIGHT_MODULE to its path');
}

// A mid-match table from the real engine (round 3, my third draw turn, the Queen of Spades in hand).
// Deck and Math.random (bot names, bot choices) are seeded: every run deals the same table.
function tableState() {
  const GameManager = require(path.join(ROOT, 'game', 'GameManager'));
  const { seededRandom } = require(path.join(ROOT, 'game', 'Deck'));
  const random = Math.random;
  Math.random = seededRandom(284 * 9973 + 17);
  try {
    const g = new GameManager(() => {}, { deckSeed: 284 });
    g.maybeRunBotTurn = () => {}; // the turns are driven here
    g.addOrReconnectPlayer('p1', NAME);
    g.fillWithBots();
    g.startNewRound();
    if (g.phase === 'cutting') g.performCut(g.cutterId, 0.5);
    g.players.forEach((p, i) => { g.totals[p.id] = [280, 415, 160, 345][i]; });
    g.roundNumber = 3;
    let state = null;
    for (let mine = 0, guard = 0; mine < 3 && g.phase === 'playing' && guard < 800; guard++) {
      const cp = g.currentPlayer();
      g.runBotTurn(cp.id, { forced: !cp.isBot });
      const next = g.currentPlayer();
      if (g.phase === 'playing' && next && next.id === 'p1' && g.turnPhase === 'draw') { mine += 1; state = g.publicState('p1'); }
    }
    g.destroy();
    if (!state) throw new Error('the engine ended the round before my third turn - pick another seed');
    return state;
  } finally {
    Math.random = random;
  }
}

async function shoot(dir) {
  const stateFile = path.join(dir, 'table-state.json');
  fs.writeFileSync(stateFile, JSON.stringify(tableState()));
  // --safe-area: laid out like the installed app on an iPhone, the status bar left free for the island.
  execFileSync(process.execPath, [UI_SHOTS, '--out', dir, '--port', String(await freePort()), '--views', 'phone',
    '--scale', '3', '--safe-area', '--name', NAME, '--tower', 'crowned', '--scenes', 'lobby,tower,table', '--state', stateFile],
  { cwd: ROOT, stdio: 'inherit' });
}

async function compose(dir) {
  const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  let html = fs.readFileSync(TEMPLATE, 'utf8');
  for (const s of SCREENS) html = html.replace(`{{${s}}}`, dataUrl(path.join(dir, `phone-${s}.png`)));
  const browser = await loadPlaywright().chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 2400, height: 1600 } });
    await page.setContent(html, { waitUntil: 'load' });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT, omitBackground: true });
  } finally {
    await browser.close();
  }
}

(async () => {
  const given = arg('shots', '');
  const dir = given ? path.resolve(given) : fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-hero-'));
  try {
    if (!SCREENS.every((s) => fs.existsSync(path.join(dir, `phone-${s}.png`)))) {
      fs.mkdirSync(dir, { recursive: true });
      await shoot(dir);
    }
    await compose(dir);
  } finally {
    if (!given) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${path.relative(ROOT, OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
