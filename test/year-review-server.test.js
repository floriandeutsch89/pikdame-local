/** The year review through the real server: the review request over the
 *  WebSocket (private cards only for the name's account), the opt-in switch
 *  with its consent version, and the unsubscribe link (GET only asks, POST
 *  switches off - the page's button and the RFC 8058 one-click). */
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { Pool } = require('pg');
const { createPgAccountStore } = require('../game/PgAccountStore');
const { gameDay } = require('../game/GameDay');
const { REVIEW_MAIL_CONSENT_VERSION } = require('../game/YearReviewMail');
const { testDatabaseUrl } = require('./helpers/test-db');

const ROOT = path.join(__dirname, '..');
let PORT = 0;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: data ? { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* html or text */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await request('GET', '/healthz')).status === 200) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
}

function wsAsk(msg, answerType) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { 'User-Agent': 'Mozilla/5.0 (test)' } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`no ${answerType}`)); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type !== answerType) return;
      clearTimeout(timer);
      ws.close();
      resolve(m);
    });
    ws.on('error', reject);
  });
}

test('year review over the WebSocket, opt-in switch and unsubscribe link', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-yrsrv-'));
  const year = gameDay().slice(0, 4);
  // A counted year for "Flo" (years.json), the confirmed accounts Flo and
  // Gerda with sessions, and a known unsubscribe token - before the server starts.
  fs.writeFileSync(path.join(dataDir, 'years.json'), JSON.stringify({
    since: `${year}-01-01`,
    players: { flo: { name: 'Flo', years: { [year]: {
      games: 12, wins: 5, queensLaid: 3, queensCaught: 1, bestRound: 240, bestGame: 1100, handAus: 0, jokers: 9, days: 6,
      lastDay: `${year}-03-01`, bestStreak: 4, opponents: { gerda: { name: 'Gerda', games: 7, wins: 3 } },
      bots: { hard: { games: 5, wins: 2 } }, tables: { familie: { name: 'Familie', games: 4, wins: 2 } },
    } } } },
  }));
  const databaseUrl = testDatabaseUrl('yrsrv');
  const seed = createPgAccountStore(databaseUrl);
  const signUp = async (name) => {
    const reg = await seed.register(name, `${name.toLowerCase()}@example.com`, 'geheim123');
    await seed.verifyEmail(reg.verifyToken);
    return (await seed.login(name, 'geheim123')).token;
  };
  const token = await signUp('Flo');
  const gerdaToken = await signUp('Gerda');
  const acc = await seed.accountForSession(token);
  const unsub = crypto.randomBytes(32).toString('hex');
  await seed.setReviewUnsubHash(acc.id, crypto.createHash('sha256').update(unsub).digest('hex'));
  await seed.close();

  PORT = await freePort();

  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PIKDAME_DATABASE_URL: databaseUrl, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_YEAR_REVIEW_PREVIEW: '1', PIKDAME_PUBLIC_MODE: '', PIKDAME_SMTP_HOST: '' },
    stdio: 'ignore',
  });
  t.after(async () => {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited; // SIGTERM still writes the snapshot into dataDir
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer();

  // Favourite opponent and Stammtisch name only for the account owning the name.
  const ask = (extra) => wsAsk({ type: 'getYearReview', name: 'flo', ...extra }, 'yearReview');
  const owner = await ask({ accountToken: token });
  assert.strictEqual(owner.available, true);
  assert.strictEqual(owner.season, true, 'the preview switch opens the season');
  assert.strictEqual(owner.review.year, year);
  assert.strictEqual(owner.review.totals.games, 12);
  assert.deepStrictEqual(owner.review.favorite, { name: 'Gerda', games: 7, wins: 3 });
  assert.deepStrictEqual(owner.review.table, { name: 'Familie', games: 4, wins: 2 });
  assert.deepStrictEqual(owner.review.bots, [{ level: 'hard', games: 5, wins: 2 }]);
  assert.strictEqual(owner.review.opponents, undefined, 'only the favourite leaves the server, not the list');
  for (const [why, extra] of [['no token', {}], ['a wrong token', { accountToken: 'f'.repeat(64) }], ["another account's token", { accountToken: gerdaToken }]]) {
    const r = await ask(extra);
    assert.strictEqual(r.available, true, why);
    assert.strictEqual(r.review.totals.games, 12, `${why}: the rest of the review stays`);
    assert.deepStrictEqual([r.review.favorite, r.review.table], [null, null], `${why}: no opponent, no Stammtisch name`);
  }
  const nobody = await wsAsk({ type: 'getYearReview', name: 'Niemand' }, 'yearReview');
  assert.deepStrictEqual({ available: nobody.available, review: nobody.review }, { available: false, review: null });

  const methods = async () => (await request('POST', '/api/account/methods', { token })).json;
  assert.strictEqual((await methods()).reviewMail, false, 'off by default');
  assert.strictEqual((await request('POST', '/api/account/review-mail', { enabled: true })).status, 401, 'signed in only');
  assert.strictEqual((await request('POST', '/api/account/review-mail', { token, enabled: 'yes' })).status, 400);
  const on = await request('POST', '/api/account/review-mail', { token, enabled: true, lang: 'en' });
  assert.deepStrictEqual(on.json, { ok: true, enabled: true });
  assert.strictEqual((await methods()).reviewMail, true);
  const raw = new Pool({ connectionString: databaseUrl, max: 1 });
  const consent = (await raw.query('SELECT review_mail_consent AS v FROM users WHERE username = $1', ['Flo'])).rows[0].v;
  await raw.end();
  assert.strictEqual(consent, REVIEW_MAIL_CONSENT_VERSION, 'the opt-in records the consent text version');

  // GET only asks: a link scanner opening the link changes nothing.
  const ask1 = await request('GET', `/unsubscribe?t=${unsub}`);
  assert.strictEqual(ask1.status, 200);
  assert.match(ask1.text, /<html lang="en">/, 'answered in the language of the opt-in');
  assert.match(ask1.text, /Unsubscribe from the year review\?/);
  assert.ok(ask1.text.includes(`<form method="post" action="/unsubscribe?t=${unsub}">`), 'the button posts to the same link');
  assert.doesNotMatch(ask1.text, /<script/i, 'no script: the CSP stays as it is');
  assert.strictEqual((await methods()).reviewMail, true, 'GET leaves the opt-in on');

  // HEAD and a wrong token change nothing either.
  assert.strictEqual((await request('HEAD', `/unsubscribe?t=${unsub}`)).status, 405);
  for (const method of ['GET', 'POST']) {
    const wrong = await request(method, `/unsubscribe?t=${'0'.repeat(64)}`, method === 'POST' ? 'List-Unsubscribe=One-Click' : undefined);
    assert.strictEqual(wrong.status, 400, method);
    assert.match(wrong.text, /ungültig/);
    assert.doesNotMatch(wrong.text, /<form/);
  }
  assert.strictEqual((await methods()).reviewMail, true, 'a wrong token stays neutral');

  // The button on the page: POST switches it off and confirms.
  const off = await request('POST', `/unsubscribe?t=${unsub}`, '');
  assert.strictEqual(off.status, 200);
  assert.match(off.text, /<html lang="en">[\s\S]*Unsubscribed/);
  assert.strictEqual((await methods()).reviewMail, false, 'POST switched it off');
  const again = await request('GET', `/unsubscribe?t=${unsub}`);
  assert.match(again.text, /Already unsubscribed/);
  assert.doesNotMatch(again.text, /<form/, 'nothing left to switch off');

  // RFC 8058 one-click from the mail client: one POST, no page visit.
  await request('POST', '/api/account/review-mail', { token, enabled: true, lang: 'de' });
  const oneClick = await request('POST', `/unsubscribe?t=${unsub}`, 'List-Unsubscribe=One-Click');
  assert.strictEqual(oneClick.status, 200, 'RFC 8058 one-click from the mail client');
  assert.match(oneClick.text, /<html lang="de">[\s\S]*Abbestellt/);
  assert.strictEqual((await methods()).reviewMail, false);
});
