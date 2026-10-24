// Runs before every page (not the API, which sets its own headers): adds the security headers,
// including a Content-Security-Policy with a fresh random nonce. Next.js puts the nonce on its
// own scripts automatically; any other script is refused by the browser.
import { NextResponse } from 'next/server';
import { securityHeaders } from './lib/headers.js';

export function proxy(request) {
  const nonce = btoa(crypto.randomUUID());
  const production = process.env.NODE_ENV === 'production';
  const headers = securityHeaders({ production, nonce, dev: !production });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', headers['Content-Security-Policy']);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
