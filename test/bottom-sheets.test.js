/** Phone dialogs are bottom sheets (v2.63). Swiping one down presses the
 *  dialog's OWN close button (data-sheet-close), so the gesture can never
 *  dismiss something a tap could not: round end, pause and cutting have none.
 *  The behaviour tests boot the REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const SHEET_QUERY = '(max-width: 600px) and (orientation: portrait)';

const overlays = [...html.matchAll(/<section id="(\w+Overlay)" class="overlay[^"]*"([^>]*)>([\s\S]*?)<\/section>/g)]
  .map(([, id, attrs, body]) => ({ id, close: (attrs.match(/data-sheet-close="([^"]*)"/) || [])[1] || null, body }));

test('sheet contract: each swipe target is a button of its own dialog', () => {
  assert.ok(overlays.length > 15, 'overlays found');
  for (const o of overlays.filter((x) => x.close)) {
    assert.match(o.body, new RegExp(`<button[^>]*id="${o.close}"`), `#${o.id}: data-sheet-close must name a button inside it`);
  }
});

test('sheet contract: dialogs without a way out stay without the gesture', () => {
  for (const id of ['resultOverlay', 'pauseOverlay', 'cutOverlay']) {
    const o = overlays.find((x) => x.id === id);
    assert.ok(o, `#${id} exists`);
    assert.strictEqual(o.close, null, `#${id} has no close button, so no swipe either`);
  }
});

test('sheet contract: a dialog with a close or cancel button declares it', () => {
  for (const o of overlays) {
    if (/<button[^>]*id="\w+(Close|Cancel|No)Btn"/.test(o.body)) {
      assert.ok(o.close, `#${o.id} has a close/cancel button but no data-sheet-close`);
    }
  }
});

function boot({ sheet = true } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({
    matches: sheet && q === SHEET_QUERY, media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  window.WebSocket = class {
    constructor() { this.readyState = 1; }
    addEventListener() {} removeEventListener() {} send() {} close() {}
  };
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  return { window, doc: window.document, errors };
}

// jsdom has no Touch constructor; the handlers only read touches[0].clientX/Y.
function touch(window, target, type, x, y) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
  target.dispatchEvent(ev);
  return ev;
}
function swipe(window, target, dy) {
  touch(window, target, 'touchstart', 100, 300);
  touch(window, target, 'touchmove', 100, 310);
  const move = touch(window, target, 'touchmove', 100, 300 + dy);
  touch(window, target, 'touchend', 100, 300 + dy);
  return move;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('swiping a sheet down presses its close button', async () => {
  const { window, doc, errors } = boot();
  try {
    const overlay = doc.getElementById('botDiffOverlay');
    overlay.classList.remove('hidden');
    const card = overlay.querySelector('.overlay-card');
    assert.ok(card.querySelector('.sheetGrabber'), 'dismissible sheet gets a grip');
    const move = swipe(window, card.querySelector('h2'), 260);
    assert.ok(move.defaultPrevented, 'the sheet follows the finger instead of the page scrolling');
    await wait(250);
    assert.ok(overlay.classList.contains('hidden'), 'closed through its own button');
    assert.strictEqual(card.style.transform, '', 'transform reset for the next opening');
    assert.deepStrictEqual(errors, []);
  } finally {
    window.close();
  }
});

test('a short pull snaps back and leaves the sheet open', async () => {
  const { window, doc, errors } = boot();
  try {
    const overlay = doc.getElementById('gameSettingsOverlay');
    overlay.classList.remove('hidden');
    const card = overlay.querySelector('.overlay-card');
    Object.defineProperty(card, 'offsetHeight', { value: 600 });
    const grip = card.querySelector('.sheetGrabber');
    touch(window, grip, 'touchstart', 100, 300);
    touch(window, grip, 'touchmove', 100, 312);
    await wait(120); // slow, so not a flick
    touch(window, grip, 'touchmove', 100, 330);
    touch(window, grip, 'touchend', 100, 330);
    await wait(300);
    assert.ok(!overlay.classList.contains('hidden'), 'still open');
    assert.strictEqual(card.style.transform, '', 'back in place');
    assert.deepStrictEqual(errors, []);
  } finally {
    window.close();
  }
});

test('the round result has no grip and ignores the gesture', async () => {
  const { window, doc, errors } = boot();
  try {
    const overlay = doc.getElementById('resultOverlay');
    overlay.classList.remove('hidden');
    const card = overlay.querySelector('.overlay-card');
    assert.strictEqual(card.querySelector('.sheetGrabber'), null);
    const move = swipe(window, card, 300);
    assert.ok(!move.defaultPrevented, 'no drag started');
    await wait(250);
    assert.ok(!overlay.classList.contains('hidden'), 'stays open');
    assert.deepStrictEqual(errors, []);
  } finally {
    window.close();
  }
});

test('sideways or upward moves and the non-sheet layouts leave scrolling alone', async () => {
  const phone = boot();
  try {
    const overlay = phone.doc.getElementById('rulesOverlay');
    overlay.classList.remove('hidden');
    const h2 = overlay.querySelector('h2');
    touch(phone.window, h2, 'touchstart', 100, 300);
    assert.ok(!touch(phone.window, h2, 'touchmove', 160, 310).defaultPrevented, 'sideways');
    touch(phone.window, h2, 'touchend', 160, 310);
    touch(phone.window, h2, 'touchstart', 100, 300);
    assert.ok(!touch(phone.window, h2, 'touchmove', 100, 200).defaultPrevented, 'upward');
    touch(phone.window, h2, 'touchend', 100, 200);
    await wait(250);
    assert.ok(!overlay.classList.contains('hidden'));
    assert.deepStrictEqual(phone.errors, []);
  } finally {
    phone.window.close();
  }
  const wide = boot({ sheet: false });
  try {
    const overlay = wide.doc.getElementById('rulesOverlay');
    overlay.classList.remove('hidden');
    const move = swipe(wide.window, overlay.querySelector('h2'), 300);
    assert.ok(!move.defaultPrevented, 'landscape/desktop: centred card, no drag');
    await wait(250);
    assert.ok(!overlay.classList.contains('hidden'));
    assert.deepStrictEqual(wide.errors, []);
  } finally {
    wide.window.close();
  }
});
