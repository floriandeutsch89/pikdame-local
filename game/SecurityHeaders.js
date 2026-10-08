/** Security headers sent by the app itself, so they ship with the image.
 *  The CSP allows index.html's inline scripts by hash, computed from the very
 *  file this process serves: an edited script can no longer drift from its hash
 *  (it did once while the CSP lived in a separately deployed Caddyfile). */
const crypto = require('crypto');

/** Inline <script> bodies; JSON-LD is data, script-src does not apply to it. */
function inlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

const hashOf = (body) => `sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}`;

// Host header values only; anything else falls back to 'self' alone.
const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

/** Returns headersFor(hostHeader). With an https baseUrl the WebSocket origin and
 *  HSTS are fixed to it; without one (local stacks) ws:// follows the Host header. */
function createSecurityHeaders({ html, baseUrl }) {
  const scriptHashes = inlineScripts(html.replace(/\r\n/g, '\n')).map((b) => `'${hashOf(b)}'`);
  let fixedWs = null;
  let https = false;
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      https = u.protocol === 'https:';
      fixedWs = `${https ? 'wss' : 'ws'}://${u.host}`;
    } catch { /* invalid base URL: per-request origin below */ }
  }

  const csp = (wsOrigin) => [
    "default-src 'self'",
    ['script-src', "'self'", ...scriptHashes].join(' '),
    // CSSOM writes and SVG presentation attributes need inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // Spelled out on top of 'self': Safari has not always matched ws(s) against it.
    ['connect-src', "'self'", wsOrigin].filter(Boolean).join(' '),
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');

  const base = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (https) base['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  const fixed = fixedWs ? { ...base, 'Content-Security-Policy': csp(fixedWs) } : null;

  return function headersFor(host) {
    if (fixed) return fixed;
    const ws = typeof host === 'string' && HOST_RE.test(host) ? `ws://${host}` : null;
    return { ...base, 'Content-Security-Policy': csp(ws) };
  };
}

module.exports = { createSecurityHeaders, inlineScripts, hashOf };
