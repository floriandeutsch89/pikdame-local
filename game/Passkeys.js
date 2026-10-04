// game/Passkeys.js
// WebAuthn (passkeys) on top of @simplewebauthn/server - the ceremony, not
// the storage (AccountStore / PgAccountStore keep the credentials).
//
// Off - the factory returns null - when
//   - the library is not installed (plain `node server.js` from a checkout,
//     e.g. the iPhone/CodeApp hotspot mode), or
//   - there is no usable origin: passkeys are bound to a domain (the
//     "relying party ID"), so they need PIKDAME_BASE_URL with https - or
//     http://localhost for development.
// Changing the domain later invalidates every stored passkey; the e-mail
// login link is the way back in.
const crypto = require('crypto');

const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_FLOWS = 2000;

function loadLibrary() {
  try {
    return require('@simplewebauthn/server');
  } catch (e) {
    return null;
  }
}

/** Relying party from the public base URL, or null if passkeys cannot work. */
function relyingParty(baseUrl) {
  if (!baseUrl) return null;
  let url;
  try { url = new URL(baseUrl); } catch (e) { return null; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  // WebAuthn needs a domain; a bare IP address is not a valid RP ID.
  if (!local && /^[\d.]+$|:/.test(url.hostname)) return null;
  return { rpID: url.hostname === '127.0.0.1' ? 'localhost' : url.hostname, origin: url.origin };
}

/** A readable default name for a new passkey, e.g. "iPhone · 05.10.2026". */
function deviceName(userAgent, now = new Date()) {
  const ua = String(userAgent || '');
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux' : 'Gerät';
  const date = now.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${device} · ${date}`;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * @param {object} opts
 * @param {string} opts.baseUrl  PIKDAME_BASE_URL
 * @param {string} [opts.rpName]
 * @param {object} [opts.lib]    @simplewebauthn/server (test seam)
 * @param {() => number} [opts.now]
 */
function createPasskeyService({ baseUrl, rpName = 'Pik Dame', lib = loadLibrary(), now = Date.now } = {}) {
  const rp = relyingParty(baseUrl);
  if (!lib || !rp) return null;
  const flows = new Map(); // flowId -> { kind, challenge, expires, ...data }

  function newFlow(kind, challenge, data) {
    const t = now();
    for (const [id, f] of flows) if (f.expires < t) flows.delete(id);
    while (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value);
    const flowId = b64url(crypto.randomBytes(18));
    flows.set(flowId, { kind, challenge, expires: t + FLOW_TTL_MS, ...data });
    return flowId;
  }

  /** One use per flow, and only for the ceremony it was started for. */
  function takeFlow(flowId, kind) {
    const f = flows.get(String(flowId || ''));
    flows.delete(String(flowId || ''));
    if (!f || f.kind !== kind || f.expires < now()) return null;
    return f;
  }

  return {
    rpID: rp.rpID,
    origin: rp.origin,

    /** A fresh random WebAuthn user handle (base64url) for a new account. */
    newUserHandle() { return b64url(crypto.randomBytes(16)); },

    /**
     * @param {object} p
     * @param {string} p.username     what password managers file it under (the e-mail)
     * @param {string} [p.displayName] shown in the passkey picker (the player name)
     * @param {string} p.userHandle   base64url, stable per account
     * @param {string[]} [p.excludeIds] the account's existing credential ids
     * @param {object} [p.data]       carried to finishRegistration (e-mail, account id)
     */
    async startRegistration({ username, displayName, userHandle, excludeIds = [], data = {} }) {
      const options = await lib.generateRegistrationOptions({
        rpName,
        rpID: rp.rpID,
        userName: username,
        userDisplayName: displayName || username,
        userID: Buffer.from(userHandle, 'base64url'),
        attestationType: 'none',
        excludeCredentials: excludeIds.map((id) => ({ id })),
        // Discoverable credential: the passkey itself names the account, so
        // signing in needs no username.
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        timeout: 120000,
      });
      const flowId = newFlow('register', options.challenge, { username, userHandle, ...data });
      return { flowId, options };
    },

    /** @returns {Promise<{credential, flow}|{error}>} */
    async finishRegistration(flowId, response) {
      const flow = takeFlow(flowId, 'register');
      if (!flow) return { error: 'Die Passkey-Anfrage ist abgelaufen - bitte noch einmal versuchen.' };
      let result;
      try {
        result = await lib.verifyRegistrationResponse({
          response,
          expectedChallenge: flow.challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpID,
          requireUserVerification: false,
        });
      } catch (e) {
        return { error: 'Der Passkey konnte nicht geprüft werden.' };
      }
      if (!result.verified) return { error: 'Der Passkey konnte nicht geprüft werden.' };
      const info = result.registrationInfo;
      return {
        flow,
        credential: {
          id: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: info.credential.counter || 0,
          transports: info.credential.transports || (response.response && response.response.transports) || undefined,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
        },
      };
    },

    async startLogin() {
      const options = await lib.generateAuthenticationOptions({
        rpID: rp.rpID,
        userVerification: 'preferred',
        allowCredentials: [], // discoverable: the authenticator offers its passkeys
        timeout: 120000,
      });
      const flowId = newFlow('login', options.challenge, {});
      return { flowId, options };
    },

    /**
     * @param {(credId: string) => Promise<{credential, user}|null>} lookup
     * @returns {Promise<{user, credentialId, newCounter}|{error}>}
     */
    async finishLogin(flowId, response, lookup) {
      const flow = takeFlow(flowId, 'login');
      if (!flow) return { error: 'Die Passkey-Anfrage ist abgelaufen - bitte noch einmal versuchen.' };
      const found = response && response.id ? await lookup(response.id) : null;
      if (!found) return { error: 'Dieser Passkey ist hier nicht (mehr) registriert.' };
      let result;
      try {
        result = await lib.verifyAuthenticationResponse({
          response,
          expectedChallenge: flow.challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpID,
          credential: {
            id: found.credential.id,
            publicKey: new Uint8Array(found.credential.publicKey),
            counter: found.credential.counter,
            transports: found.credential.transports,
          },
          requireUserVerification: false,
        });
      } catch (e) {
        return { error: 'Der Passkey konnte nicht geprüft werden.' };
      }
      if (!result.verified) return { error: 'Der Passkey konnte nicht geprüft werden.' };
      return { user: found.user, credentialId: found.credential.id, newCounter: result.authenticationInfo.newCounter };
    },

    /** Test seam: how many ceremonies are pending. */
    _pendingFlows() { return flows.size; },
  };
}

module.exports = { createPasskeyService, relyingParty, deviceName };
