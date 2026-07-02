const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { createMailer } = require('../game/Mailer');

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
  assert.ok(all.includes('Subject: Bestätigung'));
  assert.ok(all.includes('\r\n..punkt-zeile'), 'Punkt-Stuffing nach RFC 5321');
});
