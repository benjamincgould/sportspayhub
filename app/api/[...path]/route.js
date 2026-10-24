// Every /api/... request goes to the app's own router (lib/server/app.js), which checks who is
// signed in, what their role and club allow, and blocks requests from other websites.
import { after } from 'next/server';
import { getApp } from '../../../lib/server/instance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handler(request) {
  // Work that mustn't slow the reply down (e.g. sending a reset email) runs after it's sent
  return getApp().handle(request, { schedule: (fn) => after(fn) });
}

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
