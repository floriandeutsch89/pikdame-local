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
const BotTower = require('./BotTower');

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
  // The value shows on hover - and on tap, since phones have no hover
  // (tabindex makes the chip focusable, CSS shows the bubble on :focus).
  const tip = (x) => (!x.set ? 'nicht gesetzt - Standardwert'
    : x.secret ? 'geheim - Wert wird nicht angezeigt'
      : x.value);
  return `<div class="vars">${vars.map((x) =>
    `<code class="${x.set ? 'set' : 'unset'}${x.secret ? ' secret' : ''}" tabindex="0" data-tip="${esc(tip(x))}">${esc(x.name)}</code>`).join(' ')}</div>`;
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' }) : '–');
const fmtNum = (v, digits = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits }));

const STYLE = `
:root{color-scheme:dark;--bg:#101318;--panel:#1a1f27;--line:#2a313c;--text:#eef1f4;--muted:#94a0ad;--ok:#43dd9a;--warn:#f5c542;--error:#ff7d7d;--accent:#2fd6b0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px 16px 40px}
main{max-width:960px;margin:0 auto}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1rem;margin:28px 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.sum{color:var(--muted);margin:0 0 8px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
nav.tabs{display:flex;gap:6px;margin:14px 0 4px;border-bottom:1px solid var(--line);overflow-x:auto}
nav.tabs a{padding:10px 14px;min-height:44px;display:inline-flex;align-items:center;color:var(--muted);text-decoration:none;font-weight:600;border-bottom:2px solid transparent;white-space:nowrap}
nav.tabs a.active{color:var(--text);border-bottom-color:var(--accent)}
table{width:100%;border-collapse:collapse}td,th{padding:10px 12px;border-top:1px solid var(--line);text-align:left;vertical-align:top}tr:first-child td,tr:first-child th{border-top:0}
table.cfg th{font-weight:600;white-space:nowrap;width:1%}.icon{width:1%;font-weight:800}
tr.ok .icon{color:var(--ok)}tr.warn .icon{color:var(--warn)}tr.error .icon{color:var(--error)}tr.off{color:var(--muted)}
.missing{margin-top:4px;font-size:.88em;color:var(--warn)}
.vars{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}
.vars code{position:relative;cursor:help;outline:none}
.vars code:focus-visible{box-shadow:0 0 0 2px var(--accent)}
.vars code[data-tip]:hover::after,.vars code[data-tip]:focus::after{content:attr(data-tip);position:absolute;left:0;top:calc(100% + 6px);z-index:5;
  max-width:min(420px,80vw);width:max-content;white-space:normal;overflow-wrap:anywhere;padding:6px 9px;border-radius:8px;
  background:#0b0e12;border:1px solid var(--line);color:var(--text);font-size:.95em;box-shadow:0 6px 18px rgba(0,0,0,.45)}
.vars code.secret[data-tip]:hover::after,.vars code.secret[data-tip]:focus::after{color:var(--muted);font-style:italic}.vars code.set{color:var(--ok);border:1px solid rgba(67,221,154,.35)}.vars code.unset{color:var(--muted);opacity:.7}
.legend{color:var(--muted);font-size:.85em;margin:8px 2px 0}.legend code.set{color:var(--ok)}code{background:#0b0e12;padding:1px 5px;border-radius:5px;font-size:.88em}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0;padding:12px}dt{color:var(--muted)}dd{margin:0}
form{display:flex;flex-wrap:wrap;gap:8px;padding:12px}input{flex:1 1 220px;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:#0b0e12;color:var(--text);font:inherit}
button{min-height:44px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:#252c36;color:var(--text);font:inherit;font-weight:600;cursor:pointer}button.primary{background:var(--accent);color:#03241b;border-color:var(--accent)}
button.danger{background:transparent;border-color:rgba(255,125,125,.5);color:var(--error)}button.danger.solid{background:var(--error);color:#2a0606;border-color:var(--error)}
.notice{margin:12px 0;padding:10px 12px;border-radius:10px;border:1px solid var(--line)}.notice.ok{border-color:var(--ok)}.notice.err{border-color:var(--error)}
.notice form{padding:10px 0 0}
.muted{color:var(--muted)}.probe{padding:12px 12px 0}
td{overflow-wrap:anywhere}
/* Users: a wide table scrolls sideways inside its panel instead of the page */
.scroll{overflow-x:auto}table.users{min-width:760px}table.users th{color:var(--muted);font-weight:600;font-size:.85em;white-space:nowrap}
table.users td{overflow-wrap:normal;white-space:nowrap}table.users .mail{color:var(--muted);font-size:.88em;margin-top:2px}table.users td.num{text-align:right;font-variant-numeric:tabular-nums}table.users form{display:inline-flex;padding:0;flex-wrap:nowrap}
table.users button{min-height:36px;padding:0 12px;font-size:.88em;background:rgba(47,214,176,.1);border-color:rgba(47,214,176,.6);color:var(--accent)}
table.users button:hover{background:rgba(47,214,176,.2)}
table.users button.danger{background:rgba(255,125,125,.1);border-color:rgba(255,125,125,.75);color:var(--error)}
table.users button.danger:hover{background:rgba(255,125,125,.2)}.actions{display:flex;gap:6px;flex-wrap:nowrap}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.82em;border:1px solid var(--line);white-space:nowrap}.badge.ok{color:var(--ok);border-color:rgba(67,221,154,.4)}
.badge.warn{color:var(--warn);border-color:rgba(245,197,66,.4)}.badge.error{color:var(--error);border-color:rgba(255,125,125,.4)}
/* Monitoring cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.card h3{margin:0 0 4px;font-size:.85rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.big{font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums}.big small{font-size:.9rem;color:var(--muted);font-weight:500}
.bar{height:6px;border-radius:3px;background:#0b0e12;margin:8px 0 4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
.bar i.warn{background:var(--warn)}.bar i.error{background:var(--error)}
/* History charts (uPlot, public/admin-monitor.js) */
nav.ranges{display:flex;gap:6px;margin:0 0 12px;flex-wrap:wrap}
nav.ranges a{padding:0 14px;min-height:36px;display:inline-flex;align-items:center;border-radius:999px;border:1px solid var(--line);color:var(--muted);text-decoration:none;font-weight:600;font-size:.9em}
nav.ranges a.active{color:#03241b;background:var(--accent);border-color:var(--accent)}
.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px}
@media (max-width:520px){.charts{grid-template-columns:1fr}}
.chart{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 12px 6px;min-width:0}
.chart .chead{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline;margin-bottom:4px}
.chart h3{margin:0;font-size:.85rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.chart .plot{width:100%}
.uplot{font-family:inherit}.u-legend{color:var(--text);font-size:.82em}.u-legend .u-marker{border-radius:2px}
.u-select{background:rgba(47,214,176,.12)}
.sub{color:var(--muted);font-size:.85em}
/* Phone: one card per user - in a sideways-scrolling table the action
   buttons sat off screen, and iOS hides the scroll hint. */
@media (max-width:600px){.scroll{overflow-x:visible}table.users{min-width:0}table.users thead{display:none}
table.users,table.users tbody,table.users tr{display:block}table.users tr{padding:12px 14px;border-top:1px solid var(--line)}table.users tr:first-child{border-top:0}
table.users td{display:inline-block;border:0;padding:2px 12px 2px 0;white-space:normal}
table.users td.name{font-size:1.05em;display:block}table.users td.date{display:block}
table.users td.num{text-align:left}table.users td.num::before,table.users td.date::before{content:attr(data-label) ": ";color:var(--muted);font-size:.9em}
table.users td.act{display:block;padding-top:10px}table.users .actions{flex-wrap:wrap}table.users button{min-height:44px}}
/* Phone: config rows as icon + label on one line, details below */
@media (max-width:560px){table.cfg,table.cfg tbody{display:block}table.cfg tr{display:grid;grid-template-columns:auto 1fr;border-top:1px solid var(--line)}table.cfg tr:first-child{border-top:0}
table.cfg td,table.cfg th{border-top:0;width:auto}table.cfg tr>td:last-child{grid-column:1/-1;padding-top:0}}
/* Phone: four tabs do not fit one row - a 2x2 grid instead of a hidden scroller */
@media (max-width:520px){nav.tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;border-bottom:0;margin:14px 0 8px}
nav.tabs a{justify-content:center;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
nav.tabs a.active{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}}
/* Festhänger: the Kartenhaus month by floor, players stuck on one */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px 14px}
.kpi span{display:block;color:var(--muted);font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.kpi b{display:block;font-size:1.45rem;font-variant-numeric:tabular-nums}.kpi.warn b{color:var(--warn)}
a.kpi{color:inherit;text-decoration:none}a.kpi:hover,a.kpi:focus-visible{border-color:var(--warn)}
table.list th{color:var(--muted);font-weight:600;font-size:.85em;white-space:nowrap}
table.list td{overflow-wrap:normal;vertical-align:middle}table.list .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.floor b{white-space:nowrap}td.floor small{display:block;color:var(--muted);font-size:.82em;margin-top:2px}
td.rate{min-width:180px;white-space:nowrap}.track{display:inline-block;vertical-align:middle;width:calc(100% - 60px);height:8px;border-radius:4px;background:#0b0e12;overflow:hidden}
.fill{display:block;height:100%;background:var(--accent)}.pct{display:inline-block;width:56px;text-align:right;font-variant-numeric:tabular-nums}
tr.wall td{background:rgba(245,197,66,.07)}tr.wall td:first-child{box-shadow:inset 3px 0 0 var(--warn)}tr.wall .fill{background:var(--warn)}
td.hot{color:var(--warn);font-weight:700}
td.name{padding-top:0;padding-bottom:0}td.name a,a.back{color:var(--accent);font-weight:600;text-decoration:none;display:inline-flex;align-items:center;min-height:44px}
td.name a:hover,a.back:hover{text-decoration:underline}td.why .sub{white-space:nowrap}
/* Phone: every row a card - floors with the bar beside the title, the counts as "39 Spieler" below */
@media (max-width:600px),(max-height:540px),(pointer:coarse){nav.ranges a{min-height:44px}}
@media (max-width:600px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.kpi{padding:8px 10px}.kpi span{letter-spacing:.02em}.kpi b{font-size:1.25rem}
table.list thead{display:none}table.list,table.list tbody{display:block}
table.list tr{padding:10px 14px;border-top:1px solid var(--line)}table.list tr:first-child{border-top:0}
table.list td,table.list .num{border:0;padding:0;white-space:normal;text-align:left}
table.stuck td:nth-child(2),table.tries td:nth-child(2),table.tries td:nth-child(5){text-align:right}
table.list td[data-label]::before{content:attr(data-label) " ";color:var(--muted)}table.list td[data-unit]::after{content:" " attr(data-unit);color:var(--muted)}
table.floors tr{display:flex;flex-wrap:wrap;align-items:center;gap:2px 14px}table.floors td{order:3;font-size:.92em}
table.floors td.floor{order:1;flex:1 1 calc(100% - 164px);min-width:0;font-size:1em}table.floors td.rate{order:2;flex:0 0 150px;min-width:0}
table.floors td.floor small{margin-bottom:4px}table.floors td.stuckn:not(.hot){display:none}
table.stuck tr,table.tries tr{display:grid;grid-template-columns:auto 1fr auto;gap:2px 14px;align-items:center}
table.stuck td.name{grid-column:1/3}table.stuck td.why,table.tries td.why{grid-column:1/-1;margin-top:2px}
table.stuck td:nth-child(4){grid-column:2/4}table.tries td.date{grid-column:1/3;color:var(--muted)}
td.rate{min-width:0}tr.wall{background:rgba(245,197,66,.07);box-shadow:inset 3px 0 0 var(--warn)}tr.wall td{background:none}tr.wall td:first-child{box-shadow:none}}
`;

