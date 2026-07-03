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

test('PgAccountStore: unreachable database degrades gracefully (no throw, fails closed)', async () => {
  const store = createPgAccountStore('postgres://nouser:nopass@127.0.0.1:59999/nodb');
  assert.ok(store);
  const r = await store.register('Ghost', 'ghost@example.com', 'geheim123');
  assert.match(r.error, /nicht erreichbar/);
  assert.equal(await store.sessionUser('sometoken'), null);
  assert.equal(await store.isRegisteredName('Ghost'), false, 'fails closed');
  await store.close();
});
