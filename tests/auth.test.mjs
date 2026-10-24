import { APP_URL, startServer, browser, tokenFromUrl, totpNow, PASSWORD, SEED_SQUADS, emailedLink, lastMail } from './helpers.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
let clubId;
before(async () => {
  app = await startServer();
  clubId = await app.clubs.createClub({ name: 'Test Swim Club', sport: 'Swimming', status: 'active' });
});
after(async () => { await app.close(); });

// Invite → set password → sign in → set up 2-step. Returns a signed-in staff browser.
async function signUpStaff(email, role = 'coach', inviter = null) {
  let url;
  if (inviter) {
    const r = await inviter.post('/api/users/invite', { email, name: `Test ${role}`, role });
    assert.equal(r.status, 200, r.text);
    url = await emailedLink(app, email);
  } else {
    url = (await app.auth.inviteUser({ clubId, email, name: 'Head Coach', role })).url;
  }
  const b = browser(app.base);
  const token = tokenFromUrl(url);
  assert.equal((await b.post('/api/auth/token', { token })).json.kind, 'invite');
  assert.equal((await b.post('/api/auth/accept', { token, password: PASSWORD })).status, 200);
  const login = await b.post('/api/auth/login', { email, password: PASSWORD });
  assert.equal(login.json.stage, 'mfa_setup', 'staff must set up 2-step');
  assert.equal((await b.get('/api/bootstrap')).status, 401, 'no data before 2-step is set up');
  const setup = await b.post('/api/auth/2fa/setup');
  assert.match(setup.json.uri, /^otpauth:\/\/totp\//);
  const confirm = await b.post('/api/auth/2fa/confirm', { code: await totpNow(setup.json.secret) });
  assert.equal(confirm.status, 200, confirm.text);
  assert.equal(confirm.json.stage, 'full');
  assert.equal(confirm.json.recoveryCodes.length, 10);
  return { b, secret: setup.json.secret, recoveryCodes: confirm.json.recoveryCodes };
}

async function signUpParent(coach, email, athleteIds) {
  const inv = await coach.post('/api/users/invite', { email, name: 'Test Parent', role: 'parent', athleteIds });
  assert.equal(inv.status, 200, inv.text);
  const b = browser(app.base);
  assert.equal((await b.post('/api/auth/accept', { token: tokenFromUrl(await emailedLink(app, email)), password: PASSWORD })).status, 200);
  const login = await b.post('/api/auth/login', { email, password: PASSWORD });
  assert.equal(login.json.stage, 'full', 'parents sign straight in unless they turn 2-step on');
  return { b, userId: inv.json.userId };
}

let coach;
let athleteA;
let athleteB;

test('coach sign-up requires two-step verification before any data is shown', async () => {
  coach = await signUpStaff('coach@club.test');
  const boot = await coach.b.get('/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.json.me.role, 'coach');
  assert.equal(boot.json.me.club.name, 'Test Swim Club');
  assert.deepEqual(boot.json.squads, [], 'a new club starts with no groups');
});

test('session cookie is HttpOnly, SameSite=Strict and stored hashed', async () => {
  const b = browser(app.base);
  const login = await b.post('/api/auth/login', { email: 'coach@club.test', password: PASSWORD });
  const cookie = login.setCookie.find((c) => c.startsWith('club_session='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  const value = cookie.split(';')[0].split('=')[1];
  assert.ok(value.length >= 40);
  assert.equal(await app.one('select 1 as x from app.sessions where id_hash = $1', value), undefined, 'raw session id is not in the database');
  assert.ok(!(await app.query('select sb_tokens_enc from app.sessions')).some((r) => /^at\./.test(r.sb_tokens_enc || '')), 'Supabase tokens are stored encrypted');
  await b.post('/api/auth/logout');
});

test('second sign-in asks for a code, refuses a wrong code, accepts the right one', async () => {
  await coach.b.post('/api/auth/logout');
  assert.equal((await coach.b.get('/api/bootstrap')).status, 401);
  const login = await coach.b.post('/api/auth/login', { email: 'coach@club.test', password: PASSWORD });
  assert.equal(login.json.stage, 'mfa');
  assert.equal((await coach.b.get('/api/bootstrap')).status, 401, 'password alone is not enough');
  const wrong = await coach.b.post('/api/auth/2fa/verify', { code: (Number(await totpNow(coach.secret)) + 1).toString().padStart(6, '0').slice(-6) });
  assert.equal(wrong.status, 401, 'a wrong code is refused');
  const ok = await coach.b.post('/api/auth/2fa/verify', { code: await totpNow(coach.secret) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await coach.b.get('/api/bootstrap')).status, 200);
});

test('too many wrong codes ends the sign-in attempt', async () => {
  const other = await signUpStaff('coach2@club.test');
  await other.b.post('/api/auth/logout');
  await other.b.post('/api/auth/login', { email: 'coach2@club.test', password: PASSWORD });
  let last;
  for (let i = 0; i < 5; i++) last = await other.b.post('/api/auth/2fa/verify', { code: '000000' });
  assert.equal(last.status, 401);
  assert.equal(last.json.signedOut, true);
  const after5 = await other.b.post('/api/auth/2fa/verify', { code: await totpNow(other.secret) });
  assert.equal(after5.status, 401, 'must start again with the password');
});

test('a recovery code works once, and staff must then add their new phone', async () => {
  const b = browser(app.base);
  await b.post('/api/auth/login', { email: 'coach@club.test', password: PASSWORD });
  const code = coach.recoveryCodes[0];
  const first = await b.post('/api/auth/2fa/verify', { code, recovery: true });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.stage, 'mfa_setup', 'the lost authenticator is removed; staff set up a new one before getting in');
  assert.equal((await b.get('/api/bootstrap')).status, 401, 'no data until the new phone is added');
  const setup = await b.post('/api/auth/2fa/setup');
  const confirm = await b.post('/api/auth/2fa/confirm', { code: await totpNow(setup.json.secret) });
  assert.equal(confirm.json.stage, 'full');
  assert.equal(confirm.json.recoveryCodes.length, 10, 'fresh recovery codes');
  coach.secret = setup.json.secret;
  coach.recoveryCodes = confirm.json.recoveryCodes;
  await b.post('/api/auth/logout');
  await b.post('/api/auth/login', { email: 'coach@club.test', password: PASSWORD });
  assert.equal((await b.post('/api/auth/2fa/verify', { code, recovery: true })).status, 401, 'old codes no longer work');
  assert.equal((await b.post('/api/auth/2fa/verify', { code: await totpNow(coach.secret) })).status, 200, 'the new phone works');
});

let squad1;
let squad2;
test('coach adds athletes; medical details are encrypted in the database', async () => {
  const { id: _a, ...dev } = SEED_SQUADS[0];
  const { id: _b, ...bronze } = SEED_SQUADS[1];
  squad1 = (await coach.b.post('/api/squads', dev)).json;
  squad2 = (await coach.b.post('/api/squads', bronze)).json;
  assert.ok(squad1.id && squad2.id);
  const a = await coach.b.post('/api/athletes', { name: 'Test Athlete A', squadId: squad1.id, frequency: 'weekly', parent: 'Parent A', email: 'parent.a@club.test', phone: '021 555 0001', address: '1 Test St', emergency: 'Contact A', allergies: 'Peanuts', medication: 'EpiPen' });
  assert.equal(a.status, 200, a.text);
  athleteA = a.json.athlete;
  const b2 = await coach.b.post('/api/athletes', { name: 'Test Athlete B', squadId: squad2.id, frequency: 'monthly', parent: 'Parent B', email: 'parent.b@club.test', phone: '021 555 0002', address: '2 Test St', emergency: 'Contact B', allergies: 'None', medication: 'Inhaler' });
  athleteB = b2.json.athlete;
  assert.equal(athleteA.medication, 'EpiPen', 'coach sees medical details');
  const raw = await app.one('select data::text as data, private_enc from app.athletes where id = $1', athleteA.id);
  assert.ok(!raw.private_enc.includes('EpiPen') && !raw.data.includes('EpiPen'));
});

let parent;
test('a parent only ever sees and changes their own child', async () => {
  parent = await signUpParent(coach.b, 'parent.a@club.test', [athleteA.id]);
  const boot = await parent.b.get('/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.deepEqual(boot.json.athletes.map((x) => x.id), [athleteA.id]);
  assert.equal(boot.json.athletes[0].medication, 'EpiPen', 'parents see their own child\'s medical details');
  assert.deepEqual(boot.json.transactions, []);
  assert.equal(boot.json.settings.smsTemplate, undefined);

  assert.equal((await parent.b.put(`/api/athletes/${athleteA.id}/profile`, { phone: '021 555 0999' })).status, 200);
  assert.equal((await parent.b.put(`/api/athletes/${athleteB.id}/profile`, { phone: '021 555 0999' })).status, 404, 'other child is invisible');
  assert.equal((await parent.b.put('/api/rsvps', { athleteId: athleteB.id, seriesId: 'brz-tue', date: '2099-01-06', attending: true })).status, 404);
  assert.equal((await parent.b.put(`/api/athletes/${athleteA.id}`, { name: 'Renamed' })).status, 403, 'parents cannot use staff edits');
  assert.equal((await parent.b.post(`/api/athletes/${athleteA.id}/plan`, { frequency: 'monthly', squadId: squad2.id })).json.athlete.squadId, squad1.id, 'parents cannot move squads');
  assert.equal((await parent.b.post('/api/squads', { name: 'X' })).status, 403);
  assert.equal((await parent.b.get('/api/users')).status, 403);
  assert.equal((await parent.b.put('/api/attendance', { athleteId: athleteA.id, seriesId: 'dev-mon', date: '2099-01-05', present: true })).status, 403);
  const regular = await parent.b.put(`/api/athletes/${athleteA.id}/regular`, { seriesIds: ['dev-mon'] });
  assert.equal(regular.status, 200, regular.text);
  assert.equal(regular.json.regularCounts['dev-mon'], 1);
  assert.equal((await parent.b.put(`/api/athletes/${athleteA.id}/regular`, { seriesIds: ['brz-tue'] })).status, 400, 'only their own squad\'s sessions');
});

let treasurer;
test('the treasurer sees billing and contact details but no medical information', async () => {
  treasurer = await signUpStaff('treasurer@club.test', 'treasurer', coach.b);
  const boot = await treasurer.b.get('/api/bootstrap');
  assert.equal(boot.status, 200);
  const a = boot.json.athletes.find((x) => x.id === athleteA.id);
  assert.equal(a.email, 'parent.a@club.test');
  assert.equal(a.medication, undefined);
  assert.equal(a.allergies, undefined);
  assert.equal(a.emergency, undefined);
  assert.equal((await treasurer.b.post('/api/users/invite', { email: 'x@club.test', role: 'coach' })).status, 403, 'only coaches invite staff');
  assert.equal((await treasurer.b.put(`/api/squads/${squad1.id}`, { name: 'Hacked', weekly: 1, fortnightly: 1, monthly: 1, pass: 1 })).status, 403);
  const tx = await treasurer.b.post('/api/transactions', { type: 'Expense', description: 'Lane hire', amount: 450, gst: true });
  assert.equal(tx.status, 200, tx.text);
  const edit = await treasurer.b.put(`/api/athletes/${athleteA.id}`, { medication: 'changed', phone: '021 555 0555' });
  assert.equal(edit.status, 200);
  assert.equal((await coach.b.get('/api/bootstrap')).json.athletes.find((x) => x.id === athleteA.id).medication, 'EpiPen', 'treasurer cannot change medical details');
  const users = await treasurer.b.get('/api/users');
  assert.ok(users.json.every((u) => u.role === 'parent'), 'treasurer only sees parent accounts');
});

test('wrong email and wrong password give the same answer', async () => {
  const b = browser(app.base);
  const noAccount = await b.post('/api/auth/login', { email: 'nobody@club.test', password: PASSWORD });
  const wrongPw = await b.post('/api/auth/login', { email: 'parent.a@club.test', password: 'wrong password entirely' });
  assert.equal(noAccount.status, 401);
  assert.equal(wrongPw.status, 401);
  assert.equal(noAccount.json.error, wrongPw.json.error);
  await app.query('update app.profiles set failed_logins = 0 where email = $1', 'parent.a@club.test');
});

test('changes from other websites are blocked', async () => {
  const body = { type: 'Expense', description: 'x', amount: 1 };
  assert.equal((await coach.b.post('/api/transactions', body, { headers: { 'X-Club-Request': '0' } })).status, 403);
  assert.equal((await coach.b.post('/api/transactions', body, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const noJson = await fetch(`${app.base}/api/auth/login`, { method: 'POST', headers: { 'X-Club-Request': '1', Origin: APP_URL, 'Content-Type': 'text/plain' }, body: '{"email":"a"}' });
  assert.equal(noJson.status, 415);
});

test('security headers are sent with every API reply', async () => {
  const r = await coach.b.get('/api/auth/session');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('forgot password: same reply for any email; reset link works once and signs out other devices', async () => {
  const anon = browser(app.base);
  const unknown = await anon.post('/api/auth/forgot', { email: 'nobody@club.test' });
  const known = await anon.post('/api/auth/forgot', { email: 'parent.a@club.test' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.message, known.json.message);
  const mail = await lastMail(app, 'parent.a@club.test', /Reset/);
  const link = mail.text.match(/http\S+#\/reset\/\S+/)[0];
  const token = tokenFromUrl(link);

  assert.equal((await anon.post('/api/auth/accept', { token, password: 'short' })).status, 400, 'weak password refused');
  assert.equal((await anon.post('/api/auth/accept', { token, password: 'a brand new passphrase' })).status, 200);
  assert.equal((await anon.post('/api/auth/accept', { token, password: 'another new passphrase' })).status, 400, 'link only works once');
  assert.equal((await parent.b.get('/api/bootstrap')).status, 401, 'existing sessions are signed out');
  assert.equal((await anon.post('/api/auth/login', { email: 'parent.a@club.test', password: PASSWORD })).status, 401);
  assert.equal((await parent.b.post('/api/auth/login', { email: 'parent.a@club.test', password: 'a brand new passphrase' })).json.stage, 'full');
});

test('expired invite links are refused', async () => {
  const inv = await coach.b.post('/api/users/invite', { email: 'late@club.test', role: 'parent', athleteIds: [athleteB.id] });
  await app.query("update app.tokens set expires_at = now() - interval '1 second' where kind = 'invite' and user_id = $1", inv.json.userId);
  const r = await browser(app.base).post('/api/auth/accept', { token: tokenFromUrl(await emailedLink(app, 'late@club.test')), password: PASSWORD });
  assert.equal(r.status, 400);
});

test('changing password signs out other devices', async () => {
  const other = browser(app.base);
  await other.post('/api/auth/login', { email: 'parent.a@club.test', password: 'a brand new passphrase' });
  assert.equal((await other.get('/api/bootstrap')).status, 200);
  const change = await parent.b.post('/api/auth/password', { current: 'a brand new passphrase', next: 'yet another passphrase' });
  assert.equal(change.status, 200, change.text);
  assert.equal((await other.get('/api/bootstrap')).status, 401);
  assert.equal((await parent.b.get('/api/bootstrap')).status, 200, 'this device stays signed in');
});

test('switching an account off signs it out everywhere', async () => {
  const r = await coach.b.post(`/api/users/${parent.userId}/status`, { status: 'disabled' });
  assert.equal(r.status, 200);
  assert.equal((await parent.b.get('/api/bootstrap')).status, 401);
  assert.equal((await browser(app.base).post('/api/auth/login', { email: 'parent.a@club.test', password: 'yet another passphrase' })).status, 401);
  assert.equal((await coach.b.post(`/api/users/${(await app.one("select id from app.profiles where email = 'coach@club.test'")).id}/status`, { status: 'disabled' })).status, 400, 'cannot switch yourself off');
});

test('a coach can reset a lost authenticator, forcing new 2-step setup', async () => {
  const id = (await app.one("select id from app.profiles where email = 'treasurer@club.test'")).id;
  assert.equal((await coach.b.post(`/api/users/${id}/reset-2fa`)).status, 200);
  assert.equal((await treasurer.b.get('/api/bootstrap')).status, 401, 'signed out');
  const login = await treasurer.b.post('/api/auth/login', { email: 'treasurer@club.test', password: PASSWORD });
  assert.equal(login.json.stage, 'mfa_setup');
});

test('the audit log records sign-ins and admin actions', async () => {
  const log = await coach.b.get('/api/audit');
  const actions = new Set(log.json.map((e) => e.action));
  for (const a of ['login_success', 'login_failed', '2fa_enabled', 'invite_sent', 'password_reset', 'account_disabled', '2fa_reset_by_coach']) {
    assert.ok(actions.has(a), `audit has ${a}`);
  }
  assert.equal((await treasurer.b.get('/api/audit')).status, 401);
});

test('people can change their own name; staff can fix names', async () => {
  const mine = await coach.b.post('/api/auth/profile', { name: '  Jane   Smith\u0007 ' });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json.user.name, 'Jane Smith', 'trimmed, single-spaced, control characters removed');
  assert.equal((await coach.b.post('/api/auth/profile', { name: '   ' })).status, 400);

  const fam = await signUpParent(coach.b, 'two.kids@club.test', [athleteA.id, athleteB.id]);
  const boot = await fam.b.get('/api/bootstrap');
  assert.deepEqual(boot.json.athletes.map((a) => a.id).sort(), [athleteA.id, athleteB.id].sort(), 'one parent, two athletes');
  assert.equal((await fam.b.post('/api/auth/profile', { name: 'Pat Parent' })).json.user.name, 'Pat Parent');
  const coachId = (await app.one("select id from app.profiles where email = 'coach@club.test'")).id;
  assert.equal((await fam.b.put(`/api/users/${coachId}/name`, { name: 'Hacked' })).status, 403, 'parents cannot rename others');
  const renamed = await coach.b.put(`/api/users/${fam.userId}/name`, { name: 'Patricia Parent' });
  assert.equal(renamed.status, 200);
  assert.equal((await fam.b.get('/api/auth/session')).json.user.name, 'Patricia Parent');
});
