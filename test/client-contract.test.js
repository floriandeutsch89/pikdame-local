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

// --- v1.36.1: changelog ordering guard -------------------------------------------
test('CHANGELOG: Versionen stehen streng absteigend (neueste ganz oben)', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const versions = [...text.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\]/gm)].map((m) =>
    m.slice(1, 4).map(Number)
  );
  assert.ok(versions.length > 10, 'parser sanity');
  for (let i = 1; i < versions.length; i++) {
    const [a, b] = [versions[i - 1], versions[i]];
    const newerFirst = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
    assert.ok(newerFirst, `Reihenfolge kaputt: ${a.join('.')} steht vor ${b.join('.')}`);
  }
});

// --- v1.78.1: UI-Größenstufen dürfen die Hand nie sprengen ----------------------
test('CSS contract: every uiscale card height fits into the matching #hand min-height', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const FAN_DIP = 6; // capped fan dip (see #hand base comment)
  const SELECT_LIFT = 14; // .card.selected { top: -14px }
  const baseHand = Number((css.match(/#hand \{[^}]*min-height:\s*(\d+)px/s) || [])[1]);
  const baseCard = Number((css.match(/\.card \{[^}]*height:\s*(\d+)px/s) || [])[1]);
  assert.ok(baseHand >= baseCard + FAN_DIP + SELECT_LIFT, `base: hand ${baseHand} >= card ${baseCard}+dip+lift`);
  for (const scale of ['large', 'xlarge']) {
    const cardM = css.match(new RegExp(`html\\[data-uiscale="${scale}"\\] #hand \\.card[^{]*\\{[^}]*height:\\s*(\\d+)px`));
    assert.ok(cardM, `${scale}: card height rule exists`);
    const cardH = Number(cardM[1]);
    // Die Stufe muss eine EIGENE #hand-min-height mitbringen, sobald ihre
    // Karten höher sind als die Basis-Reserve - sonst ragen die Karten über
    // die Werkzeugleiste (Live-Bug-Report mit Foto, uiscale xlarge).
    const handM = css.match(new RegExp(`html\\[data-uiscale="${scale}"\\] #hand \\{[^}]*min-height:\\s*(\\d+)px`));
    const handH = handM ? Number(handM[1]) : baseHand;
    assert.ok(handH >= cardH + FAN_DIP + SELECT_LIFT,
      `${scale}: #hand min-height ${handH}px must cover card ${cardH}px + dip + selection lift`);
  }
});
