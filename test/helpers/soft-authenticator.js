'use strict';
// A software passkey authenticator: real P-256 keys and signatures, encoded as the
// WebAuthn spec says - the same bytes a phone or a password manager would send.
const crypto = require('crypto');

// --- A minimal CBOR encoder (maps, ints, byte and text strings) -------------
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
  if (v instanceof Map) {
    const parts = [cborHead(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  throw new Error('unsupported');
}

/** One authenticator holding one P-256 passkey. get(options, { userVerified: false })
 *  answers with "user present" only, like a security key tapped without its PIN. */
function softAuthenticator(origin, rpID) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  let signCount = 0;
  let userHandle = null;
  const rpIdHash = crypto.createHash('sha256').update(rpID).digest();
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const clientData = (type, challenge, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
  return {
    id: b64u(credId),
    create(options, { origin: o } = {}) {
      userHandle = options.user.id;
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cose]);
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData('webauthn.create', options.challenge, o)), attestationObject: b64u(attestationObject), transports: ['internal'] },
      };
    },
    get(options, { origin: o, userVerified = true } = {}) {
      signCount += 1;
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(signCount);
      const authData = Buffer.concat([rpIdHash, Buffer.from([userVerified ? 0x05 : 0x01]), cnt]);
      const cd = clientData('webauthn.get', options.challenge, o);
      const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(cd).digest()]), privateKey);
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature), userHandle },
      };
    },
  };
}

module.exports = { softAuthenticator, cbor };
