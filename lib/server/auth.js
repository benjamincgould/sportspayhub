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
const INVITE_TTL = 72 * HOUR;
const RESET_TTL = 1 * HOUR;
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

  const revokeAllSessions = (userId) => sql`delete from app.sessions where user_id = ${userId}`;

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
      id: u.id, email: u.email, name: u.name, role: u.role,
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

  async function issueToken(user, kind, createdBy) {
    const token = randomToken(32);
    await sql`update app.tokens set used_at = now() where user_id = ${user.id} and kind = ${kind} and used_at is null`;
    await sql`insert into app.tokens (hash, user_id, kind, expires_at, created_by)
              values (${sha256(token)}, ${user.id}, ${kind}, ${new Date(Date.now() + (kind === 'invite' ? INVITE_TTL : RESET_TTL))}, ${createdBy ?? null})`;
    // The token travels in the URL fragment (#), which browsers never send to servers or put in referrer headers
    return `${appUrl}/#/${kind === 'invite' ? 'invite' : 'reset'}/${token}`;
  }

  async function findToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const [row] = await sql`select * from app.tokens where hash = ${sha256(token)} and used_at is null and expires_at > now()`;
    if (!row) return null;
    const user = await getProfile(row.user_id);
    if (!user || user.status === 'disabled') return null;
    return { row, user };
  }

  async function emailInvite(user, url, invitedBy) {
    const club = user.club_id ? (await getClub(user.club_id))?.name : null;
    const where = club ? `${club} on ${platformName}` : platformName;
    return mailer.send({
      to: user.email,
      subject: club ? `You're invited to ${club}` : `You're invited to ${platformName}`,
      text: `Hi ${user.name || 'there'},\n\n${invitedBy || 'The club'} has set up an account for you with ${where}.\n\nSet your password here (the link works for 3 days and can only be used once):\n${url}\n\nIf you weren't expecting this, you can ignore this email.\n`,
    });
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
  async function inviteUser({ clubId = null, email, name = '', role, athleteIds = [], createdBy = null }) {
    let [user] = await sql`select * from app.profiles where email = ${email}`;
    if (user) {
      if ((user.club_id ?? null) !== (clubId ?? null)) throw new HttpError(409, 'That email already uses the app with another club. Ask them for a different email address.');
      if (user.role !== role) throw new HttpError(409, `${email} already has a ${user.role} account.`);
      if (user.status === 'disabled') throw new HttpError(409, 'That account is switched off. Turn it back on first.');
      if (name && !user.name) await sql`update app.profiles set name = ${name} where id = ${user.id}`;
    } else {
      const id = await authAccountFor(email);
      try {
        [user] = await sql`insert into app.profiles (id, club_id, email, name, role, status)
                           values (${id}, ${clubId}, ${email}, ${name}, ${role}, 'invited') returning *`;
      } catch (err) {
        if (err.code === '23505') throw new HttpError(409, 'That email already has an account.');
        throw err;
      }
    }
    for (const id of athleteIds) {
      await sql`insert into app.user_athletes (user_id, athlete_id) values (${user.id}, ${id}) on conflict do nothing`;
    }
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

    r.post('/api/auth/logout', async (ctx) => {
      const userId = (ctx.user || ctx.pendingUser)?.id;
      await destroyCurrentSession(ctx, { revoke: true });
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
      if (!found) throw new HttpError(400, BAD_LINK);
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
      if (!found) throw new HttpError(400, BAD_LINK);
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
      const emailed = await emailInvite(user, url, platformName);
      // Only shown when email isn't set up (never in production, where email is required)
      return { emailed, inviteUrl: emailed || config.production ? null : url };
    });

    // ----- Team & access (staff) -----

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
        id: u.id, email: u.email, name: u.name, role: u.role, status: u.status,
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
      const { user, url } = await inviteUser({ clubId: ctx.user.club_id, email, name, role, athleteIds, createdBy: ctx.user.id });
      await audit(ctx, ctx.user.id, url ? 'invite_sent' : 'parent_linked', { to: email, role, athleteIds });
      const emailed = url ? await emailInvite(user, url, ctx.user.name) : false;
      // The link is only shown when it couldn't be emailed (never in production, where email is required)
      return { userId: user.id, inviteUrl: url && !emailed && !config.production ? url : null, emailed, linked: !url };
    });

    // A fresh invite (not yet accepted) or a password-reset link for someone
    r.post('/api/users/:id/reset-link', requireUser('coach', 'treasurer'), async (ctx) => {
      const target = await targetIn(ctx);
      if (ctx.user.role !== 'coach' && target.role !== 'parent') throw new HttpError(403, 'Only a coach can do that for staff accounts.');
      if (target.status === 'disabled') throw new HttpError(409, 'That account is switched off. Turn it back on first.');
      const kind = target.status === 'invited' ? 'invite' : 'reset';
      const url = await issueToken(target, kind, ctx.user.id);
      await audit(ctx, ctx.user.id, kind === 'invite' ? 'invite_resent' : 'reset_link_created', { for: target.email });
      const emailed = kind === 'invite' ? await emailInvite(target, url, ctx.user.name) : await emailReset(target, url);
      // A password-reset link is never shown to staff: whoever holds it can take over that person's account.
      // A fresh invite link is shown only to a coach, and only if it couldn't be emailed.
      const showLink = kind === 'invite' && !emailed && ctx.user.role === 'coach' && !config.production;
      return { kind, emailed, ...(showLink ? { url } : {}) };
    });

    r.post('/api/users/:id/status', requireUser('coach'), async (ctx) => {
      const target = await targetIn(ctx);
      if (target.id === ctx.user.id) throw new HttpError(400, "You can't switch off your own account.");
      const enable = ctx.body.status === 'active';
      const status = enable ? (target.password_changed_at ? 'active' : 'invited') : 'disabled';
      await ctx.provider.setBanned(target.id, !enable);
      await sql`update app.profiles set status = ${status}, failed_logins = 0, locked_until = null where id = ${target.id}`;
      if (!enable) await revokeAllSessions(target.id);
      await audit(ctx, ctx.user.id, enable ? 'account_enabled' : 'account_disabled', { for: target.email });
      return { status };
    });

    r.post('/api/users/:id/reset-2fa', requireUser('coach'), async (ctx) => {
      const target = await targetIn(ctx);
      if (target.id === ctx.user.id) throw new HttpError(400, "You can't reset your own two-step verification here.");
      await ctx.provider.mfaRemoveAll(target.id);
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
      await sql.begin(async (tx) => {
        await tx`delete from app.user_athletes where user_id = ${target.id}`;
        for (const id of ids) await tx`insert into app.user_athletes (user_id, athlete_id) values (${target.id}, ${id})`;
      });
      await audit(ctx, ctx.user.id, 'parent_links_changed', { for: target.email, athleteIds: ids });
      return { athleteIds: ids };
    });

    // Permanently remove someone's account. Switch it off first, so nobody is removed by a single mis-tap.
    r.delete('/api/users/:id', requireUser('coach'), async (ctx) => {
      const target = await targetIn(ctx);
      if (target.id === ctx.user.id) throw new HttpError(400, "You can't delete your own account here.");
      if (target.status === 'active') throw new HttpError(409, 'Switch the account off first, then delete it.');
      await ctx.provider.deleteUser(target.id); // the profile, sessions, links and recovery codes go with it
      await sql`delete from app.profiles where id = ${target.id}`; // in case the auth record was already gone
      await sql`update app.audit_log set user_id = null where user_id = ${target.id}`;
      await sql`update app.audit_log set detail = replace(detail::text, ${target.email}::text, '(deleted account)')::jsonb
                where club_id = ${ctx.user.club_id} and detail::text like ${`%${target.email}%`}`;
      await audit(ctx, ctx.user.id, 'account_deleted', { role: target.role });
      return { deleted: target.id };
    });

    // Activity log for the club. IP addresses are kept for security checks but not shown.
    r.get('/api/audit', requireUser('coach'), async (ctx) => (await sql`
      select a.id, a.at, a.action, a.detail, u.email as "userEmail"
      from app.audit_log a left join app.profiles u on u.id = a.user_id
      where a.club_id = ${ctx.user.club_id} order by a.id desc limit 300`).map((row) => ({ ...row, at: ms(row.at) })));
  }

  return {
    routes, loadSession, requireUser, audit, inviteUser, publicUser, athleteIdsFor, emailInvite,
    revokeAllSessions, saveTokens, getClub, getProfile, provider, SESSION_POLICY,
  };
}
