// Clubs choose how parents pay them: card through Stripe, bank transfer, or both.
import { startServer, browser, tokenFromUrl, totpNow, PASSWORD, SEED_SQUADS, fakeStripe } from './helpers.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
let coach;
let treasurer;
let parent;
let kid;
let clubId;
before(async () => {
  app = await startServer({ stripe: fakeStripe() });
  clubId = await app.clubs.createClub({ name: 'Bank Club', sport: 'Swimming', status: 'active' });
  await app.query(`update app.clubs set billing = '{"connectAccountId":"acct_bank","connectChargesEnabled":true}' where id = $1`, clubId);
  coach = await setUp((await app.auth.inviteUser({ clubId, email: 'coach@bank.test', role: 'coach' })).url, 'coach@bank.test');
  treasurer = await setUp((await app.auth.inviteUser({ clubId, email: 'treasurer@bank.test', role: 'treasurer' })).url, 'treasurer@bank.test');
  const { id, ...squad } = SEED_SQUADS[0];
  const sq = (await coach.post('/api/squads', squad)).json;
  kid = (await coach.post('/api/athletes', { name: 'Leo Parker', squadId: sq.id, frequency: 'weekly' })).json.athlete;
  parent = await setUp((await app.auth.inviteUser({ clubId, email: 'fam@bank.test', role: 'parent', athleteIds: [kid.id] })).url, 'fam@bank.test');
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
const methods = async (who) => (await who.get('/api/bootstrap')).json.me.club.payments;

test('clubs start on card only; the coach or treasurer can switch to bank transfer', async () => {
  assert.deepEqual(await methods(parent), { connected: true, started: true, card: true, bank: null });
  assert.equal((await parent.put('/api/club/payment-methods', { bank: true })).status, 403, 'parents cannot change it');
  assert.equal((await treasurer.put('/api/club/payment-methods', { card: false, bank: false })).status, 400, 'at least one way to pay');
  assert.equal((await treasurer.put('/api/club/payment-methods', { bank: true })).status, 400, 'bank needs account details');
  assert.equal((await treasurer.put('/api/club/payment-methods', { bank: true, bankAccountName: 'Bank Club Inc', bankAccountNumber: '12-34' })).status, 400);
  const r = await treasurer.put('/api/club/payment-methods', { card: false, bank: true, bankAccountName: 'Bank Club Inc', bankAccountNumber: '1234560123456000', instructions: 'Thanks!' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.payments, { card: false, bank: { accountName: 'Bank Club Inc', accountNumber: '12-3456-0123456-000', instructions: 'Thanks!' } });
});

test('parents see the club\'s bank details and their child\'s own reference; card checkout is closed', async () => {
  const boot = (await parent.get('/api/bootstrap')).json;
  assert.equal(boot.me.club.payments.bank.accountNumber, '12-3456-0123456-000');
  assert.equal(boot.me.club.payments.card, false);
  const ref = boot.athletes[0].payRef;
  assert.match(ref, /^LEOPARKER\d+$/);
  assert.ok(ref.length <= 12, 'fits a bank reference');
  for (const path of ['/api/checkout/subscription', '/api/checkout/pass', '/api/portal']) {
    const res = await parent.post(path, { athleteId: kid.id });
    assert.equal(res.status, 409, path);
    assert.match(res.json.error, /bank transfer/);
  }
  assert.equal((await parent.post(`/api/athletes/${kid.id}/plan`, { frequency: 'monthly' })).status, 200, 'parents can still choose how often they pay');
});

test('staff record a bank payment: the member is marked paid and the income goes in the books', async () => {
  await treasurer.put(`/api/athletes/${kid.id}`, { status: 'overdue' });
  assert.equal((await coach.get('/api/bootstrap')).json.athletes[0].status, 'overdue');
  assert.equal((await parent.post(`/api/athletes/${kid.id}/payment`, { amount: 100 })).status, 403, 'parents cannot mark themselves paid');
  assert.equal((await treasurer.post(`/api/athletes/${kid.id}/payment`, { amount: 0 })).status, 400);
  const r = await treasurer.post(`/api/athletes/${kid.id}/payment`, { amount: 100 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.athlete.status, 'paid');
  assert.ok(r.json.athlete.lastPaidOn);
  const boot = (await coach.get('/api/bootstrap')).json;
  const income = boot.transactions.find((t) => t.id === r.json.transaction.id);
  assert.equal(income.amount, 100);
  assert.match(income.description, /Leo Parker - Bank transfer/);
  // Staff can still mark them overdue later
  await coach.put(`/api/athletes/${kid.id}`, { status: 'overdue' });
  assert.equal((await coach.get('/api/bootstrap')).json.athletes[0].status, 'overdue');
});

test('offering both: card checkout works again alongside bank details', async () => {
  await coach.put('/api/club/payment-methods', { card: true });
  const m = await methods(parent);
  assert.equal(m.card, true);
  assert.ok(m.bank);
  assert.equal((await parent.post('/api/checkout/pass', { athleteId: kid.id })).status, 200);
});

test('another club never sees these bank details', async () => {
  const other = await app.clubs.createClub({ name: 'Other', sport: 'Swimming', status: 'active' });
  const oc = await setUp((await app.auth.inviteUser({ clubId: other, email: 'c@other-bank.test', role: 'coach' })).url, 'c@other-bank.test');
  assert.equal((await methods(oc)).bank, null);
  assert.equal((await oc.post(`/api/athletes/${kid.id}/payment`, { amount: 5 })).status, 404);
});