const TABS = [
  ['config', '/admin', 'Konfiguration'],
  ['users', '/admin/users', 'Benutzer'],
  ['monitor', '/admin/monitor', 'Monitoring'],
  ['stuck', '/admin/stuck', 'Festhänger'],
];

function layout({ tab, summary, notice, body, extraHead = '' }) {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Pik Dame · Admin</title>${extraHead}
<style>${STYLE}</style></head><body><main>
<h1>Pik Dame · Admin</h1>
${summary ? `<p class="sum">${summary}</p>` : ''}
<nav class="tabs">${TABS.map(([id, href, label]) => `<a href="${href}"${id === tab ? ' class="active" aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
${notice ? `<div class="notice ${notice.ok ? 'ok' : 'err'}">${esc(notice.text)}${notice.html || ''}</div>` : ''}
${body}
</main></body></html>`;
}

// --------------------------------------------------------------- config tab
function configBody({ report, smtpProbe, csrf, mailConfigured }) {
  const order = { error: 0, warn: 1, ok: 2, off: 3 };
  const rows = [...report].sort((a, b) => order[a.status] - order[b.status]).map((i) => `
      <tr class="${i.status}"><td class="icon">${STATUS_ICON[i.status]}</td><th>${esc(i.label)}</th><td>${esc(i.detail)}${
        i.missing.length ? `<div class="missing">fehlt: ${i.missing.map((m) => `<code>${esc(m)}</code>`).join(' ')}</div>` : ''
      }${varList(i)}</td></tr>`).join('');
  const probeLine = !mailConfigured
    ? 'Kein SMTP-Server konfiguriert.'
    : smtpProbe
      ? `${smtpProbe.ok ? '✓ Anmeldung am SMTP-Server erfolgreich' : `✗ ${esc(smtpProbe.reason)}`} <span class="muted">(${esc(fmtDate(smtpProbe.at))})</span>`
      : 'Noch nicht geprüft.';
  return `<h2>Konfiguration</h2>
<div class="panel"><table class="cfg">${rows}</table></div>
<p class="legend">Variablen: <code class="set">grün</code> = gesetzt, grau = nicht gesetzt (Standardwert). Darüberfahren oder antippen zeigt den Wert - außer bei Passwörtern und Tokens; ein Passwort in der Datenbank-URL erscheint als ***.</p>
<h2>E-Mail prüfen</h2>
<div class="panel">
<p class="probe">${probeLine}</p>
<form method="post" action="/admin/mail">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="email" name="to" placeholder="Empfänger für die Testmail" autocomplete="email">
<button type="submit" name="action" value="probe">Verbindung prüfen</button>
<button type="submit" name="action" value="send" class="primary">Testmail senden</button>
<input type="text" name="player" placeholder="Spielername für echte Zahlen (optional)" autocomplete="off">
<button type="submit" name="action" value="review">Jahresrückblick-Vorschau senden</button>
</form></div>`;
}

// ---------------------------------------------------------------- users tab
function userStatus(u, now) {
  if (u.verified) return '<span class="badge ok">bestätigt</span>';
  if (u.verifyExpires && u.verifyExpires < now) return '<span class="badge error">Link abgelaufen</span>';
  return `<span class="badge warn" title="Link gültig bis ${esc(fmtDate(u.verifyExpires))}">Link offen</span>`;
}

/** "Passkey ×2 · Passwort" - how this account can sign in. */
function loginMethods(u) {
  const parts = [];
  if (u.passkeys) parts.push(u.passkeys > 1 ? `Passkey ×${u.passkeys}` : 'Passkey');
  if (u.hasPassword) parts.push('Passwort');
  return parts.length ? parts.join(' · ') : 'kein Anmeldeweg';
}

function userForm(csrf, username, action, label, cls) {
  return `<form method="post" action="/admin/users"><input type="hidden" name="csrf" value="${esc(csrf)}">` +
    `<input type="hidden" name="username" value="${esc(username)}"><button type="submit" name="action" value="${action}"${cls ? ` class="${cls}"` : ''}>${label}</button></form>`;
}

function usersBody({ users, csrf, now = Date.now() }) {
  if (!users) return '<p class="muted">Benutzerkonten sind auf diesem Server nicht aktiv.</p>';
  if (users.error) return `<div class="notice err">Benutzerliste nicht lesbar: ${esc(users.error)}</div>`;
  const list = users.users || [];
  const verified = list.filter((u) => u.verified).length;
  const rows = list.map((u) => `<tr>
<td class="name"><b>${esc(u.username)}</b><div class="mail">${esc(u.email)}</div><div class="mail">${esc(loginMethods(u))}</div></td>
<td class="status">${userStatus(u, now)}</td>
<td class="date" data-label="Registriert">${esc(fmtDate(u.createdAt))}</td>
<td class="num" data-label="EP">${fmtNum(u.xp)}</td><td class="num" data-label="Spiele">${fmtNum(u.games)}</td><td class="num" data-label="Siege">${fmtNum(u.wins)}</td>
<td class="num" data-label="Saison-EP">${fmtNum(u.seasonXp)}${u.season ? ` <span class="sub">${esc(u.season)}</span>` : ''}</td>
<td class="act"><div class="actions">${u.verified ? userForm(csrf, u.username, 'login-link', 'Anmelde-Link senden') : userForm(csrf, u.username, 'resend', 'Mail neu senden')}${userForm(csrf, u.username, 'ask-delete', 'Löschen', 'danger')}</div></td>
</tr>`).join('');
  return `<h2>Benutzer <span class="sub">(${users.total} gesamt, ${verified} bestätigt${users.total > list.length ? `, die neuesten ${list.length} angezeigt` : ''})</span></h2>
${list.length ? `<div class="panel scroll"><table class="users">
<thead><tr><th>Name / E-Mail</th><th>Status</th><th>Registriert</th><th>EP</th><th>Spiele</th><th>Siege</th><th>Saison-EP</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>` : '<p class="muted">Noch keine registrierten Benutzer.</p>'}
<p class="legend">„Anmelde-Link senden“ schickt einem bestätigten Konto einen 15 Minuten gültigen Einmal-Link - der Weg zurück nach verlorenem Passkey oder vergessenem Passwort. Unbestätigte Konten werden 48 Stunden nach Ablauf ihres Links bei der nächsten Registrierung automatisch entfernt. Löschen entfernt das Konto, seine Anmeldungen und seine Spielversuche (Festhänger); das Gast-Profil unter dem Namen (Statistik, Abzeichen) bleibt erhalten.</p>`;
}

/** The second step of a delete: shown in the notice area. */
function confirmDeleteHtml(csrf, username) {
  return `<form method="post" action="/admin/users"><input type="hidden" name="csrf" value="${esc(csrf)}">` +
    `<input type="hidden" name="username" value="${esc(username)}">` +
    `<button type="submit" name="action" value="delete" class="danger solid">Ja, ${esc(username)} endgültig löschen</button>` +
    '<a href="/admin/users" style="align-self:center;color:var(--muted);margin-left:8px">Abbrechen</a></form>';
}

// -------------------------------------------------------------- monitor tab
const RANGE_TABS = [['1h', '1 Std'], ['24h', '24 Std'], ['7d', '7 Tage'], ['30d', '30 Tage']];

/** Bar whose width admin-monitor.js keeps up to date (data-bar="value/limit"). */
function bar(value, limit, keys) {
  if (value == null || !limit) return '';
  const pct = Math.min(100, (value / limit) * 100);
  return `<div class="bar"><i data-bar="${keys}" style="width:${pct.toFixed(1)}%"${pct > 90 ? ' class="error"' : pct > 75 ? ' class="warn"' : ''}></i></div>`;
}

function card(title, big, extra = '') {
  return `<div class="card"><h3>${title}</h3><div class="big">${big}</div>${extra}</div>`;
}

/** Memory outside V8 (RSS - heap - external): native libraries such as the
 *  ONNX runtime. A JS leak grows the heap, this one stays flat after warmup. */
function nativeMb(p) {
  if (p.externalMb == null) return null;
  return Math.max(0, p.rssMb - p.heapTotalMb - p.externalMb);
}

/** A number the script refreshes: <span data-k="memMb" data-d="0">. */
const live = (key, value, digits = 0) => `<span data-k="${key}" data-d="${digits}">${fmtNum(value, digits)}</span>`;

/** Flat "now" values for the cards - the same shape the JSON endpoint sends. */
function currentValues(c) {
  return {
    memMb: c.container.memMb != null ? c.container.memMb : c.process.rssMb,
    memLimitMb: c.container.memLimitMb,
    cpuPct: c.container.cpuPct != null ? c.container.cpuPct : c.process.cpuPct,
    cpuLimitPct: c.container.cpuLimit ? c.container.cpuLimit * 100 : null,
    lagMs: c.process.loopLagMs,
    players: c.game.players,
    sessions: c.game.sessions,
    hostMemUsedGb: c.host.memUsedMb / 1024,
    hostMemTotalGb: c.host.memTotalMb / 1024,
    diskFreeGb: c.disk.freeMb != null ? c.disk.freeMb / 1024 : null,
    diskUsedGb: c.disk.totalMb != null ? (c.disk.totalMb - c.disk.freeMb) / 1024 : null,
    diskTotalGb: c.disk.totalMb != null ? c.disk.totalMb / 1024 : null,
  };
}

function monitorBody({ current: c, range, version }) {
  const v = currentValues(c);
  const nav = `<nav class="ranges">${RANGE_TABS.map(([id, label]) =>
    `<a href="/admin/monitor?range=${id}"${id === range ? ' class="active" aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  return `<h2>Jetzt <span class="sub">(aktualisiert <span id="updated">${esc(new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' }))}</span>, alle 15 s)</span></h2>
