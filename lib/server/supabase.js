// Supabase Auth, wrapped in the handful of operations the app needs.
//
// Supabase stores the passwords (bcrypt) and the authenticator-app secrets, checks passwords
// and two-step codes, and issues sessions. The browser never talks to Supabase: everything goes
// through the app's server, which keeps each session's Supabase tokens encrypted in its own
// database and gives the browser only a random session id in an HttpOnly cookie.
//
// Tests swap this module for a stand-in with the same methods (tests/fake-auth.mjs).

import { createClient } from '@supabase/supabase-js';
import { HttpError } from './http.js';

const SIGNED_OUT = () => new HttpError(401, 'Your sign-in has timed out. Please sign in again.', { signedOut: true });

// Accepts the Project URL as given, or with extra bits on the end (/rest/v1/ …), or the
// dashboard's address for the project, and works out https://<project>.supabase.co
export function projectUrl(value) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) throw new Error('Set SUPABASE_URL in Vercel: your Supabase Project URL, like https://abcd1234.supabase.co');
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { u = null; }
  if (u && /^[a-z0-9]+\.supabase\.co$/i.test(u.hostname)) return `https://${u.hostname.toLowerCase()}`;
  const ref = u && /(^|\.)supabase\.com$/i.test(u.hostname) && u.pathname.match(/\/project\/([a-z0-9]{15,30})/i);
  if (ref) return `https://${ref[1].toLowerCase()}.supabase.co`;
  throw new Error('SUPABASE_URL should look like https://abcd1234.supabase.co. Find it in Supabase → Project Settings → Data API.');
}

