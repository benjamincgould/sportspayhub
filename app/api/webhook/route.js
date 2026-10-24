// Stripe webhooks: club subscriptions (the platform's account) and parent payments (clubs' accounts).
// Every event must carry a valid Stripe signature.
import { getApp } from '../../../lib/server/instance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  return getApp().handleWebhook(request);
}
