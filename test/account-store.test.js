const test = require('node:test');
const assert = require('node:assert');
const { createAccountStoreAuto } = require('../game/AccountStore');

test('createAccountStoreAuto: no pool or no URL means no accounts (null)', () => {
  assert.equal(createAccountStoreAuto({}, { pool: null }), null);
  assert.equal(createAccountStoreAuto({ PIKDAME_DATABASE_URL: 'postgres://x/y' }, { pool: null }), null);
  assert.equal(createAccountStoreAuto({}, { pool: {} }), null);
});

// --- PostgreSQL accounts ---
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
test('PgAccountStore: unreachable database degrades gracefully (no throw, fails closed)', async () => {
  const store = createPgAccountStore('postgres://nouser:nopass@127.0.0.1:59999/nodb');
  assert.ok(store);
  const r = await store.register('Ghost', 'ghost@example.com', 'geheim123');
  assert.match(r.error, /nicht erreichbar/);
  assert.equal(await store.sessionUser('sometoken'), null);
  assert.equal(await store.isRegisteredName('Ghost'), false, 'fails closed');
  await store.close();
});


test('PgAccountStore: expired unverified accounts are purged on next register (name+mail become free)', { skip: !PG_URL }, async () => {
  const { Pool } = require('pg');
  const store = createPgAccountStore(PG_URL);
  const admin = new Pool({ connectionString: PG_URL, max: 1 });
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const name = `Flo_${suffix}`;
  const mail = `flo_${suffix}@example.org`;
  try {
    const r1 = await store.register(name, mail, 'geheim123');
    assert.ok(r1.ok, 'first register works');
    const r2 = await store.register(name, mail, 'geheim123');
    assert.ok(r2.error, 'unverified but unexpired still blocks');
    await admin.query('UPDATE users SET verify_expires = $1 WHERE username = $2', [Date.now() - 1000, name]);
    const r3 = await store.register(name, mail, 'geheim123');
    assert.ok(r3.ok, 'expired unverified account was purged - re-register works');
    const l = await store.login(name, 'geheim123');
    assert.ok(l.error && /bestätigen/.test(l.error), 'login stays blocked until verified');
    assert.ok((await store.verifyEmail(r3.verifyToken)).ok, 'verify works');
    assert.ok((await store.login(name, 'geheim123')).ok, 'login works after confirmation - opt-in complete');
  } finally {
    await admin.query('DELETE FROM users WHERE username = $1', [name]).catch(() => {});
    await admin.end();
    await store.close();
  }
});

// Names are unique per run: these tests share the public schema of PG_URL.
const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

test('PgAccountStore: register validation and duplicates', { skip: !PG_URL }, async () => {
  const store = createPgAccountStore(PG_URL);
  const u = uniq();
  const name = `Anna${u}`;
  try {
    const r = await store.register(name, `anna${u}@example.com`, 'passwort99');
    await store.verifyEmail(r.verifyToken);
    assert.match((await store.login(name, 'falsch1234')).error, /falsch/);
    assert.match((await store.register(name.toLowerCase(), `other${u}@example.com`, 'passwort99')).error, /bereits registriert/); // case-insensitive
    assert.match((await store.register(`Neu${u}`, `ANNA${u}@example.com`, 'passwort99')).error, /bereits registriert/);
    assert.match((await store.register('x', 'a@b.de', 'passwort99')).error, /2-24 Zeichen/);
    assert.match((await store.register('Okname', 'keinemail', 'passwort99')).error, /gültige E-Mail/);
    assert.match((await store.register('Okname', 'a@b.de', 'kurz')).error, /8 Zeichen/);
  } finally {
    await store.deleteUser(name).catch(() => {});
    await store.close();
  }
});

test('PgAccountStore: isRegisteredName protects only VERIFIED names', { skip: !PG_URL }, async () => {
  const store = createPgAccountStore(PG_URL);
  const name = `Opa${uniq()}`;
  try {
    const r = await store.register(name, `${name.toLowerCase()}@example.com`, 'passwort99');
    assert.equal(await store.isRegisteredName(name), false, 'unverified = unprotected');
    await store.verifyEmail(r.verifyToken);
    assert.equal(await store.isRegisteredName(name), true);
    assert.equal(await store.isRegisteredName(`Fremder${uniq()}`), false);
  } finally {
    await store.deleteUser(name).catch(() => {});
    await store.close();
  }
});

test('PgAccountStore: season ladder books XP, ranks players and resets per season', { skip: !PG_URL }, async () => {
  const store = createPgAccountStore(PG_URL);
  const u = uniq();
  // A season label no other test or run uses, so the board holds only our players.
  const s1 = `T${u}-a`;
  const s2 = `T${u}-b`;
  const names = [`Flo${u}`, `Erika${u}`, `Gast${u}`];
  const [flo, erika, gast] = names;
  const signUp = async (name) => {
    const r = await store.register(name, `${name.toLowerCase()}@example.com`, 'geheim123');
    await store.verifyEmail(r.verifyToken);
  };
  try {
    await signUp(flo);
    await signUp(erika);

    assert.equal((await store.progressFor(flo)).xp, 0, 'a fresh account starts at zero');
    assert.deepEqual(await store.ladder(s1), [], 'nobody has played yet');

    await store.addGameResult(flo, { xp: 160, won: true, season: s1 });
    await store.addGameResult(flo, { xp: 50, won: false, season: s1 });
    await store.addGameResult(erika, { xp: 300, won: true, season: s1 });

    const f = await store.progressFor(flo);
    assert.equal(f.xp, 210);
    assert.equal(f.seasonXp, 210);
    assert.equal(f.games, 2);
    assert.equal(f.wins, 1);
    assert.equal(f.rank, 2, 'Erika has more seasonal XP');
    assert.equal((await store.progressFor(erika)).rank, 1);

    assert.deepEqual((await store.ladder(s1)).map((e) => e.username), [erika, flo], 'highest seasonal XP first');

    // New season: the seasonal counter restarts, the lifetime total does not.
    await store.addGameResult(flo, { xp: 40, won: false, season: s2 });
    const next = await store.progressFor(flo);
    assert.equal(next.seasonXp, 40, 'season reset');
    assert.equal(next.xp, 250, 'lifetime XP keeps accumulating');
    assert.deepEqual((await store.ladder(s1)).map((e) => e.username), [erika], 'old season keeps its own board');

    // Unknown and unverified accounts are never booked.
    assert.equal(await store.addGameResult(`Niemand${u}`, { xp: 100, season: s2 }), null);
    assert.ok((await store.register(gast, `${gast.toLowerCase()}@example.com`, 'geheim123')).ok);
    // Postgres answers with the unchanged progress (the UPDATE only matches verified rows).
    const unbooked = await store.addGameResult(gast, { xp: 100, season: s2 });
    assert.ok(!unbooked || (unbooked.xp === 0 && unbooked.games === 0), 'unverified accounts are never booked');
    assert.ok(!(await store.ladder(s2)).some((e) => e.username === gast), 'unverified accounts stay out of the ladder');
  } finally {
    for (const n of names) await store.deleteUser(n).catch(() => {});
    await store.close();
  }
});