<div class="cards">
${card('App: Arbeitsspeicher', `${live('memMb', v.memMb)} <small>MB${v.memLimitMb ? ` von ${fmtNum(v.memLimitMb)} MB` : ''}</small>`, bar(v.memMb, v.memLimitMb, 'memMb/memLimitMb'))}
${card('App: CPU', `${live('cpuPct', v.cpuPct, 1)} <small>%${v.cpuLimitPct ? ` von ${fmtNum(v.cpuLimitPct)} %` : ''}</small>`, bar(v.cpuPct, v.cpuLimitPct, 'cpuPct/cpuLimitPct'))}
${card('Reaktionszeit', `${live('lagMs', v.lagMs, 1)} <small>ms (p99)</small>`)}
${card('Spieler', `${live('players', v.players)} <small>verbunden · ${live('sessions', v.sessions)} Spiele</small>`)}
${card('Server: Arbeitsspeicher', `${live('hostMemUsedGb', v.hostMemUsedGb, 1)} <small>GB von ${fmtNum(v.hostMemTotalGb, 1)} GB</small>`, bar(v.hostMemUsedGb, v.hostMemTotalGb, 'hostMemUsedGb/hostMemTotalGb'))}
${card('Datenverzeichnis', v.diskUsedGb != null ? `${live('diskUsedGb', v.diskUsedGb, 1)} <small>GB von ${fmtNum(v.diskTotalGb, 1)} GB belegt</small>` : '–', bar(v.diskUsedGb, v.diskTotalGb, 'diskUsedGb/diskTotalGb'))}
</div>
<h2>Verlauf</h2>
${nav}
<div id="charts" class="charts" data-range="${esc(range)}"><p class="sub">Diagramme werden geladen …</p></div>
<noscript><p class="notice err">Die Diagramme brauchen JavaScript.</p></noscript>
<p class="legend">Fläche = Durchschnitt${range !== '1h' ? ', dünne Linie = Spitze im Intervall' : ''}, gestrichelt = Grenze, Lücke = Server lief nicht.
Über ein Diagramm fahren (Handy: antippen) zeigt die Werte in allen; Bereich mit der Maus aufziehen oder seitlich wischen = heranzoomen, Doppelklick/Doppeltipp = zurück.
Auflösung: 1 Std alle 15 s, 24 Std in 5-Minuten-, 7/30 Tage in 30-Minuten-Mitteln. 100 % CPU = ein voller Kern.</p>
<h2>Prozess</h2>
<div class="panel"><dl>
<dt>Version</dt><dd>${esc(version)}</dd>
<dt>Laufzeit</dt><dd>${esc(formatUptime(c.uptimeSeconds))}</dd>
<dt>Node</dt><dd>${esc(process.version)}</dd>
<dt>Speicher (RSS)</dt><dd>${fmtNum(c.process.rssMb)} MB</dd>
<dt>Heap</dt><dd>${fmtNum(c.process.heapUsedMb)} von ${fmtNum(c.process.heapTotalMb)} MB</dd>
<dt>Nativ</dt><dd>${nativeMb(c.process) != null ? `${fmtNum(nativeMb(c.process))} MB <small>(RSS − Heap − extern; u. a. ONNX-Laufzeit)</small>` : '–'}</dd>
<dt>Last 1 / 5 / 15 min</dt><dd>${fmtNum(c.host.load1, 2)} · ${fmtNum(c.host.load5, 2)} · ${fmtNum(c.host.load15, 2)} (${c.host.cores} Kerne)</dd>
</dl></div>
<p class="legend">Andere Container (PostgreSQL, Caddy, CrowdSec) sieht die App nicht einzeln - sie hat bewusst keinen Zugriff auf Docker. Ihr Anteil steckt in „Server“.</p>
<script src="/vendor-uplot.js" defer></script>
<script src="/uplot-touch.js" defer></script>
<script src="/admin-monitor.js" defer></script>`;
}

/** JSON for /admin/monitor/data: history of one range + limits + now. */
function monitorData(series, current) {
  const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
  const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  const v = currentValues(current);
  return {
    range: series.range,
    from: series.from,
    to: series.to,
    step: series.step,
    limits: {
      memLimitMb: v.memLimitMb,
      cpuLimitPct: v.cpuLimitPct,
      hostMemTotalMb: current.host.memTotalMb,
      cores: current.host.cores,
    },
    current: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r2(x)])),
    points: series.points.map((p) => ({
      at: p.at,
      memMb: r1(p.memMb), memMbMax: r1(p.memMbMax),
      cpuPct: r2(p.cpuPct), cpuPctMax: r2(p.cpuPctMax),
      lagMs: r2(p.lagMs), lagMsMax: r2(p.lagMsMax),
      players: r1(p.players),
      hostMemUsedMb: r1(p.hostMemUsedMb),
      load1: r2(p.load1),
    })),
  };
}

// ---------------------------------------------------------------- stuck tab
const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monthLabel = (m) => `${MONTHS_DE[Number(String(m).slice(5, 7)) - 1] || ''} ${String(m).slice(0, 4)}`;
const pct = (v) => (v == null ? '–' : `${fmtNum(v * 100)} %`);
const stuckHref = (query) => esc(`/admin/stuck?${new URLSearchParams(query)}`);
const LEVEL_DE = { easy: 'Leicht', medium: 'Mittel', hard: 'Schwer', zen: 'Zen' };
const MOD_DE = { queen: 'mit Pik Dame', noDiscard: 'ohne Ablage', goOut: 'selbst ausmachen' };
const REASON_DE = { forfeit: 'aufgegeben', left: 'verlassen', timeout: 'nicht zurückgekehrt', expired: 'Tisch abgelaufen', restart: 'Server-Neustart' };
const END_DE = { me: 'selbst ausgemacht', bot: 'ein Bot ging raus', emptyDraw: 'Ziehstapel leer', stalemate: '160 Züge ohne Auslage' };

/** "2× Zen, Schwer · +40 Vorgabe · ohne Ablage": who a floor plays against. */
function floorInfo(stage) {
  const cfg = BotTower.TOWER_STAGES.find((s) => s.stage === stage);
  if (!cfg) return '';
  const counts = new Map();
  for (const b of cfg.bots) counts.set(b, (counts.get(b) || 0) + 1);
  const parts = [[...counts].map(([b, n]) => (n > 1 ? `${n}× ${LEVEL_DE[b]}` : LEVEL_DE[b])).join(', ')];
  if (cfg.handicap) parts.push(`+${cfg.handicap} Vorgabe`);
  for (const m of cfg.mods || []) parts.push(MOD_DE[m]);
  return parts.join(' · ');
}

/** A failed attempt's cause in words, e.g. "Schwelle um 40 Pkt verfehlt". */
function causeText(cause, { miss = null, turn = null } = {}) {
  switch (cause) {
    case 'abandoned': return turn != null ? `abgebrochen in Zug ${turn}` : 'abgebrochen';
    case 'queen': return 'Pik Dame kassiert';
    case 'jokers': return 'Joker auf der Hand geblieben';
    case 'goOut': return 'nicht selbst ausgemacht';
    case 'emptyDraw': return 'Ziehstapel leer';
    case 'stalemate': return '160 Züge ohne Auslage';
    case 'margin':
      if (miss == null) return 'Schwelle verfehlt';
      return miss > 0 ? `Schwelle um ${fmtNum(miss)} Pkt verfehlt` : 'punktgleich mit dem besten Bot';
    default: return '–';
  }
}

const signed = (v) => (v == null ? '–' : v > 0 ? `+${fmtNum(v)}` : v < 0 ? `−${fmtNum(-v)}` : '0');

function floorRow(f) {
  const width = f.winRate == null ? 0 : Math.round(f.winRate * 100);
  return `<tr${f.wall ? ' class="wall"' : ''}>
