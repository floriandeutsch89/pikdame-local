// game/AdminToken.js
// The /admin credential, the way Vaultwarden handles ADMIN_TOKEN: the
// environment holds an Argon2id hash in PHC format, never the password.
// A plain token still works (with a warning in the config report).
//
// Argon2 comes from Node's own crypto (Node >= 24.7) - no dependency. On an
// older Node a configured hash cannot be checked, so the admin page stays off
// and the config report says why.
//
// CLI (also inside the container: `docker compose exec pikdame node game/AdminToken.js`):
//   node game/AdminToken.js --generate   random token + its hash
//   node game/AdminToken.js              hash your own password (asked twice, hidden)
//   printf '%s' "pw" | node game/AdminToken.js   hash from stdin
const crypto = require('crypto');

// OWASP's first recommendation for Argon2id: 19 MiB, 2 passes, 1 lane.
// Light enough for a small VM, and a login is rare.
const DEFAULTS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
// Bounds for hashes we accept: a typo like m=19456000 would otherwise make
// every login allocate 19 GB.
const LIMITS = { memory: [8, 262144], passes: [1, 10], parallelism: [1, 16] };
// Argon2 is deliberately expensive; never run more than this many at once.
const MAX_CONCURRENT = 2;

const hasArgon2 = () => typeof crypto.argon2 === 'function';

const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');
const unb64 = (s) => Buffer.from(s, 'base64');

/** `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` -> parts, or null. */
function parsePhc(value) {
  const m = /^\$(argon2id|argon2i|argon2d)\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(String(value || '').trim());
  if (!m) return null;
  const parts = {
    algorithm: m[1], memory: Number(m[2]), passes: Number(m[3]), parallelism: Number(m[4]),
    salt: unb64(m[5]), hash: unb64(m[6]),
  };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (parts[k] < lo || parts[k] > hi) return null;
  if (parts.salt.length < 8 || parts.hash.length < 16) return null;
  return parts;
}

const looksLikePhc = (value) => /^\$argon2/.test(String(value || '').trim());

function argon2(algorithm, params) {
  return new Promise((resolve, reject) => {
    crypto.argon2(algorithm, params, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashAdminToken(password, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const salt = crypto.randomBytes(16);
  const hash = await argon2('argon2id', {
    message: String(password), nonce: salt, memory: o.memory, passes: o.passes, parallelism: o.parallelism, tagLength: o.tagLength,
  });
  return `$argon2id$v=19$m=${o.memory},t=${o.passes},p=${o.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/**
 * @param {string|undefined} configured  PIKDAME_ADMIN_TOKEN (or _FILE) value
 * @returns {{ mode: 'off'|'argon2'|'plain'|'invalid'|'unsupported', verify(password): Promise<'ok'|'fail'|'busy'> }}
 */
function createAdminTokenVerifier(configured) {
  const value = String(configured || '').trim();
  if (!value) return { mode: 'off', verify: async () => 'fail' };

  if (!looksLikePhc(value)) {
    const want = sha256(value);
    return {
      mode: 'plain',
      verify: async (pw) => (crypto.timingSafeEqual(sha256(pw), want) ? 'ok' : 'fail'),
    };
  }

  const phc = parsePhc(value);
  if (!phc) return { mode: 'invalid', verify: async () => 'fail' };
  if (!hasArgon2()) return { mode: 'unsupported', verify: async () => 'fail' };

  // Basic auth re-sends the password with EVERY request. After one real
  // Argon2 check, remember a SHA-256 of the accepted password so page loads
  // do not each cost 19 MiB and ~30 ms. Only the process memory holds it.
  let acceptedDigest = null;
  let running = 0;
  return {
    mode: 'argon2',
    async verify(pw) {
      const digest = sha256(pw);
      if (acceptedDigest && crypto.timingSafeEqual(digest, acceptedDigest)) return 'ok';
      if (running >= MAX_CONCURRENT) return 'busy';
      running += 1;
      try {
        const key = await argon2(phc.algorithm, {
          message: String(pw), nonce: phc.salt, memory: phc.memory, passes: phc.passes,
          parallelism: phc.parallelism, tagLength: phc.hash.length,
        });
        if (crypto.timingSafeEqual(key, phc.hash)) { acceptedDigest = digest; return 'ok'; }
        return 'fail';
      } finally {
        running -= 1;
      }
    },
  };
}

// ---------------------------------------------------------------- CLI
function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    // A pasted password (password manager) arrives as ONE chunk with the
    // Enter at its end - walk it character by character.
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(input);
          return;
        }
        if (ch === '\u0003') { stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
        else input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

async function cli(argv) {
  if (!hasArgon2()) {
    console.error(`Argon2 braucht Node 24.7 oder neuer (hier: ${process.version}).`);
    process.exit(1);
  }
  let password;
  if (argv.includes('--generate')) {
    password = crypto.randomBytes(24).toString('base64url');
    console.log('Admin-Passwort (in den Passwort-Manager, wird nicht gespeichert):');
    console.log(`  ${password}`);
    console.log('');
  } else if (process.stdin.isTTY) {
    password = await readHidden('Admin-Passwort: ');
    const again = await readHidden('Wiederholen:    ');
    if (password !== again) { console.error('Die Eingaben stimmen nicht überein.'); process.exit(1); }
  } else {
    password = await readStdin();
  }
  if (password.length < 12) { console.error('Bitte mindestens 12 Zeichen.'); process.exit(1); }
  const hash = await hashAdminToken(password);
  console.log('PIKDAME_ADMIN_TOKEN (Argon2id-Hash):');
  console.log(`  ${hash}`);
  console.log('');
  console.log("In docker/.env in EINFACHEN Anführungszeichen eintragen (sonst ersetzt Compose die $-Teile):");
  console.log(`  PIKDAME_ADMIN_TOKEN='${hash}'`);
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createAdminTokenVerifier, hashAdminToken, parsePhc, hasArgon2, DEFAULTS };
