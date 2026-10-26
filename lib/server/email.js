// Sends sign-up, invite and password-reset emails through Resend or Postmark (plain HTTPS, no
// extra packages). In production one of them is required: sign-in links only ever travel by email.
// In tests, messages are kept in `outbox` instead of being sent.

// Server logs never get full email addresses
const mask = (to) => String(to).replace(/^[^@]{0,2}[^@]*/, (m) => `${m.slice(0, 2)}***`);

export function createMailer({ production, log = console } = {}) {
  const resendKey = process.env.RESEND_API_KEY;
  const postmarkToken = process.env.POSTMARK_TOKEN;
  const from = process.env.EMAIL_FROM;
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
      return 'Resend only sends to your own email address until you verify a domain you own (Resend → Domains), then set EMAIL_FROM to an address at that domain.';
    }
    if (/domain is not verified|not verified/i.test(m)) return `The sending address in EMAIL_FROM (${from}) is at a domain Resend hasn't verified yet. Finish verifying it in Resend → Domains.`;
    if (status === 401 || /api key is invalid|invalid api key|unauthori/i.test(m)) return 'The email service rejected the API key. Check RESEND_API_KEY in Vercel.';
    if (/from/i.test(m) && status === 422) return `EMAIL_FROM isn't valid (${from}). It should look like: Club App <noreply@yourdomain.com>.`;
    if (status === 429) return 'The email service is limiting how many emails can be sent right now. Try again in a minute.';
    return m ? `The email service said: ${m.slice(0, 200)}` : `The email service refused it (error ${status}).`;
  }

  async function sendDetailed({ to, subject, text }) {
    if (process.env.NODE_ENV === 'test') {
      if (process.env.TEST_EMAIL_FAIL) return { ok: false, problem: explain(403, process.env.TEST_EMAIL_FAIL) };
      outbox.push({ to, subject, text });
      return { ok: true };
    }
    if (!(resendKey || postmarkToken) || !from) {
      if (!production) log.info?.(`[email not configured] To: ${to}\nSubject: ${subject}\n${text}\n`);
      return { ok: false, problem: 'Email isn\'t set up: add RESEND_API_KEY and EMAIL_FROM in Vercel.' };
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
    configured: Boolean((resendKey || postmarkToken) && from),
    outbox,
    sendDetailed,
    async send(message) { return (await sendDetailed(message)).ok; },
  };
}
