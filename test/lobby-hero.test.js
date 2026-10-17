/** The start screen's card fan hides a small extra that comes out by itself
 *  only on occasion days: the signed-in account's greeting day (a window the
 *  server sends via /api/me) and holidays for everyone (windows in /statusz),
 *  so a break would go unnoticed until then. Boots the REAL markup and client
 *  in jsdom with a movable clock and a stubbed server. */
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
// holidays(t0): the `occasions` status /statusz answers with; omitted = none.
function boot({ date = [2026, 2, 9], greeting, holidays, still = false } = {}) {
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
  window.matchMedia = (q) => ({
    matches: still && q.includes('prefers-reduced-motion'), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
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
  const asked = { statusz: 0 };
  const answer = (url) => {
    if (url === '/statusz') {
      asked.statusz += 1;
      return { accountsEnabled: greeting !== undefined, ...(holidays ? { occasions: holidays(t0, asked.statusz) } : {}) };
    }
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
  const offered = (emoji) => [...doc.querySelectorAll('#emoteBar button')].filter((b) => b.dataset.emote === emoji).length;
  const cakeOffered = () => offered('🎂') > 0;
  const occasion = () => doc.body.dataset.occasion || null;
  const worn = () => [...doc.querySelectorAll('.heroCostume.on, .heroDeco.on')].map((g) => g.getAttribute('data-for'));
  const particles = (cls) => doc.querySelectorAll(`#greetConfetti ${cls}`).length;
  const icon = () => doc.getElementById('greetLineIcon').getAttribute('href');
  // Moves the clock and lets the app notice, like a phone waking up.
  const jump = (ms) => {
    offset += ms;
    doc.dispatchEvent(new window.Event('visibilitychange'));
  };
  return { window, hero, has, greetingShown, line, cakeOffered, offered, occasion, worn, particles, icon, asked, jump, errors };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const aroundNow = (now) => ({ from: now - HOUR, until: now + HOUR });

test('start screen hero: a device date alone brings nothing out, the five quick taps still do', async () => {
  const { hero, has, greetingShown, errors, window } = boot({ date: [2026, 2, 9] });
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

// --- Holidays: for everyone, from /statusz ---------------------------------------
const holiday = (id, from = -HOUR, until = HOUR) => (t0) => ({ windows: [{ id, from: t0 + from, until: t0 + until }], refreshAt: t0 + until });

test('holiday: everyone gets it without an account - costume, line, props, bats, emote, cat out all day', async () => {
  const s = boot({ holidays: holiday('halloween') });
  try {
    await wait(150);
    assert.strictEqual(s.occasion(), 'halloween');
    assert.ok(s.greetingShown());
    assert.strictEqual(s.line(), 'Süßes oder Saures!');
    assert.strictEqual(s.icon(), '#i-pumpkin');
    assert.deepStrictEqual(s.worn().sort(), ['halloween', 'halloween'], 'witch hat on the cat, pumpkin by the cards');
    assert.strictEqual(s.particles('.occBat'), 6);
    assert.strictEqual(s.offered('🎃'), 1);
    assert.ok(!s.cakeOffered());
    assert.ok(s.has('catOut'), 'the cat comes out by itself');
    await wait(400);
    assert.ok(s.has('catOut') && !s.has('catTalk'), 'and stays after talking');
    assert.deepStrictEqual(s.errors, []);
  } finally {
    s.window.close();
  }
});

test('holiday: each one has its own costume, line, icon, particles and emote', async () => {
  const cases = [
    { id: 'nikolaus', line: 'Frohen Nikolaus!', icon: '#i-mitre', worn: ['nikolaus'], particles: [], emote: '🎅' },
    { id: 'christmas', line: 'Frohe Weihnachten!', icon: '#i-tree', worn: ['christmas', 'christmas'], particles: ['.occStar', 12], emote: '🎄' },
    { id: 'silvester', line: 'Guten Rutsch!', icon: '#i-sparkle', worn: ['silvester newyear'], particles: ['.occBurst', 5], emote: '🎆' },
    { id: 'newyear', line: 'Frohes neues Jahr!', icon: '#i-sparkle', worn: ['silvester newyear'], particles: ['.occBurst', 5], emote: '🎆' },
    { id: 'easter', line: 'Frohe Ostern!', icon: '#i-egg', worn: ['easter', 'easter'], particles: ['.occPetal', 14], emote: '🐣' },
  ];
  for (const c of cases) {
    const s = boot({ holidays: holiday(c.id) });
    try {
      await wait(150);
      assert.strictEqual(s.occasion(), c.id);
      assert.strictEqual(s.line(), c.line, c.id);
      assert.strictEqual(s.icon(), c.icon, c.id);
      assert.deepStrictEqual(s.worn(), c.worn, c.id);
      if (c.particles.length) assert.strictEqual(s.particles(c.particles[0]), c.particles[1], c.id);
      else assert.strictEqual(s.particles('i'), 0, `${c.id}: the December snow is enough`);
      assert.strictEqual(s.offered(c.emote), 1, c.id);
      assert.ok(s.has('catOut'), c.id);
      assert.deepStrictEqual(s.errors, []);
    } finally {
      s.window.close();
    }
  }
});

test('holiday: New Year\'s Eve hands over to New Year at midnight, and the end switches it off', async () => {
  const s = boot({
    holidays: (t0) => ({
      windows: [{ id: 'silvester', from: t0 - HOUR, until: t0 + 300 }, { id: 'newyear', from: t0 + 300, until: t0 + 900 }],
      refreshAt: t0 + 300,
    }),
  });
  try {
    await wait(150);
    assert.strictEqual(s.line(), 'Guten Rutsch!');
    await wait(450); // the midnight timer fires on its own
    assert.strictEqual(s.occasion(), 'newyear');
    assert.strictEqual(s.line(), 'Frohes neues Jahr!');
    assert.strictEqual(s.offered('🎆'), 1, 'still one sparkler emote, not two');
    await wait(600);
    assert.strictEqual(s.occasion(), null, 'over at the end of New Year');
    assert.strictEqual(s.line(), '');
    assert.strictEqual(s.particles('i'), 0);
    assert.strictEqual(s.offered('🎆'), 0);
    assert.deepStrictEqual(s.worn(), []);
    await wait(450);
    assert.ok(!s.has('catOut'), 'the cat goes back once it finished talking');
    assert.deepStrictEqual(s.errors, []);
  } finally {
    s.window.close();
  }
});

test('holiday: the greeting day wins on the same day', async () => {
  const s = boot({ greeting: aroundNow, holidays: holiday('christmas') });
  try {
    await wait(150);
    assert.strictEqual(s.occasion(), 'birthday');
    assert.strictEqual(s.line(), 'Alles Gute zum Geburtstag, Testkonto!');
    assert.deepStrictEqual(s.worn(), ['birthday']);
    assert.ok(s.cakeOffered());
    assert.strictEqual(s.offered('🎄'), 0);
    assert.ok(s.particles('i') > 0, 'confetti');
    assert.deepStrictEqual(s.errors, []);
  } finally {
    s.window.close();
  }
});

test('holiday: reduced motion keeps costume and line, but no particles', async () => {
  const s = boot({ holidays: holiday('easter'), still: true });
  try {
    await wait(150);
    assert.strictEqual(s.line(), 'Frohe Ostern!');
    assert.deepStrictEqual(s.worn(), ['easter', 'easter']);
    assert.strictEqual(s.particles('i'), 0);
    assert.deepStrictEqual(s.errors, []);
  } finally {
    s.window.close();
  }
});

test('holiday: the seasonal pumpkin is not offered twice in October', async () => {
  const s = boot({ date: [2026, 9, 31], holidays: holiday('halloween') });
  try {
    await wait(150);
    assert.strictEqual(s.occasion(), 'halloween');
    assert.strictEqual(s.offered('🎃'), 1);
    assert.deepStrictEqual(s.errors, []);
  } finally {
    s.window.close();
  }
});

test('holiday: a new game day asks the server again when the app comes back', async () => {
  // First answer: nothing today, stale in 2 h; second answer: a holiday has begun.
  const s = boot({
    holidays: (t0, n) => (n === 1
      ? { windows: [], refreshAt: t0 + 2 * HOUR }
      : { windows: [{ id: 'christmas', from: t0 + HOUR, until: t0 + 30 * HOUR }], refreshAt: t0 + 30 * HOUR }),
  });
  try {
    await wait(150);
    assert.strictEqual(s.occasion(), null);
    assert.strictEqual(s.asked.statusz, 1);
    s.jump(HOUR); // still the same day: no new question
    await wait(50);
    assert.strictEqual(s.asked.statusz, 1);
    s.jump(2 * HOUR); // past midnight
    await wait(150);
    assert.strictEqual(s.asked.statusz, 2);
    assert.strictEqual(s.occasion(), 'christmas');
    assert.deepStrictEqual(s.errors, []);
  } finally {
    s.window.close();
  }
});
