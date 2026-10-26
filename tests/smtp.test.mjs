// Sending email through Gmail (or any SMTP server) with the app's own small SMTP sender.
// A pretend mail server checks the conversation and what arrives.
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSmtp, buildMessage } from '../lib/server/smtp.js';
import { createMailer } from '../lib/server/email.js';

// A throwaway certificate made for this run only (needs openssl; the TLS test is skipped without it)
let key = null;
let cert = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  key = fs.readFileSync(`${dir}/k.pem`);
  cert = fs.readFileSync(`${dir}/c.pem`);
  fs.rmSync(dir, { recursive: true, force: true });
} catch { /* no openssl here */ }

function fakeServer({ secure = false, password = 'abcdefghijklmnop', rejectRcpt = false } = {}) {
  const received = [];
  const handler = (sock) => {
    const session = { commands: [], data: '' };
    let inData = false;
    let buf = '';
    sock.write('220 fake.smtp ESMTP ready\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; received.push(session); sock.write('250 2.0.0 OK queued\r\n'); } else session.data += `${line}\r\n`;
          continue;
        }
        session.commands.push(line);
        if (/^EHLO/.test(line)) sock.write('250-fake.smtp greets you\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (/^AUTH PLAIN /.test(line)) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          session.user = user;
          sock.write(pass === password ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Username and Password not accepted\r\n');
        } else if (/^MAIL FROM/.test(line)) sock.write('250 OK\r\n');
        else if (/^RCPT TO/.test(line)) sock.write(rejectRcpt ? '550 5.1.1 No such user\r\n' : '250 OK\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 Go ahead\r\n'); } else if (line === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
      }
    });
    sock.on('error', () => {});
  };
  const server = secure ? tls.createServer({ key, cert }, handler) : net.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, received, close: () => server.close() })));
}

test('sends over TLS (like Gmail on port 465) with AUTH PLAIN', { skip: !cert && 'openssl not available' }, async () => {
  const srv = await fakeServer({ secure: true });
  try {
    await sendSmtp({
      host: '127.0.0.1', port: srv.port, secure: true, user: 'club@gmail.com', pass: 'abcdefghijklmnop',
      from: 'SportsPayHub <club@gmail.com>', to: 'dad@example.com', subject: "You're invited to Skills 4 Life", text: 'Hi Dad,\n\nSet your password:\nhttps://x/#/invite/abc\n.\nBye',
      tlsOptions: { rejectUnauthorized: false },
    });
    const [m] = srv.received;
    assert.equal(m.user, 'club@gmail.com');
    assert.ok(m.commands.includes('MAIL FROM:<club@gmail.com>'));
    assert.ok(m.commands.includes('RCPT TO:<dad@example.com>'));
    assert.match(m.data, /^From: SportsPayHub <club@gmail.com>\r\n/m);
    assert.match(m.data, /^Subject: You're invited to Skills 4 Life\r\n/m);
    const body = Buffer.from(m.data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
    assert.equal(body, 'Hi Dad,\r\n\r\nSet your password:\r\nhttps://x/#/invite/abc\r\n.\r\nBye', 'the body arrives exactly, including a line with only a dot');
  } finally { srv.close(); }
});

test('a wrong password or refused address is reported, not hidden', async () => {
  const srv = await fakeServer();
  try {
    await assert.rejects(sendSmtp({ host: '127.0.0.1', port: srv.port, secure: false, user: 'a@gmail.com', pass: 'wrong', from: 'a@gmail.com', to: 'b@x.com', subject: 's', text: 't' }), (e) => e.code === 535);
  } finally { srv.close(); }
  const srv2 = await fakeServer({ rejectRcpt: true });
  try {
    await assert.rejects(sendSmtp({ host: '127.0.0.1', port: srv2.port, secure: false, user: 'a@gmail.com', pass: 'abcdefghijklmnop', from: 'a@gmail.com', to: 'nobody@x.com', subject: 's', text: 't' }), (e) => e.code === 550);
  } finally { srv2.close(); }
});

test('non-English subjects and names are encoded safely; header injection is stripped', () => {
  const msg = buildMessage({ from: 'Ngā Tamariki <a@gmail.com>', to: 'b@x.com\r\nBcc: evil@x.com', subject: 'Kia ora — welcome\r\nBcc: evil@x.com', text: 'hi' });
  assert.match(msg, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@gmail.com>/m);
  assert.match(msg, /^Subject: =\?UTF-8\?B\?/m);
  assert.doesNotMatch(msg, /^Bcc:/m, 'no injected headers');
});

test('the mailer uses Gmail settings when GMAIL_USER is set, and explains a rejected app password', async () => {
  const srv = await fakeServer();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(srv.port), SMTP_SECURE: 'false', SMTP_USER: 'club@gmail.com', SMTP_PASS: 'abcdefghijklmnop', PLATFORM_NAME: 'SportsPayHub', RESEND_API_KEY: 're_should_not_be_used' });
    delete process.env.EMAIL_FROM;
    const mailer = createMailer({ production: true, log: {} });
    assert.equal(mailer.via, 'smtp', 'SMTP is used ahead of Resend');
    assert.equal(mailer.configured, true);
    const ok = await mailer.sendDetailed({ to: 'dad@example.com', subject: 'Hello', text: 'Hi' });
    assert.equal(ok.ok, true, ok.problem);
    assert.match(srv.received[0].data, /^From: SportsPayHub <club@gmail.com>/m);

    process.env.SMTP_PASS = 'wrong';
    const bad = await createMailer({ production: true, log: {} }).sendDetailed({ to: 'dad@example.com', subject: 'Hello', text: 'Hi' });
    assert.equal(bad.ok, false);
    assert.match(bad.problem, /refused the user name or password/);

    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];
    Object.assign(process.env, { GMAIL_USER: 'club@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' });
    const gmail = createMailer({ production: true, log: {} });
    assert.equal(gmail.via, 'gmail');
    assert.equal(gmail.configured, true);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    srv.close();
  }
});
