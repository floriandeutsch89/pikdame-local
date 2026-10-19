// game/Imprint.js
// Provider data for the legal page (§ 5 DDG) comes from the environment, so the
// public repo carries no name or address. Rendered into public/impressum.html.

const IMPRINT_VARS = {
  name: 'PIKDAME_IMPRINT_NAME',
  street: 'PIKDAME_IMPRINT_STREET',
  city: 'PIKDAME_IMPRINT_CITY',
  email: 'PIKDAME_IMPRINT_EMAIL',
};
const COUNTRY_VAR = 'PIKDAME_IMPRINT_COUNTRY';
const DEFAULT_COUNTRY = 'Deutschland';

const NOT_CONFIGURED = 'Impressum nicht konfiguriert: Der Betreiber hat die Anbieterangaben noch nicht hinterlegt.';

function readImprint(env = process.env) {
  const value = (name) => String(env[name] || '').trim();
  const data = {};
  for (const [key, name] of Object.entries(IMPRINT_VARS)) data[key] = value(name);
  data.country = value(COUNTRY_VAR) || DEFAULT_COUNTRY;
  const missing = Object.entries(IMPRINT_VARS).filter(([key]) => !data[key]).map(([, name]) => name);
  return { ...data, missing, configured: missing.length === 0 };
}

/** Every character as a decimal entity: readable in the browser, no plain
 *  text for simple address harvesters (only used in the noscript fallback). */
function entities(text) {
  return [...String(text)].map((ch) => `&#${ch.codePointAt(0)};`).join('');
}

/** Base64 of the URI-encoded JSON: ASCII only, decoded by impressum.js. */
function encodePayload(value) {
  return Buffer.from(encodeURIComponent(JSON.stringify(value)), 'utf8').toString('base64');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** Fills the IMPRINT_* placeholders of the impressum.html template. */
function renderImprintPage(template, imprint) {
  let provider;
  let contact;
  if (imprint.configured) {
    const lines = [imprint.name, imprint.street, imprint.city, imprint.country];
    const [user, domain] = imprint.email.split('@');
    provider = {
      data: encodePayload(lines),
      body: `<noscript>${lines.map(entities).join('<br />')}</noscript>`,
    };
    contact = {
      data: encodePayload(imprint.email),
      body: `<noscript>E-Mail: ${entities(domain ? `${user} [at] ${domain}` : user)}</noscript>`,
    };
  } else {
    provider = { data: '', body: `<strong class="legal-missing">${escapeHtml(NOT_CONFIGURED)}</strong>` };
    contact = { data: '', body: '' };
  }
  return template
    .replace('{{IMPRINT_PROVIDER_DATA}}', provider.data)
    .replace('{{IMPRINT_PROVIDER}}', provider.body)
    .replace('{{IMPRINT_CONTACT_DATA}}', contact.data)
    .replace('{{IMPRINT_CONTACT}}', contact.body);
}

module.exports = { readImprint, renderImprintPage, IMPRINT_VARS, COUNTRY_VAR, NOT_CONFIGURED };
