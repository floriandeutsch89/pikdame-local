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
