// Routing, errors, visitor addresses and rate limits for the app's API.

import { sha256 } from './security.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------- Router ----------

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, ...handlers) => {
    const opts = typeof handlers[0] === 'object' && !Array.isArray(handlers[0]) && typeof handlers[0] !== 'function' ? handlers.shift() : {};
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}$`);
    routes.push({ method, re, keys, handlers, opts });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        try {
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        } catch {
          throw new HttpError(400, 'That web address is not valid.');
        }
        return { ...r, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

// ---------- Visitor address (for rate limits) ----------
// On Vercel, x-real-ip is set by Vercel's own network and can't be supplied by the visitor.
// Elsewhere, TRUST_PROXY says how many proxies sit in front, and the address the nearest
// trusted proxy recorded (counting from the right of X-Forwarded-For) is used.
export function visitorIp(headers, hops = Number(process.env.TRUST_PROXY || 1)) {
  let ip = '';
  if (process.env.VERCEL) ip = headers.get('x-real-ip') || '';
  if (!ip && hops > 0) {
    const chain = String(headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length >= hops) ip = chain[chain.length - hops];
  }
  ip = ip.replace(/^::ffff:/, '');
  // Only a plain IPv4 or IPv6 address is passed on (e.g. to Supabase)
  return /^[\d.]{7,15}$/.test(ip) || /^[0-9a-f:]{2,39}$/i.test(ip) ? ip : null;
}

// The visitor, as counted by rate limits
export function clientAddress(headers, hops) {
  let ip = visitorIp(headers, hops) || 'unknown';
  // One IPv6 home or phone connection owns a whole /64, so treat it as one visitor
  if (ip.includes(':')) {
    const parts = ip.split('::')[0].split(':');
    ip = `${parts.slice(0, 4).join(':')}::/64`;
  }
  return ip.slice(0, 64);
}

// ---------- Rate limiting (in the database, so it holds across many servers) ----------
// Keys are stored as fingerprints, so emails and addresses never sit in the limits table.

export async function hitLimit(sql, name, key, { windowSec, max }) {
  const [row] = await sql`select * from app.hit_rate_limit(${sha256(`${name}:${key}`)}, ${windowSec}::int, ${max}::int)`;
  return { allowed: row.allowed, retryAfter: row.retry_after };
}

export async function enforceLimit(sql, name, key, limit, message = 'Too many attempts. Please wait a few minutes and try again.') {
  const { allowed, retryAfter } = await hitLimit(sql, name, key, limit);
  if (!allowed) throw new HttpError(429, message, { headers: { 'Retry-After': String(retryAfter) } });
}

export const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
};

// Security headers live in lib/headers.js so the page proxy (proxy.js) can share them
export { securityHeaders } from '../headers.js';
