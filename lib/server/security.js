// Security helpers, built only on Node's own crypto module.
//
// Passwords and two-step secrets are stored by Supabase Auth. This file covers what the app
// does itself: password rules, the breached-password check, random tokens (stored as SHA-256
// fingerprints only), recovery codes, and AES-256-GCM encryption of children's private details.

import crypto from 'node:crypto';

// ---------- Password rules (NIST 800-63B style: long, not common, not breached) ----------

const COMMON = new Set([
  'password1234', 'password12345', 'password123456', '123456789012', '1234567890123', 'qwertyuiop12',
  'qwertyuiop123', 'passwordpassword', 'iloveyou1234', '1q2w3e4r5t6y', 'qwerty123456', 'abcdefghijkl',
  'abc123456789', 'welcome12345', 'password!234', 'letmein12345', 'trustno1trustno1', 'aaaaaaaaaaaa',
  'swimming1234', 'swimmer12345', 'football1234', 'monkey123456', 'sunshine1234', 'princess1234',
  'changeme1234', 'administrator', 'superman1234', 'baseball1234', 'qwertyqwerty', '111111111111',
  '000000000000', 'asdfghjkl123', 'zxcvbnm12345', 'p@ssw0rd1234', 'p@ssword1234', 'newzealand123',
]);

// Supabase Auth stores passwords with bcrypt, which only reads the first 72 bytes.
// Longer passwords are refused rather than silently cut short.
const MAX_PASSWORD_BYTES = 72;

export function passwordProblem(password, { email = '', name = '', clubName = '' } = {}) {
  if (typeof password !== 'string' || password.length === 0) return 'Enter a password.';
  if (password.length < 12) return 'Use at least 12 characters. A few random words works well.';
  if (Buffer.byteLength(password.normalize('NFKC'), 'utf8') > MAX_PASSWORD_BYTES) return 'Use 72 characters or fewer.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common. Choose something less predictable.';
  if (/^(.)\1+$/.test(password)) return 'Avoid repeating the same character.';
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return "Don't include your email address in your password.";
  const first = String(name).trim().split(/\s+/)[0]?.toLowerCase() || '';
  if (first.length >= 4 && lower.includes(first)) return "Don't include your name in your password.";
  const club = String(clubName).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (club.length >= 5 && lower.replace(/[^a-z0-9]/g, '').includes(club)) return "Don't use the club's name in your password.";
  return null;
}

// Checks Have I Been Pwned using k-anonymity: only the first 5 characters of the password's
// SHA-1 hash leave the server, never the password. Fails open if the service is unreachable,
// so an outage never locks families out.
export async function isBreachedPassword(password, { timeoutMs = 2500 } = {}) {
  if (process.env.CHECK_BREACHED_PASSWORDS === 'false') return false;
  const sha1 = crypto.createHash('sha1').update(String(password).normalize('NFKC')).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => {
      const [hash, count] = line.trim().split(':');
      return hash === suffix && Number(count) > 0;
    });
  } catch {
    return false;
  }
}

// ---------- Random tokens ----------

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
export function safeEqual(a, b) {
  const A = Buffer.from(sha256(a));
  const B = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(A, B) && String(a) === String(b);
}

// ---------- Recovery codes (for two-step verification) ----------

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function newRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = Array.from(crypto.randomBytes(10), (b) => B32[b & 31]).join(''); // 50 bits each
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
export const normaliseRecoveryCode = (code) => String(code || '').toLowerCase().replace(/[^a-z2-7]/g, '');

// ---------- Encryption at rest (AES-256-GCM) ----------

let cachedKey = null;
export function encryptionKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded (run: npm run gen-key)');
    cachedKey = key;
    return key;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_ENCRYPTION_KEY is required in production (run: npm run gen-key)');
  }
  console.warn('APP_ENCRYPTION_KEY not set: using an insecure development key. Never use this for real data.');
  cachedKey = crypto.createHash('sha256').update('club-app-development-only-key').digest();
  return cachedKey;
}

export function encrypt(plaintext, key = encryptionKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decrypt(blob, key = encryptionKey()) {
  if (!blob) return null;
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unknown encryption format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
