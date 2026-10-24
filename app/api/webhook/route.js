// Stripe webhooks: club subscriptions (the platform's account) and parent payments (clubs' accounts).
// Every event must carry a valid Stripe signature.
import { getApp } from '../../../lib/server/instance';

import { setupErrorResponse } from '../../../lib/server/setup-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  let app;
  try { app = getApp(); } catch (err) { return setupErrorResponse(err); }
  return app.handleWebhook(request);
}
