// Holiday decor days: which game days they are, the windows the server sends
// (today and tomorrow only, German game day) and /statusz carrying them.
const test = require('node:test');
const { freePort } = require('./helpers/free-port');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { HOLIDAY_IDS, holidayFor, holidayWindows, holidayStatus } = require('../game/Holidays');
const { HOLIDAY_EMOTES, isAllowedEmote, emoteLevel } = require('../game/Emotes');
const { testDatabaseUrl } = require('./helpers/test-db');

const HOUR = 60 * 60 * 1000;
const at = (iso) => Date.parse(iso);

test('holidays: the fixed days, and nothing around them', () => {
  const days = {
    '2026-10-31': 'halloween', '2026-12-06': 'nikolaus', '2026-12-24': 'christmas', '2026-12-25': 'christmas',
    '2026-12-26': 'christmas', '2026-12-31': 'silvester', '2027-01-01': 'newyear',
  };
  for (const [date, id] of Object.entries(days)) assert.strictEqual(holidayFor(date), id, date);
  for (const date of ['2026-10-30', '2026-11-01', '2026-12-05', '2026-12-07', '2026-12-23', '2026-12-27', '2026-12-30', '2027-01-02']) {
    assert.strictEqual(holidayFor(date), null, date);
  }
  assert.strictEqual(holidayFor(''), null);
  assert.strictEqual(holidayFor('12-24'), null);
});

test('holidays: Easter is Sunday and Monday, never Good Friday or Saturday (2026-2030)', () => {
  const sundays = { 2026: '2026-04-05', 2027: '2027-03-28', 2028: '2028-04-16', 2029: '2029-04-01', 2030: '2030-04-21' };
  const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 24 * HOUR).toISOString().slice(0, 10);
  for (const sunday of Object.values(sundays)) {
    assert.strictEqual(holidayFor(sunday), 'easter', sunday);
    assert.strictEqual(holidayFor(shift(sunday, 1)), 'easter', `${sunday} + 1`);
    assert.strictEqual(holidayFor(shift(sunday, -2)), null, `Good Friday before ${sunday}`);
    assert.strictEqual(holidayFor(shift(sunday, -1)), null, `Saturday before ${sunday}`);
    assert.strictEqual(holidayFor(shift(sunday, 2)), null, `Tuesday after ${sunday}`);
  }
});

test('holidays: windows cover the German game day, today and tomorrow only', () => {
  // Two days ahead stays unannounced, one day ahead is announced for midnight.
  assert.deepStrictEqual(holidayWindows(at('2026-10-29T12:00:00Z')), []);
  assert.deepStrictEqual(holidayWindows(at('2026-10-30T12:00:00Z')), [
    { id: 'halloween', from: at('2026-10-30T23:00:00Z'), until: at('2026-10-31T23:00:00Z') },
  ]);
  // 00:30 in Berlin on 1 November is past Halloween while UTC still says the 31st.
  assert.deepStrictEqual(holidayWindows(at('2026-10-31T23:30:00Z')), []);
  // Three Christmas days in a row: today and tomorrow, one entry each.
  assert.deepStrictEqual(holidayWindows(at('2026-12-24T10:00:00Z')).map((w) => w.id), ['christmas', 'christmas']);
  assert.deepStrictEqual(holidayWindows(at('2026-12-26T10:00:00Z')).map((w) => w.id), ['christmas']);
});

test('holidays: New Year\'s Eve hands over to New Year across the year boundary', () => {
  const w = holidayWindows(at('2026-12-31T12:00:00Z'));
  assert.deepStrictEqual(w, [
    { id: 'silvester', from: at('2026-12-30T23:00:00Z'), until: at('2026-12-31T23:00:00Z') },
    { id: 'newyear', from: at('2026-12-31T23:00:00Z'), until: at('2027-01-01T23:00:00Z') },
  ]);
  assert.strictEqual(w[0].until, w[1].from, 'no gap at midnight');
});

