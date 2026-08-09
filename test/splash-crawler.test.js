/** The studio intro used to cover the page for search engines: the Search
 *  Console live test renders exactly the first frame, so Googlebot saw the
 *  logo and never the lobby or the SEO section. Two pieces must agree - the
 *  head pre-check in index.html sets html.noSplash, and client.js drops the
 *  overlay out of the document when it sees that class. These tests boot the
 *  REAL files, because a comment is not a guarantee. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

/** The one inline <script> in the head - the pre-first-paint decision. */
const headScript = (() => {
  const m = html.match(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, 'inline head script not found in index.html');
  return m[1];
})();

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BINGBOT = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

/** Google fetches the page under SEVERAL names, and only some carry 'bot'.
 *  The first fix matched /bot/ and therefore still showed the logo to exactly
 *  the agent one uses to check the fix - the URL inspector of the Search
 *  Console. Verified against the live site on 2026-08-09. */
const NON_BOT_AGENTS = {
  // Search Console "Live-Test" and the rich results test.
  'Google-InspectionTool':
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 (compatible; Google-InspectionTool/1.0)',
  'GoogleOther': 'Mozilla/5.0 (compatible; GoogleOther)',
  'Google-Extended': 'Mozilla/5.0 (compatible; Google-Extended)',
  'Google-Site-Verification': 'Mozilla/5.0 (compatible; Google-Site-Verification/1.0)',
  // Link previews: same problem, same consequence (a shared link shows a logo).
  'facebookexternalhit': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'WhatsApp': 'WhatsApp/2.23.20.0',
};

/** Boots a jsdom with the real markup, then runs the head script (and
 *  optionally the whole client) exactly as a browser would. */
function boot({ userAgent, reduceMotion = false, storage = {}, session = {}, withClient = false }) {
  const dom = new JSDOM(html, {
    url: 'https://play.example/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
    },
  });
  const { window } = dom;
  window.matchMedia = (q) => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(q) ? reduceMotion : false,
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(session)) window.sessionStorage.setItem(k, v);

  window.eval(headScript);

  if (withClient) {
    window.navigator.vibrate = () => true;
    let rafDepth = 0;
    window.requestAnimationFrame = (cb) => {
      if (rafDepth > 4) return 0;
      rafDepth += 1;
      try { cb(Date.now()); } finally { rafDepth -= 1; }
      return 0;
    };
    window.scrollTo = () => {};
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
    window.WebSocket = class {
      constructor() { this.readyState = 1; }
      addEventListener() {} removeEventListener() {} send() {} close() {}
    };
    for (const src of ['i18n.js', 'client.js']) {
      window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
    }
  }
  return window;
}

const skipped = (w) => w.document.documentElement.classList.contains('noSplash');

test('crawlers skip the intro: Googlebot and bingbot get html.noSplash', () => {
  for (const ua of [GOOGLEBOT, BINGBOT]) {
    assert.strictEqual(skipped(boot({ userAgent: ua })), true, `intro not skipped for ${ua}`);
  }
});

test('crawlers WITHOUT "bot" in the name skip the intro too', () => {
  for (const [name, ua] of Object.entries(NON_BOT_AGENTS)) {
    assert.strictEqual(skipped(boot({ userAgent: ua })), true, `intro not skipped for ${name}`);
  }
});

test('a normal first visit still shows the intro', () => {
  for (const ua of [IPHONE, ANDROID_CHROME]) {
    assert.strictEqual(skipped(boot({ userAgent: ua })), false, `intro wrongly skipped for ${ua}`);
  }
});

test('prefers-reduced-motion skips the intro, an explicit "full" setting overrides it', () => {
  assert.strictEqual(skipped(boot({ userAgent: IPHONE, reduceMotion: true })), true);
  assert.strictEqual(
    skipped(boot({ userAgent: IPHONE, reduceMotion: true, storage: { pikdame_studio_logo: 'full' } })),
    false,
    "an explicit 'full' choice must still play the intro"
  );
});

test('the existing reasons to skip keep working (already seen, switched off)', () => {
  assert.strictEqual(skipped(boot({ userAgent: IPHONE, session: { pikdame_splash_seen: '1' } })), true);
  assert.strictEqual(skipped(boot({ userAgent: IPHONE, storage: { pikdame_studio_logo: 'off' } })), true);
});

test('the head pre-check writes nothing to storage', () => {
  for (const ua of [GOOGLEBOT, IPHONE]) {
    const w = boot({ userAgent: ua });
    assert.strictEqual(w.sessionStorage.length, 0, `sessionStorage was written for ${ua}`);
    assert.strictEqual(w.localStorage.length, 0, `localStorage was written for ${ua}`);
  }
});

test('the head pre-check leaks no globals into window', () => {
  const w = boot({ userAgent: GOOGLEBOT });
  for (const name of ['bot', 'ua', 'reduce', 'seen', 'mode']) {
    assert.ok(!(name in w) || typeof w[name] === 'undefined', `head script leaked window.${name}`);
  }
});

test('a crawler boot leaves NO intro in the document and marks nothing as seen', () => {
  const w = boot({ userAgent: NON_BOT_AGENTS['Google-InspectionTool'], withClient: true });
  assert.strictEqual(w.document.getElementById('studioSplash'), null, 'the intro is still in the DOM');
  assert.strictEqual(
    w.sessionStorage.getItem('pikdame_splash_seen'), null,
    'a crawler must not mark the intro as seen - the next real visitor would lose it'
  );
  // What the crawler must actually find: the lobby and the SEO copy.
  assert.ok(w.document.querySelector('#lobby h1'), 'lobby heading missing');
  assert.ok(w.document.querySelector('.seoIntro'), 'SEO section missing');
  assert.match(w.document.querySelector('#lobby').textContent, /Pik Dame/);
});

test('a normal visitor still gets the intro, and it is marked as seen', () => {
  const w = boot({ userAgent: IPHONE, withClient: true });
  const splash = w.document.getElementById('studioSplash');
  assert.ok(splash, 'the intro was removed for a normal first visit');
  assert.ok(splash.classList.contains('play'), 'the intro animation was not started');
  assert.strictEqual(w.sessionStorage.getItem('pikdame_splash_seen'), '1');
});
