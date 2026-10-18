/** The year-review mail: composed in the account's language with an
 *  unsubscribe link in every mail, due from 27 December 10:00 German time,
 *  and sent once per account and year - across ticks and restarts. */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { composeReviewMail, sampleReview, dueYear, createYearReviewMailer, REVIEW_MAIL_CONSENT_VERSION } = require('../game/YearReviewMail');
const { Pool } = require('pg');
const { createPgAccountStore } = require('../game/PgAccountStore');
const { testDatabaseUrl } = require('./helpers/test-db');

test('the consent version names the German opt-in text: new wording, new version', () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const box = new JSDOM(html).window.document.getElementById('accountMailPrefs');
  const text = [...box.querySelectorAll('.settingsLabel, .settingsHint')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join('\n');
  assert.match(text, /^Jahresrückblick per E-Mail\nEinmal im Jahr/, 'label and hint found');
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  assert.match(REVIEW_MAIL_CONSENT_VERSION, /^\d{4}-\d{2}-\d{2}\.[0-9a-f]{8}$/);
  assert.strictEqual(REVIEW_MAIL_CONSENT_VERSION.split('.')[1], hash,
    `the opt-in text changed: give REVIEW_MAIL_CONSENT_VERSION (game/YearReviewMail.js) today's date and the hash ${hash}`);
});

const BASE = 'https://play.example';
const URLS = { appUrl: `${BASE}/?jahr=2026`, unsubscribeUrl: `${BASE}/unsubscribe?t=${'a'.repeat(64)}` };
const at = (iso) => Date.parse(iso);

test('the mail carries the facts, the app link and the unsubscribe link - in text and HTML', () => {
  const m = composeReviewMail({ review: sampleReview('2026'), name: 'Flo', lang: 'de', ...URLS });
  assert.strictEqual(m.subject, 'Dein Pik-Dame-Jahr 2026');
  for (const part of [m.text, m.html]) {
    assert.ok(part.includes(URLS.unsubscribeUrl), 'unsubscribe link');
    assert.ok(part.includes(URLS.appUrl), 'link into the game');
    assert.match(part, /87 Partien Pik Dame, 34 davon gewonnen \(39 %\)/);
    assert.match(part, /Die Pik Dame hast du 21-mal gerettet/);
    assert.match(part, /Oma Gerda/);
    assert.match(part, /Donnerstagsrunde/);
    assert.match(part, /Gegen die Zen-Bots: 3 Siege in 12 Partien/, 'the strongest level played');
    assert.match(part, /11 Tage am Stück/);
    assert.match(part, /Gut Blatt für 2027/);
  }
  assert.match(m.text, /^Hallo Flo,/);
  assert.match(m.html, /<html lang="de">/);

  const en = composeReviewMail({ review: sampleReview('2026'), name: 'Flo', lang: 'en', ...URLS });
  assert.strictEqual(en.subject, 'Your Pik Dame year 2026');
  assert.match(en.text, /87 games of Pik Dame, 34 of them won \(39 %\)/);
  assert.match(en.html, />Unsubscribe</);
  assert.doesNotMatch(en.text, /Partie|gewonnen/, 'no German in the English mail');
});

test('missing facts are left out, names are escaped, praise follows the win rate', () => {
  const review = {
    year: '2026', totals: { games: 4, wins: 0, queensLaid: 0, queensCaught: 0, bestRound: 0, bestGame: 120, handAus: 0, jokers: 0, bestStreak: 1 },
    totalsSince: '2026-10-17', breakdownSince: '2026-10-17', activeDays: 2, favorite: null, bots: [], table: null,
  };
  const m = composeReviewMail({ review, name: '<b>Max & Co</b>', lang: 'de', ...URLS });
  assert.doesNotMatch(m.text, /Pik Dame hast du|beste Runde|häufigsten|Bots|Serie|Stammtisch/);
  assert.match(m.text, /Dabei sein ist alles/);
  assert.match(m.text, /\(Gezählt seit dem 17\. Oktober\.\)/, 'a year counted from mid-October says so');
  assert.ok(m.html.includes('Hallo &lt;b&gt;Max &amp; Co&lt;/b&gt;,'), 'the name is escaped in HTML');
  assert.ok(!m.html.includes('<b>Max'), 'no markup from a player name');

  const verdict = (wins) => composeReviewMail({ review: { ...review, totals: { ...review.totals, wins } }, name: 'X', ...URLS }).text;
  assert.match(verdict(2), /Die Katze nickt anerkennend/, '50 %');
  assert.match(verdict(1), /Solide\. Die Katze schnurrt/, '25 %');
});

