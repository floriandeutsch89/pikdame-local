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

// Themenseiten: je eine Seite pro Hauptthema (eine Seite kann nur fuer EIN
// Thema ranken). Slugs stehen auch in server.js - dort ohne .html erreichbar.
const TOPIC_PAGES = ['romme-regeln', 'pik-dame-regeln', 'kartenspiele-zu-zweit'];

test('sitemap lists the canonical URL and nothing disallowed', () => {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    locs,
    [CANONICAL, ...TOPIC_PAGES.map((s) => `${CANONICAL}${s}`)],
    'sitemap should list the game plus exactly the topic pages'
  );
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


test('every topic page is reachable, self-canonical, indexable and linked from the game', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const slug of TOPIC_PAGES) {
    const file = path.join(__dirname, '..', 'public', `${slug}.html`);
    assert.ok(fs.existsSync(file), `public/${slug}.html is missing`);
    const page = fs.readFileSync(file, 'utf8');

    // Selbst-kanonisch auf die SPRECHENDE Adresse: Waeren /slug und
    // /slug.html beide kanonisch, waere es doppelter Inhalt.
    assert.ok(
      page.includes(`<link rel="canonical" href="${CANONICAL}${slug}"`),
      `${slug}: canonical must point at the clean URL`
    );
    assert.ok(/<meta name="robots" content="index, follow/.test(page), `${slug}: must be indexable`);
    assert.ok(/<title>[^<]{20,}<\/title>/.test(page), `${slug}: needs a real title`);
    const desc = page.match(/<meta name="description" content="([^"]+)"/);
    assert.ok(desc && desc[1].length > 80, `${slug}: description too short to be useful`);
    assert.ok(/<h1>/.test(page), `${slug}: needs an h1`);

    // Der Server muss die sprechende Adresse kennen, sonst laeuft der
    // canonical-Verweis ins Leere (404).
    assert.ok(server.includes(`'${slug}'`), `${slug}: server.js does not route the clean URL`);

    // Und die Spielseite muss darauf verweisen - ohne interne Links wird
    // eine Seite kaum gefunden.
    assert.ok(html.includes(`href="/${slug}"`), `${slug}: not linked from the game page`);
  }
});

test('topic pages carry valid, page-specific structured data', () => {
  for (const slug of TOPIC_PAGES) {
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', `${slug}.html`), 'utf8');
    const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]));
    assert.ok(blocks.length >= 2, `${slug}: expected article + FAQ structured data`);
    const types = blocks.map((b) => b['@type']);
    assert.ok(types.includes('Article'), `${slug}: no Article block`);
    assert.ok(types.includes('FAQPage'), `${slug}: no FAQPage block`);
    // Die Daten muessen DIESE Seite beschreiben, nicht die Startseite.
    const article = blocks.find((b) => b['@type'] === 'Article');
    assert.equal(article.mainEntityOfPage['@id'], `${CANONICAL}${slug}`, `${slug}: Article points elsewhere`);
    for (const q of blocks.find((b) => b['@type'] === 'FAQPage').mainEntity) {
      assert.ok(q.name && q.name.length > 5, `${slug}: question without a name`);
      assert.ok(q.acceptedAnswer.text.length > 40, `${slug}: answer too short: ${q.name}`);
    }
  }
});
