// Club data: members, groups & timetables, bookings, attendance, ledger, settings.
// Every route checks the signed-in person's role AND club: nothing ever crosses from one club to
// another, and parents only ever receive their own children.

import { encrypt, decrypt } from './security.js';
import { HttpError, toInt } from './http.js';
import { assertUsable, sampleData, text, longText, isEmail, isPhone } from './rules.js';

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
  const prices = ['weekly', 'fortnightly', 'monthly', 'pass'].map((k) => Number(body[k]));
  if (prices.some((n) => !Number.isFinite(n) || n < 0 || n > 100000)) bad('Enter all four prices.');
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
    weekly: prices[0], fortnightly: prices[1], monthly: prices[2], pass: prices[3], sessions,
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
    ...(row.private_enc ? JSON.parse(decrypt(row.private_enc)) : {}), id: row.id, clubId: row.club_id,
  });
  const getAthlete = async (id) => {
    const n = toInt(id);
    const [r] = n ? await sql`select * from app.athletes where id = ${n}` : [];
    return r ? readAthlete(r) : null;
  };
  const writeAthlete = async (a, q = sql) => {
    const { id, clubId, ...fields } = a;
    const { priv, rest } = splitPrivate(fields);
    await q`update app.athletes set data = ${sql.json(rest)}, private_enc = ${encrypt(JSON.stringify(priv))} where id = ${id}`;
  };

  const getBilling = async (athleteId) => (await sql`select data from app.billing where athlete_id = ${athleteId}`)[0]?.data || {};
  const setBilling = (athleteId, b) => sql`insert into app.billing (athlete_id, data) values (${athleteId}, ${sql.json(b)})
                                           on conflict (athlete_id) do update set data = excluded.data`;
  const athleteIdForCustomer = async (customerId, clubId) => (await sql`
    select b.athlete_id from app.billing b join app.athletes a on a.id = b.athlete_id
    where a.club_id = ${clubId} and b.data->>'customerId' = ${String(customerId)} limit 1`)[0]?.athlete_id;

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

  // What each role may see about a member
  function project(a, viewer, b) {
    const active = Boolean(b.subscriptionId) && b.status !== 'canceled';
    const out = {
      id: a.id, name: a.name, squadId: a.squadId, frequency: a.frequency,
      status: b.status === 'paid' || b.status === 'overdue' ? b.status : a.status,
      regularSessions: a.regularSessions || [],
      hasSubscription: active, autoDebit: active,
      cardLast4: b.cardLast4 || null, nextBillingDate: active ? b.nextBillingDate || null : null,
      parent: a.parent, phone: a.phone, email: a.email, address: a.address,
    };
    if (viewer.role === 'coach' || viewer.role === 'parent') {
      Object.assign(out, { emergency: a.emergency, allergies: a.allergies, medication: a.medication });
    }
    return out;
  }
  const projectOne = async (a, viewer) => project(a, viewer, await getBilling(a.id));

  async function visibleAthletes(user) {
    const rows = user.role === 'parent'
      ? await sql`select a.* from app.athletes a join app.user_athletes ua on ua.athlete_id = a.id
                  where ua.user_id = ${user.id} and a.club_id = ${user.club_id} order by a.id`
      : await sql`select * from app.athletes where club_id = ${user.club_id} order by id`;
    return rows.map(readAthlete);
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

  // ---------- Plan changes (moves the Stripe subscription when there is one) ----------

  const INTERVALS = { weekly: { interval: 'week', interval_count: 1 }, fortnightly: { interval: 'week', interval_count: 2 }, monthly: { interval: 'month', interval_count: 1 } };
  const cents = (n) => Math.round(Number(n) * 100);
  const isoFromUnix = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : null);
  const periodEnd = (sub) => sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end;

  // Parent payments run on each club's own connected Stripe account (money goes to the club)
  const connectOpts = (club) => ({ stripeAccount: club.billing.connectAccountId });
  function clubPayments(club) {
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

  async function changePlan(a, squadId, frequency) {
    const squad = await getSquad(squadId, a.clubId);
    if (!squad) bad('Choose a group.');
    if (!FREQS.has(frequency)) bad('Choose weekly, fortnightly or monthly.');
    const b = await getBilling(a.id);
    if (b.subscriptionId && b.status !== 'canceled') {
      const opts = clubPayments(await auth.getClub(a.clubId));
      const sub = await stripe.subscriptions.retrieve(b.subscriptionId, {}, opts);
      const price = await recurringPrice(squad, frequency, opts);
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: sub.items.data[0].id, price }],
        proration_behavior: 'create_prorations',
        metadata: { ...sub.metadata, squadId: String(squad.id), frequency },
      }, opts);
      await setBilling(a.id, { ...b, squadId: squad.id, frequency, nextBillingDate: isoFromUnix(periodEnd(updated)) });
    }
    const movedSquad = squad.id !== a.squadId;
    const next = { ...a, squadId: squad.id, frequency, ...(movedSquad ? { regularSessions: [] } : {}) };
    await writeAthlete(next);
    if (movedSquad) await sql`delete from app.rsvps where athlete_id = ${a.id} and date >= ${todayIso()}`;
    return next;
  }

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
          ...base, sample: true, squads: sample.squads, athletes: sample.athletes, regularCounts: sample.regularCounts,
          rsvps: {}, attendance: {}, transactions: STAFF.has(user.role) ? sample.transactions : [],
        };
      }
      const athletes = await visibleAthletes(user);
      const ids = new Set(athletes.map((a) => a.id));
      const billing = new Map((await sql`select b.athlete_id, b.data from app.billing b join app.athletes a on a.id = b.athlete_id
                                         where a.club_id = ${user.club_id}`).map((row) => [row.athlete_id, row.data]));
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
        squads: await allSquads(user.club_id),
        athletes: athletes.map((a) => project(a, user, billing.get(a.id) || {})),
        regularCounts: await regularCounts(user.club_id),
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
      const { priv, rest } = splitPrivate({ status: 'paid', ...fields, regularSessions: [] });
      const [row] = await sql`insert into app.athletes (club_id, data, private_enc)
                              values (${ctx.user.club_id}, ${sql.json(rest)}, ${encrypt(JSON.stringify(priv))}) returning *`;
      const created = readAthlete(row);
      await audit(ctx, ctx.user.id, 'athlete_created', { athleteId: created.id });
      return { athlete: await projectOne(created, ctx.user) };
    });

    r.put('/api/athletes/:id', ...member('coach', 'treasurer'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.params.id, { staffOnly: true });
      const fields = await cleanAthleteFields(ctx.body, { allowMedical: ctx.user.role === 'coach', partial: true, clubId: ctx.user.club_id });
      const { squadId = a.squadId, frequency = a.frequency, ...rest } = fields;
      let next = a;
      if (squadId !== a.squadId || frequency !== a.frequency) next = await changePlan(a, squadId, frequency);
      if ((await getBilling(a.id)).subscriptionId) delete rest.status; // Stripe decides paid/overdue
      next = { ...next, ...rest };
      await writeAthlete(next);
      await audit(ctx, ctx.user.id, 'athlete_updated', { athleteId: a.id, fields: Object.keys(fields) });
      return { athlete: await projectOne(next, ctx.user) };
    });

    // Permanently remove a member and everything about them: contact and medical details, bookings,
    // attendance, payment links and parent links. Ledger entries stay, because clubs must keep
    // financial records for tax.
    r.delete('/api/athletes/:id', ...member('coach'), async (ctx) => {
      const a = await athleteFor(ctx, ctx.params.id, { staffOnly: true });
      await sql`delete from app.athletes where id = ${a.id} and club_id = ${ctx.user.club_id}`; // cascades to the rest
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

    r.post('/api/athletes/:id/plan', ...member(), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.params.id);
      // Parents can change how often they pay; only staff move members between groups
      const squadId = ctx.user.role === 'parent' ? a.squadId : toInt(ctx.body.squadId ?? a.squadId);
      const next = await changePlan(a, squadId, String(ctx.body.frequency ?? a.frequency));
      await audit(ctx, ctx.user.id, 'plan_changed', { athleteId: a.id, squadId, frequency: next.frequency });
      return { athlete: await projectOne(next, ctx.user) };
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
      await sql`insert into app.attendance (athlete_id, series_id, date, present, marked_by)
                values (${a.id}, ${seriesId}, ${date}, ${Boolean(ctx.body.present)}, ${ctx.user.id})
                on conflict (athlete_id, series_id, date) do update set present = excluded.present, marked_by = excluded.marked_by`;
      return { ok: true };
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
        for (const id of members) {
          await tx`insert into app.attendance (athlete_id, series_id, date, present, marked_by) values (${id}, ${seriesId}, ${date}, true, ${ctx.user.id})
                   on conflict (athlete_id, series_id, date) do update set present = true, marked_by = excluded.marked_by`;
        }
      });
      return { ok: true };
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
        if (!['04-01', '07-01', '01-01'].includes(ctx.body.financialYearStart)) bad('Choose a financial year start.');
        next.financialYearStart = ctx.body.financialYearStart;
      }
      if ('smsTemplate' in ctx.body) next.smsTemplate = text(ctx.body.smsTemplate, 480);
      if ('emailTemplate' in ctx.body) next.emailTemplate = longText(ctx.body.emailTemplate, 3000);
      await sql`update app.clubs set settings = ${sql.json(next)} where id = ${club.id}`;
      return next;
    });

    // ----- Parent payments (on the club's own Stripe account) -----

    async function ensureCustomer(a, opts) {
      const b = await getBilling(a.id);
      if (b.customerId) return b.customerId;
      const customer = await stripe.customers.create({ name: a.parent || a.name, email: a.email || undefined, metadata: { athleteId: String(a.id), athleteName: a.name } }, opts);
      await setBilling(a.id, { ...b, customerId: customer.id, athleteName: a.name });
      return customer.id;
    }

    r.post('/api/checkout/subscription', ...member('parent'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.body.athleteId);
      const opts = clubPayments(await clubOf(ctx));
      const b = await getBilling(a.id);
      if (b.subscriptionId && b.status !== 'canceled') throw new HttpError(409, 'Automatic payments are already set up. Change how often you pay instead.');
      const squad = await getSquad(a.squadId, a.clubId);
      if (!squad) bad('This athlete is not in a group yet.');
      const customer = await ensureCustomer(a, opts);
      const price = await recurringPrice(squad, a.frequency, opts);
      const meta = { athleteId: String(a.id), athleteName: a.name, squadId: String(squad.id), frequency: a.frequency, kind: 'subscription' };
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription', customer, line_items: [{ price, quantity: 1 }], metadata: meta, subscription_data: { metadata: meta },
        success_url: `${appUrl}/?checkout=success`, cancel_url: `${appUrl}/?checkout=cancelled`,
      }, opts);
      await audit(ctx, ctx.user.id, 'checkout_started', { athleteId: a.id, kind: 'subscription' });
      return { url: session.url };
    });

    r.post('/api/checkout/pass', ...member('parent'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.body.athleteId);
      const opts = clubPayments(await clubOf(ctx));
      const squad = await getSquad(a.squadId, a.clubId);
      if (!squad) bad('This athlete is not in a group yet.');
      const customer = await ensureCustomer(a, opts);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment', customer,
        line_items: [{ quantity: 1, price_data: { currency: 'nzd', unit_amount: cents(squad.pass), product_data: { name: `${squad.name} — 10-Session Pass` } } }],
        metadata: { athleteId: String(a.id), athleteName: a.name, squadId: String(squad.id), kind: 'pass' },
        success_url: `${appUrl}/?checkout=success`, cancel_url: `${appUrl}/?checkout=cancelled`,
      }, opts);
      await audit(ctx, ctx.user.id, 'checkout_started', { athleteId: a.id, kind: 'pass' });
      return { url: session.url };
    });

    r.post('/api/portal', ...member('parent'), usable, async (ctx) => {
      const a = await athleteFor(ctx, ctx.body.athleteId);
      const opts = clubPayments(await clubOf(ctx));
      const b = await getBilling(a.id);
      if (!b.customerId) bad('There are no saved payment details yet.');
      const session = await stripe.billingPortal.sessions.create({ customer: b.customerId, return_url: `${appUrl}/` }, opts);
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
    // Only members of the club whose account sent the event can be touched
    const athleteInClub = async (id) => { const a = await getAthlete(id); return a && a.clubId === clubId ? a : null; };
    const athleteForSub = async (sub) => {
      const fromMeta = toInt(sub.metadata?.athleteId);
      if (fromMeta && (await athleteInClub(fromMeta))) return fromMeta;
      return athleteIdForCustomer(sub.customer, clubId);
    };

    switch (event.type) {
      case 'account.updated':
        await sql`update app.clubs set billing = billing || ${sql.json({ connectChargesEnabled: Boolean(obj.charges_enabled) })} where id = ${clubId}`;
        break;
      case 'checkout.session.completed': {
        const s = await stripe.checkout.sessions.retrieve(obj.id, { expand: ['subscription.default_payment_method', 'payment_intent.payment_method'] }, opts);
        const athleteId = toInt(s.metadata?.athleteId);
        if (!athleteId || !(await athleteInClub(athleteId))) break;
        const b = await getBilling(athleteId);
        b.customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id;
        b.athleteName = s.metadata.athleteName || b.athleteName;
        if (s.mode === 'subscription' && s.subscription) {
          Object.assign(b, {
            subscriptionId: s.subscription.id, status: 'paid', frequency: s.metadata.frequency, squadId: toInt(s.metadata.squadId),
            nextBillingDate: isoFromUnix(periodEnd(s.subscription)),
            cardLast4: s.subscription.default_payment_method?.card?.last4 || b.cardLast4,
          });
        }
        if (s.mode === 'payment' && s.payment_status === 'paid') {
          await addIncome(clubId, { category: 'Session Pass', description: `${b.athleteName} - 10-Session Pass`, amount: s.amount_total / 100, ref: s.id });
          b.cardLast4 = s.payment_intent?.payment_method?.card?.last4 || b.cardLast4;
        }
        await setBilling(athleteId, b);
        break;
      }
      case 'invoice.paid': {
        const athleteId = await athleteIdForCustomer(obj.customer, clubId);
        if (!athleteId) break;
        const b = await getBilling(athleteId);
        b.status = 'paid';
        if (obj.amount_paid > 0) {
          await addIncome(clubId, { category: 'Subscription', description: `${b.athleteName || `Member ${athleteId}`} - ${FREQ_TITLE[b.frequency] || ''} Fee`.trim(), amount: obj.amount_paid / 100, ref: obj.id });
        }
        if (b.subscriptionId) b.nextBillingDate = isoFromUnix(periodEnd(await stripe.subscriptions.retrieve(b.subscriptionId, {}, opts)));
        await setBilling(athleteId, b);
        break;
      }
      case 'invoice.payment_failed': {
        const athleteId = await athleteIdForCustomer(obj.customer, clubId);
        if (athleteId) await setBilling(athleteId, { ...(await getBilling(athleteId)), status: 'overdue' });
        break;
      }
      case 'customer.subscription.updated': {
        const athleteId = await athleteForSub(obj);
        if (!athleteId) break;
        const b = await getBilling(athleteId);
        if (['past_due', 'unpaid'].includes(obj.status)) b.status = 'overdue';
        if (obj.status === 'active' && b.status === 'overdue') b.status = 'paid';
        b.nextBillingDate = isoFromUnix(periodEnd(obj)) || b.nextBillingDate;
        await setBilling(athleteId, b);
        break;
      }
      case 'customer.subscription.deleted': {
        const athleteId = await athleteForSub(obj);
        if (athleteId) await setBilling(athleteId, { ...(await getBilling(athleteId)), status: 'canceled', subscriptionId: null, nextBillingDate: null });
        break;
      }
      default:
        break;
    }
  }

  return { routes, handleStripeEvent };
}