test('due from 27 December 10:00 German time until New Year, never before', () => {
  assert.strictEqual(dueYear(at('2026-12-27T08:59:00Z')), null, '09:59 CET');
  assert.strictEqual(dueYear(at('2026-12-27T09:00:00Z')), '2026', '10:00 CET');
  assert.strictEqual(dueYear(at('2026-12-26T22:00:00Z')), null, '23:00 on the 26th in Germany');
  assert.strictEqual(dueYear(at('2026-12-31T22:59:00Z')), '2026', 'New Year’s Eve 23:59');
  assert.strictEqual(dueYear(at('2026-12-31T23:00:00Z')), null, 'midnight in Germany: a new year');
  assert.strictEqual(dueYear(at('2026-11-27T12:00:00Z')), null);
  assert.strictEqual(dueYear(at('2027-12-28T12:00:00Z')), '2027');
});

/** Real account store on its own schema, a recording mailer, reviews only for the names in `played`. */
function setup(t) {
  const url = testDatabaseUrl('yrmail');
  const pool = new Pool({ connectionString: url, max: 1 });
  t.after(() => pool.end());
  const env = { url, sql: async (q, params) => (await pool.query(q, params)).rows, store: createPgAccountStore(url), sent: [], played: new Set(['Anna']), result: { delivered: true }, logs: [] };
  env.mailer = { send: async (m) => { env.sent.push(m); return env.result; } };
  env.make = () => createYearReviewMailer({
    accountStore: env.store, mailer: env.mailer, baseUrl: BASE, log: (l) => env.logs.push(l),
    reviewFor: (name, year) => (env.played.has(name) ? { ...sampleReview(year), name } : null),
  });
  return env;
}
async function account(env, name, { verify = true, optIn = true, lang = 'de' } = {}) {
  const r = await env.store.register(name, `${name.toLowerCase()}@example.com`, 'geheim123');
  assert.ok(r.ok, JSON.stringify(r));
  if (!verify) {
    await env.sql('UPDATE users SET review_mail = TRUE WHERE username = $1', [name]);
    return null;
  }
  await env.store.verifyEmail(r.verifyToken);
  const acc = await env.store.accountForSession((await env.store.login(name, 'geheim123')).token);
  if (optIn) await env.store.setReviewMail(acc.id, true, lang);
  return acc;
}

