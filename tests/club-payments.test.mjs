// How parents pay their club: the club decides card or bank transfer for each family, and a
// family's children are billed together (one schedule, one total, one reference, one card payment).
import { startServer, browser, tokenFromUrl, totpNow, PASSWORD, SEED_SQUADS, fakeStripe, emailedLink } from './helpers.mjs';
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
  assert.deepEqual((await boot(parent)).me.club.payments, { connected: true, started: true, card: true, bank: null, defaultMethod: 'bank', cardFee: 'club', cardFeeRule: { percent: 2.65, fixedNzd: 0.3 } });
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
  const offer = (await coach.post(`/api/athletes/${sam.id}/passes`, { sessions: 10, price: 100, paidBy: 'offer' })).json.pass;
  assert.equal((await parent.post('/api/checkout/pass', { passId: offer.id })).status, 200, 'a pass offered to one child');
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

test('card fees: the club chooses whether it pays Stripe\'s fee or parents do; parents see it before paying', async () => {
  const { cardFeeFor } = await import('../lib/server/rules.js');
  // Enough that the club still gets the full amount after Stripe's 2.65% + 30c, and never more
  assert.equal(cardFeeFor(57), 1.85); // rounded down: the club may be under a cent short, parents are never over-charged
  const net = (gross) => gross - (gross * 0.0265 + 0.30);
  for (const amount of [5, 25.5, 57, 100, 312.4]) {
    const fee = cardFeeFor(amount);
    assert.ok(net(amount + fee) <= amount + 0.005 && net(amount + fee) >= amount - 0.02, `${amount}: fee ${fee}`);
    assert.ok(fee <= (amount + fee) * 0.0265 + 0.30, 'never more than Stripe\'s own fee');
  }
  assert.equal(cardFeeFor(0), 0);

  const fam = (await boot(parent)).families[0];
  await coach.put(`/api/families/${fam.id}/pay-method`, { method: 'card' }); // it was moved to bank earlier
  assert.equal(fam.cardFee, 0, 'the club pays by default');
  assert.equal((await parent.put('/api/club/payment-methods', { cardFee: 'parents' })).status, 403, 'parents cannot choose');
  const set = await treasurer.put('/api/club/payment-methods', { cardFee: 'parents' });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.payments.cardFee, 'parents');
  // Other saves keep the choice
  assert.equal((await treasurer.put('/api/club/payment-methods', { defaultMethod: 'card' })).json.payments.cardFee, 'parents');

  const after = (await boot(parent)).families.find((f) => f.id === fam.id);
  assert.equal(after.payMethod, 'card');
  assert.equal(after.cardFee, cardFeeFor(after.total), 'parents see the fee and the total before paying');
  // The family's card subscription gets a card-fee line (Parker family has one from earlier tests)
  const update = stripe.calls.findLast((c) => c.name === 'subscriptions.update' && c.args[1].items);
  assert.ok(update.args[1].items.some((i) => String(i.price).startsWith('price_cardfee_')), 'card fee added to the card payments already set up');
  const feePrice = stripe.calls.findLast((c) => c.name === 'prices.create' && c.args[0].product === 'card_fee').args[0];
  assert.equal(feePrice.unit_amount, Math.round(cardFeeFor(after.total) * 100));

  // Bank families never pay a card fee
  await coach.put(`/api/families/${fam.id}/pay-method`, { method: 'bank' });
  assert.equal((await boot(parent)).families.find((f) => f.id === fam.id).cardFee, 0);
  await coach.put(`/api/families/${fam.id}/pay-method`, { method: 'card' });

  // A pass bought by card carries the fee as its own line
  const offer = (await coach.post(`/api/athletes/${leo.id}/passes`, { sessions: 5, price: 60, paidBy: 'offer' })).json.pass;
  assert.equal((await parent.post('/api/checkout/pass', { passId: offer.id })).status, 200);
  const passLines = stripe.calls.findLast((c) => c.name === 'checkout.sessions.create').args[0].line_items;
  assert.equal(passLines.length, 2);
  assert.equal(passLines[1].price_data.product_data.name, 'Card processing fee');
  assert.equal(passLines[1].price_data.unit_amount, Math.round(cardFeeFor(60) * 100));

  // Back to the club paying: the fee line is removed from card payments
  await coach.put('/api/club/payment-methods', { cardFee: 'club' });
  const back = stripe.calls.findLast((c) => c.name === 'subscriptions.update' && c.args[1].items);
  assert.ok(back.args[1].items.every((i) => !String(i.price || '').startsWith('price_cardfee_')));
  assert.equal((await boot(parent)).families[0].cardFee, 0);
});

