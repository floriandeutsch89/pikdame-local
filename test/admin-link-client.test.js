/** The admin link in the account sheet: only for an account the server calls admin
 *  (/api/me isAdmin), gone on sign-out, a plain link to /admin (the server checks
 *  the role again and asks for the step-up). Boots the REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot({ me = {}, signedIn = true, lang = null } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, { url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  const answer = (url) => {
    if (url === '/statusz') return { accountsEnabled: true };
    if (url === '/api/me') return { ok: true, username: 'Chefin', ...me };
    return { ok: true };
  };
  window.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(answer(url)), text: () => Promise.resolve('') });
  window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };
  window.WebSocket.OPEN = 1;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Chefin');
  if (signedIn) window.localStorage.setItem('pikdame_account_token', 'tok');
  if (lang) window.localStorage.setItem('pikdame_lang', lang);
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  return { window, doc: window.document, settle, errors, link: () => window.document.getElementById('accAdminLink') };
}

test('the admin link shows only for an admin account and leads to /admin', async () => {
  const admin = boot({ me: { isAdmin: true } });
  await admin.settle();
  const link = admin.link();
  assert.strictEqual(link.classList.contains('hidden'), false);
  assert.strictEqual(link.tagName, 'A');
  assert.strictEqual(link.getAttribute('href'), '/admin', 'no token in the address - the step-up page reads the sign-in itself');
  assert.strictEqual(link.getAttribute('target'), null, 'same tab: an iPhone home-screen app keeps its storage');
  assert.ok(link.querySelector('svg.icon use[href="#i-shield"]'), 'an icon from the sprite, the label in its own span');
  assert.strictEqual(link.querySelector('span').textContent, 'Admin-Bereich');
  // Signing out takes it away.
  admin.doc.getElementById('accLogoutBtn').click();
  await admin.settle();
  assert.strictEqual(admin.link().classList.contains('hidden'), true);
  assert.deepStrictEqual(admin.errors, []);
  admin.window.close();

  for (const t of [boot({ me: { isAdmin: false } }), boot({ me: {} }), boot({ signedIn: false, me: { isAdmin: true } })]) {
    await t.settle();
    assert.strictEqual(t.link().classList.contains('hidden'), true, 'players, older servers and guests see no link');
    t.window.close();
  }
});

test('the admin link speaks English too', async () => {
  const en = boot({ me: { isAdmin: true }, lang: 'en' });
  await en.settle();
  assert.strictEqual(en.link().querySelector('span').textContent, 'Admin area');
  en.window.close();
});
