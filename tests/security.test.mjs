import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem, encrypt, decrypt, newRecoveryCodes, normaliseRecoveryCode, sha256, safeEqual } from '../lib/server/security.js';
import { clientAddress, securityHeaders } from '../lib/server/http.js';
import { isEmail, isPhone, text } from '../lib/server/rules.js';

test('password rules', () => {
  assert.match(passwordProblem('short'), /12 characters/);
  assert.match(passwordProblem('password1234'), /common/);
  assert.match(passwordProblem('sarah.parker2024!', { email: 'sarah.parker@example.com' }), /email/);
  assert.match(passwordProblem('riverside rugby rocks!', { clubName: 'Riverside Rugby' }), /club/);
  assert.match(passwordProblem('x'.repeat(73)), /72 characters/, 'bcrypt only reads 72 bytes, so longer is refused');
  assert.match(passwordProblem('ü'.repeat(40)), /72 characters/, 'counted in bytes, not letters');
  assert.equal(passwordProblem('violet anchor teapot river'), null);
});

test('encryption at rest round-trips and detects tampering', () => {
  const key = Buffer.alloc(32, 7);
  const blob = encrypt('Peanuts', key);
  assert.ok(!blob.includes('Peanuts'));
  assert.equal(decrypt(blob, key), 'Peanuts');
  const [v, iv, tag] = blob.split(':');
  const tampered = [v, iv, tag, Buffer.from('Peanutz').toString('base64url')].join(':');
  assert.throws(() => decrypt(tampered, key));
  assert.throws(() => decrypt(blob, Buffer.alloc(32, 8)), 'wrong key fails');
});

test('recovery codes are random and normalise for comparison', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((c) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c)));
  assert.equal(sha256(normaliseRecoveryCode(codes[0].toUpperCase().replace('-', ' '))), sha256(normaliseRecoveryCode(codes[0])));
});

test('constant-time comparison', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('visitor address: Vercel\'s own header, else the address the proxy added', () => {
  const h = (o) => new Headers(o);
  process.env.VERCEL = '1';
  assert.equal(clientAddress(h({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.1, 198.51.100.7' })), '203.0.113.9');
  delete process.env.VERCEL;
  assert.equal(clientAddress(h({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '10.0.0.1, 198.51.100.7' })), '198.51.100.7', 'x-real-ip is only trusted on Vercel');
  assert.equal(clientAddress(h({ 'x-forwarded-for': '2001:db8:1:2:3:4:5:6' })), '2001:db8:1:2::/64', 'IPv6 grouped by /64');
});

test('typed text and contact checks', () => {
  assert.equal(text('  a‮b​c  d '), 'abc d');
  assert.equal(isEmail('x@y.nz?bcc=z@w.nz'), false);
  assert.equal(isEmail('jo.smith+club@example.co.nz'), true);
  assert.equal(isPhone('(09) 555-1234'), true);
  assert.equal(isPhone('021 555?body=hi'), false);
});

test('security headers: strict CSP with a per-page nonce for Next.js scripts', () => {
  const plain = securityHeaders({ production: true });
  assert.match(plain['Content-Security-Policy'], /script-src 'self';/);
  assert.match(plain['Strict-Transport-Security'], /max-age=63072000/);
  const page = securityHeaders({ production: true, nonce: 'abc123' });
  assert.match(page['Content-Security-Policy'], /script-src 'self' 'nonce-abc123' 'strict-dynamic'/);
  assert.doesNotMatch(page['Content-Security-Policy'], /unsafe-inline|unsafe-eval/);
});
