// game/Mailer.js
// E-Mail-Versand OHNE Dependencies: ein bewusst kleiner SMTP-Client auf
// node:net/node:tls (EHLO -> STARTTLS/SSL -> AUTH LOGIN -> MAIL/RCPT/DATA).
//
// KONFIGURATION per Umgebungsvariablen - der Mailserver wird später
// eingetragen, bis dahin läuft der Log-Fallback:
//   PIKDAME_SMTP_HOST   z.B. smtp.example.com   (fehlt -> Log-Fallback)
//   PIKDAME_SMTP_PORT   587 (starttls, Default) / 465 (ssl) / 25
//   PIKDAME_SMTP_SECURE 'starttls' (Default) | 'ssl' | 'none'
//   PIKDAME_SMTP_USER   SMTP-Benutzer (optional, sonst kein AUTH)
//   PIKDAME_SMTP_PASS   SMTP-Passwort (oder PIKDAME_SMTP_PASS_FILE)
//   PIKDAME_SMTP_TLS_SERVERNAME  Zertifikats-Name, falls Host ein Egress-Proxy ist
//   PIKDAME_MAIL_FROM   Absender, z.B. 'Pik Dame <noreply@pikdame.online>'
//
// LOG-FALLBACK: Ohne PIKDAME_SMTP_HOST wird die Mail nicht verschickt,
// sondern ihr Inhalt (inkl. Bestätigungslink) ins Server-Log geschrieben -
// so ist die Registrierung auch ohne Mailserver testbar.
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

const CRLF = '\r\n';

// RFC 2047 encoded-word for header values with non-ASCII characters. A raw
// "Subject: E-Mail-Adresse bestätigen" is only legal with the SMTPUTF8
// extension; without it some relays reject the message and others deliver
// "bestÃ¤tigen". ASCII-only values are passed through untouched.
function encodeHeaderValue(value) {
  const str = String(value);
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

// Quoted-printable body (RFC 2045): the message stays 7-bit clean whatever
// the relay negotiates, so umlauts survive without 8BITMIME. Lines are kept
// under 76 characters with soft breaks; a leading dot is encoded so it can
// never collide with the SMTP end-of-data marker.
function quotedPrintable(text) {
  const bytes = Buffer.from(String(text).replace(/\r?\n/g, '\n'), 'utf8');
  const out = [];
  let line = '';
  const flush = (soft) => {
    out.push(soft ? `${line}=` : line);
    line = '';
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let token;
    if (b === 0x0a) {
      // Trailing whitespace before a line break must be encoded (it would
      // otherwise be stripped in transit).
      if (/[ \t]$/.test(line)) line = `${line.slice(0, -1)}=${line.charCodeAt(line.length - 1).toString(16).toUpperCase().padStart(2, '0')}`;
      flush(false);
      continue;
    }
    const printable = (b >= 0x20 && b <= 0x7e && b !== 0x3d) || b === 0x09;
    const leadingDot = b === 0x2e && line.length === 0;
    token = printable && !leadingDot ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    if (line.length + token.length > 75) flush(true);
    line += token;
  }
  if (line.length) flush(false);
  return out.join(CRLF);
}

function smtpExchange(socket, expectCode, lineToSend) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SMTP-Timeout'));
    }, 15000);
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      // Multi-line replies end with '<code><space>'
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        const code = parseInt(last.slice(0, 3), 10);
        if (code >= 400) reject(new Error(`SMTP ${code}: ${last.slice(4)}`));
        else if (expectCode && Math.floor(code / 100) !== Math.floor(expectCode / 100)) {
          reject(new Error(`SMTP: erwartete ${expectCode}, bekam ${code}`));
        } else resolve({ code, lines });
      }
    }
    function onError(err) { cleanup(); reject(err); }
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    }
    socket.on('data', onData);
    socket.on('error', onError);
    if (lineToSend !== undefined) socket.write(lineToSend + CRLF);
  });
}

