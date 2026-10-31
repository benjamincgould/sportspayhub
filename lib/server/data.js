// Club data: members, groups & timetables, bookings, attendance, ledger, settings.
// Every route checks the signed-in person's role AND club: nothing ever crosses from one club to
// another, and parents only ever receive their own children.

import { encrypt, decrypt } from './security.js';
import { HttpError, toInt } from './http.js';
import { assertUsable, sampleData, text, longText, isEmail, isPhone, cleanBankAccount, clubPaymentMethods, familyReference, cardFeeFor } from './rules.js';

const STAFF = new Set(['coach', 'treasurer']);
const FREQS = new Set(['weekly', 'fortnightly', 'monthly']);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (msg) => { throw new HttpError(400, msg); };
const todayIso = () => new Date().toISOString().slice(0, 10);
const addDaysIso = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export const DEFAULT_SETTINGS = {
  financialYearStart: '04-01',
  smsTemplate: 'Hi {ParentName}, missed payment of ${Amount} for {AthleteName}. Pay here: {PaymentLink}',
  emailTemplate: 'Dear {ParentName},\n\nPayment of ${Amount} for {AthleteName} is overdue.\n\nPlease update your billing details securely: {PaymentLink}',
};

// ---------- Groups ----------

export function cleanSquad(body, id) {
  const name = text(body.name, 80);
  if (!name) bad('Give the group a name.');
  const prices = ['weekly', 'fortnightly', 'monthly'].map((k) => Number(body[k]));
  if (prices.some((n) => !Number.isFinite(n) || n < 0 || n > 100000)) bad('Enter all three prices.');
  const capacity = body.capacity == null || body.capacity === '' ? null : Number(body.capacity);
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 500)) bad('Capacity must be a whole number.');
  const rawSessions = Array.isArray(body.sessions) ? body.sessions : [];
  if (rawSessions.length > 100) bad('That group has too many sessions.');

  const sessions = rawSessions.map((s) => {
    const day = Number(s?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) bad('Invalid session day.');
    if (!TIME.test(s.start) || !TIME.test(s.end) || s.end <= s.start) bad('Session finish time must be after the start time.');
    for (const d of [s.startsOn, s.endsOn]) if (d != null && !DATE.test(d)) bad('Invalid session date.');
    const sid = text(s.id, 60).replace(/[^\w-]/g, '');
    if (!sid) bad('Invalid session.');
    return {
      id: sid, seriesId: text(s.seriesId, 60).replace(/[^\w-]/g, '') || sid,
      day, start: s.start, end: s.end, location: text(s.location, 120),
      startsOn: s.startsOn || null, endsOn: s.endsOn || null,
      cancellations: (Array.isArray(s.cancellations) ? s.cancellations : []).slice(0, 200)
        .filter((c) => DATE.test(c?.date)).map((c) => ({ date: c.date, reason: text(c.reason, 120) })),
    };
  });

  return {
    id, name, level: text(body.level, 80), description: longText(body.description, 400),
    location: text(body.location, 120), capacity, coach: text(body.coach, 80),
    weekly: prices[0], fortnightly: prices[1], monthly: prices[2], sessions,
  };
}

// Series a group still runs (today or later), so parents can only pick real sessions
const liveSeriesIds = (squad, iso) => new Set(squad.sessions.filter((s) => !s.endsOn || s.endsOn >= iso).map((s) => s.seriesId));
const seriesInSquad = (squad, seriesId) => Boolean(squad) && squad.sessions.some((s) => s.seriesId === seriesId);

