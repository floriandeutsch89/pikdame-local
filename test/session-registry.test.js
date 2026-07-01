const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionRegistry, sanitizeName, normalizeCode, generateCode, CODE_ALPHABET, CODE_LENGTH } = require('../game/SessionRegistry');

function makeRegistry(opts = {}) {
  let fakeNow = 1_000_000;
  const registry = new SessionRegistry(() => ({ fakeGame: true }), {
    now: () => fakeNow,
    ...opts,
  });
  return { registry, advance: (ms) => { fakeNow += ms; } };
}

test('generateCode: richtige Länge, nur erlaubte Zeichen', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.equal(code.length, CODE_LENGTH);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `unerlaubtes Zeichen: ${ch}`);
  }
});

test('create: liefert Session mit eindeutigem Code und Spiel-Instanz', () => {
  const { registry } = makeRegistry();
  const { session } = registry.create();
  assert.ok(session.code);
  assert.ok(session.game.fakeGame);
  assert.equal(registry.get(session.code), session);
});

test('get: Beitritt nur mit korrektem Code, Normalisierung (Kleinschreibung/Leerzeichen)', () => {
  const { registry } = makeRegistry();
  const { session } = registry.create();
  assert.equal(registry.get(session.code.toLowerCase()), session, 'Kleinschreibung muss funktionieren');
  assert.equal(registry.get(` ${session.code} `), session, 'Leerzeichen müssen ignoriert werden');
  assert.equal(registry.get('FALSCH'), null, 'falscher Code darf keine Session liefern');
  assert.equal(registry.get(''), null);
  assert.equal(registry.get(null), null);
});

test('create: Obergrenze paralleler Sessions wird durchgesetzt (DoS-Schutz)', () => {
  const { registry } = makeRegistry({ maxSessions: 3 });
  registry.create();
  registry.create();
  registry.create();
  const fourth = registry.create();
  assert.ok(fourth.error, 'vierte Session muss abgelehnt werden');
  assert.equal(registry.size, 3);
});

test('cleanup: leere Sessions werden nach TTL entfernt, aktive bleiben', () => {
  const { registry, advance } = makeRegistry({ emptySessionTtlMs: 1000 });
  const { session: stale } = registry.create();
  const { session: fresh } = registry.create();

  advance(1500); // beide über TTL...
  registry.touch(fresh); // ...aber fresh hatte gerade Aktivität

  const removed = registry.cleanup();
  assert.equal(removed, 1);
  assert.equal(registry.get(stale.code), null);
  assert.equal(registry.get(fresh.code), fresh);
});

test('cleanup: Sessions mit verbundenem Socket bleiben trotz Inaktivität (bis maxAge)', () => {
  const { registry, advance } = makeRegistry({ emptySessionTtlMs: 1000, maxSessionAgeMs: 10_000 });
  const { session } = registry.create();
  session.sockets.set('p1', { readyState: 1, close() {} }); // verbunden

  advance(5000);
  assert.equal(registry.cleanup(), 0, 'verbundene Session darf nicht entfernt werden');

  advance(6000); // Gesamtalter > maxAge
  assert.equal(registry.cleanup(), 1, 'nach maxAge wird auch eine verbundene Session entfernt');
});

test('sanitizeName: entfernt HTML/gefährliche Zeichen, erhält Umlaute, begrenzt Länge', () => {
  assert.equal(sanitizeName('<img src=x onerror=alert(1)>'), 'img srcx onerror'); // gefährliche Zeichen raus, auf 16 gekürzt
  assert.equal(sanitizeName('Jörg Müller'), 'Jörg Müller');
  assert.equal(sanitizeName('  viel   Abstand  '), 'viel Abstand');
  assert.equal(sanitizeName('A'.repeat(50)).length, 16);
  assert.equal(sanitizeName('"quotes\'&<>'), 'quotes');
  assert.equal(sanitizeName(123), '');
  assert.equal(sanitizeName(null), '');
});

test('normalizeCode: Großschreibung, Sonderzeichen raus, Länge begrenzt', () => {
  assert.equal(normalizeCode('ab-c 12x'), 'ABC12X');
  assert.equal(normalizeCode('abcdefghij'), 'ABCDEF');
  assert.equal(normalizeCode(null), '');
});
