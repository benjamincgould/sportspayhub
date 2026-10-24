// The platform side: clubs signing up, their branding, paying for the app (to the platform owner),
// connecting their own Stripe account for parent fees, and the owner's console.

import { HttpError, enforceLimit, hitLimit, toInt } from './http.js';
import { canUse, cleanBranding, publicClub, text, isEmail, normEmail } from './rules.js';

const SPORTS = ['Swimming', 'Football', 'Rugby', 'Netball', 'Basketball', 'Hockey', 'Cricket', 'Athletics', 'Gymnastics', 'Tennis', 'Dance', 'Martial arts', 'Cycling', 'Rowing', 'Other'];
const DEFAULT_WORDS = {
  Swimming: { group: 'Squad', member: 'Swimmer' }, Football: { group: 'Team', member: 'Player' }, Rugby: { group: 'Team', member: 'Player' },
  Netball: { group: 'Team', member: 'Player' }, Basketball: { group: 'Team', member: 'Player' }, Hockey: { group: 'Team', member: 'Player' },
  Cricket: { group: 'Team', member: 'Player' }, Gymnastics: { group: 'Class', member: 'Gymnast' }, Dance: { group: 'Class', member: 'Dancer' },
  'Martial arts': { group: 'Class', member: 'Student' }, Tennis: { group: 'Group', member: 'Player' }, Rowing: { group: 'Crew', member: 'Rower' },
};
const LIMITS = {
  signupIp: { windowSec: 3600, max: 5 },
  signupEmail: { windowSec: 3600, max: 3 },
};