test('parents are found from their children\'s records: one-tap invite links every child with that parent email', async () => {
  const ana = (await coach.post('/api/athletes', { name: 'Ana Tui', squadId: dev.id, parent: 'Abdu Tui', email: 'Abdu@Tui.test' })).json.athlete;
  const ben = (await coach.post('/api/athletes', { name: 'Ben Tui', squadId: bronze.id, parent: 'Abdu Tui', email: 'abdu@tui.test' })).json.athlete;
  const other = (await coach.post('/api/athletes', { name: 'Someone Else', squadId: dev.id, parent: 'X', email: 'x@else.test' })).json.athlete;
  const noEmail = (await coach.post('/api/athletes', { name: 'No Email', squadId: dev.id })).json.athlete;
  const missing = await coach.post(`/api/athletes/${noEmail.id}/invite-parent`);
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /Add the parent's email to No Email's record/);

  const r = await coach.post(`/api/athletes/${ana.id}/invite-parent`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.email, 'abdu@tui.test');
  assert.deepEqual(r.json.children.sort(), ['Ana Tui', 'Ben Tui'], 'both children, matched by email (any capitals)');
  assert.equal(r.json.emailed, true);
  const abdu = await setUp(await emailedLink(app, 'abdu@tui.test'), 'abdu@tui.test');
  const b = await boot(abdu);
  assert.deepEqual(b.athletes.map((x) => x.name).sort(), ['Ana Tui', 'Ben Tui']);
  assert.equal(b.families.length, 1, 'one family for the two children');
  assert.ok(!b.athletes.some((x) => x.id === other.id));

  // A new brother added later with the same parent email joins the account and the family by itself
  const cal = await coach.post('/api/athletes', { name: 'Cal Tui', squadId: dev.id, parent: 'Abdu Tui', email: 'abdu@tui.test' });
  assert.equal(cal.json.linkedParent, true);
  const after = await boot(abdu);
  assert.equal(after.athletes.length, 3);
  assert.equal(after.families.length, 1);
  // So does a child whose parent email is corrected to match
  await coach.put(`/api/athletes/${noEmail.id}`, { email: 'abdu@tui.test' });
  assert.equal((await boot(abdu)).athletes.length, 4);
  // Inviting again for an existing parent just links (no new invite)
  const again = await coach.post(`/api/athletes/${ben.id}/invite-parent`);
  assert.equal(again.json.linked, true);
});

