const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAccountStore } = require('../game/AccountStore');

// node:sqlite gibt es erst ab Node 22 - auf 18/20 (CI-Matrix) wird der
// Store null und die Accounts sind deaktiviert. Genau das testen wir mit.
const probe = createAccountStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pikacc-')), 'probe.db'));
const HAS_SQLITE = probe !== null;
if (probe) probe.close();

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikacc-'));
  return createAccountStore(path.join(dir, 'users.db'));
}

test('AccountStore: ohne node:sqlite (Node < 22) liefert die Factory null', () => {
  if (HAS_SQLITE) {
    assert.ok(createAccountStore !== null); // trivial - Verhalten gilt nur ohne sqlite
    return;
  }
  assert.equal(probe, null);
});

test('AccountStore: Registrierung -> Verifikation -> Login (kompletter Flow)', { skip: !HAS_SQLITE }, () => {
  const store = freshStore();
  const r = store.register('Florian', 'flo@example.com', 'geheim123');
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.verifyToken.length >= 32);

  // Vor der Bestätigung: Login verweigert
  const early = store.login('Florian', 'geheim123');
  assert.match(early.error, /bestätigen/);

  const v = store.verifyEmail(r.verifyToken);
  assert.equal(v.ok, true);
  assert.equal(v.username, 'Florian');
  // Token ist verbraucht
  assert.match(store.verifyEmail(r.verifyToken).error, /Ungültiger/);

  const l = store.login('flo@example.com', 'geheim123'); // Login auch per E-Mail
  assert.equal(l.ok, true);
  assert.equal(l.username, 'Florian');
  assert.deepEqual(store.sessionUser(l.token), { username: 'Florian' });

  store.logout(l.token);
  assert.equal(store.sessionUser(l.token), null);
  store.close();
});

test('AccountStore: falsches Passwort, Duplikate, Validierung', { skip: !HAS_SQLITE }, () => {
  const store = freshStore();
  const r = store.register('Anna', 'anna@example.com', 'passwort99');
  store.verifyEmail(r.verifyToken);
  assert.match(store.login('Anna', 'falsch1234').error, /falsch/);
  assert.match(store.register('anna', 'other@example.com', 'passwort99').error, /bereits registriert/); // case-insensitive
  assert.match(store.register('Neu', 'ANNA@example.com', 'passwort99').error, /bereits registriert/);
  assert.match(store.register('x', 'a@b.de', 'passwort99').error, /2-24 Zeichen/);
  assert.match(store.register('Okname', 'keinemail', 'passwort99').error, /gültige E-Mail/);
  assert.match(store.register('Okname', 'a@b.de', 'kurz').error, /8 Zeichen/);
  store.close();
});

test('AccountStore: isRegisteredName schützt nur VERIFIZIERTE Namen', { skip: !HAS_SQLITE }, () => {
  const store = freshStore();
  const r = store.register('Opa', 'opa@example.com', 'passwort99');
  assert.equal(store.isRegisteredName('Opa'), false, 'unverifiziert = ungeschützt');
  store.verifyEmail(r.verifyToken);
  assert.equal(store.isRegisteredName('Opa'), true);
  assert.equal(store.isRegisteredName('Fremder'), false);
  store.close();
});

// --- v1.17.0: PostgreSQL backend - same behavior as SQLite ------------------
// Runs only when a test database is reachable (locally via installed
// Postgres, in CI via a service container providing PIKDAME_TEST_PG_URL).
const PG_URL = process.env.PIKDAME_TEST_PG_URL || '';
const { createPgAccountStore } = require('../game/PgAccountStore');

