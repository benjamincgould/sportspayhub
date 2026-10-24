// Test only: an in-memory stand-in for Supabase Auth with the same methods as lib/server/supabase.js.
// It behaves like the real service where the app depends on it: passwords are checked, sessions have
// refresh tokens that can be revoked, authenticator-app codes are real TOTP codes, banned users can't
// sign in, and users live in the database's auth.users table (so deleting one removes their profile).

import crypto from 'node:crypto';
import { HttpError } from '../lib/server/http.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0; let value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
export const totpStep = () => Math.floor(Date.now() / 30000);
export const totpFor = (secret, offset = 0) => hotp(base32Decode(secret), totpStep() + offset);

export function createFakeAuth(sql) {
  const users = new Map();     // id -> { email, password, banned, factors: [{ id, secret, status }] }
  const sessions = new Map();  // session id -> { userId, revoked }
  const refresh = new Map();   // refresh token -> session id
  const calls = [];

  const newTokens = (sessionId) => {
    const rt = crypto.randomBytes(16).toString('hex');
    refresh.set(rt, sessionId);
    return { at: `at.${sessionId}.${crypto.randomBytes(8).toString('hex')}`, rt };
  };
  const sessionFor = (tokens) => {
    const id = refresh.get(tokens?.rt);
    const s = id && sessions.get(id);
    if (!s || s.revoked || !users.has(s.userId) || users.get(s.userId).banned) {
      throw new HttpError(401, 'Your sign-in has timed out. Please sign in again.', { signedOut: true });
    }
    return { id, ...s };
  };

  const api = {
    users, sessions, calls,
    // Real Supabase calls carry the visitor's address; the stand-in just records it
    withIp(ip) { calls.push(['withIp', ip]); return api; },

    async createUser(email) {
      calls.push(['createUser', email]);
      if ([...users.values()].some((u) => u.email === email)) { const e = new Error('exists'); e.exists = true; throw e; }
      const id = crypto.randomUUID();
      await sql`insert into auth.users (id, email) values (${id}, ${email})`;
      users.set(id, { email, password: null, banned: false, factors: [] });
      return { id };
    },
    async setPassword(userId, password) {
      calls.push(['setPassword', userId]);
      if (password.length < 6) throw new HttpError(400, 'Password too weak.');
      users.get(userId).password = password;
    },
    async deleteUser(userId) {
      calls.push(['deleteUser', userId]);
      users.delete(userId);
      await sql`delete from auth.users where id = ${userId}`;
    },
    async setBanned(userId, banned) {
      calls.push(['setBanned', userId, banned]);
      users.get(userId).banned = banned;
    },
    async signIn(email, password) {
      calls.push(['signIn', email]);
      const entry = [...users.entries()].find(([, u]) => u.email === email);
      if (!entry || entry[1].banned || !entry[1].password || entry[1].password !== password) return null;
      const sid = crypto.randomUUID();
      sessions.set(sid, { userId: entry[0], revoked: false });
      return newTokens(sid);
    },
    async checkPassword(email, password) {
      const t = await this.signIn(email, password);
      if (!t) return false;
      await this.signOut(t, 'local');
      return true;
    },
    async signOut(tokens, scope = 'local') {
      calls.push(['signOut', scope]);
      const s = sessionFor(tokens);
      for (const [id, other] of sessions) {
        if (other.userId !== s.userId) continue;
        if (scope === 'global' || (scope === 'local' && id === s.id) || (scope === 'others' && id !== s.id)) other.revoked = true;
      }
    },
    async mfaEnroll(tokens, { issuer }) {
      const s = sessionFor(tokens);
      const u = users.get(s.userId);
      u.factors = u.factors.filter((f) => f.status === 'verified');
      const factor = { id: crypto.randomUUID(), secret: base32Encode(crypto.randomBytes(20)), status: 'unverified' };
      u.factors.push(factor);
      const label = encodeURIComponent(`${issuer}:${u.email}`);
      return { factorId: factor.id, secret: factor.secret, uri: `otpauth://totp/${label}?secret=${factor.secret}&issuer=${encodeURIComponent(issuer)}`, tokens };
    },
    async mfaVerify(tokens, code, factorId = null) {
      const s = sessionFor(tokens);
      const u = users.get(s.userId);
      const factor = factorId ? u.factors.find((f) => f.id === factorId) : u.factors.find((f) => f.status === 'verified');
      if (!factor) return null;
      const now = totpStep();
      const ok = [-1, 0, 1].some((d) => hotp(base32Decode(factor.secret), now + d) === String(code));
      if (!ok) return null;
      factor.status = 'verified';
      refresh.delete(tokens.rt); // tokens rotate, as with Supabase
      return { tokens: newTokens(s.id) };
    },
    // Like Supabase: deleting a verified factor signs the user out of every session
    async mfaRemoveAll(userId) {
      calls.push(['mfaRemoveAll', userId]);
      const u = users.get(userId);
      if (!u) return;
      if (u.factors.some((f) => f.status === 'verified')) {
        for (const s of sessions.values()) if (s.userId === userId) s.revoked = true;
      }
      u.factors = [];
    },
    async newSession(email) {
      calls.push(['newSession', email]);
      const entry = [...users.entries()].find(([, u]) => u.email === email);
      if (!entry || entry[1].banned) throw new Error('no such user');
      const sid = crypto.randomUUID();
      sessions.set(sid, { userId: entry[0], revoked: false });
      return newTokens(sid);
    },
  };
  return api;
}