test('the confirm box decides which children go on the parent\'s account, including different surnames', async () => {
  const mum = (await coach.post('/api/athletes', { name: 'Lily Brown', squadId: dev.id, parent: 'Kate Smith', email: 'kate@smith.test', phone: '021 555 0101' })).json.athlete;
  const step = (await coach.post('/api/athletes', { name: 'Jack Jones', squadId: dev.id, parent: 'Kate Smith' })).json.athlete; // no email on his record
  const r = await coach.post(`/api/athletes/${mum.id}/invite-parent`, { athleteIds: [step.id] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.children.sort(), ['Jack Jones', 'Lily Brown'], 'the child itself is always included');
  const kate = await setUp(await emailedLink(app, 'kate@smith.test'), 'kate@smith.test');
  assert.deepEqual((await boot(kate)).athletes.map((a) => a.name).sort(), ['Jack Jones', 'Lily Brown']);
  assert.equal((await boot(kate)).families.length, 1, 'one family');
  // Another club's child can't be added
  const otherClub = await app.clubs.createClub({ name: 'Elsewhere', sport: 'Swimming', status: 'active' });
  const oc = await setUp((await app.auth.inviteUser({ clubId: otherClub, email: 'c@elsewhere.test', role: 'coach' })).url, 'c@elsewhere.test');
  const { id, ...sq } = SEED_SQUADS[0];
  const theirSquad = (await oc.post('/api/squads', sq)).json;
  const theirs = (await oc.post('/api/athletes', { name: 'Not Ours', squadId: theirSquad.id })).json.athlete;
  assert.equal((await coach.post(`/api/athletes/${mum.id}/invite-parent`, { athleteIds: [theirs.id] })).status, 400);
});

test('back from Stripe\'s page, the app checks the payment itself (no need to wait for Stripe\'s message)', async () => {
  const fam = (await boot(parent)).families[0];
  // Start from a family without auto-pay
  await app.query(`update app.families set billing = '{}' where id = $1`, fam.id);
  assert.equal((await boot(parent)).families[0].hasSubscription, false);
  const subCall = (await parent.post('/api/checkout/subscription', { familyId: fam.id }));
  assert.equal(subCall.status, 200, subCall.text);
  assert.match(stripe.calls.findLast((c) => c.name === 'checkout.sessions.create').args[0].success_url, /checkout=success&session=\{CHECKOUT_SESSION_ID\}$/);
  stripe.checkout.sessions.retrieve = async (id) => ({ id, status: 'complete', mode: 'subscription', metadata: { familyId: String(fam.id) }, customer: 'cus_back',
    subscription: { id: 'sub_back', current_period_end: 1893456000, default_payment_method: { card: { last4: '1111' } } } });
  assert.equal((await parent.post('/api/checkout/confirm', { sessionId: 'nope' })).status, 400);
  const r = await parent.post('/api/checkout/confirm', { sessionId: 'cs_test_back123' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.done, true);
  const after = (await boot(parent)).families[0];
  assert.equal(after.hasSubscription, true);
  assert.equal(after.cardLast4, '1111');
  // Another parent can't confirm (or see) this family's checkout
  const stranger = await setUp((await app.auth.inviteUser({ clubId, email: 'stranger@fam.test', role: 'parent', athleteIds: [] })).url, 'stranger@fam.test');
  assert.equal((await stranger.post('/api/checkout/confirm', { sessionId: 'cs_test_back123' })).status, 404);
});

test('Refresh (and the daily check) asks Stripe how card families stand, even if webhooks were missed', async () => {
  const fam = (await boot(coach)).families.find((f) => f.hasSubscription);
  assert.ok(fam, 'a card family');
  assert.equal((await parent.post('/api/payments/sync')).status, 403, 'staff only');
  stripe.subscriptions.retrieve = async (id) => ({ id, status: 'past_due', current_period_end: 1893456000, cancel_at_period_end: false,
    latest_invoice: { id: 'in_failed', status: 'open', attempt_count: 1, amount_paid: 0 }, default_payment_method: { card: { last4: '0341' } } });
  const r = await treasurer.post('/api/payments/sync');
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.checked >= 1);
  assert.equal((await boot(coach)).families.find((f) => f.id === fam.id).status, 'overdue', 'a failed payment shows as overdue');

  stripe.subscriptions.retrieve = async (id) => ({ id, status: 'active', current_period_end: 1893456000, cancel_at_period_end: false,
    latest_invoice: { id: 'in_paid_late', status: 'paid', amount_paid: 2598, status_transitions: { paid_at: 1890000000 } }, default_payment_method: { card: { last4: '4242' } } });
  await app.query(`delete from app.rate_limits`);
  await app.sweep();
  const after = (await boot(coach)).families.find((f) => f.id === fam.id);
  assert.equal(after.status, 'paid');
  assert.equal(after.cardLast4, '4242');
  await app.query(`delete from app.rate_limits`);
  await treasurer.post('/api/payments/sync'); // again: the payment is recorded only once
  const income = (await boot(coach)).transactions.filter((t) => t.amount === 25.98 && /fees$/.test(t.description));
  assert.equal(income.length, 1);
});