<td class="floor"><b>Etage ${f.stage}</b>${f.wall ? ' <span class="badge warn" title="Siegquote höchstens halb so hoch wie auf der Etage darunter">Knick</span>' : ''}<small>${esc(floorInfo(f.stage))}</small></td>
<td class="num" data-unit="Spieler">${fmtNum(f.players)}</td><td class="num" data-unit="geschafft">${fmtNum(f.cleared)}</td>
<td class="num" data-unit="Versuche">${fmtNum(f.attempts)}</td>
<td class="rate" title="Siegquote"><span class="track" aria-hidden="true"><span class="fill" style="width:${width}%"></span></span><span class="pct">${pct(f.winRate)}</span></td>
<td class="num" data-unit="Abbrüche">${pct(f.abandonRate)}</td><td class="num" data-label="Median" data-unit="Züge">${fmtNum(f.medianTurns)}</td>
<td class="num stuckn${f.stuck ? ' hot' : ''}" data-unit="Festhänger">${fmtNum(f.stuck)}</td>
</tr>`;
}

function stuckRow(s, month) {
  const why = s.top ? causeText(s.top.cause, { miss: s.miss, turn: s.quitTurn }) : '–';
  return `<tr>
<td class="name"><a href="${stuckHref({ month, player: s.name })}">${esc(s.name)}</a></td>
<td class="num" data-label="Etage">${s.stage}</td><td class="num" data-unit="Versuche">${fmtNum(s.attempts)}</td>
<td class="date" data-label="zuletzt">${esc(fmtDate(s.lastAt))}</td>
<td class="why">${esc(why)}${s.top ? ` <span class="sub">${s.top.n} von ${s.attempts}</span>` : ''}</td>
</tr>`;
}

/** One attempt of the player view: result, distance to the star, why. */
function attemptRow(a, shownMonth) {
  const f = a.facts || {};
  const [month, stage] = String(a.target).split('/');
  const stars = Math.max(1, Math.min(3, f.stars || 1));
  const result = a.outcome === 'won' ? `<span class="badge ok">${'★'.repeat(stars)} ${stars === 1 ? 'Stern' : 'Sterne'}</span>`
    : a.outcome === 'lost' ? '<span class="badge error">kein Stern</span>' : '<span class="badge warn">abgebrochen</span>';
  const details = [];
  if (a.outcome === 'abandoned') details.push(causeText('abandoned', { turn: a.turns }), REASON_DE[f.reason]);
  else if (a.outcome === 'lost') details.push(causeText(f.cause, { miss: f.margin == null ? null : -f.margin }));
  if (f.end && !(a.outcome === 'lost' && f.cause === f.end)) details.push(END_DE[f.end]);
  if (f.queenInHand && !(a.outcome === 'lost' && f.cause === 'queen')) details.push('Pik Dame auf der Hand');
  if (f.jokersInHand && !(a.outcome === 'lost' && f.cause === 'jokers')) details.push(`${f.jokersInHand} Joker auf der Hand`);
  return `<tr>
