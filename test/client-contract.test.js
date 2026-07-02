// Verträge zwischen Client-JS, HTML und i18n - fängt eine ganze
// Fehlerklasse ab: el('id') auf ein fehlendes Element wirft beim LADEN
// und würde die komplette App sterben lassen (kein Rendering, keine
// Fehlermeldung fuer den Nutzer).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const clientJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');

test('Client-Vertrag: jede el(...)-ID existiert im HTML', () => {
  const ids = new Set([...clientJs.matchAll(/el\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `el() auf fehlende IDs: ${missing.join(', ')}`);
});

test('Client-Vertrag: keine ungeschuetzten localStorage-Zugriffe', () => {
  // Nur die drei storage*-Wrapper duerfen localStorage direkt anfassen
  // (Safari-Privatmodus/volles Quota werfen sonst beim App-Start).
  const direct = (clientJs.match(/localStorage\./g) || []).length;
  assert.ok(direct <= 3, `${direct} direkte localStorage-Zugriffe (erwartet: max. 3 in den Wrappern)`);
});

test('i18n-Vertrag: alle I18N_STATIC-Eintraege existieren im HTML', () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8'), ctx);
  const plainHtml = html.replace(/&amp;/g, '&');
  const missing = Object.keys(ctx.window.I18N_STATIC).filter((de) => !plainHtml.includes(de));
  assert.deepEqual(missing, [], `STATIC-Eintraege ohne HTML-Gegenstueck: ${missing.slice(0, 3).join(' | ')}`);
});

test('i18n-Vertrag: Server-Muster sind gueltige RegExp-Paare', () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8'), ctx);
  for (const entry of ctx.window.I18N_SERVER_PATTERNS) {
    // instanceof RegExp scheitert cross-realm (vm-Kontext) -> Duck-Typing
    assert.ok(
      entry.length === 2 && typeof entry[0].test === 'function' && typeof entry[1] === 'string',
      `kaputtes Muster: ${String(entry[0]).slice(0, 60)}`
    );
    assert.doesNotThrow(() => entry[0].test('probe')); // Muster ist anwendbar
  }
});
