/** The display font is a vendored asset like the browser libraries: served
 *  from this origin, unchanged from its npm package, with its licence. */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

const faceUrls = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)]
  .flatMap((m) => [...m[0].matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((u) => u[1]));

test('fonts: every @font-face file is local, exists and has a known hash', () => {
  assert.ok(faceUrls.length >= 1, 'expected the display font face');
  const readme = fs.readFileSync(path.join(pub, 'fonts', 'README.md'), 'utf8');
  for (const url of faceUrls) {
    assert.doesNotMatch(url, /^(?:https?:)?\/\//, `no font host in the load path: ${url}`);
    const file = path.join(pub, url.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `missing font file ${url}`);
    assert.ok(fs.statSync(file).size <= 60 * 1024, `${url} is over the 60 KB budget`);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.ok(readme.includes(sha), `${url} differs from the vendored file named in fonts/README.md (sha256 ${sha})`);
  }
  assert.ok(fs.existsSync(path.join(pub, 'fonts', 'OFL.txt')), 'the OFL licence ships next to the font');
});

test('fonts: the preload names the face file and the server types it', () => {
  const preload = html.match(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin/);
  assert.ok(preload, 'index.html preloads the display font (crossorigin, or the browser fetches it twice)');
  assert.ok(faceUrls.includes(preload[1]), `preload ${preload[1]} must match an @font-face url`);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /'\.woff2': 'font\/woff2'/, 'server.js serves .woff2 as font/woff2');
});
