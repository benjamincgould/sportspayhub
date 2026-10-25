// Shared rules about clubs: what each status allows, how branding and typed text are checked,
// and the sample data a club sees while previewing.

import { HttpError } from './http.js';
import sampleSquads from './sample-squads.js';

export const USABLE = new Set(['active', 'comped', 'past_due']);
export const canUse = (club) => Boolean(club) && USABLE.has(club.status);

const LOCKED_MESSAGE = {
  preview: "You're previewing the app with sample data. A coach can subscribe in Settings to start using it with your own club.",
  canceled: "Your club's subscription has ended, so the app is look-only. A coach can resubscribe in Settings; your data is kept.",
  suspended: "This club's access has been switched off. Please contact the app provider.",
};

export function assertUsable(club) {
  if (!club) throw new HttpError(403, "Your account doesn't have access to that.");
  if (!canUse(club)) throw new HttpError(402, LOCKED_MESSAGE[club.status] || LOCKED_MESSAGE.preview, { locked: true });
}

// ---------- Branding ----------

export const COLOURS = ['indigo', 'blue', 'sky', 'teal', 'green', 'red', 'orange', 'purple', 'pink', 'slate'];
export const WORD_DEFAULTS = { group: 'Squad', groups: 'Squads', member: 'Athlete', members: 'Athletes' };
const MAX_LOGO_BYTES = 200 * 1024;