test('sends once per account and year: opted-in and verified only, nothing without a game', async (t) => {
  const env = setup(t);
  await account(env, 'Anna', { lang: 'en' });
  await account(env, 'Bert'); // opted in, but no game this year
  await account(env, 'Cleo', { optIn: false });
  await account(env, 'Dora', { verify: false }); // flag set in the database, never confirmed

  const mailer = env.make();
  assert.strictEqual((await mailer.tick(at('2026-12-27T08:59:00Z'))).year, null);
  assert.strictEqual(env.sent.length, 0, 'not before 10:00');

  const first = await mailer.tick(at('2026-12-27T09:00:00Z'));
  assert.deepStrictEqual(first, { year: '2026', sent: 1, skipped: 1, failed: 0 });
  assert.strictEqual(env.sent.length, 1);
  const mail = env.sent[0];
  assert.strictEqual(mail.to, 'anna@example.com');
  assert.strictEqual(mail.subject, 'Your Pik Dame year 2026', 'in the language chosen at opt-in');
  const token = (mail.headers['List-Unsubscribe'].match(/^<https:\/\/play\.example\/unsubscribe\?t=([a-f0-9]{64})>$/) || [])[1];
  assert.ok(token, `one-click link in the header: ${mail.headers['List-Unsubscribe']}`);
  assert.strictEqual(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(mail.text.includes(`/unsubscribe?t=${token}`) && mail.html.includes(`/unsubscribe?t=${token}`), 'and in both bodies');

  await mailer.tick(at('2026-12-27T09:10:00Z'));
  await mailer.tick(at('2026-12-31T20:00:00Z'));
  assert.strictEqual(env.sent.length, 1, 'later ticks send nothing again');

  // A restart: new store connection, new sender - the database remembers.
  await env.store.close();
  env.store = createPgAccountStore(env.url);
  await env.make().tick(at('2026-12-28T09:00:00Z'));
  assert.strictEqual(env.sent.length, 1, 'no second mail after a restart');

  // The link from the mail switches it off; next year Bert (who played) gets his.
  assert.deepStrictEqual(await env.store.unsubscribeReviewMail(token), { ok: true, username: 'Anna', lang: 'en' });
  env.played.add('Bert');
  const next = await env.make().tick(at('2027-12-27T09:30:00Z'));
  assert.deepStrictEqual(env.sent.slice(1).map((m) => m.to), ['bert@example.com']);
  assert.strictEqual(next.sent, 1);
  await env.store.close();
});

test('every mail gets a fresh link; only its hash is stored', async (t) => {
  const env = setup(t);
  await account(env, 'Anna');
  await env.make().tick(at('2026-12-27T10:00:00Z'));
  await env.make().tick(at('2027-12-27T10:00:00Z'));
  const tokens = env.sent.map((m) => m.headers['List-Unsubscribe'].match(/t=([a-f0-9]{64})/)[1]);
  assert.strictEqual(tokens.length, 2);
  assert.notStrictEqual(tokens[0], tokens[1]);
  assert.deepStrictEqual(await env.store.unsubscribeReviewMail(tokens[0]), { error: 'invalid' }, 'the old link is replaced');
  const [row] = await env.sql('SELECT review_unsub_hash FROM users WHERE username = $1', ['Anna']);
  assert.strictEqual(row.review_unsub_hash, crypto.createHash('sha256').update(tokens[1]).digest('hex'), 'hash, never the token');
  await env.store.close();
});

test('a failing relay is retried three times per process, a restart tries again; no relay = log only', async (t) => {
  const env = setup(t);
  await account(env, 'Anna');
  env.result = { delivered: false, reason: 'timeout' };
  const mailer = env.make();
  for (let i = 0; i < 5; i++) await mailer.tick(at('2026-12-27T10:00:00Z') + i * 600e3);
  assert.strictEqual(env.sent.length, 3, 'three attempts, then this process gives up');
  assert.ok(env.logs.some((l) => /fehlgeschlagen/.test(l)));

  env.result = { delivered: false, reason: 'smtp_not_configured' };
  const r = await env.make().tick(at('2026-12-28T10:00:00Z'));
  assert.strictEqual(r.sent, 1, 'the log fallback counts as sent (by design, like every other mail)');
  await env.make().tick(at('2026-12-29T10:00:00Z'));
  assert.strictEqual(env.sent.length, 4, 'and is not repeated');
  await env.store.close();
});

test('overlapping ticks send once, and a broken store never throws', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sent = [];
  const marked = [];
  const store = {
    reviewMailRecipients: async () => { await gate; return marked.length ? [] : [{ id: 1, username: 'Anna', email: 'a@example.com', lang: 'de' }]; },
    setReviewUnsubHash: async () => {},
    markReviewMailSent: async (id, year) => { marked.push([id, year]); },
  };
  const mailer = createYearReviewMailer({
    accountStore: store, baseUrl: BASE, log: () => {}, reviewFor: (name, year) => sampleReview(year),
    mailer: { send: async (m) => { sent.push(m); return { delivered: true }; } },
  });
  const a = mailer.tick(at('2026-12-27T10:00:00Z'));
  const b = mailer.tick(at('2026-12-27T10:00:00Z'));
  release();
  await Promise.all([a, b]);
  assert.strictEqual(sent.length, 1, 'the second tick saw the first one running');
  assert.deepStrictEqual(marked, [[1, '2026']]);

  const logs = [];
  const broken = createYearReviewMailer({
    accountStore: { reviewMailRecipients: async () => { throw new Error('db gone'); } },
    baseUrl: BASE, log: (l) => logs.push(l), reviewFor: () => null, mailer: { send: async () => ({ delivered: true }) },
  });
  const r = await broken.tick(at('2026-12-27T10:00:00Z'));
  assert.deepStrictEqual(r, { year: '2026', sent: 0, skipped: 0, failed: 0 });
  assert.ok(logs.some((l) => /db gone/.test(l)), 'logged, not thrown');
});
