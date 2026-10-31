// The platform side: clubs signing up, their branding, paying for the app (to the platform owner),
// connecting their own Stripe account for parent fees, and the owner's console.

import { HttpError, enforceLimit, hitLimit, toInt } from './http.js';
import {
  canUse, cleanBranding, publicClub, text, isEmail, normEmail,
  defaultPriceNzd, monthlyPriceNzd, setupFeeNzd, setupFeeDueNzd, toCents,
} from './rules.js';

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

  const clubOf = async (ctx) => {
    if (!ctx.user?.club_id) throw new HttpError(403, "Your account doesn't have access to that.");
    return auth.getClub(ctx.user.club_id);
  };
  const needStripe = () => {
    if (!stripe) throw new HttpError(503, `Online subscriptions aren't switched on yet. Please contact ${process.env.OWNER_CONTACT || 'the app provider'}.`);
  };
  const mergeBilling = (clubId, fields) => sql`update app.clubs set billing = billing || ${sql.json(fields)} where id = ${clubId}`;

  // cardFee: who pays Stripe's card fee, chosen when the club signs up ('club' or 'parents')
  async function createClub({ name, sport, status, cardFee = 'club' }) {
    const words = DEFAULT_WORDS[sport] || {};
    const branding = cleanBranding({ ...(words.group ? { group: words.group } : {}), ...(words.member ? { member: words.member } : {}), colour: 'indigo' }, {});
    const settings = { payments: { cardFee: cardFee === 'parents' ? 'parents' : 'club' } };
    const [row] = await sql`insert into app.clubs (name, sport, status, branding, settings) values (${name}, ${sport}, ${status}, ${sql.json(branding)}, ${sql.json(settings)}) returning id`;
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
             (select count(*)::int from app.profiles p where p.club_id = c.id) as users,
             (select count(*)::int from app.platform_charges x where x.club_id = c.id and x.status = 'open') as open_charges,
             (select coalesce(sum(amount_cents), 0)::int from app.platform_charges x where x.club_id = c.id and x.status = 'open') as open_cents
      from app.clubs c where c.id = ${id}`;
    if (!c) return null;
    const [coach] = await sql`select email, name from app.profiles where club_id = ${id} and role = 'coach' order by created_at limit 1`;
    return {
      id: c.id, name: c.name, sport: c.sport, status: c.status, createdAt: new Date(c.created_at).getTime(),
      athletes: c.athletes, users: c.users, contact: coach || null,
      subscriptionStatus: c.billing.subscriptionStatus || null, renewsOn: c.billing.renewsOn || null,
      pricing: {
        monthlyPriceNzd: monthlyPriceNzd(c), customMonthly: c.billing.monthlyPriceNzd != null,
        setupFeeNzd: setupFeeNzd(c), customSetupFee: c.billing.setupFeeNzd != null,
        setupFeePaid: Boolean(c.billing.setupFeePaid), setupFeeInvoiced: Boolean(c.billing.setupFeeInvoiced),
      },
      openCharges: c.open_charges, openChargesNzd: c.open_cents / 100,
    };
  }

  // ---------- Charging a club (set-up fees and one-off charges) ----------
  // Clubs get an email with a secure Stripe card payment page and/or your bank details, and the
  // request shows in their Settings. Card payments are marked paid automatically.

  async function platformCustomer(club, email) {
    if (club.billing.platformCustomerId) return club.billing.platformCustomerId;
    const id = (await stripe.customers.create({ name: club.name, email: email || undefined, metadata: { clubId: String(club.id), kind: 'platform' } })).id;
    await mergeBilling(club.id, { platformCustomerId: id });
    return id;
  }

  // ---------- How clubs pay you: card (Stripe) and/or bank transfer ----------

  const PAYMENT_DEFAULTS = { card: true, bank: false, bankAccountName: '', bankAccountNumber: '', instructions: '' };
  async function paymentSettings() {
    const [row] = await sql`select value from app.platform_settings where key = 'payment'`;
    return { ...PAYMENT_DEFAULTS, ...(row?.value || {}) };
  }
  // What's actually available right now
  const methodsFrom = (s) => ({
    card: Boolean(stripe) && s.card !== false,
    bank: Boolean(s.bank && s.bankAccountNumber),
  });
  const bankView = (s) => (methodsFrom(s).bank
    ? { accountName: s.bankAccountName, accountNumber: s.bankAccountNumber, instructions: s.instructions || '' }
    : null);

  const chargeView = (c, settings = null) => ({
    id: c.id, kind: c.kind, description: c.description, amountNzd: c.amount_cents / 100, status: c.status,
    reference: c.reference || null, paidMethod: c.paid_method || null,
    payUrl: c.status === 'open' ? c.pay_url : null,
    bank: c.status === 'open' && settings ? bankView(settings) : null,
    createdAt: new Date(c.created_at).getTime(), paidAt: c.paid_at ? new Date(c.paid_at).getTime() : null,
  });

  const needPaymentMethod = (methods) => {
    if (!methods.card && !methods.bank) {
      throw new HttpError(503, "Set up how clubs pay you first: add your bank details in Owner Console → Payment details, or add your Stripe keys in Vercel (STRIPE_SECRET_KEY) for card payments.");
    }
  };

  async function chargeClub(ctx, club, { amountNzd, description, kind }) {
    const settings = await paymentSettings();
    const methods = methodsFrom(settings);
    needPaymentMethod(methods);
    const coaches = await sql`select email, name from app.profiles where club_id = ${club.id} and role = 'coach' and status <> 'disabled' order by created_at`;
    let [row] = await sql`insert into app.platform_charges (club_id, kind, description, amount_cents, created_by)
                          values (${club.id}, ${kind}, ${description}, ${toCents(amountNzd)}, ${ctx.user.id}) returning *`;
    // A short reference for bank transfers (fits the 12 characters NZ banks allow)
    [row] = await sql`update app.platform_charges set reference = ${`INV${String(row.id).padStart(5, '0')}`} where id = ${row.id} returning *`;
    try {
      if (methods.card) {
        const customer = await platformCustomer(club, coaches[0]?.email);
        const meta = { kind: 'platform_charge', chargeKind: kind, clubId: String(club.id), chargeId: String(row.id) };
        const invoice = await stripe.invoices.create({
          customer, collection_method: 'send_invoice', days_until_due: 14, auto_advance: false,
          pending_invoice_items_behavior: 'exclude', description: `${platformName}: ${description} (ref ${row.reference})`, metadata: meta,
        });
        await stripe.invoiceItems.create({ customer, invoice: invoice.id, amount: toCents(amountNzd), currency: 'nzd', description });
        const finalised = await stripe.invoices.finalizeInvoice(invoice.id);
        [row] = await sql`update app.platform_charges set stripe_ref = ${invoice.id}, pay_url = ${finalised.hosted_invoice_url || null}
                          where id = ${row.id} returning *`;
      }
      if (kind === 'setup') await mergeBilling(club.id, { setupFeeInvoiced: true });
      const amount = `$${Number(amountNzd).toFixed(2)}`;
      const bank = bankView(settings);
      const ways = [
        row.pay_url && `Pay securely by card:\n${row.pay_url}`,
        bank && `Pay by bank transfer:\n  Account name: ${bank.accountName}\n  Account number: ${bank.accountNumber}\n  Reference: ${row.reference}${bank.instructions ? `\n  ${bank.instructions}` : ''}`,
      ].filter(Boolean).join('\n\nOr\n\n');
      for (const coach of coaches) {
        await mailer.send({
          to: coach.email,
          subject: `Payment request from ${platformName}: ${amount} (ref ${row.reference})`,
          text: `Hi ${coach.name || 'there'},\n\n${platformName} has sent ${club.name} a payment request:\n\n${description}: ${amount} NZD\nReference: ${row.reference}\nPlease pay within 14 days.\n\n${ways}\n\nYou can also find it in the app under Settings.\n`,
        });
      }
      await audit(ctx, ctx.user.id, 'owner_charged_club', { club: club.name, amountNzd, kind }, club.id);
      return chargeView(row, settings);
    } catch (err) {
      await sql`delete from app.platform_charges where id = ${row.id} and stripe_ref is null`;
      throw err;
    }
  }

  // A charge was paid (Stripe told us, or the owner saw a bank transfer arrive)
  async function markChargePaid(where, method) {
    const [charge] = where.id
      ? await sql`update app.platform_charges set status = 'paid', paid_at = now(), pay_url = null, paid_method = ${method}
                  where id = ${where.id} and status = 'open' returning *`
      : await sql`update app.platform_charges set status = 'paid', paid_at = now(), pay_url = null, paid_method = ${method}
                  where stripe_ref = ${where.stripeRef} and status = 'open' returning *`;
    if (charge?.kind === 'setup') await mergeBilling(charge.club_id, { setupFeePaid: true });
    return charge;
  }

  const cleanAmount = (v, { allowZero = false, label = 'amount' } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < (allowZero ? 0 : 0.5) || n > 100000 || Math.round(n * 100) !== n * 100) {
      throw new HttpError(400, `Enter the ${label} in dollars, e.g. 49 or 49.50${allowZero ? ' (0 for none)' : ''}.`);
    }
    return n;
  };

  function routes(r) {
    // Public: what the sign-in page shows
    r.get('/api/platform', () => ({ name: platformName, priceNzd: defaultPriceNzd(), sports: SPORTS, signupOpen: process.env.SIGNUP_OPEN !== 'false' }));

    // Public: a new club signs up. A confirmation email proves the address before any password exists.
    r.post('/api/signup', async (ctx) => {
      if (process.env.SIGNUP_OPEN === 'false') throw new HttpError(403, 'New club sign-ups are closed at the moment.');
      await enforceLimit(sql, 'signupIp', ctx.ip, LIMITS.signupIp, 'Too many sign-ups from here. Please try again later.');
      const { clubName, sport } = cleanClubDetails(ctx.body);
      const name = text(ctx.body.name, 80);
      const email = normEmail(ctx.body.email);
      if (!name) throw new HttpError(400, 'Enter your name.');
      if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
      const generic = { ok: true, message: `Check your email. We've sent ${email} a link to confirm the address and choose a password. It works for 7 days.` };
      if (!(await hitLimit(sql, 'signupEmail', email, LIMITS.signupEmail)).allowed) return generic;

      // Same reply, in the same time, whether or not the email is already used: the work happens after the reply
      ctx.after(async () => {
        if ((await sql`select 1 from app.profiles where email = ${email}`).length) {
          await mailer.send({ to: email, subject: `You already have a ${platformName} account`, text: `Hi,\n\nSomeone (hopefully you) tried to create a new club with this email address, but it already has an account.\n\nSign in, or use "Forgot password" on the sign-in page. If this wasn't you, you can ignore this email.\n` });
          return;
        }
        const clubId = await createClub({ name: clubName, sport, status: 'preview', cardFee: ctx.body.cardFee });
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
          text: `Hi ${name},\n\nThanks for creating ${clubName} on ${platformName}. Confirm your email and choose a password here (the link works for 7 days, once):\n${invited.url}\n\nYou can look around with sample data straight away. Subscribe from Settings whenever you're ready to use it with your club.\n\nIf you didn't sign up, ignore this email and nothing will happen.\n`,
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
      // The club's own monthly price (or the default), plus any set-up fee still due, charged once
      const setupDue = setupFeeDueNzd(club);
      const meta = { kind: 'platform', clubId: String(club.id) };
      const line = process.env.PLATFORM_PRICE_ID && club.billing.monthlyPriceNzd == null
        ? { price: process.env.PLATFORM_PRICE_ID, quantity: 1 }
        : { quantity: 1, price_data: { currency: 'nzd', unit_amount: toCents(monthlyPriceNzd(club)), recurring: { interval: 'month' }, product_data: { name: `${platformName} — club subscription` } } };
      const lines = [line];
      if (setupDue > 0) lines.push({ quantity: 1, price_data: { currency: 'nzd', unit_amount: toCents(setupDue), product_data: { name: `${platformName} — set-up fee (one-off)` } } });
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription', customer, line_items: lines,
        metadata: { ...meta, setupFeeCents: String(toCents(setupDue)) }, subscription_data: { metadata: meta },
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
        // The club's own full Stripe account (what Stripe used to call "Standard"): the club pays
        // Stripe's fees directly and Stripe carries the risk of losses, so the platform pays no
        // Connect account or payout fees and isn't liable for a club's refunds or chargebacks
        account = (await stripe.accounts.create({
          country: 'NZ', email: ctx.user.email,
          controller: { fees: { payer: 'account' }, losses: { payments: 'stripe' }, requirement_collection: 'stripe', stripe_dashboard: { type: 'full' } },
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
      return { priceNzd: defaultPriceNzd(), setupFeeNzd: Number(process.env.PLATFORM_SETUP_FEE_NZD || 0), stripe: Boolean(stripe), payMethods: methodsFrom(await paymentSettings()), clubs };
    });

    const clubParam = async (ctx) => {
      const id = toInt(ctx.params.id);
      const c = id ? await auth.getClub(id) : null;
      if (!c) throw new HttpError(404, 'Club not found.');
      return c;
    };

    // The owner adds a person to run a club (a treasurer, or another coach) with their own title,
    // e.g. "Treasurer" or "Club Administrator". They get an email to set their password.
    // Staff only: parents are always invited by the club's own coaches.
    r.post('/api/owner/clubs/:id/members', requireUser('owner'), async (ctx) => {
      const c = await clubParam(ctx);
      const email = normEmail(ctx.body.email);
      const name = text(ctx.body.name, 80);
      const role = String(ctx.body.role || '');
      const title = text(ctx.body.title, 60) || null;
      if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
      if (role !== 'treasurer' && role !== 'coach') throw new HttpError(400, 'Choose treasurer or coach.');
      const invited = await auth.inviteUser({ clubId: c.id, email, name, role, title, createdBy: ctx.user.id });
      await audit(ctx, ctx.user.id, 'owner_added_member', { role, title }, c.id);
      const sent = invited.url ? await auth.emailInvite(invited.user, invited.url, platformName) : { emailed: false, problem: null };
      return {
        role, title, alreadyMember: !invited.url, emailed: sent.emailed, emailProblem: sent.problem,
        // If the email couldn't be sent, the owner gets the link to pass on
        inviteUrl: invited.url && !sent.emailed ? invited.url : null,
      };
    });

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
      const pricing = {};
      if (ctx.body.monthlyPriceNzd !== undefined && ctx.body.monthlyPriceNzd !== '' && ctx.body.monthlyPriceNzd !== null) pricing.monthlyPriceNzd = cleanAmount(ctx.body.monthlyPriceNzd, { allowZero: true, label: 'monthly price' });
      if (ctx.body.setupFeeNzd !== undefined && ctx.body.setupFeeNzd !== '' && ctx.body.setupFeeNzd !== null) pricing.setupFeeNzd = cleanAmount(ctx.body.setupFeeNzd, { allowZero: true, label: 'set-up fee' });
      const free = ctx.body.free !== false;
      if (free && pricing.setupFeeNzd > 0) needPaymentMethod(methodsFrom(await paymentSettings())); // a free club's set-up fee is requested straight away
      const clubId = await createClub({ name: clubName, sport, status: free ? 'comped' : 'preview', cardFee: ctx.body.cardFee });
      if (Object.keys(pricing).length) await mergeBilling(clubId, pricing);
      let invited;
      try {
        invited = await auth.inviteUser({ clubId, email, name, role: 'coach', createdBy: ctx.user.id });
      } catch (err) {
        await sql`delete from app.clubs where id = ${clubId}`;
        throw err;
      }
      await audit(ctx, ctx.user.id, 'owner_created_club', { club: clubName }, clubId);
      const { emailed, problem: emailProblem } = await auth.emailInvite(invited.user, invited.url, platformName);
      // A club with free access never goes through checkout, so its set-up fee is invoiced now
      let charge = null;
      if (free && pricing.setupFeeNzd > 0) {
        charge = await chargeClub(ctx, await auth.getClub(clubId), { amountNzd: pricing.setupFeeNzd, description: 'Set-up fee', kind: 'setup' });
      }
      // If it couldn't be emailed, the owner gets the link to pass on: whoever opens it becomes the club's coach
      return { inviteUrl: emailed ? null : invited.url, emailed, emailProblem, charge, club: await clubSummary(clubId) };
    });

    // ----- Pricing and charges (owner) -----

    // A club's own monthly price and set-up fee. null puts it back to the default.
    r.put('/api/owner/clubs/:id/pricing', requireUser('owner'), async (ctx) => {
      const c = await clubParam(ctx);
      const next = {};
      for (const [key, label] of [['monthlyPriceNzd', 'monthly price'], ['setupFeeNzd', 'set-up fee']]) {
        if (!(key in ctx.body)) continue;
        const v = ctx.body[key];
        next[key] = v === null || v === '' ? null : cleanAmount(v, { allowZero: true, label });
      }
      const before = monthlyPriceNzd(c);
      await mergeBilling(c.id, next);
      const club = await auth.getClub(c.id);
      // A club already subscribed moves to the new price from its next bill (no charge for the change itself)
      let movedSubscription = false;
      const after = monthlyPriceNzd(club);
      if (after !== before && stripe && club.billing.platformSubscriptionId && ['active', 'trialing', 'past_due'].includes(club.billing.subscriptionStatus)) {
        const sub = await stripe.subscriptions.retrieve(club.billing.platformSubscriptionId);
        const item = sub.items.data[0];
        const product = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
        const price = await stripe.prices.create({ product, currency: 'nzd', unit_amount: toCents(after), recurring: { interval: 'month' } });
        await stripe.subscriptions.update(sub.id, { items: [{ id: item.id, price: price.id }], proration_behavior: 'none' });
        movedSubscription = true;
      }
      await audit(ctx, ctx.user.id, 'owner_set_pricing', { club: c.name, ...next }, c.id);
      return { club: await clubSummary(c.id), movedSubscription };
    });

    r.get('/api/owner/clubs/:id/charges', requireUser('owner'), async (ctx) => {
      const c = await clubParam(ctx);
      return (await sql`select * from app.platform_charges where club_id = ${c.id} order by id desc limit 100`).map((x) => chargeView(x));
    });

    // Charge a club any amount, any time (set-up fee or a one-off). The coach gets an email with a
    // secure Stripe payment page, and it shows in their Settings.
    r.post('/api/owner/clubs/:id/charges', requireUser('owner'), async (ctx) => {
      const c = await clubParam(ctx);
      const amountNzd = cleanAmount(ctx.body.amountNzd);
      const description = text(ctx.body.description, 120);
      if (!description) throw new HttpError(400, 'Say what the charge is for.');
      const kind = ctx.body.kind === 'setup' ? 'setup' : 'oneoff';
      return { charge: await chargeClub(ctx, c, { amountNzd, description, kind }), club: await clubSummary(c.id) };
    });

    // Cancel a charge that hasn't been paid
    r.post('/api/owner/charges/:id/void', requireUser('owner'), async (ctx) => {
      const id = toInt(ctx.params.id);
      const [charge] = id ? await sql`select * from app.platform_charges where id = ${id}` : [];
      if (!charge) throw new HttpError(404, 'Charge not found.');
      if (charge.status !== 'open') throw new HttpError(409, charge.status === 'paid' ? 'That charge has already been paid. Refund it in Stripe instead.' : 'That charge is already cancelled.');
      if (stripe && charge.stripe_ref?.startsWith('in_')) await stripe.invoices.voidInvoice(charge.stripe_ref);
      const [saved] = await sql`update app.platform_charges set status = 'void' where id = ${id} and status = 'open' returning *`;
      if (charge.kind === 'setup') await mergeBilling(charge.club_id, { setupFeeInvoiced: false });
      await audit(ctx, ctx.user.id, 'owner_voided_charge', { amountNzd: charge.amount_cents / 100 }, charge.club_id);
      return { charge: chargeView(saved || { ...charge, status: 'void' }) };
    });

    // A charge paid some other way (usually a bank transfer that has arrived)
    r.post('/api/owner/charges/:id/mark-paid', requireUser('owner'), async (ctx) => {
      const id = toInt(ctx.params.id);
      const [existing] = id ? await sql`select * from app.platform_charges where id = ${id}` : [];
      if (!existing) throw new HttpError(404, 'Charge not found.');
      if (existing.status !== 'open') throw new HttpError(409, existing.status === 'paid' ? 'That charge is already paid.' : 'That charge was cancelled.');
      // Close the card payment page too, so the club can't pay twice
      if (stripe && existing.stripe_ref?.startsWith('in_')) {
        await stripe.invoices.pay(existing.stripe_ref, { paid_out_of_band: true }).catch((err) => console.warn('Could not close the Stripe invoice', err.message));
      }
      const charge = await markChargePaid({ id }, ctx.body.method === 'other' ? 'other' : 'bank');
      await audit(ctx, ctx.user.id, 'owner_marked_paid', { amountNzd: existing.amount_cents / 100 }, existing.club_id);
      return { charge: chargeView(charge || existing) };
    });

    // How clubs pay you: card (Stripe), bank transfer, or both
    r.get('/api/owner/payment-settings', requireUser('owner'), async () => {
      const s = await paymentSettings();
      return { ...s, stripeConnected: Boolean(stripe), available: methodsFrom(s) };
    });

    r.put('/api/owner/payment-settings', requireUser('owner'), async (ctx) => {
      const b = ctx.body;
      const next = { ...(await paymentSettings()) };
      if ('card' in b) next.card = Boolean(b.card);
      if ('bank' in b) next.bank = Boolean(b.bank);
      if ('bankAccountName' in b) next.bankAccountName = text(b.bankAccountName, 80);
      if ('bankAccountNumber' in b) {
        const digits = String(b.bankAccountNumber || '').replace(/[\s-]/g, '');
        if (digits && !/^\d{15,16}$/.test(digits)) throw new HttpError(400, 'Enter a New Zealand bank account number, like 12-3456-0123456-00.');
        next.bankAccountNumber = digits ? `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 13)}-${digits.slice(13)}` : '';
      }
      if ('instructions' in b) next.instructions = text(b.instructions, 200);
      if (next.bank && (!next.bankAccountNumber || !next.bankAccountName)) throw new HttpError(400, 'Enter the account name and number to offer bank transfer.');
      await sql`insert into app.platform_settings (key, value) values ('payment', ${sql.json(next)})
                on conflict (key) do update set value = excluded.value, updated_at = now()`;
      await audit(ctx, ctx.user.id, 'owner_payment_settings_changed', { card: next.card, bank: next.bank }, null);
      return { ...next, stripeConnected: Boolean(stripe), available: methodsFrom(next) };
    });

    // A club sees what the platform has asked it to pay (coaches and the treasurer)
    r.get('/api/club/charges', requireUser('coach', 'treasurer'), async (ctx) => {
      const club = await clubOf(ctx);
      const settings = await paymentSettings();
      return (await sql`select * from app.platform_charges where club_id = ${club.id} and status <> 'void' order by id desc limit 50`).map((c) => chargeView(c, settings));
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
        // A set-up fee paid with the first subscription payment
        const setupCents = toInt(obj.metadata.setupFeeCents);
        if (setupCents) {
          await mergeBilling(clubId, { setupFeePaid: true });
          await sql`insert into app.platform_charges (club_id, kind, description, amount_cents, status, stripe_ref, paid_at)
                    values (${clubId}, 'setup', 'Set-up fee (paid with first subscription payment)', ${setupCents}, 'paid', ${`checkout:${obj.id}`}, now())
                    on conflict (stripe_ref) do nothing`;
        }
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
      case 'invoice.paid': {
        if (obj.metadata?.kind !== 'platform_charge') break; // subscription invoices are handled above
        const charge = await markChargePaid({ stripeRef: String(obj.id) }, 'card');
        if (charge) await audit(null, null, 'club_paid_charge', { amountNzd: charge.amount_cents / 100 }, charge.club_id);
        break;
      }
      case 'invoice.voided': {
        if (obj.metadata?.kind !== 'platform_charge') break;
        const [charge] = await sql`update app.platform_charges set status = 'void' where stripe_ref = ${String(obj.id)} and status = 'open' returning *`;
        if (charge?.kind === 'setup') await mergeBilling(charge.club_id, { setupFeeInvoiced: false });
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