const word = (v, fallback) => {
  const w = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!w) return fallback;
  if (!/^[\p{L}\p{M}' -]+$/u.test(w)) throw new HttpError(400, 'Use letters only for the names of groups and members.');
  return w;
};
const plural = (w) => (/(s|x|ch|sh)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);

// Only PNG, JPEG or WebP images, checked by their actual bytes (never SVG, which can carry scripts)
function cleanLogo(value) {
  if (value === null || value === '') return null;
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(String(value));
  if (!m) throw new HttpError(400, 'Upload the logo as a PNG, JPG or WebP image.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_LOGO_BYTES) throw new HttpError(400, 'That logo is too large. Use an image under 200 KB.');
  const sig = {
    png: bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    webp: bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  };
  if (!sig[m[1]]) throw new HttpError(400, "That file doesn't look like a real image. Try exporting it again as PNG or JPG.");
  return `data:image/${m[1]};base64,${bytes.toString('base64')}`;
}

export function cleanBranding(body, current = {}) {
  const next = { ...current };
  if ('group' in body || 'groups' in body) {
    next.group = word(body.group, WORD_DEFAULTS.group);
    next.groups = body.groups ? word(body.groups, plural(next.group)) : plural(next.group);
  }
  if ('member' in body || 'members' in body) {
    next.member = word(body.member, WORD_DEFAULTS.member);
    next.members = body.members ? word(body.members, plural(next.member)) : plural(next.member);
  }
  if ('colour' in body) {
    if (!COLOURS.includes(body.colour)) throw new HttpError(400, 'Choose one of the colours shown.');
    next.colour = body.colour;
  }
  if ('logo' in body) next.logo = cleanLogo(body.logo);
  return next;
}

// Control characters, zero-width characters and right-to-left overrides can hide or reverse text
// on screen, so they're removed from everything people type.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
export const clean = (v) => String(v ?? '').replace(INVISIBLE, '');
export const text = (v, max = 200) => clean(v).replace(/\s+/g, ' ').trim().slice(0, max);
// Same, but keeps line breaks (descriptions, email templates)
export const longText = (v, max = 3000) => String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map(clean).join('\n').slice(0, max);

// Email addresses: plain addresses only. Characters like ? & = , ; could add hidden recipients
// or change a message when the address is put into an email link.
export const isEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[A-Za-z0-9.!#$%'*+/^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(e)
  && !/[?&=,;]/.test(e);
export const normEmail = (e) => String(e ?? '').trim().toLowerCase();
// Phone numbers: digits, spaces and + ( ) - only
export const isPhone = (p) => typeof p === 'string' && p.length <= 30 && /^[+\d(][\d\s()+-]*$/.test(p) && (p.match(/\d/g) || []).length >= 6;

// ---------- What a club pays the platform ----------
// Each club can have its own monthly price and set-up fee (set by the owner); otherwise the
// defaults from the server settings apply.
const money = (v, fallback) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));
export const defaultPriceNzd = () => money(process.env.PLATFORM_PRICE_NZD, 49);
export const defaultSetupFeeNzd = () => money(process.env.PLATFORM_SETUP_FEE_NZD, 0);
export const monthlyPriceNzd = (club) => money(club?.billing?.monthlyPriceNzd, defaultPriceNzd());
export const setupFeeNzd = (club) => money(club?.billing?.setupFeeNzd, defaultSetupFeeNzd());
// The set-up fee still to pay (none once paid, or once invoiced separately)
export const setupFeeDueNzd = (club) => (club?.billing?.setupFeePaid || club?.billing?.setupFeeInvoiced ? 0 : setupFeeNzd(club));
export const toCents = (nzd) => Math.round(Number(nzd) * 100);

// ---------- How parents pay their club: card (Stripe) and/or bank transfer ----------

export function cleanBankAccount(name, number) {
  const digits = String(number || '').replace(/[\s-]/g, '');
  if (digits && !/^\d{15,16}$/.test(digits)) throw new HttpError(400, 'Enter a New Zealand bank account number, like 12-3456-0123456-00.');
  return {
    accountName: text(name, 80),
    accountNumber: digits ? `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 13)}-${digits.slice(13)}` : '',
  };
}

export function clubPaymentMethods(club) {
  const p = club?.settings?.payments || {};
  const bankReady = Boolean(p.bank && p.bankAccountNumber && p.bankAccountName);
  return {
    card: p.card !== false, // the club wants card payments (they also need Stripe connected)
    bank: bankReady ? { accountName: p.bankAccountName, accountNumber: p.bankAccountNumber, instructions: p.instructions || '' } : null,
  };
}

// A bank-transfer reference for a member: letters of their name plus their number, at most 12
// characters (the most NZ banks allow), so every child's payments can be told apart
export function paymentReference(athlete) {
  const id = String(athlete.id);
  const letters = String(athlete.name || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12 - id.length);
  return `${letters}${id}`;
}

// What signed-in club members are told about their club
export function publicClub(club) {
  if (!club) return null;
  const b = club.branding || {};
  return {
    id: club.id, name: club.name, sport: club.sport, status: club.status, canUse: canUse(club),
    branding: { ...WORD_DEFAULTS, colour: 'indigo', logo: null, ...b },
    subscription: {
      renewsOn: club.billing?.renewsOn || null,
      cancelAtPeriodEnd: Boolean(club.billing?.cancelAtPeriodEnd),
      hasBillingAccount: Boolean(club.billing?.platformCustomerId),
      priceNzd: monthlyPriceNzd(club),
      setupFeeNzd: setupFeeDueNzd(club),
    },
    payments: { connected: Boolean(club.billing?.connectChargesEnabled), started: Boolean(club.billing?.connectAccountId), ...clubPaymentMethods(club) },
  };
}

// ---------- Sample data for clubs that are previewing ----------

const SAMPLE_ATHLETES = [
  ['Leo Parker', 1, 'weekly', 'Sarah Parker', 'None', 'None', ['dev-mon', 'dev-sat']],
  ['Mia Chen', 3, 'monthly', 'Grace Chen', 'Peanuts', 'EpiPen (carried in bag)', ['end-mon', 'end-wed', 'end-fri']],
  ['Ruby Walsh', 2, 'weekly', 'Emma Walsh', 'Shellfish', 'Ventolin inhaler', ['brz-tue', 'brz-sat']],
  ['Aria Thompson', 1, 'monthly', 'Kate Thompson', 'None', 'None', ['dev-mon', 'dev-wed', 'dev-sat']],
  ['Noah Smith', 1, 'weekly', 'Priya Smith', 'Bee stings', 'None', ['dev-wed']],
  ['Jack Wilson', 2, 'fortnightly', 'Lucy Wilson', 'None', 'None', ['brz-tue', 'brz-thu']],
];

export function sampleData(viewer) {
  const squads = sampleSquads.map((s) => ({ ...s, id: 900000 + s.id }));
  const athletes = SAMPLE_ATHLETES.map(([name, squad, frequency, parent, allergies, medication, regular], i) => {
    const first = parent.split(' ')[0].toLowerCase();
    const a = {
      id: 900001 + i, name, squadId: 900000 + squad, frequency, status: i === 1 ? 'overdue' : 'paid', regularSessions: regular,
      parent, phone: `021 000 00${String(i + 1).padStart(2, '0')}`, email: `${first}@example.com`, address: `${10 + i} Sample Street`,
      hasSubscription: i % 3 !== 2, autoDebit: i % 3 !== 2, cardLast4: i % 3 !== 2 ? '4242' : null, nextBillingDate: null,
      emergency: `${parent.replace(/^\w+/, 'Alex')} (021 000 09${i})`, allergies, medication,
    };
    a.payRef = paymentReference(a);
    if (viewer.role === 'treasurer') { delete a.emergency; delete a.allergies; delete a.medication; }
    return a;
  });
  const regularCounts = {};
  athletes.forEach((a) => a.regularSessions.forEach((id) => { regularCounts[id] = (regularCounts[id] || 0) + 1; }));
  const today = new Date().toISOString().slice(0, 10);
  const transactions = [
    { id: 900001, date: today, type: 'Income', category: 'Subscription', description: 'Leo Parker - Weekly Fee', amount: 25.5, gst: true },
    { id: 900002, date: today, type: 'Expense', category: 'Facility Hire', description: 'Venue hire', amount: 450, gst: true },
  ];
  return { squads, athletes, regularCounts, transactions };
}
