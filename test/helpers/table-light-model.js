/** The table light of style.css as numbers, for test/table-light-css.test.js: reads the
 *  TABLE LIGHT section and evaluates its custom properties (var, calc, oklab(from),
 *  rgb, color-mix) per theme and phase weights. Colours are sRGB 0..1, unclamped until
 *  painted; painting clips per channel, as Chrome does on an sRGB screen. */
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'style.css'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const START = CSS.indexOf('/* ============================ TABLE LIGHT');
const END = CSS.indexOf('\n#topBar {', START);
const SECTION = stripComments(CSS.slice(START, END));

/** Rules of a CSS text in order: { prelude, at: enclosing at-rules, decls: Map }. */
function rules(text) {
  const out = [];
  const walk = (src, outer) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const prelude = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < src.length && depth; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0;
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith('@')) walk(body, [...outer, prelude]);
      else {
        const decls = new Map();
        let paren = 0;
        let from = 0;
        for (let k = 0; k <= body.length; k++) {
          const ch = body[k];
          if (ch === '(') paren++;
          else if (ch === ')') paren--;
          else if ((ch === ';' || k === body.length) && paren === 0) {
            const m = /^([a-z-]+)\s*:\s*([\s\S]+)$/i.exec(body.slice(from, k).trim());
            from = k + 1;
            if (m) decls.set(m[1], m[2].replace(/\s+/g, ' ').trim());
          }
        }
        out.push({ prelude, at: outer, decls });
      }
      i = j;
    }
  };
  walk(text, []);
  return out;
}
const RULES = rules(SECTION);
const SUPPORTS = RULES.filter((r) => r.at.some((a) => a.startsWith('@supports')));
const ruleOf = (prelude, list = SUPPORTS) => list.find((r) => r.prelude === prelude);

// --- Theme tokens, read like test/theme-contrast does ---------------------------
function varsOf(block) {
  const v = {};
  for (const m of stripComments(block).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) v[m[1]] = m[2].trim();
  return v;
}
const ROOT = varsOf(CSS.match(/\n:root \{([\s\S]*?)\n\}/)[1]);
const THEMES = ['table', 'night', 'felt', 'love', 'bordeaux', 'kitchen'];
const themeTokens = (name) => ({ ...ROOT, ...varsOf(CSS.match(new RegExp(`\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`))[1]) });

