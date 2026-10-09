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
