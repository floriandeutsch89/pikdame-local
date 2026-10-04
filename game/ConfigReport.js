// game/ConfigReport.js
// One place that answers "which features are on, and what is missing for
// the ones that are half set up". Printed as a block at startup and shown on
// the /admin page. Pure: environment and runtime facts in, report out.
//
// Secret VALUES never appear in the report - only whether they are set.

const STATUS_ICON = { ok: '✓', warn: '⚠', off: '–', error: '✗' };

function isSet(env, name) {
  return !!(env[name] || env[`${name}_FILE`]);
}

function parseUrl(value) {
  try { return new URL(value); } catch (e) { return null; }
}

/**
 * @param {object} env  process.env (or a test double)
 * @param {object} facts runtime facts the env alone cannot tell:
 *   dataDir, dataDirWritable, accountsEnabled, accountsBackend ('postgres'|'sqlite'),
 *   onnxActive (bool|null), adminEnabled
 * @returns {{ id, label, status: 'ok'|'warn'|'off'|'error', detail: string, missing: string[] }[]}
 */
function buildConfigReport(env, facts = {}) {
  const items = [];
  const add = (id, label, status, detail, missing = []) => items.push({ id, label, status, detail, missing });

  // Data directory
  add('data', 'Datenverzeichnis',
    facts.dataDirWritable === false ? 'error' : 'ok',
    facts.dataDirWritable === false
      ? `${facts.dataDir} ist nicht beschreibbar - nichts wird gespeichert`
      : `${facts.dataDir || '(Standard)'}`);

  // Accounts + database
  const accountsOff = env.PIKDAME_ACCOUNTS === '0';
  if (accountsOff) {
    add('accounts', 'Benutzerkonten', 'off', 'abgeschaltet (PIKDAME_ACCOUNTS=0)');
  } else if (!facts.accountsEnabled) {
    add('accounts', 'Benutzerkonten', 'error', 'nicht verfügbar (node:sqlite fehlt und keine PostgreSQL-URL)');
  } else {
    add('accounts', 'Benutzerkonten', 'ok', `aktiv (${facts.accountsBackend === 'postgres' ? 'PostgreSQL' : 'SQLite im Datenverzeichnis'})`);
  }
  if (env.PIKDAME_DATABASE_URL) {
    const url = parseUrl(env.PIKDAME_DATABASE_URL);
    const hasPassword = !!(url && url.password) || isSet(env, 'PIKDAME_DATABASE_PASSWORD');
    if (!url) add('database', 'Datenbank', 'error', 'PIKDAME_DATABASE_URL ist keine gültige URL', ['PIKDAME_DATABASE_URL']);
    else if (!hasPassword) add('database', 'Datenbank', 'warn', `${url.hostname}: kein Passwort gesetzt`, ['PIKDAME_DATABASE_PASSWORD']);
    else add('database', 'Datenbank', 'ok', `PostgreSQL auf ${url.hostname}`);
  }

  // Mail. Only matters when accounts are on: without it the confirmation
  // link exists only in the log.
  const accountsOn = !accountsOff && facts.accountsEnabled;
  if (!env.PIKDAME_SMTP_HOST) {
    add('mail', 'E-Mail', accountsOn ? 'warn' : 'off',
      accountsOn ? 'kein SMTP-Server - Bestätigungslinks stehen nur im Log' : 'nicht konfiguriert',
      accountsOn ? ['PIKDAME_SMTP_HOST'] : []);
  } else {
    const missing = [];
    if (!env.PIKDAME_SMTP_USER) missing.push('PIKDAME_SMTP_USER');
    if (!isSet(env, 'PIKDAME_SMTP_PASS')) missing.push('PIKDAME_SMTP_PASS');
    if (!env.PIKDAME_MAIL_FROM) missing.push('PIKDAME_MAIL_FROM');
    const secure = (env.PIKDAME_SMTP_SECURE || 'starttls').toLowerCase();
    const badSecure = !['starttls', 'ssl', 'none'].includes(secure);
    if (badSecure) missing.push('PIKDAME_SMTP_SECURE');
    add('mail', 'E-Mail',
      badSecure ? 'error' : missing.length ? 'warn' : 'ok',
      badSecure
        ? `PIKDAME_SMTP_SECURE="${env.PIKDAME_SMTP_SECURE}" ist ungültig (starttls | ssl | none)`
        : missing.length
          ? `${env.PIKDAME_SMTP_HOST}: unvollständig - ohne Anmeldung und eigenen Absender lehnen die meisten Anbieter Mails ab`
          : `${env.PIKDAME_SMTP_HOST} (${secure})`,
      missing);
  }

  // Public base URL: confirmation links and invite QR codes.
  if (env.PIKDAME_BASE_URL) {
    const url = parseUrl(env.PIKDAME_BASE_URL);
    if (!url) add('baseUrl', 'Öffentliche Adresse', 'error', 'PIKDAME_BASE_URL ist keine gültige URL', ['PIKDAME_BASE_URL']);
    else if (url.protocol !== 'https:' && !/^(localhost|127\.|192\.168\.|10\.)/.test(url.hostname)) {
      add('baseUrl', 'Öffentliche Adresse', 'warn', `${url.origin} ohne https - Links in Mails sind unverschlüsselt`);
    } else add('baseUrl', 'Öffentliche Adresse', 'ok', url.origin);
  } else {
    const behindProxy = env.PIKDAME_TRUST_PROXY === '1';
    add('baseUrl', 'Öffentliche Adresse', accountsOn && behindProxy ? 'warn' : 'off',
      accountsOn && behindProxy
        ? 'nicht gesetzt - Bestätigungslinks entstehen aus dem Host-Header (fälschbar)'
        : 'nicht gesetzt - Links verwenden die aufgerufene Adresse',
      accountsOn && behindProxy ? ['PIKDAME_BASE_URL'] : []);
  }

  // Reverse proxy / origin pinning
  add('proxy', 'Reverse-Proxy', env.PIKDAME_TRUST_PROXY === '1' ? 'ok' : 'off',
    env.PIKDAME_TRUST_PROXY === '1' ? 'X-Forwarded-For wird ausgewertet' : 'aus (direkter Betrieb)');
  add('origin', 'WebSocket-Herkunft', env.PIKDAME_ALLOWED_ORIGIN ? 'ok' : 'off',
    env.PIKDAME_ALLOWED_ORIGIN ? `nur ${env.PIKDAME_ALLOWED_ORIGIN}` : 'jede Herkunft erlaubt');

  // Learned bot policy
  if (env.PIKDAME_ONNX === '0') add('onnx', 'ONNX-Bots', 'off', 'abgeschaltet (PIKDAME_ONNX=0)');
  else if (facts.onnxActive) add('onnx', 'ONNX-Bots', 'ok', 'aktiv');
  else add('onnx', 'ONNX-Bots', env.PIKDAME_ONNX === '1' ? 'error' : 'off',
    env.PIKDAME_ONNX === '1' ? 'erzwungen, aber Laufzeit oder Modelle fehlen - Heuristik läuft' : 'Heuristik (Laufzeit/Modelle nicht vorhanden)');

  // The admin page itself
  add('admin', 'Admin-Seite', facts.adminEnabled ? 'ok' : 'off',
    facts.adminEnabled ? '/admin aktiv' : 'aus - zum Einschalten PIKDAME_ADMIN_TOKEN setzen');

  add('publicMode', 'Öffentlicher Modus', env.PIKDAME_PUBLIC_MODE === '1' ? 'ok' : 'off',
    env.PIKDAME_PUBLIC_MODE === '1' ? 'an - keine Profile, keine Spielerliste' : 'aus');

  return items;
}

/** Log lines for the startup block. Problems first, so they are not lost
 *  between a dozen fine entries. */
function formatConfigReport(items) {
  const order = { error: 0, warn: 1, ok: 2, off: 3 };
  const sorted = [...items].sort((a, b) => order[a.status] - order[b.status]);
  const width = Math.max(...items.map((i) => i.label.length));
  const lines = ['[config] Konfiguration:'];
  for (const i of sorted) {
    const missing = i.missing.length ? ` (fehlt: ${i.missing.join(', ')})` : '';
    lines.push(`[config]  ${STATUS_ICON[i.status]} ${i.label.padEnd(width)}  ${i.detail}${missing}`);
  }
  const problems = items.filter((i) => i.status === 'error' || i.status === 'warn').length;
  lines.push(problems
    ? `[config] ${problems} Punkt(e) brauchen Aufmerksamkeit (Details auch unter /admin, falls aktiv).`
    : '[config] Alles vollständig konfiguriert.');
  return lines;
}

module.exports = { buildConfigReport, formatConfigReport, STATUS_ICON };
