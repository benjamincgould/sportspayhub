// Sends sign-up, invite and password-reset emails through one of:
//  - Gmail (free): GMAIL_USER + GMAIL_APP_PASSWORD (a Google "app password"); or any SMTP server
//    with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//  - Resend (RESEND_API_KEY) or Postmark (POSTMARK_TOKEN), which need EMAIL_FROM at a domain you own
// In production one of them is required: sign-in links only ever travel by email.
// In tests, messages are kept in `outbox` instead of being sent.

import { sendSmtp, SmtpError } from './smtp.js';

// Server logs never get full email addresses
const mask = (to) => String(to).replace(/^[^@]{0,2}[^@]*/, (m) => `${m.slice(0, 2)}***`);

export function createMailer({ production, log = console } = {}) {
  const env = process.env;
  const gmailUser = String(env.GMAIL_USER || '').trim();
  const smtp = gmailUser
    ? { host: 'smtp.gmail.com', port: 465, user: gmailUser, pass: String(env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''), gmail: true }
    : env.SMTP_HOST ? { host: env.SMTP_HOST.trim(), port: Number(env.SMTP_PORT || 465), user: env.SMTP_USER, pass: env.SMTP_PASS, secure: env.SMTP_SECURE ? env.SMTP_SECURE !== 'false' : undefined } : null;
  const resendKey = smtp ? null : env.RESEND_API_KEY;
  const postmarkToken = smtp || resendKey ? null : env.POSTMARK_TOKEN;
  // Gmail always sends as the Gmail address itself, so the name comes from EMAIL_FROM or PLATFORM_NAME
  const displayName = (/^\s*(.*?)\s*</.exec(env.EMAIL_FROM || '')?.[1] || env.PLATFORM_NAME || 'Club App').replace(/["<>]/g, '');
  const from = smtp?.gmail ? `${displayName} <${gmailUser}>` : (env.EMAIL_FROM || (smtp?.user ? `${displayName} <${smtp.user}>` : ''));
  const outbox = [];

  async function deliver({ to, subject, text }) {
    if (resendKey) {
      return fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(8000),
      });
    }
    return fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Postmark-Server-Token': postmarkToken },
      body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' }),
      signal: AbortSignal.timeout(8000),
    });
  }

  // Turns the email service's refusal into something the club can act on (never includes keys)
  function explain(status, message) {
    const m = String(message || '');
    if (/only send testing emails|verify a domain|testing emails to your own/i.test(m)) {
      return 'Resend only sends to your own email address until you verify a domain you own. Free alternative: send through Gmail by adding GMAIL_USER and GMAIL_APP_PASSWORD in Vercel (see README).';
    }
    if (/domain is not verified|not verified/i.test(m)) return `The sending address in EMAIL_FROM (${from}) is at a domain Resend hasn't verified yet. Finish verifying it in Resend → Domains.`;
    if (status === 401 || /api key is invalid|invalid api key|unauthori/i.test(m)) return 'The email service rejected the API key. Check RESEND_API_KEY in Vercel.';
    if (/from/i.test(m) && status === 422) return `EMAIL_FROM isn't valid (${from}). It should look like: Club App <noreply@yourdomain.com>.`;
    if (status === 429) return 'The email service is limiting how many emails can be sent right now. Try again in a minute.';
    return m ? `The email service said: ${m.slice(0, 200)}` : `The email service refused it (error ${status}).`;
  }

  // Gmail / SMTP problems, in plain words
  function explainSmtp(err) {
    const code = err?.code || 0;
    const m = String(err?.message || '');
    if (code === 535 || code === 534 || /auth|credentials|password/i.test(m)) {
      return smtp?.gmail
        ? 'Gmail refused the sign-in. GMAIL_APP_PASSWORD must be a 16-letter Google "app password" (Google Account → Security → 2-Step Verification → App passwords), not your normal Gmail password.'
        : 'The mail server refused the user name or password (SMTP_USER / SMTP_PASS).';
    }
    if (code === 550 || code === 553) return `The mail server refused the address: ${m.slice(0, 160)}`;
    if (/limit|quota|rate/i.test(m) || code === 421 || code === 454) return 'The mail server says too many emails have been sent today. Try again later.';
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|too long/i.test(m)) return 'The mail server couldn\'t be reached. Try again in a minute.';
    return `The mail server said: ${m.slice(0, 200) || 'no reason given'}`;
  }

  async function sendDetailed({ to, subject, text }) {
    if (process.env.NODE_ENV === 'test' && !smtp) {
      if (process.env.TEST_EMAIL_FAIL) return { ok: false, problem: explain(403, process.env.TEST_EMAIL_FAIL) };
      outbox.push({ to, subject, text });
      return { ok: true };
    }
    if (smtp) {
      if (!smtp.pass) return { ok: false, problem: smtp.gmail ? 'Add GMAIL_APP_PASSWORD in Vercel (a Google app password).' : 'Add SMTP_PASS in Vercel.' };
      try {
        await sendSmtp({ ...smtp, from, to, subject, text, tlsOptions: smtp.tlsOptions });
        if (process.env.NODE_ENV === 'test') outbox.push({ to, subject, text });
        return { ok: true };
      } catch (err) {
        log.error?.(`Email to ${mask(to)} failed: ${err instanceof SmtpError ? err.code : ''} ${String(err.message).slice(0, 200)}`);
        return { ok: false, problem: explainSmtp(err) };
      }
    }
    if (!(resendKey || postmarkToken) || !from) {
      if (!production) log.info?.(`[email not configured] To: ${to}\nSubject: ${subject}\n${text}\n`);
      return { ok: false, problem: 'Email isn\'t set up: add GMAIL_USER and GMAIL_APP_PASSWORD (free) or RESEND_API_KEY and EMAIL_FROM in Vercel.' };
    }
    try {
      const res = await deliver({ to, subject, text });
      if (!res.ok) {
        let message = '';
        try { const body = await res.json(); message = body?.message || body?.Message || body?.error || ''; } catch { /* not json */ }
        log.error?.(`Email to ${mask(to)} failed: ${res.status} ${String(message).slice(0, 200)}`);
        return { ok: false, problem: explain(res.status, message) };
      }
      return { ok: true };
    } catch (err) {
      log.error?.(`Email to ${mask(to)} failed: ${err.message}`);
      return { ok: false, problem: 'The email service couldn\'t be reached. Try again in a minute.' };
    }
  }

  return {
    configured: Boolean(smtp ? smtp.pass && from : (resendKey || postmarkToken) && from),
    via: smtp?.gmail ? 'gmail' : smtp ? 'smtp' : resendKey ? 'resend' : postmarkToken ? 'postmark' : null,
    outbox,
    sendDetailed,
    async send(message) { return (await sendDetailed(message)).ok; },
  };
}
