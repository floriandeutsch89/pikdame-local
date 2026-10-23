const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createPgAccountStore } = require('../game/PgAccountStore');
const { testDatabaseUrl } = require('./helpers/test-db');

/** A store on a fresh schema; sql() reads and writes it directly. */
function fresh() {
  const url = testDatabaseUrl('acc');
  const store = createPgAccountStore(url);
  const pool = new Pool({ connectionString: url, max: 1 });
  const close = async () => { await pool.end(); await store.close(); };
  return { url, store, sql: async (q, params) => (await pool.query(q, params)).rows, close };
}

test('AccountStore: Registrierung -> Verifikation -> Login (kompletter Flow)', async () => {
  const { store, close } = fresh();
  const r = await store.register('Florian', 'flo@example.com', 'geheim123');
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.verifyToken.length >= 32);

  // Vor der Bestätigung: Login verweigert
  const early = await store.login('Florian', 'geheim123');
  assert.match(early.error, /bestätigen/);

  const v = await store.verifyEmail(r.verifyToken);
  assert.equal(v.ok, true);
  assert.equal(v.username, 'Florian');
  // Token ist verbraucht
  assert.match((await store.verifyEmail(r.verifyToken)).error, /Ungültiger/);

  const l = await store.login('flo@example.com', 'geheim123'); // Login auch per E-Mail
  assert.equal(l.ok, true);
  assert.equal(l.username, 'Florian');
  // id and e-mail: /api/me checks the admin role with them and shows the address (and its state) to its own account.
  assert.deepEqual(await store.sessionUser(l.token), { username: 'Florian', id: 1, email: 'flo@example.com', emailVerified: true });

  await store.logout(l.token);
  assert.equal(await store.sessionUser(l.token), null);
  await close();
});

test('AccountStore: falsches Passwort, Duplikate, Validierung', async () => {
  const { store, close } = fresh();
  const r = await store.register('Anna', 'anna@example.com', 'passwort99');
  await store.verifyEmail(r.verifyToken);
  assert.match((await store.login('Anna', 'falsch1234')).error, /falsch/);
  assert.match((await store.register('anna', 'other@example.com', 'passwort99')).error, /bereits registriert/); // case-insensitive
  assert.match((await store.register('Neu', 'ANNA@example.com', 'passwort99')).error, /bereits registriert/);
  assert.match((await store.register('x', 'a@b.de', 'passwort99')).error, /2-24 Zeichen/);
  assert.match((await store.register('Okname', 'keinemail', 'passwort99')).error, /gültige E-Mail/);
  assert.match((await store.register('Okname', 'a@b.de', 'kurz')).error, /8 Zeichen/);
  await close();
});

test('AccountStore: isRegisteredName schützt nur VERIFIZIERTE Namen', async () => {
  const { store, close } = fresh();
  const r = await store.register('Opa', 'opa@example.com', 'passwort99');
  assert.equal(await store.isRegisteredName('Opa'), false, 'unverifiziert = ungeschützt');
  await store.verifyEmail(r.verifyToken);
  assert.equal(await store.isRegisteredName('Opa'), true);
  assert.equal(await store.isRegisteredName('Fremder'), false);
  await close();
});

test('AccountStore: expired unverified accounts are purged on the next register (name and mail become free)', async () => {
  const { store, sql, close } = fresh();
  assert.ok((await store.register('Flo', 'flo@example.org', 'geheim123')).ok, 'first register works');
  assert.ok((await store.register('Flo', 'flo@example.org', 'geheim123')).error, 'unverified but unexpired still blocks');
  await sql('UPDATE users SET verify_expires_at = $1 WHERE username = $2', [new Date(Date.now() - 1000), 'Flo']);
  const r3 = await store.register('Flo', 'flo@example.org', 'geheim123');
  assert.ok(r3.ok, 'expired unverified account was purged - re-register works');
  assert.match((await store.login('Flo', 'geheim123')).error, /bestätigen/, 'login stays blocked until verified');
  assert.ok((await store.verifyEmail(r3.verifyToken)).ok);
  assert.ok((await store.login('Flo', 'geheim123')).ok, 'login works after confirmation');
  await close();
});

