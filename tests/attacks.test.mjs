// Attack tests from the security review. Each test tries something an attacker (or a curious
// insider) would try, and checks the server refuses it or reveals nothing.
import { startServer, browser, tokenFromUrl, totpNow, PASSWORD, SEED_SQUADS, emailedLink, lastMail } from './helpers.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
let clubId;
let coach;
let treasurer;
let parent;
let parentId;
let squad;
let kid;
let otherKid;

const squadBody = (i) => { const { id, ...rest } = SEED_SQUADS[i]; return rest; };

async function finishSetup(url, email, pw = PASSWORD) {
  const b = browser(app.base);
  const acc = await b.post('/api/auth/accept', { token: tokenFromUrl(url), password: pw });
  assert.equal(acc.status, 200, acc.text);
  const login = await b.post('/api/auth/login', { email, password: pw });
  let secret = null;
  if (login.json.stage === 'mfa_setup') {
    secret = (await b.post('/api/auth/2fa/setup')).json.secret;
    assert.equal((await b.post('/api/auth/2fa/confirm', { code: await totpNow(secret) })).status, 200);
  }
  return Object.assign(b, { secret });
}

before(async () => {
  app = await startServer();
  clubId = await app.clubs.createClub({ name: 'Attack Test Club', sport: 'Swimming', status: 'active' });
  coach = await finishSetup((await app.auth.inviteUser({ clubId, email: 'coach@atk.test', name: 'Coach', role: 'coach' })).url, 'coach@atk.test');
  await coach.post('/api/users/invite', { email: 'treasurer@atk.test', role: 'treasurer' });
  treasurer = await finishSetup(await emailedLink(app, 'treasurer@atk.test'), 'treasurer@atk.test');
  squad = (await coach.post('/api/squads', squadBody(0))).json;
  kid = (await coach.post('/api/athletes', { name: 'Kid One', squadId: squad.id, email: 'fam@atk.test', medication: 'Insulin', allergies: 'Peanuts', phone: '021 555 0101', address: '1 Private Lane' })).json.athlete;
  otherKid = (await coach.post('/api/athletes', { name: 'Kid Two', squadId: squad.id, medication: 'Ritalin' })).json.athlete;
  const inv = await coach.post('/api/users/invite', { email: 'fam@atk.test', role: 'parent', athleteIds: [kid.id] });
  parentId = inv.json.userId;
  assert.equal(inv.json.inviteUrl, null, 'once emailed, the invite link is not shown to staff');
  parent = await finishSetup(await emailedLink(app, 'fam@atk.test'), 'fam@atk.test');
});
after(async () => { await app.close(); });

// ---------- H1: staff must never receive someone else's password-reset link ----------

test('H1: staff cannot get a reset link for an active account (it is emailed to the owner only)', async () => {
  for (const staff of [coach, treasurer]) {
    const r = await staff.post(`/api/users/${parentId}/reset-link`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.url, undefined, 'the reset link must not be returned to staff');
    assert.equal(r.json.kind, 'reset');
  }
  const mail = await lastMail(app, 'fam@atk.test', /Reset/);
  assert.ok(mail, 'the reset link goes to the account owner by email');
});

// ---------- H2: the treasurer must not be able to give themselves access to a child ----------

test('H2: the treasurer cannot invite parents or link children to accounts', async () => {
  const inv = await treasurer.post('/api/users/invite', { email: 'sneaky@atk.test', role: 'parent', athleteIds: [otherKid.id] });
  assert.equal(inv.status, 403, inv.text);
  const link = await treasurer.put(`/api/users/${parentId}/athletes`, { athleteIds: [kid.id, otherKid.id] });
  assert.equal(link.status, 403, link.text);
  const boot = await parent.get('/api/bootstrap');
  assert.deepEqual(boot.json.athletes.map((a) => a.id), [kid.id], 'parent still only has their own child');
});

