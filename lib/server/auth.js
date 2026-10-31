// Accounts, sign-in, sessions, two-step verification, invites, password resets,
// team access management and the activity log.
//
// Supabase Auth checks passwords and two-step codes. The app keeps its own session table on top,
// so it can sign staff out after 30 idle minutes, end sessions instantly (switching someone off,
// "sign out everywhere"), and give the browser nothing but a random id in an HttpOnly cookie.

import {
  passwordProblem, isBreachedPassword, randomToken, sha256, safeEqual,
  newRecoveryCodes, normaliseRecoveryCode, encrypt, decrypt,
} from './security.js';
import { HttpError, enforceLimit, hitLimit, isUuid, toInt } from './http.js';
import { publicClub, assertUsable, isEmail, normEmail, text } from './rules.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Staff see medical and financial records, so they sign out sooner and must use two-step.
export const SESSION_POLICY = {
  parent: { idle: 7 * DAY, absolute: 30 * DAY },
  treasurer: { idle: 30 * MIN, absolute: 12 * HOUR },
  coach: { idle: 30 * MIN, absolute: 12 * HOUR },
  owner: { idle: 30 * MIN, absolute: 12 * HOUR },
};
const PENDING_TTL = 10 * MIN;      // time allowed between password and two-step code
const INVITE_TTL = 7 * DAY;     // invites (and new-club sign-up links) work for a week
const RESET_TTL = 1 * HOUR;
const EMAIL_CHANGE_TTL = 24 * HOUR;
const TRUST_TTL = 8 * HOUR;       // "remember this device": no two-step code needed for this long
const LOCK_AFTER = 5;              // failed attempts before the account locks
const MAX_LOCK = 1 * HOUR;         // longest lock, so nobody can keep someone else locked out all day
const MAX_CODE_TRIES = 5;          // wrong two-step codes before the sign-in must restart
const LOGIN_MIN_MS = 900;          // every sign-in reply takes at least this long (hides whether an email has an account)
const MFA_REQUIRED = new Set(['coach', 'treasurer', 'owner']); // everyone who can see other people's data
const ROLES = new Set(['parent', 'treasurer', 'coach']);       // roles a club can invite

const LIMITS = {
  loginIp: { windowSec: 15 * 60, max: 30 },
  loginEmail: { windowSec: 15 * 60, max: 10 },
  forgotIp: { windowSec: 3600, max: 10 },
  forgotEmail: { windowSec: 3600, max: 3 },
  tokenIp: { windowSec: 15 * 60, max: 30 },
  passwordUser: { windowSec: 15 * 60, max: 10 },
  inviteUser: { windowSec: 3600, max: 60 },
  setupIp: { windowSec: 3600, max: 5 },
};

const GENERIC_LOGIN_ERROR = "That email and password don't match an account, or the account is locked after too many attempts. Check your details, wait 15 minutes, or use Forgot password.";
const GENERIC_FORGOT = "If that email has an account, we've sent a link to reset the password. It works for 1 hour. If nothing arrives, ask the club for a reset link.";
const BAD_LINK = 'This link has expired or has already been used. Ask the club to send you a new one.';
const SIGNED_OUT_MSG = 'Your sign-in has timed out. Please sign in again.';

function cleanName(value) {
  const name = text(value, 80);
  if (!name) throw new HttpError(400, 'Enter a name.');
  return name;
}
const ms = (d) => (d ? new Date(d).getTime() : 0);
const sleepUntil = (start, minMs) => new Promise((r) => setTimeout(r, Math.max(0, start + minMs - Date.now())));