<td class="date">${esc(fmtDate(a.at))}</td>
<td class="num" data-label="Etage">${esc(stage)}${month !== shownMonth ? ` <span class="sub">${esc(monthLabel(month))}</span>` : ''}</td>
<td class="res">${result}</td>
<td class="num" data-label="Abstand">${signed(f.margin)}${a.outcome === 'abandoned' ? ' <span class="sub">vorläufig</span>' : ''}</td>
<td class="num" data-unit="Züge">${fmtNum(a.turns)}</td>
<td class="why">${esc(details.filter(Boolean).join(' · ') || '–')}</td>
</tr>`;
}

function playerBody({ month, player, attempts }) {
  const back = `<p><a class="back" href="${stuckHref({ month })}">← Zur Übersicht ${esc(monthLabel(month))}</a></p>`;
  if (!attempts || attempts.error) {
    return `${back}<div class="notice err">Spielversuche nicht lesbar: ${esc(attempts ? attempts.error : 'unbekannt')}</div>`;
  }
  const list = attempts.attempts;
  return `${back}<h2>Versuche von ${esc(attempts.name || player)} <span class="sub">Kartenhaus, letzte 90 Tage</span></h2>
${list.length ? `<div class="panel"><table class="list tries">
<thead><tr><th>Wann</th><th class="num">Etage</th><th>Ergebnis</th><th class="num">Abstand</th><th class="num">Züge</th><th>Warum</th></tr></thead>
<tbody>${list.map((a) => attemptRow(a, month)).join('')}</tbody></table></div>` : `<p class="muted">Keine Kartenhaus-Versuche von „${esc(player)}“ in den letzten 90 Tagen.</p>`}
<p class="legend">Abstand = eigene Punkte − Vorgabe − bester Bot: über 0 gibt einen Stern, ab ${BotTower.CLEAR_MARGIN} zwei. Bei abgebrochenen Versuchen der Stand beim Abbruch (Auslage minus Hand). Züge zählen alle Sitze am Tisch.</p>`;
}

function stuckBody({ current, month, player, report, attempts }) {
  if (player) return playerBody({ month, player, attempts });
  if (!report || report.error) return `<div class="notice err">Spielversuche nicht lesbar: ${esc(report ? report.error : 'unbekannt')}</div>`;
  const months = [...new Set([current, month, ...report.months])].filter(Boolean).sort().reverse();
  const nav = `<nav class="ranges" aria-label="Monat">${months.map((m) =>
    `<a href="${stuckHref({ month: m })}"${m === month ? ' class="active" aria-current="page"' : ''}>${esc(monthLabel(m))}</a>`).join('')}</nav>`;
  const t = report.totals;
  const find = `<form class="find" method="get" action="/admin/stuck"><input type="hidden" name="month" value="${esc(month)}">
