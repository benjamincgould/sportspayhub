// The Accounts v2 requests sent to Stripe when a club connects (checked with a pretend fetch)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStripeV2, canTakeCards, StripeV2Error } from '../lib/server/stripe-v2.js';

function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); return { ok: reply.ok ?? true, status: reply.status ?? 200, json: async () => reply.body }; };
  fn.calls = calls;
  return fn;
}

test('creating a club account: Accounts v2, NZ, card payments, club pays fees, Stripe carries losses, full dashboard', async () => {
  const f = fakeFetch({ body: { id: 'acct_123' } });
  const v2 = createStripeV2('sk_test_x', { fetchImpl: f });
  assert.equal((await v2.createAccount({ email: 'c@club.nz', name: 'Riverside Rugby', clubId: 7 })).id, 'acct_123');
  const [call] = f.calls;
  assert.equal(call.url, 'https://api.stripe.com/v2/core/accounts');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk_test_x');
  assert.match(call.init.headers['Stripe-Version'], /preview$/);
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.body.dashboard, 'full');
  assert.equal(call.body.identity.country, 'nz');
  assert.deepEqual(call.body.configuration.merchant.capabilities.card_payments, { requested: true });
  assert.deepEqual(call.body.defaults.responsibilities, { fees_collector: 'stripe', losses_collector: 'stripe' });
  assert.equal(call.body.metadata.clubId, '7');
});

test('onboarding link and reading whether cards are switched on', async () => {
  const f = fakeFetch({ body: { url: 'https://connect.stripe.com/setup/x' } });
  const v2 = createStripeV2('sk_test_x', { fetchImpl: f });
  await v2.onboardingLink({ account: 'acct_123', returnUrl: 'https://a/?connect=done', refreshUrl: 'https://a/?connect=retry' });
  const body = f.calls[0].body;
  assert.equal(f.calls[0].url, 'https://api.stripe.com/v2/core/account_links');
  assert.equal(body.use_case.type, 'account_onboarding');
  assert.equal(body.use_case.account_onboarding.configurations, undefined, 'Stripe rejects this field');
  assert.deepEqual(body.use_case.account_onboarding.collection_options, { fields: 'currently_due' });
  assert.equal(body.use_case.account_onboarding.return_url, 'https://a/?connect=done');

  const g = fakeFetch({ body: {} });
  await createStripeV2('sk', { fetchImpl: g }).getAccount('acct_123');
  assert.equal(g.calls[0].url, 'https://api.stripe.com/v2/core/accounts/acct_123?include=configuration.merchant&include=requirements');
  assert.equal(canTakeCards({ configuration: { merchant: { capabilities: { card_payments: { status: 'active' } } } } }), true);
  assert.equal(canTakeCards({ configuration: { merchant: { capabilities: { card_payments: { status: 'pending' } } } } }), false);
});

test('Stripe\'s refusal reason is kept', async () => {
  const f = fakeFetch({ ok: false, status: 400, body: { error: { message: 'Invalid country', code: 'invalid' } } });
  await assert.rejects(createStripeV2('sk', { fetchImpl: f }).createAccount({ email: 'a@b.c', name: 'x', clubId: 1 }), (e) => e instanceof StripeV2Error && e.message === 'Invalid country' && e.type === 'StripeV2Error');
});
