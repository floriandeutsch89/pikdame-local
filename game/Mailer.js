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

const CRLF = '\r\n';

function smtpExchange(socket, expectCode, lineToSend) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SMTP-Timeout'));
    }, 15000);
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      // Multiline-Antworten enden mit '<code><space>'
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

  const configured = !!host;

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
        s.setTimeout(15000, () => reject(new Error('SMTP-Verbindungs-Timeout')));
      });

      await smtpExchange(socket, 220); // Server-Greeting
      await smtpExchange(socket, 250, `EHLO pikdame`);

      if (secure === 'starttls') {
        await smtpExchange(socket, 220, 'STARTTLS');
        socket = await new Promise((resolve, reject) => {
          const t = tls.connect({ socket, servername: tlsServername || host }, () => resolve(t));
          t.once('error', reject);
        });
        await smtpExchange(socket, 250, `EHLO pikdame`);
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
      const message =
        [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          // Zeilenenden normalisieren, sonst greift das Punkt-Stuffing
          // (das nur nach CRLF sucht) nicht auf LF-Texten
          String(text).replace(/\r?\n/g, CRLF),
        ]
          .join(CRLF)
          // Punkt-Stuffing nach RFC 5321
          .replace(/(^|\r\n)\./g, '$1..') + `${CRLF}.${CRLF}`;
      // DATA-Body senden und auf 250 warten
      await new Promise((resolve, reject) => {
        socket.write(message, (err) => (err ? reject(err) : resolve()));
      });
      await smtpExchange(socket, 250);
      await smtpExchange(socket, 221, 'QUIT').catch(() => {}); // manche Server trennen sofort
      socket.end();
      return { delivered: true };
    } catch (err) {
      try { if (socket) socket.destroy(); } catch (e) { /* egal */ }
      log(`[mail] Versand an ${to} fehlgeschlagen: ${err.message}`);
      return { delivered: false, reason: err.message };
    }
  }

  return { send, configured };
}

module.exports = { createMailer };
