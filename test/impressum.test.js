/** The legal page: provider data from PIKDAME_IMPRINT_*, rendered by the server,
 *  decoded by public/impressum.js (a file, because the CSP blocks inline scripts). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { readImprint, renderImprintPage, NOT_CONFIGURED } = require('../game/Imprint');

const pub = path.join(__dirname, '..', 'public');
const template = fs.readFileSync(path.join(pub, 'impressum.html'), 'utf8');
const ENV = {
  PIKDAME_IMPRINT_NAME: 'Max Muster',
  PIKDAME_IMPRINT_STREET: 'Musterstraße 1',
  PIKDAME_IMPRINT_CITY: '12345 Musterstadt',
  PIKDAME_IMPRINT_EMAIL: 'impressum@example.org',
};

function load(env) {
  const html = renderImprintPage(template, readImprint(env));
  const { window } = new JSDOM(html, { runScripts: 'outside-only' });
  window.eval(fs.readFileSync(path.join(pub, 'impressum.js'), 'utf8'));
  return { html, doc: window.document };
}

test('the legal page shows the provider and reveals the e-mail on a click', () => {
  assert.match(template, /<script src="\/impressum\.js" defer><\/script>/);
  const { html, doc } = load(ENV);
  assert.ok(!/\{\{IMPRINT_/.test(html), 'every placeholder is filled');
  assert.ok(!html.includes('Musterstraße') && !html.includes('impressum@example.org'), 'no plain text for harvesters');

  const provider = doc.getElementById('providerBlock');
  assert.deepStrictEqual(provider.innerHTML.split('<br>'), ['Max Muster', 'Musterstraße 1', '12345 Musterstadt', 'Deutschland']);

  const contact = doc.getElementById('contactBlock');
  assert.strictEqual(contact.querySelector('a'), null, 'no address before the click');
  contact.querySelector('button').click();
  const link = contact.querySelector('a[href^="mailto:"]');
  assert.strictEqual(link.getAttribute('href'), 'mailto:impressum@example.org');
  assert.strictEqual(link.textContent, 'impressum@example.org');
});

test('without JavaScript the noscript fallback carries the data as entities', () => {
  const html = renderImprintPage(template, readImprint({ ...ENV, PIKDAME_IMPRINT_COUNTRY: 'Österreich' }));
  const { window } = new JSDOM(html);
  // Without scripting the parser decodes the entities: a browser shows plain lines.
  const block = (id) => window.document.querySelector(`#${id} noscript`).innerHTML;
  assert.deepStrictEqual(block('providerBlock').split('<br>'), ['Max Muster', 'Musterstraße 1', '12345 Musterstadt', 'Österreich']);
  assert.strictEqual(block('contactBlock'), 'E-Mail: impressum [at] example.org');
});

test('markup in a value stays text', () => {
  const { html, doc } = load({ ...ENV, PIKDAME_IMPRINT_NAME: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img'), 'not in the served HTML');
  const provider = doc.getElementById('providerBlock');
  assert.strictEqual(provider.querySelector('img'), null);
  assert.match(provider.textContent, /^<img src=x onerror=alert\(1\)>/);
});

test('missing variables: a visible notice instead of empty blocks, never a crash', () => {
  for (const env of [{}, { ...ENV, PIKDAME_IMPRINT_EMAIL: '  ' }]) {
    const imprint = readImprint(env);
    assert.strictEqual(imprint.configured, false);
    const { html, doc } = load(env);
    assert.ok(!/\{\{IMPRINT_/.test(html));
    assert.strictEqual(doc.getElementById('providerBlock').textContent, NOT_CONFIGURED);
    assert.strictEqual(doc.getElementById('contactBlock').textContent, '');
  }
  assert.deepStrictEqual(readImprint({ ...ENV, PIKDAME_IMPRINT_EMAIL: '' }).missing, ['PIKDAME_IMPRINT_EMAIL']);
});

// The operator's data must stay out of the public repo: the template carries only
// placeholders, the script no literal address. (Hashing the old values here would
// leak them again - a postcode or short mail name is easy to brute-force.)
test('no provider data in the tracked legal page and script', () => {
  const block = (id) => (template.match(new RegExp(`<p id="${id}"[^>]*>([^<]*)</p>`)) || [])[1];
  assert.strictEqual(block('providerBlock'), '{{IMPRINT_PROVIDER}}');
  assert.strictEqual(block('contactBlock'), '{{IMPRINT_CONTACT}}');
  const literals = fs.readFileSync(path.join(pub, 'impressum.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '').match(/'[^']*'/g) || [];
  assert.deepStrictEqual(literals.filter((l) => /\d{4,}|@|\.(org|de|com)\b|stra(ss|ß)e|allee|weg\b/i.test(l)), []);
});
