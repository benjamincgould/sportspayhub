import { startServer, browser, tokenFromUrl, totpNow, PASSWORD, SEED_SQUADS, fakeStripe, emailedLink, lastMail } from './helpers.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
let stripe;
before(async () => { stripe = fakeStripe(); app = await startServer({ stripe }); });
after(async () => { await app.close(); });

const squadBody = (i) => { const { id, ...rest } = SEED_SQUADS[i]; return rest; };
const lastMailTo = (email) => lastMail(app, email);
const linkIn = (mail) => mail.text.match(/http\S+#\/(invite|reset)\/\S+/)[0];

// Confirm the emailed link, set a password, sign in and (for staff) set up 2-step
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

async function activeClub(name, email) {
  const clubId = await app.clubs.createClub({ name, sport: 'Football', status: 'active' });
  const { url } = await app.auth.inviteUser({ clubId, email, name: `${name} Coach`, role: 'coach' });
  return { clubId, coach: await finishSetup(url, email) };
}

let preview;
test('a new club signs up: email confirmation first, then a look-only preview with sample data', async () => {
  const anon = browser(app.base);
  const platform = await anon.get('/api/platform');
  assert.equal(platform.status, 200);
  assert.ok(platform.json.sports.includes('Football'));

  const r = await anon.post('/api/signup', { clubName: 'Riverside Rugby', sport: 'Rugby', name: 'Dana Fox', email: 'dana@riverside.test' });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.message, /Check your email/);
  const mail = await lastMailTo('dana@riverside.test');
  assert.match(mail.subject, /Confirm your email/);
  assert.equal((await anon.post('/api/auth/login', { email: 'dana@riverside.test', password: PASSWORD })).status, 401, 'no access before confirming the email');

  preview = await finishSetup(linkIn(mail), 'dana@riverside.test');
  const boot = await preview.get('/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.json.sample, true);
  assert.equal(boot.json.me.club.name, 'Riverside Rugby');
  assert.equal(boot.json.me.club.status, 'preview');
  assert.equal(boot.json.me.club.canUse, false);
  assert.equal(boot.json.me.club.branding.group, 'Team', 'rugby clubs start with "Team"');
  assert.equal(boot.json.me.club.branding.member, 'Player');
  assert.ok(boot.json.athletes.length > 3, 'sample members to look at');
});

test('previewing clubs cannot use the app until they subscribe', async () => {
  const blocked = [
    await preview.post('/api/athletes', { name: 'Real Kid', squadId: 1 }),
    await preview.post('/api/squads', squadBody(0)),
    await preview.post('/api/users/invite', { email: 'parent@riverside.test', role: 'parent' }),
    await preview.post('/api/transactions', { type: 'Expense', description: 'x', amount: 5 }),
    await preview.put('/api/settings', { financialYearStart: '07-01' }),
  ];
  for (const r of blocked) {
    assert.equal(r.status, 402, r.text);
    assert.match(r.json.error, /Subscribe|subscribe/);
  }
});

test('signing up with an email that already has an account reveals nothing', async () => {
  const anon = browser(app.base);
  const r = await anon.post('/api/signup', { clubName: 'Copycat FC', sport: 'Football', name: 'X', email: 'dana@riverside.test' });
  assert.equal(r.status, 200);
  assert.match(r.json.message, /Check your email/);
  assert.match((await lastMailTo('dana@riverside.test')).subject, /already have/);
  assert.equal((await app.one("select count(*)::int as n from app.clubs where name = 'Copycat FC'")).n, 0);
});

test('branding: coaches can rename and restyle their club, with safe checks', async () => {
  const ok = await preview.put('/api/club', { name: 'Riverside Rugby Club', sport: 'Rugby', group: 'Grade', member: 'Player', colour: 'teal' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.club.name, 'Riverside Rugby Club');
  assert.equal(ok.json.club.branding.groups, 'Grades', 'plural made automatically');
  assert.equal(ok.json.club.branding.colour, 'teal');

  assert.equal((await preview.put('/api/club', { colour: '#ff0000;background:url(x)' })).status, 400, 'only listed colours');
  assert.equal((await preview.put('/api/club', { group: '<script>' })).status, 400, 'words are letters only');
  const svg = `data:image/png;base64,${Buffer.from('<svg onload=alert(1)></svg>').toString('base64')}`;
  assert.equal((await preview.put('/api/club', { logo: svg })).status, 400, 'a file pretending to be PNG is refused');
  assert.equal((await preview.put('/api/club', { logo: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400, 'SVG is refused');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const logo = await preview.put('/api/club', { logo: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(logo.status, 200, logo.text);
  assert.match(logo.json.club.branding.logo, /^data:image\/png;base64,/);
  const big = Buffer.concat([png, Buffer.alloc(250 * 1024)]);
  const bigRes = await preview.put('/api/club', { logo: `data:image/png;base64,${big.toString('base64')}` });
  assert.equal(bigRes.status, 400, 'logos over 200 KB are refused with a clear message');
  assert.match(bigRes.json.error, /under 200 KB/);
  const huge = Buffer.concat([png, Buffer.alloc(600 * 1024)]);
  assert.equal((await preview.put('/api/club', { logo: `data:image/png;base64,${huge.toString('base64')}` })).status, 413, 'oversized requests get a "too large" reply');
  assert.equal((await preview.post('/api/transactions', { description: 'x'.repeat(70 * 1024) })).status, 413, 'other routes keep the small limit');
});

test('subscribing: checkout for the platform, then Stripe confirms and the club unlocks', async () => {
  const r = await preview.post('/api/club/subscribe');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.url, 'https://checkout.stripe.test/session');
  const call = stripe.calls.findLast((c) => c.name === 'checkout.sessions.create');
  const params = call.args[0];
  assert.equal(params.mode, 'subscription');
  assert.equal(params.metadata.kind, 'platform');
  assert.equal(call.args[1], undefined, 'platform subscriptions are on the platform account, not a club account');
  const clubId = Number(params.metadata.clubId);

  await app.clubs.handlePlatformEvent({ type: 'checkout.session.completed', data: { object: { metadata: params.metadata, subscription: 'sub_1', customer: 'cus_platform' } } });
  assert.equal((await app.auth.getClub(clubId)).status, 'active');
  const boot = await preview.get('/api/bootstrap');
  assert.equal(boot.json.sample, false, 'real (empty) club data once subscribed');
  assert.deepEqual(boot.json.athletes, []);
  assert.equal((await preview.post('/api/squads', squadBody(0))).status, 200, 'now they can use it');

  await app.clubs.handlePlatformEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', metadata: { kind: 'platform', clubId: String(clubId) } } } });
  assert.equal((await app.auth.getClub(clubId)).status, 'canceled');
  const locked = await preview.get('/api/bootstrap');
  assert.equal(locked.json.sample, false, 'a lapsed club still sees its own data');
  assert.equal((await preview.post('/api/squads', squadBody(1))).status, 402, '…but read-only');
});

test('one club can never see or touch another club', async () => {
  const a = await activeClub('Alpha FC', 'coach@alpha.test');
  const b = await activeClub('Bravo FC', 'coach@bravo.test');
  const squadA = (await a.coach.post('/api/squads', squadBody(0))).json;
  const kidA = (await a.coach.post('/api/athletes', { name: 'Alpha Kid', squadId: squadA.id, email: 'fam@alpha.test', medication: 'Secret meds' })).json.athlete;
  const invite = await a.coach.post('/api/users/invite', { email: 'fam@alpha.test', role: 'parent', athleteIds: [kidA.id] });
  assert.equal(invite.status, 200);

  const bootB = await b.coach.get('/api/bootstrap');
  assert.deepEqual(bootB.json.athletes, []);
  assert.deepEqual(bootB.json.squads, []);
  assert.ok(!JSON.stringify(bootB.json).includes('Secret meds'));
  assert.equal((await b.coach.put(`/api/athletes/${kidA.id}`, { name: 'Stolen' })).status, 404);
  assert.equal((await b.coach.put(`/api/athletes/${kidA.id}/regular`, { seriesIds: [] })).status, 404);
  assert.equal((await b.coach.put('/api/rsvps', { athleteId: kidA.id, seriesId: 'dev-mon', date: '2099-01-05', attending: true })).status, 404);
  assert.equal((await b.coach.put('/api/attendance', { athleteId: kidA.id, seriesId: 'dev-mon', date: '2099-01-05', present: true })).status, 404);
  assert.equal((await b.coach.put(`/api/squads/${squadA.id}`, squadBody(1))).status, 404);
  assert.equal((await b.coach.del(`/api/squads/${squadA.id}`)).status, 404);
  assert.equal((await b.coach.post('/api/athletes', { name: 'Sneaky', squadId: squadA.id })).status, 400, "can't add to another club's group");
  assert.equal((await b.coach.post('/api/users/invite', { email: 'x@bravo.test', role: 'parent', athleteIds: [kidA.id] })).status, 400, "can't link another club's athlete");
  const usersB = (await b.coach.get('/api/users')).json;
  assert.ok(usersB.every((u) => !u.email.endsWith('@alpha.test')));
  const parentId = (await app.one("select id from app.profiles where email = 'fam@alpha.test'")).id;
  for (const path of [`/api/users/${parentId}/reset-link`, `/api/users/${parentId}/status`, `/api/users/${parentId}/reset-2fa`]) {
    assert.equal((await b.coach.post(path, { status: 'disabled' })).status, 404, path);
  }
  assert.equal((await b.coach.put(`/api/users/${parentId}/name`, { name: 'x' })).status, 404);
  assert.equal((await b.coach.post('/api/users/invite', { email: 'fam@alpha.test', role: 'parent' })).status, 409, 'one email, one club');
  const auditB = (await b.coach.get('/api/audit')).json;
  assert.ok(auditB.every((e) => !String(e.userEmail || '').endsWith('@alpha.test')), 'activity logs are per club');
});

let owner;
test('the platform owner manages clubs but never sees their members', async () => {
  const { url } = await app.auth.inviteUser({ clubId: null, email: 'owner@platform.test', name: 'Owner', role: 'owner' });
  owner = await finishSetup(url, 'owner@platform.test');
  const list = await owner.get('/api/owner/clubs');
  assert.equal(list.status, 200);
  const alpha = list.json.clubs.find((c) => c.name === 'Alpha FC');
  assert.equal(alpha.athletes, 1);
  assert.ok(!JSON.stringify(list.json).includes('Alpha Kid'), 'no member names');
  assert.equal((await owner.get('/api/bootstrap')).status, 403, 'owner has no club data');

  const created = await owner.post('/api/owner/clubs', { clubName: 'Gift Gymnastics', sport: 'Gymnastics', name: 'Gina', email: 'gina@gift.test' });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.club.status, 'comped', 'clubs the owner sets up are free by default');
  assert.equal(created.json.inviteUrl, null, 'the owner is not shown the coach\'s link once it has been emailed');
  const gina = await finishSetup(await emailedLink(app, 'gina@gift.test'), 'gina@gift.test');
  const boot = await gina.get('/api/bootstrap');
  assert.equal(boot.json.me.club.branding.group, 'Class');
  assert.equal(boot.json.me.club.branding.member, 'Gymnast');
  assert.equal((await gina.post('/api/squads', squadBody(0))).status, 200, 'free clubs can use everything');

  const ginaClub = created.json.club.id;
  assert.equal((await owner.post(`/api/owner/clubs/${ginaClub}/access`, { access: 'suspend' })).json.status, 'suspended');
  assert.equal((await gina.post('/api/squads', squadBody(1))).status, 402);
  assert.equal((await gina.post('/api/club/subscribe')).status, 403, "a switched-off club can't just resubscribe");
  assert.equal((await owner.post(`/api/owner/clubs/${ginaClub}/access`, { access: 'normal' })).json.status, 'preview', 'back to its subscription status (never paid)');
  assert.equal((await owner.post(`/api/owner/clubs/${ginaClub}/access`, { access: 'free' })).json.status, 'comped');

  // Stripe events don't override the owner's free access
  await app.clubs.handlePlatformEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_x', status: 'canceled', metadata: { kind: 'platform', clubId: String(ginaClub) } } } });
  assert.equal((await app.auth.getClub(ginaClub)).status, 'comped');

  assert.equal((await gina.get('/api/owner/clubs')).status, 403, 'coaches cannot use the owner console');
  assert.equal((await gina.post(`/api/owner/clubs/${ginaClub}/access`, { access: 'free' })).status, 403);
});

test('club fees: a club connects its own Stripe account and parent payments go to it', async () => {
  const { clubId, coach } = await activeClub('Payments Club', 'coach@pay.test');
  const squad = (await coach.post('/api/squads', squadBody(0))).json;
  const kid = (await coach.post('/api/athletes', { name: 'Pay Kid', squadId: squad.id, email: 'fam@pay.test' })).json.athlete;
  const invite = await coach.post('/api/users/invite', { email: 'fam@pay.test', role: 'parent', athleteIds: [kid.id] });
  const parent = await finishSetup(await emailedLink(app, 'fam@pay.test'), 'fam@pay.test');
  const offer = (await coach.post(`/api/athletes/${kid.id}/passes`, { sessions: 10, price: 100, paidBy: 'offer' })).json.pass;

  assert.equal((await parent.post('/api/checkout/pass', { passId: offer.id })).status, 503, 'no payments until the club connects Stripe');
  const connect = await coach.post('/api/club/connect');
  assert.equal(connect.json.url, 'https://connect.stripe.test/onboarding');
  const created = stripe.calls.findLast((c) => c.name === 'accounts.create').args[0];
  assert.deepEqual(created.controller.fees, { payer: 'account' }, 'the club pays Stripe\'s fees itself, so the platform has no Connect fees');
  assert.deepEqual(created.controller.losses, { payments: 'stripe' }, 'Stripe, not the platform, carries the risk of losses');
  assert.equal(created.type, undefined);
  const refreshed = await coach.post('/api/club/connect/refresh');
  assert.equal(refreshed.json.club.payments.connected, true);

  const pay = await parent.post('/api/checkout/pass', { passId: offer.id });
  assert.equal(pay.status, 200, pay.text);
  const call = stripe.calls.findLast((c) => c.name === 'checkout.sessions.create');
  assert.deepEqual(call.args[1], { stripeAccount: 'acct_club' }, "the parent's payment is created on the club's own account");
  assert.equal((await app.auth.getClub(clubId)).billing.connectAccountId, 'acct_club');
});

test('when Stripe refuses something, the person sees Stripe\'s reason instead of "something went wrong"', async () => {
  const { coach } = await activeClub('Refused Club', 'coach@refused.test');
  const original = stripe.accounts.create;
  stripe.accounts.create = async () => { const e = new Error('You must complete your platform profile to use Connect.'); e.type = 'StripeInvalidRequestError'; throw e; };
  try {
    const r = await coach.post('/api/club/connect');
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'Stripe said: You must complete your platform profile to use Connect.');
  } finally { stripe.accounts.create = original; }
});