<input type="search" name="player" placeholder="Spielername" aria-label="Spielername" autocomplete="off" required>
<button type="submit">Versuche anzeigen</button></form>`;
  if (!t.attempts) {
    return `<h2>Kartenhaus</h2>${nav}
<p class="muted">Noch keine Kartenhaus-Versuche in diesem Monat.</p>
<h2>Spieler nachschlagen</h2><div class="panel">${find}</div>
<p class="legend">Gezählt wird jeder beendete oder abgebrochene Versuch einer Etage, mit Spielernamen, 90 Tage lang.</p>`;
  }
  // Floors from 1 up to the highest one tried, gaps included: the curve stays readable.
  const byStage = new Map(report.floors.map((f) => [f.stage, f]));
  const top = Math.max(...report.floors.map((f) => f.stage));
  const rows = [];
  for (let s = 1; s <= top; s++) {
    rows.push(byStage.get(s) || { stage: s, attempts: 0, players: 0, cleared: 0, winRate: null, abandonRate: null, medianTurns: null, stuck: 0, wall: false });
  }
  const walls = report.floors.filter((f) => f.wall).map((f) => f.stage);
  return `<h2>Kartenhaus</h2>${nav}
<div class="kpis">
<div class="kpi"><span>Versuche</span><b>${fmtNum(t.attempts)}</b></div>
<div class="kpi"><span>Spieler</span><b>${fmtNum(t.players)}</b></div>
<div class="kpi"><span>Siegquote</span><b>${pct(t.winRate)}</b></div>
<div class="kpi"><span>Abbrüche</span><b>${pct(t.abandonRate)}</b></div>
${t.stuck ? `<a class="kpi warn" href="#festhaenger"><span>Festhänger</span><b>${fmtNum(t.stuck)}</b></a>` : '<div class="kpi"><span>Festhänger</span><b>0</b></div>'}
</div>
<h2>Etagen${walls.length ? ` <span class="sub">Knick auf Etage ${walls.join(', ')}</span>` : ''}</h2>
<div class="panel"><table class="list floors">
<thead><tr><th>Etage</th><th class="num">Spieler</th><th class="num">Geschafft</th><th class="num">Versuche</th><th>Siegquote</th><th class="num">Abbrüche</th><th class="num">Median Züge</th><th class="num">Festhänger</th></tr></thead>
<tbody>${rows.map(floorRow).join('')}</tbody></table></div>
<h2 id="festhaenger">Festhänger <span class="sub">ab ${report.minAttempts} Versuchen ohne Stern</span></h2>
${report.stuck.length ? `<div class="panel"><table class="list stuck">
<thead><tr><th>Spieler</th><th class="num">Etage</th><th class="num">Versuche</th><th>Zuletzt</th><th>Häufigster Grund</th></tr></thead>
<tbody>${report.stuck.map((s) => stuckRow(s, month)).join('')}</tbody></table></div>${t.stuck > report.stuck.length ? `<p class="legend">Die ${report.stuck.length} mit den meisten Versuchen von ${t.stuck}.</p>` : ''}`
    : '<p class="muted">Niemand hängt fest.</p>'}
