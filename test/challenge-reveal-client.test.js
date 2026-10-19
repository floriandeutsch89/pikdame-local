/** Daily challenge intro: before the own game the board line shows only how
 *  many played; the request proves the name with the account token. Boots the
 *  REAL markup and client in jsdom. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

function boot(board) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const requests = [];
  window.fetch = (url, opts) => {
    requests.push({ url: String(url), headers: (opts && opts.headers) || {} });
    const body = String(url).startsWith('/challengeboardz') ? board : { ok: true };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve('') });
  };
  window.WebSocket = class {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  };
  window.WebSocket.OPEN = 1;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Ada');
  window.localStorage.setItem('pikdame_account_token', 'tok');
  for (const src of ['i18n.js', 'client.js']) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  return { window, doc: window.document, requests, settle, errors };
}

const today = '2026-10-19';
const week = { top: [{ name: 'Yuri', weekScore: 400, days: 1 }] };

test('before the own game: only the count, the week without today, the token goes along', async () => {
  const t = boot({ date: today, revealed: false, players: 12, board: [], magnet: null, you: null, attempted: false, weekly: week, trend: { dates: [], me: null, top: [] } });
  t.doc.getElementById('challengeBtn').click();
  await t.settle();
  const top = t.doc.getElementById('challengeTopLine').textContent;
  assert.match(top, /Die Punkte siehst du nach deinem Spiel/);
  assert.match(top, /schon 12 Leute/);
  assert.match(t.doc.getElementById('challengeWeekLine').textContent, /Yuri – 400 \(ohne heute\)/);
  assert.ok(t.doc.getElementById('challengeMagnetLine').classList.contains('hidden'));
  const req = t.requests.find((r) => r.url.startsWith('/challengeboardz'));
  assert.match(req.url, /name=Ada/);
  assert.strictEqual(req.headers['X-Account-Token'], 'tok');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('after the own game: the board as before', async () => {
  const t = boot({ date: today, revealed: true, players: 2, board: [{ rank: 1, name: 'Anna', score: 310 }, { rank: 2, name: 'Ada', score: 250 }], magnet: null, you: { rank: 2, score: 250, queens: 0, players: 2 }, attempted: true, weekly: week, trend: { dates: [], me: null, top: [] } });
  t.doc.getElementById('challengeBtn').click();
  await t.settle();
  assert.match(t.doc.getElementById('challengeTopLine').textContent, /Anna – 310 Punkte {2}· {2}🥈 Ada – 250/);
  assert.doesNotMatch(t.doc.getElementById('challengeWeekLine').textContent, /ohne heute/);
  assert.ok(!t.doc.getElementById('challengePlayedNote').classList.contains('hidden'));
  t.window.close();
});

test('nobody played yet: the old invitation, nothing to hide', async () => {
  const t = boot({ date: today, revealed: false, players: 0, board: [], magnet: null, you: null, attempted: false, weekly: { top: [] }, trend: { dates: [], me: null, top: [] } });
  t.doc.getElementById('challengeBtn').click();
  await t.settle();
  assert.match(t.doc.getElementById('challengeTopLine').textContent, /Noch niemand/);
  t.window.close();
});