test('AccountStore: season ladder books XP, ranks players and resets per season', async () => {
  const { store, close } = fresh();
  const signUp = async (name) => {
    const r = await store.register(name, `${name.toLowerCase()}@example.com`, 'geheim123');
    await store.verifyEmail(r.verifyToken);
  };
  await signUp('Flo');
  await signUp('Erika');

  assert.equal((await store.progressFor('Flo')).xp, 0, 'a fresh account starts at zero');
  assert.deepEqual(await store.ladder('2026-08'), [], 'nobody has played yet');

  await store.addGameResult('Flo', { xp: 160, won: true, season: '2026-08' });
  await store.addGameResult('Flo', { xp: 50, won: false, season: '2026-08' });
  await store.addGameResult('Erika', { xp: 300, won: true, season: '2026-08' });

  const flo = await store.progressFor('Flo');
  assert.equal(flo.xp, 210);
  assert.equal(flo.seasonXp, 210);
  assert.equal(flo.games, 2);
  assert.equal(flo.wins, 1);
  assert.equal(flo.rank, 2, 'Erika has more seasonal XP');
  assert.equal((await store.progressFor('Erika')).rank, 1);

  const board = await store.ladder('2026-08');
  assert.deepEqual(board.map((e) => e.username), ['Erika', 'Flo'], 'highest seasonal XP first');

  // New season: the seasonal counter restarts, the lifetime total does not.
  await store.addGameResult('Flo', { xp: 40, won: false, season: '2026-09' });
  const next = await store.progressFor('Flo');
  assert.equal(next.seasonXp, 40, 'season reset');
  assert.equal(next.xp, 250, 'lifetime XP keeps accumulating');
  assert.deepEqual((await store.ladder('2026-08')).map((e) => e.username), ['Erika'], 'old season keeps its own board');

  // Unknown and unverified accounts are never booked.
  assert.equal(await store.addGameResult('Niemand', { xp: 100, season: '2026-09' }), null);
  const unverified = await store.register('Gast', 'gast@example.com', 'geheim123');
  assert.ok(unverified.ok);
  assert.equal(await store.addGameResult('Gast', { xp: 100, season: '2026-09' }), null, 'unverified accounts stay out of the ladder');
  await close();
});

test('AccountStore: addXp books lifetime and season XP without counting a game (Kartenhaus)', async () => {
  const { store, sql, close } = fresh();
  const r = await store.register('Turm', 'turm@example.com', 'geheim123');
  await store.verifyEmail(r.verifyToken);
  await store.addGameResult('Turm', { xp: 60, won: true, season: '2026-10' });
  const p = await store.addXp('Turm', { xp: 25, season: '2026-10' });
  assert.deepEqual([p.xp, p.seasonXp, p.games, p.wins], [85, 85, 1, 1], 'XP grows, the game counters do not');
  const next = await store.addXp('Turm', { xp: 25, season: '2026-11' });
  assert.deepEqual([next.xp, next.seasonXp, next.games], [110, 25, 1], 'a new season starts from this XP');
  assert.equal((await sql('SELECT season_games FROM users WHERE username = $1', ['Turm']))[0].season_games, 0, 'no season game either');
  const [archived] = await sql('SELECT season, season_xp::int AS season_xp, season_games FROM season_archive WHERE user_id = (SELECT id FROM users WHERE username = $1)', ['Turm']);
  assert.deepEqual({ ...archived }, { season: '2026-10', season_xp: 85, season_games: 1 }, 'the finished season is archived');
  assert.equal(await store.addXp('Niemand', { xp: 25, season: '2026-11' }), null, 'a guest has no account to book');
  const unverified = await store.register('Gast', 'gast@example.com', 'geheim123');
  assert.ok(unverified.ok);
  assert.equal(await store.addXp('Gast', { xp: 25, season: '2026-11' }), null, 'unverified accounts are not booked');
  await close();
});

test('AccountStore: an existing database without the progression columns migrates', async () => {
  // The database survives updates, so a users table from an older version must
  // gain the new columns instead of failing with "column does not exist" forever.
  const { store, sql, close } = fresh();
  await sql(`CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL,
    password_hash BYTEA NOT NULL, salt TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE,
    verify_token TEXT, verify_expires BIGINT, created_at BIGINT NOT NULL)`);
  const r = await store.register('Alt', 'alt@example.com', 'geheim123');
  await store.verifyEmail(r.verifyToken);
  assert.equal((await store.progressFor('Alt')).xp, 0, 'migrated column readable');
  await store.addGameResult('Alt', { xp: 70, won: true, season: '2026-08' });
  assert.equal((await store.progressFor('Alt')).seasonXp, 70);
  await close();
});

