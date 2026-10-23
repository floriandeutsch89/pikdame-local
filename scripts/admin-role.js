#!/usr/bin/env node
// Break-glass for the admin role, from the operator's shell only (never the web):
//   docker compose exec pikdame node scripts/admin-role.js grant <email>
//   docker compose exec pikdame node scripts/admin-role.js revoke <email>
//   docker compose exec pikdame node scripts/admin-role.js list
// Uses the container's database settings. A CLI grant persists until revoked here;
// an address in PIKDAME_ADMINS is admin regardless, and revoke refuses it.
'use strict';
const { connectionStringFromEnv, createPool } = require('../game/Database');
const { createAdminStore } = require('../game/AdminStore');
const { parseAdminEmails, normEmail } = require('../game/AdminAccess');

const USAGE = `Aufruf:
  node scripts/admin-role.js grant <E-Mail>    Konto zum Admin machen (bleibt, bis revoke)
  node scripts/admin-role.js revoke <E-Mail>   per CLI vergebene Rolle entziehen
  node scripts/admin-role.js list              alle Admins und ihre Quelle`;

const SOURCE_DE = { env: 'PIKDAME_ADMINS', cli: 'CLI' };
const fmt = (ms) => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });

async function run(argv, env = process.env, out = console) {
  const [command, email] = argv;
  if (!['grant', 'revoke', 'list'].includes(command) || (command !== 'list' && !email)) {
    out.error(USAGE);
    return 2;
  }
  const url = connectionStringFromEnv(env);
  if (!url) {
    out.error('PIKDAME_DATABASE_URL ist nicht gesetzt - im Container ausführen: docker compose exec pikdame node scripts/admin-role.js …');
    return 2;
  }
  const pool = createPool(url);
  const store = createAdminStore(pool);
  const envEmails = parseAdminEmails(env.PIKDAME_ADMINS).emails;
  try {
    if (command === 'grant') {
      const r = await store.grantCli(email);
      if (r.error === 'unknown') { out.error(`Kein Konto mit der Adresse ${email}.`); return 1; }
      if (r.error === 'unconfirmed') { out.error(`${r.username}: die E-Mail-Adresse ist noch nicht bestätigt - erst bestätigen, dann erneut.`); return 1; }
      out.log(r.added ? `✓ ${r.username} ist jetzt Admin (CLI).` : `${r.username} hatte die Rolle per CLI schon.`);
      if (envEmails.has(normEmail(email))) out.log('  Die Adresse steht auch in PIKDAME_ADMINS.');
      return 0;
    }
    if (command === 'revoke') {
      const r = await store.revokeCli(email, { envEmails });
      if (r.error === 'unknown') { out.error(`Kein Konto mit der Adresse ${email}.`); return 1; }
      if (r.error === 'env') {
        out.error(`${r.username} ist über PIKDAME_ADMINS Admin - die CLI entzieht diese Rolle nicht.`);
        out.error('  Adresse aus PIKDAME_ADMINS entfernen und den Container neu erstellen (docker compose up -d).');
        return 1;
      }
      out.log(r.removed
        ? `✓ ${r.username} ist kein Admin mehr${r.sessions ? ` (${r.sessions} Admin-Sitzung${r.sessions === 1 ? '' : 'en'} beendet)` : ''}.`
        : `${r.username} hatte keine Rolle per CLI.`);
      return 0;
    }
    const admins = await store.listAdmins();
    if (!admins.length) out.log('Keine Admins. Vergeben: PIKDAME_ADMINS=<E-Mail> setzen oder node scripts/admin-role.js grant <E-Mail>.');
    for (const a of admins) {
      const ways = [a.passkeys ? `${a.passkeys} Passkey${a.passkeys === 1 ? '' : 's'}` : null, a.hasPassword ? 'Passwort' : null].filter(Boolean);
      out.log(`${a.username} <${a.email}>  Quelle: ${a.sources.map((s) => SOURCE_DE[s] || s).join(' + ')}  seit ${fmt(a.grantedAt)}  Step-up: ${ways.join(', ') || 'kein Anmeldeweg'}`);
    }
    const waiting = [...envEmails].filter((e) => !admins.some((a) => normEmail(a.email) === e));
    if (waiting.length) out.log(`PIKDAME_ADMINS ohne bestätigtes Konto (noch kein Admin): ${waiting.join(', ')}`);
    return 0;
  } catch (e) {
    out.error(`Datenbankfehler: ${e.message}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { run };
