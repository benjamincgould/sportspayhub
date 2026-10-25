// Session passes: the coach or treasurer sets how many sessions a group's pass has and its price,
// and can give a child a pass. Each session the coach marks the child present uses one.
import { startServer, browser, tokenFromUrl, totpNow, PASSWORD, SEED_SQUADS, fakeStripe } from './helpers.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
let stripe;
let coach;
let treasurer;
let parent;
let dev;
let kid;
let other;
let clubId;
before(async () => {
  stripe = fakeStripe();
  app = await startServer({ stripe });
  clubId = await app.clubs.createClub({ name: 'Pass Club', sport: 'Swimming', status: 'active' });
  await app.query(`update app.clubs set billing = '{"connectAccountId":"acct_pass","connectChargesEnabled":true}' where id = $1`, clubId);
  coach = await setUp((await app.auth.inviteUser({ clubId, email: 'coach@pass.test', role: 'coach' })).url, 'coach@pass.test');
  treasurer = await setUp((await app.auth.inviteUser({ clubId, email: 'treasurer@pass.test', role: 'treasurer' })).url, 'treasurer@pass.test');
  const { id, ...body } = SEED_SQUADS[0];
  dev = (await coach.post('/api/squads', body)).json;
  kid = (await coach.post('/api/athletes', { name: 'Kai Ngata', squadId: dev.id })).json.athlete;
  other = (await coach.post('/api/athletes', { name: 'Other Kid', squadId: dev.id })).json.athlete;
  parent = await setUp((await app.auth.inviteUser({ clubId, email: 'p@pass.test', role: 'parent', athleteIds: [kid.id] })).url, 'p@pass.test');
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
const series = () => dev.sessions[0].seriesId;

test('one pass for the whole club: the coach and treasurer set the sessions and price', async () => {
  assert.equal((await parent.post('/api/checkout/pass', { athleteId: kid.id })).status, 409, 'no pass set up yet');
  assert.equal((await parent.put('/api/club/pass', { sessions: 5, price: 50 })).status, 403, 'not parents');
  assert.equal((await treasurer.put('/api/club/pass', { sessions: 0, price: 50 })).status, 400);
  assert.equal((await treasurer.put('/api/club/pass', { sessions: 8, price: 0 })).status, 400);
  const r = await treasurer.put('/api/club/pass', { sessions: 8, price: 96 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.pass, { sessions: 8, price: 96 });
  assert.deepEqual((await coach.put('/api/club/pass', { sessions: 12, price: 120 })).json.pass, { sessions: 12, price: 120 });
  assert.deepEqual((await boot(parent)).settings.pass, { sessions: 12, price: 120 }, 'parents see the pass');
  // Groups only have weekly, fortnightly and monthly prices now
  const { id, pass, passSessions, ...rest } = dev;
  assert.equal((await coach.put(`/api/squads/${dev.id}`, { ...rest, name: 'Development' })).status, 200);
});

test('parents buy the club\'s pass by card, whatever the group; Stripe confirming it gives the child the pass', async () => {
  const r = await parent.post('/api/checkout/pass', { athleteId: kid.id });
  assert.equal(r.status, 200, r.text);
  const call = stripe.calls.findLast((x) => x.name === 'checkout.sessions.create');
  assert.equal(call.args[0].line_items[0].price_data.unit_amount, 12000);
  assert.match(call.args[0].line_items[0].price_data.product_data.name, /12-Session Pass/);
  const fam = (await boot(parent)).families[0];
  stripe.checkout.sessions.retrieve = async () => ({ id: 'cs_pass', mode: 'payment', payment_status: 'paid', amount_total: 12000, customer: 'cus_k', metadata: { familyId: String(fam.id), athleteId: String(kid.id), sessions: '12', kind: 'pass' } });
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
  try {
    for (let i = 0; i < 2; i++) { // Stripe may send it twice: still one pass
      await app.handleWebhook(new Request('http://x/api/webhook', { method: 'POST', body: JSON.stringify({ account: 'acct_pass', type: 'checkout.session.completed', data: { object: { id: 'cs_pass' } } }), headers: { 'stripe-signature': 'signed-with:whsec_connect' } }));
    }
  } finally { delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET; }
  const passes = (await boot(parent)).passes;
  assert.equal(passes.length, 1);
  assert.deepEqual([passes[0].sessions, passes[0].left, passes[0].paidBy, passes[0].price], [12, 12, 'card', 120]);
});

test('the coach or treasurer issues a pass with their own sessions and price; paid ones go in the books', async () => {
  assert.equal((await parent.post(`/api/athletes/${kid.id}/passes`, { sessions: 5, price: 50, paidBy: 'cash' })).status, 403);
  assert.equal((await coach.post(`/api/athletes/${kid.id}/passes`, { sessions: 0, price: 50, paidBy: 'cash' })).status, 400);
  assert.equal((await coach.post(`/api/athletes/${kid.id}/passes`, { sessions: 5, price: 50, paidBy: 'card' })).status, 400, 'card passes come from Stripe');
  const r = await treasurer.post(`/api/athletes/${other.id}/passes`, { sessions: 5, price: 45, paidBy: 'bank' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.pass.sessions, r.json.pass.left, r.json.pass.price], [5, 5, 45]);
  assert.match(r.json.transaction.description, /^Other Kid - 5-Session Pass \(Bank transfer\)$/);
  assert.equal(r.json.transaction.amount, 45);
  const free = await coach.post(`/api/athletes/${other.id}/passes`, { sessions: 2, price: 20, paidBy: 'free' });
  assert.equal(free.json.transaction, null);
  assert.equal(free.json.pass.price, 0);
  const later = await coach.post(`/api/athletes/${other.id}/passes`, { sessions: 3, price: 30, paidBy: 'unpaid' });
  assert.equal(later.json.transaction, null);
  const paid = await treasurer.put(`/api/passes/${later.json.pass.id}`, { paidBy: 'cash' });
  assert.equal(paid.json.pass.paidBy, 'cash');
  assert.equal(paid.json.transaction.amount, 30);
  assert.equal((await treasurer.put(`/api/passes/${later.json.pass.id}`, { paidBy: 'cash' })).status, 400, 'only once');
  assert.equal((await parent.get('/api/bootstrap')).json.passes.every((p) => p.athleteId === kid.id), true, 'parents only see their own child\'s passes');
});

test('marking a child present uses a session; unticking gives it back; the oldest pass is used first', async () => {
  const before = (await boot(coach)).passes.filter((p) => p.athleteId === other.id);
  assert.equal(before.length, 3);
  const date = '2026-03-02';
  let r = await coach.put('/api/attendance', { athleteId: other.id, seriesId: series(), date, present: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.passes[0].left, 4, 'first pass used');
  r = await coach.put('/api/attendance', { athleteId: other.id, seriesId: series(), date, present: true });
  assert.equal(r.json.passes[0].left, 4, 'marking again doesn\'t use another');
  r = await coach.put('/api/attendance', { athleteId: other.id, seriesId: series(), date, present: false });
  assert.equal(r.json.passes[0].left, 5, 'unticked: given back');
  assert.equal((await treasurer.put('/api/attendance', { athleteId: other.id, seriesId: series(), date, present: true })).status, 403, 'attendance stays with the coach');

  const bulk = await coach.post('/api/attendance/bulk', { seriesId: series(), date: '2026-03-09', athleteIds: [other.id, kid.id] });
  assert.equal(bulk.status, 200, bulk.text);
  assert.equal(bulk.json.passes.find((p) => p.athleteId === kid.id).left, 11);
  assert.equal(bulk.json.passes.find((p) => p.athleteId === other.id && p.sessions === 5).left, 4);

  // Used up: the next present mark moves to the next pass
  const first = bulk.json.passes.find((p) => p.athleteId === other.id && p.sessions === 5);
  assert.equal((await coach.put(`/api/passes/${first.id}`, { left: 0 })).json.pass.left, 0, 'staff can correct sessions left');
  r = await coach.put('/api/attendance', { athleteId: other.id, seriesId: series(), date: '2026-03-16', present: true });
  assert.equal(r.json.passes.find((p) => p.sessions === 2).left, 1);
});

test('passes can be cancelled, and other clubs can\'t touch them', async () => {
  const p = (await boot(coach)).passes.find((x) => x.athleteId === other.id);
  const club2 = await app.clubs.createClub({ name: 'Other Club', sport: 'Swimming', status: 'active' });
  const coach2 = await setUp((await app.auth.inviteUser({ clubId: club2, email: 'c2@pass.test', role: 'coach' })).url, 'c2@pass.test');
  assert.equal((await coach2.put(`/api/passes/${p.id}`, { status: 'cancelled' })).status, 404);
  assert.equal((await coach2.post(`/api/athletes/${other.id}/passes`, { sessions: 5, price: 1, paidBy: 'free' })).status, 404);
  assert.equal((await coach2.put(`/api/squads/${dev.id}/pass`, { sessions: 5, price: 1 })).status, 404);
  assert.equal((await treasurer.put(`/api/passes/${p.id}`, { status: 'cancelled' })).json.pass.status, 'cancelled');
  assert.ok(!(await boot(coach)).passes.some((x) => x.id === p.id), 'cancelled passes are hidden');
});

test('clubs choose any financial year start (charities, societies and companies differ)', async () => {
  for (const ok of ['10-01', '07-01', '02-28', '12-31']) {
    const r = await treasurer.put('/api/settings', { financialYearStart: ok });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.financialYearStart, ok);
  }
  for (const bad of ['02-30', '13-01', '00-10', '4-1', 'April']) {
    assert.equal((await treasurer.put('/api/settings', { financialYearStart: bad })).status, 400, bad);
  }
  assert.equal((await parent.put('/api/settings', { financialYearStart: '01-01' })).status, 403);
  assert.equal((await boot(parent)).settings.financialYearStart, '12-31');
});
