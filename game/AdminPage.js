// game/AdminPage.js
// Read-only operator page at /admin: the config report, a few runtime facts
// and a mail check. No I/O here - server.js wires requests to these helpers.
//
// Off unless PIKDAME_ADMIN_TOKEN (or _FILE) is set; then /admin answers 404,
// the same as any unknown path. Login is HTTP Basic auth, the password is
// checked against an Argon2id hash (see AdminToken.js): no JavaScript and no cookie needed, so the page works under the
// site's strict CSP unchanged. The browser re-sends Basic credentials on its
// own, so the one state-changing form (test mail) carries a CSRF token.
const crypto = require('crypto');
const { STATUS_ICON } = require('./ConfigReport');

/** Password from an `Authorization: Basic ...` header, or null. The user
 *  name is ignored - there is exactly one operator credential. Checking it
 *  is AdminToken's job (Argon2 hash or plain token). */
function basicPassword(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/** CSRF token for the admin forms: derived from the admin token, so it is
 *  stable across restarts and unknown to anyone without the token. */
function csrfToken(token) {
  return crypto.createHmac('sha256', String(token)).update('pikdame-admin-csrf').digest('hex');
}

function csrfValid(given, token) {
  const expected = csrfToken(token);
  return typeof given === 'string' && given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** A recipient we are willing to put into an SMTP dialogue. CR/LF would let
 *  the field inject headers or SMTP commands. */
function validRecipient(to) {
  return typeof to === 'string' && to.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to);
}

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} T ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

// Every variable behind an entry: set ones highlighted, unset ones dimmed
// (default in use). Missing ones are already listed above - not repeated.
function varList(item) {
  const vars = (item.vars || []).filter((x) => !item.missing.includes(x.name));
  if (!vars.length) return '';
  return `<div class="vars">${vars.map((x) =>
    `<code class="${x.set ? 'set' : 'unset'}" title="${x.set ? 'gesetzt' : 'nicht gesetzt - Standardwert'}">${esc(x.name)}</code>`).join(' ')}</div>`;
}

/**
 * @param {object} p
 * @param {object[]} p.report   buildConfigReport() output
 * @param {object} p.runtime    { version, uptimeSeconds, sessions, connectedPlayers, rssMb, node }
 * @param {object|null} p.smtpProbe  last probe { ok, reason, at }
 * @param {object|null} p.notice     result of the last form action { ok, text }
 * @param {string} p.csrf
 * @param {boolean} p.mailConfigured
 */
