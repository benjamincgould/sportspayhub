// The app's API in one place: builds the routes and turns a web Request into a Response.
// Next.js calls this from app/api/[...path]/route.js; the tests call it directly with stand-ins
// for the database, Supabase Auth and Stripe.

import { createAuth } from './auth.js';
import { createData } from './data.js';
import { createClubs } from './clubs.js';
import { HttpError, createRouter, clientAddress, visitorIp, enforceLimit, securityHeaders } from './http.js';

// JSON parsing that drops keys which could tamper with object prototypes
const safeJson = (t) => JSON.parse(t, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue; // first cookie wins; ignore duplicates planted by others
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

export function createConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const appUrl = String(env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const cookieSecure = appUrl.startsWith('https://');
  if (production && !cookieSecure) throw new Error('APP_URL must be set and start with https:// in production.');
  return {
    production, appUrl, appOrigin: new URL(appUrl).origin, cookieSecure,
    // The __Host- prefix makes browsers refuse the cookie unless it's Secure, on this exact site, for every path
    cookieName: cookieSecure ? '__Host-club_session' : 'club_session',
    platformName: env.PLATFORM_NAME || 'Club App',
  };
}

export function createApp({ sql, provider, mailer, stripe = null, config }) {
  const auth = createAuth({ sql, config, mailer, provider });
  const data = createData({ sql, auth, stripe, appUrl: config.appUrl });
  const clubs = createClubs({ sql, auth, mailer, stripe, config });

  const router = createRouter();
  auth.routes(router);
  data.routes(router);
  clubs.routes(router);

  const headers = securityHeaders({ production: config.production });
  const API_LIMIT = { windowSec: 60, max: 300 };

  function json(status, body, extra = {}, cookies = []) {
    const h = new Headers({ ...headers, ...extra, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    for (const c of cookies) h.append('Set-Cookie', c);
    return new Response(JSON.stringify(body ?? {}), { status, headers: h });
  }

  const runTasks = async (tasks) => {
    for (const task of tasks) {
      try { await task(); } catch (err) { console.error('Background task failed', err); }
    }
  };

  // schedule: how to run work after the reply has gone (Next.js `after`); by default it just runs
  async function handle(request, { schedule = (fn) => { fn(); } } = {}) {
    const url = new URL(request.url);
    const method = request.method;
    const ip = clientAddress(request.headers);
    const tasks = [];
    const ctx = {
      sql, ip, ua: request.headers.get('user-agent'),
      // Supabase Auth calls made for this visitor carry their own address
      provider: provider.withIp ? provider.withIp(visitorIp(request.headers)) : provider, cookies: parseCookies(request.headers.get('cookie')), cookiesOut: [],
      body: {}, params: {}, query: url.searchParams, user: null, pendingUser: null, session: null,
      after: (fn) => tasks.push(fn),
    };
    const reply = (status, body, extra = {}) => {
      if (tasks.length) schedule(() => runTasks(tasks));
      return json(status, body, extra, ctx.cookiesOut);
    };

    try {
      const route = router.match(method, url.pathname);
      if (!route) throw new HttpError(404, 'Not found.');
      if (route.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
      await enforceLimit(sql, 'api', ip, API_LIMIT, 'Too many requests. Please slow down and try again.');

      if (method !== 'GET' && method !== 'HEAD') {
        // Request-forgery protection, two layers:
        // 1) browsers always label cross-site requests with their Origin: refuse any that aren't ours
        // 2) require a custom header, which other websites can't add without our permission (never granted)
        const origin = request.headers.get('origin');
        if (origin && origin !== config.appOrigin) throw new HttpError(403, 'This request came from another website and was blocked.');
        if (request.headers.get('x-club-request') !== '1') throw new HttpError(403, 'This request was blocked.');

        const limit = route.opts.bodyLimit || 64 * 1024;
        if (Number(request.headers.get('content-length') || 0) > limit) throw new HttpError(413, 'That upload is too large.');
        const raw = await request.text();
        if (Buffer.byteLength(raw) > limit) throw new HttpError(413, 'That upload is too large.');
        if (raw.length) {
          if (!String(request.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'Send the request as JSON.');
          try { ctx.body = safeJson(raw); } catch { throw new HttpError(400, 'The request was not valid JSON.'); }
          if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new HttpError(400, 'Invalid request.');
        }
      }

      ctx.params = route.params;
      await auth.loadSession(ctx);
      let result;
      for (const handler of route.handlers) result = await handler(ctx);
      return reply(200, result);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply(err.status, { error: err.message, ...(err.extra.signedOut ? { signedOut: true } : {}) }, err.extra.headers || {});
      }
      console.error(err);
      return reply(500, { error: 'Something went wrong on our side. Please try again.' });
    }
  }

  // Stripe sends two kinds of events here, each signed with its own secret: the platform's own
  // account (club subscriptions) and clubs' connected accounts (parent payments).
  async function handleWebhook(request) {
    if (!stripe) return json(404, { error: 'Not found.' });
    let event = null;
    try {
      const raw = await request.text();
      if (raw.length > 1024 * 1024) return json(413, { error: 'Too large.' });
      const signature = request.headers.get('stripe-signature');
      for (const secret of [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean)) {
        try { event = stripe.webhooks.constructEvent(raw, signature, secret); break; } catch { /* try the next secret */ }
      }
    } catch { /* unreadable body */ }
    if (!event) return json(400, { error: 'Invalid signature.' });
    try {
      if (event.account) await data.handleStripeEvent(event);
      else await clubs.handlePlatformEvent(event);
      return json(200, { received: true });
    } catch (err) {
      console.error('Webhook handling failed', err);
      return json(500, { error: 'Failed.' }); // Stripe retries
    }
  }

  // Hourly clean-up (Vercel Cron calls /api/cron/sweep)
  async function sweep() {
    await sql`delete from app.sessions where expires_at < now()`;
    await sql`delete from app.tokens where expires_at < now() - interval '1 day' or used_at < now() - interval '30 days'`;
    await sql`delete from app.rate_limits where window_start < now() - interval '1 day'`;
    // The activity log is kept for a year, then removed (personal information only as long as needed)
    await sql`delete from app.audit_log where at < now() - interval '365 days'`;
    // Clubs whose sign-up was never confirmed are removed after 7 days, sign-in accounts included
    const stale = await sql`select id from app.clubs c where status = 'preview' and created_at < now() - interval '7 days'
                            and not exists (select 1 from app.profiles p where p.club_id = c.id and p.status <> 'invited')`;
    for (const { id } of stale) {
      for (const p of await sql`select id from app.profiles where club_id = ${id}`) await provider.deleteUser(p.id).catch(() => {});
      await sql`delete from app.clubs where id = ${id}`;
    }
    return { removedClubs: stale.length };
  }

  return { handle, handleWebhook, sweep, auth, data, clubs, mailer, config };
}
