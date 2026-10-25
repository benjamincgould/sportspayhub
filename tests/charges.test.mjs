// The owner charging clubs: per-club prices, set-up fees, one-off charges, and paying them.
import { startServer, browser, tokenFromUrl, totpNow, PASSWORD, fakeStripe, emailedLink, lastMail } from './helpers.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
let stripe;
let owner;
before(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_platform';
  stripe = fakeStripe();
  app = await startServer({ stripe });
  owner = await finishSetup((await app.auth.inviteUser({ email: 'owner@charges.test', name: 'Owner', role: 'owner' })).url, 'owner@charges.test');
});
after(async () => { delete process.env.STRIPE_WEBHOOK_SECRET; await app.close(); });

async function finishSetup(url, email) {
  const b = browser(app.base);
  assert.equal((await b.post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD })).status, 200);
  const login = await b.post('/api/auth/login', { email, password: PASSWORD });
  if (login.json.stage === 'mfa_setup') {
    const setup = await b.post('/api/auth/2fa/setup');
    assert.equal((await b.post('/api/auth/2fa/confirm', { code: await totpNow(setup.json.secret) })).status, 200);
  }
  return b;
}
const webhook = (event) => fetch(`${app.base}/api/webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 'signed-with:whsec_platform' }, body: JSON.stringify(event),
});
const lastCall = (name) => stripe.calls.findLast((c) => c.name === name);

let paying;
let payingCoach;
test('the owner sets a club\'s own monthly price and set-up fee; the club sees them and pays both at subscribe', async () => {
  const anon = browser(app.base);
  await anon.post('/api/signup', { clubName: 'Pricey FC', sport: 'Football', name: 'Pat', email: 'pat@pricey.test' });
  payingCoach = await finishSetup(await emailedLink(app, 'pat@pricey.test'), 'pat@pricey.test');
  paying = (await owner.get('/api/owner/clubs')).json.clubs.find((c) => c.name === 'Pricey FC');
  assert.equal(paying.pricing.monthlyPriceNzd, 49, 'starts on the default price');

  assert.equal((await owner.put(`/api/owner/clubs/${paying.id}/pricing`, { monthlyPriceNzd: -5 })).status, 400);
  assert.equal((await owner.put(`/api/owner/clubs/${paying.id}/pricing`, { monthlyPriceNzd: 'lots' })).status, 400);
  const set = await owner.put(`/api/owner/clubs/${paying.id}/pricing`, { monthlyPriceNzd: 39.5, setupFeeNzd: 150 });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.club.pricing.monthlyPriceNzd, 39.5);
  assert.equal(set.json.club.pricing.setupFeeNzd, 150);

  const boot = await payingCoach.get('/api/bootstrap');
  assert.equal(boot.json.me.club.subscription.priceNzd, 39.5);
  assert.equal(boot.json.me.club.subscription.setupFeeNzd, 150);

  assert.equal((await payingCoach.post('/api/club/subscribe')).status, 200);
  const lines = lastCall('checkout.sessions.create').args[0].line_items;
  assert.equal(lines[0].price_data.unit_amount, 3950, 'the club\'s own monthly price');
  assert.equal(lines[0].price_data.recurring.interval, 'month');
  assert.equal(lines[1].price_data.unit_amount, 15000, 'set-up fee, once');
  assert.equal(lines[1].price_data.recurring, undefined, 'the set-up fee is not monthly');

  const meta = lastCall('checkout.sessions.create').args[0].metadata;
  await webhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', metadata: meta, subscription: 'sub_pricey', customer: 'cus_pricey' } } });
  const after = (await owner.get('/api/owner/clubs')).json.clubs.find((c) => c.id === paying.id);
  assert.equal(after.status, 'active');
  assert.equal(after.pricing.setupFeePaid, true);
  assert.equal((await payingCoach.get('/api/bootstrap')).json.me.club.subscription.setupFeeNzd, 0, 'nothing more to pay for set-up');
  const history = (await owner.get(`/api/owner/clubs/${paying.id}/charges`)).json;
  assert.equal(history[0].status, 'paid');
  assert.equal(history[0].amountNzd, 150);
});

test('changing a subscribed club\'s price moves its subscription from the next bill', async () => {
  const r = await owner.put(`/api/owner/clubs/${paying.id}/pricing`, { monthlyPriceNzd: 45 });
  assert.equal(r.json.movedSubscription, true);
  assert.equal(lastCall('prices.create').args[0].unit_amount, 4500);
  const update = lastCall('subscriptions.update').args[1];
  assert.equal(update.items[0].price, 'price_test');
  assert.equal(update.proration_behavior, 'none', 'no surprise charge for the change itself');
  assert.equal((await owner.put(`/api/owner/clubs/${paying.id}/pricing`, { monthlyPriceNzd: null })).json.club.pricing.monthlyPriceNzd, 49, 'null goes back to the default');
});

test('the owner charges a club a one-off amount: the coach is emailed a payment page and sees it in Settings', async () => {
  assert.equal((await owner.post(`/api/owner/clubs/${paying.id}/charges`, { amountNzd: 0, description: 'x' })).status, 400);
  assert.equal((await owner.post(`/api/owner/clubs/${paying.id}/charges`, { amountNzd: 20 })).status, 400, 'needs a description');
  const r = await owner.post(`/api/owner/clubs/${paying.id}/charges`, { amountNzd: 80, description: 'Extra training session setup' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.charge.status, 'open');
  assert.match(r.json.charge.payUrl, /^https:\/\/invoice\.stripe\.test\//);
  assert.equal(lastCall('invoiceItems.create').args[0].amount, 8000);
  assert.equal(lastCall('invoices.create').args[0].collection_method, 'send_invoice');
  assert.equal(r.json.club.openCharges, 1);

  const mail = await lastMail(app, 'pat@pricey.test', /Payment request/);
  assert.ok(mail.text.includes(r.json.charge.payUrl), 'the coach gets the payment link by email');
  const seen = (await payingCoach.get('/api/club/charges')).json;
  assert.equal(seen[0].description, 'Extra training session setup');
  assert.equal(seen[0].payUrl, r.json.charge.payUrl);

  const invoiceId = lastCall('invoices.finalizeInvoice').args[0];
  await webhook({ type: 'invoice.paid', data: { object: { id: invoiceId, metadata: { kind: 'platform_charge' } } } });
  const paid = (await payingCoach.get('/api/club/charges')).json.find((c) => c.id === r.json.charge.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.payUrl, null, 'no payment link once paid');
});

test('an unpaid charge can be cancelled; a paid one cannot', async () => {
  const r = await owner.post(`/api/owner/clubs/${paying.id}/charges`, { amountNzd: 10, description: 'Mistake' });
  const voided = await owner.post(`/api/owner/charges/${r.json.charge.id}/void`);
  assert.equal(voided.json.charge.status, 'void');
  assert.ok(lastCall('invoices.voidInvoice'), 'cancelled in Stripe too');
  assert.ok(!(await payingCoach.get('/api/club/charges')).json.some((c) => c.id === r.json.charge.id), 'cancelled charges disappear for the club');
  const paidId = (await owner.get(`/api/owner/clubs/${paying.id}/charges`)).json.find((c) => c.status === 'paid').id;
  assert.equal((await owner.post(`/api/owner/charges/${paidId}/void`)).status, 409);
});

test('a club the owner sets up for free is invoiced its set-up fee straight away', async () => {
  const created = await owner.post('/api/owner/clubs', { clubName: 'Gifted Gym', sport: 'Gymnastics', name: 'Gil', email: 'gil@gifted.test', free: true, setupFeeNzd: 99, monthlyPriceNzd: 0 });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.charge.amountNzd, 99);
  assert.equal(created.json.charge.kind, 'setup');
  assert.equal(created.json.club.status, 'comped');
  const gil = await finishSetup(await emailedLink(app, 'gil@gifted.test'), 'gil@gifted.test');
  assert.equal((await gil.get('/api/club/charges')).json[0].amountNzd, 99, 'the new coach sees it once signed in');
  assert.equal((await gil.get('/api/bootstrap')).json.me.club.subscription.setupFeeNzd, 0, 'not charged twice if they subscribe later');
});

test('only the owner can set prices or charge; clubs only see their own charges', async () => {
  for (const [method, path] of [['put', `/api/owner/clubs/${paying.id}/pricing`], ['post', `/api/owner/clubs/${paying.id}/charges`], ['get', `/api/owner/clubs/${paying.id}/charges`]]) {
    assert.equal((await payingCoach[method](path, method === 'get' ? undefined : { amountNzd: 1, description: 'x', monthlyPriceNzd: 0 })).status, 403, path);
  }
  const other = await finishSetup((await app.auth.inviteUser({ clubId: await app.clubs.createClub({ name: 'Nosy FC', sport: 'Football', status: 'active' }), email: 'c@nosy.test', role: 'coach' })).url, 'c@nosy.test');
  assert.deepEqual((await other.get('/api/club/charges')).json, []);
  const firstCharge = (await owner.get(`/api/owner/clubs/${paying.id}/charges`)).json[0].id;
  assert.equal((await other.post(`/api/owner/charges/${firstCharge}/void`)).status, 403);
});

test('without Stripe set up, charging explains what to do', async () => {
  const bare = await startServer();
  try {
    const o = browser(bare.base);
    const { url } = await bare.auth.inviteUser({ email: 'o@bare.test', role: 'owner' });
    await o.post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD });
    await o.post('/api/auth/login', { email: 'o@bare.test', password: PASSWORD });
    const setup = await o.post('/api/auth/2fa/setup');
    await o.post('/api/auth/2fa/confirm', { code: await totpNow(setup.json.secret) });
    const clubId = await bare.clubs.createClub({ name: 'Bare', sport: 'Rowing', status: 'comped' });
    const r = await o.post(`/api/owner/clubs/${clubId}/charges`, { amountNzd: 10, description: 'x' });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /STRIPE_SECRET_KEY/);
  } finally { await bare.close(); }
});