<h2>Spieler nachschlagen</h2><div class="panel">${find}</div>
<p class="legend">Gezählt wird jeder beendete oder abgebrochene Versuch einer Etage, mit Spielernamen, 90 Tage lang. Siegquote = Versuche mit mindestens einem Stern; Geschafft = Spieler mit Stern. Abbrüche: aufgegeben, verlassen, nicht zurückgekehrt oder bei einem Neustart verloren. Züge zählen alle Sitze am Tisch. Knick = Siegquote höchstens halb so hoch wie auf der Etage darunter (beide ab 5 Versuchen).</p>`;
}

/**
 * @param {object} p
 * @param {'config'|'users'|'monitor'|'stuck'} [p.tab]
 * config:  report, smtpProbe, mailConfigured
 * users:   users ({total, users[]} | {error} | null when accounts are off)
 * monitor: monitor ({current, history}), version
 * stuck:   stuck ({current, month, player, report, attempts} - PlayEvents.towerReport / playerAttempts)
 * all:     csrf, notice ({ok, text, html?})
 */
function renderAdminPage(p) {
  const tab = p.tab || 'config';
  const report = p.report || [];
  const problems = report.filter((i) => i.status === 'error' || i.status === 'warn').length;
  const summary = tab === 'config'
    ? `${problems ? `${problems} Punkt(e) brauchen Aufmerksamkeit.` : 'Alles vollständig konfiguriert.'} Werte von Secrets werden nie angezeigt.`
    : '';
  let body;
  if (tab === 'users') body = usersBody({ users: p.users, csrf: p.csrf });
  else if (tab === 'stuck') body = stuckBody(p.stuck || {});
  else if (tab === 'monitor') body = monitorBody({ current: p.monitor.current, range: p.monitor.range || '1h', version: p.version || (p.runtime && p.runtime.version) });
  else body = configBody({ report, smtpProbe: p.smtpProbe, csrf: p.csrf, mailConfigured: p.mailConfigured });
  return layout({ tab, summary, notice: p.notice, body, extraHead: tab === 'monitor' ? '<link rel="stylesheet" href="/vendor-uplot.css">' : '' });
}

module.exports = { basicPassword, csrfToken, csrfValid, validRecipient, renderAdminPage, confirmDeleteHtml, monitorData, causeText, floorInfo };