function createMailer(env = process.env, log = console.log) {
  const host = env.PIKDAME_SMTP_HOST;
  const secure = (env.PIKDAME_SMTP_SECURE || 'starttls').toLowerCase();
  const port = parseInt(env.PIKDAME_SMTP_PORT || (secure === 'ssl' ? '465' : '587'), 10);
  const user = env.PIKDAME_SMTP_USER;
  const { readSecret } = require('./secretEnv');
  const pass = readSecret(env, 'PIKDAME_SMTP_PASS');
  // When the app reaches SMTP through an egress proxy (host = proxy name,
  // e.g. 'smtp-egress'), the certificate still belongs to the real mail
  // server - verify against that name instead of the connect host.
  const tlsServername = env.PIKDAME_SMTP_TLS_SERVERNAME || undefined;
  const from = env.PIKDAME_MAIL_FROM || 'Pik Dame <noreply@localhost>';
  // EHLO wants a host name, ideally the public one. Some relays reject a
  // bare word ("pikdame"); the container's own hostname is a random hash,
  // so the public base URL wins where it is known.
  let ehloName = env.PIKDAME_SMTP_EHLO || '';
  if (!ehloName && env.PIKDAME_BASE_URL) {
    try { ehloName = new URL(env.PIKDAME_BASE_URL).hostname; } catch (e) { /* fall through */ }
  }
  if (!ehloName) ehloName = os.hostname() || 'pikdame';

  const configured = !!host;

  // Loud, once, at startup: a relay that is configured but missing its
  // identity fails at the FIRST real mail, hours later, with a provider
  // error nobody connects back to a compose file. Both cases below are
  // rejected by every hosted provider (Mailgun/Postmark/SES): sending
  // without AUTH, or sending as noreply@localhost.
  if (configured) {
    if (!user || !pass) {
      log('[mail] WARNUNG: SMTP-Host gesetzt, aber PIKDAME_SMTP_USER/PASS fehlt - es wird OHNE AUTH gesendet. Die meisten Anbieter lehnen das ab.');
    }
    if (!env.PIKDAME_MAIL_FROM) {
      log(`[mail] WARNUNG: PIKDAME_MAIL_FROM ist nicht gesetzt - Absender bleibt "${from}". Anbieter lehnen fremde Absender in der Regel ab (SMTP 550/553).`);
    }
  }

  async function send({ to, subject, text }) {
    if (!configured) {
      log(`[mail] SMTP nicht konfiguriert - Mail an ${to} wird nur geloggt:`);
      log(`[mail] Betreff: ${subject}`);
      for (const line of String(text).split('\n')) log(`[mail] ${line}`);
      return { delivered: false, reason: 'smtp_not_configured' };
    }

    let socket;
    try {
      socket = await new Promise((resolve, reject) => {
        const s =
          secure === 'ssl'
            ? tls.connect({ host, port, servername: tlsServername || host }, () => resolve(s))
            : net.connect({ host, port }, () => resolve(s));
        s.once('error', reject);
        // Idle timeout for the WHOLE dialogue: destroying the socket routes
        // the error into whichever exchange is pending (rejecting an already
        // settled connect promise, as before, left a stalled DATA phase
        // hanging until the relay dropped the line).
        s.setTimeout(15000, () => s.destroy(new Error('SMTP-Verbindungs-Timeout')));
      });

      await smtpExchange(socket, 220); // server greeting
      await smtpExchange(socket, 250, `EHLO ${ehloName}`);

      if (secure === 'starttls') {
        await smtpExchange(socket, 220, 'STARTTLS');
        socket = await new Promise((resolve, reject) => {
          const t = tls.connect({ socket, servername: tlsServername || host }, () => resolve(t));
          t.once('error', reject);
        });
        await smtpExchange(socket, 250, `EHLO ${ehloName}`);
      }

      if (user && pass) {
        await smtpExchange(socket, 334, 'AUTH LOGIN');
        await smtpExchange(socket, 334, Buffer.from(user).toString('base64'));
        await smtpExchange(socket, 235, Buffer.from(pass).toString('base64'));
      }

      const fromAddr = (from.match(/<([^>]+)>/) || [null, from])[1];
      await smtpExchange(socket, 250, `MAIL FROM:<${fromAddr}>`);
      await smtpExchange(socket, 250, `RCPT TO:<${to}>`);
      await smtpExchange(socket, 354, 'DATA');
      // Display name of the sender may carry umlauts too ("Pik Dame" does
      // not, but the variable is free-form).
      const fromHeader = from.includes('<')
        ? `${encodeHeaderValue(from.slice(0, from.indexOf('<')).trim())} <${fromAddr}>`
        : from;
      // Date + Message-ID: both are required by RFC 5322, and spam filters
      // score their absence. Relays that add them (Postmark, SES) are the
      // exception, not the rule.
      const messageId = `<${crypto.randomBytes(12).toString('hex')}.${Date.now()}@${fromAddr.split('@')[1] || ehloName}>`;
      const message =
        [
          `From: ${fromHeader}`,
          `To: ${to}`,
          `Subject: ${encodeHeaderValue(subject)}`,
          `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
          `Message-ID: ${messageId}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: quoted-printable',
          '',
          quotedPrintable(text),
        ]
          .join(CRLF)
          // Dot stuffing per RFC 5321 (QP already encodes a leading dot in
          // the body; the headers cannot start with one - belt and braces).
          .replace(/(^|\r\n)\./g, '$1..') + `${CRLF}.${CRLF}`;
      // Send the DATA body and wait for the 250
      await new Promise((resolve, reject) => {
        socket.write(message, (err) => (err ? reject(err) : resolve()));
      });
      await smtpExchange(socket, 250);
      await smtpExchange(socket, 221, 'QUIT').catch(() => {}); // some servers hang up right away
      socket.end();
      return { delivered: true };
    } catch (err) {
      try { if (socket) socket.destroy(); } catch (e) { /* already gone */ }
      // Recovery fallback: a configured-but-failing SMTP server used to
      // swallow the confirmation link entirely - the account existed but
      // could never be verified. Log the message like the no-SMTP fallback
      // does, so an admin can hand the link out while fixing the relay.
      log(`[mail] Versand an ${to} fehlgeschlagen: ${err.message}`);
      log(`[mail] Inhalt der nicht zugestellten Mail (Betreff: ${subject}):`);
      for (const line of String(text).split('\n')) log(`[mail] ${line}`);
      return { delivered: false, reason: err.message };
    }
  }

  return { send, configured };
}

module.exports = { createMailer, encodeHeaderValue, quotedPrintable };
