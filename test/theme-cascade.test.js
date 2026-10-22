// Theme contract, through the real cascade: a theme block's variables must be
// what applies. A later :root block of the same specificity silently won once,
// and felt's cyan draw ring turned gold next to its gold selection (--accent).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

/** Style rules in source order ({ selectors, body, order }); at-rules flattened, keyframes skipped. */
function styleRules(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') {
      const prelude = src.slice(start, i).trim();
      const inKeyframes = stack.some((s) => /^@(-webkit-)?keyframes\b/.test(s));
      if (!prelude.startsWith('@') && !inKeyframes) {
        const end = src.indexOf('}', i);
        out.push({ selectors: prelude.split(',').map((s) => s.trim()), body: src.slice(i + 1, end), order: out.length });
        i = end;
      } else {
        stack.push(prelude);
      }
      start = i + 1;
    } else if (src[i] === '}') {
      stack.pop();
      start = i + 1;
    } else if (src[i] === ';' && !stack.length) {
      start = i + 1;
    }
  }
  return out;
}
const RULES = styleRules(css);

/** Specificity [ids, classes, types] of a selector that matches <html data-theme="theme">
 *  itself, else null (descendants, other attributes, other themes). */
function rootSpecificity(selector, theme) {
  let rest = selector.trim();
  const spec = [0, 0, 0];
  if (!rest) return null;
  while (rest) {
    const m = rest.match(/^(?::root|html|\[data-theme(?:="([a-z-]+)")?\]|:not\(\[data-theme="([a-z-]+)"\]\))/);
    if (!m) return null;
    if (m[0] === 'html') spec[2] += 1;
    else if (m[0].startsWith(':not')) { if (m[2] === theme) return null; spec[1] += 1; }
    else { if (m[1] && m[1] !== theme) return null; spec[1] += 1; }
    rest = rest.slice(m[0].length);
  }
  return spec;
}
function declarations(body) {
  const out = new Map();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+?)\s*(!important)?\s*(?:;|$)/g)) out.set(m[1], { value: m[2].trim(), important: !!m[3] });
  return out;
}
const DECLS = RULES.map((r) => declarations(r.body));
const before = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
/** The value of a custom property on the root in a theme: !important, specificity, then order. */
function applied(theme, prop) {
  let best = null;
  RULES.forEach((r, i) => {
    const d = DECLS[i].get(prop);
    if (!d) return;
    for (const sel of r.selectors) {
      const spec = rootSpecificity(sel, theme);
      if (!spec) continue;
      const key = [d.important ? 1 : 0, ...spec, r.order];
      if (!best || !before(key, best.key)) best = { key, value: d.value, selector: sel };
    }
  });
  return best;
}
const THEMES = [...new Set([...css.matchAll(/\[data-theme="([a-z]+)"\]/g)].map((m) => m[1]))].sort();
/** The rule whose selector list names exactly this theme (table shares its block with :root). */
const themeRule = (theme) => RULES.find((r) => r.selectors.includes(`[data-theme="${theme}"]`));

test('theme cascade: the parser sees all six themes and their blocks', () => {
  assert.deepEqual(THEMES, ['bordeaux', 'felt', 'kitchen', 'love', 'night', 'table']);
  for (const t of THEMES) assert.ok(themeRule(t), `block for ${t}`);
  assert.ok(RULES.length > 500, `parsed ${RULES.length} rules`);
});

for (const theme of THEMES) {
  test(`theme cascade (${theme}): every variable its block sets is the one that applies`, () => {
    const own = declarations(themeRule(theme).body);
    const lost = [];
    for (const [prop, d] of own) {
      const won = applied(theme, prop);
      if (won.value !== d.value) lost.push(`${prop}: ${d.value} loses to ${won.value} (${won.selector})`);
    }
    assert.deepEqual(lost, [], `${theme}: overridden by a later rule`);
  });
}

// CLAUDE.md: --accent (selection) and --drawn stay distinct in every theme.
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
test('theme cascade: the applied --drawn differs clearly from the applied --accent in every theme', () => {
  for (const theme of THEMES) {
    const drawn = applied(theme, '--drawn');
    const accent = applied(theme, '--accent');
    assert.ok(drawn && /^#[0-9a-f]{6}$/i.test(drawn.value), `${theme}: --drawn applies`);
    assert.ok(accent && /^#[0-9a-f]{6}$/i.test(accent.value), `${theme}: --accent applies`);
    const dist = rgb(drawn.value).reduce((s, v, i) => s + Math.abs(v - rgb(accent.value)[i]), 0);
    assert.ok(dist > 150, `${theme}: --drawn ${drawn.value} too close to --accent ${accent.value} (${dist})`);
  }
  // The two gold themes draw in cyan (the bug: felt fell back to the amber default).
  assert.strictEqual(applied('felt', '--drawn').value, '#5ad1ff');
  assert.strictEqual(applied('bordeaux', '--drawn').value, '#5ad1ff');
});
