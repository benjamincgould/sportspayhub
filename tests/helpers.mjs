// Test helpers: run the app's API against a fresh, real Postgres database (with the same migration
// Supabase gets), a stand-in for Supabase Auth, and a browser-like client with its own cookie jar.
//
// Needs a local Postgres. TEST_DATABASE_URL defaults to postgres://postgres@127.0.0.1:54329/postgres

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createSql } from './pg-wire.mjs';
import { createFakeAuth, totpFor } from './fake-auth.mjs';
import { createApp, createConfig } from '../lib/server/app.js';
import { createMailer } from '../lib/server/email.js';
import { securityHeaders } from '../lib/headers.js';
import SAMPLE_SQUADS from '../lib/server/sample-squads.js';

process.env.NODE_ENV = 'test';
process.env.CHECK_BREACHED_PASSWORDS = 'false';
process.env.APP_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');

export const APP_URL = 'http://localhost:3000';
export const PASSWORD = 'correct horse battery staple';
export const SEED_SQUADS = SAMPLE_SQUADS;

const PG = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/postgres');
const pgOpts = (database) => ({ host: PG.hostname, port: Number(PG.port || 5432), user: decodeURIComponent(PG.username || 'postgres'), database });

// One template database with the migration applied; each test server gets a quick copy of it
let templateReady = null;
async function ensureTemplate() {
  templateReady ||= (async () => {
    const admin = createSql(pgOpts(PG.pathname.slice(1) || 'postgres'));
    await admin.unsafe('drop database if exists club_template');
    await admin.unsafe('create database club_template');
    await admin.end();
    const t = createSql(pgOpts('club_template'));
    for (const file of ['tests/supabase-stub.sql', 'supabase/migrations/0001_init.sql']) {
      await t.unsafe(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
    await t.end();
  })();
  return templateReady;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export async function startServer({ stripe = null, env = {}, staticDir = null, port = 0, emptyDatabase = false } = {}) {
  // For browser tests: the bundled app, served with the same strict security headers as the real pages
  const pageHeaders = securityHeaders({ production: false });
  const staticFile = (pathname) => {
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!staticDir || !/^[\w.-]+$/.test(name) || !fs.existsSync(`${staticDir}/${name}`)) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(`${staticDir}/${name}`), { headers: { ...pageHeaders, 'Content-Type': TYPES[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream' } });
  };
  await ensureTemplate();
  const dbName = `club_test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = createSql(pgOpts(PG.pathname.slice(1) || 'postgres'));
  await admin.unsafe(`create database ${dbName} template ${emptyDatabase ? 'template0' : 'club_template'}`);
  const sql = createSql(pgOpts(dbName));
  // An "empty" database still has what Supabase always provides (its auth schema and roles)
  if (emptyDatabase) await sql.unsafe(fs.readFileSync(new URL('./supabase-stub.sql', import.meta.url), 'utf8'));

  const provider = createFakeAuth(sql);
  const mailer = createMailer({ production: false, log: {} });
  const config = createConfig({ APP_URL, NODE_ENV: 'test', PLATFORM_NAME: 'Test Platform', ...env });
  const app = createApp({ sql, provider, mailer, stripe, config });

  // Work scheduled to run after a reply (emails etc.) is tracked so tests can wait for it
  const pending = new Set();
  const schedule = (fn) => { const p = Promise.resolve().then(fn); pending.add(p); p.finally(() => pending.delete(p)); };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const url = new URL(request.url);
    const response = url.pathname === '/api/webhook' ? await app.handleWebhook(request)
      : url.pathname.startsWith('/api/') ? await app.handle(request, { schedule })
      : staticFile(url.pathname);
    const out = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    ...app, sql, provider, base: `http://127.0.0.1:${server.address().port}`,
    // Waits for emails and other after-the-reply work to finish
    settle: async () => { while (pending.size) await Promise.all([...pending]); },
    // Plain SQL straight into the test database ($1, $2… placeholders)
    query: (text, ...params) => sql.unsafe(text, params),
    one: async (text, ...params) => (await sql.unsafe(text, params))[0],
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      for (const p of pending) await p.catch(() => {});
      await sql.end();
      await admin.unsafe(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    },
  };
}

// A browser-like client with its own cookie jar
export function browser(base) {
  const jar = {};
  async function req(method, path, body, { headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (csrf) { h['X-Club-Request'] ??= '1'; h.Origin ??= APP_URL; }
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.Cookie = cookie;
    const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.getSetCookie();
    for (const c of setCookie) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || v === '') delete jar[k]; else jar[k] = v;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers, setCookie };
  }
  return {
    jar,
    get: (p, o) => req('GET', p, undefined, o),
    post: (p, b = {}, o) => req('POST', p, b, o),
    put: (p, b = {}, o) => req('PUT', p, b, o),
    del: (p, o) => req('DELETE', p, undefined, o),
  };
}

export const tokenFromUrl = (url) => url.split('/').pop();

// The newest sign-in link emailed to someone (tests read the test mailbox, like a person reading their email)
export async function emailedLink(app, email) {
  await app.settle();
  const mail = app.mailer.outbox.findLast((m) => m.to === email && /#\/(invite|reset)\//.test(m.text));
  if (!mail) throw new Error(`No sign-in link was emailed to ${email}`);
  return mail.text.match(/\S+#\/(?:invite|reset)\/[\w-]+/)[0];
}

export async function lastMail(app, email, subject = /./) {
  await app.settle();
  return app.mailer.outbox.findLast((m) => m.to === email && subject.test(m.subject));
}

export const totpNow = async (secret, offset = 0) => totpFor(secret, offset);

// A stand-in for Stripe's SDK that records every call, so payment flows can be tested offline
export function fakeStripe() {
  const calls = [];
  const rec = (name, ret) => (...args) => { calls.push({ name, args }); return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret); };
  return {
    calls,
    customers: { create: rec('customers.create', () => ({ id: `cus_${calls.length}` })) },
    checkout: { sessions: { create: rec('checkout.sessions.create', { url: 'https://checkout.stripe.test/session' }), retrieve: rec('checkout.sessions.retrieve', {}) } },
    billingPortal: { sessions: { create: rec('billingPortal.sessions.create', { url: 'https://billing.stripe.test/portal' }) } },
    subscriptions: {
      retrieve: rec('subscriptions.retrieve', (id) => ({ id, status: 'active', current_period_end: 1893456000, metadata: {} })),
      update: rec('subscriptions.update', (id) => ({ id, status: 'active', current_period_end: 1893456000 })),
      cancel: rec('subscriptions.cancel', {}),
    },
    accounts: { create: rec('accounts.create', { id: 'acct_club' }), retrieve: rec('accounts.retrieve', { id: 'acct_club', charges_enabled: true }) },
    accountLinks: { create: rec('accountLinks.create', { url: 'https://connect.stripe.test/onboarding' }) },
    products: { retrieve: rec('products.retrieve', { name: 'x' }), update: rec('products.update', {}), create: rec('products.create', {}) },
    prices: { list: rec('prices.list', { data: [] }), create: rec('prices.create', { id: 'price_test' }) },
    webhooks: {
      // Accepts only events "signed" with the test secret, like the real check
      constructEvent: (raw, signature, secret) => {
        if (signature !== `signed-with:${secret}`) throw new Error('bad signature');
        return JSON.parse(raw.toString());
      },
    },
  };
}