// --- Year-review mail (opt-in) ----------------------------------------------
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

test('AccountStore: year-review mail opt-in, once per year, unsubscribe token', async () => {
  const { store, sql, close } = fresh();
  try {
    await reviewMailContract(store, 'P', {
      forceOptIn: (name) => sql('UPDATE users SET review_mail = TRUE WHERE username = $1', [name]),
      consentOf: async (name) => (await sql('SELECT review_mail_consent AS v FROM users WHERE username = $1', [name]))[0].v,
    });
  } finally {
    await close();
  }
});

// Production databases predate the migration runner: the 001 schema in epoch
// milliseconds minus the newest columns, the old schema_version hash table, no schema_migrations.
test('AccountStore: a database from before the migration runner upgrades in place, data kept', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { loadMigrations } = require('../game/Migrations');
  const { url, sql, close } = fresh();
  const baseline = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_baseline.sql'), 'utf8');
  await sql(baseline.split('\n').filter((line) => !line.includes('review_')).join('\n'));
  await sql('CREATE TABLE schema_version (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
  await sql("INSERT INTO schema_version VALUES ('0123456789abcdef', 1)");
  const salt = crypto.randomBytes(32).toString('hex');
  const created = Date.UTC(2025, 2, 14, 9, 30, 15, 123);
  await sql(`INSERT INTO users (username, email, password_hash, salt, verified, created_at, xp, games, wins, season, season_xp, season_games)
    VALUES ('Vorher', 'vorher@example.com', $1, $2, TRUE, $3, 900, 12, 5, '2026-10', 300, 4)`,
  [crypto.scryptSync('geheim123', salt, 64), salt, created]);
  await sql("INSERT INTO sessions (token, user_id, created_at) SELECT 'old-session', id, $1 FROM users", [Date.now() - 60000]);

  const store = createPgAccountStore(url); // the first start of the new version
  assert.deepStrictEqual(await store.sessionUser('old-session'), { username: 'Vorher', id: 1, email: 'vorher@example.com', emailVerified: true },
    'a sign-in from before stays valid');
  const acc = await store.accountForSession((await store.login('Vorher', 'geheim123')).token);
  assert.strictEqual(acc.reviewMail, false, 'the migration never opts an old account in');
  assert.strictEqual(acc.hasPassword, true);
  assert.deepStrictEqual(await store.reviewMailRecipients('2026'), []);
  const p = await store.progressFor('vorher');
  assert.deepStrictEqual([p.xp, p.games, p.wins, p.season, p.seasonXp], [900, 12, 5, '2026-10', 300]);
  assert.strictEqual((await store.listUsers()).users[0].createdAt, created, 'milliseconds come back exactly');
  const versions = (await sql('SELECT version FROM schema_migrations ORDER BY version')).map((x) => x.version);
  assert.deepStrictEqual(versions, loadMigrations().map((m) => m.version), 'baseline, hash-table drop and every later file recorded');
  assert.strictEqual((await sql("SELECT to_regclass('schema_version') AS t"))[0].t, null, 'the old hash table is gone');
  const linked = await sql('SELECT p.player_key, p.player_name FROM users u JOIN players p ON p.id = u.player_id');
  assert.deepStrictEqual(linked, [{ player_key: 'vorher', player_name: 'Vorher' }], 'the confirmed account got its player');
  await store.close();
  await close();
});

// The account owns its name's player: set at the confirmation, kept by the FK.
test('AccountStore: a confirmed account is linked to its player, deleting the account keeps the player', async () => {
  const { store, sql, close } = fresh();
  try {
    const r = await store.register('Öma', 'oema@example.com', 'geheim123');
    const other = await store.registerWithoutPassword('Opa', 'opa@example.com');
    await sql("INSERT INTO players (player_key, player_name, games_played) VALUES ('öma', 'Öma', 7)"); // her guest profile
    assert.deepStrictEqual(await sql('SELECT player_id FROM users ORDER BY id'), [{ player_id: null }, { player_id: null }], 'unconfirmed: no player yet');
    await store.verifyEmail(r.verifyToken);
    assert.ok((await store.verifyCodeAndSignIn('opa@example.com', other.code)).token, 'the code path confirms too');
    const rows = await sql(`SELECT u.username, p.player_key, p.games_played FROM users u
      JOIN players p ON p.id = u.player_id ORDER BY u.id`);
    assert.deepStrictEqual(rows, [
      { username: 'Öma', player_key: 'öma', games_played: 7 },
      { username: 'Opa', player_key: 'opa', games_played: 0 },
    ], 'the guest profile of the name (keyed like the stores, not by SQL lower()) or a new player');
    await assert.rejects(sql("DELETE FROM players WHERE player_key = 'öma'"), /users_player_id_fkey/, 'the account goes first');
    assert.deepStrictEqual(await store.deleteUser('Öma'), { ok: true, username: 'Öma' });
    assert.deepStrictEqual(await sql("SELECT games_played FROM players WHERE player_key = 'öma'"), [{ games_played: 7 }], 'the guest profile stays');
  } finally {
    await close();
  }
});

