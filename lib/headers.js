// Security headers for every page and API reply. No imports, so it can run anywhere Next.js runs.
//
// Pages get a fresh random nonce per request: Next.js adds it to its own scripts, and the browser
// refuses any script without it, so injected scripts can't run.

// dev: `next dev` needs eval (fast refresh) and injects its styles inline, so those are allowed
// only while developing on your own computer, never in production.
export function securityHeaders({ production, nonce = null, dev = false }) {
  const csp = [
    "default-src 'self'",
    nonce ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}` : "script-src 'self'",
    dev ? "style-src 'self' 'unsafe-inline'" : nonce ? `style-src 'self' 'nonce-${nonce}'` : "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...(production ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
  };
}
