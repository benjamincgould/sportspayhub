import { startServer, browser, tokenFromUrl, PASSWORD } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('five wrong passwords lock the account, even against the right password', async () => {
  const app = await startServer();
  try {
    const clubId = await app.clubs.createClub({ name: 'Lockout Club', sport: 'Netball', status: 'active' });
    const { url } = await app.auth.inviteUser({ clubId, email: 'family@club.test', role: 'parent' });
    const b = browser(app.base);
    await b.post('/api/auth/accept', { token: tokenFromUrl(url), password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      assert.equal((await b.post('/api/auth/login', { email: 'family@club.test', password: `wrong guess number ${i}` })).status, 401);
    }
    const right = await b.post('/api/auth/login', { email: 'family@club.test', password: PASSWORD });
    assert.equal(right.status, 401, 'locked accounts refuse the correct password too');
    assert.ok((await app.one("select locked_until from app.profiles where email = 'family@club.test'")).locked_until > new Date());

    // Per-email rate limit kicks in after 10 tries in 15 minutes, whatever the outcome
    let limited = false;
    for (let i = 0; i < 6; i++) {
      const r = await b.post('/api/auth/login', { email: 'family@club.test', password: PASSWORD });
      if (r.status === 429) limited = true;
    }
    assert.ok(limited, 'rate limit applies');
  } finally {
    await app.close();
  }
});
