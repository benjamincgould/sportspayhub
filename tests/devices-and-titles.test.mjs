// "Remember this device for 8 hours" at the two-step step, and staff titles (including the owner
// adding a treasurer or another coach to a club).
import { startServer, browser, tokenFromUrl, totpNow, PASSWORD, emailedLink } from './helpers.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
let clubId;
let coach;
let coachSecret;
let owner;
before(async () => {
  app = await startServer({});
  clubId = await app.clubs.createClub({ name: 'Device Club', sport: 'Netball', status: 'active' });
  ({ b: coach, secret: coachSecret } = await finishSetup((await app.auth.inviteUser({ clubId, email: 'coach@device.test', role: 'coach' })).url, 'coach@device.test'));
  ({ b: owner } = await finishSetup((await app.auth.inviteUser({ email: 'owner@device.test', role: 'owner' })).url, 'owner@device.test'));
});
after(async () => { await app.close(); });

async function finishSetup(url, email) {
  const b = browser(app.base);
  assert.equal((await b.post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD })).status, 200);
  const login = await b.post('/api/auth/login', { email, password: PASSWORD });
  assert.equal(login.json.stage, 'mfa_setup');
  const setup = await b.post('/api/auth/2fa/setup');
  assert.equal((await b.post('/api/auth/2fa/confirm', { code: await totpNow(setup.json.secret) })).status, 200);
  return { b, secret: setup.json.secret };
}
const sessionKey = (b) => Object.keys(b.jar).find((k) => /club_session/.test(k));
const deviceKey = (b) => Object.keys(b.jar).find((k) => /club_device/.test(k));
const login = (b, email = 'coach@device.test', password = PASSWORD) => b.post('/api/auth/login', { email, password });
// Leaving the app idle: the session ends, the remembered device stays
const goIdle = (b) => { delete b.jar[sessionKey(b)]; };

test('without ticking the box, the code is asked for every sign-in', async () => {
  const b = browser(app.base);
  assert.equal((await login(b)).json.stage, 'mfa');
  const ok = await b.post('/api/auth/2fa/verify', { code: await totpNow(coachSecret) });
  assert.equal(ok.json.stage, 'full');
  assert.equal(deviceKey(b), undefined, 'nothing remembered');
  goIdle(b);
  assert.equal((await login(b)).json.stage, 'mfa');
});

let laptop;
test('ticking "remember this device" skips the code (not the password) for 8 hours on that device only', async () => {
  laptop = browser(app.base);
  await login(laptop);
  const ok = await laptop.post('/api/auth/2fa/verify', { code: await totpNow(coachSecret), remember: true });
  assert.equal(ok.json.stage, 'full', ok.text);
  const set = ok.setCookie.find((c) => /club_device=/.test(c));
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Max-Age=28800/, '8 hours');

  goIdle(laptop);
  const again = await login(laptop);
  assert.equal(again.json.stage, 'full', 'no code needed');
  assert.equal(again.json.rememberedDevice, true);
  assert.equal((await laptop.get('/api/bootstrap')).status, 200);

  goIdle(laptop);
  assert.equal((await login(laptop, 'coach@device.test', 'wrong password')).status, 401, 'the password is still needed');

  const phone = browser(app.base);
  assert.equal((await login(phone)).json.stage, 'mfa', 'another device still needs the code');

  // The remembered device only works for the person who ticked it
  const { b: other } = await finishSetup((await app.auth.inviteUser({ clubId, email: 'coach2@device.test', role: 'coach' })).url, 'coach2@device.test');
  await other.post('/api/auth/logout');
  other.jar[deviceKey(laptop)] = laptop.jar[deviceKey(laptop)];
  assert.equal((await login(other, 'coach2@device.test')).json.stage, 'mfa');
});