// ---------- M1: rate limits can't be dodged with a fake X-Forwarded-For ----------

test('M1: behind a proxy, rate limits use the address the proxy saw, not one the visitor made up', async () => {
  const proxied = await startServer();
  try {
    const b = browser(proxied.base);
    let last;
    for (let i = 0; i < 12; i++) {
      // The visitor invents a new address each time; the real proxy appends the true one last
      last = await b.post('/api/auth/forgot', { email: `x${i}@atk.test` }, { headers: { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9` } });
    }
    assert.equal(last.status, 429, 'the forgot-password limit (10/hour) must apply to the real address');
  } finally {
    await proxied.close();
  }
});

// ---------- M2: no code guessing on a locked account ----------

test('M2: two-step codes are refused while the account is locked', async () => {
  const b = browser(app.base);
  assert.equal((await b.post('/api/auth/login', { email: 'coach@atk.test', password: PASSWORD })).json.stage, 'mfa');
  await app.query("update app.profiles set locked_until = now() + interval '10 minutes' where email = 'coach@atk.test'");
  const r = await b.post('/api/auth/2fa/verify', { code: await totpNow(coach.secret) });
  assert.equal(r.status, 401, 'even the right code must not work while locked');
  await app.query("update app.profiles set locked_until = null, failed_logins = 0 where email = 'coach@atk.test'");
});

// ---------- M3: contact details can't smuggle extra recipients into links ----------

test('M3: email addresses and phone numbers with link tricks are refused', async () => {
  for (const email of ['x@y.nz?bcc=evil@bad.test', 'x@y.nz&cc=evil@bad.test', 'a,b@y.nz', '"x"@y.nz', 'x@y.nz;evil@bad.test']) {
    const r = await parent.put(`/api/athletes/${kid.id}/profile`, { email });
    assert.equal(r.status, 400, `${email} should be refused`);
  }
  const phone = await parent.put(`/api/athletes/${kid.id}/profile`, { phone: '021 555?body=hi' });
  assert.equal(phone.status, 400, 'phone numbers may only contain digits, spaces, + ( ) -');
  assert.equal((await coach.post('/api/users/invite', { email: 'x@y.nz?bcc=evil@bad.test', role: 'parent' })).status, 400);
});

// ---------- M4: contact details are encrypted at rest ----------

test('M4: phone, email, address and parent name are not stored in plain text', async () => {
  const row = await app.one('select data::text as data, private_enc from app.athletes where id = $1', kid.id);
  for (const secret of ['021 555 0101', '1 Private Lane', 'fam@atk.test', 'Insulin']) {
    assert.ok(!row.data.includes(secret) && !row.private_enc.includes(secret), `${secret} must be encrypted`);
  }
  const seen = (await coach.get('/api/bootstrap')).json.athletes.find((a) => a.id === kid.id);
  assert.equal(seen.phone, '021 555 0101', 'staff still see it normally');
});

// ---------- M5: deleting data ----------

test('M5: a coach can permanently delete a child; the treasurer and parents cannot', async () => {
  const temp = (await coach.post('/api/athletes', { name: 'Leaving Kid', squadId: squad.id, medication: 'Temp meds' })).json.athlete;
  await coach.put('/api/attendance', { athleteId: temp.id, seriesId: 'dev-mon', date: '2026-01-05', present: true });
  assert.equal((await treasurer.del(`/api/athletes/${temp.id}`)).status, 403);
  assert.equal((await parent.del(`/api/athletes/${kid.id}`)).status, 403);
  const r = await coach.del(`/api/athletes/${temp.id}`);
  assert.equal(r.status, 200, r.text);
  assert.equal((await app.one('select count(*)::int as n from app.athletes where id = $1', temp.id)).n, 0);
  assert.equal((await app.one('select count(*)::int as n from app.attendance where athlete_id = $1', temp.id)).n, 0, 'their attendance goes too');
});

test('M5: a coach can delete a switched-off account; the owner can delete a whole club', async () => {
  // An invite nobody has used can be cancelled straight away
  const unused = await coach.post('/api/users/invite', { email: 'never@atk.test', role: 'parent' });
  assert.equal((await coach.del(`/api/users/${unused.json.userId}`)).status, 200);
  // An account someone uses must be switched off first
  const inv = await coach.post('/api/users/invite', { email: 'gone@atk.test', role: 'parent', athleteIds: [otherKid.id] });
  const gone = await finishSetup(await emailedLink(app, 'gone@atk.test'), 'gone@atk.test');
  assert.equal((await coach.del(`/api/users/${inv.json.userId}`)).status, 409, 'switch the account off first');
  assert.equal((await treasurer.del(`/api/users/${inv.json.userId}`)).status, 403);
  await coach.post(`/api/users/${inv.json.userId}/status`, { status: 'disabled' });
  assert.equal((await coach.del(`/api/users/${inv.json.userId}`)).status, 200);
  assert.equal((await app.one("select count(*)::int as n from app.profiles where email = 'gone@atk.test'")).n, 0);
  assert.equal((await app.one("select count(*)::int as n from auth.users where email = 'gone@atk.test'")).n, 0, 'their Supabase sign-in account goes too');
  assert.equal((await app.one("select count(*)::int as n from app.audit_log where detail::text like '%gone@atk.test%'")).n, 0, 'their email is scrubbed from the activity log');
  assert.equal((await gone.get('/api/bootstrap')).status, 401);

  const doomed = await app.clubs.createClub({ name: 'Doomed FC', sport: 'Football', status: 'active' });
  const dc = await finishSetup((await app.auth.inviteUser({ clubId: doomed, email: 'c@doomed.test', role: 'coach' })).url, 'c@doomed.test');
  const ds = (await dc.post('/api/squads', squadBody(0))).json;
  await dc.post('/api/athletes', { name: 'Doomed Kid', squadId: ds.id, medication: 'x' });
  const owner = await finishSetup((await app.auth.inviteUser({ clubId: null, email: 'owner@atk.test', role: 'owner' })).url, 'owner@atk.test');
  assert.equal((await owner.post(`/api/owner/clubs/${doomed}/delete`, { confirmName: 'Doomed' })).status, 400, 'needs the exact club name typed to confirm');
  const del = await owner.post(`/api/owner/clubs/${doomed}/delete`, { confirmName: 'Doomed FC' });
  assert.equal(del.status, 200, del.text);
  for (const t of ['clubs where id', 'profiles where club_id', 'athletes where club_id', 'squads where club_id', 'audit_log where club_id']) {
    assert.equal((await app.one(`select count(*)::int as n from app.${t} = $1`, doomed)).n, 0, `${t} emptied`);
  }
  assert.equal((await app.one("select count(*)::int as n from auth.users where email = 'c@doomed.test'")).n, 0, 'sign-in accounts are deleted too');
  assert.equal((await dc.get('/api/bootstrap')).status, 401, 'its people are signed out');
});

// ---------- M6: forgot password takes the same time either way ----------

test('M6: forgot-password does not wait for the email, so timing reveals nothing', async () => {
  const slow = app.mailer.send;
  app.mailer.send = async (m) => { await new Promise((r) => setTimeout(r, 400)); return slow(m); };
  try {
    const b = browser(app.base);
    const t0 = Date.now();
    await b.post('/api/auth/forgot', { email: 'fam@atk.test' }, { headers: { 'X-Forwarded-For': '1.1.1.1' } });
    const known = Date.now() - t0;
    assert.ok(known < 300, `took ${known}ms — the reply waited for the email`);
  } finally {
    app.mailer.send = slow;
  }
});

// ---------- Low ----------

test('L1: lockouts last at most an hour', async () => {
  const { url } = await app.auth.inviteUser({ clubId, email: 'lock@atk.test', role: 'parent' });
  await browser(app.base).post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD });
  await app.query("update app.profiles set failed_logins = 20 where email = 'lock@atk.test'");
  await browser(app.base).post('/api/auth/login', { email: 'lock@atk.test', password: 'wrong wrong wrong' });
  const until = (await app.one("select locked_until from app.profiles where email = 'lock@atk.test'")).locked_until;
  assert.ok(until.getTime() - Date.now() <= 3_600_000 + 1000, 'capped at 1 hour');
  assert.ok(until.getTime() > Date.now(), 'but it is locked');
});

test('L2: the activity log does not show people\'s IP addresses', async () => {
  const log = (await coach.get('/api/audit')).json;
  assert.ok(log.length > 0);
  assert.ok(log.every((e) => !('ip' in e)));
});

test('L3: malformed web addresses get a 400, not a server error', async () => {
  const r = await coach.get('/api/users/%E0%A4%A/name');
  assert.ok([400, 404, 405].includes(r.status), `got ${r.status}`);
});

test('L6: invisible and right-to-left control characters are stripped from names', async () => {
  const r = await coach.put(`/api/athletes/${otherKid.id}`, { name: 'Kid‮owt​ Two' });
  assert.equal(r.json.athlete.name, 'Kidowt Two');
});

// ---------- Things that were already safe (kept as tests so they stay safe) ----------

test('already safe: prototype-pollution payloads are ignored', async () => {
  const r = await fetch(`${app.base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Club-Request': '1' },
    body: '{"email":"fam@atk.test","password":"x","__proto__":{"role":"coach"},"constructor":{"prototype":{"role":"coach"}}}',
  });
  assert.equal(r.status, 401);
  assert.equal(({}).role, undefined);
});

test('already safe: SQL-looking input is treated as plain text', async () => {
  for (const email of ["' OR 1=1 --", 'fam@atk.test\' --', '"; DROP TABLE users; --']) {
    assert.ok([400, 401].includes((await browser(app.base).post('/api/auth/login', { email, password: 'x' })).status));
  }
  assert.ok((await app.one('select count(*)::int as n from app.profiles')).n > 0);
});

test('already safe: a parent cannot widen their view by sending extra fields', async () => {
  const r = await parent.put(`/api/athletes/${kid.id}/profile`, { name: 'Renamed', squadId: 999, status: 'paid', clubId: 999, id: otherKid.id });
  assert.equal(r.status, 200);
  assert.equal(r.json.athlete.name, 'Kid One');
  assert.equal(r.json.athlete.id, kid.id);
});

test('already safe: guessing other ids returns nothing', async () => {
  for (const id of [otherKid.id, 0, -1, 99999999, '1 OR 1=1', '../1']) {
    const r = await parent.put(`/api/athletes/${encodeURIComponent(id)}/profile`, { phone: '021' });
    assert.equal(r.status, 404, `id ${id}`);
  }
});

test('already safe: a planted second session cookie is ignored', async () => {
  const r = await fetch(`${app.base}/api/bootstrap`, { headers: { Cookie: `club_session=planted; ${Object.entries(parent.jar).map(([k, v]) => `${k}=${v}`).join('; ')}` } });
  assert.equal(r.status, 401, 'the first cookie wins, and a planted one is not a valid session');
});

test('already safe: the owner sees no member details', async () => {
  const { url } = await app.auth.inviteUser({ clubId: null, email: 'owner2@atk.test', role: 'owner' });
  const owner = await finishSetup(url, 'owner2@atk.test');
  const list = JSON.stringify((await owner.get('/api/owner/clubs')).json);
  for (const secret of ['Kid One', 'Insulin', '021 555 0101', 'fam@atk.test']) assert.ok(!list.includes(secret), secret);
  assert.equal((await owner.get('/api/bootstrap')).status, 403);
  assert.equal((await owner.get('/api/users')).status, 403);
  assert.equal((await owner.get('/api/audit')).status, 403);
});