// Accounts confirmed before 008 have no player yet: the first start links them (two replicas: once).
test('AccountStore: replicas starting together link the old confirmed accounts once', async () => {
  const { url, store, sql, close } = fresh();
  const names = ['Ältere', 'Bert', 'Cleo'];
  for (const name of names) {
    const r = await store.register(name, `${name.toLowerCase()}@example.com`, 'geheim123');
    await store.verifyEmail(r.verifyToken);
  }
  await sql("INSERT INTO players (player_key, player_name, games_played) VALUES ('bert', 'Bert', 3) ON CONFLICT (player_key) DO UPDATE SET games_played = 3");
  await sql('UPDATE users SET player_id = NULL');
  await sql("DELETE FROM players WHERE player_key <> 'bert'");
  const replicas = [createPgAccountStore(url), createPgAccountStore(url)];
  try {
    assert.deepStrictEqual(await Promise.all(replicas.map((r) => r.isRegisteredName('Bert'))), [true, true]);
    const rows = await sql('SELECT u.username, p.player_key, p.games_played FROM users u JOIN players p ON p.id = u.player_id ORDER BY u.id');
    assert.deepStrictEqual(rows, [
      { username: 'Ältere', player_key: 'ältere', games_played: 0 },
      { username: 'Bert', player_key: 'bert', games_played: 3 },
      { username: 'Cleo', player_key: 'cleo', games_played: 0 },
    ]);
    assert.strictEqual((await sql('SELECT count(*)::int AS n FROM players'))[0].n, 3, 'one player per name');
  } finally {
    await Promise.all(replicas.map((r) => r.close()));
    await close();
  }
});

// CI runs test files in parallel against one database: several stores create
// the schema at once (as replicas would). Without the advisory lock in
// the migration runner this deadlocked or hit "relation already exists".
test('PgAccountStore: concurrent first starts on an empty database all succeed', async () => {
  const url = testDatabaseUrl('race');
  const stores = Array.from({ length: 6 }, () => createPgAccountStore(url));
  try {
    const res = await Promise.all(stores.map((s, i) => s.register(`Race${i}`, `race${i}@example.com`, 'geheim123')));
    for (const r of res) assert.ok(r.ok, JSON.stringify(r));
  } finally {
    await Promise.all(stores.map((s) => s.close()));
  }
});

// A replica starting while others serve players must not take table locks:
// ALTER ... ADD COLUMN IF NOT EXISTS wants an exclusive lock even when the
// column exists and deadlocked live transactions (release CI, v2.102.1).
test('PgAccountStore: a second start on a ready schema takes no table lock', async () => {
  const { Client } = require('pg');
  const url = testDatabaseUrl('lock');
  const first = createPgAccountStore(url);
  const reader = new Client({ connectionString: url });
  let second;
  try {
    assert.ok((await first.register('Erst', 'erst@example.com', 'geheim123')).ok);
    await reader.connect();
    await reader.query('BEGIN');
    await reader.query('SELECT count(*) FROM users'); // holds a share lock until COMMIT
    await reader.query('SELECT pg_advisory_xact_lock(726813)'); // and the migration lock
    second = createPgAccountStore(url);
    const res = await Promise.race([
      second.register('Zweit', 'zweit@example.com', 'geheim123'),
      new Promise((resolve) => setTimeout(() => resolve({ error: 'blocked on a lock' }), 3000)),
    ]);
    assert.ok(res.ok, JSON.stringify(res));
  } finally {
    await reader.query('COMMIT').catch(() => {});
    await reader.end().catch(() => {});
    if (second) await second.close();
    await first.close();
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