export function createAuth({ sql, config, mailer, provider }) {
  const { appUrl, cookieName, cookieSecure, platformName } = config;

  // Called when children are linked to or unlinked from parent accounts, so families can be
  // regrouped (set up by the data module, which owns families)
  let onLinksChanged = async () => {};
  const setOnLinksChanged = (fn) => { onLinksChanged = fn; };
  const linkedIds = async (userId) => (await sql`select athlete_id from app.user_athletes where user_id = ${userId}`).map((r) => r.athlete_id);

  const getProfile = async (id) => (isUuid(id) ? (await sql`select * from app.profiles where id = ${id}`)[0] || null : null);
  const getClub = async (id) => (id == null ? null : (await sql`select * from app.clubs where id = ${id}`)[0] || null);

  // ---------- Activity log ----------

  async function audit(ctx, userId, action, detail = null, clubId = undefined) {
    let club = clubId;
    if (club === undefined) {
      club = userId ? (await getProfile(userId))?.club_id ?? null : null;
      club ??= ctx?.user?.club_id ?? null;
    }
    await sql`insert into app.audit_log (club_id, user_id, action, detail, ip)
              values (${club}, ${userId ?? null}, ${action}, ${detail ? sql.json(detail) : null}, ${ctx?.ip ?? null})`;
  }

  // ---------- Sessions ----------

  const cookie = (value, maxAgeSec) => {
    let c = `${cookieName}=${value}; Path=/; SameSite=Strict; HttpOnly`;
    if (cookieSecure) c += '; Secure';
    return `${c}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
  };
  const clearSessionCookie = (ctx) => ctx.cookiesOut.push(cookie('', 0));

  // "Remember this device for 8 hours": a second random cookie, only valid for the person who ticked it
  const deviceCookieName = cookieSecure ? '__Host-club_device' : 'club_device';
  const deviceCookie = (value, maxAgeSec) => {
    let c = `${deviceCookieName}=${value}; Path=/; SameSite=Strict; HttpOnly`;
    if (cookieSecure) c += '; Secure';
    return `${c}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
  };
  async function rememberDevice(ctx, user) {
    const token = randomToken(32);
    await sql`delete from app.trusted_devices where user_id = ${user.id} and expires_at < now()`;
    await sql`insert into app.trusted_devices (hash, user_id, expires_at, ip, user_agent)
              values (${sha256(token)}, ${user.id}, ${new Date(Date.now() + TRUST_TTL)}, ${ctx.ip}, ${String(ctx.ua || '').slice(0, 200)})`;
    ctx.cookiesOut.push(deviceCookie(token, TRUST_TTL / 1000));
  }
  async function deviceTrusted(ctx, user) {
    const token = ctx.cookies[deviceCookieName];
    if (!token || token.length > 100) return false;
    const [row] = await sql`select 1 from app.trusted_devices where hash = ${sha256(token)} and user_id = ${user.id} and expires_at > now()`;
    return Boolean(row);
  }
  async function forgetDevice(ctx) {
    const token = ctx.cookies[deviceCookieName];
    if (token && token.length <= 100) await sql`delete from app.trusted_devices where hash = ${sha256(token)}`;
    if (token) ctx.cookiesOut.push(deviceCookie('', 0));
  }
  const forgetAllDevices = (userId) => sql`delete from app.trusted_devices where user_id = ${userId}`;

  const sealTokens = (tokens) => (tokens ? encrypt(JSON.stringify(tokens)) : null);
  const tokensOf = (session) => (session?.sb_tokens_enc ? JSON.parse(decrypt(session.sb_tokens_enc)) : null);

  async function createSession(ctx, user, stage, tokens) {
    const token = randomToken(32);
    const lifetime = stage === 'full' ? SESSION_POLICY[user.role].absolute : PENDING_TTL;
    await sql`insert into app.sessions (id_hash, user_id, stage, sb_tokens_enc, expires_at, ip, user_agent)
              values (${sha256(token)}, ${user.id}, ${stage}, ${sealTokens(tokens)}, ${new Date(Date.now() + lifetime)}, ${ctx.ip}, ${String(ctx.ua || '').slice(0, 200)})`;
    ctx.cookiesOut.push(cookie(token, lifetime / 1000));
  }

  // Ends this browser's session. With revoke, the Supabase session behind it is ended too.
  async function destroyCurrentSession(ctx, { revoke = false } = {}) {
    if (ctx.session) {
      await sql`delete from app.sessions where id_hash = ${ctx.session.id_hash}`;
      if (revoke) await ctx.provider.signOut(tokensOf(ctx.session), 'local').catch(() => {});
    }
    ctx.session = null;
    ctx.user = null;
    ctx.pendingUser = null;
  }

  // Signed out everywhere (password change, switched off, sign out everywhere): remembered devices go too
  const revokeAllSessions = async (userId) => {
    await sql`delete from app.sessions where user_id = ${userId}`;
    await forgetAllDevices(userId);
  };

  // Runs on every API request: works out who is signed in, if anyone
  async function loadSession(ctx) {
    const token = ctx.cookies[cookieName];
    if (!token || token.length > 100) return;
    const [row] = await sql`select * from app.sessions where id_hash = ${sha256(token)}`;
    const now = Date.now();
    const drop = async () => {
      if (row) await sql`delete from app.sessions where id_hash = ${row.id_hash}`;
      clearSessionCookie(ctx);
    };
    if (!row) return clearSessionCookie(ctx);
    if (now > ms(row.expires_at)) return drop();
    const user = await getProfile(row.user_id);
    if (!user || user.status !== 'active') return drop();
    if (row.stage === 'full') {
      if (now - ms(row.last_seen_at) > SESSION_POLICY[user.role].idle) return drop();
      if (now - ms(row.last_seen_at) > MIN) await sql`update app.sessions set last_seen_at = now() where id_hash = ${row.id_hash}`;
      ctx.user = user;
    } else {
      ctx.pendingUser = user;
    }
    ctx.session = row;
  }

  // Keeps the session's Supabase tokens current after Supabase refreshes them
  async function saveTokens(ctx, tokens) {
    if (ctx.session && tokens) await sql`update app.sessions set sb_tokens_enc = ${sealTokens(tokens)} where id_hash = ${ctx.session.id_hash}`;
  }

  // ---------- Guards ----------

  const requireUser = (...roles) => (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Please sign in to continue.', { signedOut: true });
    if (roles.length && !roles.includes(ctx.user.role)) throw new HttpError(403, "Your account doesn't have access to that.");
  };

  function requireStage(ctx, ...stages) {
    if (!ctx.session || !stages.includes(ctx.session.stage)) throw new HttpError(401, SIGNED_OUT_MSG, { signedOut: true });
    return { session: ctx.session, user: ctx.user || ctx.pendingUser };
  }

  // ---------- Helpers ----------

  const athleteIdsFor = async (userId) => (await sql`select athlete_id from app.user_athletes where user_id = ${userId} order by athlete_id`).map((r) => r.athlete_id);

  async function publicUser(u) {
    return {
      id: u.id, email: u.email, name: u.name, role: u.role, title: u.title || null,
      club: u.club_id ? publicClub(await getClub(u.club_id)) : null,
      mfaEnabled: Boolean(u.mfa_enabled),
      mfaRequired: MFA_REQUIRED.has(u.role),
      athleteIds: u.role === 'parent' ? await athleteIdsFor(u.id) : [],
      idleMinutes: SESSION_POLICY[u.role].idle / MIN,
    };
  }
  const pendingView = (u) => ({ email: u.email, name: u.name, role: u.role });

  // A wrong password or wrong two-step code counts toward locking the account
  async function registerFailure(ctx, user) {
    const [{ failed_logins: n }] = await sql`update app.profiles set failed_logins = failed_logins + 1 where id = ${user.id} returning failed_logins`;
    if (n >= LOCK_AFTER) {
      const until = new Date(Date.now() + Math.min(15 * MIN * 2 ** Math.min(n - LOCK_AFTER, 8), MAX_LOCK));
      await sql`update app.profiles set locked_until = ${until} where id = ${user.id}`;
      await audit(ctx, user.id, 'account_locked', { until: until.toISOString() });
    }
  }
  const isLocked = (user) => ms(user.locked_until) > Date.now();

  async function completeSignIn(ctx, user, tokens) {
    await destroyCurrentSession(ctx);
    await sql`update app.profiles set failed_logins = 0, locked_until = null, last_login_at = now() where id = ${user.id}`;
    await createSession(ctx, user, 'full', tokens);
    await audit(ctx, user.id, 'login_success');
    return publicUser(await getProfile(user.id));
  }

  async function checkNewPassword(password, user) {
    const club = user.club_id ? await getClub(user.club_id) : null;
    const problem = passwordProblem(password, { email: user.email, name: user.name, clubName: club?.name });
    if (problem) throw new HttpError(400, problem);
    if (await isBreachedPassword(password)) {
      throw new HttpError(400, 'That password has appeared in a known data breach, so it isn\'t safe to use. Please choose a different one.');
    }
  }

  async function checkCurrentPassword(ctx, user, password) {
    await enforceLimit(sql, 'passwordUser', user.id, LIMITS.passwordUser);
    if (typeof password !== 'string' || !password || !(await ctx.provider.checkPassword(user.email, password))) {
      await registerFailure(ctx, user);
      return false;
    }
    return true;
  }

  async function issueToken(user, kind, createdBy, data = null) {
    const token = randomToken(32);
    const ttl = kind === 'invite' ? INVITE_TTL : kind === 'email' ? EMAIL_CHANGE_TTL : RESET_TTL;
    await sql`update app.tokens set used_at = now() where user_id = ${user.id} and kind = ${kind} and used_at is null`;
    await sql`insert into app.tokens (hash, user_id, kind, expires_at, created_by, data)
              values (${sha256(token)}, ${user.id}, ${kind}, ${new Date(Date.now() + ttl)}, ${createdBy ?? null}, ${data ? sql.json(data) : null})`;
    // The token travels in the URL fragment (#), which browsers never send to servers or put in referrer headers
    return `${appUrl}/#/${kind}/${token}`;
  }

  async function findToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const [row] = await sql`select * from app.tokens where hash = ${sha256(token)} and used_at is null and expires_at > now()`;
    if (!row) return null;
    const user = await getProfile(row.user_id);
    if (!user || user.status === 'disabled') return null;
    return { row, user };
  }

  // Returns { emailed, problem }: problem explains a failed send, so the inviter can fix it or
  // pass the link on themselves
  async function emailInvite(user, url, invitedBy) {
    const club = user.club_id ? (await getClub(user.club_id))?.name : null;
    const where = club ? `${club} on ${platformName}` : platformName;
    const res = await mailer.sendDetailed({
      to: user.email,
      subject: club ? `You're invited to ${club}` : `You're invited to ${platformName}`,
      text: `Hi ${user.name || 'there'},\n\n${invitedBy || 'The club'} has set up an account for you with ${where}.\n\nSet your password here (the link works for 7 days and can only be used once):\n${url}\n\nIf you weren't expecting this, you can ignore this email.\n`,
    });
    return { emailed: res.ok, problem: res.ok ? null : res.problem };
  }

  async function emailReset(user, url) {
    return mailer.send({
      to: user.email,
      subject: `Reset your ${platformName} password`,
      text: `Hi ${user.name || 'there'},\n\nUse this link to choose a new password. It works for 1 hour and can only be used once:\n${url}\n\nIf you didn't ask for this, you can ignore this email; your password hasn't changed.\n`,
    });
  }

  // The Supabase Auth account for an email: a new one, or one left behind by an earlier attempt
  async function authAccountFor(email) {
    try {
      return (await provider.createUser(email)).id;
    } catch (err) {
      if (!err.exists) throw err;
      const [row] = await sql`select id from auth.users where lower(email) = ${email}`;
      if (!row) throw err;
      return row.id;
    }
  }

  // Creates (or re-sends) an invite. Used by the API and the owner set-up.
  async function inviteUser({ clubId = null, email, name = '', role, title = null, athleteIds = [], createdBy = null }) {
    let [user] = await sql`select * from app.profiles where email = ${email}`;
    if (user) {
      if ((user.club_id ?? null) !== (clubId ?? null)) throw new HttpError(409, 'That email already uses the app with another club. Ask them for a different email address.');
      if (user.role !== role) throw new HttpError(409, `${email} already has a ${user.role} account.`);
      if (user.status === 'disabled') throw new HttpError(409, 'That account is switched off. Turn it back on first.');
      if (name && !user.name) await sql`update app.profiles set name = ${name} where id = ${user.id}`;
      if (title && role !== 'parent') await sql`update app.profiles set title = ${title} where id = ${user.id}`;
    } else {
      const id = await authAccountFor(email);
      try {
        [user] = await sql`insert into app.profiles (id, club_id, email, name, role, status, title)
                           values (${id}, ${clubId}, ${email}, ${name}, ${role}, 'invited', ${role === 'parent' ? null : title || null}) returning *`;
      } catch (err) {
        if (err.code === '23505') throw new HttpError(409, 'That email already has an account.');
        throw err;
      }
    }
    for (const id of athleteIds) {
      await sql`insert into app.user_athletes (user_id, athlete_id) values (${user.id}, ${id}) on conflict do nothing`;
    }
    if (athleteIds.length) await onLinksChanged(await linkedIds(user.id));
    const url = user.status === 'invited' ? await issueToken(user, 'invite', createdBy) : null;
    return { user, url };
  }

  // ---------- Routes ----------

  function routes(r) {
    // Who is signed in (or part-way through signing in)
    r.get('/api/auth/session', async (ctx) => {
      if (ctx.user) return { stage: 'full', user: await publicUser(ctx.user) };
      if (ctx.pendingUser) return { stage: ctx.session.stage, user: pendingView(ctx.pendingUser) };
      return { stage: null };
    });

    r.post('/api/auth/login', async (ctx) => {
      const started = Date.now();
      await enforceLimit(sql, 'loginIp', ctx.ip, LIMITS.loginIp);
      const email = normEmail(ctx.body.email);
      const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
      if (!email || !password) throw new HttpError(400, 'Enter your email and password.');
      if (password.length > 256 || !isEmail(email)) { await sleepUntil(started, LOGIN_MIN_MS); throw new HttpError(401, GENERIC_LOGIN_ERROR); }
      await enforceLimit(sql, 'loginEmail', email, LIMITS.loginEmail, GENERIC_LOGIN_ERROR);

      const [user] = await sql`select * from app.profiles where email = ${email}`;
      const fail = async (reason) => {
        await audit(ctx, user?.id, 'login_failed', { email, reason }, user ? undefined : null);
        await sleepUntil(started, LOGIN_MIN_MS);
        throw new HttpError(401, GENERIC_LOGIN_ERROR);
      };

      // Same answer, and at least the same time, whether or not the email has an account
      if (!user || user.status !== 'active') return fail(user ? user.status : 'no_account');
      if (isLocked(user)) return fail('locked');
      const tokens = await ctx.provider.signIn(email, password);
      if (!tokens) { await registerFailure(ctx, user); return fail('wrong_password'); }
      await sleepUntil(started, LOGIN_MIN_MS);

      if (user.mfa_enabled && await deviceTrusted(ctx, user)) {
        // Two-step code entered on this device in the last 8 hours (the password is still checked above)
        await destroyCurrentSession(ctx, { revoke: true });
        const signedIn = await completeSignIn(ctx, user, tokens);
        await audit(ctx, user.id, 'login_remembered_device');
        return { stage: 'full', user: signedIn, rememberedDevice: true };
      }
      if (user.mfa_enabled) {
        await destroyCurrentSession(ctx, { revoke: true });
        await createSession(ctx, user, 'mfa', tokens);
        return { stage: 'mfa', user: pendingView(user) };
      }
      if (MFA_REQUIRED.has(user.role)) {
        await destroyCurrentSession(ctx, { revoke: true });
        await createSession(ctx, user, 'mfa_setup', tokens);
        return { stage: 'mfa_setup', user: pendingView(user) };
      }
      await destroyCurrentSession(ctx, { revoke: true });
      return { stage: 'full', user: await completeSignIn(ctx, user, tokens) };
    });

    r.post('/api/auth/2fa/verify', async (ctx) => {
      const { session, user } = requireStage(ctx, 'mfa');
      if (isLocked(user)) {
        // No code guessing while the account is locked, whatever sign-in attempt it comes from
        await destroyCurrentSession(ctx, { revoke: true });
        clearSessionCookie(ctx);
        throw new HttpError(401, GENERIC_LOGIN_ERROR, { signedOut: true });
      }
      const code = String(ctx.body.code ?? '');

      if (ctx.body.recovery === true) {
        const norm = normaliseRecoveryCode(code);
        const [row] = norm.length === 10
          ? await sql`update app.recovery_codes set used_at = now()
                      where id = (select id from app.recovery_codes where user_id = ${user.id} and code_hash = ${sha256(norm)} and used_at is null limit 1)
                      returning id`
          : [];
        if (row) {
          await audit(ctx, user.id, 'recovery_code_used');
          // A recovery code means the phone is lost: the old authenticator is removed for good.
          // Supabase ends every session when the authenticator goes, so this sign-in continues on a fresh one.
          await ctx.provider.mfaRemoveAll(user.id);
          await forgetAllDevices(user.id);
          const fresh = await ctx.provider.newSession(user.email);
          await sql`update app.profiles set mfa_enabled = false where id = ${user.id}`;
          await sql`delete from app.recovery_codes where user_id = ${user.id}`;
          if (MFA_REQUIRED.has(user.role)) {
            // Staff must add their new phone before they get in
            await sql`update app.sessions set stage = 'mfa_setup', mfa_attempts = 0, sb_tokens_enc = ${sealTokens(fresh)},
                        expires_at = ${new Date(Date.now() + PENDING_TTL)} where id_hash = ${session.id_hash}`;
            return { stage: 'mfa_setup', user: pendingView(user), notice: 'Recovery code accepted. Now set up two-step verification on your new phone.' };
          }
          return {
            stage: 'full', user: await completeSignIn(ctx, user, fresh),
            notice: 'Recovery code accepted. Two-step verification is now off; you can turn it back on in Settings.',
          };
        }
      } else {
        const verified = /^\d{6}$/.test(code) ? await ctx.provider.mfaVerify(tokensOf(session), code) : null;
        if (verified) {
          const left = (await sql`select count(*)::int as n from app.recovery_codes where user_id = ${user.id} and used_at is null`)[0].n;
          if (ctx.body.remember === true) await rememberDevice(ctx, user);
          return { stage: 'full', user: await completeSignIn(ctx, user, verified.tokens), recoveryCodesLeft: left };
        }
      }

      await registerFailure(ctx, user);
      await audit(ctx, user.id, 'mfa_failed');
      const tries = session.mfa_attempts + 1;
      if (tries >= MAX_CODE_TRIES) {
        await destroyCurrentSession(ctx, { revoke: true });
        clearSessionCookie(ctx);
        throw new HttpError(401, 'Too many incorrect codes. Please sign in again.', { signedOut: true });
      }
      await sql`update app.sessions set mfa_attempts = ${tries} where id_hash = ${session.id_hash}`;
      throw new HttpError(401, ctx.body.recovery === true
        ? "That recovery code isn't valid or has already been used."
        : "That code isn't right. Check your authenticator app and enter the newest code.");
    });

    // Start setting up two-step: during first staff sign-in, or later by a signed-in parent
    r.post('/api/auth/2fa/setup', async (ctx) => {
      const { session, user } = requireStage(ctx, 'mfa_setup', 'full');
      if (session.stage === 'full' && user.mfa_enabled) throw new HttpError(400, 'Two-step verification is already on.');
      const enrolled = await ctx.provider.mfaEnroll(tokensOf(session), { issuer: platformName });
      await sql`update app.sessions set pending_factor_id = ${enrolled.factorId}, sb_tokens_enc = ${sealTokens(enrolled.tokens)} where id_hash = ${session.id_hash}`;
      return { secret: enrolled.secret, uri: enrolled.uri };
    });

    r.post('/api/auth/2fa/confirm', async (ctx) => {
      const { session, user } = requireStage(ctx, 'mfa_setup', 'full');
      if (!session.pending_factor_id) throw new HttpError(400, 'Start the setup again to get a new key.');
      const code = String(ctx.body.code ?? '');
      const verified = /^\d{6}$/.test(code) ? await ctx.provider.mfaVerify(tokensOf(session), code, session.pending_factor_id) : null;
      if (!verified) {
        const tries = session.mfa_attempts + 1;
        if (tries >= MAX_CODE_TRIES && session.stage === 'mfa_setup') {
          await destroyCurrentSession(ctx, { revoke: true });
          clearSessionCookie(ctx);
          throw new HttpError(401, 'Too many incorrect codes. Please sign in again.', { signedOut: true });
        }
        await sql`update app.sessions set mfa_attempts = ${tries} where id_hash = ${session.id_hash}`;
        throw new HttpError(400, "That code isn't right. Make sure you added the key shown here, then enter the newest code.");
      }

      const codes = newRecoveryCodes();
      await sql.begin(async (tx) => {
        await tx`update app.profiles set mfa_enabled = true where id = ${user.id}`;
        await tx`delete from app.recovery_codes where user_id = ${user.id}`;
        for (const c of codes) await tx`insert into app.recovery_codes (user_id, code_hash) values (${user.id}, ${sha256(normaliseRecoveryCode(c))})`;
        await tx`update app.sessions set pending_factor_id = null, mfa_attempts = 0, sb_tokens_enc = ${sealTokens(verified.tokens)} where id_hash = ${session.id_hash}`;
      });
      await audit(ctx, user.id, '2fa_enabled');

      const fresh = await getProfile(user.id);
      const signedIn = session.stage === 'mfa_setup' ? await completeSignIn(ctx, fresh, verified.tokens) : await publicUser(fresh);
      return { stage: 'full', user: signedIn, recoveryCodes: codes };
    });

    // Parents may switch two-step off; staff can't
    r.post('/api/auth/2fa/disable', requireUser(), async (ctx) => {
      const user = ctx.user;
      if (MFA_REQUIRED.has(user.role)) throw new HttpError(403, 'Two-step verification is required for staff accounts.');
      if (!(await checkCurrentPassword(ctx, user, ctx.body.password))) throw new HttpError(400, 'Your password is incorrect.');
      await forgetAllDevices(user.id);
      await ctx.provider.mfaRemoveAll(user.id);
      // Removing the authenticator signs them out of Supabase everywhere: other devices stay signed
      // out, and this one continues on a fresh session (their password was just checked)
      await revokeAllSessions(user.id);
      const fresh = await ctx.provider.signIn(user.email, ctx.body.password);
      if (fresh) await createSession(ctx, user, 'full', fresh);
      else clearSessionCookie(ctx);
      await sql`update app.profiles set mfa_enabled = false where id = ${user.id}`;
      await sql`delete from app.recovery_codes where user_id = ${user.id}`;
      await audit(ctx, user.id, '2fa_disabled');
      return { user: await publicUser(await getProfile(user.id)) };
    });

    r.post('/api/auth/2fa/recovery-codes', requireUser(), async (ctx) => {
      const user = ctx.user;
      if (!user.mfa_enabled) throw new HttpError(400, 'Turn on two-step verification first.');
      if (!(await checkCurrentPassword(ctx, user, ctx.body.password))) throw new HttpError(400, 'Your password is incorrect.');
      const codes = newRecoveryCodes();
      await sql.begin(async (tx) => {
        await tx`delete from app.recovery_codes where user_id = ${user.id}`;
        for (const c of codes) await tx`insert into app.recovery_codes (user_id, code_hash) values (${user.id}, ${sha256(normaliseRecoveryCode(c))})`;
      });
      await audit(ctx, user.id, 'recovery_codes_replaced');
      return { recoveryCodes: codes };
    });

    // Change your own display name
    r.post('/api/auth/profile', requireUser(), async (ctx) => {
      const name = cleanName(ctx.body.name);
      await sql`update app.profiles set name = ${name} where id = ${ctx.user.id}`;
      await audit(ctx, ctx.user.id, 'name_changed');
      return { user: await publicUser(await getProfile(ctx.user.id)) };
    });

    // Change your own email address. Nothing changes until the link sent to the new address is
    // opened, which proves it's yours; the old address is told, so a takeover can't go unnoticed.
    r.post('/api/auth/email', requireUser(), async (ctx) => {
      const user = ctx.user;
      const newEmail = normEmail(ctx.body.newEmail);
      if (!isEmail(newEmail)) throw new HttpError(400, 'Enter a valid email address, like name@example.com.');
      if (newEmail === user.email) throw new HttpError(400, "That's already your email address.");
      if (!(await checkCurrentPassword(ctx, user, ctx.body.password))) throw new HttpError(400, 'Your password is incorrect.');
      if ((await sql`select 1 from app.profiles where email = ${newEmail}`).length) throw new HttpError(409, 'That email address already has an account.');
      const url = await issueToken(user, 'email', user.id, { newEmail });
      await mailer.send({
        to: newEmail,
        subject: `Confirm your new email for ${platformName}`,
        text: `Hi ${user.name || 'there'},\n\nTo use this address to sign in to ${platformName}, confirm it here (the link works once, for 24 hours):\n${url}\n\nIf you didn't ask for this, ignore this email and nothing will change.\n`,
      });
      await mailer.send({
        to: user.email,
        subject: `Email change requested for your ${platformName} account`,
        text: `Hi ${user.name || 'there'},\n\nSomeone signed in to your account asked to change its email address to ${newEmail}. It only changes once that address confirms it.\n\nIf this wasn't you, change your password straight away and contact ${process.env.OWNER_CONTACT || 'the app provider'}.\n`,
      });
      await audit(ctx, user.id, 'email_change_requested');
      return { ok: true, message: `We've emailed ${newEmail} a link to confirm. Your email changes once you open it (within 24 hours).` };
    });

    r.post('/api/auth/email/confirm', async (ctx) => {
      await enforceLimit(sql, 'tokenIp', ctx.ip, LIMITS.tokenIp);
      const found = await findToken(ctx.body.token);
      if (!found || found.row.kind !== 'email' || !isEmail(found.row.data?.newEmail)) throw new HttpError(400, 'This link has expired or has already been used. Ask for a new one in Settings → Your Account.');
      const { row, user } = found;
      const newEmail = found.row.data.newEmail;
      if ((await sql`select 1 from app.profiles where email = ${newEmail}`).length) throw new HttpError(409, 'That email address already has an account.');
      const claimed = await sql`update app.tokens set used_at = now() where hash = ${row.hash} and used_at is null returning hash`;
      if (!claimed.length) throw new HttpError(400, 'This link has already been used.');
      try {
        await ctx.provider.setEmail(user.id, newEmail);
      } catch (err) {
        await sql`update app.tokens set used_at = null where hash = ${row.hash}`;
        throw err;
      }
      await sql`update app.profiles set email = ${newEmail} where id = ${user.id}`;
      await mailer.send({
        to: user.email,
        subject: `Your ${platformName} email address was changed`,
        text: `Hi ${user.name || 'there'},\n\nYour account now signs in with ${newEmail} instead of this address.\n\nIf this wasn't you, contact ${process.env.OWNER_CONTACT || 'the app provider'} straight away.\n`,
      });
      await audit(ctx, user.id, 'email_changed');
      return { ok: true, email: newEmail };
    });

    r.post('/api/auth/logout', async (ctx) => {
      const userId = (ctx.user || ctx.pendingUser)?.id;
      await destroyCurrentSession(ctx, { revoke: true });
      await forgetDevice(ctx); // signing out on purpose means "don't remember me here"
      clearSessionCookie(ctx);
      if (userId) await audit(ctx, userId, 'logout');
      return { ok: true };
    });

    r.post('/api/auth/logout-all', requireUser(), async (ctx) => {
      const userId = ctx.user.id;
      await ctx.provider.signOut(tokensOf(ctx.session), 'global').catch(() => {});
      await revokeAllSessions(userId);
      clearSessionCookie(ctx);
      await audit(ctx, userId, 'logout_all');
      return { ok: true };
    });

    r.post('/api/auth/password', requireUser(), async (ctx) => {
      const user = ctx.user;
      if (!(await checkCurrentPassword(ctx, user, ctx.body.current))) throw new HttpError(400, 'Your current password is incorrect.');
      const next = String(ctx.body.next ?? '');
      await checkNewPassword(next, user);
      await ctx.provider.setPassword(user.id, next);
      await sql`update app.profiles set password_changed_at = now() where id = ${user.id}`;
      // Sign out every other device, and give this one a fresh session (Supabase's too)
      const tokens = await ctx.provider.signIn(user.email, next);
      if (tokens) await ctx.provider.signOut(tokens, 'others').catch(() => {});
      await revokeAllSessions(user.id);
      await createSession(ctx, user, 'full', tokens);
      await audit(ctx, user.id, 'password_changed');
      await mailer.send({ to: user.email, subject: `Your ${platformName} password was changed`, text: `Hi ${user.name || 'there'},\n\nYour password was just changed and other devices were signed out. If this wasn't you, contact the club straight away.\n` });
      return { ok: true };
    });

    r.post('/api/auth/forgot', async (ctx) => {
      await enforceLimit(sql, 'forgotIp', ctx.ip, LIMITS.forgotIp);
      const email = normEmail(ctx.body.email);
      if (!isEmail(email)) throw new HttpError(400, 'Enter the email address you sign in with.');
      const { allowed } = await hitLimit(sql, 'forgotEmail', email, LIMITS.forgotEmail);
      const [user] = allowed ? await sql`select * from app.profiles where email = ${email} and status = 'active'` : [];
      if (user) {
        // Sent after the reply, so the reply takes the same time whether or not the email has an account
        ctx.after(async () => {
          const url = await issueToken(user, 'reset', null);
          await emailReset(user, url);
          await audit(ctx, user.id, 'reset_requested');
        });
      }
      return { ok: true, message: GENERIC_FORGOT };
    });

    // What an invite / reset link is for (so the page can show the email address)
    r.post('/api/auth/token', async (ctx) => {
      await enforceLimit(sql, 'tokenIp', ctx.ip, LIMITS.tokenIp);
      const found = await findToken(ctx.body.token);
      if (!found || found.row.kind === 'email') throw new HttpError(400, BAD_LINK);
      const club = found.user.club_id ? await getClub(found.user.club_id) : null;
      return {
        kind: found.row.kind, email: found.user.email, name: found.user.name, mfaRequired: MFA_REQUIRED.has(found.user.role),
        club: club ? { name: club.name, logo: club.branding?.logo || null, colour: club.branding?.colour || 'indigo' } : null,
      };
    });

    // Set a password from an invite or reset link
    r.post('/api/auth/accept', async (ctx) => {
      await enforceLimit(sql, 'tokenIp', ctx.ip, LIMITS.tokenIp);
      const found = await findToken(ctx.body.token);
      if (!found || found.row.kind === 'email') throw new HttpError(400, BAD_LINK);
      const { row, user } = found;
      const password = String(ctx.body.password ?? '');
      await checkNewPassword(password, user);
      // Claim the link first, so the same link can't be used twice at once
      const claimed = await sql`update app.tokens set used_at = now() where hash = ${row.hash} and used_at is null returning hash`;
      if (!claimed.length) throw new HttpError(400, BAD_LINK);
      try {
        await ctx.provider.setPassword(user.id, password);
      } catch (err) {
        await sql`update app.tokens set used_at = null where hash = ${row.hash}`; // let them try again
        throw err;
      }
      const name = row.kind === 'invite' ? text(ctx.body.name, 80) : '';
      await sql`update app.profiles set password_changed_at = now(), failed_logins = 0, locked_until = null, status = 'active',
                  name = case when ${name}::text <> '' then ${name}::text else name end
                where id = ${user.id}`;
      await revokeAllSessions(user.id);
      await audit(ctx, user.id, row.kind === 'invite' ? 'invite_accepted' : 'password_reset');
      // A reset never removes two-step verification, so a stolen email alone can't take over a staff account
      return { ok: true, email: user.email };
    });

    // ----- First-time set-up: create the platform owner's account -----
    // Works only while no owner exists, and only with OWNER_SETUP_SECRET from the server's settings.

    r.get('/api/setup/owner', async () => {
      const [{ n }] = await sql`select count(*)::int as n from app.profiles where role = 'owner'`;
      return { available: n === 0 && String(process.env.OWNER_SETUP_SECRET || '').length >= 24 };
    });

    r.post('/api/setup/owner', async (ctx) => {
      await enforceLimit(sql, 'setupIp', ctx.ip, LIMITS.setupIp);
      const secret = String(process.env.OWNER_SETUP_SECRET || '');
      const [{ n }] = await sql`select count(*)::int as n from app.profiles where role = 'owner'`;
      if (secret.length < 24 || n > 0) throw new HttpError(404, 'Not found.');
      if (!safeEqual(String(ctx.body.secret ?? ''), secret)) throw new HttpError(403, "That set-up code isn't right.");
      const email = normEmail(ctx.body.email);
      if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
      const { user, url } = await inviteUser({ email, name: text(ctx.body.name, 80), role: 'owner' });
      await audit(ctx, user.id, 'owner_created', null, null);
      const { emailed, problem: emailProblem } = await emailInvite(user, url, platformName);
      // If the email couldn't be sent, the person holding the set-up code gets the link instead
      return { emailed, emailProblem, inviteUrl: emailed ? null : url };
    });

    // ----- Team & access (staff) -----

    // ----- Managing people: shared by a club's coaches and the platform owner -----

    // A club always keeps at least one coach who can get in (they run everything else)
    async function keepsACoach(target, clubId) {
      if (target.role !== 'coach') return;
      const [{ n }] = await sql`select count(*)::int as n from app.profiles
                                where club_id = ${clubId} and role = 'coach' and status <> 'disabled' and id <> ${target.id}`;
      if (n === 0) throw new HttpError(409, 'A club needs at least one coach. Add or give someone else coach access first.');
    }

    // Change between coach and treasurer access. They're signed out so the new access applies at once.
    async function changeRole(ctx, target, role, clubId) {
      if (target.role === 'parent' || target.role === 'owner') throw new HttpError(400, "Parents' access can't be changed here. Invite them as staff with a different email instead.");
      if (role !== 'coach' && role !== 'treasurer') throw new HttpError(400, 'Choose coach or treasurer.');
      if (role === target.role) return target.role;
      if (role === 'treasurer') await keepsACoach(target, clubId);
      await sql`update app.profiles set role = ${role} where id = ${target.id}`;
      await revokeAllSessions(target.id);
      await audit(ctx, ctx.user.id, 'access_changed', { for: target.email, from: target.role, to: role }, clubId);
      return role;
    }

    async function setAccountStatus(ctx, target, enable, clubId) {
      if (!enable) await keepsACoach(target, clubId);
      const status = enable ? (target.password_changed_at ? 'active' : 'invited') : 'disabled';
      await ctx.provider.setBanned(target.id, !enable);
      await sql`update app.profiles set status = ${status}, failed_logins = 0, locked_until = null where id = ${target.id}`;
      if (!enable) await revokeAllSessions(target.id);
      await audit(ctx, ctx.user.id, enable ? 'account_enabled' : 'account_disabled', { for: target.email }, clubId);
      return status;
    }

    // Deleting signs them out everywhere and removes their sign-in for good (the club's records stay)
    async function deleteAccount(ctx, target, clubId) {
      await keepsACoach(target, clubId);
      const children = await linkedIds(target.id);
      await revokeAllSessions(target.id);
      await ctx.provider.deleteUser(target.id); // the profile, sessions, links and recovery codes go with it
      await sql`delete from app.profiles where id = ${target.id}`; // in case the auth record was already gone
      await sql`update app.audit_log set user_id = null where user_id = ${target.id}`;
      await sql`update app.audit_log set detail = replace(detail::text, ${target.email}::text, '(deleted account)')::jsonb
                where club_id = ${clubId} and detail::text like ${`%${target.email}%`}`;
      if (children.length) await onLinksChanged(children);
      await audit(ctx, ctx.user.id, 'account_deleted', { role: target.role }, clubId);
      return target.id;
    }

    async function setTitle(ctx, target, rawTitle, clubId) {
      if (target.role === 'parent') throw new HttpError(400, 'Titles are for coaches and treasurers.');
      const title = text(rawTitle, 60) || null;
      await sql`update app.profiles set title = ${title} where id = ${target.id}`;
      await audit(ctx, ctx.user.id, 'title_changed', { for: target.email, title }, clubId);
      return title;
    }

    const targetIn = async (ctx) => {
      const [target] = isUuid(ctx.params.id) ? await sql`select * from app.profiles where id = ${ctx.params.id} and club_id = ${ctx.user.club_id}` : [];
      if (!target) throw new HttpError(404, 'Account not found.');
      return target;
    };

    r.get('/api/users', requireUser('coach', 'treasurer'), async (ctx) => {
      const rows = ctx.user.role === 'coach'
        ? await sql`select * from app.profiles where club_id = ${ctx.user.club_id} order by role, name, email`
        : await sql`select * from app.profiles where club_id = ${ctx.user.club_id} and role = 'parent' order by name, email`;
      const pending = new Set((await sql`select distinct t.user_id from app.tokens t join app.profiles p on p.id = t.user_id
                                         where p.club_id = ${ctx.user.club_id} and t.kind = 'invite' and t.used_at is null and t.expires_at > now()`).map((x) => x.user_id));
      const links = await sql`select ua.user_id, ua.athlete_id from app.user_athletes ua join app.profiles p on p.id = ua.user_id
                              where p.club_id = ${ctx.user.club_id} order by ua.athlete_id`;
      return rows.map((u) => ({
        id: u.id, email: u.email, name: u.name, role: u.role, title: u.title || null, status: u.status,
        mfaEnabled: Boolean(u.mfa_enabled), lastLoginAt: ms(u.last_login_at) || null, createdAt: ms(u.created_at),
        locked: isLocked(u), inviteActive: pending.has(u.id),
        athleteIds: u.role === 'parent' ? links.filter((l) => l.user_id === u.id).map((l) => l.athlete_id) : [],
      }));
    });

    const athleteIdsInClub = async (ctx) => {
      const ids = [...new Set((Array.isArray(ctx.body.athleteIds) ? ctx.body.athleteIds : []).map(toInt))];
      for (const id of ids) {
        if (!id || !(await sql`select 1 from app.athletes where id = ${id} and club_id = ${ctx.user.club_id}`).length) {
          throw new HttpError(400, 'One of the chosen athletes no longer exists.');
        }
      }
      return ids;
    };

    // Only coaches invite people. Linking a child to an account gives that account the child's medical
    // details, so it's restricted to the role that can already see them.
    r.post('/api/users/invite', requireUser('coach'), async (ctx) => {
      await enforceLimit(sql, 'inviteUser', ctx.user.id, LIMITS.inviteUser);
      const email = normEmail(ctx.body.email);
      const role = String(ctx.body.role ?? 'parent');
      const name = text(ctx.body.name, 80);
      if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
      if (!ROLES.has(role)) throw new HttpError(400, 'Choose parent, treasurer or coach.');
      assertUsable(await getClub(ctx.user.club_id));
      const athleteIds = role === 'parent' ? await athleteIdsInClub(ctx) : [];
      const title = role === 'parent' ? null : text(ctx.body.title, 60) || null;
      const { user, url } = await inviteUser({ clubId: ctx.user.club_id, email, name, role, title, athleteIds, createdBy: ctx.user.id });
      await audit(ctx, ctx.user.id, url ? 'invite_sent' : 'parent_linked', { to: email, role, athleteIds });
      const sent = url ? await emailInvite(user, url, ctx.user.name) : { emailed: false, problem: null };
      // If the email couldn't be sent, the coach gets the link to pass on themselves (they could
      // invite any address anyway, so it gives them nothing extra), plus the reason so it can be fixed
      return { userId: user.id, inviteUrl: url && !sent.emailed ? url : null, emailed: sent.emailed, emailProblem: sent.problem, linked: !url };
    });

    // A fresh invite (not yet accepted) or a password-reset link for someone
    r.post('/api/users/:id/reset-link', requireUser('coach', 'treasurer'), async (ctx) => {
      const target = await targetIn(ctx);
      if (ctx.user.role !== 'coach' && target.role !== 'parent') throw new HttpError(403, 'Only a coach can do that for staff accounts.');
      if (target.status === 'disabled') throw new HttpError(409, 'That account is switched off. Turn it back on first.');
      const kind = target.status === 'invited' ? 'invite' : 'reset';
      const url = await issueToken(target, kind, ctx.user.id);
      await audit(ctx, ctx.user.id, kind === 'invite' ? 'invite_resent' : 'reset_link_created', { for: target.email });
      const sent = kind === 'invite' ? await emailInvite(target, url, ctx.user.name) : { emailed: await emailReset(target, url), problem: null };
      // A password-reset link is never shown to staff: whoever holds it can take over that person's account.
      // A fresh invite (for someone who has never signed in) is shown to a coach if it couldn't be emailed.
      const showLink = kind === 'invite' && !sent.emailed && ctx.user.role === 'coach';
      return { kind, emailed: sent.emailed, emailProblem: sent.emailed ? null : (sent.problem || (kind === 'reset' ? "The email couldn't be sent. Check the email set-up in Vercel." : null)), ...(showLink ? { url } : {}) };
    });

    // A staff member's job title, e.g. "Club Administrator" (coaches can change it; blank = the role's name)
    r.put('/api/users/:id/title', requireUser('coach'), async (ctx) => {
      const target = await targetIn(ctx);
      return { title: await setTitle(ctx, target, ctx.body.title, ctx.user.club_id) };
    });

    // Coach or treasurer access (not for yourself, so a coach can't lock themselves out)
    r.put('/api/users/:id/role', requireUser('coach'), async (ctx) => {
      const target = await targetIn(ctx);
      if (target.id === ctx.user.id) throw new HttpError(400, "You can't change your own access. Ask another coach.");
      return { role: await changeRole(ctx, target, String(ctx.body.role || ''), ctx.user.club_id) };
    });

    r.post('/api/users/:id/status', requireUser('coach'), async (ctx) => {
      const target = await targetIn(ctx);
      if (target.id === ctx.user.id) throw new HttpError(400, "You can't switch off your own account.");
      return { status: await setAccountStatus(ctx, target, ctx.body.status === 'active', ctx.user.club_id) };
    });

    r.post('/api/users/:id/reset-2fa', requireUser('coach'), async (ctx) => {
      const target = await targetIn(ctx);
      if (target.id === ctx.user.id) throw new HttpError(400, "You can't reset your own two-step verification here.");
      await ctx.provider.mfaRemoveAll(target.id);
      await forgetAllDevices(target.id);
      await sql.begin(async (tx) => {
        await tx`update app.profiles set mfa_enabled = false where id = ${target.id}`;
        await tx`delete from app.recovery_codes where user_id = ${target.id}`;
        await tx`delete from app.sessions where user_id = ${target.id}`;
      });
      await audit(ctx, ctx.user.id, '2fa_reset_by_coach', { for: target.email });
      return { ok: true };
    });

    // Fix someone else's name: coaches for anyone, the treasurer for families
    r.put('/api/users/:id/name', requireUser('coach', 'treasurer'), async (ctx) => {
      const target = await targetIn(ctx);
      if (ctx.user.role !== 'coach' && target.role !== 'parent') throw new HttpError(403, 'Only a coach can rename staff accounts.');
      const name = cleanName(ctx.body.name);
      await sql`update app.profiles set name = ${name} where id = ${target.id}`;
      await audit(ctx, ctx.user.id, 'name_changed', { for: target.email });
      return { id: target.id, name };
    });

    r.put('/api/users/:id/athletes', requireUser('coach'), async (ctx) => {
      const target = await targetIn(ctx).catch(() => null);
      if (!target || target.role !== 'parent') throw new HttpError(404, 'Parent account not found.');
      const ids = await athleteIdsInClub(ctx);
      const before = await linkedIds(target.id);
      await sql.begin(async (tx) => {
        await tx`delete from app.user_athletes where user_id = ${target.id}`;
        for (const id of ids) await tx`insert into app.user_athletes (user_id, athlete_id) values (${target.id}, ${id})`;
      });
      await onLinksChanged([...before, ...ids]);
      await audit(ctx, ctx.user.id, 'parent_links_changed', { for: target.email, athleteIds: ids });
      return { athleteIds: ids };
    });

    // Permanently remove someone's account. Switch it off first, so nobody is removed by a single mis-tap.
    r.delete('/api/users/:id', requireUser('coach'), async (ctx) => {
      const target = await targetIn(ctx);
      if (target.id === ctx.user.id) throw new HttpError(400, "You can't delete your own account here.");
      return { deleted: await deleteAccount(ctx, target, ctx.user.club_id) };
    });

    // ----- The platform owner: a club's staff (coaches and treasurers, never parents or members) -----

    const ownerTarget = async (ctx) => {
      const clubId = toInt(ctx.params.clubId);
      const [target] = clubId && isUuid(ctx.params.userId)
        ? await sql`select * from app.profiles where id = ${ctx.params.userId} and club_id = ${clubId} and role in ('coach', 'treasurer')` : [];
      if (!target) throw new HttpError(404, 'Account not found.');
      return { target, clubId };
    };

    r.get('/api/owner/clubs/:clubId/people', requireUser('owner'), async (ctx) => {
      const clubId = toInt(ctx.params.clubId);
      if (!clubId || !(await getClub(clubId))) throw new HttpError(404, 'Club not found.');
      const rows = await sql`select * from app.profiles where club_id = ${clubId} and role in ('coach', 'treasurer') order by role, name, email`;
      return rows.map((u) => ({
        id: u.id, email: u.email, name: u.name, role: u.role, title: u.title || null, status: u.status,
        mfaEnabled: Boolean(u.mfa_enabled), lastLoginAt: ms(u.last_login_at) || null,
      }));
    });
    r.put('/api/owner/clubs/:clubId/people/:userId/role', requireUser('owner'), async (ctx) => {
      const { target, clubId } = await ownerTarget(ctx);
      return { role: await changeRole(ctx, target, String(ctx.body.role || ''), clubId) };
    });
    r.put('/api/owner/clubs/:clubId/people/:userId/title', requireUser('owner'), async (ctx) => {
      const { target, clubId } = await ownerTarget(ctx);
      return { title: await setTitle(ctx, target, ctx.body.title, clubId) };
    });
    r.post('/api/owner/clubs/:clubId/people/:userId/status', requireUser('owner'), async (ctx) => {
      const { target, clubId } = await ownerTarget(ctx);
      return { status: await setAccountStatus(ctx, target, ctx.body.status === 'active', clubId) };
    });
    // A fresh invite for someone who hasn't set up yet (the owner gets the link if email fails)
    r.post('/api/owner/clubs/:clubId/people/:userId/invite', requireUser('owner'), async (ctx) => {
      const { target, clubId } = await ownerTarget(ctx);
      if (target.status !== 'invited') throw new HttpError(409, 'They have already set up their account. They can use "Forgot password" if needed.');
      const url = await issueToken(target, 'invite', ctx.user.id);
      const sent = await emailInvite(target, url, platformName);
      await audit(ctx, ctx.user.id, 'invite_resent', { for: target.email }, clubId);
      return { emailed: sent.emailed, emailProblem: sent.problem, inviteUrl: sent.emailed ? null : url };
    });
    r.delete('/api/owner/clubs/:clubId/people/:userId', requireUser('owner'), async (ctx) => {
      const { target, clubId } = await ownerTarget(ctx);
      return { deleted: await deleteAccount(ctx, target, clubId) };
    });

    // Activity log for the club. IP addresses are kept for security checks but not shown.
    r.get('/api/audit', requireUser('coach'), async (ctx) => (await sql`
      select a.id, a.at, a.action, a.detail, u.email as "userEmail"
      from app.audit_log a left join app.profiles u on u.id = a.user_id
      where a.club_id = ${ctx.user.club_id} order by a.id desc limit 300`).map((row) => ({ ...row, at: ms(row.at) })));
  }

  return {
    routes, loadSession, requireUser, audit, inviteUser, publicUser, athleteIdsFor, emailInvite,
    revokeAllSessions, saveTokens, getClub, getProfile, provider, SESSION_POLICY, setOnLinksChanged,
  };
}
