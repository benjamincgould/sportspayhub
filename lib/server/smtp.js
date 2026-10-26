// A small SMTP sender (no extra packages), so clubs can send email through a free Gmail account
// with a Google "app password" instead of paying for a domain. Speaks just enough SMTP:
// EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT. Port 465 uses TLS from the first byte.

import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

export class SmtpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// RFC 2047 for headers with anything beyond plain ASCII
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
// "Name <a@b.c>" or "a@b.c" -> a@b.c
export const addressOf = (s) => (/<([^>]+)>/.exec(s)?.[1] || String(s)).trim();

export function buildMessage({ from, to, subject, text, date = new Date() }) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  const fromHeader = m ? `${header(clean(m[1]).replace(/"/g, ''))} <${m[2]}>` : clean(from);
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${fromHeader}`,
    `To: ${clean(to)}`,
    `Subject: ${header(clean(subject))}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${addressOf(from).split('@')[1] || 'localhost'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

export async function sendSmtp({ host, port = 465, secure = port === 465, user, pass, from, to, subject, text, timeoutMs = 15000, tlsOptions = {} }) {
  const socket = secure
    ? tls.connect({ host, port, servername: host, ...tlsOptions })
    : net.connect({ host, port });
  socket.setTimeout(timeoutMs);
  let buffer = '';
  const waiting = [];
  let failed = null;
  const fail = (err) => { failed = failed || err; while (waiting.length) waiting.shift().reject(failed); };
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    // A reply is complete when a line has a space (not a dash) after the 3-digit code
    for (;;) {
      const lines = buffer.split('\r\n');
      const end = lines.findIndex((l, i) => i < lines.length - 1 && /^\d{3} /.test(l));
      if (end < 0) break;
      const reply = lines.slice(0, end + 1);
      buffer = lines.slice(end + 1).join('\r\n');
      const code = Number(reply[end].slice(0, 3));
      const next = waiting.shift();
      if (next) next.resolve({ code, text: reply.map((l) => l.slice(4)).join(' ') });
    }
  });
  socket.on('timeout', () => { fail(new SmtpError(0, 'The mail server took too long to answer.')); socket.destroy(); });
  socket.on('error', (err) => fail(new SmtpError(0, err.message)));
  socket.on('close', () => fail(new SmtpError(0, 'The mail server closed the connection.')));

  const reply = () => new Promise((resolve, reject) => (failed ? reject(failed) : waiting.push({ resolve, reject })));
  const expect = async (ok, write) => {
    const p = reply();
    if (write !== undefined) socket.write(`${write}\r\n`);
    const r = await p;
    if (!ok.includes(r.code)) throw new SmtpError(r.code, r.text);
    return r;
  };

  try {
    await expect([220]);
    await expect([250], 'EHLO sportspayhub');
    if (user) await expect([235], `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`);
    await expect([250], `MAIL FROM:<${addressOf(from)}>`);
    await expect([250, 251], `RCPT TO:<${addressOf(to)}>`);
    await expect([354], 'DATA');
    // Lines starting with "." are doubled (base64 bodies never do, but headers might)
    const data = buildMessage({ from, to, subject, text }).replace(/\r\n\./g, '\r\n..');
    await expect([250], `${data}\r\n.`);
    socket.write('QUIT\r\n');
  } finally {
    socket.end();
  }
}