export function createClubs({ sql, auth, mailer, stripe = null, config }) {
  const { requireUser, audit } = auth;
  const { appUrl, platformName } = config;
  const priceNzd = Number(process.env.PLATFORM_PRICE_NZD || 49);

  const clubOf = async (ctx) => {
    if (!ctx.user?.club_id) throw new HttpError(403, "Your account doesn't have access to that.");
    return auth.getClub(ctx.user.club_id);
  };
  const needStripe = () => {
    if (!stripe) throw new HttpError(503, `Online subscriptions aren't switched on yet. Please contact ${process.env.OWNER_CONTACT || 'the app provider'}.`);
  };
  const mergeBilling = (clubId, fields) => sql`update app.clubs set billing = billing || ${sql.json(fields)} where id = ${clubId}`;

  async function createClub({ name, sport, status }) {
    const words = DEFAULT_WORDS[sport] || {};
    const branding = cleanBranding({ ...(words.group ? { group: words.group } : {}), ...(words.member ? { member: words.member } : {}), colour: 'indigo' }, {});
    const [row] = await sql`insert into app.clubs (name, sport, status, branding) values (${name}, ${sport}, ${status}, ${sql.json(branding)}) returning id`;
    return row.id;
  }

  function cleanClubDetails(body) {
    const clubName = text(body.clubName, 80);
    const sport = text(body.sport, 40);
    if (!clubName) throw new HttpError(400, "Enter your club's name.");
    if (!sport) throw new HttpError(400, 'Choose your sport.');
    return { clubName, sport };
  }

  // Map a Stripe subscription to what the club can do. The owner's choices (free / switched off) always win.
  async function applyPlatformSubscription(clubId, sub) {
    const club = await auth.getClub(clubId);
    if (!club) return;
    const s = sub.status;
    const status = ['active', 'trialing'].includes(s) ? 'active'
      : ['past_due', 'incomplete'].includes(s) ? 'past_due'
      : ['canceled', 'unpaid', 'incomplete_expired'].includes(s) ? 'canceled' : club.status;
    const periodEnd = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
    const billing = {
      platformSubscriptionId: sub.id, subscriptionStatus: s,
      renewsOn: periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : club.billing.renewsOn || null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    };
    const ownerOverride = ['comped', 'suspended'].includes(club.status);
    await sql`update app.clubs set billing = billing || ${sql.json(billing)}, status = ${ownerOverride ? club.status : status} where id = ${clubId}`;
  }

  // Owner console summary for one club: counts only, never members or their details
  async function clubSummary(id) {
    const [c] = await sql`
      select c.*, (select count(*)::int from app.athletes a where a.club_id = c.id) as athletes,
             (select count(*)::int from app.profiles p where p.club_id = c.id) as users
      from app.clubs c where c.id = ${id}`;
    if (!c) return null;
    const [coach] = await sql`select email, name from app.profiles where club_id = ${id} and role = 'coach' order by created_at limit 1`;
    return {
      id: c.id, name: c.name, sport: c.sport, status: c.status, createdAt: new Date(c.created_at).getTime(),
      athletes: c.athletes, users: c.users, contact: coach || null,
      subscriptionStatus: c.billing.subscriptionStatus || null, renewsOn: c.billing.renewsOn || null,
    };
  }

  function routes(r) {
    // Public: what the sign-in page shows
    r.get('/api/platform', () => ({ name: platformName, priceNzd, sports: SPORTS, signupOpen: process.env.SIGNUP_OPEN !== 'false' }));

    // Public: a new club signs up. A confirmation email proves the address before any password exists.
    r.post('/api/signup', async (ctx) => {
      if (process.env.SIGNUP_OPEN === 'false') throw new HttpError(403, 'New club sign-ups are closed at the moment.');
      await enforceLimit(sql, 'signupIp', ctx.ip, LIMITS.signupIp, 'Too many sign-ups from here. Please try again later.');
      const { clubName, sport } = cleanClubDetails(ctx.body);
      const name = text(ctx.body.name, 80);
      const email = normEmail(ctx.body.email);
      if (!name) throw new HttpError(400, 'Enter your name.');
      if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
      const generic = { ok: true, message: `Check your email. We've sent ${email} a link to confirm the address and choose a password. It works for 3 days.` };
      if (!(await hitLimit(sql, 'signupEmail', email, LIMITS.signupEmail)).allowed) return generic;

      // Same reply, in the same time, whether or not the email is already used: the work happens after the reply
      ctx.after(async () => {
        if ((await sql`select 1 from app.profiles where email = ${email}`).length) {
          await mailer.send({ to: email, subject: `You already have a ${platformName} account`, text: `Hi,\n\nSomeone (hopefully you) tried to create a new club with this email address, but it already has an account.\n\nSign in, or use "Forgot password" on the sign-in page. If this wasn't you, you can ignore this email.\n` });
          return;
        }
        const clubId = await createClub({ name: clubName, sport, status: 'preview' });
        let invited;
        try {
          invited = await auth.inviteUser({ clubId, email, name, role: 'coach' });
        } catch (err) {
          await sql`delete from app.clubs where id = ${clubId}`;
          throw err;
        }
        await audit(ctx, invited.user.id, 'club_signed_up', { club: clubName });
        await mailer.send({
          to: email,
          subject: `Confirm your email to finish setting up ${clubName}`,
          text: `Hi ${name},\n\nThanks for creating ${clubName} on ${platformName}. Confirm your email and choose a password here (the link works for 3 days, once):\n${invited.url}\n\nYou can look around with sample data straight away. Subscribe from Settings whenever you're ready to use it with your club.\n\nIf you didn't sign up, ignore this email and nothing will happen.\n`,
        });
      });
      return generic;
    });

    // ----- The club's own settings (coach). Allowed while previewing, so they can see their branding -----

    r.put('/api/club', { bodyLimit: 400 * 1024 }, requireUser('coach'), async (ctx) => { // room for a 200 KB logo
      const club = await clubOf(ctx);
      let { name, sport } = club;
      if ('name' in ctx.body) { name = text(ctx.body.name, 80); if (!name) throw new HttpError(400, "Enter your club's name."); }
      if ('sport' in ctx.body) { sport = text(ctx.body.sport, 40); if (!sport) throw new HttpError(400, 'Choose your sport.'); }
      const branding = cleanBranding(ctx.body, club.branding);
      await sql`update app.clubs set name = ${name}, sport = ${sport}, branding = ${sql.json(branding)} where id = ${club.id}`;
      await audit(ctx, ctx.user.id, 'club_updated', { fields: Object.keys(ctx.body).slice(0, 10) });
      return { club: publicClub(await auth.getClub(club.id)) };
    });

    // ----- Paying the platform -----

    r.post('/api/club/subscribe', requireUser('coach'), async (ctx) => {
      const club = await clubOf(ctx);
      if (club.status === 'suspended') throw new HttpError(403, "This club's access has been switched off. Please contact the app provider.");
      if (canUse(club)) throw new HttpError(409, 'Your club already has access.');
      needStripe();
      let customer = club.billing.platformCustomerId;
      if (!customer) {
        customer = (await stripe.customers.create({ name: club.name, email: ctx.user.email, metadata: { clubId: String(club.id), kind: 'platform' } })).id;
        await mergeBilling(club.id, { platformCustomerId: customer });
      }
      const meta = { kind: 'platform', clubId: String(club.id) };
      const line = process.env.PLATFORM_PRICE_ID
        ? { price: process.env.PLATFORM_PRICE_ID, quantity: 1 }
        : { quantity: 1, price_data: { currency: 'nzd', unit_amount: Math.round(priceNzd * 100), recurring: { interval: 'month' }, product_data: { name: `${platformName} — club subscription` } } };
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription', customer, line_items: [line], metadata: meta, subscription_data: { metadata: meta },
        success_url: `${appUrl}/?subscribed=1`, cancel_url: `${appUrl}/?subscribed=0`,
      });
      await audit(ctx, ctx.user.id, 'platform_checkout_started');
      return { url: session.url };
    });

    r.post('/api/club/billing', requireUser('coach'), async (ctx) => {
      const club = await clubOf(ctx);
      needStripe();
      if (!club.billing.platformCustomerId) throw new HttpError(400, "Your club hasn't subscribed yet.");
      const session = await stripe.billingPortal.sessions.create({ customer: club.billing.platformCustomerId, return_url: `${appUrl}/` });
      return { url: session.url };
    });

    // ----- Club fees: connect the club's own Stripe account (Stripe Connect) -----

    r.post('/api/club/connect', requireUser('coach'), async (ctx) => {
      const club = await clubOf(ctx);
      if (!canUse(club)) throw new HttpError(402, 'Subscribe first, then connect your payments.');
      needStripe();
      let account = club.billing.connectAccountId;
      if (!account) {
        account = (await stripe.accounts.create({
          type: 'express', country: 'NZ', email: ctx.user.email,
          business_profile: { name: club.name },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          metadata: { clubId: String(club.id) },
        })).id;
        await mergeBilling(club.id, { connectAccountId: account });
      }
      const link = await stripe.accountLinks.create({ account, type: 'account_onboarding', refresh_url: `${appUrl}/?connect=retry`, return_url: `${appUrl}/?connect=done` });
      await audit(ctx, ctx.user.id, 'payments_connect_started');
      return { url: link.url };
    });

    r.post('/api/club/connect/refresh', requireUser('coach'), async (ctx) => {
      const club = await clubOf(ctx);
      if (!stripe || !club.billing.connectAccountId) return { club: publicClub(club) };
      const a = await stripe.accounts.retrieve(club.billing.connectAccountId);
      await mergeBilling(club.id, { connectChargesEnabled: Boolean(a.charges_enabled) });
      return { club: publicClub(await auth.getClub(club.id)) };
    });

    // ----- Owner console: every club, its status, free access, switching off -----

    r.get('/api/owner/clubs', requireUser('owner'), async () => {
      const ids = await sql`select id from app.clubs order by created_at desc`;
      const clubs = [];
      for (const { id } of ids) clubs.push(await clubSummary(id));
      return { priceNzd, clubs };
    });

    const clubParam = async (ctx) => {
      const id = toInt(ctx.params.id);
      const c = id ? await auth.getClub(id) : null;
      if (!c) throw new HttpError(404, 'Club not found.');
      return c;
    };

    r.post('/api/owner/clubs/:id/access', requireUser('owner'), async (ctx) => {
      const c = await clubParam(ctx);
      const access = ctx.body.access;
      let status;
      if (access === 'free') status = 'comped';
      else if (access === 'suspend') status = 'suspended';
      else if (access === 'normal') {
        // Back to whatever their subscription says
        const s = c.billing.subscriptionStatus;
        status = ['active', 'trialing'].includes(s) ? 'active' : ['past_due', 'incomplete'].includes(s) ? 'past_due' : s ? 'canceled' : 'preview';
      } else throw new HttpError(400, 'Choose free, normal or suspend.');
      await sql`update app.clubs set status = ${status} where id = ${c.id}`;
      await audit(ctx, ctx.user.id, `owner_set_${access}`, { club: c.name }, c.id);
      return clubSummary(c.id);
    });

    // The owner can set up a club for someone, e.g. one they're giving the app to for free
    r.post('/api/owner/clubs', requireUser('owner'), async (ctx) => {
      const { clubName, sport } = cleanClubDetails(ctx.body);
      const name = text(ctx.body.name, 80);
      const email = normEmail(ctx.body.email);
      if (!isEmail(email)) throw new HttpError(400, "Enter the coach's email address.");
      if ((await sql`select 1 from app.profiles where email = ${email}`).length) throw new HttpError(409, 'That email already has an account.');
      const clubId = await createClub({ name: clubName, sport, status: ctx.body.free === false ? 'preview' : 'comped' });
      let invited;
      try {
        invited = await auth.inviteUser({ clubId, email, name, role: 'coach', createdBy: ctx.user.id });
      } catch (err) {
        await sql`delete from app.clubs where id = ${clubId}`;
        throw err;
      }
      await audit(ctx, ctx.user.id, 'owner_created_club', { club: clubName }, clubId);
      const emailed = await auth.emailInvite(invited.user, invited.url, platformName);
      // Only shown if it couldn't be emailed (never in production): whoever opens it becomes the club's coach
      return { inviteUrl: emailed || config.production ? null : invited.url, emailed, club: await clubSummary(clubId) };
    });

    // Permanently delete a club and everything in it. The owner types the club's name to confirm.
    r.post('/api/owner/clubs/:id/delete', requireUser('owner'), async (ctx) => {
      const c = await clubParam(ctx);
      if (text(ctx.body.confirmName, 80) !== c.name) throw new HttpError(400, "Type the club's name exactly to confirm.");
      if (stripe && c.billing.platformSubscriptionId && ['active', 'trialing', 'past_due'].includes(c.billing.subscriptionStatus)) {
        await stripe.subscriptions.cancel(c.billing.platformSubscriptionId).catch((err) => console.warn('Could not cancel subscription', err.message));
      }
      // Everyone's sign-in accounts go first; their profiles, sessions and links go with them
      const people = await sql`select id from app.profiles where club_id = ${c.id}`;
      for (const p of people) await auth.provider.deleteUser(p.id);
      await sql.begin(async (tx) => {
        await tx`delete from app.clubs where id = ${c.id}`; // members, groups, ledger and anything left go with it
        await tx`delete from app.audit_log where club_id = ${c.id}`;
      });
      await audit(ctx, ctx.user.id, 'owner_deleted_club', { clubId: c.id }, null);
      return { deleted: c.id };
    });
  }

  // ---------- Stripe events for the platform's own account (club subscriptions) ----------

  const clubForCustomer = async (customerId) => (await sql`select id from app.clubs where billing->>'platformCustomerId' = ${String(customerId)}`)[0]?.id;

  async function handlePlatformEvent(event) {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.metadata?.kind !== 'platform' || !obj.subscription) break;
        const clubId = toInt(obj.metadata.clubId);
        const club = clubId && (await auth.getClub(clubId));
        if (!club) break;
        const sub = await stripe.subscriptions.retrieve(typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id);
        await mergeBilling(clubId, { platformCustomerId: typeof obj.customer === 'string' ? obj.customer : obj.customer?.id });
        await applyPlatformSubscription(clubId, sub);
        await audit(null, null, 'club_subscribed', { club: club.name }, clubId);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        if (obj.metadata?.kind !== 'platform') break;
        const clubId = toInt(obj.metadata.clubId) || (await clubForCustomer(obj.customer));
        if (clubId) await applyPlatformSubscription(clubId, event.type === 'customer.subscription.deleted' ? { ...obj, status: 'canceled' } : obj);
        break;
      }
      case 'invoice.payment_failed': {
        const clubId = await clubForCustomer(obj.customer);
        if (clubId) await sql`update app.clubs set status = 'past_due' where id = ${clubId} and status = 'active'`;
        break;
      }
      default:
        break;
    }
  }

  return { routes, handlePlatformEvent, createClub };
}