// --- Colour maths ----------------------------------------------------------------
const toLin = (c) => (Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (Math.abs(c) <= 0.0031308 ? 12.92 * c : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055));
function toOklab({ r, g, b }) {
  const [R, G, B] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, A, B], alpha) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const [r, g, b] = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(toGam);
  return { r, g, b, a: alpha };
}
const clip = (c) => ({ r: Math.min(1, Math.max(0, c.r)), g: Math.min(1, Math.max(0, c.g)), b: Math.min(1, Math.max(0, c.b)), a: c.a });
/** `top` painted over an opaque `bottom` (source-over in sRGB, as browsers paint). */
function over(top, bottom) {
  const t = clip(top);
  return { r: t.r * t.a + bottom.r * (1 - t.a), g: t.g * t.a + bottom.g * (1 - t.a), b: t.b * t.a + bottom.b * (1 - t.a), a: 1 };
}
const lum = (c) => { const p = clip(c); return 0.2126 * toLin(p.r) + 0.7152 * toLin(p.g) + 0.0722 * toLin(p.b); };
/** WCAG 2 contrast of `fg` (translucent text is painted over `bg` first) on an opaque `bg`. */
function contrast(fg, bg) {
  const x = lum(fg.a < 1 ? over(fg, bg) : fg);
  const y = lum(bg);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function lab(c) { // CIELAB (D65), for CIEDE2000
  const p = clip(c);
  const [r, g, b] = [p.r, p.g, p.b].map(toLin);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function deltaE2000(c1, c2) {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const [a1p, a2p] = [(1 + G) * a1, (1 + G) * a2];
  const [C1p, C2p] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const hue = (y, x) => { const v = Math.atan2(y, x) / rad; return v < 0 ? v + 360 : v; };
  const [h1p, h2p] = [hue(b1, a1p), hue(b2, a2p)];
  let dhp = 0;
  if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p) { hbp = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2; if (hbp >= 360) hbp -= 360; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Rt = -Math.sin(2 * 30 * Math.exp(-(((hbp - 275) / 25) ** 2)) * rad) * Rc;
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const [dL, dC, dH] = [(L2 - L1) / Sl, (C2p - C1p) / Sc, dHp / Sh];
  return Math.sqrt(dL ** 2 + dC ** 2 + dH ** 2 + Rt * dC * dH);
}

// --- Evaluating values: var(), calc(), oklab(from ...), rgb()/rgba(), color-mix(in srgb) --
function tokenize(s) {
  const out = [];
  const valueLike = () => out.length && ['num', 'ident', ')'].includes(out[out.length - 1].t);
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('(),/*'.includes(c)) { out.push({ t: c }); i++; continue; }
    const hash = /^#[0-9a-f]{3,8}\b/i.exec(s.slice(i));
    if (hash) { out.push({ t: 'hash', v: hash[0] }); i += hash[0].length; continue; }
    const num = /^[+-]?(?:\d+\.?\d*|\.\d+)(%|[a-z]+)?/i.exec(s.slice(i));
    if (num && (/[\d.]/.test(c) || !valueLike())) { out.push({ t: 'num', v: parseFloat(num[0]), u: num[1] || '' }); i += num[0].length; continue; }
    if ((c === '+' || c === '-') && !/^-[a-z-]/i.test(s.slice(i))) { out.push({ t: c }); i++; continue; }
    const id = /^-?-?[a-z][a-z0-9-]*/i.exec(s.slice(i));
    if (!id) throw new Error(`cannot read "${s.slice(i, i + 20)}"`);
    i += id[0].length;
    if (s[i] === '(') { out.push({ t: 'fn', v: id[0].toLowerCase() }); i++; } else out.push({ t: 'ident', v: id[0] });
  }
  return out;
}
/** Substitutes var() from `vars` (raw strings), recursively. */
function substitute(value, vars, seen = new Set()) {
  return value.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,([^()]*))?\)/gi, (m, name, fallback) => {
    assert.ok(!seen.has(name), `cyclic ${name}`);
    const raw = vars[name] !== undefined ? vars[name] : fallback;
    assert.ok(raw !== undefined, `undefined ${name}`);
    return substitute(String(raw).trim(), vars, new Set([...seen, name]));
  });
}
const parseHex = (h) => {
  const x = h.length === 4 ? [...h.slice(1)].map((c) => c + c).join('') : h.slice(1);
  return { r: parseInt(x.slice(0, 2), 16) / 255, g: parseInt(x.slice(2, 4), 16) / 255, b: parseInt(x.slice(4, 6), 16) / 255, a: 1 };
};
/** One value: a colour, a { v, u } number, or a list of them (box-shadow). */
function evaluate(value, vars) {
  const toks = tokenize(substitute(value, vars));
  let p = 0;
  const peek = () => toks[p] || { t: 'end' };
  const eat = (t) => { assert.strictEqual(peek().t, t, `expected ${t} in ${value}`); return toks[p++]; };
  const num = (v, u = '') => ({ v, u });
  function arith(x, op, y) {
    if (op === '*') return num(x.v * y.v, x.u || y.u);
    if (op === '/') return num(x.v / y.v, x.u);
    assert.ok(!x.u || !y.u || x.u === y.u, `unit mix ${x.u} ${op} ${y.u} in ${value}`);
    return num(op === '+' ? x.v + y.v : x.v - y.v, x.u || y.u);
  }
  function expr(ch) {
    let x = term(ch);
    while (peek().t === '+' || peek().t === '-') { const op = toks[p++].t; x = arith(x, op, term(ch)); }
    return x;
  }
  function term(ch) {
    let x = factor(ch);
    while (peek().t === '*' || peek().t === '/') { const op = toks[p++].t; x = arith(x, op, factor(ch)); }
    return x;
  }
  function factor(ch) {
    const t = toks[p++];
    if (t.t === 'num') return num(t.v, t.u);
    if (t.t === 'ident' && ch && t.v in ch) return num(ch[t.v]);
    if (t.t === '(' || (t.t === 'fn' && t.v === 'calc')) { const x = expr(ch); eat(')'); return x; }
    throw new Error(`unexpected ${JSON.stringify(t)} in ${value}`);
  }
  // Outside calc() a value is one component: a top-level "/" separates the alpha.
  const component = factor;
  function colour() {
    const t = toks[p++];
    if (t.t === 'hash') return parseHex(t.v);
    if (t.t === 'ident' && t.v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (t.t === 'fn' && (t.v === 'rgb' || t.v === 'rgba')) {
      const parts = [component()];
      while (peek().t !== ')' && peek().t !== '/') { if (peek().t === ',') p++; parts.push(component()); }
      let a = parts[3] ? parts[3].v : 1;
      if (peek().t === '/') { p++; a = component().v; }
      eat(')');
      return { r: parts[0].v / 255, g: parts[1].v / 255, b: parts[2].v / 255, a };
    }
    if (t.t === 'fn' && t.v === 'oklab') {
      assert.strictEqual(eat('ident').v, 'from');
      const origin = colour();
      const [l, a, b] = toOklab(origin);
      const ch = { l, a, b, alpha: origin.a };
      const lab3 = [component(ch).v, component(ch).v, component(ch).v];
      let alpha = origin.a;
      if (peek().t === '/') { p++; alpha = component(ch).v; }
      eat(')');
      return fromOklab(lab3, alpha);
    }
    if (t.t === 'fn' && t.v === 'color-mix') {
      assert.strictEqual(eat('ident').v, 'in');
      assert.strictEqual(eat('ident').v, 'srgb');
      eat(',');
      const c1 = colour();
      const p1 = peek().t === ',' ? null : component().v / 100;
      eat(',');
      const c2 = colour();
      const p2 = peek().t === ')' ? null : component().v / 100;
      eat(')');
      const w1 = p1 === null ? 1 - p2 : p1;
      const w2 = p2 === null ? 1 - w1 : p2;
      const a = c1.a * w1 + c2.a * w2;
      const mix = (k) => (a ? (c1[k] * c1.a * w1 + c2[k] * c2.a * w2) / a : 0);
      return { r: mix('r'), g: mix('g'), b: mix('b'), a };
    }
    throw new Error(`not a colour: ${JSON.stringify(t)} in ${value}`);
  }
  const list = [];
  while (p < toks.length) {
    const t = peek();
    list.push(t.t === 'num' || (t.t === 'fn' && t.v === 'calc') ? component() : colour());
  }
  return list.length === 1 ? list[0] : list;
}

/** What the light paints on #table for `theme` at phase weights `w` ({ m, d, e, n });
 *  `overrides` replaces custom properties (calibration). */
function light(theme, w, overrides = {}) {
  const vars = { ...themeTokens(theme) };
  for (const r of [ruleOf(':root', RULES), ruleOf('#table', RULES), ruleOf('#table'), ruleOf(`[data-theme="${theme}"] #table`)]) {
    if (r) for (const [k, v] of r.decls) if (k.startsWith('--')) vars[k] = v;
  }
  Object.assign(vars, overrides);
  for (const k of ['m', 'd', 'e', 'n']) vars[`--tod-${k}`] = String(w[k]);
  const get = (name) => evaluate(vars[name], vars);
  return {
    vars,
    get,
    bg: parseHex(vars['--bg']),
    glow: parseHex(vars['--bg-glow']),
    felt: get('--felt'),
    text: get('--text'),
    muted: get('--text-muted'),
    glass: get('--glass'),
    spot: get('--spot'),
    vignette: get('--vignette'),
    daylight: get('--daylight'),
    pool: get('--pool-c'),
    window: get('--window-c'),
    roomInk: get('--room-ink'),
  };
}

module.exports = {
  CSS, START, END, SECTION, RULES, SUPPORTS, ruleOf, stripComments, THEMES,
  over, lum, contrast, deltaE2000, toOklab, light,
};
