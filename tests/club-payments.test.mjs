// How parents pay their club: the club decides card or bank transfer for each family, and a
// family's children are billed together (one schedule, one total, one reference, one card payment).
import { startServer, browser, tokenFromUrl, totpNow, PASSWORD, SEED_SQUADS, fakeStripe } from './helpers.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
let stripe;
let coach;
let treasurer;
let parent;
let parentId;
let leo;
let mia;
let sam;
let dev;
let bronze;
let clubId;
before(async () => {
  stripe = fakeStripe();
  app = await startServer({ stripe });
  clubId = await app.clubs.createClub({ name: 'Family Club', sport: 'Swimming', status: 'active' });
  await app.query(`update app.clubs set billing = '{"connectAccountId":"acct_fam","connectChargesEnabled":true}' where id = $1`, clubId);
  coach = await setUp((await app.auth.inviteUser({ clubId, email: 'coach@fam.test', role: 'coach' })).url, 'coach@fam.test');
  treasurer = await setUp((await app.auth.inviteUser({ clubId, email: 'treasurer@fam.test', role: 'treasurer' })).url, 'treasurer@fam.test');
  const body = (i) => { const { id, ...rest } = SEED_SQUADS[i]; return rest; };
  dev = (await coach.post('/api/squads', body(0))).json;     // $25.50 a week
  bronze = (await coach.post('/api/squads', body(1))).json;  // a different price
  leo = (await coach.post('/api/athletes', { name: 'Leo Parker', squadId: dev.id, frequency: 'weekly' })).json.athlete;
  const invited = await app.auth.inviteUser({ clubId, email: 'fam@fam.test', role: 'parent', athleteIds: [leo.id] });
  parentId = invited.user.id;
  parent = await setUp(invited.url, 'fam@fam.test');
});
after(async () => { await app.close(); });

async function setUp(url, email) {
  const b = browser(app.base);
  assert.equal((await b.post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD })).status, 200);
  const login = await b.post('/api/auth/login', { email, password: PASSWORD });
  if (login.json.stage === 'mfa_setup') {
    const s = await b.post('/api/auth/2fa/setup');
    await b.post('/api/auth/2fa/confirm', { code: await totpNow(s.json.secret) });
  }
  return b;
}
const boot = async (who) => (await who.get('/api/bootstrap')).json;
const lastCall = (name) => stripe.calls.findLast((c) => c.name === name);