test('holidays: the status goes stale at the next German midnight', () => {
  assert.deepStrictEqual(holidayStatus(at('2026-12-31T12:00:00Z')), {
    windows: holidayWindows(at('2026-12-31T12:00:00Z')), refreshAt: at('2026-12-31T23:00:00Z'),
  });
  // Summer time: midnight is 22:00 UTC.
  assert.strictEqual(holidayStatus(at('2026-07-01T21:30:00Z')).refreshAt, at('2026-07-01T22:00:00Z'));
  assert.deepStrictEqual(holidayStatus(at('2026-07-01T21:30:00Z')).windows, []);
});

test('holidays: Easter on a DST day is 23 hours long', () => {
  // 2027: Easter Sunday is the day the clocks go forward.
  const [sunday, monday] = holidayWindows(at('2027-03-28T10:00:00Z'));
  assert.strictEqual(sunday.id, 'easter');
  assert.strictEqual(sunday.until - sunday.from, 23 * HOUR);
  assert.strictEqual(monday.until - monday.from, 24 * HOUR);
  assert.strictEqual(sunday.from, at('2027-03-27T23:00:00Z'));
});

test('holidays: every holiday has an emote the whitelist accepts, never level-locked', () => {
  assert.deepStrictEqual(Object.keys(HOLIDAY_EMOTES).sort(), [...HOLIDAY_IDS].sort());
  for (const emoji of Object.values(HOLIDAY_EMOTES)) {
    assert.ok(isAllowedEmote(emoji), emoji);
    assert.strictEqual(emoteLevel(emoji), 1, emoji);
  }
  // The client keeps its own copy for the emote bar; both must agree.
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const m = client.match(/const HOLIDAY_EMOTES = (\{[^}]*\});/);
  assert.ok(m, 'client.js declares HOLIDAY_EMOTES');
  assert.deepStrictEqual(Function(`return ${m[1]}`)(), HOLIDAY_EMOTES);
});

test('holidays: every occasion icon and particle shape exists in the sprite, every holiday has a costume', () => {
  // The client sets these at runtime, so the static icon contract cannot see them.
  const pub = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
  const symbols = new Set([...html.matchAll(/<symbol id="(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
  const block = client.slice(client.indexOf('const OCCASIONS = {'), client.indexOf('function setGreeting('));
  const icons = [...block.matchAll(/icon: '(i-[a-z0-9-]+)'/g)].map((m) => m[1]);
  const shapes = [...client.matchAll(/piece\([^;]*?, '(i-[a-z0-9-]+)'\)/g)].map((m) => m[1]);
  assert.strictEqual(icons.length, HOLIDAY_IDS.length + 1, 'one icon per holiday plus the greeting day');
  assert.ok(shapes.length >= 3);
  for (const id of [...icons, ...shapes]) assert.ok(symbols.has(id), `${id} is in the sprite`);
  const costumes = [...html.matchAll(/class="heroCostume" data-for="([^"]+)"/g)].flatMap((m) => m[1].split(' '));
  for (const id of [...HOLIDAY_IDS, 'birthday']) assert.ok(costumes.includes(id), `${id} has a costume`);
});

test('holidays: /statusz carries the windows for every client, no account needed', async (t) => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-holidays-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PIKDAME_DATABASE_URL: testDatabaseUrl('holidays'), PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ACCOUNTS: '0', PIKDAME_SMTP_HOST: '', PIKDAME_ADMIN_TOKEN: '' },
    stdio: 'ignore',
  });
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const get = () => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/statusz' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  let status = null;
  for (let i = 0; !status; i++) {
    try { status = await get(); } catch (e) {
      if (i > 150) throw new Error('server did not come up');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(Array.isArray(status.occasions.windows), 'always a list, usually empty');
  assert.deepStrictEqual(status.occasions, holidayStatus());
});