export function createSupabaseAuth({ ip = null } = {}) {
  // Linking Supabase to Vercel may create NEXT_PUBLIC_SUPABASE_URL instead; either works
  const url = projectUrl(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
  const secretKey = String(process.env.SUPABASE_SECRET_KEY || '').trim();
  if (!secretKey) {
    throw new Error(process.env.SUPABASE_SERVICE_ROLE_KEY
      ? 'Set SUPABASE_SECRET_KEY in Vercel. SUPABASE_SERVICE_ROLE_KEY is there, but this app needs a new secret key (sb_secret_…) from Supabase → Project Settings → API Keys.'
      : 'Set SUPABASE_SECRET_KEY in Vercel: a secret key starting with sb_secret_ from Supabase → Project Settings → API Keys.');
  }
  if (!secretKey.startsWith('sb_secret_')) {
    // Only the new secret keys can pass on each visitor's address (below); the legacy service_role key can't
    throw new Error('SUPABASE_SECRET_KEY must be a secret key starting with sb_secret_ (Supabase → Project Settings → API Keys).');
  }
  // No storage, no auto-refresh, nothing read from the address bar: this runs on the server only.
  // Every call carries the visitor's own address (Sb-Forwarded-For), so Supabase's per-address
  // limits on sign-ins and two-step codes apply to each visitor, not to this server as a whole.
  // Needs "IP address forwarding" switched on in Supabase → Authentication → Rate Limits.
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: ip ? { 'Sb-Forwarded-For': ip } : {} },
  };
  const admin = createClient(url, secretKey, options).auth.admin;
  const fresh = () => createClient(url, secretKey, options);

  const tokensOf = (session) => ({ at: session.access_token, rt: session.refresh_token });

  // A client holding one person's session (refreshed if the access token has expired)
  async function asUser(tokens) {
    if (!tokens?.at || !tokens?.rt) throw SIGNED_OUT();
    const client = fresh();
    const { data, error } = await client.auth.setSession({ access_token: tokens.at, refresh_token: tokens.rt });
    if (error || !data?.session) throw SIGNED_OUT();
    return client;
  }
  async function currentTokens(client, fallback) {
    const { data } = await client.auth.getSession();
    return data?.session ? tokensOf(data.session) : fallback;
  }

  return {
    // The same operations, on behalf of the visitor at this address
    withIp: (visitorIp) => createSupabaseAuth({ ip: visitorIp }),

    // New accounts are created already confirmed and with no password. The person sets their
    // password from the app's own invite link, which proves they own the email address.
    async createUser(email) {
      const { data, error } = await admin.createUser({ email, email_confirm: true });
      if (error) {
        const err = new Error(error.message);
        err.exists = error.code === 'email_exists' || error.status === 422;
        throw err;
      }
      return { id: data.user.id };
    },

    async setPassword(userId, password) {
      const { error } = await admin.updateUserById(userId, { password });
      if (error) {
        if (error.code === 'weak_password' || /password/i.test(error.message)) {
          throw new HttpError(400, 'That password isn\'t strong enough or has appeared in a known data breach. Please choose a different one.');
        }
        throw new Error(`Supabase could not set the password: ${error.message}`);
      }
    },

    async deleteUser(userId) {
      const { error } = await admin.deleteUser(userId);
      if (error && error.status !== 404) throw new Error(`Supabase could not delete the user: ${error.message}`);
    },

    // A confirmed new email address (the app has already checked the person owns it)
    async setEmail(userId, email) {
      const { error } = await admin.updateUserById(userId, { email, email_confirm: true });
      if (error) {
        if (error.code === 'email_exists' || error.status === 422) throw new HttpError(409, 'That email address already has an account.');
        throw new Error(`Supabase could not change the email: ${error.message}`);
      }
    },

    // A switched-off account is also banned in Supabase, so its tokens can't be refreshed
    async setBanned(userId, banned) {
      const { error } = await admin.updateUserById(userId, { ban_duration: banned ? '876000h' : 'none' });
      if (error) throw new Error(`Supabase could not update the user: ${error.message}`);
    },

    // Returns the new session's tokens, or null if the email and password don't match
    async signIn(email, password) {
      const { data, error } = await fresh().auth.signInWithPassword({ email, password });
      if (error || !data?.session) return null;
      return tokensOf(data.session);
    },

    // Confirms someone's password before a sensitive change, without leaving a session behind
    async checkPassword(email, password) {
      const tokens = await this.signIn(email, password);
      if (!tokens) return false;
      await this.signOut(tokens, 'local').catch(() => {});
      return true;
    },

    // scope: 'local' (this session), 'others' (every other session) or 'global' (all of them)
    async signOut(tokens, scope = 'local') {
      const client = await asUser(tokens);
      await client.auth.signOut({ scope });
    },

    // Starts adding an authenticator app. Any half-finished setup is cleared first.
    async mfaEnroll(tokens, { issuer }) {
      const client = await asUser(tokens);
      const { data: list } = await client.auth.mfa.listFactors();
      for (const f of list?.all || []) {
        if (f.factor_type === 'totp' && f.status !== 'verified') await client.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', issuer, friendlyName: `Authenticator ${new Date().toISOString()}` });
      if (error || !data) throw new Error(`Supabase could not start two-step setup: ${error?.message}`);
      return { factorId: data.id, secret: data.totp.secret, uri: data.totp.uri, tokens: await currentTokens(client, tokens) };
    },

    // Checks a 6-digit code. With no factorId, uses the person's authenticator app.
    // Returns the session's new tokens (now two-step verified), or null if the code is wrong.
    async mfaVerify(tokens, code, factorId = null) {
      const client = await asUser(tokens);
      let id = factorId;
      if (!id) {
        const { data } = await client.auth.mfa.listFactors();
        id = data?.totp?.[0]?.id;
      }
      if (!id) return null;
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId: id, code: String(code) });
      if (error) return null;
      return { tokens: await currentTokens(client, tokens) };
    },

    // A fresh session for someone the app has already checked (after a recovery code, whose use
    // ends all their sessions). The one-time sign-in token is made and used here on the server;
    // nothing is emailed and it never reaches the browser.
    async newSession(email) {
      const { data, error } = await admin.generateLink({ type: 'magiclink', email });
      const tokenHash = data?.properties?.hashed_token;
      if (error || !tokenHash) throw new Error(`Supabase could not start a session: ${error?.message}`);
      const { data: verified, error: verifyError } = await fresh().auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
      if (verifyError || !verified?.session) throw new Error(`Supabase could not start a session: ${verifyError?.message}`);
      return tokensOf(verified.session);
    },

    // Removes every authenticator app from an account (lost phone, recovery code, turning it off).
    // Supabase signs the person out of all their sessions when a verified one is removed.
    async mfaRemoveAll(userId) {
      const { data, error } = await admin.mfa.listFactors({ userId });
      if (error) throw new Error(`Supabase could not list two-step factors: ${error.message}`);
      for (const f of data?.factors || []) {
        const { error: delError } = await admin.mfa.deleteFactor({ id: f.id, userId });
        if (delError) throw new Error(`Supabase could not remove a two-step factor: ${delError.message}`);
      }
    },
  };
}