test('PgAccountStore: full flow (register -> verify -> login -> me -> logout)', { skip: !PG_URL }, async () => {
  const store = createPgAccountStore(PG_URL);
  assert.ok(store, "the 'pg' package must be installed for this test");
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const name = `Pg_${suffix}`;
  const mail = `pg_${suffix}@example.com`;

  const r = await store.register(name, mail, 'geheim123');
  assert.ok(r.ok, JSON.stringify(r));
  assert.match((await store.login(name, 'geheim123')).error, /bestätigen/);

  const v = await store.verifyEmail(r.verifyToken);
  assert.equal(v.ok, true);
  assert.match((await store.verifyEmail(r.verifyToken)).error, /Ungültiger/);

  const l = await store.login(mail.toUpperCase(), 'geheim123'); // case-insensitive
  assert.equal(l.ok, true, JSON.stringify(l));
  assert.deepEqual(await store.sessionUser(l.token), { username: name });
  assert.match((await store.login(name, 'falsch1234')).error, /falsch/);

  assert.equal(await store.isRegisteredName(name.toUpperCase()), true);
  assert.equal(await store.isRegisteredName('NobodyHere'), false);
  assert.match((await store.register(name.toLowerCase(), 'x@y.de', 'geheim123')).error, /bereits registriert/);

  await store.logout(l.token);
  assert.equal(await store.sessionUser(l.token), null);
  await store.close();
});

test('AccountStore: season ladder books XP, ranks players and resets per season', { skip: !HAS_SQLITE }, async () => {
  const store = freshStore();
  const signUp = async (name) => {
    const r = await store.register(name, `${name.toLowerCase()}@example.com`, 'geheim123');
    await store.verifyEmail(r.verifyToken);
  };
  await signUp('Flo');
  await signUp('Erika');

  assert.equal(store.progressFor('Flo').xp, 0, 'a fresh account starts at zero');
  assert.deepEqual(store.ladder('2026-08'), [], 'nobody has played yet');

  store.addGameResult('Flo', { xp: 160, won: true, season: '2026-08' });
  store.addGameResult('Flo', { xp: 50, won: false, season: '2026-08' });
  store.addGameResult('Erika', { xp: 300, won: true, season: '2026-08' });

  const flo = store.progressFor('Flo');
  assert.equal(flo.xp, 210);
  assert.equal(flo.seasonXp, 210);
  assert.equal(flo.games, 2);
  assert.equal(flo.wins, 1);
  assert.equal(flo.rank, 2, 'Erika has more seasonal XP');
  assert.equal(store.progressFor('Erika').rank, 1);

  const board = store.ladder('2026-08');
  assert.deepEqual(board.map((e) => e.username), ['Erika', 'Flo'], 'highest seasonal XP first');

  // New season: the seasonal counter restarts, the lifetime total does not.
  store.addGameResult('Flo', { xp: 40, won: false, season: '2026-09' });
  const next = store.progressFor('Flo');
  assert.equal(next.seasonXp, 40, 'season reset');
  assert.equal(next.xp, 250, 'lifetime XP keeps accumulating');
  assert.deepEqual(store.ladder('2026-08').map((e) => e.username), ['Erika'], 'old season keeps its own board');

  // Unknown and unverified accounts are never booked.
  assert.equal(store.addGameResult('Niemand', { xp: 100, season: '2026-09' }), null);
  const unverified = await store.register('Gast', 'gast@example.com', 'geheim123');
  assert.ok(unverified.ok);
  assert.equal(store.addGameResult('Gast', { xp: 100, season: '2026-09' }), null, 'unverified accounts stay out of the ladder');
  await store.close();
});

