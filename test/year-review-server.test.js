/** The year review through the real server: the review request over the
 *  WebSocket, the opt-in switch of the account API and the unsubscribe link
 *  (GET from the mail text, POST as RFC 8058 one-click, HEAD changes nothing). */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { createAccountStore } = require('../game/AccountStore');
const { gameDay } = require('../game/GameDay');

const ROOT = path.join(__dirname, '..');
const PORT = 8137;
const HAS_SQLITE = (() => {
  try { require('node:sqlite'); return true; } catch (e) { return false; }
})();

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

test('year review over the WebSocket, opt-in switch and unsubscribe link', { skip: !HAS_SQLITE }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-yrsrv-'));
  const year = gameDay().slice(0, 4);
  // A counted year for "Flo" (years.json) and a confirmed account with a
  // session and a known unsubscribe token, written before the server starts.
  fs.writeFileSync(path.join(dataDir, 'years.json'), JSON.stringify({
    since: `${year}-01-01`,
    players: { flo: { name: 'Flo', years: { [year]: {
      games: 12, wins: 5, queensLaid: 3, queensCaught: 1, bestRound: 240, bestGame: 1100, handAus: 0, jokers: 9, days: 6,
      lastDay: `${year}-03-01`, bestStreak: 4, opponents: { gerda: { name: 'Gerda', games: 7, wins: 3 } },
      bots: { hard: { games: 5, wins: 2 } }, tables: {},
    } } } },
  }));
  const seed = createAccountStore(path.join(dataDir, 'users.db'));
  const reg = await seed.register('Flo', 'flo@example.com', 'geheim123');
  await seed.verifyEmail(reg.verifyToken);
  const token = (await seed.login('Flo', 'geheim123')).token;
  const acc = await seed.accountForSession(token);
  const unsub = crypto.randomBytes(32).toString('hex');
  await seed.setReviewUnsubHash(acc.id, crypto.createHash('sha256').update(unsub).digest('hex'));
  await seed.close();

  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_YEAR_REVIEW_PREVIEW: '1', PIKDAME_PUBLIC_MODE: '', PIKDAME_SMTP_HOST: '' },
    stdio: 'ignore',
  });
  t.after(async () => {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited; // SIGTERM still writes the snapshot into dataDir
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer();

  const mine = await wsAsk({ type: 'getYearReview', name: 'flo' }, 'yearReview');
  assert.strictEqual(mine.available, true);
  assert.strictEqual(mine.season, true, 'the preview switch opens the season');
  assert.strictEqual(mine.review.year, year);
  assert.strictEqual(mine.review.totals.games, 12);
  assert.deepStrictEqual(mine.review.favorite, { name: 'Gerda', games: 7, wins: 3 });
  assert.deepStrictEqual(mine.review.bots, [{ level: 'hard', games: 5, wins: 2 }]);
  assert.strictEqual(mine.review.table, null);
  assert.strictEqual(mine.review.opponents, undefined, 'only the favourite leaves the server, not the list');
  const nobody = await wsAsk({ type: 'getYearReview', name: 'Niemand' }, 'yearReview');
  assert.deepStrictEqual({ available: nobody.available, review: nobody.review }, { available: false, review: null });

  const methods = async () => (await request('POST', '/api/account/methods', { token })).json;
  assert.strictEqual((await methods()).reviewMail, false, 'off by default');
  assert.strictEqual((await request('POST', '/api/account/review-mail', { enabled: true })).status, 401, 'signed in only');
  assert.strictEqual((await request('POST', '/api/account/review-mail', { token, enabled: 'yes' })).status, 400);
  const on = await request('POST', '/api/account/review-mail', { token, enabled: true, lang: 'en' });
  assert.deepStrictEqual(on.json, { ok: true, enabled: true });
  assert.strictEqual((await methods()).reviewMail, true);

  // HEAD (link checkers) and a wrong token change nothing.
  assert.strictEqual((await request('HEAD', `/unsubscribe?t=${unsub}`)).status, 405);
  const wrong = await request('GET', `/unsubscribe?t=${'0'.repeat(64)}`);
  assert.strictEqual(wrong.status, 400);
  assert.match(wrong.text, /ungültig/);
  assert.strictEqual((await methods()).reviewMail, true);

  const off = await request('GET', `/unsubscribe?t=${unsub}`);
  assert.strictEqual(off.status, 200);
  assert.match(off.text, /<html lang="en">/, 'answered in the language of the opt-in');
  assert.match(off.text, /Unsubscribed/);
  assert.strictEqual((await methods()).reviewMail, false, 'the link switched it off');

  await request('POST', '/api/account/review-mail', { token, enabled: true, lang: 'de' });
  const oneClick = await request('POST', `/unsubscribe?t=${unsub}`, 'List-Unsubscribe=One-Click');
  assert.deepStrictEqual([oneClick.status, oneClick.text], [200, 'OK'], 'RFC 8058 one-click from the mail client');
  assert.strictEqual((await methods()).reviewMail, false);
  assert.strictEqual((await request('POST', `/unsubscribe?t=${'f'.repeat(64)}`, 'List-Unsubscribe=One-Click')).status, 400);
});