function renderAdminPage({ report, runtime, smtpProbe, notice, csrf, mailConfigured }) {
  const order = { error: 0, warn: 1, ok: 2, off: 3 };
  const rows = [...report].sort((a, b) => order[a.status] - order[b.status]).map((i) => `
      <tr class="${i.status}"><td class="icon">${STATUS_ICON[i.status]}</td><th>${esc(i.label)}</th><td>${esc(i.detail)}${
        i.missing.length ? `<div class="missing">fehlt: ${i.missing.map((m) => `<code>${esc(m)}</code>`).join(' ')}</div>` : ''
      }${varList(i)}</td></tr>`).join('');
  const problems = report.filter((i) => i.status === 'error' || i.status === 'warn').length;
  const probeLine = !mailConfigured
    ? 'Kein SMTP-Server konfiguriert.'
    : smtpProbe
      ? `${smtpProbe.ok ? '✓ Anmeldung am SMTP-Server erfolgreich' : `✗ ${esc(smtpProbe.reason)}`} <span class="muted">(${esc(new Date(smtpProbe.at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }))})</span>`
      : 'Noch nicht geprüft.';
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Pik Dame · Admin</title>
<style>
:root{color-scheme:dark;--bg:#101318;--panel:#1a1f27;--line:#2a313c;--text:#eef1f4;--muted:#94a0ad;--ok:#43dd9a;--warn:#f5c542;--error:#ff7d7d;--accent:#2fd6b0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px 16px 40px}
main{max-width:760px;margin:0 auto}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1rem;margin:28px 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.sum{color:var(--muted);margin:0 0 8px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
table{width:100%;border-collapse:collapse}td,th{padding:10px 12px;border-top:1px solid var(--line);text-align:left;vertical-align:top}tr:first-child td,tr:first-child th{border-top:0}
th{font-weight:600;white-space:nowrap;width:1%}.icon{width:1%;font-weight:800}
tr.ok .icon{color:var(--ok)}tr.warn .icon{color:var(--warn)}tr.error .icon{color:var(--error)}tr.off{color:var(--muted)}
.missing{margin-top:4px;font-size:.88em;color:var(--warn)}
.vars{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}.vars code.set{color:var(--ok);border:1px solid rgba(67,221,154,.35)}.vars code.unset{color:var(--muted);opacity:.7}
.legend{color:var(--muted);font-size:.85em;margin:8px 2px 0}.legend code.set{color:var(--ok)}code{background:#0b0e12;padding:1px 5px;border-radius:5px;font-size:.88em}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0;padding:12px}dt{color:var(--muted)}dd{margin:0}
form{display:flex;flex-wrap:wrap;gap:8px;padding:12px}input{flex:1 1 220px;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:#0b0e12;color:var(--text);font:inherit}
button{min-height:44px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:#252c36;color:var(--text);font:inherit;font-weight:600;cursor:pointer}button.primary{background:var(--accent);color:#03241b;border-color:var(--accent)}
.notice{margin:12px 0;padding:10px 12px;border-radius:10px;border:1px solid var(--line)}.notice.ok{border-color:var(--ok)}.notice.err{border-color:var(--error)}
.muted{color:var(--muted)}.probe{padding:12px 12px 0}
td{overflow-wrap:anywhere}
/* Phone: icon + label on one line, details below - three columns overflowed */
@media (max-width:560px){table,tbody{display:block}tr{display:grid;grid-template-columns:auto 1fr;border-top:1px solid var(--line)}tr:first-child{border-top:0}
td,th{border-top:0;width:auto}tr>td:last-child{grid-column:1/-1;padding-top:0}}
</style></head><body><main>
<h1>Pik Dame · Admin</h1>
<p class="sum">${problems ? `${problems} Punkt(e) brauchen Aufmerksamkeit.` : 'Alles vollständig konfiguriert.'} Werte von Secrets werden nie angezeigt.</p>
${notice ? `<div class="notice ${notice.ok ? 'ok' : 'err'}">${esc(notice.text)}</div>` : ''}
<h2>Konfiguration</h2>
<div class="panel"><table>${rows}</table></div>
<p class="legend">Variablen: <code class="set">grün</code> = gesetzt, grau = nicht gesetzt (Standardwert). Werte werden nicht angezeigt.</p>
<h2>E-Mail prüfen</h2>
<div class="panel">
<p class="probe">${probeLine}</p>
<form method="post" action="/admin/mail">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="email" name="to" placeholder="Empfänger für die Testmail" autocomplete="email">
<button type="submit" name="action" value="probe">Verbindung prüfen</button>
<button type="submit" name="action" value="send" class="primary">Testmail senden</button>
</form></div>
<h2>Laufzeit</h2>
<div class="panel"><dl>
<dt>Version</dt><dd>${esc(runtime.version)}</dd>
<dt>Laufzeit</dt><dd>${esc(formatUptime(runtime.uptimeSeconds))}</dd>
<dt>Spiele</dt><dd>${esc(runtime.sessions)}</dd>
<dt>Verbundene Spieler</dt><dd>${esc(runtime.connectedPlayers)}</dd>
<dt>Speicher</dt><dd>${esc(runtime.rssMb)} MB</dd>
<dt>Node</dt><dd>${esc(runtime.node)}</dd>
</dl></div>
</main></body></html>`;
}

module.exports = { basicPassword, csrfToken, csrfValid, validRecipient, renderAdminPage };