test('clubs start on card only; the coach or treasurer can switch to bank transfer', async () => {
  assert.deepEqual((await boot(parent)).me.club.payments, { connected: true, started: true, card: true, bank: null, defaultMethod: 'bank' });
  assert.equal((await parent.put('/api/club/payment-methods', { bank: true })).status, 403, 'parents cannot change it');
  assert.equal((await treasurer.put('/api/club/payment-methods', { card: false, bank: false })).status, 400, 'at least one way to pay');
  assert.equal((await treasurer.put('/api/club/payment-methods', { bank: true })).status, 400, 'bank needs account details');
  assert.equal((await treasurer.put('/api/club/payment-methods', { bank: true, bankAccountName: 'Family Club Inc', bankAccountNumber: '12-34' })).status, 400);
  const r = await treasurer.put('/api/club/payment-methods', { card: false, bank: true, bankAccountName: 'Family Club Inc', bankAccountNumber: '1234560123456000' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.payments.bank.accountNumber, '12-3456-0123456-000');
});

test('brothers and sisters are one family with one total, even in different groups', async () => {
  mia = (await coach.post('/api/athletes', { name: 'Mia Parker', squadId: bronze.id })).json.athlete;
  await coach.put(`/api/users/${parentId}/athletes`, { athleteIds: [leo.id, mia.id] });
  const b = await boot(parent);
  assert.equal(b.families.length, 1, 'one family');
  const fam = b.families[0];
  assert.deepEqual(fam.athleteIds.sort(), [leo.id, mia.id].sort());
  assert.equal(fam.name, 'Parker family');
  assert.match(fam.reference, /^PARKERF\d+$/);
  assert.ok(fam.reference.length <= 12, 'fits a bank reference');
  assert.equal(fam.total, Math.round((dev.weekly + bronze.weekly) * 100) / 100, 'each child at their own group\'s price');
  assert.equal(fam.payMethod, 'bank', 'the club only takes bank transfers');
  assert.ok(b.athletes.every((a) => a.familyId === fam.id && a.payRef === fam.reference));
});

test('parents choose how often the family pays, but never card or bank', async () => {
  const famId = (await boot(parent)).families[0].id;
  assert.equal((await parent.put(`/api/families/${famId}/pay-method`, { method: 'card' })).status, 403, 'the club decides card or bank');
  const r = await parent.put(`/api/families/${famId}/frequency`, { frequency: 'monthly' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.family.frequency, 'monthly');
  assert.equal(r.json.family.total, Math.round((dev.monthly + bronze.monthly) * 100) / 100);
  assert.ok((await boot(parent)).athletes.every((a) => a.frequency === 'monthly'), 'every child moves together');
  assert.equal((await parent.post('/api/checkout/subscription', { familyId: famId })).status, 409, 'no card checkout for a bank family');
});

test('staff record one bank payment for the whole family', async () => {
  const famId = (await boot(coach)).families.find((f) => f.athleteIds.includes(leo.id)).id;
  await treasurer.put(`/api/families/${famId}/status`, { status: 'overdue' });
  assert.ok((await boot(parent)).athletes.every((a) => a.status === 'overdue'), 'overdue together');
  assert.equal((await parent.post(`/api/families/${famId}/payment`, { amount: 100 })).status, 403, 'parents cannot mark themselves paid');
  assert.equal((await treasurer.post(`/api/families/${famId}/payment`, { amount: 0 })).status, 400);
  const r = await treasurer.post(`/api/families/${famId}/payment`, { amount: 160 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.family.status, 'paid');
  assert.ok(r.json.family.lastPaidOn);
  assert.match(r.json.transaction.description, /^Parker family - Bank transfer \(monthly, ref PARKERF\d+\)$/);
  assert.ok((await boot(parent)).athletes.every((a) => a.status === 'paid'));
});

test('with both offered, the club sets each family to card or bank; card is one payment for all the children', async () => {
  await coach.put('/api/club/payment-methods', { card: true, defaultMethod: 'card' });
  sam = (await coach.post('/api/athletes', { name: 'Sam Parker', squadId: dev.id })).json.athlete;
  await coach.put(`/api/users/${parentId}/athletes`, { athleteIds: [leo.id, mia.id, sam.id] });
  const fam = (await boot(parent)).families[0];
  assert.equal(fam.athleteIds.length, 3);
  assert.equal(fam.payMethod, 'card', 'the club default for families it hasn\'t set');

  assert.equal((await coach.put(`/api/families/${fam.id}/pay-method`, { method: 'bank' })).json.family.payMethod, 'bank');
  assert.equal((await parent.post('/api/checkout/subscription', { familyId: fam.id })).status, 409);
  assert.equal((await treasurer.put(`/api/families/${fam.id}/pay-method`, { method: 'card' })).json.family.payMethod, 'card');

  const r = await parent.post('/api/checkout/subscription', { familyId: fam.id });
  assert.equal(r.status, 200, r.text);
  const call = lastCall('checkout.sessions.create');
  assert.deepEqual(call.args[1], { stripeAccount: 'acct_fam' }, 'on the club\'s own Stripe account');
  const quantities = call.args[0].line_items.map((l) => l.quantity).sort();
  assert.equal(quantities.reduce((s, q) => s + q, 0), 3, 'a line for every child');
  assert.equal(call.args[0].metadata.familyId, String(fam.id));
  assert.equal((await parent.post('/api/checkout/pass', { athleteId: sam.id })).status, 200, 'passes are per child');
});

test('card families: Stripe confirms, every child shows paid, and group moves update the card payment', async () => {
  const fam = (await boot(coach)).families.find((f) => f.athleteIds.includes(leo.id));
  stripe.checkout.sessions.retrieve = async () => ({ mode: 'subscription', metadata: { familyId: String(fam.id) }, customer: 'cus_parker', subscription: { id: 'sub_parker', current_period_end: 1893456000, default_payment_method: { card: { last4: '4242' } } } });
  const webhook = await app.handleWebhook(new Request('http://x/api/webhook', { method: 'POST', body: JSON.stringify({ account: 'acct_fam', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } }), headers: { 'stripe-signature': 'signed-with:whsec_connect' } }));
  assert.equal(webhook.status, 400, 'needs the connect secret configured');
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
  try {
    await app.handleWebhook(new Request('http://x/api/webhook', { method: 'POST', body: JSON.stringify({ account: 'acct_fam', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } }), headers: { 'stripe-signature': 'signed-with:whsec_connect' } }));
  } finally { delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET; }
  const after = (await boot(parent)).families[0];
  assert.equal(after.hasSubscription, true);
  assert.equal(after.cardLast4, '4242');

  // Mia moves group: the family's card payment is updated (old line removed, new lines added)
  const r = await coach.put(`/api/athletes/${mia.id}`, { squadId: dev.id });
  assert.equal(r.status, 200, r.text);
  const update = lastCall('subscriptions.update');
  assert.deepEqual(update.args[2], { stripeAccount: 'acct_fam' });
  assert.ok(update.args[1].items.some((i) => i.deleted), 'old line removed');
  assert.equal(update.args[1].items.filter((i) => i.price).reduce((s, i) => s + i.quantity, 0), 3, 'all three children billed');
  assert.equal(update.args[1].proration_behavior, 'create_prorations');

  // The club moves the family to bank: card payments stop after the paid period
  const toBank = await coach.put(`/api/families/${after.id}/pay-method`, { method: 'bank' });
  assert.ok(toBank.json.cardStopsOn);
  assert.equal(toBank.json.family.cardStopping, true);
  assert.equal(lastCall('subscriptions.update').args[1].cancel_at_period_end, true);
});

test('a child unlinked from the family gets a family of their own', async () => {
  await coach.put(`/api/users/${parentId}/athletes`, { athleteIds: [leo.id, mia.id] });
  const families = (await boot(coach)).families;
  const parkers = families.find((f) => f.athleteIds.includes(leo.id));
  assert.deepEqual(parkers.athleteIds.sort(), [leo.id, mia.id].sort());
  const samsFamily = families.find((f) => f.athleteIds.includes(sam.id));
  assert.notEqual(samsFamily.id, parkers.id);
  assert.deepEqual(samsFamily.athleteIds, [sam.id]);
});

test('another club never sees these families or bank details', async () => {
  const other = await app.clubs.createClub({ name: 'Other', sport: 'Swimming', status: 'active' });
  const oc = await setUp((await app.auth.inviteUser({ clubId: other, email: 'c@other-fam.test', role: 'coach' })).url, 'c@other-fam.test');
  const b = await boot(oc);
  assert.equal(b.me.club.payments.bank, null);
  assert.deepEqual(b.families, []);
  const famId = (await boot(coach)).families[0].id;
  assert.equal((await oc.post(`/api/families/${famId}/payment`, { amount: 5 })).status, 404);
  assert.equal((await oc.put(`/api/families/${famId}/pay-method`, { method: 'card' })).status, 404);
  assert.equal((await oc.put(`/api/families/${famId}/frequency`, { frequency: 'weekly' })).status, 404);
});
