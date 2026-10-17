/** The start screen's card fan hides a small extra that comes out by itself
 *  only on the signed-in account's greeting day (a window the server sends via
 *  /api/me), so a break would go unnoticed until then. Boots the REAL markup and
 *  client in jsdom with a movable clock and a stubbed account API. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const SPEED = 10; // client timers run this much faster than real time here
const HOUR = 60 * 60 * 1000;

// greeting(t0): the window /api/me answers with (t0 = boot time, so a re-fetch
// gets the same day), or null; omitted = a server without accounts.
function boot({ date = [2026, 2, 9], greeting } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  const RealDate = window.Date;
  let offset = new RealDate(date[0], date[1], date[2], 10, 0, 0).getTime() - RealDate.now();
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
  const t0 = window.Date.now();
  const answer = (url) => {
    if (url === '/statusz') return { accountsEnabled: greeting !== undefined };
    if (url === '/api/me') {
      const win = greeting ? greeting(t0) : null;
      return { ok: true, username: 'Testkonto', ...(win ? { greeting: win } : {}) };
    }
    return { ok: true };
  };
  window.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(answer(url)), text: () => Promise.resolve('') });
  window.WebSocket = class {
    constructor() { this.readyState = 1; }
    addEventListener() {} removeEventListener() {} send() {} close() {}
  };
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  if (greeting !== undefined) window.localStorage.setItem('pikdame_account_token', 'token');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  const hero = doc.querySelector('.lobbyHero');
  const has = (cls) => hero.classList.contains(cls);
  const greetingShown = () => doc.body.classList.contains('greetingDay');
  const line = () => doc.getElementById('greetLineText').textContent;
  // Compared in JS: jsdom's selector engine misreads astral emoji in attribute selectors.
  const cakeOffered = () => [...doc.querySelectorAll('#emoteBar button')].some((b) => b.dataset.emote === '🎂');
  // Moves the clock and lets the app notice, like a phone waking up.
  const jump = (ms) => {
    offset += ms;
    doc.dispatchEvent(new window.Event('visibilitychange'));
  };
  return { window, hero, has, greetingShown, line, cakeOffered, jump, errors };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const aroundNow = (now) => ({ from: now - HOUR, until: now + HOUR });

test('start screen hero: a device date alone brings nothing out, the five quick taps still do', async () => {
  const { hero, has, greetingShown, errors, window } = boot({ date: [2026, 11, 17] });
  try {
    await wait(150);
    assert.ok(!has('catOut'), 'stays hidden by itself, whatever the device date');
    assert.ok(!greetingShown());
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

test('greeting day: the cat comes out by itself with its hat, stays, and the greeting names the account', async () => {
  const { window, hero, has, greetingShown, line, cakeOffered, errors } = boot({ greeting: aroundNow });
  try {
    assert.ok(!has('catOut'), 'waits a moment instead of being there on the first frame');
    await wait(150);
    assert.ok(greetingShown(), 'hat, line and confetti are switched on');
    assert.strictEqual(line(), 'Alles Gute zum Geburtstag, Testkonto!');
    assert.ok(cakeOffered(), 'the cake joins the emote bar');
    assert.ok(window.document.querySelector('#greetConfetti i'), 'confetti pieces exist');
    assert.ok(has('catOut') && has('catTalk'), 'out and talking');
    assert.strictEqual(window.document.querySelector('.heroCatBubble text').textContent, 'Miau!');
    await wait(400);
    assert.ok(has('catOut') && !has('catTalk'), 'the bubble goes, the cat stays');
    hero.click();
    assert.ok(has('catTalk'), 'one tap is enough on the day');
    assert.deepStrictEqual(errors, []);
  } finally {
    window.close();
  }
});

test('greeting day: it ends by itself at the end of the window, and waits for the cat to finish', async () => {
  const short = boot({ greeting: (now) => ({ from: now - HOUR, until: now + 600 }) });
  try {
    await wait(150);
    assert.ok(short.greetingShown() && short.has('catOut'));
    await wait(900); // the end-of-day timer fires on its own
    assert.ok(!short.greetingShown(), 'switched off at the end of the window');
    assert.strictEqual(short.line(), '');
    assert.ok(!short.cakeOffered(), 'the cake leaves the emote bar');
    assert.ok(!short.has('catOut'), 'the cat goes back');
    assert.deepStrictEqual(short.errors, []);
  } finally {
    short.window.close();
  }
  const { window, has, greetingShown, jump, errors } = boot({ greeting: aroundNow });
  try {
    await wait(150);
    assert.ok(has('catTalk'), 'talking when the day ends');
    jump(2 * HOUR); // the phone wakes up the next day
    assert.ok(!greetingShown());
    assert.ok(has('catOut'), 'not pulled away mid-sentence');
    await wait(400);
    assert.ok(!has('catOut') && !has('catTalk'), 'goes back once it finished talking');
    assert.deepStrictEqual(errors, []);
  } finally {
    window.close();
  }
});

test('greeting day: a window that starts tomorrow switches on at its start, nothing without one', async () => {
  const early = boot({ greeting: (now) => ({ from: now + 2 * HOUR, until: now + 26 * HOUR }) });
  try {
    await wait(150);
    assert.ok(!early.greetingShown() && !early.has('catOut'), 'not yet');
    early.jump(3 * HOUR);
    await wait(150);
    assert.ok(early.greetingShown() && early.has('catOut'), 'on at midnight');
    assert.deepStrictEqual(early.errors, []);
  } finally {
    early.window.close();
  }
  const none = boot({ greeting: () => null });
  try {
    await wait(150);
    assert.ok(!none.greetingShown() && !none.has('catOut') && !none.cakeOffered());
    assert.strictEqual(none.line(), '');
    assert.deepStrictEqual(none.errors, []);
  } finally {
    none.window.close();
  }
});

test('greeting day: signing out ends it at once', async () => {
  const { window, greetingShown, cakeOffered, errors } = boot({ greeting: aroundNow });
  try {
    await wait(150);
    assert.ok(greetingShown());
    window.document.getElementById('accLogoutBtn').click();
    await wait(50);
    assert.ok(!greetingShown() && !cakeOffered());
    assert.deepStrictEqual(errors, []);
  } finally {
    window.close();
  }
});
