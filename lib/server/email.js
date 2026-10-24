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

  return {
    configured: Boolean((resendKey || postmarkToken) && from),
    outbox,
    async send({ to, subject, text }) {
      if (process.env.NODE_ENV === 'test') { outbox.push({ to, subject, text }); return true; }
      if (!(resendKey || postmarkToken) || !from) {
        if (!production) log.info?.(`[email not configured] To: ${to}\nSubject: ${subject}\n${text}\n`);
        return false;
      }
      try {
        const res = await deliver({ to, subject, text });
        if (!res.ok) { log.error?.(`Email to ${mask(to)} failed: ${res.status}`); return false; }
        return true;
      } catch (err) {
        log.error?.(`Email to ${mask(to)} failed: ${err.message}`);
        return false;
      }
    },
  };
}
