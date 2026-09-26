const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { createMailer, encodeHeaderValue, quotedPrintable } = require('../game/Mailer');

test('Mailer: Log-Fallback ohne SMTP-Konfiguration', async () => {
  const logs = [];
  const mailer = createMailer({}, (l) => logs.push(l));
  assert.equal(mailer.configured, false);
  const r = await mailer.send({ to: 'x@example.com', subject: 'Test', text: 'Link: http://x/verify?token=abc' });
  assert.equal(r.delivered, false);
  assert.ok(logs.some((l) => l.includes('token=abc')), 'Bestätigungslink muss im Log stehen');
});

test('Mailer: kompletter SMTP-Dialog gegen einen Fake-Server (AUTH LOGIN, DATA)', async () => {
  const received = [];
  const server = net.createServer((sock) => {
    sock.write('220 fake ESMTP\r\n');
    let inData = false;
    sock.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      received.push(text);
      if (inData) {
        if (text.includes('\r\n.\r\n')) { inData = false; sock.write('250 OK gespeichert\r\n'); }
        return;
      }
      const line = text.trim();
      if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
      else if (line === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n');
      else if (line === Buffer.from('smtpuser').toString('base64')) sock.write('334 UGFzc3dvcmQ6\r\n');
      else if (line === Buffer.from('smtppass').toString('base64')) sock.write('235 OK\r\n');
      else if (line.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
      else if (line.startsWith('RCPT TO')) sock.write('250 OK\r\n');
      else if (line === 'DATA') { inData = true; sock.write('354 los\r\n'); }
      else if (line === 'QUIT') { sock.write('221 tschuess\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const mailer = createMailer(
    {
      PIKDAME_SMTP_HOST: '127.0.0.1',
      PIKDAME_SMTP_PORT: String(port),
      PIKDAME_SMTP_SECURE: 'none',
      PIKDAME_SMTP_USER: 'smtpuser',
      PIKDAME_SMTP_PASS: 'smtppass',
      PIKDAME_MAIL_FROM: 'Pik Dame <noreply@pikdame.online>',
    },
    () => {}
  );
  const r = await mailer.send({ to: 'flo@example.com', subject: 'Bestätigung', text: 'Hallo!\n.punkt-zeile\nEnde.' });
  server.close();
  assert.equal(r.delivered, true);
  const all = received.join('');
  assert.ok(all.includes('MAIL FROM:<noreply@pikdame.online>'));
  assert.ok(all.includes('RCPT TO:<flo@example.com>'));
  // Non-ASCII subject travels as an RFC 2047 encoded word; the body is
  // quoted-printable (7-bit clean) and its leading dot is encoded, so the
  // SMTP end-of-data marker can never be forged by message text.
  assert.ok(all.includes(`Subject: ${encodeHeaderValue('Bestätigung')}`), 'umlaut subject is RFC 2047 encoded');
  assert.ok(!/Subject: Best/.test(all), 'no raw UTF-8 in the Subject header');
  assert.ok(all.includes('Content-Transfer-Encoding: quoted-printable'));
  assert.ok(all.includes('\r\n=2Epunkt-zeile'), 'leading dot is QP-encoded');
  assert.ok(/\r\nDate: /.test(all) && /\r\nMessage-ID: </.test(all), 'Date and Message-ID headers present');
  assert.ok(!/EHLO pikdame\r\n/.test(all), 'EHLO carries a host name, not a bare word');
  // Decode the QP body back: the reader must see exactly the text we sent.
  const body = all.split('\r\n\r\n')[1].split('\r\n.\r\n')[0];
  const decoded = Buffer.from(
    body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))),
    'latin1'
  ).toString('utf8');
  assert.strictEqual(decoded, 'Hallo!\r\n.punkt-zeile\r\nEnde.');
});

test('Mailer: quoted-printable keeps umlauts, long lines and trailing spaces intact', () => {
  const text = `Grüße aus Köln – ${'x'.repeat(120)}\nZeile mit Leerzeichen am Ende \n=gleich`;
  const qp = quotedPrintable(text);
  for (const line of qp.split('\r\n')) assert.ok(line.length <= 76, `line too long: ${line.length}`);
  assert.ok(/^[\x20-\x7e]*$/.test(qp.replace(/\r\n/g, '')), 'QP output is 7-bit ASCII');
  const decoded = Buffer.from(
    qp.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))),
    'latin1'
  ).toString('utf8');
  assert.strictEqual(decoded, text.replace(/\n/g, '\r\n'));
});

test('Mailer: unvollständige SMTP-Konfiguration warnt beim Start', () => {
  // Both of these are accepted silently by the config and then rejected by
  // every hosted provider at the first real mail - hours later, with an
  // error nobody traces back to a compose file.
  const logs = [];
  createMailer({ PIKDAME_SMTP_HOST: 'smtp.example.com' }, (l) => logs.push(l));
  assert.ok(logs.some((l) => /USER\/PASS fehlt/.test(l)), 'fehlendes AUTH muss warnen');
  assert.ok(logs.some((l) => /PIKDAME_MAIL_FROM/.test(l)), 'fehlender Absender muss warnen');

  // Fully configured = no warnings at all.
  const quiet = [];
  createMailer(
    {
      PIKDAME_SMTP_HOST: 'smtp.example.com',
      PIKDAME_SMTP_USER: 'u',
      PIKDAME_SMTP_PASS: 'p',
      PIKDAME_MAIL_FROM: 'Pik Dame <noreply@pikdame.online>',
    },
    (l) => quiet.push(l)
  );
  assert.deepEqual(quiet, [], `vollständige Konfiguration darf nicht warnen: ${quiet.join(' | ')}`);

  // No SMTP at all is the documented log fallback, not a misconfiguration.
  const off = [];
  createMailer({}, (l) => off.push(l));
  assert.deepEqual(off, [], 'ohne SMTP-Host gibt es keine Warnung');
});

test('Mailer: konfigurierter, aber fehlschlagender Server loggt den Link trotzdem', async () => {
  // Regression: a configured relay that rejects the mail used to swallow the
  // confirmation link - the account existed and could never be verified.
  const logs = [];
  const server = net.createServer((sock) => {
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      if (chunk.toString('utf8').startsWith('EHLO')) sock.write('550 go away\r\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const mailer = createMailer(
    {
      PIKDAME_SMTP_HOST: '127.0.0.1',
      PIKDAME_SMTP_PORT: String(port),
      PIKDAME_SMTP_SECURE: 'none',
    },
    (l) => logs.push(l)
  );
  assert.equal(mailer.configured, true, 'gesetzter Host = konfiguriert');
  const r = await mailer.send({ to: 'x@example.com', subject: 'Test', text: 'Link: http://x/verify?token=abc' });
  server.close();
  assert.equal(r.delivered, false);
  assert.notEqual(r.reason, 'smtp_not_configured', 'Grund muss den echten Fehler nennen');
  assert.ok(logs.some((l) => l.includes('fehlgeschlagen')), 'Fehler muss im Log stehen');
  assert.ok(logs.some((l) => l.includes('token=abc')), 'Bestätigungslink muss auch bei Fehlversand im Log stehen');
});
