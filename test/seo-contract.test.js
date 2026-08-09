/** SEO metadata is easy to break silently: a sitemap that points at the wrong
 *  host, a lastmod that stopped being a date, structured data that no longer
 *  parses as JSON. None of it shows up in the UI, so nothing else would catch
 *  it - Google would just quietly stop trusting the file. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
// Comments are stripped: the file explains WHY changefreq/priority are gone,
// and that explanation must not trip the check that they are gone.
const sitemap = read('sitemap.xml').replace(/<!--[\s\S]*?-->/g, '');
const robots = read('robots.txt');

const CANONICAL = 'https://play.pikdame.online/';

/** Inline JSON-LD data blocks, parsed. */
function jsonLd() {
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    // A structured-data block that does not parse is worth nothing at all.
    out.push(JSON.parse(m[1]));
  }
  return out;
}

test('sitemap lists the canonical URL and nothing disallowed', () => {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepStrictEqual(locs, [CANONICAL], 'sitemap should list exactly the canonical URL');
  assert.ok(html.includes(`<link rel="canonical" href="${CANONICAL}"`), 'canonical link differs from the sitemap');
  // Anything robots.txt disallows must not be advertised in the sitemap.
  for (const [, rule] of robots.matchAll(/^Disallow:\s*(\S+)/gm)) {
    assert.ok(!locs.some((l) => l.endsWith(rule)), `sitemap advertises a disallowed path: ${rule}`);
  }
});

test('sitemap lastmod is a real ISO date, and the ignored hints stay out', () => {
  const lastmod = sitemap.match(/<lastmod>([^<]+)<\/lastmod>/);
  assert.ok(lastmod, '<lastmod> is missing - it is the one hint Google actually reads');
  assert.match(lastmod[1], /^\d{4}-\d{2}-\d{2}$/, `not an ISO date: ${lastmod[1]}`);
  assert.ok(!Number.isNaN(Date.parse(lastmod[1])), `not a valid date: ${lastmod[1]}`);
  assert.ok(Date.parse(lastmod[1]) <= Date.now(), 'lastmod lies in the future');
  // Removed on purpose (Google states it ignores both) - keep them gone.
  assert.ok(!/<changefreq>|<priority>/.test(sitemap), 'changefreq/priority are ignored by Google');
});

test('robots.txt points at the sitemap and keeps the legal page out', () => {
  assert.match(robots, /^Sitemap:\s*https:\/\/play\.pikdame\.online\/sitemap\.xml$/m);
  assert.match(robots, /^Disallow:\s*\/impressum\.html$/m);
});

test('every JSON-LD block parses and describes THIS page', () => {
  const blocks = jsonLd();
  assert.ok(blocks.length >= 2, 'expected the game and the FAQ block');
  const game = blocks.find((b) => b['@type'] === 'VideoGame');
  assert.ok(game, 'VideoGame block missing');
  assert.strictEqual(game.url, CANONICAL, 'structured data points at a different URL');
});

test('the alternate spellings are in the structured data AND in visible copy', () => {
  // Deliberately BOTH: a name that exists only in metadata and never in the
  // page body is hidden text. The copy lives in the collapsed seoIntro
  // <details>, which a reader can open - that is what keeps this honest.
  const game = jsonLd().find((b) => b['@type'] === 'VideoGame');
  const body = html.slice(html.indexOf('class="seoIntro"'));
  for (const name of ['Pikdame', 'Pique Dame', 'Pik-Dame', 'Pik Dame Kartenspiel']) {
    assert.ok(game.alternateName.includes(name), `alternateName is missing ${name}`);
    assert.ok(body.includes(name), `${name} appears in metadata but nowhere a reader can see it`);
  }
});

test('the FAQ answers exist and are not empty', () => {
  const faq = jsonLd().find((b) => b['@type'] === 'FAQPage');
  assert.ok(faq, 'FAQPage block missing');
  for (const q of faq.mainEntity) {
    assert.ok(q.name && q.name.length > 5, `question without a name: ${JSON.stringify(q).slice(0, 60)}`);
    assert.ok(
      q.acceptedAnswer && typeof q.acceptedAnswer.text === 'string' && q.acceptedAnswer.text.length > 20,
      `answer too short for: ${q.name}`
    );
  }
});

test('the "kostenlos" search terms are in the metadata AND answered in visible copy', () => {
  // Vom Nutzer bestellt: "Kartenspiel kostenlos" und "Pik Dame kostenlos".
  // Dieselbe Regel wie oben - ein Begriff, der nur in Metadaten steht und
  // nirgends im lesbaren Text, waere versteckter Text.
  const game = jsonLd().find((b) => b['@type'] === 'VideoGame');
  const body = html.slice(html.indexOf('class="seoIntro"'));
  for (const term of ['Kartenspiel kostenlos', 'Pik Dame kostenlos']) {
    assert.ok(game.keywords.includes(term), `keywords are missing "${term}"`);
    assert.ok(body.includes(term), `"${term}" appears in metadata but nowhere a reader can see it`);
  }
  // Und die Aussage muss stimmen: Das Spiel ist als kostenfrei ausgezeichnet.
  assert.equal(game.isAccessibleForFree, true, 'claiming "kostenlos" requires isAccessibleForFree');
  assert.equal(game.offers.price, '0', 'the offer must state a price of zero');
});