test('it stops after 8 hours, on signing out, and when signed out everywhere', async () => {
  goIdle(laptop);
  await app.query("update app.trusted_devices set expires_at = now() - interval '1 minute'");
  assert.equal((await login(laptop)).json.stage, 'mfa', 'expired');
  await laptop.post('/api/auth/2fa/verify', { code: await totpNow(coachSecret), remember: true });

  await laptop.post('/api/auth/logout');
  assert.equal(deviceKey(laptop), undefined, 'signing out forgets the device');
  assert.equal((await login(laptop)).json.stage, 'mfa');
  await laptop.post('/api/auth/2fa/verify', { code: await totpNow(coachSecret), remember: true });

  const user = await app.one("select id from app.profiles where email = 'coach@device.test'");
  await app.auth.revokeAllSessions(user.id); // password changed, switched off, or "sign out everywhere"
  assert.equal((await app.one('select count(*)::int as n from app.trusted_devices where user_id = $1', user.id)).n, 0);
  assert.equal((await login(laptop)).json.stage, 'mfa');
  coach = laptop;
  await laptop.post('/api/auth/2fa/verify', { code: await totpNow(coachSecret) });
});

test('the owner adds a treasurer to a club with their own title; they get an email to set up', async () => {
  assert.equal((await coach.post(`/api/owner/clubs/${clubId}/members`, { email: 'x@device.test', role: 'treasurer' })).status, 403, 'owner only');
  assert.equal((await owner.post(`/api/owner/clubs/${clubId}/members`, { email: 'nope', role: 'treasurer' })).status, 400);
  assert.equal((await owner.post(`/api/owner/clubs/${clubId}/members`, { email: 'p@device.test', role: 'parent' })).status, 400, 'staff only');
  assert.equal((await owner.post('/api/owner/clubs/999999/members', { email: 't@device.test', role: 'treasurer' })).status, 404);
  const r = await owner.post(`/api/owner/clubs/${clubId}/members`, { email: 'tess@device.test', name: 'Tess', role: 'treasurer', title: 'Club Administrator' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.emailed, true);
  const { b: tess } = await finishSetup(await emailedLink(app, 'tess@device.test'), 'tess@device.test');
  const me = (await tess.get('/api/bootstrap')).json.me;
  assert.equal(me.role, 'treasurer');
  assert.equal(me.title, 'Club Administrator');
  assert.equal(me.club.id, clubId);
  const team = (await coach.get('/api/users')).json;
  assert.equal(team.find((u) => u.email === 'tess@device.test').title, 'Club Administrator', 'the coach sees the title');
});

test('coaches can change a staff title; nobody else can, and parents have none', async () => {
  const team = (await coach.get('/api/users')).json;
  const tessId = team.find((u) => u.email === 'tess@device.test').id;
  const r = await coach.put(`/api/users/${tessId}/title`, { title: 'Finance Manager' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await coach.get('/api/users')).json.find((u) => u.id === tessId).title, 'Finance Manager');
  assert.equal((await coach.put(`/api/users/${tessId}/title`, { title: '' })).json.title, null, 'blank = the role name');
  const invite = await coach.post('/api/users/invite', { email: 'sam@device.test', role: 'coach', title: 'Head Coach' });
  assert.equal(invite.status, 200, invite.text);
  assert.equal((await coach.get('/api/users')).json.find((u) => u.email === 'sam@device.test').title, 'Head Coach');
  // A coach of another club can't touch these people
  const other = await app.clubs.createClub({ name: 'Other Club', sport: 'Netball', status: 'active' });
  const { b: stranger } = await finishSetup((await app.auth.inviteUser({ clubId: other, email: 'x@other.test', role: 'coach' })).url, 'x@other.test');
  assert.equal((await stranger.put(`/api/users/${tessId}/title`, { title: 'Hacked' })).status, 404);
});

test('coaches change access between coach and treasurer, and delete people; a club always keeps a coach', async () => {
  const team = (await coach.get('/api/users')).json;
  const me = team.find((u) => u.email === 'coach@device.test');
  const tess = team.find((u) => u.email === 'tess@device.test');
  assert.equal((await coach.put(`/api/users/${me.id}/role`, { role: 'treasurer' })).status, 400, 'not your own access');
  assert.equal((await coach.put(`/api/users/${tess.id}/role`, { role: 'parent' })).status, 400, 'coach or treasurer only');
  const tessBrowser = browser(app.base);
  // Tess is signed in somewhere; changing her access signs her out so it applies at once
  const up = await coach.put(`/api/users/${tess.id}/role`, { role: 'coach' });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.role, 'coach');
  assert.equal((await app.one('select count(*)::int as n from app.sessions where user_id = $1', tess.id)).n, 0);
  assert.equal((await coach.get('/api/users')).json.find((u) => u.id === tess.id).role, 'coach');
  assert.equal((await coach.put(`/api/users/${tess.id}/role`, { role: 'treasurer' })).json.role, 'treasurer');
  void tessBrowser;

  // Delete straight away (no need to switch off first)
  const sam = (await coach.get('/api/users')).json.find((u) => u.email === 'sam@device.test');
  assert.equal((await coach.del(`/api/users/${sam.id}`)).status, 200);
  assert.ok(!(await coach.get('/api/users')).json.some((u) => u.id === sam.id));
});

