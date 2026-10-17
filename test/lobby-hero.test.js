/** The start screen's card fan hides a small extra with a date rule that fires
 *  on one day a year, so a break would go unnoticed until then. Boots the REAL
 *  markup and client in jsdom on a fixed device date. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const SPEED = 10; // client timers run this much faster than real time here

function bootOn(year, monthIndex, day) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  const RealDate = window.Date;
  const offset = new RealDate(year, monthIndex, day, 10, 0, 0).getTime() - RealDate.now();
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
    static now() { return RealDate.now() + offset; }
  };
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, ms / SPEED, ...args);
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  let rafDepth = 0;
  window.requestAnimationFrame = (cb) => {
    if (rafDepth > 4) return 0;
    rafDepth += 1;
    try { cb(Date.now()); } finally { rafDepth -= 1; }
    return 0;
  };
  window.scrollTo = () => {};
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  window.WebSocket = class {
    constructor() { this.readyState = 1; }
    addEventListener() {} removeEventListener() {} send() {} close() {}
  };
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const hero = window.document.querySelector('.lobbyHero');
  const has = (cls) => hero.classList.contains(cls);
  return { window, hero, has, errors };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('start screen hero: on its day the guest comes out by itself, stays and answers one tap', async () => {
  const { window, hero, has, errors } = bootOn(2026, 11, 17);
  try {
    assert.ok(!has('catOut'), 'waits a moment instead of being there on the first frame');
    await wait(150);
    assert.ok(has('catOut') && has('catTalk'), 'out and talking');
    assert.strictEqual(window.document.querySelector('.heroCatBubble text').textContent, 'Miau!');
    await wait(400);
    assert.ok(has('catOut') && !has('catTalk'), 'the bubble goes, the guest stays');
    hero.click();
    assert.ok(has('catTalk'), 'one tap is enough on its day');
    assert.deepStrictEqual(errors, []);
  } finally {
    window.close();
  }
});

test('start screen hero: on any other day only five quick taps bring the guest out, briefly', async () => {
  const { window, hero, has, errors } = bootOn(2026, 11, 16);
  try {
    await wait(150);
    assert.ok(!has('catOut'), 'stays hidden by itself');
    for (let i = 0; i < 4; i++) hero.click();
    assert.ok(!has('catOut'), 'four taps are not enough');
    hero.click();
    assert.ok(has('catOut') && has('catTalk'), 'five taps bring it out');
    await wait(400);
    assert.ok(!has('catOut') && !has('catTalk'), 'and it goes back');
    assert.deepStrictEqual(errors, []);
  } finally {
    window.close();
  }
});
