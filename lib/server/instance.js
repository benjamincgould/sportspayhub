// Builds the app once per server instance with the real database, Supabase Auth, email and Stripe.

import postgres from 'postgres';
import Stripe from 'stripe';
import { createApp, createConfig } from './app.js';
import { createSupabaseAuth } from './supabase.js';
import { createMailer } from './email.js';
import { encryptionKey } from './security.js';

let app = null;

export function getApp() {
  if (app) return app;
  const config = createConfig();
  encryptionKey(); // fails now, not mid-request, if the key is missing in production
  const dbUrl = String(process.env.DATABASE_URL || '').trim();
  if (!dbUrl) throw new Error('Set DATABASE_URL to the Supabase connection string (see README).');
  if (!/^postgres(ql)?:\/\//.test(dbUrl)) throw new Error('DATABASE_URL should start with postgresql:// (copy the Transaction pooler string from Supabase → Connect).');
  if (/\[YOUR-PASSWORD\]|YOUR-PASSWORD/i.test(dbUrl)) throw new Error('DATABASE_URL still has [YOUR-PASSWORD] in it: replace that (including the brackets) with your database password.');
  try { new URL(dbUrl); } catch {
    throw new Error("DATABASE_URL isn't a valid address. If your database password has symbols like @ # / ? %, reset it in Supabase (Project Settings → Database) to letters and numbers only, then update DATABASE_URL.");
  }

  const mailer = createMailer({ production: config.production });
  // In production, sign-up, invite and reset links must only ever travel by email to the person
  // they're for, never shown to staff, so email has to be set up.
  if (config.production && !mailer.configured) {
    throw new Error('Set up email: GMAIL_USER and GMAIL_APP_PASSWORD (free), or RESEND_API_KEY (or POSTMARK_TOKEN) and EMAIL_FROM. In production, sign-in links are only ever sent by email.');
  }

  // Supabase's connection pooler in transaction mode (port 6543) doesn't support prepared statements
  const sql = postgres(dbUrl, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: process.env.DATABASE_SSL === 'false' ? false : 'require',
  });

  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

  app = createApp({ sql, provider: createSupabaseAuth(), mailer, stripe, config });
  return app;
}