test('the owner sees a club\'s staff (never parents), and can change access, switch off and delete them', async () => {
  const parentInvite = await coach.post('/api/users/invite', { email: 'parent@device.test', role: 'parent' });
  assert.equal(parentInvite.status, 200, parentInvite.text);
  const people = await owner.get(`/api/owner/clubs/${clubId}/people`);
  assert.equal(people.status, 200, people.text);
  assert.ok(people.json.every((u) => u.role === 'coach' || u.role === 'treasurer'), 'staff only');
  assert.ok(!people.json.some((u) => u.email === 'parent@device.test'));
  assert.equal((await coach.get(`/api/owner/clubs/${clubId}/people`)).status, 403, 'owner only');
  const parentId = parentInvite.json.userId;
  assert.equal((await owner.del(`/api/owner/clubs/${clubId}/people/${parentId}`)).status, 404, 'parents are the club\'s to manage');

  const tess = people.json.find((u) => u.email === 'tess@device.test');
  assert.equal((await owner.put(`/api/owner/clubs/${clubId}/people/${tess.id}/role`, { role: 'coach' })).json.role, 'coach');
  assert.equal((await owner.put(`/api/owner/clubs/${clubId}/people/${tess.id}/title`, { title: 'Head Coach' })).json.title, 'Head Coach');
  assert.equal((await owner.post(`/api/owner/clubs/${clubId}/people/${tess.id}/status`, { status: 'disabled' })).json.status, 'disabled');
  assert.equal((await owner.post(`/api/owner/clubs/${clubId}/people/${tess.id}/status`, { status: 'active' })).json.status, 'active');
  // Wrong club in the address: not found
  const other = await app.clubs.createClub({ name: 'Third Club', sport: 'Netball', status: 'active' });
  assert.equal((await owner.del(`/api/owner/clubs/${other}/people/${tess.id}`)).status, 404);

  // The last coach can't be removed, demoted or switched off
  const coaches = (await owner.get(`/api/owner/clubs/${clubId}/people`)).json.filter((u) => u.role === 'coach' && u.status !== 'disabled');
  for (const c of coaches.slice(1)) assert.equal((await owner.del(`/api/owner/clubs/${clubId}/people/${c.id}`)).status, 200);
  const last = coaches[0];
  assert.equal((await owner.del(`/api/owner/clubs/${clubId}/people/${last.id}`)).status, 409);
  assert.equal((await owner.put(`/api/owner/clubs/${clubId}/people/${last.id}/role`, { role: 'treasurer' })).status, 409);
  assert.equal((await owner.post(`/api/owner/clubs/${clubId}/people/${last.id}/status`, { status: 'disabled' })).status, 409);
});