export function createData({ sql, auth, stripe = null, appUrl }) {
  const { requireUser, audit } = auth;

  // Signed-in member of a club (the platform owner has no club data)
  const inClub = (ctx) => { if (!ctx.user?.club_id) throw new HttpError(403, "Your account doesn't have access to that."); };
  const member = (...roles) => [requireUser(...roles), inClub];
  const clubOf = (ctx) => auth.getClub(ctx.user.club_id);
  // ...and the club has access (subscribed or given free access): previews are look-only
  const usable = async (ctx) => assertUsable(await clubOf(ctx));

  // ---------- Reading ----------

  const allSquads = async (clubId) => (await sql`select * from app.squads where club_id = ${clubId} order by id`).map((r) => ({ ...r.data, id: r.id }));
  const getSquad = async (id, clubId) => {
    const n = toInt(id);
    const [r] = n ? await sql`select * from app.squads where id = ${n} and club_id = ${clubId}` : [];
    return r ? { ...r.data, id: r.id } : null;
  };
  const saveSquad = async (sq, clubId) => { const { id, ...rest } = sq; await sql`update app.squads set data = ${sql.json(rest)} where id = ${id} and club_id = ${clubId}`; };

  // Contact and medical details are encrypted in the database (AES-256-GCM); only training and
  // billing fields are stored as plain data.
  const PRIVATE = ['parent', 'phone', 'email', 'address', 'emergency', 'allergies', 'medication'];
  const splitPrivate = (a) => {
    const priv = {};
    const rest = {};
    for (const [k, v] of Object.entries(a)) (PRIVATE.includes(k) ? priv : rest)[k] = v;
    for (const k of PRIVATE) priv[k] ??= '';
    return { priv, rest };
  };
  const readAthlete = (row) => ({
    ...Object.fromEntries(PRIVATE.map((k) => [k, ''])), ...row.data,
    ...(row.private_enc ? JSON.parse(decrypt(row.private_enc)) : {}), id: row.id, clubId: row.club_id, familyId: row.family_id ?? null,
  });
  const getAthlete = async (id) => {
    const n = toInt(id);
    const [r] = n ? await sql`select * from app.athletes where id = ${n}` : [];
    return r ? readAthlete(r) : null;
  };
  const writeAthlete = async (a, q = sql) => {
    const { id, clubId, familyId, ...fields } = a;
    const { priv, rest } = splitPrivate(fields);
    await q`update app.athletes set data = ${sql.json(rest)}, private_enc = ${encrypt(JSON.stringify(priv))} where id = ${id}`;
  };

  const owns = async (user, athleteId) => (await sql`select 1 from app.user_athletes where user_id = ${user.id} and athlete_id = ${athleteId}`).length > 0;

  // Loads a member the signed-in person is allowed to touch, or refuses
  async function athleteFor(ctx, id, { staffOnly = false, coachOrOwner = false } = {}) {
    const u = ctx.user;
    let a = await getAthlete(id);
    if (a && a.clubId !== u.club_id) a = null; // other clubs' members simply don't exist
    const isParent = u.role === 'parent' && a && (await owns(u, a.id));
    const allowed = staffOnly ? STAFF.has(u.role)
      : coachOrOwner ? (u.role === 'coach' || isParent)
      : (STAFF.has(u.role) || isParent);
    // Same answer for "doesn't exist" and "not yours", so ids can't be probed
    if (!a || !allowed) throw new HttpError(404, 'Athlete not found.');
    return a;
  }

  // ---------- Families ----------
  // Children who share a parent account are one family: one schedule, one way of paying (set by
  // the club), one status, one bank reference and, for card, one Stripe subscription.

  const getFamily = async (id) => (toInt(id) ? (await sql`select * from app.families where id = ${toInt(id)}`)[0] || null : null);
  const familyMembers = async (familyId) => (await sql`select * from app.athletes where family_id = ${familyId} order by id`).map(readAthlete);
  const setFamilyBilling = (familyId, fields) => sql`update app.families set billing = billing || ${sql.json(fields)} where id = ${familyId}`;
  const familyByCustomer = async (customerId, clubId) => (await sql`
    select * from app.families where club_id = ${clubId} and billing->>'customerId' = ${String(customerId)} limit 1`)[0] || null;

  async function createFamily(clubId, { frequency = 'weekly', status = 'paid', payMethod = null, surname = '' } = {}) {
    const [f] = await sql`insert into app.families (club_id, frequency, status, pay_method)
                          values (${clubId}, ${FREQS.has(frequency) ? frequency : 'weekly'}, ${status}, ${payMethod}) returning *`;
    const [saved] = await sql`update app.families set reference = ${familyReference(surname, f.id)} where id = ${f.id} returning *`;
    return saved;
  }
  const surnameOf = (name) => String(name || '').trim().split(/\s+/).pop() || '';

  // The family a member belongs to (made if they somehow have none)
  async function familyOf(a) {
    const existing = a.familyId ? await getFamily(a.familyId) : null;
    if (existing) return existing;
    const f = await createFamily(a.clubId, { frequency: a.frequency, surname: surnameOf(a.name) });
    await sql`update app.athletes set family_id = ${f.id} where id = ${a.id}`;
    return f;
  }

  const subscriptionActive = (f) => Boolean(f?.billing?.subscriptionId) && f.billing.subscriptionActive !== false;

  // The way a family pays: the club's choice for them, or the club's default
  const methodFor = (f, methods) => {
    const allowed = { card: methods.card, bank: Boolean(methods.bank) };
    if (f?.pay_method && allowed[f.pay_method]) return f.pay_method;
    if (allowed.card && !allowed.bank) return 'card';
    if (allowed.bank && !allowed.card) return 'bank';
    return allowed[methods.defaultMethod] ? methods.defaultMethod : 'bank';
  };

  // Keeps families matching parent links: children linked (directly, or through a chain of shared
  // parent accounts) are one family; a child linked to nobody in their family gets a family of
  // their own. Called whenever parent links change.
  async function regroupFamilies(athleteIds) {
    const pending = [...new Set(athleteIds.map(toInt).filter(Boolean))];
    const components = [];
    const seen = new Set();
    // Include current family-mates, so anyone split off is handled too
    for (const id of [...pending]) {
      const a = await getAthlete(id);
      if (a?.familyId) for (const m of await familyMembers(a.familyId)) if (!pending.includes(m.id)) pending.push(m.id);
    }
    for (const start of pending) {
      if (seen.has(start)) continue;
      const comp = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const id = queue.pop();
        const linked = await sql`select distinct ua2.athlete_id from app.user_athletes ua1
                                 join app.user_athletes ua2 on ua2.user_id = ua1.user_id where ua1.athlete_id = ${id}`;
        for (const { athlete_id: other } of linked) if (!comp.has(other)) { comp.add(other); queue.push(other); }
      }
      comp.forEach((id) => seen.add(id));
      const members = (await Promise.all([...comp].map(getAthlete))).filter(Boolean);
      if (members.length) components.push(members);
    }
    // Each existing family goes to the group holding most of its children (card details stay with it)
    const claimed = new Map();
    components.sort((x, y) => y.length - x.length);
    const touched = new Set();
    const movedTo = new Map(); // old family -> family its children joined (family passes follow them)
    for (const members of components) {
      const counts = new Map();
      for (const m of members) if (m.familyId) counts.set(m.familyId, (counts.get(m.familyId) || 0) + 1);
      const candidates = [...counts.entries()].filter(([fid]) => !claimed.has(fid));
      let keep = null;
      if (candidates.length) {
        const families = await Promise.all(candidates.map(([fid]) => getFamily(fid)));
        candidates.sort((x, y) => {
          const fx = families.find((f) => f?.id === x[0]); const fy = families.find((f) => f?.id === y[0]);
          return (subscriptionActive(fy) - subscriptionActive(fx)) || (y[1] - x[1]) || (x[0] - y[0]);
        });
        keep = await getFamily(candidates[0][0]);
      }
      if (!keep) {
        const template = members[0].familyId ? await getFamily(members[0].familyId) : null;
        keep = await createFamily(members[0].clubId, { frequency: template?.frequency || members[0].frequency, payMethod: template?.pay_method || null, status: template?.status || 'paid', surname: surnameOf(members[0].name) });
      }
      claimed.set(keep.id, true);
      const overdue = members.some((m) => m.familyId && m.familyId !== keep.id) && (await sql`
        select 1 from app.families where status = 'overdue' and id in (select family_id from app.athletes where id = any(${'{' + members.map((m) => m.id).join(',') + '}'}::int[]))`).length;
      for (const m of members) {
        if (m.familyId !== keep.id) {
          if (m.familyId) { touched.add(m.familyId); movedTo.set(m.familyId, keep.id); }
          await sql`update app.athletes set family_id = ${keep.id} where id = ${m.id}`;
          await writeAthlete({ ...m, frequency: keep.frequency });
        }
      }
      if (overdue) await sql`update app.families set status = 'overdue' where id = ${keep.id}`;
      touched.add(keep.id);
    }
    for (const fid of touched) {
      if (!(await familyMembers(fid)).length) {
        if (movedTo.has(fid)) await sql`update app.passes set family_id = ${movedTo.get(fid)} where family_id = ${fid}`;
        await closeFamily(fid);
      } else await syncFamilySubscription(fid).catch((err) => console.warn('Could not update family card payments', err.message));
    }
  }

  // A family with no children left: stop any card payments and remove it
  async function closeFamily(familyId) {
    const f = await getFamily(familyId);
    if (!f) return;
    if (subscriptionActive(f) && stripe) {
      const club = await auth.getClub(f.club_id);
      if (club?.billing?.connectAccountId) await stripe.subscriptions.cancel(f.billing.subscriptionId, {}, connectOpts(club)).catch(() => {});
    }
    await sql`delete from app.families where id = ${familyId}`;
  }

  // What each role may see about a member (payment details come from their family)
  function project(a, viewer, f) {
    const fb = f?.billing || {};
    const active = subscriptionActive(f);
    const out = {
      id: a.id, name: a.name, squadId: a.squadId, familyId: f?.id ?? null,
      frequency: f?.frequency || a.frequency || 'weekly',
      status: f?.status || a.status || 'paid',
      regularSessions: a.regularSessions || [],
      hasSubscription: active, autoDebit: active,
      cardLast4: fb.cardLast4 || null, nextBillingDate: active ? fb.nextBillingDate || null : null,
      parent: a.parent, phone: a.phone, email: a.email, address: a.address,
      payRef: f?.reference || null,
      lastPaidOn: fb.lastPaidOn || null,
    };
    if (viewer.role === 'coach' || viewer.role === 'parent') {
      Object.assign(out, { emergency: a.emergency, allergies: a.allergies, medication: a.medication });
    }
    return out;
  }
  const projectOne = async (a, viewer) => project(a, viewer, await familyOf(a));

  // A family as the app shows it: who's in it, what it costs, how and whether it's paid
  function familyView(f, members, squads, methods) {
    const active = subscriptionActive(f);
    const surnames = [...new Set(members.map((m) => surnameOf(m.name)).filter(Boolean))];
    const total = members.reduce((sum, m) => sum + Number(squads.get(m.squadId)?.[f.frequency] || 0), 0);
    const payMethod = methodFor(f, methods);
    // Shown to parents before they pay, so the surcharge is never a surprise
    const cardFee = payMethod === 'card' && methods.cardFee === 'parents' ? cardFeeFor(total) : 0;
    return {
      cardFee,
      id: f.id, name: `${surnames.join(' / ') || 'Family'} family`, reference: f.reference,
      athleteIds: members.map((m) => m.id), frequency: f.frequency, total: Math.round(total * 100) / 100,
      payMethod, payMethodChosen: Boolean(f.pay_method), status: f.status,
      hasSubscription: active, cardLast4: f.billing.cardLast4 || null, nextBillingDate: active ? f.billing.nextBillingDate || null : null,
      cardStopping: active && Boolean(f.billing.cancelAtPeriodEnd), lastPaidOn: f.billing.lastPaidOn || null,
    };
  }

  async function visibleAthletes(user) {
    const rows = user.role === 'parent'
      ? await sql`select a.* from app.athletes a join app.user_athletes ua on ua.athlete_id = a.id
                  where ua.user_id = ${user.id} and a.club_id = ${user.club_id} order by a.id`
      : await sql`select * from app.athletes where club_id = ${user.club_id} order by id`;
    return rows.map(readAthlete);
  }

  // Loads a family the signed-in person may see: staff of its club, or a parent of one of its children
  async function familyFor(ctx, id, { staffOnly = false } = {}) {
    const f = await getFamily(id);
    const u = ctx.user;
    let ok = Boolean(f) && f.club_id === u.club_id;
    if (ok && !STAFF.has(u.role)) {
      ok = !staffOnly && u.role === 'parent' && (await sql`select 1 from app.user_athletes ua join app.athletes a on a.id = ua.athlete_id
                                                            where ua.user_id = ${u.id} and a.family_id = ${f.id} limit 1`).length > 0;
    }
    if (!ok) throw new HttpError(404, 'Family not found.');
    return f;
  }

  async function regularCounts(clubId) {
    const counts = {};
    for (const r of await sql`select data from app.athletes where club_id = ${clubId}`) {
      for (const s of r.data.regularSessions || []) counts[s] = (counts[s] || 0) + 1;
    }
    return counts;
  }

  const keyOf = (r) => `${r.athlete_id}|${r.series_id}|${r.date}`;

  // ---------- Validation ----------

  async function cleanAthleteFields(body, { allowMedical, partial, clubId }) {
    const out = {};
    if (!partial || 'name' in body) { out.name = text(body.name, 80); if (!out.name) bad("Enter the athlete's name."); }
    if (!partial || 'squadId' in body) { out.squadId = toInt(body.squadId); if (!(await getSquad(out.squadId, clubId))) bad('Choose a group.'); }
    if (!partial || 'frequency' in body) { out.frequency = String(body.frequency || 'weekly'); if (!FREQS.has(out.frequency)) bad('Choose weekly, fortnightly or monthly.'); }
    if ('status' in body) { out.status = body.status === 'overdue' ? 'overdue' : 'paid'; }
    for (const k of ['parent', 'phone', 'email', 'address']) if (!partial || k in body) out[k] = text(body[k], k === 'address' ? 200 : 120);
    if (out.email) { out.email = out.email.toLowerCase(); if (!isEmail(out.email)) bad('Check the email address. Use a plain address like name@example.com.'); }
    if (out.phone && !isPhone(out.phone)) bad('Check the phone number. Use digits, spaces and + ( ) - only.');
    if (allowMedical) for (const k of ['emergency', 'allergies', 'medication']) if (!partial || k in body) out[k] = text(body[k], 300);
    return out;
  }

  // ---------- Card payments (on each club's own connected Stripe account) ----------

  const INTERVALS = { weekly: { interval: 'week', interval_count: 1 }, fortnightly: { interval: 'week', interval_count: 2 }, monthly: { interval: 'month', interval_count: 1 } };
  const cents = (n) => Math.round(Number(n) * 100);
  const isoFromUnix = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : null);
  const periodEnd = (sub) => sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end;

  const connectOpts = (club) => ({ stripeAccount: club.billing.connectAccountId });
  function clubPayments(club) {
    if (!clubPaymentMethods(club).card) throw new HttpError(409, 'This club takes payments by bank transfer. The details are on your Payments page.');
    if (!stripe) throw new HttpError(503, "Online payments aren't set up yet. Please contact the club.");
    if (!club.billing?.connectAccountId || !club.billing?.connectChargesEnabled) {
      throw new HttpError(503, "This club hasn't switched on online payments yet. Please contact the club.");
    }
    return connectOpts(club);
  }

  async function ensureProduct(squad, opts) {
    const id = `squad_${squad.id}`;
    try {
      const product = await stripe.products.retrieve(id, {}, opts);
      if (product.name !== squad.name) await stripe.products.update(id, { name: squad.name }, opts);
    } catch (err) {
      if (err.code !== 'resource_missing') throw err;
      await stripe.products.create({ id, name: squad.name }, opts);
    }
    return id;
  }

  async function recurringPrice(squad, frequency, opts) {
    const amount = cents(squad[frequency]);
    const lookup_key = `squad_${squad.id}_${frequency}_${amount}`;
    const existing = await stripe.prices.list({ lookup_keys: [lookup_key], limit: 1 }, opts);
    if (existing.data[0]) return existing.data[0].id;
    const product = await ensureProduct(squad, opts);
    return (await stripe.prices.create({ product, currency: 'nzd', unit_amount: amount, recurring: INTERVALS[frequency], lookup_key }, opts)).id;
  }

  // The card fee as its own line, when the club passes it on (one price per amount and schedule)
  async function cardFeePrice(frequency, amount, opts) {
    const lookup_key = `cardfee_${frequency}_${amount}`;
    const existing = await stripe.prices.list({ lookup_keys: [lookup_key], limit: 1 }, opts);
    if (existing.data[0]) return existing.data[0].id;
    try {
      await stripe.products.retrieve('card_fee', {}, opts);
    } catch (err) {
      if (err.code !== 'resource_missing') throw err;
      await stripe.products.create({ id: 'card_fee', name: 'Card processing fee' }, opts);
    }
    return (await stripe.prices.create({ product: 'card_fee', currency: 'nzd', unit_amount: amount, recurring: INTERVALS[frequency], lookup_key }, opts)).id;
  }

  // The card subscription's lines: one per group price, with a quantity for brothers and sisters in the
  // same group, plus the card fee if the club passes it on to parents
  async function familyLines(f, members, opts) {
    const lines = new Map();
    let total = 0;
    for (const m of members) {
      const squad = await getSquad(m.squadId, f.club_id);
      if (!squad || !(Number(squad[f.frequency]) > 0)) continue;
      const price = await recurringPrice(squad, f.frequency, opts);
      lines.set(price, (lines.get(price) || 0) + 1);
      total += Number(squad[f.frequency]);
    }
    const club = await auth.getClub(f.club_id);
    if (lines.size && clubPaymentMethods(club).cardFee === 'parents') {
      const fee = cents(cardFeeFor(total));
      if (fee > 0) lines.set(await cardFeePrice(f.frequency, fee, opts), 1);
    }
    return lines;
  }

  // A club changed who pays the card fee: every family already paying by card moves to the new amount
  async function resyncClubSubscriptions(clubId) {
    for (const { id } of await sql`select id from app.families where club_id = ${clubId} and coalesce(billing->>'subscriptionId', '') <> ''`) {
      await syncFamilySubscription(id).catch((err) => console.warn('Could not update family card payments', err.message));
    }
  }

  // Brings a family's card subscription in line with its children, their groups and its schedule
  async function syncFamilySubscription(familyId) {
    const f = await getFamily(familyId);
    if (!f || !subscriptionActive(f) || !stripe) return;
    const club = await auth.getClub(f.club_id);
    if (!club?.billing?.connectAccountId) return;
    const opts = connectOpts(club);
    const members = await familyMembers(f.id);
    if (!members.length) return closeFamily(f.id);
    const want = await familyLines(f, members, opts);
    const sub = await stripe.subscriptions.retrieve(f.billing.subscriptionId, {}, opts);
    const items = [];
    for (const it of sub.items?.data || []) {
      const priceId = typeof it.price === 'string' ? it.price : it.price?.id;
      if (want.has(priceId)) {
        if (it.quantity !== want.get(priceId)) items.push({ id: it.id, quantity: want.get(priceId) });
        want.delete(priceId);
      } else items.push({ id: it.id, deleted: true });
    }
    for (const [price, quantity] of want) items.push({ price, quantity });
    if (!items.length) return;
    const updated = await stripe.subscriptions.update(sub.id, {
      items, proration_behavior: 'create_prorations', metadata: { ...(sub.metadata || {}), familyId: String(f.id), frequency: f.frequency },
    }, opts);
    await setFamilyBilling(f.id, { nextBillingDate: isoFromUnix(periodEnd(updated)) || f.billing.nextBillingDate || null });
  }

  // A child moves group (staff only); the family's card payments follow
  async function moveSquad(a, squadId) {
    const squad = await getSquad(squadId, a.clubId);
    if (!squad) bad('Choose a group.');
    if (squad.id === a.squadId) return a;
    const next = { ...a, squadId: squad.id, regularSessions: [] };
    await writeAthlete(next);
    await sql`delete from app.rsvps where athlete_id = ${a.id} and date >= ${todayIso()}`;
    if (a.familyId) await syncFamilySubscription(a.familyId);
    return next;
  }

  // How often the whole family pays (parents choose); card payments follow
  async function setFamilyFrequency(f, frequency) {
    if (!FREQS.has(frequency)) bad('Choose weekly, fortnightly or monthly.');
    if (frequency === f.frequency) return f;
    await sql`update app.families set frequency = ${frequency} where id = ${f.id}`;
    for (const m of await familyMembers(f.id)) await writeAthlete({ ...m, frequency });
    await syncFamilySubscription(f.id);
    return getFamily(f.id);
  }

  // Card or bank transfer for a family (the club decides). Moving to bank stops card payments at the
  // end of the period already paid, so nobody pays twice; moving back to card before then keeps them.
  async function setFamilyMethod(f, method) {
    if (!['card', 'bank'].includes(method)) bad('Choose card or bank transfer.');
    const club = await auth.getClub(f.club_id);
    const allowed = clubPaymentMethods(club);
    if (method === 'card' && !allowed.card) bad("This club doesn't take card payments.");
    if (method === 'bank' && !allowed.bank) bad("This club hasn't set up bank transfers.");
    let cardStopsOn = null;
    if (subscriptionActive(f) && stripe && club.billing?.connectAccountId && Boolean(f.billing.cancelAtPeriodEnd) !== (method === 'bank')) {
      const sub = await stripe.subscriptions.update(f.billing.subscriptionId, { cancel_at_period_end: method === 'bank' }, connectOpts(club));
      await setFamilyBilling(f.id, { cancelAtPeriodEnd: method === 'bank' });
      if (method === 'bank') cardStopsOn = isoFromUnix(periodEnd(sub));
    }
    await sql`update app.families set pay_method = ${method} where id = ${f.id}`;
    return { family: await getFamily(f.id), cardStopsOn };
  }

  async function familyPayload(f, viewerClub) {
    const members = await familyMembers(f.id);
    const squads = new Map((await allSquads(f.club_id)).map((s) => [s.id, s]));
    return familyView(f, members, squads, clubPaymentMethods(viewerClub || await auth.getClub(f.club_id)));
  }

  // ---------- Session passes ----------
  // A pass is a number of sessions, at a price the coach or treasurer chooses, for one child or for
  // a whole family (any of the children can use the sessions). It can be offered to the parents to
  // buy, or given straight away. Each time the coach marks a child present, one session is used
  // (the child's own pass first, then the family's, oldest first); unticking gives it back.

  const passView = (p) => ({
    id: p.id, athleteId: p.athlete_id ?? null, familyId: p.family_id ?? null,
    sessions: p.sessions, used: p.used, left: Math.max(p.sessions - p.used, 0),
    price: Number(p.price), paidBy: p.paid_by, status: p.status,
    issuedOn: new Date(p.created_at).toISOString().slice(0, 10),
  });
  // A child's usable passes: their own and their family's
  const passesOf = async (athleteId) => (await sql`
    select p.* from app.passes p
    where p.status = 'active' and (p.athlete_id = ${athleteId} or p.family_id = (select family_id from app.athletes where id = ${athleteId}))
    order by p.id`).map(passView);
  const PASS_PAID_BY = new Set(['bank', 'cash', 'free', 'unpaid', 'offer']);
  const PAID_LABEL = { bank: 'Bank transfer', cash: 'Cash', card: 'Card' };
  const passIncome = (name, sessions, paidBy, amount) => ({
    date: todayIso(), type: 'Income', gst: true, category: 'Session Pass',
    description: `${name} - ${sessions}-Session Pass (${PAID_LABEL[paidBy] || paidBy})`, amount,
  });
  const passOwnerName = async (p) => {
    if (p.athlete_id) return (await getAthlete(p.athlete_id))?.name || 'Member';
    const f = await getFamily(p.family_id);
    const kids = f ? await familyMembers(f.id) : [];
    return kids.length ? `${surnameOf(kids[0].name)} family` : 'Family';
  };

  // Marks attendance, using or giving back a pass session as needed
  async function markAttendance(tx, athleteId, seriesId, date, present, userId) {
    const [prev] = await tx`select pass_id from app.attendance where athlete_id = ${athleteId} and series_id = ${seriesId} and date = ${date} for update`;
    let passId = prev?.pass_id ?? null;
    if (present && !passId) {
      const [p] = await tx`select id from app.passes
                           where status = 'active' and used < sessions
                             and (athlete_id = ${athleteId} or family_id = (select family_id from app.athletes where id = ${athleteId}))
                           order by (athlete_id is null), id limit 1 for update`;
      if (p) { await tx`update app.passes set used = used + 1 where id = ${p.id}`; passId = p.id; }
    } else if (!present && passId) {
      await tx`update app.passes set used = greatest(used - 1, 0) where id = ${passId}`;
      passId = null;
    }
    await tx`insert into app.attendance (athlete_id, series_id, date, present, marked_by, pass_id)
             values (${athleteId}, ${seriesId}, ${date}, ${present}, ${userId}, ${passId})
             on conflict (athlete_id, series_id, date) do update set present = excluded.present, marked_by = excluded.marked_by, pass_id = excluded.pass_id`;
  }

  const passFor = async (ctx) => {
    const id = toInt(ctx.params.id);
    const [p] = id ? await sql`select * from app.passes where id = ${id} and club_id = ${ctx.user.club_id}` : [];
    if (!p) throw new HttpError(404, 'Pass not found.');
    return p;
  };

  // ---------- Routes ----------

  function routes(r) {
    // Everything the signed-in person is allowed to see, in one load
    r.get('/api/bootstrap', ...member(), async (ctx) => {
      const user = ctx.user;
      const club = await clubOf(ctx);
      const settings = { ...DEFAULT_SETTINGS, ...club.settings };
      const base = {
        me: await auth.publicUser(user),
        settings: STAFF.has(user.role) ? settings : { financialYearStart: settings.financialYearStart },
        payments: { connected: Boolean(stripe && club.billing?.connectChargesEnabled) },
      };
      // A club that hasn't subscribed yet sees sample data so they can try every screen
      if (club.status === 'preview') {
        const sample = sampleData(user);
        return {
          ...base, sample: true, squads: sample.squads, athletes: sample.athletes, families: sample.families, regularCounts: sample.regularCounts,
          rsvps: {}, attendance: {}, passes: [], transactions: STAFF.has(user.role) ? sample.transactions : [],
        };
      }
      const athletes = await visibleAthletes(user);
      for (const a of athletes) if (!a.familyId) a.familyId = (await familyOf(a)).id;
      const ids = new Set(athletes.map((a) => a.id));
      const familyIds = [...new Set(athletes.map((a) => a.familyId))];
      const families = new Map();
      for (const fid of familyIds) { const f = await getFamily(fid); if (f) families.set(fid, f); }
      const squads = await allSquads(user.club_id);
      const squadMap = new Map(squads.map((s) => [s.id, s]));
      const methods = clubPaymentMethods(club);
      const familyList = [];
      for (const f of families.values()) {
        // Parents see their own children; staff see the whole family
        const members = user.role === 'parent' ? athletes.filter((a) => a.familyId === f.id) : await familyMembers(f.id);
        familyList.push(familyView(f, members, squadMap, methods));
      }
      const rsvps = {};
      for (const row of await sql`select r.* from app.rsvps r join app.athletes a on a.id = r.athlete_id
                                  where a.club_id = ${user.club_id} and r.date >= ${addDaysIso(todayIso(), -7)}`) {
        if (ids.has(row.athlete_id)) rsvps[keyOf(row)] = row.attending;
      }
      const attendance = {};
      if (user.role === 'coach') {
        for (const row of await sql`select t.* from app.attendance t join app.athletes a on a.id = t.athlete_id
                                    where a.club_id = ${user.club_id} and t.date >= ${addDaysIso(todayIso(), -120)}`) {
          attendance[keyOf(row)] = row.present;
        }
      }
      return {
        ...base, sample: false,
        squads,
        athletes: athletes.map((a) => project(a, user, families.get(a.familyId))),
        families: familyList,
        regularCounts: await regularCounts(user.club_id),
        passes: (await sql`select * from app.passes where club_id = ${user.club_id} and status in ('offered', 'active') order by id`)
          .filter((p) => (p.athlete_id ? ids.has(p.athlete_id) : families.has(p.family_id))).map(passView),
        rsvps,
        attendance,
        transactions: STAFF.has(user.role)
          ? (await sql`select id, data from app.transactions where club_id = ${user.club_id} order by id`).map((t) => ({ ...t.data, id: t.id }))
          : [],
      };
    });

    // ----- Members -----

    r.post('/api/athletes', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const fields = await cleanAthleteFields(ctx.body, { allowMedical: ctx.user.role === 'coach', partial: false, clubId: ctx.user.club_id });
      const { status = 'paid', ...rest0 } = fields;
      const family = await createFamily(ctx.user.club_id, { frequency: fields.frequency, status, surname: surnameOf(fields.name) });
      const { priv, rest } = splitPrivate({ ...rest0, regularSessions: [] });
      const [row] = await sql`insert into app.athletes (club_id, data, private_enc, family_id)
                              values (${ctx.user.club_id}, ${sql.json(rest)}, ${encrypt(JSON.stringify(priv))}, ${family.id}) returning *`;
      const created = readAthlete(row);
      await audit(ctx, ctx.user.id, 'athlete_created', { athleteId: created.id });
      return { athlete: project(created, ctx.user, family), family: await familyPayload(family) };
    });

    r.put('/api/athletes/:id', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.params.id, { staffOnly: true });
      const fields = await cleanAthleteFields(ctx.body, { allowMedical: ctx.user.role === 'coach', partial: true, clubId: ctx.user.club_id });
      const { squadId = a.squadId, frequency, status, ...rest } = fields;
      let next = squadId !== a.squadId ? await moveSquad(a, squadId) : a;
      let family = await familyOf(next);
      // Schedule, card-or-bank and paid status belong to the family
      if (frequency && frequency !== family.frequency) family = await setFamilyFrequency(family, frequency);
      if (['card', 'bank'].includes(ctx.body.payMethod) && ctx.body.payMethod !== family.pay_method) family = (await setFamilyMethod(family, ctx.body.payMethod)).family;
      if (status && !subscriptionActive(family) && status !== family.status) { // Stripe decides paid/overdue for card families
        await sql`update app.families set status = ${status} where id = ${family.id}`;
        family = await getFamily(family.id);
      }
      next = { ...next, ...rest, frequency: family.frequency };
      await writeAthlete(next);
      await audit(ctx, ctx.user.id, 'athlete_updated', { athleteId: a.id, fields: Object.keys(fields) });
      return { athlete: project(next, ctx.user, family), family: await familyPayload(family) };
    });

    // Permanently remove a member and everything about them: contact and medical details, bookings,
    // attendance and parent links. Ledger entries stay, because clubs must keep financial records for tax.
    r.delete('/api/athletes/:id', ...member('coach'), async (ctx) => {
      const a = await athleteFor(ctx, ctx.params.id, { staffOnly: true });
      await sql`delete from app.athletes where id = ${a.id} and club_id = ${ctx.user.club_id}`; // cascades to the rest
      if (a.familyId) {
        if (!(await familyMembers(a.familyId)).length) await closeFamily(a.familyId);
        else await syncFamilySubscription(a.familyId).catch((err) => console.warn('Could not update family card payments', err.message));
      }
      await audit(ctx, ctx.user.id, 'athlete_deleted', { athleteId: a.id });
      return { deleted: a.id };
    });

    // Parents update their own child's contact and medical details
    r.put('/api/athletes/:id/profile', ...member('parent'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.params.id);
      const allowed = Object.fromEntries(Object.entries(ctx.body).filter(([k]) => ['phone', 'email', 'address', 'emergency', 'allergies', 'medication'].includes(k)));
      const fields = await cleanAthleteFields(allowed, { allowMedical: true, partial: true, clubId: ctx.user.club_id });
      const next = { ...a, ...fields };
      await writeAthlete(next);
      await audit(ctx, ctx.user.id, 'profile_updated', { athleteId: a.id });
      return { athlete: await projectOne(next, ctx.user) };
    });

    // Staff move a member between groups; anyone allowed can change the family's schedule
    r.post('/api/athletes/:id/plan', ...member(), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.params.id);
      let next = a;
      if (ctx.user.role !== 'parent' && ctx.body.squadId != null) next = await moveSquad(a, toInt(ctx.body.squadId));
      let family = await familyOf(next);
      if (ctx.body.frequency) family = await setFamilyFrequency(family, String(ctx.body.frequency));
      await audit(ctx, ctx.user.id, 'plan_changed', { athleteId: a.id, squadId: next.squadId, frequency: family.frequency });
      return { athlete: project({ ...next, frequency: family.frequency }, ctx.user, family), family: await familyPayload(family) };
    });

    // Regular training days
    r.put('/api/athletes/:id/regular', ...member('parent', 'coach'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.params.id, { coachOrOwner: true });
      const squad = await getSquad(a.squadId, a.clubId);
      if (!squad) bad('This athlete is not in a group yet.');
      const live = liveSeriesIds(squad, todayIso());
      const wanted = [...new Set((Array.isArray(ctx.body.seriesIds) ? ctx.body.seriesIds : []).map(String))];
      if (wanted.some((id) => !live.has(id))) bad("One of those sessions isn't running any more. Refresh and try again.");
      const before = new Set(a.regularSessions || []);
      const counts = await regularCounts(a.clubId);
      for (const id of wanted) {
        if (!before.has(id) && squad.capacity && (counts[id] || 0) >= squad.capacity) bad('That session is full. Ask the coach about a spot.');
      }
      const changed = [...wanted.filter((x) => !before.has(x)), ...[...before].filter((x) => !wanted.includes(x))];
      await sql.begin(async (tx) => {
        await writeAthlete({ ...a, regularSessions: wanted }, tx);
        for (const sid of changed) await tx`delete from app.rsvps where athlete_id = ${a.id} and series_id = ${sid} and date >= ${todayIso()}`;
      });
      return { athlete: await projectOne(await getAthlete(a.id), ctx.user), regularCounts: await regularCounts(a.clubId) };
    });

    // One-off "coming / not coming" for a date
    r.put('/api/rsvps', ...member('parent', 'coach'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.body.athleteId, { coachOrOwner: true });
      const seriesId = String(ctx.body.seriesId ?? '');
      const { date } = ctx.body;
      if (typeof date !== 'string' || !DATE.test(date) || date < todayIso()) bad('Choose a date from today onwards.');
      if (!seriesInSquad(await getSquad(a.squadId, a.clubId), seriesId)) bad("That session isn't part of this group.");
      if (ctx.body.attending === null || ctx.body.attending === undefined) {
        await sql`delete from app.rsvps where athlete_id = ${a.id} and series_id = ${seriesId} and date = ${date}`;
      } else {
        await sql`insert into app.rsvps (athlete_id, series_id, date, attending) values (${a.id}, ${seriesId}, ${date}, ${Boolean(ctx.body.attending)})
                  on conflict (athlete_id, series_id, date) do update set attending = excluded.attending`;
      }
      return { ok: true };
    });

    // ----- Attendance (coach) -----

    r.put('/api/attendance', ...member('coach'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.body.athleteId, { staffOnly: true });
      const seriesId = String(ctx.body.seriesId ?? '');
      const { date } = ctx.body;
      if (typeof date !== 'string' || !DATE.test(date) || !seriesInSquad(await getSquad(a.squadId, a.clubId), seriesId)) bad('Invalid session.');
      await sql.begin((tx) => markAttendance(tx, a.id, seriesId, date, Boolean(ctx.body.present), ctx.user.id));
      return { ok: true, passes: await passesOf(a.id), athleteId: a.id };
    });

    r.post('/api/attendance/bulk', ...member('coach'), usable, async (ctx) => {
      const seriesId = String(ctx.body.seriesId ?? '');
      const { date } = ctx.body;
      const ids = (Array.isArray(ctx.body.athleteIds) ? ctx.body.athleteIds : []).map(toInt).filter(Boolean).slice(0, 500);
      if (typeof date !== 'string' || !DATE.test(date)) bad('Invalid session.');
      const squads = new Map((await allSquads(ctx.user.club_id)).map((s) => [s.id, s]));
      const members = [];
      for (const id of ids) {
        const a = await getAthlete(id);
        if (a && a.clubId === ctx.user.club_id && seriesInSquad(squads.get(a.squadId), seriesId)) members.push(id);
      }
      await sql.begin(async (tx) => {
        for (const id of members) await markAttendance(tx, id, seriesId, date, true, ctx.user.id);
      });
      const passes = [];
      for (const id of members) passes.push(...await passesOf(id));
      return { ok: true, passes, athleteIds: members };
    });

    // ----- Groups & timetables -----

    r.post('/api/squads', ...member('coach'), usable, async (ctx) => {
      const { id: _ignored, ...rest } = cleanSquad(ctx.body, 0);
      const [row] = await sql`insert into app.squads (club_id, data) values (${ctx.user.club_id}, ${sql.json(rest)}) returning id`;
      await audit(ctx, ctx.user.id, 'squad_created', { squadId: row.id });
      return { ...rest, id: row.id };
    });

    r.put('/api/squads/:id', ...member('coach'), usable, async (ctx) => {
      const existing = await getSquad(ctx.params.id, ctx.user.club_id);
      if (!existing) throw new HttpError(404, 'Group not found.');
      const squad = cleanSquad(ctx.body, existing.id);
      await saveSquad(squad, ctx.user.club_id);
      const club = await clubOf(ctx);
      if (stripe && club.billing?.connectChargesEnabled && squad.name !== existing.name) await ensureProduct(squad, connectOpts(club)).catch(() => {});
      return squad;
    });

    r.delete('/api/squads/:id', ...member('coach'), usable, async (ctx) => {
      const existing = await getSquad(ctx.params.id, ctx.user.club_id);
      if (!existing) throw new HttpError(404, 'Group not found.');
      const [{ n }] = await sql`select count(*)::int as n from app.athletes where club_id = ${ctx.user.club_id} and (data->>'squadId')::int = ${existing.id}`;
      if (n > 0) throw new HttpError(409, "Move this group's members to another group first.");
      await sql`delete from app.squads where id = ${existing.id} and club_id = ${ctx.user.club_id}`;
      await audit(ctx, ctx.user.id, 'squad_deleted', { squadId: existing.id });
      return { deleted: existing.id };
    });

    // ----- Session passes (coach and treasurer) -----

    // A pass for a child, or for their whole family: offered to the parents to buy, or given now
    // (paid by bank transfer or cash, to be paid later, or free)
    r.post('/api/athletes/:id/passes', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.params.id, { staffOnly: true });
      const sessions = Number(ctx.body.sessions);
      const price = Number(ctx.body.price);
      const paidBy = String(ctx.body.paidBy || '');
      if (!Number.isInteger(sessions) || sessions < 1 || sessions > 500) bad('Enter the number of sessions (1 to 500).');
      if (!Number.isFinite(price) || price < 0 || price > 100000) bad('Enter a price.');
      if (!PASS_PAID_BY.has(paidBy)) bad('Choose how the pass is paid for.');
      if (paidBy === 'offer' && !(price > 0)) bad('Enter the price the parents will pay.');
      const family = ctx.body.forFamily ? await familyOf(a) : null;
      const amount = paidBy === 'free' ? 0 : Math.round(price * 100) / 100;
      const status = paidBy === 'offer' ? 'offered' : 'active';
      const stored = paidBy === 'offer' ? 'unpaid' : paidBy;
      let transaction = null;
      const pass = await sql.begin(async (tx) => {
        const [p] = await tx`insert into app.passes (club_id, athlete_id, family_id, sessions, price, paid_by, status, issued_by)
                             values (${ctx.user.club_id}, ${family ? null : a.id}, ${family ? family.id : null}, ${sessions}, ${amount}, ${stored}, ${status}, ${ctx.user.id}) returning *`;
        if ((paidBy === 'bank' || paidBy === 'cash') && amount > 0) {
          const data = passIncome(family ? `${surnameOf(a.name)} family` : a.name, sessions, paidBy, amount);
          const [row] = await tx`insert into app.transactions (club_id, data) values (${ctx.user.club_id}, ${sql.json(data)}) returning id`;
          transaction = { ...data, id: row.id };
        }
        return p;
      });
      await audit(ctx, ctx.user.id, paidBy === 'offer' ? 'pass_offered' : 'pass_issued', { athleteId: a.id, familyId: family?.id, passId: pass.id, sessions, paidBy });
      return { pass: passView(pass), transaction };
    });

    // Change a pass: sessions left, mark an unpaid or offered pass paid, or cancel/withdraw it
    r.put('/api/passes/:id', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const p = await passFor(ctx);
      if (p.status === 'cancelled') bad('That pass has been cancelled.');
      const b = ctx.body;
      let transaction = null;
      if (b.status === 'cancelled') {
        await sql`update app.passes set status = 'cancelled' where id = ${p.id}`;
        await audit(ctx, ctx.user.id, 'pass_cancelled', { passId: p.id });
        return { pass: passView({ ...p, status: 'cancelled' }), transaction };
      }
      if (b.left != null) {
        if (p.status !== 'active') bad('That pass hasn\'t started yet.');
        const left = Number(b.left);
        if (!Number.isInteger(left) || left < 0 || p.used + left > 500 || p.used + left < 1) bad('Enter the sessions left (a whole number).');
        await sql`update app.passes set sessions = ${p.used + left} where id = ${p.id}`;
      }
      if (b.paidBy != null) {
        if (p.paid_by !== 'unpaid') bad('That pass is already paid.');
        if (b.paidBy !== 'bank' && b.paidBy !== 'cash') bad('Choose bank transfer or cash.');
        await sql`update app.passes set paid_by = ${b.paidBy}, status = 'active' where id = ${p.id}`;
        if (Number(p.price) > 0) {
          const data = passIncome(await passOwnerName(p), p.sessions, b.paidBy, Number(p.price));
          const [row] = await sql`insert into app.transactions (club_id, data) values (${ctx.user.club_id}, ${sql.json(data)}) returning id`;
          transaction = { ...data, id: row.id };
        }
      }
      await audit(ctx, ctx.user.id, 'pass_changed', { passId: p.id });
      const [fresh] = await sql`select * from app.passes where id = ${p.id}`;
      return { pass: passView(fresh), transaction };
    });

    // ----- How parents pay (the club decides) -----

    r.put('/api/club/payment-methods', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const club = await clubOf(ctx);
      const b = ctx.body;
      const current = club.settings?.payments || {};
      const next = {
        card: current.card !== false, bank: Boolean(current.bank), defaultMethod: current.defaultMethod === 'card' ? 'card' : 'bank', cardFee: current.cardFee === 'parents' ? 'parents' : 'club',
        bankAccountName: current.bankAccountName || '', bankAccountNumber: current.bankAccountNumber || '', instructions: current.instructions || '',
      };
      if ('card' in b) next.card = Boolean(b.card);
      if ('bank' in b) next.bank = Boolean(b.bank);
      if ('defaultMethod' in b) next.defaultMethod = b.defaultMethod === 'card' ? 'card' : 'bank';
      if ('cardFee' in b) next.cardFee = b.cardFee === 'parents' ? 'parents' : 'club';
      if ('bankAccountName' in b || 'bankAccountNumber' in b) {
        const acct = cleanBankAccount(b.bankAccountName ?? next.bankAccountName, b.bankAccountNumber ?? next.bankAccountNumber);
        next.bankAccountName = acct.accountName;
        next.bankAccountNumber = acct.accountNumber;
      }
      if ('instructions' in b) next.instructions = text(b.instructions, 200);
      if (!next.card && !next.bank) bad('Choose at least one way for parents to pay.');
      if (next.bank && (!next.bankAccountName || !next.bankAccountNumber)) bad("Enter the club's account name and number to take bank transfers.");
      await sql`update app.clubs set settings = settings || ${sql.json({ payments: next })} where id = ${club.id}`;
      await audit(ctx, ctx.user.id, 'payment_methods_changed', { card: next.card, bank: next.bank, cardFee: next.cardFee });
      // Card payments already set up follow the club's choice of who pays the fee
      if ((current.cardFee === 'parents') !== (next.cardFee === 'parents')) await resyncClubSubscriptions(club.id);
      return { payments: clubPaymentMethods(await clubOf(ctx)) };
    });

    // ----- Families -----

    // Card or bank transfer for one family: the coach or treasurer decides, never the parents
    r.put('/api/families/:id/pay-method', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const f = await familyFor(ctx, ctx.params.id, { staffOnly: true });
      const { family, cardStopsOn } = await setFamilyMethod(f, String(ctx.body.method || ''));
      await audit(ctx, ctx.user.id, 'pay_method_changed', { familyId: f.id, method: family.pay_method });
      return { family: await familyPayload(family), cardStopsOn };
    });

    // How often the family pays: parents choose; staff can change it too
    r.put('/api/families/:id/frequency', ...member('parent', 'coach', 'treasurer'), usable, async (ctx) => {
      const f = await familyFor(ctx, ctx.params.id);
      const family = await setFamilyFrequency(f, String(ctx.body.frequency || ''));
      await audit(ctx, ctx.user.id, 'plan_changed', { familyId: f.id, frequency: family.frequency });
      return { family: await familyPayload(family) };
    });

    // Paid or overdue, for families paying by bank (Stripe keeps card families up to date)
    r.put('/api/families/:id/status', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const f = await familyFor(ctx, ctx.params.id, { staffOnly: true });
      if (subscriptionActive(f)) throw new HttpError(409, 'This family pays by card, so Stripe keeps their status up to date.');
      const status = ctx.body.status === 'overdue' ? 'overdue' : 'paid';
      await sql`update app.families set status = ${status} where id = ${f.id}`;
      return { family: await familyPayload(await getFamily(f.id)) };
    });

    // A payment that arrived outside the app (usually a bank transfer) for the whole family: marks
    // them paid and records the income in the club's ledger
    r.post('/api/families/:id/payment', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const f = await familyFor(ctx, ctx.params.id, { staffOnly: true });
      const amount = Number(ctx.body.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) bad('Enter the amount received.');
      const date = typeof ctx.body.date === 'string' && DATE.test(ctx.body.date) ? ctx.body.date : todayIso();
      const view = await familyPayload(f);
      const how = ctx.body.method === 'cash' ? 'Cash' : 'Bank transfer';
      const tx = { date, type: 'Income', category: 'Subscription', description: `${view.name} - ${how} (${f.frequency}, ref ${f.reference})`, amount: Math.round(amount * 100) / 100, gst: true };
      const [row] = await sql`insert into app.transactions (club_id, data) values (${ctx.user.club_id}, ${sql.json(tx)}) returning id`;
      if (!subscriptionActive(f)) await sql`update app.families set status = 'paid' where id = ${f.id}`;
      await setFamilyBilling(f.id, { lastPaidOn: date });
      await audit(ctx, ctx.user.id, 'payment_recorded', { familyId: f.id, amount: tx.amount });
      return { family: await familyPayload(await getFamily(f.id)), transaction: { ...tx, id: row.id } };
    });

    // ----- Ledger & settings (staff) -----

    r.post('/api/transactions', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const { date, type, category, description, amount, gst } = ctx.body;
      const value = Number(amount);
      if (!text(description) || !Number.isFinite(value) || value <= 0 || value > 1e7 || !['Income', 'Expense'].includes(type)) {
        bad('Enter a description, type and amount.');
      }
      const tx = { date: typeof date === 'string' && DATE.test(date) ? date : todayIso(), type, category: text(category, 80) || 'General', description: text(description, 200), amount: Math.round(value * 100) / 100, gst: Boolean(gst) };
      const [row] = await sql`insert into app.transactions (club_id, data) values (${ctx.user.club_id}, ${sql.json(tx)}) returning id`;
      await audit(ctx, ctx.user.id, 'transaction_added', { id: row.id });
      return { ...tx, id: row.id };
    });

    r.put('/api/settings', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const club = await clubOf(ctx);
      const next = { ...DEFAULT_SETTINGS, ...club.settings };
      if ('financialYearStart' in ctx.body) {
        const m = /^(\d{2})-(\d{2})$/.exec(String(ctx.body.financialYearStart));
        const month = m && Number(m[1]);
        const day = m && Number(m[2]);
        const daysIn = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (!m || month < 1 || month > 12 || day < 1 || day > daysIn[month - 1]) bad('Choose the day your financial year starts.');
        next.financialYearStart = ctx.body.financialYearStart;
      }
      if ('smsTemplate' in ctx.body) next.smsTemplate = text(ctx.body.smsTemplate, 480);
      if ('emailTemplate' in ctx.body) next.emailTemplate = longText(ctx.body.emailTemplate, 3000);
      await sql`update app.clubs set settings = ${sql.json(next)} where id = ${club.id}`;
      return next;
    });

    // ----- Card payments by parents (on the club's own Stripe account) -----

    async function ensureCustomer(f, ctx, opts) {
      if (f.billing.customerId) return f.billing.customerId;
      const view = await familyPayload(f);
      const customer = await stripe.customers.create({ name: ctx.user.name || view.name, email: ctx.user.email || undefined, metadata: { familyId: String(f.id), family: view.name } }, opts);
      await setFamilyBilling(f.id, { customerId: customer.id });
      return customer.id;
    }

    // The family whose card payments a parent is setting up (by family, or by one of its children)
    const familyFromBody = async (ctx) => (ctx.body.familyId != null
      ? familyFor(ctx, ctx.body.familyId)
      : familyOf(await athleteFor(ctx, ctx.body.athleteId)));

    // One card subscription for the whole family: a line per group price, at the family's schedule
    r.post('/api/checkout/subscription', ...member('parent'), usable, async (ctx) => {
      const f = await familyFromBody(ctx);
      const club = await clubOf(ctx);
      const opts = clubPayments(club);
      if (methodFor(f, clubPaymentMethods(club)) !== 'card') throw new HttpError(409, 'The club has set your family to pay by bank transfer. The details are on your Payments page.');
      if (subscriptionActive(f)) throw new HttpError(409, 'Automatic card payments are already set up. Change how often you pay instead.');
      const members = await familyMembers(f.id);
      const lines = await familyLines(f, members, opts);
      if (!lines.size) bad('Your children need to be in a group before you can set up payments.');
      const customer = await ensureCustomer(f, ctx, opts);
      const meta = { familyId: String(f.id), frequency: f.frequency, kind: 'family_subscription' };
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription', customer, line_items: [...lines].map(([price, quantity]) => ({ price, quantity })),
        metadata: meta, subscription_data: { metadata: meta },
        success_url: `${appUrl}/?checkout=success`, cancel_url: `${appUrl}/?checkout=cancelled`,
      }, opts);
      await audit(ctx, ctx.user.id, 'checkout_started', { familyId: f.id, kind: 'subscription' });
      return { url: session.url };
    });

    // Parents buy a pass the club has offered to their child or family
    r.post('/api/checkout/pass', ...member('parent'), usable, async (ctx) => {
      const id = toInt(ctx.body.passId);
      const [p] = id ? await sql`select * from app.passes where id = ${id} and club_id = ${ctx.user.club_id}` : [];
      let f = null;
      let label = '';
      if (p?.athlete_id) {
        const a = await athleteFor(ctx, p.athlete_id).catch(() => null);
        if (a) { f = await familyOf(a); label = a.name; }
      } else if (p?.family_id) {
        f = await familyFor(ctx, p.family_id).catch(() => null);
        if (f) label = `${surnameOf((await familyMembers(f.id))[0]?.name || '')} family`;
      }
      if (!p || !f) throw new HttpError(404, 'Pass not found.');
      if (p.status !== 'offered') throw new HttpError(409, p.status === 'active' ? 'That pass is already paid for.' : 'That pass is no longer on offer.');
      const club = await clubOf(ctx);
      const opts = clubPayments(club);
      if (methodFor(f, clubPaymentMethods(club)) !== 'card') throw new HttpError(409, 'The club has set your family to pay by bank transfer. The details are on your Payments page.');
      const customer = await ensureCustomer(f, ctx, opts);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment', customer,
        line_items: [
          { quantity: 1, price_data: { currency: 'nzd', unit_amount: cents(p.price), product_data: { name: `${p.sessions}-Session Pass (${label})` } } },
          ...(clubPaymentMethods(club).cardFee === 'parents' && cardFeeFor(p.price) > 0
            ? [{ quantity: 1, price_data: { currency: 'nzd', unit_amount: cents(cardFeeFor(p.price)), product_data: { name: 'Card processing fee' } } }] : []),
        ],
        metadata: { passId: String(p.id), familyId: String(f.id), kind: 'pass', sessions: String(p.sessions) },
        success_url: `${appUrl}/?checkout=success`, cancel_url: `${appUrl}/?checkout=cancelled`,
      }, opts);
      await audit(ctx, ctx.user.id, 'checkout_started', { passId: p.id, kind: 'pass' });
      return { url: session.url };
    });

    r.post('/api/portal', ...member('parent'), usable, async (ctx) => {
      const f = await familyFromBody(ctx);
      const opts = clubPayments(await clubOf(ctx));
      if (!f.billing.customerId) bad('There are no saved card details yet.');
      const session = await stripe.billingPortal.sessions.create({ customer: f.billing.customerId, return_url: `${appUrl}/` }, opts);
      return { url: session.url };
    });
  }

  // ---------- Stripe webhook events from clubs' connected accounts ----------

  const FREQ_TITLE = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly' };
  const addIncome = (clubId, tx) => sql`
    insert into app.transactions (club_id, data, ref)
    values (${clubId}, ${sql.json({ date: todayIso(), type: 'Income', gst: true, category: tx.category, description: tx.description, amount: tx.amount })}, ${tx.ref})
    on conflict (ref) do nothing`;

  async function handleStripeEvent(event) {
    const [clubRow] = await sql`select id from app.clubs where billing->>'connectAccountId' = ${String(event.account)}`;
    if (!clubRow) return; // not one of ours
    const clubId = clubRow.id;
    const club = await auth.getClub(clubId);
    const opts = connectOpts(club);
    const obj = event.data.object;
    // Only families of the club whose account sent the event can be touched
    const familyInClub = async (id) => { const f = await getFamily(id); return f && f.club_id === clubId ? f : null; };
    const familyForSub = async (sub) => (await familyInClub(sub.metadata?.familyId)) || (await familyByCustomer(sub.customer, clubId));

    switch (event.type) {
      case 'account.updated':
        await sql`update app.clubs set billing = billing || ${sql.json({ connectChargesEnabled: Boolean(obj.charges_enabled) })} where id = ${clubId}`;
        break;
      case 'checkout.session.completed': {
        const s = await stripe.checkout.sessions.retrieve(obj.id, { expand: ['subscription.default_payment_method', 'payment_intent.payment_method'] }, opts);
        const f = await familyInClub(s.metadata?.familyId);
        if (!f) break;
        const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id;
        if (s.mode === 'subscription' && s.subscription) {
          await sql`update app.families set status = 'paid' where id = ${f.id}`;
          await setFamilyBilling(f.id, {
            customerId, subscriptionId: s.subscription.id, subscriptionActive: true, cancelAtPeriodEnd: false,
            nextBillingDate: isoFromUnix(periodEnd(s.subscription)),
            cardLast4: s.subscription.default_payment_method?.card?.last4 || f.billing.cardLast4 || null,
          });
          if (!f.pay_method) await sql`update app.families set pay_method = 'card' where id = ${f.id}`;
        }
        if (s.mode === 'payment' && s.payment_status === 'paid') {
          // The offered pass starts working (only a pass of this club, and only once)
          const passId = toInt(s.metadata?.passId);
          const [p] = passId ? await sql`select * from app.passes where id = ${passId} and club_id = ${clubId}` : [];
          const sessions = p ? p.sessions : Math.min(Math.max(toInt(s.metadata?.sessions) || 10, 1), 500);
          await addIncome(clubId, { category: 'Session Pass', description: `${p ? await passOwnerName(p) : 'Member'} - ${sessions}-Session Pass (Card)`, amount: s.amount_total / 100, ref: s.id });
          if (p && p.status === 'offered') {
            await sql`update app.passes set status = 'active', paid_by = 'card', ref = ${s.id} where id = ${p.id} and status = 'offered'`;
          }
          await setFamilyBilling(f.id, { customerId, cardLast4: s.payment_intent?.payment_method?.card?.last4 || f.billing.cardLast4 || null });
        }
        break;
      }
      case 'invoice.paid': {
        const f = await familyByCustomer(obj.customer, clubId);
        if (!f) break;
        await sql`update app.families set status = 'paid' where id = ${f.id}`;
        if (obj.amount_paid > 0) {
          const view = await familyPayload(f, club);
          await addIncome(clubId, { category: 'Subscription', description: `${view.name} - ${FREQ_TITLE[f.frequency] || ''} fees`, amount: obj.amount_paid / 100, ref: obj.id });
        }
        const fields = { lastPaidOn: todayIso() };
        if (subscriptionActive(f)) fields.nextBillingDate = isoFromUnix(periodEnd(await stripe.subscriptions.retrieve(f.billing.subscriptionId, {}, opts)));
        await setFamilyBilling(f.id, fields);
        break;
      }
      case 'invoice.payment_failed': {
        const f = await familyByCustomer(obj.customer, clubId);
        if (f) await sql`update app.families set status = 'overdue' where id = ${f.id}`;
        break;
      }
      case 'customer.subscription.updated': {
        const f = await familyForSub(obj);
        if (!f) break;
        if (['past_due', 'unpaid'].includes(obj.status)) await sql`update app.families set status = 'overdue' where id = ${f.id}`;
        if (obj.status === 'active' && f.status === 'overdue') await sql`update app.families set status = 'paid' where id = ${f.id}`;
        await setFamilyBilling(f.id, { nextBillingDate: isoFromUnix(periodEnd(obj)) || f.billing.nextBillingDate || null, cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end) });
        break;
      }
      case 'customer.subscription.deleted': {
        const f = await familyForSub(obj);
        if (f && (!f.billing.subscriptionId || f.billing.subscriptionId === obj.id)) {
          await setFamilyBilling(f.id, { subscriptionActive: false, subscriptionId: null, nextBillingDate: null, cancelAtPeriodEnd: false });
        }
        break;
      }
      default:
        break;
    }
  }

  return { routes, handleStripeEvent, regroupFamilies };
}
