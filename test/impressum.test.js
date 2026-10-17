/** The legal page builds provider and contact from public/impressum.js. Inline it
 *  was blocked by the CSP and the page showed empty blocks from 2.58.0 on. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');

test('the legal page shows the provider and reveals the e-mail on a click', () => {
  const html = fs.readFileSync(path.join(pub, 'impressum.html'), 'utf8');
  assert.match(html, /<script src="\/impressum\.js" defer><\/script>/);
  const { window } = new JSDOM(html, { runScripts: 'outside-only' });
  window.eval(fs.readFileSync(path.join(pub, 'impressum.js'), 'utf8'));
  const doc = window.document;

  const provider = doc.getElementById('providerBlock');
  assert.strictEqual(provider.querySelectorAll('br').length, 3, 'name, street, city and country on four lines');
  assert.match(provider.textContent, /Deutschland$/);

  const contact = doc.getElementById('contactBlock');
  assert.strictEqual(contact.querySelector('a'), null, 'no address before the click');
  contact.querySelector('button').click();
  const link = contact.querySelector('a[href^="mailto:"]');
  assert.ok(link, 'mailto link after the click');
  assert.strictEqual(link.getAttribute('href'), `mailto:${link.textContent}`);
  assert.match(link.textContent, /^[^@\s]+@[^@\s]+\.[a-z]+$/);
});
