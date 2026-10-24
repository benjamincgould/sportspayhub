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
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the Supabase connection string (see README).');

  const mailer = createMailer({ production: config.production });
  // In production, sign-up, invite and reset links must only ever travel by email to the person
  // they're for, never shown to staff, so email has to be set up.
  if (config.production && !mailer.configured) {
    throw new Error('Set RESEND_API_KEY (or POSTMARK_TOKEN) and EMAIL_FROM: in production, sign-in links are only ever sent by email.');
  }

  // Supabase's connection pooler in transaction mode (port 6543) doesn't support prepared statements
  const sql = postgres(process.env.DATABASE_URL, {
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
