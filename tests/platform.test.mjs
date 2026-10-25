// Tests for what's new in the Next.js + Supabase version: Stripe webhook signatures, the hourly
// clean-up, the first-time owner set-up, Supabase sessions ending on sign-out, and the database
// refusing Supabase's public roles.
import { startServer, browser, tokenFromUrl, totpNow, PASSWORD, SEED_SQUADS, fakeStripe, emailedLink, lastMail } from './helpers.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
let stripe;
before(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_platform';
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
  stripe = fakeStripe();
  app = await startServer({ stripe });
});
after(async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  delete process.env.OWNER_SETUP_SECRET;
  await app.close();
});

const squadBody = (i) => { const { id, ...rest } = SEED_SQUADS[i]; return rest; };

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

const webhook = (event, signature) => fetch(`${app.base}/api/webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: JSON.stringify(event),
});

test('Stripe webhooks: unsigned or wrongly signed events are refused', async () => {
  const clubId = await app.clubs.createClub({ name: 'Hook Club', sport: 'Hockey', status: 'preview' });
  const event = { type: 'customer.subscription.updated', data: { object: { id: 'sub_fake', status: 'active', metadata: { kind: 'platform', clubId: String(clubId) } } } };
  assert.equal((await webhook(event, 'none')).status, 400);
  assert.equal((await webhook(event, 'signed-with:whsec_wrong')).status, 400);
  assert.equal((await app.auth.getClub(clubId)).status, 'preview', 'a forged "you paid" event changes nothing');

  assert.equal((await webhook(event, 'signed-with:whsec_platform')).status, 200);
  assert.equal((await app.auth.getClub(clubId)).status, 'active', 'a genuine event unlocks the club');
});

test('Stripe webhooks: a club\'s payment events only reach that club\'s members', async () => {
  const clubA = await app.clubs.createClub({ name: 'Club A', sport: 'Swimming', status: 'active' });
  const clubB = await app.clubs.createClub({ name: 'Club B', sport: 'Swimming', status: 'active' });
  await app.query(`update app.clubs set billing = '{"connectAccountId":"acct_a","connectChargesEnabled":true}' where id = $1`, clubA);
  await app.query(`update app.clubs set billing = '{"connectAccountId":"acct_b","connectChargesEnabled":true}' where id = $1`, clubB);
  const coachB = await finishSetup((await app.auth.inviteUser({ clubId: clubB, email: 'coach@b.test', role: 'coach' })).url, 'coach@b.test');
  const squad = (await coachB.post('/api/squads', squadBody(0))).json;
  const kidB = (await coachB.post('/api/athletes', { name: 'B Kid', squadId: squad.id })).json.athlete;
  await app.query(`update app.families set billing = '{"customerId":"cus_b","subscriptionId":"sub_b"}' where id = $1`, kidB.familyId);
  const familyStatus = async () => (await app.one('select status from app.families where id = $1', kidB.familyId)).status;

  // Club A's account claims a failed payment for club B's family: ignored
  await webhook({ account: 'acct_a', type: 'invoice.payment_failed', data: { object: { customer: 'cus_b' } } }, 'signed-with:whsec_connect');
  assert.equal(await familyStatus(), 'paid');
  // The same event from club B's own account is applied
  await webhook({ account: 'acct_b', type: 'invoice.payment_failed', data: { object: { customer: 'cus_b' } } }, 'signed-with:whsec_connect');
  assert.equal(await familyStatus(), 'overdue');
  // Paid invoices land in the club's ledger once, however often Stripe retries
  const paid = { account: 'acct_b', type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_b', amount_paid: 2550 } } };
  await webhook(paid, 'signed-with:whsec_connect');
  await webhook(paid, 'signed-with:whsec_connect');
  assert.equal((await app.one("select count(*)::int as n from app.transactions where ref = 'in_1' and club_id = $1", clubB)).n, 1);
});

test('signing out ends the Supabase session too; "sign out everywhere" ends them all', async () => {
  const clubId = await app.clubs.createClub({ name: 'Session Club', sport: 'Rowing', status: 'active' });
  const { url, user } = await app.auth.inviteUser({ clubId, email: 'fam@session.test', role: 'parent' });
  await browser(app.base).post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD });
  const live = () => [...app.provider.sessions.values()].filter((s) => s.userId === user.id && !s.revoked).length;

  const one = browser(app.base);
  const two = browser(app.base);
  await one.post('/api/auth/login', { email: 'fam@session.test', password: PASSWORD });
  await two.post('/api/auth/login', { email: 'fam@session.test', password: PASSWORD });
  assert.equal(live(), 2);
  await one.post('/api/auth/logout');
  assert.equal(live(), 1, 'signing out revokes that Supabase session');
  assert.equal((await two.get('/api/bootstrap')).status, 200, 'the other device is unaffected');
  await one.post('/api/auth/login', { email: 'fam@session.test', password: PASSWORD });
  await two.post('/api/auth/logout-all');
  assert.equal(live(), 0, 'sign out everywhere revokes every Supabase session');
  assert.equal((await one.get('/api/bootstrap')).status, 401);
});

test('switching someone off also bans them in Supabase Auth', async () => {
  const clubId = await app.clubs.createClub({ name: 'Ban Club', sport: 'Tennis', status: 'active' });
  const coach = await finishSetup((await app.auth.inviteUser({ clubId, email: 'coach@ban.test', role: 'coach' })).url, 'coach@ban.test');
  const { user } = await app.auth.inviteUser({ clubId, email: 'fam@ban.test', role: 'parent' });
  await coach.post(`/api/users/${user.id}/status`, { status: 'disabled' });
  assert.equal(app.provider.users.get(user.id).banned, true);
  await coach.post(`/api/users/${user.id}/status`, { status: 'active' });
  assert.equal(app.provider.users.get(user.id).banned, false);
  assert.equal((await coach.post('/api/users/not-a-uuid/status', { status: 'disabled' })).status, 404, 'malformed ids are just "not found"');
});

test('first-time set-up: the owner account needs the set-up code, and works only once', async () => {
  const anon = browser(app.base);
  assert.equal((await anon.get('/api/setup/owner')).json.available, false, 'off unless OWNER_SETUP_SECRET is set');
  assert.equal((await anon.post('/api/setup/owner', { secret: '', email: 'me@owner.test' })).status, 404);

  process.env.OWNER_SETUP_SECRET = 'a-long-random-setup-code-for-tests';
  assert.equal((await anon.get('/api/setup/owner')).json.available, true);
  assert.equal((await anon.post('/api/setup/owner', { secret: 'wrong guess', email: 'me@owner.test' })).status, 403);
  const ok = await anon.post('/api/setup/owner', { secret: process.env.OWNER_SETUP_SECRET, email: 'me@owner.test', name: 'Me' });
  assert.equal(ok.status, 200, ok.text);
  const owner = await finishSetup(await emailedLink(app, 'me@owner.test'), 'me@owner.test');
  assert.equal((await owner.get('/api/owner/clubs')).status, 200, 'the owner is in');

  assert.equal((await anon.get('/api/setup/owner')).json.available, false, 'closed once an owner exists');
  assert.equal((await anon.post('/api/setup/owner', { secret: process.env.OWNER_SETUP_SECRET, email: 'second@owner.test' })).status, 404);
});

test('daily clean-up removes expired sessions and never-confirmed sign-ups, sign-in accounts included', async () => {
  const anon = browser(app.base);
  await anon.post('/api/signup', { clubName: 'Abandoned FC', sport: 'Football', name: 'Al', email: 'al@abandoned.test' });
  await app.settle();
  const club = await app.one("select id from app.clubs where name = 'Abandoned FC'");
  assert.ok(club, 'sign-up created a preview club');
  assert.equal((await app.one("select count(*)::int as n from auth.users where email = 'al@abandoned.test'")).n, 1);
  await app.query("update app.clubs set created_at = now() - interval '8 days' where id = $1", club.id);
  await app.query("insert into app.sessions (id_hash, user_id, stage, expires_at) select 'old', id, 'full', now() - interval '1 minute' from app.profiles limit 1");

  const result = await app.sweep();
  assert.equal(result.removedClubs, 1);
  assert.equal(await app.one('select id from app.clubs where id = $1', club.id), undefined);
  assert.equal((await app.one("select count(*)::int as n from auth.users where email = 'al@abandoned.test'")).n, 0);
  assert.equal(await app.one("select 1 from app.sessions where id_hash = 'old'"), undefined);
});

test('the database refuses Supabase\'s public roles, even if the schema were exposed', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(app.query(`set role ${role}; select * from app.athletes`), /permission denied/);
    await app.query('reset role');
  }
  const unlocked = await app.query("select tablename from pg_tables where schemaname = 'app' and not rowsecurity");
  assert.equal(unlocked.length, 0, 'row-level security is on for every table');
});

test('a parent can turn two-step on and off; their session keeps working afterwards', async () => {
  const clubId = await app.clubs.createClub({ name: 'Optional 2FA Club', sport: 'Dance', status: 'active' });
  const { url } = await app.auth.inviteUser({ clubId, email: 'fam@optional.test', role: 'parent' });
  await browser(app.base).post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD });
  const b = browser(app.base);
  const other = browser(app.base);
  await b.post('/api/auth/login', { email: 'fam@optional.test', password: PASSWORD });
  const setup = await b.post('/api/auth/2fa/setup');
  assert.equal((await b.post('/api/auth/2fa/confirm', { code: await totpNow(setup.json.secret) })).json.user.mfaEnabled, true);
  assert.equal((await other.post('/api/auth/login', { email: 'fam@optional.test', password: PASSWORD })).json.stage, 'mfa', 'now asks for a code');
  assert.equal((await other.post('/api/auth/2fa/verify', { code: await totpNow(setup.json.secret) })).status, 200);

  assert.equal((await b.post('/api/auth/2fa/disable', { password: 'not my password' })).status, 400);
  const off = await b.post('/api/auth/2fa/disable', { password: PASSWORD });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.user.mfaEnabled, false);
  assert.equal((await b.get('/api/bootstrap')).status, 200, 'this device stays signed in');
  assert.equal((await other.get('/api/bootstrap')).status, 401, 'other devices are signed out');
  // ...and this device can still do things that need its Supabase session
  assert.equal((await b.post('/api/auth/2fa/setup')).status, 200);
  await b.post('/api/auth/logout');
  assert.equal((await b.post('/api/auth/login', { email: 'fam@optional.test', password: PASSWORD })).json.stage, 'full', 'no code needed any more');
});

test('after a password change, this device can still use its Supabase session', async () => {
  const clubId = await app.clubs.createClub({ name: 'Password Club', sport: 'Cycling', status: 'active' });
  const { url } = await app.auth.inviteUser({ clubId, email: 'fam@pw.test', role: 'parent' });
  await browser(app.base).post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD });
  const b = browser(app.base);
  await b.post('/api/auth/login', { email: 'fam@pw.test', password: PASSWORD });
  assert.equal((await b.post('/api/auth/password', { current: PASSWORD, next: 'a different long passphrase' })).status, 200);
  assert.equal((await b.post('/api/auth/2fa/setup')).status, 200, 'two-step setup still works on this device');
});

test('Supabase sees each visitor\'s own address, not the server\'s (its per-address limits stay per visitor)', async () => {
  const clubId = await app.clubs.createClub({ name: 'Address Club', sport: 'Netball', status: 'active' });
  const { url } = await app.auth.inviteUser({ clubId, email: 'fam@addr.test', role: 'parent' });
  await browser(app.base).post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD });
  app.provider.calls.length = 0;
  await browser(app.base).post('/api/auth/login', { email: 'fam@addr.test', password: PASSWORD }, { headers: { 'X-Forwarded-For': '10.9.9.9, 203.0.113.77' } });
  assert.ok(app.provider.calls.some(([name, ip]) => name === 'withIp' && ip === '203.0.113.77'), 'the address the proxy saw is passed on');
  app.provider.calls.length = 0;
  await browser(app.base).post('/api/auth/login', { email: 'fam@addr.test', password: PASSWORD }, { headers: { 'X-Forwarded-For': 'not-an-address' } });
  assert.ok(app.provider.calls.some(([name, ip]) => name === 'withIp' && ip === null), 'anything that isn\'t a plain address is not passed on');
});

test('a missing database table is explained as a setup problem, not a vague error', async () => {
  await app.query('alter table app.rate_limits rename to rate_limits_hidden');
  try {
    const r = await browser(app.base).get('/api/platform');
    assert.equal(r.status, 500);
    assert.match(r.json.error, /database tables are missing/);
  } finally {
    await app.query('alter table app.rate_limits_hidden rename to rate_limits');
  }
});

test('on a brand-new empty database, the app creates its own tables on the first request', async () => {
  const fresh = await startServer({ emptyDatabase: true });
  try {
    const before = await fresh.one("select count(*)::int as n from information_schema.schemata where schema_name = 'app'");
    assert.equal(before.n, 0, 'starts empty');
    const [a, b] = await Promise.all([browser(fresh.base).get('/api/platform'), browser(fresh.base).get('/api/platform')]);
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    assert.equal((await fresh.one("select count(*)::int as n from pg_tables where schemaname = 'app' and not rowsecurity")).n, 0, 'all tables locked');
    assert.ok((await fresh.one("select count(*)::int as n from pg_tables where schemaname = 'app'")).n >= 16, 'all tables created');
    assert.equal((await browser(fresh.base).get('/api/platform')).status, 200, 'later requests carry on as normal');
  } finally {
    await fresh.close();
  }
});

test("the app's built-in copy of the database changes matches supabase/migrations", async () => {
  const fs = await import('node:fs');
  const { MIGRATIONS } = await import('../lib/server/schema-sql.js');
  const files = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual(MIGRATIONS.map((m) => `${m.id}.sql`), files, 'run: node scripts/build-schema.mjs');
  for (const m of MIGRATIONS) assert.equal(m.sql, fs.readFileSync(new URL(`../supabase/migrations/${m.id}.sql`, import.meta.url), 'utf8'), m.id);
});

test('a database set up before migrations were tracked is brought up to date once', async () => {
  const fresh = await startServer({ emptyDatabase: true });
  try {
    const fs = await import('node:fs');
    // Exactly what the first live deployment did: only the first setup file, no bookkeeping
    await fresh.query(fs.readFileSync(new URL('../supabase/migrations/0001_init.sql', import.meta.url), 'utf8'));
    assert.equal((await browser(fresh.base).get('/api/platform')).status, 200);
    const ids = (await fresh.query('select id from app.schema_migrations order by id')).map((r) => r.id);
    assert.deepEqual(ids, ['0001_init', '0002_platform_charges', '0003_payment_details_and_email_change', '0004_families', '0005_passes', '0006_pass_offers', '0007_trusted_devices_and_titles']);
    assert.equal((await fresh.one("select count(*)::int as n from pg_tables where schemaname = 'app' and not rowsecurity")).n, 0, 'new tables are locked too');
  } finally {
    await fresh.close();
  }
});

test('people can change their email: password needed, new address confirms, old address is told', async () => {
  const clubId = await app.clubs.createClub({ name: 'Email Club', sport: 'Hockey', status: 'active' });
  const { url } = await app.auth.inviteUser({ clubId, email: 'old@email.test', role: 'parent' });
  await browser(app.base).post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD });
  const b = browser(app.base);
  await b.post('/api/auth/login', { email: 'old@email.test', password: PASSWORD });

  assert.equal((await b.post('/api/auth/email', { newEmail: 'new@email.test', password: 'wrong password here' })).status, 400);
  assert.equal((await b.post('/api/auth/email', { newEmail: 'not-an-email', password: PASSWORD })).status, 400);
  assert.equal((await b.post('/api/auth/email', { newEmail: 'fam@session.test', password: PASSWORD })).status, 409, 'already used by someone');
  const asked = await b.post('/api/auth/email', { newEmail: 'New@Email.test', password: PASSWORD });
  assert.equal(asked.status, 200, asked.text);
  assert.equal((await b.get('/api/auth/session')).json.user.email, 'old@email.test', 'nothing changes yet');
  assert.ok((await lastMail(app, 'old@email.test', /Email change requested/)), 'the old address is told');

  const link = await emailedLink(app, 'new@email.test');
  assert.match(link, /#\/email\//);
  assert.equal((await browser(app.base).post('/api/auth/accept', { token: tokenFromUrl(link), password: 'some new password here' })).status, 400, 'an email link cannot be used to set a password');
  const done = await browser(app.base).post('/api/auth/email/confirm', { token: tokenFromUrl(link) });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.email, 'new@email.test');
  assert.equal((await browser(app.base).post('/api/auth/email/confirm', { token: tokenFromUrl(link) })).status, 400, 'works once');
  assert.ok(await lastMail(app, 'old@email.test', /was changed/));

  assert.equal((await b.get('/api/auth/session')).json.user.email, 'new@email.test', 'this device stays signed in');
  assert.equal((await browser(app.base).post('/api/auth/login', { email: 'new@email.test', password: PASSWORD })).json.stage, 'full', 'signs in with the new email');
  assert.equal((await browser(app.base).post('/api/auth/login', { email: 'old@email.test', password: PASSWORD })).status, 401, 'not the old one');
});