test('AccountStore: addXp books lifetime and season XP without counting a game (Kartenhaus)', { skip: !HAS_SQLITE }, async () => {
  const store = freshStore();
  const r = await store.register('Turm', 'turm@example.com', 'geheim123');
  await store.verifyEmail(r.verifyToken);
  store.addGameResult('Turm', { xp: 60, won: true, season: '2026-10' });
  const p = store.addXp('Turm', { xp: 25, season: '2026-10' });
  assert.deepEqual([p.xp, p.seasonXp, p.games, p.wins], [85, 85, 1, 1], 'XP grows, the game counters do not');
  const next = store.addXp('Turm', { xp: 25, season: '2026-11' });
  assert.deepEqual([next.xp, next.seasonXp, next.games], [110, 25, 1], 'a new season starts from this XP');
  assert.equal(store._db.prepare('SELECT season_games FROM users WHERE username = ?').get('Turm').season_games, 0, 'no season game either');
  const archived = store._db.prepare('SELECT season, season_xp, season_games FROM season_archive WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('Turm');
  assert.deepEqual({ ...archived }, { season: '2026-10', season_xp: 85, season_games: 1 }, 'the finished season is archived');
  assert.equal(store.addXp('Niemand', { xp: 25, season: '2026-11' }), null, 'a guest has no account to book');
  const unverified = await store.register('Gast', 'gast@example.com', 'geheim123');
  assert.ok(unverified.ok);
  assert.equal(store.addXp('Gast', { xp: 25, season: '2026-11' }), null, 'unverified accounts are not booked');
  await store.close();
});

test('PgAccountStore: addXp books lifetime and season XP without counting a game (Kartenhaus)', { skip: !PG_URL }, async () => {
  const store = createPgAccountStore(PG_URL);
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const name = `Turm_${suffix}`;
  const r = await store.register(name, `turm_${suffix}@example.com`, 'geheim123');
  await store.verifyEmail(r.verifyToken);
  await store.addGameResult(name, { xp: 60, won: true, season: '2026-10' });
  const p = await store.addXp(name, { xp: 25, season: '2026-10' });
  assert.deepEqual([p.xp, p.seasonXp, p.games, p.wins], [85, 85, 1, 1], 'XP grows, the game counters do not');
  const next = await store.addXp(name, { xp: 25, season: '2026-11' });
  assert.deepEqual([next.xp, next.seasonXp, next.games], [110, 25, 1], 'a new season starts from this XP');
  assert.equal(await store.addXp(`Niemand_${suffix}`, { xp: 25, season: '2026-11' }), null, 'a guest has no account to book');
  await store.close();
});

test('AccountStore: an existing database without the progression columns migrates', { skip: !HAS_SQLITE }, async () => {
  // The data volume survives updates, so users.db from an older version must
  // gain the new columns instead of throwing "no such column" forever.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikacc-'));
  const dbFile = path.join(dir, 'users.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbFile);
  old.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash BLOB NOT NULL, salt TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0, verify_token TEXT,
    verify_expires INTEGER, created_at INTEGER NOT NULL);`);
  old.close();

  const store = createAccountStore(dbFile);
  const r = await store.register('Alt', 'alt@example.com', 'geheim123');
  await store.verifyEmail(r.verifyToken);
  assert.equal(store.progressFor('Alt').xp, 0, 'migrated column readable');
  store.addGameResult('Alt', { xp: 70, won: true, season: '2026-08' });
  assert.equal(store.progressFor('Alt').seasonXp, 70);
  await store.close();
});

// --- Year-review mail (opt-in): one contract, SQLite AND Postgres ----------
// raw.forceOptIn flips the flag in the database directly: the API cannot reach
// an unverified account, and exactly that one must still never get mail.
// raw.consentOf reads the stored version of the consent text.
async function reviewMailContract(store, tag, raw) {
  const crypto = require('node:crypto');
  const names = ['A', 'B', 'C'].map((s) => `Rv${tag}${s}`);
  const mine = async (year) => (await store.reviewMailRecipients(year)).map((r) => r.username).filter((n) => names.includes(n));
  for (const [i, name] of names.entries()) {
    const r = await store.register(name, `${name.toLowerCase()}@example.com`, 'geheim123');
    assert.ok(r.ok, JSON.stringify(r));
    if (i < 2) await store.verifyEmail(r.verifyToken);
  }
  const [a, , c] = names;
  const session = (await store.login(a, 'geheim123')).token;
  const acc = await store.accountForSession(session);
  assert.strictEqual(acc.reviewMail, false, 'off until the player switches it on');
  assert.deepStrictEqual(await mine('2026'), [], 'nobody opted in yet');

  assert.strictEqual(await raw.consentOf(a), null);
  assert.deepStrictEqual(await store.setReviewMail(acc.id, true, 'en', 'v1'), { ok: true, enabled: true });
  assert.strictEqual((await store.accountForSession(session)).reviewMail, true);
  assert.strictEqual(await raw.consentOf(a), 'v1', 'the consent text version is stored with the opt-in');
  await raw.forceOptIn(c);
  assert.deepStrictEqual(await mine('2026'), [a], 'only verified accounts that opted in (not B, not the unverified C)');
  const rec = (await store.reviewMailRecipients('2026')).find((r) => r.username === a);
  assert.deepStrictEqual({ email: rec.email, lang: rec.lang }, { email: `${a.toLowerCase()}@example.com`, lang: 'en' });

  await store.markReviewMailSent(acc.id, '2026');
  assert.deepStrictEqual(await mine('2026'), [], 'once per year');
  assert.deepStrictEqual(await mine('2027'), [a], 'the next year counts anew');

  const token = crypto.randomBytes(32).toString('hex');
  await store.setReviewUnsubHash(acc.id, crypto.createHash('sha256').update(token).digest('hex'));
  for (const wrong of ['f'.repeat(64), token.toUpperCase(), token.slice(1), '', null, `${token}00`]) {
    assert.deepStrictEqual(await store.reviewUnsubInfo(wrong), { error: 'invalid' }, `unknown: ${String(wrong).slice(0, 8)}`);
    assert.deepStrictEqual(await store.unsubscribeReviewMail(wrong), { error: 'invalid' }, `rejected: ${String(wrong).slice(0, 8)}`);
  }
  assert.deepStrictEqual(await store.reviewUnsubInfo(token), { ok: true, username: a, lang: 'en', active: true });
  assert.strictEqual((await store.accountForSession(session)).reviewMail, true, 'looking the link up changes nothing');
  assert.strictEqual((await store.accountForSession(session)).reviewMail, true, 'a wrong token changes nothing');
  assert.deepStrictEqual(await store.unsubscribeReviewMail(token), { ok: true, username: a, lang: 'en' });
  assert.strictEqual((await store.accountForSession(session)).reviewMail, false);
  assert.deepStrictEqual(await mine('2027'), [], 'opted out by the link');
  assert.deepStrictEqual(await store.unsubscribeReviewMail(token), { ok: true, username: a, lang: 'en' }, 'a second click still answers');
  assert.deepStrictEqual(await store.reviewUnsubInfo(token), { ok: true, username: a, lang: 'en', active: false });
  assert.strictEqual(await raw.consentOf(a), 'v1', 'the last consent stays on record after the opt-out');

  // Back on in the account: the year already mailed stays mailed.
  await store.setReviewMail(acc.id, true, 'de', 'v2');
  assert.strictEqual(await raw.consentOf(a), 'v2', 'a new opt-in records the text shown now');
  assert.deepStrictEqual(await mine('2026'), []);
  assert.deepStrictEqual(await mine('2027'), [a]);
  assert.strictEqual((await store.reviewMailRecipients('2027')).find((r) => r.username === a).lang, 'de');
  await store.setReviewMail(acc.id, false, 'de', 'v3');
  assert.strictEqual(await raw.consentOf(a), 'v2', 'switching off records no consent');
}

test('AccountStore: year-review mail opt-in, once per year, unsubscribe token', { skip: !HAS_SQLITE }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikacc-'));
  const dbFile = path.join(dir, 'users.db');
  const store = createAccountStore(dbFile);
  const { DatabaseSync } = require('node:sqlite');
  const sql = (fn) => { const db = new DatabaseSync(dbFile); try { return fn(db); } finally { db.close(); } };
  await reviewMailContract(store, 'S', {
    forceOptIn: (name) => sql((db) => db.prepare('UPDATE users SET review_mail = 1 WHERE username = ?').run(name)),
    consentOf: (name) => sql((db) => db.prepare('SELECT review_mail_consent AS v FROM users WHERE username = ?').get(name).v),
  });
  await store.close();
});

test('PgAccountStore: year-review mail opt-in, once per year, unsubscribe token', { skip: !PG_URL }, async () => {
  const store = createPgAccountStore(PG_URL);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: PG_URL });
  try {
    await reviewMailContract(store, Date.now().toString(36).slice(-5), {
      forceOptIn: (name) => pool.query('UPDATE users SET review_mail = TRUE WHERE username = $1', [name]),
      consentOf: async (name) => (await pool.query('SELECT review_mail_consent AS v FROM users WHERE username = $1', [name])).rows[0].v,
    });
  } finally {
    await pool.end();
    await store.close();
  }
});

test('AccountStore: a database from before the year review gains its columns, all off', { skip: !HAS_SQLITE }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikacc-'));
  const dbFile = path.join(dir, 'users.db');
  const first = createAccountStore(dbFile);
  const r = await first.register('Vorher', 'vorher@example.com', 'geheim123');
  await first.verifyEmail(r.verifyToken);
  await first.close();
  // Back to the schema before the year review: the columns did not exist yet.
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbFile);
  for (const col of ['review_mail', 'review_mail_at', 'review_mail_lang', 'review_mail_year', 'review_unsub_hash', 'review_mail_consent']) {
    raw.exec(`ALTER TABLE users DROP COLUMN ${col}`);
  }
  raw.close();

  const store = createAccountStore(dbFile);
  const acc = await store.accountForSession((await store.login('Vorher', 'geheim123')).token);
  assert.strictEqual(acc.reviewMail, false, 'the migration never opts an old account in');
  assert.deepStrictEqual(await store.reviewMailRecipients('2026'), []);
  await store.close();
});

// CI runs test files in parallel against one database: several stores create
// the schema at once (as replicas would). Without the advisory lock in
// ensureReady this deadlocked or hit "relation already exists".
test('PgAccountStore: concurrent first starts on an empty database all succeed', { skip: !PG_URL }, async () => {
  const { Client } = require('pg');
  const schema = `race_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(PG_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const stores = Array.from({ length: 6 }, () => createPgAccountStore(url.toString()));
  try {
    const res = await Promise.all(stores.map((s, i) => s.register(`Race${i}`, `race${i}@example.com`, 'geheim123')));
    for (const r of res) assert.ok(r.ok, JSON.stringify(r));
  } finally {
    await Promise.all(stores.map((s) => s.close()));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

// A replica starting while others serve players must not take table locks:
// ALTER ... ADD COLUMN IF NOT EXISTS wants an exclusive lock even when the
// column exists and deadlocked live transactions (release CI, v2.102.1).
test('PgAccountStore: a second start on a ready schema takes no table lock', { skip: !PG_URL }, async () => {
  const { Client } = require('pg');
  const schema = `lock_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(PG_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const first = createPgAccountStore(url.toString());
  const reader = new Client({ connectionString: url.toString() });
  let second;
  try {
    assert.ok((await first.register('Erst', 'erst@example.com', 'geheim123')).ok);
    await reader.connect();
    await reader.query('BEGIN');
    await reader.query('SELECT count(*) FROM users'); // holds a share lock until COMMIT
    second = createPgAccountStore(url.toString());
    const res = await Promise.race([
      second.register('Zweit', 'zweit@example.com', 'geheim123'),
      new Promise((resolve) => setTimeout(() => resolve({ error: 'blocked on a table lock' }), 3000)),
    ]);
    assert.ok(res.ok, JSON.stringify(res));
  } finally {
    await reader.query('COMMIT').catch(() => {});
    await reader.end().catch(() => {});
    if (second) await second.close();
    await first.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('PgAccountStore: unreachable database degrades gracefully (no throw, fails closed)', async () => {
  const store = createPgAccountStore('postgres://nouser:nopass@127.0.0.1:59999/nodb');
  assert.ok(store);
  const r = await store.register('Ghost', 'ghost@example.com', 'geheim123');
  assert.match(r.error, /nicht erreichbar/);
  assert.equal(await store.sessionUser('sometoken'), null);
  assert.equal(await store.isRegisteredName('Ghost'), false, 'fails closed');
  await store.close();
});
