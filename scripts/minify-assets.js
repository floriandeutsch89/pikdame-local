/** Minifies the shipped JS/CSS IN PLACE - Docker image builds only.
 *
 *  The repository keeps readable sources on purpose: the hotspot/CodeApp mode
 *  serves public/ straight from the checkout and must stay build-free. This
 *  script therefore runs in the image build (see docker/Dockerfile), never as
 *  part of `npm start` or the tests.
 *
 *  index.html is deliberately NOT minified: the production CSP allows its
 *  inline splash script by sha256, and rewriting a single byte would change
 *  that hash and get the script blocked.
 *
 *  Run: node scripts/minify-assets.js [--check]
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const pub = path.join(__dirname, '..', 'public');
const TARGETS = ['client.js', 'i18n.js', 'vendor-qrcode.js', 'style.css'];

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

async function main() {
  const checkOnly = process.argv.includes('--check');
  let before = 0;
  let after = 0;

  for (const name of TARGETS) {
    const file = path.join(pub, name);
    const src = fs.readFileSync(file, 'utf8');
    const result = await esbuild.transform(src, {
      loader: name.endsWith('.css') ? 'css' : 'js',
      minify: true,
      // No `target`: esbuild must not rewrite syntax, only strip whitespace and
      // rename locals. Globals the client shares across files (qrcode,
      // I18N_STATIC, ...) keep their names because nothing is bundled.
      charset: 'utf8', // keep German umlauts literal instead of \u escapes
      legalComments: 'none',
    });
    before += Buffer.byteLength(src);
    after += Buffer.byteLength(result.code);
    console.log(`  ${name.padEnd(18)} ${kb(Buffer.byteLength(src)).padStart(9)} -> ${kb(Buffer.byteLength(result.code)).padStart(9)}`);
    if (!checkOnly) fs.writeFileSync(file, result.code);
  }

  console.log(`  ${'total'.padEnd(18)} ${kb(before).padStart(9)} -> ${kb(after).padStart(9)}`);
  if (checkOnly) console.log('  (--check: nothing written)');
}

main().catch((err) => {
  console.error('minify-assets failed:', err.message);
  process.exit(1);
});
