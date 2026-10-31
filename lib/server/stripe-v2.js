// Stripe's Accounts v2 API (/v2/core/...), which Stripe requires for new Connect platforms.
// It takes JSON and a "preview" API version, so it's called directly with fetch rather than
// through the older SDK. Only the connect steps use it; payments still use the normal SDK.

const API = 'https://api.stripe.com';
export const V2_VERSION = () => process.env.STRIPE_V2_VERSION || '2026-10-28.preview';

export class StripeV2Error extends Error {
  constructor(status, message, code) { super(message); this.type = 'StripeV2Error'; this.status = status; this.code = code; }
}

export function createStripeV2(secretKey, { fetchImpl = fetch } = {}) {
  async function call(method, path, { body, query } = {}) {
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const res = await fetchImpl(`${API}${path}${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': V2_VERSION(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new StripeV2Error(res.status, data?.error?.message || `Stripe refused the request (error ${res.status}).`, data?.error?.code);
    return data;
  }
  return {
    // A club's own Stripe account: it accepts card payments itself, pays Stripe's fees itself
    // and Stripe (not the platform) carries the risk of losses; it gets the full Stripe Dashboard
    createAccount: ({ email, name, clubId }) => call('POST', '/v2/core/accounts', {
      body: {
        contact_email: email,
        display_name: name,
        dashboard: 'full',
        identity: { country: 'nz' },
        configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        defaults: { currency: 'nzd', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
        metadata: { clubId: String(clubId) },
        include: ['configuration.merchant', 'requirements'],
      },
    }),
    onboardingLink: ({ account, returnUrl, refreshUrl }) => call('POST', '/v2/core/account_links', {
      body: {
        account,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: { configurations: ['merchant'], return_url: returnUrl, refresh_url: refreshUrl, collection_options: { fields: 'currently_due' } },
        },
      },
    }),
    getAccount: (id) => call('GET', `/v2/core/accounts/${encodeURIComponent(id)}`, { query: [['include', 'configuration.merchant'], ['include', 'requirements']] }),
  };
}

// Whether the club's account can take card payments yet
export const canTakeCards = (account) => account?.configuration?.merchant?.capabilities?.card_payments?.status === 'active';
