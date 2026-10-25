import React, { useState, useEffect, useRef } from 'react';
import {
  Home, Calendar, CreditCard, User, Settings, Users, DollarSign, CheckSquare, Layers,
  FileText, Plus, Edit2, Check, X, Shield, Phone, Mail, Printer, Download, RefreshCw,
  Clock, MapPin, Trash2, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Undo2, Copy, Search, LogOut, UserPlus
} from './icons';
import { api } from './api';
import { AccountSecurity, TeamAccess } from './AuthScreens';
import { ClubSettings, PaymentMethodsCard } from './ClubSettings';
import { applyBrandColour } from './brand';

// The app runs two ways:
//  - mode="server": signed in through the club server, which decides what this person may see
//  - mode="demo":   sample data in the browser only, with a role switcher (used for team previews)

// Set window.CLUB_PREVIEW = true when sharing a click-through preview (no downloads or printing there)
const PREVIEW = typeof window !== 'undefined' && window.CLUB_PREVIEW === true;

// ---------- General helpers ----------

const GST_RATE = 0.15; // NZ GST
const gstFromInclusive = (amount) => (amount * GST_RATE) / (1 + GST_RATE); // = amount × 3/23

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date, not UTC
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
const fmtShort = (iso) => parseISO(iso).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
const fmtDay = (iso) => parseISO(iso).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = (d) => d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
// Contact links: a phone link only gets digits and +; an email link only gets a plain address,
// so nothing typed into a profile can add recipients or change the message.
const phoneDigits = (p) => String(p || '').replace(/[^\d+]/g, '');
const mailAddress = (e) => (/^[^\s@?&=,;]+@[^\s@?&=,;]+$/.test(String(e || '')) ? encodeURIComponent(e).replace(/%40/g, '@') : '');
const hasValue = (v) => Boolean(v) && !['', 'none', 'nil', 'n/a', 'na'].includes(String(v).trim().toLowerCase());
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const FREQ_LABEL = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month' };
const FREQ_TITLE = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly' };

// ---------- Timetable helpers ----------
// A squad has sessions. Each session is one version of a weekly "series" (e.g. "Monday evening").
// Scheduling a change ends the current version the day before and starts a new version of the
// same series, so parents' regular-day choices carry over automatically.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtTime = (t) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
};
const sessionLabel = (s) => `${DAY_SHORT[s.day]} ${fmtTime(s.start)}–${fmtTime(s.end)}`;
const isActiveOn = (s, iso) =>
  s.day === parseISO(iso).getDay() && (!s.startsOn || iso >= s.startsOn) && (!s.endsOn || iso <= s.endsOn);

// Concrete sessions for a squad on a given date
const sessionsOn = (squad, iso) => (squad?.sessions || [])
  .filter((s) => isActiveOn(s, iso))
  .sort((a, b) => a.start.localeCompare(b.start))
  .map((s) => {
    const c = (s.cancellations || []).find((x) => x.date === iso);
    return { ...s, date: iso, cancelled: Boolean(c), cancelReason: c?.reason || '' };
  });

// One entry per series: the version running now, or the next one to start
function seriesAsOf(squad, iso) {
  const best = {};
  (squad?.sessions || []).forEach((s) => {
    if (s.endsOn && s.endsOn < iso) return;
    const runningNow = !s.startsOn || s.startsOn <= iso;
    const cur = best[s.seriesId];
    if (!cur || (runningNow && !cur.runningNow) || (!runningNow && !cur.runningNow && s.startsOn < cur.s.startsOn)) {
      best[s.seriesId] = { s, runningNow };
    }
  });
  return Object.values(best).map((x) => x.s).sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
}

const successorOf = (squad, s) => s.endsOn && squad.sessions.find((n) => n.seriesId === s.seriesId && n.startsOn === addDays(s.endsOn, 1));
const predecessorOf = (squad, s) => s.startsOn && squad.sessions.find((p) => p.seriesId === s.seriesId && p.endsOn === addDays(s.startsOn, -1));

// What parents should know is coming up for a series
function seriesNote(squad, s, iso) {
  if (s.startsOn && s.startsOn > iso) return `Starts ${fmtDay(s.startsOn)}`;
  if (s.endsOn) {
    const next = successorOf(squad, s);
    if (!next) return `Last session ${fmtDay(s.endsOn)}`;
    const where = next.location !== s.location ? ` at ${next.location}` : '';
    return `From ${fmtDay(next.startsOn)}: ${sessionLabel(next)}${where}`;
  }
  return null;
}

function nextOccurrences(s, fromIso, count) {
  const out = [];
  let d = fromIso;
  for (let i = 0; i < 400 && out.length < count; i++) {
    if (isActiveOn(s, d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

// Scheduled changes, finishes and cancellations coming up for a squad
function upcomingChanges(squad, iso, horizonDays = 120) {
  const limit = addDays(iso, horizonDays);
  const items = [];
  squad.sessions.forEach((s) => {
    if (s.startsOn && s.startsOn > iso && s.startsOn <= limit) {
      const prev = predecessorOf(squad, s);
      items.push({
        key: `chg-${s.id}`, kind: 'change', date: s.startsOn, sessionId: s.id,
        text: prev ? `${sessionLabel(prev)} changes to ${sessionLabel(s)}${prev.location !== s.location ? ` at ${s.location}` : ''}` : `New session starts: ${sessionLabel(s)}`,
      });
    }
    if (s.endsOn && s.endsOn >= iso && s.endsOn <= limit && !successorOf(squad, s)) {
      items.push({ key: `end-${s.id}`, kind: 'end', date: s.endsOn, sessionId: s.id, text: `${sessionLabel(s)} finishes (last session)` });
    }
    (s.cancellations || []).forEach((c) => {
      if (c.date >= iso && c.date <= limit) {
        items.push({ key: `can-${s.id}-${c.date}`, kind: 'cancel', date: c.date, sessionId: s.id, text: `${sessionLabel(s)} cancelled${c.reason ? ` — ${c.reason}` : ''}` });
      }
    });
  });
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

// ----- Pure timetable edits (squad in, new squad out) -----

const cloneSessions = (squad) => squad.sessions.map((s) => ({ ...s, cancellations: [...(s.cancellations || [])] }));

function addOrEditSession(squad, form, todayIso) {
  const sessions = cloneSessions(squad);
  const fields = { day: Number(form.day), start: form.start, end: form.end, location: form.location.trim() || squad.location };
  const fromDate = form.applyMode === 'date' && form.applyFrom > todayIso ? form.applyFrom : null;

  if (form.mode === 'add') {
    const id = uid('ses');
    sessions.push({ id, seriesId: id, ...fields, startsOn: fromDate, endsOn: null, cancellations: [] });
  } else {
    const i = sessions.findIndex((s) => s.id === form.sessionId);
    const old = sessions[i];
    const schedule = fromDate && (!old.startsOn || fromDate > old.startsOn);
    if (!schedule) {
      sessions[i] = { ...old, ...fields };
    } else {
      sessions.push({
        id: uid('ses'), seriesId: old.seriesId, ...fields, startsOn: fromDate, endsOn: old.endsOn,
        cancellations: old.cancellations.filter((c) => c.date >= fromDate),
      });
      sessions[i] = { ...old, endsOn: addDays(fromDate, -1), cancellations: old.cancellations.filter((c) => c.date < fromDate) };
    }
  }
  return { ...squad, sessions };
}

function cancelOccurrence(squad, sessionId, date, reason) {
  const sessions = cloneSessions(squad);
  const s = sessions.find((x) => x.id === sessionId);
  if (!s.cancellations.some((c) => c.date === date)) s.cancellations.push({ date, reason });
  return { ...squad, sessions };
}

function removeSeries(squad, seriesId, stopFrom, todayIso) {
  const sessions = cloneSessions(squad).flatMap((s) => {
    if (s.seriesId !== seriesId) return [s];
    if (stopFrom <= todayIso) return [];                    // remove straight away
    if (s.startsOn && s.startsOn >= stopFrom) return [];    // a version that never gets to run
    if (!s.endsOn || s.endsOn >= stopFrom) return [{ ...s, endsOn: addDays(stopFrom, -1) }];
    return [s];
  });
  return { ...squad, sessions };
}

function undoChange(squad, item) {
  let sessions = cloneSessions(squad);
  const s = sessions.find((x) => x.id === item.sessionId);
  if (item.kind === 'cancel') {
    s.cancellations = s.cancellations.filter((c) => c.date !== item.date);
  } else if (item.kind === 'change') {
    const prev = predecessorOf({ sessions }, s);
    if (prev) { prev.endsOn = s.endsOn; prev.cancellations = [...prev.cancellations, ...s.cancellations]; }
    sessions = sessions.filter((x) => x.id !== s.id);
  } else if (item.kind === 'end') {
    s.endsOn = null;
  }
  return { ...squad, sessions };
}

// ---------- Finance helpers ----------

// Start of the financial year containing `date`
function fyStartFor(date, fyStart) {
  const [m, d] = fyStart.split('-').map(Number);
  let start = new Date(date.getFullYear(), m - 1, d);
  if (date < start) start = new Date(date.getFullYear() - 1, m - 1, d);
  return start;
}

// Current reporting window (2, 6 or 12 months) aligned to the financial year
function reportWindow(date, fyStart, months) {
  const fy = fyStartFor(date, fyStart);
  const monthsIn = (date.getFullYear() - fy.getFullYear()) * 12 + (date.getMonth() - fy.getMonth()) - (date.getDate() < fy.getDate() ? 1 : 0);
  const offset = Math.floor(monthsIn / months) * months;
  const start = new Date(fy.getFullYear(), fy.getMonth() + offset, fy.getDate());
  const end = new Date(start.getFullYear(), start.getMonth() + months, start.getDate() - 1);
  return { start, end };
}

function summarise(txs) {
  let income = 0, expenses = 0, gstCollected = 0, gstPaid = 0;
  txs.forEach((t) => {
    const g = t.gst ? gstFromInclusive(t.amount) : 0;
    if (t.type === 'Income') { income += t.amount; gstCollected += g; }
    else { expenses += t.amount; gstPaid += g; }
  });
  return { income, expenses, gstCollected, gstPaid, netGst: gstCollected - gstPaid };
}

// ---------- Seed data (fictional) ----------

const SEED_SQUADS = [
  {
    id: 1, name: 'Development Squad', level: 'Ages 7–10 · Learn-to-squad', description: 'Stroke technique and confidence in deep water.',
    location: 'Main Pool', capacity: 16, coach: 'Head Coach',
    weekly: 25.50, fortnightly: 51.00, monthly: 100.00, pass: 130.00,
    sessions: [
      { id: 'dev-mon', seriesId: 'dev-mon', day: 1, start: '17:00', end: '18:00', location: 'Main Pool, Lanes 1–2', startsOn: null, endsOn: null, cancellations: [{ date: '2026-10-26', reason: 'Labour Day' }] },
      { id: 'dev-wed', seriesId: 'dev-wed', day: 3, start: '17:00', end: '18:00', location: 'Main Pool, Lanes 1–2', startsOn: null, endsOn: '2026-11-03', cancellations: [] },
      { id: 'dev-wed-2', seriesId: 'dev-wed', day: 3, start: '17:30', end: '18:30', location: 'Main Pool, Lanes 1–2', startsOn: '2026-11-04', endsOn: null, cancellations: [] },
      { id: 'dev-sat', seriesId: 'dev-sat', day: 6, start: '08:00', end: '09:00', location: 'Main Pool, Lanes 1–3', startsOn: null, endsOn: null, cancellations: [] },
    ],
  },
  {
    id: 2, name: 'Bronze Squad', level: 'Ages 10–13 · Competitive', description: 'Race skills, starts and turns. Club meets each term.',
    location: 'Main Pool', capacity: 20, coach: 'Head Coach',
    weekly: 31.50, fortnightly: 63.00, monthly: 125.00, pass: 150.00,
    sessions: [
      { id: 'brz-tue', seriesId: 'brz-tue', day: 2, start: '17:00', end: '18:15', location: 'Main Pool, Lanes 3–4', startsOn: null, endsOn: null, cancellations: [] },
      { id: 'brz-thu', seriesId: 'brz-thu', day: 4, start: '17:00', end: '18:15', location: 'Main Pool, Lanes 3–4', startsOn: null, endsOn: null, cancellations: [] },
      { id: 'brz-sat', seriesId: 'brz-sat', day: 6, start: '09:00', end: '10:30', location: 'Main Pool, Lanes 3–4', startsOn: null, endsOn: null, cancellations: [{ date: '2026-10-24', reason: 'Pool maintenance' }] },
    ],
  },
  {
    id: 3, name: 'Endurance Squad', level: 'Ages 13+ · Distance & open water', description: 'Aerobic base, distance sets and open-water prep.',
    location: 'Main Pool', capacity: 14, coach: 'Head Coach',
    weekly: 25.20, fortnightly: 50.40, monthly: 100.80, pass: 130.00,
    sessions: [
      { id: 'end-mon', seriesId: 'end-mon', day: 1, start: '05:30', end: '07:00', location: 'Main Pool, Lanes 5–6', startsOn: null, endsOn: null, cancellations: [] },
      { id: 'end-wed', seriesId: 'end-wed', day: 3, start: '05:30', end: '07:00', location: 'Main Pool, Lanes 5–6', startsOn: null, endsOn: null, cancellations: [] },
      { id: 'end-fri', seriesId: 'end-fri', day: 5, start: '05:30', end: '07:00', location: 'Main Pool, Lanes 5–6', startsOn: null, endsOn: null, cancellations: [] },
    ],
  },
];

const navFor = (role, W) => ({
  parent: [['home', Home, 'Home'], ['bookings', Calendar, 'Bookings'], ['payments', CreditCard, 'Payments'], ['settings', Settings, 'Profile']],
  treasurer: [['home', Home, 'Dashboard'], ['athletes', Users, W.members], ['financials', FileText, 'GST Reports'], ['settings', Settings, 'Settings']],
  // Coach has full access: every treasurer screen plus attendance and groups
  coach: [['home', Home, 'Home'], ['attendance', CheckSquare, 'Attendance'], ['athletes', Users, W.members], ['squads', Layers, W.groups], ['financials', FileText, 'Reports'], ['settings', Settings, 'Settings']],
})[role];

// Demo mode's pretend club (server mode uses the signed-in club's own name and words)
const DEMO_CLUB = {
  id: 0, name: 'Skills 4 Life Aquatics', sport: 'Swimming', status: 'active', canUse: true,
  branding: { group: 'Squad', groups: 'Squads', member: 'Athlete', members: 'Athletes', colour: 'indigo', logo: null },
  subscription: {}, payments: { connected: false },
};

const DEMO_PARENT_ATHLETE_ID = 1; // demo: the parent's athlete
// Demo mode only: fictional athletes. regularSessions = series ids they normally attend.
const DEMO_ATHLETES = [
  { id: 1, name: 'Leo Parker', squadId: 1, frequency: 'weekly', status: 'paid', parent: 'Sarah Parker', phone: '021 000 0001', email: 'sarah.parker@example.com', address: '12 Example Street, Hamilton 3200', allergies: 'None', medication: 'None', emergency: 'Mike Parker (021 000 0011)', cardLast4: '4242', autoDebit: true, hasSubscription: true, nextBillingDate: '2026-10-26', regularSessions: ['dev-mon', 'dev-sat'] },
  { id: 2, name: 'Mia Chen', squadId: 3, frequency: 'monthly', status: 'overdue', parent: 'Grace Chen', phone: '021 000 0002', email: 'grace.chen@example.com', address: '45 Sample Road, Cambridge 3434', allergies: 'Peanuts', medication: 'EpiPen (carried in bag)', emergency: 'David Chen (021 000 0022)', cardLast4: '1881', autoDebit: true, hasSubscription: true, nextBillingDate: '2026-11-01', regularSessions: ['end-mon', 'end-wed', 'end-fri'] },
  { id: 3, name: 'Ruby Walsh', squadId: 2, frequency: 'weekly', status: 'paid', parent: 'Emma Walsh', phone: '021 000 0003', email: 'emma.walsh@example.com', address: '7 Demo Lane, Te Awamutu 3800', allergies: 'Shellfish', medication: 'Ventolin inhaler (asthma)', emergency: 'Tom Walsh (021 000 0033)', cardLast4: '0005', autoDebit: false, hasSubscription: false, nextBillingDate: null, regularSessions: ['brz-tue', 'brz-sat'] },
  { id: 4, name: 'Aria Thompson', squadId: 1, frequency: 'monthly', status: 'paid', parent: 'Kate Thompson', phone: '021 000 0004', email: 'kate.thompson@example.com', address: '3 Placeholder Place, Hamilton 3204', allergies: 'None', medication: 'None', emergency: 'Ben Thompson (021 000 0044)', cardLast4: '3220', autoDebit: true, hasSubscription: true, nextBillingDate: '2026-11-05', regularSessions: ['dev-mon', 'dev-wed', 'dev-sat'] },
  { id: 5, name: 'Noah Smith', squadId: 1, frequency: 'weekly', status: 'paid', parent: 'Priya Smith', phone: '021 000 0005', email: 'priya.smith@example.com', address: '88 Mock Avenue, Hamilton 3210', allergies: 'Bee stings', medication: 'None', emergency: 'Sam Smith (021 000 0055)', cardLast4: '9995', autoDebit: true, hasSubscription: true, nextBillingDate: '2026-10-22', regularSessions: ['dev-wed'] },
  { id: 6, name: 'Jack Wilson', squadId: 2, frequency: 'fortnightly', status: 'paid', parent: 'Lucy Wilson', phone: '021 000 0006', email: 'lucy.wilson@example.com', address: '19 Trial Street, Cambridge 3432', allergies: 'None', medication: 'None', emergency: 'Chris Wilson (021 000 0066)', cardLast4: '4444', autoDebit: true, hasSubscription: true, nextBillingDate: '2026-10-29', regularSessions: ['brz-tue', 'brz-thu'] },
  { id: 7, name: 'Ella Brown', squadId: 3, frequency: 'weekly', status: 'paid', parent: 'Hannah Brown', phone: '021 000 0007', email: 'hannah.brown@example.com', address: '5 Sample Crescent, Te Awamutu 3800', allergies: 'None', medication: 'None', emergency: 'Josh Brown (021 000 0077)', cardLast4: '1117', autoDebit: false, hasSubscription: false, nextBillingDate: null, regularSessions: ['end-wed'] },
  { id: 8, name: 'Isla Parker', squadId: 2, frequency: 'weekly', status: 'paid', parent: 'Sarah Parker', phone: '021 000 0001', email: 'sarah.parker@example.com', address: '12 Example Street, Hamilton 3200', allergies: 'None', medication: 'None', emergency: 'Mike Parker (021 000 0011)', cardLast4: '4242', autoDebit: true, hasSubscription: true, nextBillingDate: '2026-10-26', regularSessions: ['brz-tue'] },
];

// Demo mode only: sample ledger (amounts are GST-inclusive; gst = whether GST applies)
// Demo mode only: Ruby has a pass the club gave her (paid in cash); the coach has offered Leo one
const DEMO_PASSES = [
  { id: 1, athleteId: 3, familyId: null, sessions: 10, used: 3, left: 7, price: 150, paidBy: 'cash', status: 'active', issuedOn: '2026-10-01' },
  { id: 2, athleteId: 1, familyId: null, sessions: 5, used: 0, left: 5, price: 60, paidBy: 'unpaid', status: 'offered', issuedOn: '2026-10-20' },
];
const PAID_BY_LABEL = { card: 'Card', bank: 'Bank transfer', cash: 'Cash', free: 'Free', unpaid: 'Not paid yet' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const DEMO_TRANSACTIONS = [
  { id: 1, date: '2026-10-01', type: 'Income', category: 'Stripe Subscription', description: 'Leo Parker - Weekly Fee', amount: 25.50, gst: true },
  { id: 2, date: '2026-10-05', type: 'Expense', category: 'Facility Hire', description: 'Pool Lane Rental - October', amount: 450.00, gst: true },
  { id: 3, date: '2026-10-10', type: 'Income', category: 'Sponsorship', description: 'Local business sponsorship grant', amount: 1000.00, gst: false },
];

const BOOKING_DAYS = 14;     // how far ahead parents can see and change sessions

const inputCls = 'w-full mt-1 p-2 border border-slate-200 rounded-lg text-sm bg-white disabled:bg-slate-50 disabled:text-slate-400';
const card = 'bg-white p-4 rounded-xl shadow-sm border border-slate-100';
const primaryBtn = 'py-2.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-1 disabled:opacity-50';
const ghostBtn = 'py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold flex items-center justify-center gap-1';
const chipBtn = 'text-[11px] bg-slate-100 text-slate-700 px-2 py-1 rounded-md font-medium flex items-center gap-1';

const Field = ({ label, children }) => (
  <div>
    <label className="text-xs text-slate-400 block">{label}</label>
    {children}
  </div>
);

export default function SportsClubApp({ mode = 'demo', session = null, signOut, updateUser }) {
  const remote = mode === 'server';
  const me = session?.user || null;
  const club = remote ? (me?.club || DEMO_CLUB) : DEMO_CLUB;
  const W = { ...DEMO_CLUB.branding, ...club.branding }; // what this club calls groups and members
  const lc = (t) => t.toLowerCase();

  // Global App State (in server mode the role comes from the signed-in account, never from the page)
  const [currentRole, setCurrentRole] = useState(remote ? me.role : 'treasurer'); // 'parent' | 'treasurer' | 'coach'
  const [activeTab, setActiveTab] = useState('home');

  // Financial Year & Settings State
  const [financialYearStart, setFinancialYearStart] = useState('04-01'); // NZ standard balance date
  const [smsTemplate, setSmsTemplate] = useState("Hi {ParentName}, missed payment of ${Amount} for {AthleteName}. Pay here: {PaymentLink}");
  const [emailTemplate, setEmailTemplate] = useState("Dear {ParentName},\n\nPayment of ${Amount} for {AthleteName} is overdue.\n\nPlease update your billing details securely: {PaymentLink}");

  // Squads, pricing & timetables (athletes reference squads by id, so renames flow through)
  const [squads, setSquads] = useState(remote ? [] : SEED_SQUADS);

  // Athletes (regularSessions = series ids they normally attend)
  const [athletes, setAthletes] = useState(remote ? [] : DEMO_ATHLETES);

  // Ledger (amounts are GST-inclusive; gst = whether GST applies)
  const [transactions, setTransactions] = useState(remote ? [] : DEMO_TRANSACTIONS);

  // Attendance & RSVP State, keyed `${athleteId}|${seriesId}|${date}`
  const [attendance, setAttendance] = useState({});
  const [rsvpOverrides, setRsvpOverrides] = useState({});

  // UI state
  const [reportMonths, setReportMonths] = useState(2);
  const [editingAthleteId, setEditingAthleteId] = useState(null);
  const [athleteDraft, setAthleteDraft] = useState(null);
  const [squadForm, setSquadForm] = useState(null);       // create / edit squad details
  const [openTimetable, setOpenTimetable] = useState(null);
  const [sessionForm, setSessionForm] = useState(null);   // add / edit / cancel / remove a session
  const [reminderFor, setReminderFor] = useState(null);
  const [flash, setFlash] = useState('');
  const [showAddTx, setShowAddTx] = useState(false);
  const [busy, setBusy] = useState('');
  const [serverError, setServerError] = useState('');

  const today = new Date();
  const todayISO = toISO(today);
  const [attendanceDate, setAttendanceDate] = useState(todayISO);
  const blankTx = { date: todayISO, type: 'Expense', category: '', description: '', amount: '', gst: true };
  const [newTx, setNewTx] = useState(blankTx);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [copyFallback, setCopyFallback] = useState(null); // text to show when the clipboard isn't available
  const [attendanceSquadId, setAttendanceSquadId] = useState(null);   // group the coach is marking
  const [attendanceSessionId, setAttendanceSessionId] = useState(null); // when a group trains twice in a day
  const [athleteSearch, setAthleteSearch] = useState('');
  const [expandedAthleteId, setExpandedAthleteId] = useState(null);

  // ---------- Derived data ----------
  const isCoach = currentRole === 'coach';
  const squadById = (id) => squads.find((s) => s.id === id);
  const priceFor = (a) => squadById(a.squadId)?.[a.frequency] ?? 0;

  const fyStart = fyStartFor(today, financialYearStart);
  const ytdTx = transactions.filter((t) => { const d = parseISO(t.date); return d >= fyStart && d <= today; });
  const ytd = summarise(ytdTx);
  const overdueAthletes = athletes.filter((a) => a.status === 'overdue');

  const win = reportWindow(today, financialYearStart, reportMonths);
  const reportTx = transactions
    .filter((t) => { const d = parseISO(t.date); return d >= win.start && d <= win.end; })
    .sort((a, b) => a.date.localeCompare(b.date));
  const report = summarise(reportTx);

  const profileFromAthlete = (a) => ({ phone: a.phone || '', email: a.email || '', address: a.address || '', emergency: a.emergency || '', allergies: a.allergies || '', medication: a.medication || '' });
  const [loaded, setLoaded] = useState(!remote);           // server data has arrived
  const [regularCounts, setRegularCounts] = useState({});   // server mode: regulars per session, all families
  const [paymentsConnected, setPaymentsConnected] = useState(false);
  const [showAddAthlete, setShowAddAthlete] = useState(false);
  const [newAthlete, setNewAthlete] = useState(null);
  const [inviteRequest, setInviteRequest] = useState(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [recording, setRecording] = useState(null); // { id, amount } while recording a family's bank payment
  const [familiesState, setFamilies] = useState([]);
  const [passes, setPasses] = useState(remote ? [] : DEMO_PASSES);
  const flashTimer = useRef(null);
  const [passForm, setPassForm] = useState(null);     // a new pass: { athleteId, sessions, price, paidBy ('offer' = parents buy it), forFamily }
  const [passEdit, setPassEdit] = useState(null);     // changing sessions left: { id, left }
  const [profileDrafts, setProfileDrafts] = useState({}); // parent: unsaved profile edits, per child
  const [confirmDeleteAthlete, setConfirmDeleteAthlete] = useState(null);

  // Parents see all their children together, billed as one family
  const parentAthletes = remote ? (currentRole === 'parent' ? athletes : []) : athletes.filter((a) => a.parent === athletes.find((x) => x.id === DEMO_PARENT_ATHLETE_ID)?.parent);
  const parentAthlete = parentAthletes[0] || null;

  // Families: brothers and sisters share one schedule, one way of paying (set by the club), one
  // status, one bank reference and one total. (The demo treats each child as their own family.)
  const surnameOf = (n) => String(n || '').trim().split(/\s+/).pop() || '';
  // Demo mode: children with the same parent make one family
  const demoFamilies = () => {
    const groups = new Map();
    for (const a of athletes) {
      const key = (a.parent || '').trim().toLowerCase() || `id-${a.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    return [...groups.values()].map((kids) => {
      const a = kids[0];
      return {
        id: a.id, name: `${surnameOf(a.name)} family`, reference: `${surnameOf(a.name).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 9)}F${a.id}`,
        athleteIds: kids.map((k) => k.id), frequency: a.frequency,
        total: kids.reduce((sum, k) => sum + Number(squadById(k.squadId)?.[a.frequency] || 0), 0),
        payMethod: 'card', payMethodChosen: true, status: kids.some((k) => k.status === 'overdue') ? 'overdue' : 'paid',
        hasSubscription: Boolean(a.hasSubscription), cardLast4: a.cardLast4, nextBillingDate: a.nextBillingDate, cardStopping: false, lastPaidOn: a.lastPaidOn || null,
      };
    });
  };
  const families = remote ? familiesState : demoFamilies();
  const membersOf = (f) => athletes.filter((a) => f.athleteIds.includes(a.id));
  // Passes are for one child, or for a whole family (shared by the children)
  const familyIdOf = (athleteId) => families.find((f) => f.athleteIds.includes(athleteId))?.id ?? null;
  const passBelongs = (p, athleteId) => p.athleteId === athleteId || (p.familyId != null && p.familyId === familyIdOf(athleteId));
  const passesFor = (athleteId) => passes.filter((p) => p.status === 'active' && passBelongs(p, athleteId));
  const offersFor = (athleteId) => passes.filter((p) => p.status === 'offered' && passBelongs(p, athleteId));
  const passLeft = (athleteId) => passesFor(athleteId).reduce((sum, p) => sum + p.left, 0);
  const hasPass = (athleteId) => passesFor(athleteId).length > 0;
  // The server sends a child's current passes after a change
  const mergePasses = (list) => {
    const ids = new Set(list.map((p) => p.id));
    setPasses((prev) => [...prev.filter((p) => !ids.has(p.id)), ...list]);
  };
  const parentFamilies = families.filter((f) => f.athleteIds.some((id) => parentAthletes.some((a) => a.id === id)));

  const rsvpKey = (athleteId, seriesId, date) => `${athleteId}|${seriesId}|${date}`;
  const isAttending = (a, s) => {
    if (s.cancelled) return false;
    const o = rsvpOverrides[rsvpKey(a.id, s.seriesId, s.date)];
    return o !== undefined ? o : (a.regularSessions || []).includes(s.seriesId);
  };
  const squadAthletes = (squadId) => athletes.filter((a) => a.squadId === squadId);
  // Server mode counts everyone (parents can't see other families); demo mode counts locally
  const regularCount = (squadId, seriesId) => (remote
    ? regularCounts[seriesId] || 0
    : squadAthletes(squadId).filter((a) => (a.regularSessions || []).includes(seriesId)).length);

  const sessionsAcrossSquads = (iso) => squads
    .flatMap((sq) => sessionsOn(sq, iso).map((s) => ({ ...s, squad: sq })))
    .sort((a, b) => a.start.localeCompare(b.start));
  const todaysSessions = sessionsAcrossSquads(todayISO);

  // ---------- Actions ----------
  // Each new message gets its full time on screen (an older message's timer doesn't clear it)
  const showFlash = (msg) => {
    clearTimeout(flashTimer.current);
    setFlash(msg);
    flashTimer.current = setTimeout(() => setFlash(''), 3500);
  };
  const updateAthlete = (id, patch) => setAthletes((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const replaceAthlete = (a) => setAthletes((prev) => prev.map((x) => (x.id === a.id ? a : x)));
  // A family changed: update it, and the payment details shown on each of its children
  const applyFamily = (f) => {
    if (!f) return;
    setFamilies((prev) => (prev.some((x) => x.id === f.id) ? prev.map((x) => (x.id === f.id ? f : x)) : [...prev, f]));
    setAthletes((prev) => prev.map((a) => (f.athleteIds.includes(a.id) ? {
      ...a, familyId: f.id, frequency: f.frequency, status: f.status, payRef: f.reference, hasSubscription: f.hasSubscription,
      autoDebit: f.hasSubscription, cardLast4: f.cardLast4, nextBillingDate: f.nextBillingDate, lastPaidOn: f.lastPaidOn,
    } : a)));
  };

  // Server mode: load everything this person is allowed to see
  const loadFromServer = async () => {
    if (!remote) return;
    setBusy('sync');
    try {
      const d = await api('/api/bootstrap');
      setSquads(d.squads);
      setAthletes(d.athletes);
      setFamilies(d.families || []);
      setPasses(d.passes || []);
      setTransactions(d.transactions);
      setRsvpOverrides(d.rsvps);
      setAttendance(d.attendance);
      setRegularCounts(d.regularCounts);
      setPaymentsConnected(Boolean(d.payments?.connected));
      if (d.settings.financialYearStart) setFinancialYearStart(d.settings.financialYearStart);
      if (d.settings.smsTemplate !== undefined) setSmsTemplate(d.settings.smsTemplate);
      if (d.settings.emailTemplate !== undefined) setEmailTemplate(d.settings.emailTemplate);
      if (d.me) updateUser?.(d.me);
      setServerError('');
      setLoaded(true);
    } catch (e) {
      if (!e.signedOut) setServerError(e.message);
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    if (checkout) {
      if (!remote) setCurrentRole('parent');
      setActiveTab('payments');
      showFlash(checkout === 'success' ? 'Payment complete — thank you!' : 'Checkout cancelled, nothing was charged');
      window.history.replaceState({}, '', window.location.pathname);
      if (checkout === 'success') setTimeout(loadFromServer, 3000); // give Stripe's webhook a moment
    }
    loadFromServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The club's colour runs through every screen
  useEffect(() => { applyBrandColour(W.colour); }, [W.colour]);

  // Coming back from Stripe: subscribing to the app, or connecting the club's payments
  useEffect(() => {
    if (!remote) return;
    const params = new URLSearchParams(window.location.search);
    const subscribed = params.get('subscribed');
    const connect = params.get('connect');
    if (!subscribed && !connect) return;
    window.history.replaceState({}, '', window.location.pathname);
    setActiveTab('settings');
    if (subscribed === '1') {
      showFlash('Thanks for subscribing! Unlocking your club…');
      setTimeout(loadFromServer, 2500);
      setTimeout(loadFromServer, 8000); // Stripe usually confirms within a few seconds
    } else if (subscribed === '0') {
      showFlash('Subscription cancelled. Nothing was charged.');
    }
    if (connect) {
      api('/api/club/connect/refresh', { method: 'POST' })
        .then((res) => { updateUser?.({ ...me, club: res.club }); showFlash(res.club.payments.connected ? 'Online payments are on' : 'Stripe still needs a few details. Tap "Finish setting up payments".'); })
        .catch((e) => showFlash(e.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Runs a server call; shows its error message instead of crashing. Returns null on failure.
  const attempt = async (fn) => {
    try { return await fn(); } catch (e) { if (!e.signedOut) showFlash(e.message); return null; }
  };

  const redirectTo = async (key, path, body) => {
    setBusy(key);
    try {
      const { url } = await api(path, { method: 'POST', body });
      if (!/^https:\/\//.test(String(url))) throw new Error("Couldn't open the secure payment page. Please try again.");
      window.location.href = url;
    } catch (e) {
      showFlash(e.message);
      setBusy('');
    }
  };

  const switchRole = (role) => {
    if (remote) return; // demo only
    setCurrentRole(role); setActiveTab('home');
    setEditingAthleteId(null); setSquadForm(null); setSessionForm(null); setReminderFor(null);
  };

  // Reminder text for a family: every child's name and the family total
  const fillFamilyTemplate = (template, f) => {
    const kids = membersOf(f);
    const names = kids.map((k) => k.name.split(' ')[0]);
    return template
      .replaceAll('{ParentName}', ((kids.find((k) => k.parent) || {}).parent || '').split(' ')[0])
      .replaceAll('{AthleteName}', names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '')
      .replaceAll('{Amount}', Number(f.total || 0).toFixed(2))
      .replaceAll('{PaymentLink}', `${window.location.origin}/  (reference ${f.reference})`);
  };

  const fillTemplate = (template, a) => template
    .replaceAll('{ParentName}', (a.parent || '').split(' ')[0])
    .replaceAll('{AthleteName}', a.name)
    .replaceAll('{Amount}', priceFor(a).toFixed(2))
    .replaceAll('{PaymentLink}', `https://pay.example.com/club/${a.id}`);

  // ----- Bookings & attendance -----

  const toggleRegular = async (a, seriesId) => {
    const current = a.regularSessions || [];
    const adding = !current.includes(seriesId);
    const squad = squadById(a.squadId);
    if (adding && squad.capacity && regularCount(squad.id, seriesId) >= squad.capacity) {
      showFlash('That session is full — ask the coach about a spot');
      return;
    }
    const nextIds = adding ? [...current, seriesId] : current.filter((x) => x !== seriesId);
    if (remote) {
      const res = await attempt(() => api(`/api/athletes/${a.id}/regular`, { method: 'PUT', body: { seriesIds: nextIds } }));
      if (!res) return;
      replaceAthlete(res.athlete);
      setRegularCounts(res.regularCounts);
    } else {
      updateAthlete(a.id, { regularSessions: nextIds });
    }
    // Regular choice resets any one-off changes for that session
    setRsvpOverrides((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${a.id}|${seriesId}|`))));
    showFlash(adding ? 'Added to regular days' : 'Removed from regular days');
  };

  const toggleDateRsvp = async (a, s) => {
    const key = rsvpKey(a.id, s.seriesId, s.date);
    const next = !isAttending(a, s);
    const regular = (a.regularSessions || []).includes(s.seriesId);
    const backToNormal = next === regular; // no one-off change needed
    if (remote) {
      const ok = await attempt(() => api('/api/rsvps', { method: 'PUT', body: { athleteId: a.id, seriesId: s.seriesId, date: s.date, attending: backToNormal ? null : next } }));
      if (!ok) return;
    }
    setRsvpOverrides((prev) => {
      const copy = { ...prev };
      if (backToNormal) delete copy[key]; else copy[key] = next;
      return copy;
    });
  };

  // Demo mode: a present mark uses a pass session, unticking gives it back
  const demoUsePass = (athleteId, present) => setPasses((prev) => {
    // The child's own passes first, then the family's
    const mine = prev.filter((p) => p.status === 'active' && passBelongs(p, athleteId)).sort((x, y) => (x.athleteId == null) - (y.athleteId == null));
    const p = present ? mine.find((x) => x.left > 0) : [...mine].reverse().find((x) => x.used > 0);
    if (!p) return prev;
    const used = p.used + (present ? 1 : -1);
    return prev.map((x) => (x.id === p.id ? { ...x, used, left: x.sessions - used } : x));
  });

  const toggleAttendance = async (athleteId, s) => {
    const key = rsvpKey(athleteId, s.seriesId, s.date);
    const present = !attendance[key];
    setAttendance((prev) => ({ ...prev, [key]: present })); // instant on the pool deck; undone if the server refuses
    if (remote) {
      const res = await attempt(() => api('/api/attendance', { method: 'PUT', body: { athleteId, seriesId: s.seriesId, date: s.date, present } }));
      if (!res) setAttendance((prev) => ({ ...prev, [key]: !present }));
      else if (res.passes) mergePasses(res.passes);
    } else {
      demoUsePass(athleteId, present);
    }
  };

  const markAllPresent = async (list, s) => {
    if (remote) {
      const res = await attempt(() => api('/api/attendance/bulk', { method: 'POST', body: { seriesId: s.seriesId, date: s.date, athleteIds: list.map((a) => a.id) } }));
      if (!res) return;
      if (res.passes) mergePasses(res.passes);
    } else {
      for (const a of list) if (!attendance[rsvpKey(a.id, s.seriesId, s.date)]) demoUsePass(a.id, true);
    }
    setAttendance((prev) => ({ ...prev, ...Object.fromEntries(list.map((a) => [rsvpKey(a.id, s.seriesId, s.date), true])) }));
    showFlash(`${list.length} marked present`);
  };

  // Next date (from `fromIso`) this squad actually trains
  const nextTrainingDate = (squad, fromIso) => {
    for (let i = 0; i < 90; i++) {
      const d = addDays(fromIso, i);
      if (sessionsOn(squad, d).some((x) => !x.cancelled)) return d;
    }
    return null;
  };

  // Jump to an athlete's full record on the Athletes tab
  const openAthlete = (a) => {
    setAthleteSearch(a.name);
    setExpandedAthleteId(a.id);
    setEditingAthleteId(null);
    setActiveTab('athletes');
  };

  const openAttendance = (squadId, sessionId, date) => {
    setAttendanceDate(date);
    setAttendanceSquadId(squadId);
    setAttendanceSessionId(sessionId);
    setActiveTab('attendance');
  };

  // ----- Plan & payments -----

  // Change squad and/or frequency. In server mode the server also moves the Stripe subscription.
  const changePlan = async (a, squadId, frequency) => {
    if (remote) {
      const res = await api(`/api/athletes/${a.id}/plan`, { method: 'POST', body: { squadId, frequency } });
      replaceAthlete(res.athlete);
      applyFamily(res.family);
      return res.athlete;
    }
    const patch = { squadId, frequency, ...(squadId !== a.squadId ? { regularSessions: [] } : {}) };
    updateAthlete(a.id, patch);
    return { ...a, ...patch };
  };

  // Parent: how often the whole family pays
  const changeFamilyFrequency = async (f, frequency) => {
    if (frequency === f.frequency) return;
    if (!remote) { f.athleteIds.forEach((id) => updateAthlete(id, { frequency })); return; }
    setBusy('freq');
    try {
      const res = await api(`/api/families/${f.id}/frequency`, { method: 'PUT', body: { frequency } });
      applyFamily(res.family);
      showFlash(`Your family now pays ${FREQ_TITLE[frequency].toLowerCase()}: ${money(res.family.total)}/${FREQ_LABEL[frequency]}`);
    } catch (e) {
      if (!e.signedOut) showFlash(e.message);
    } finally {
      setBusy('');
    }
  };

  // One card payment for the whole family
  const startAutoPay = (f) => {
    if (!remote) {
      f.athleteIds.forEach((id) => updateAthlete(id, { autoDebit: true, hasSubscription: true, cardLast4: '4242' }));
      showFlash('Automatic payments set up (demo)');
      return;
    }
    redirectTo('autopay', '/api/checkout/subscription', { familyId: f.id });
  };

  const openBillingPortal = (f) => {
    if (!remote) { showFlash('Opens the secure Stripe billing page once payments are connected'); return; }
    redirectTo('portal', '/api/portal', { familyId: f.id });
  };

  // Parents buy a pass the club has offered them
  const buyPass = (p) => {
    if (!remote) {
      setPasses((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: 'active', paidBy: 'card' } : x)));
      setTransactions((prev) => [...prev, { id: Date.now(), date: todayISO, type: 'Income', category: 'Session Pass', description: `${passOwnerLabel(p)} - ${p.sessions}-Session Pass (Card)`, amount: p.price, gst: true }]);
      showFlash(`${plural(p.sessions, 'session')} pass bought (${money(p.price)}) — demo only`);
      return;
    }
    redirectTo(`pass-${p.id}`, '/api/checkout/pass', { passId: p.id });
  };
  const passOwnerLabel = (p) => (p.athleteId != null
    ? athletes.find((a) => a.id === p.athleteId)?.name || ''
    : families.find((f) => f.id === p.familyId)?.name || 'Family');

  const saveProfile = async (a) => {
    const draft = profileDrafts[a.id] || profileFromAthlete(a);
    if (draft.email && !/^\S+@\S+\.\S+$/.test(draft.email)) { showFlash('Check the email address'); return; }
    if (remote) {
      const res = await attempt(() => api(`/api/athletes/${a.id}/profile`, { method: 'PUT', body: draft }));
      if (!res) return;
      replaceAthlete(res.athlete);
    } else {
      updateAthlete(a.id, draft);
    }
    setProfileDrafts((prev) => { const copy = { ...prev }; delete copy[a.id]; return copy; });
    showFlash(`${a.name.split(' ')[0]}'s details saved`);
  };

  // ----- Athlete admin -----

  const startEditAthlete = (a) => {
    setEditingAthleteId(a.id);
    setAthleteDraft({
      squadId: a.squadId, frequency: a.frequency, status: a.status,
      payMethod: (families.find((f) => f.athleteIds.includes(a.id)) || {}).payMethod || '',
      parent: a.parent || '', phone: a.phone || '', email: a.email || '', address: a.address || '',
      ...(isCoach ? { emergency: a.emergency || '', allergies: a.allergies || '', medication: a.medication || '' } : {}),
    });
  };
  const saveAthlete = async () => {
    const a = athletes.find((x) => x.id === editingAthleteId);
    const { squadId, frequency, ...rest } = athleteDraft;
    const moved = squadId !== a.squadId;
    setBusy('athlete');
    try {
      if (remote) {
        const res = await api(`/api/athletes/${a.id}`, { method: 'PUT', body: athleteDraft });
        replaceAthlete(res.athlete);
        applyFamily(res.family);
        if (moved) loadFromServer(); // regular-day counts change when someone moves squad
      } else {
        if (moved || frequency !== a.frequency) await changePlan(a, squadId, frequency);
        updateAthlete(a.id, rest);
      }
      setEditingAthleteId(null);
      showFlash(moved ? `${W.member} moved — their parent can now pick days for the new ${lc(W.group)}` : `${W.member} updated`);
    } catch (e) {
      if (!e.signedOut) showFlash(e.message);
    } finally {
      setBusy('');
    }
  };

  const blankAthlete = () => ({
    name: '', squadId: squads[0]?.id ?? 1, frequency: 'weekly', parent: '', phone: '', email: '', address: '',
    ...(isCoach ? { emergency: '', allergies: '', medication: '' } : {}),
  });

  const addAthlete = async () => {
    const f = newAthlete;
    if (!f.name.trim()) { showFlash(`Enter the ${lc(W.member)}'s name`); return; }
    if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) { showFlash('Check the email address'); return; }
    let created;
    let createdFamily = null;
    if (remote) {
      const res = await attempt(() => api('/api/athletes', { method: 'POST', body: f }));
      if (!res) return;
      created = res.athlete;
      createdFamily = res.family;
    } else {
      created = { ...f, name: f.name.trim(), id: Math.max(0, ...athletes.map((a) => a.id)) + 1, status: 'paid', regularSessions: [], autoDebit: false, hasSubscription: false, cardLast4: null, nextBillingDate: null, emergency: f.emergency || '', allergies: f.allergies || '', medication: f.medication || '' };
    }
    setAthletes((prev) => [...prev, created]);
    applyFamily(createdFamily);
    setShowAddAthlete(false);
    setNewAthlete(null);
    setAthleteSearch('');
    setExpandedAthleteId(created.id);
    showFlash(remote && created.email ? `${created.name} added. Invite their parent from Settings or their record.` : `${created.name} added`);
  };

  // Permanently remove a member (coach only). Two taps, then everything about them is deleted.
  const deleteAthlete = async (a) => {
    if (confirmDeleteAthlete !== a.id) { setConfirmDeleteAthlete(a.id); showFlash(`Tap again to permanently delete ${a.name} and all their details`); return; }
    setConfirmDeleteAthlete(null);
    if (remote) {
      const ok = await attempt(() => api(`/api/athletes/${a.id}`, { method: 'DELETE' }));
      if (!ok) return;
    }
    setAthletes((prev) => prev.filter((x) => x.id !== a.id));
    setExpandedAthleteId(null);
    showFlash(`${a.name} and their details have been deleted`);
  };

  // Opens the invite form in Settings, filled in from the athlete's record
  const inviteParent = (a) => {
    setInviteRequest({ email: a.email || '', name: a.parent || '', role: 'parent', athleteIds: [a.id] });
    setActiveTab('settings');
  };

  // ----- Squads & timetables -----

  const persistSquad = async (squad) => {
    const saved = remote ? await api(`/api/squads/${squad.id}`, { method: 'PUT', body: squad }) : squad;
    setSquads((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
    return saved;
  };

  const blankSquadForm = { mode: 'create', name: '', level: '', description: '', location: 'Main Pool', capacity: '', coach: '', weekly: '', fortnightly: '', monthly: '' };
  const startCreateSquad = () => { setSessionForm(null); setSquadForm(blankSquadForm); };
  const startEditSquad = (s) => {
    setSessionForm(null);
    setConfirmDeleteId(null);
    setSquadForm({
      mode: 'edit', id: s.id, name: s.name, level: s.level || '', description: s.description || '', location: s.location || '',
      capacity: s.capacity == null ? '' : String(s.capacity), coach: s.coach || '',
      weekly: String(s.weekly), fortnightly: String(s.fortnightly), monthly: String(s.monthly),
    });
  };

  const saveSquadForm = async () => {
    const f = squadForm;
    const prices = ['weekly', 'fortnightly', 'monthly'].map((k) => parseFloat(f[k]));
    if (!f.name.trim()) { showFlash(`Give the ${lc(W.group)} a name`); return; }
    if (prices.some((n) => isNaN(n) || n < 0)) { showFlash('Enter all three prices'); return; }
    const capacity = f.capacity === '' ? null : parseInt(f.capacity, 10);
    if (capacity !== null && (isNaN(capacity) || capacity < 1)) { showFlash('Capacity must be a number, or leave it blank'); return; }
    const [weekly, fortnightly, monthly] = prices;
    const details = {
      name: f.name.trim(), level: f.level.trim(), description: f.description.trim(), location: f.location.trim(),
      capacity, coach: f.coach.trim(), weekly, fortnightly, monthly,
    };
    setBusy('squad');
    try {
      if (f.mode === 'create') {
        let squad = { id: Math.max(0, ...squads.map((s) => s.id)) + 1, ...details, sessions: [] };
        if (remote) squad = await api('/api/squads', { method: 'POST', body: squad });
        setSquads((prev) => [...prev, squad]);
        setOpenTimetable(squad.id);
        setSessionForm({ squadId: squad.id, mode: 'add', day: 1, start: '17:00', end: '18:00', location: squad.location, applyMode: 'now', applyFrom: '' });
        showFlash(`${W.group} added — now add its training times`);
      } else {
        await persistSquad({ ...squadById(f.id), ...details });
        showFlash(remote && paymentsConnected ? `${W.group} updated — new prices apply to new sign-ups and plan changes` : `${W.group} updated`);
      }
      setSquadForm(null);
    } catch (e) {
      showFlash(e.message);
    } finally {
      setBusy('');
    }
  };

  const deleteSquad = async (squad) => {
    if (squadAthletes(squad.id).length) { showFlash(`Move this ${lc(W.group)}'s ${lc(W.members)} to another ${lc(W.group)} first`); return; }
    if (confirmDeleteId !== squad.id) { setConfirmDeleteId(squad.id); return; } // first tap asks to confirm
    setConfirmDeleteId(null);
    try {
      if (remote) await api(`/api/squads/${squad.id}`, { method: 'DELETE' });
      setSquads((prev) => prev.filter((s) => s.id !== squad.id));
      setSquadForm(null);
      showFlash(`${W.group} deleted`);
    } catch (e) {
      showFlash(e.message);
    }
  };

  const openSessionForm = (squad, mode, s) => {
    setSquadForm(null);
    if (mode === 'add') {
      setSessionForm({ squadId: squad.id, mode, day: 1, start: '17:00', end: '18:00', location: squad.location || '', applyMode: 'now', applyFrom: addDays(todayISO, 7) });
    } else if (mode === 'edit') {
      setSessionForm({ squadId: squad.id, mode, sessionId: s.id, day: s.day, start: s.start, end: s.end, location: s.location, applyMode: 'now', applyFrom: addDays(todayISO, 7) });
    } else if (mode === 'cancel') {
      const dates = nextOccurrences(s, todayISO, 10).filter((d) => !(s.cancellations || []).some((c) => c.date === d));
      setSessionForm({ squadId: squad.id, mode, sessionId: s.id, cancelDate: dates[0] || '', reason: '' });
    } else if (mode === 'remove') {
      setSessionForm({ squadId: squad.id, mode, sessionId: s.id, seriesId: s.seriesId, applyMode: 'now', applyFrom: addDays(todayISO, 7) });
    }
  };

  const saveSessionForm = async () => {
    const f = sessionForm;
    const squad = squadById(f.squadId);
    const scheduled = f.applyMode === 'date' && f.applyFrom > todayISO;
    if (f.applyMode === 'date' && !(f.applyFrom > todayISO)) { showFlash('Pick a date after today'); return; }
    let updated;
    let msg;

    if (f.mode === 'add' || f.mode === 'edit') {
      if (!f.start || !f.end || f.end <= f.start) { showFlash('Finish time must be after the start time'); return; }
      if (f.mode === 'edit') {
        const old = squad.sessions.find((s) => s.id === f.sessionId);
        if (scheduled && old.endsOn && f.applyFrom > old.endsOn) { showFlash(`That session finishes on ${fmtDay(old.endsOn)}, before this date`); return; }
      }
      updated = addOrEditSession(squad, f, todayISO);
      msg = scheduled ? `Change scheduled from ${fmtDay(f.applyFrom)} — parents can see it now` : 'Timetable updated';
    } else if (f.mode === 'cancel') {
      if (!f.cancelDate) { showFlash('Pick a date to cancel'); return; }
      updated = cancelOccurrence(squad, f.sessionId, f.cancelDate, f.reason.trim());
      msg = `${fmtDay(f.cancelDate)} cancelled — parents will see it in Bookings`;
    } else if (f.mode === 'remove') {
      updated = removeSeries(squad, f.seriesId, scheduled ? f.applyFrom : todayISO, todayISO);
      msg = scheduled ? `Session finishes before ${fmtDay(f.applyFrom)}` : 'Session removed';
    }

    try {
      await persistSquad(updated);
      if (f.mode === 'remove' && !scheduled) {
        setAthletes((prev) => prev.map((a) => ({ ...a, regularSessions: (a.regularSessions || []).filter((id) => id !== f.seriesId) })));
      }
      setSessionForm(null);
      showFlash(msg);
    } catch (e) {
      showFlash(e.message);
    }
  };

  const undoSquadChange = async (squad, item) => {
    try { await persistSquad(undoChange(squad, item)); showFlash('Change undone'); }
    catch (e) { showFlash(e.message); }
  };

  const saveSettings = async () => {
    const res = await attempt(() => api('/api/settings', { method: 'PUT', body: { financialYearStart, smsTemplate, emailTemplate } }));
    if (!res) return;
    setSettingsDirty(false);
    showFlash('Settings saved');
  };

  // ----- Ledger & reports -----

  const addTransaction = async () => {
    const amount = parseFloat(newTx.amount);
    if (!newTx.description.trim() || isNaN(amount) || amount <= 0) { showFlash('Enter a description and amount'); return; }
    let tx = { ...newTx, id: Date.now(), amount, category: newTx.category.trim() || 'General', description: newTx.description.trim() };
    if (remote) {
      try { tx = await api('/api/transactions', { method: 'POST', body: tx }); }
      catch (e) { showFlash(e.message); return; }
    }
    setTransactions((prev) => [...prev, tx]);
    setNewTx(blankTx);
    setShowAddTx(false);
    showFlash('Transaction added');
  };

  const reportFileBase = `report_${toISO(win.start)}_to_${toISO(win.end)}`;

  const copyText = (text, label) => {
    const done = () => { setCopyFallback(null); showFlash(`${label} copied`); };
    const fail = () => setCopyFallback({ label, text });
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fail);
      else fail();
    } catch { fail(); }
  };

  const buildCsv = () => {
    const header = ['Date', 'Type', 'Category', 'Description', 'Amount (incl GST)', 'GST component'];
    const rows = reportTx.map((t) => [t.date, t.type, t.category, t.description, t.amount.toFixed(2), (t.gst ? gstFromInclusive(t.amount) : 0).toFixed(2)]);
    rows.push(
      [],
      ['', '', '', 'Total income', report.income.toFixed(2), report.gstCollected.toFixed(2)],
      ['', '', '', 'Total expenses', report.expenses.toFixed(2), report.gstPaid.toFixed(2)],
      ['', '', '', report.netGst >= 0 ? 'Net GST to pay' : 'Net GST refund', '', Math.abs(report.netGst).toFixed(2)],
    );
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  };

  const downloadCsv = () => {
    const csv = buildCsv();
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${reportFileBase}.csv`; link.click();
    URL.revokeObjectURL(url);
  };

  // Printable report, built with DOM methods (no HTML strings) and styled through element.style,
  // which the app's security policy allows.
  const printReport = () => {
    const w = window.open('', '_blank');
    if (!w) { showFlash('Allow pop-ups to print the report'); return; }
    const d = w.document;
    d.title = reportFileBase;
    const el = (tag, textContent, style = {}) => {
      const n = d.createElement(tag);
      if (textContent !== undefined) n.textContent = textContent;
      Object.assign(n.style, style);
      return n;
    };
    Object.assign(d.body.style, { fontFamily: 'system-ui, sans-serif', padding: '24px', color: '#1e293b' });
    d.body.append(
      el('h1', `${club.name} — Financial Report`, { fontSize: '18px' }),
      el('p', `${fmtLong(win.start)} – ${fmtLong(win.end)} (amounts GST-inclusive, GST at 15%)`),
    );
    const table = el('table', undefined, { width: '100%', borderCollapse: 'collapse', fontSize: '12px' });
    const cell = (tag, value, right) => el(tag, value, { borderBottom: '1px solid #e2e8f0', padding: '6px', textAlign: right ? 'right' : 'left' });
    const head = el('tr');
    [['Date'], ['Type'], ['Category'], ['Description'], ['Amount', true], ['GST', true]].forEach(([h, r]) => head.append(cell('th', h, r)));
    table.append(head);
    if (reportTx.length === 0) {
      const row = el('tr');
      const c = cell('td', 'No transactions in this period');
      c.colSpan = 6;
      row.append(c);
      table.append(row);
    }
    reportTx.forEach((t) => {
      const row = el('tr');
      row.append(cell('td', t.date), cell('td', t.type), cell('td', t.category), cell('td', t.description),
        cell('td', money(t.amount), true), cell('td', money(t.gst ? gstFromInclusive(t.amount) : 0), true));
      table.append(row);
    });
    d.body.append(table,
      el('p', `Income ${money(report.income)} · Expenses ${money(report.expenses)} · GST collected ${money(report.gstCollected)} · GST paid ${money(report.gstPaid)}`),
      el('p', `${report.netGst >= 0 ? 'Net GST to pay' : 'Net GST refund'} ${money(Math.abs(report.netGst))}`, { fontWeight: 'bold' }));
    w.focus();
    w.print();
  };

  // ======================================================================
  // Screens (shared between roles where it makes sense)
  // ======================================================================

  const syncButton = remote && (
    <button onClick={loadFromServer} disabled={busy === 'sync'} className="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded-lg font-medium flex items-center gap-1 disabled:opacity-50">
      <RefreshCw size={12} className={busy === 'sync' ? 'animate-spin' : ''} /> Refresh
    </button>
  );

  // ----- Parent (every child on one page) -----

  const upcomingFor = (a) => {
    const sq = squadById(a.squadId);
    const out = [];
    if (!sq) return out;
    for (let i = 0; i < BOOKING_DAYS; i++) out.push(...sessionsOn(sq, addDays(todayISO, i)));
    return out;
  };
  const howPaid = (f) => (f.payMethod === 'card'
    ? (f.hasSubscription ? `Card auto-pay${f.cardLast4 ? ` (•••• ${f.cardLast4})` : ''}` : 'Card')
    : `Bank transfer · reference ${f.reference}`);

  const renderParentHome = () => {
    const firstName = ((remote ? me?.name : parentAthlete.parent) || 'there').split(' ')[0];
    return (
      <div className="space-y-4">
        <div className={card}>
          <h2 className="text-xl font-bold text-slate-900">Welcome, {firstName}</h2>
          {parentFamilies.map((f) => (
            <div key={f.id} className="mt-3 pt-3 border-t border-slate-100 flex justify-between items-center gap-3">
              <div className="min-w-0">
                <p className="text-xs text-slate-400">{f.name} · {FREQ_TITLE[f.frequency]}</p>
                <p className="font-semibold text-sm">{money(f.total)}{f.nextBillingDate ? ` due ${fmtShort(f.nextBillingDate)}` : `/${FREQ_LABEL[f.frequency]}`}</p>
                <p className="text-xs text-slate-500 truncate">{howPaid(f)}</p>
                {passes.some((p) => p.status === 'offered' && (p.familyId === f.id || f.athleteIds.includes(p.athleteId))) && (
                  <button onClick={() => setActiveTab('payments')} className="text-xs text-indigo-700 font-semibold">The club has offered you a session pass →</button>
                )}
              </div>
              <span className={`text-xs px-2.5 py-1 rounded-full font-semibold shrink-0 ${f.status === 'paid' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                {f.status === 'paid' ? 'Paid up' : 'Payment overdue'}
              </span>
            </div>
          ))}
        </div>

        <div className={`grid gap-3 ${parentAthletes.length > 1 ? 'md:grid-cols-2' : ''}`}>
          {parentAthletes.map((a) => {
            const sq = squadById(a.squadId);
            const next = upcomingFor(a).find((s) => isAttending(a, s));
            return (
              <div key={a.id} className={card}>
                <p className="font-semibold text-sm">{a.name}</p>
                <p className="text-xs text-slate-500">{sq ? sq.name : `Not in a ${lc(W.group)} yet`}</p>
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <p className="text-xs text-slate-400">Next Training</p>
                  <p className="font-semibold text-sm">{next ? `${fmtDay(next.date)} · ${fmtTime(next.start)}–${fmtTime(next.end)}` : 'No sessions booked — choose days in Bookings'}</p>
                  {next && <p className="text-xs text-slate-400">{next.location}</p>}
                </div>
              </div>
            );
          })}
        </div>

        <div className={card}>
          <h3 className="font-semibold text-sm mb-3">Quick Actions</h3>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setActiveTab('bookings')} className="p-3 bg-indigo-50 text-indigo-700 rounded-xl text-xs font-medium text-center flex flex-col items-center gap-1">
              <Calendar size={18} /> Choose Training Days
            </button>
            <button onClick={() => setActiveTab('payments')} className="p-3 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-medium text-center flex flex-col items-center gap-1">
              <CreditCard size={18} /> Pay Fees / Passes
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderChildBookings = (a) => {
    const sq = squadById(a.squadId);
    const firstName = a.name.split(' ')[0];
    if (!sq) return <div key={a.id} className={`${card} text-sm text-slate-500`}>{a.name} isn't in a {lc(W.group)} yet. Ask the coach.</div>;
    const series = seriesAsOf(sq, todayISO);
    const upcoming = upcomingFor(a);
    return (
      <section key={a.id} className="space-y-3">
        <div>
          <h3 className="font-bold text-sm text-slate-800">{a.name}</h3>
          <p className="text-xs text-slate-500">{sq.name}{sq.level ? ` · ${sq.level}` : ''}</p>
        </div>

        <div className={`${card} space-y-2`}>
          <h3 className="font-semibold text-sm">{firstName}'s regular days</h3>
          <p className="text-xs text-slate-500">Tick the sessions {firstName} usually comes to. You can still change single dates below.</p>
          {series.length === 0 && <p className="text-xs text-slate-400">The coach hasn't added training times for this {lc(W.group)} yet.</p>}
          {series.map((s) => {
            const selected = (a.regularSessions || []).includes(s.seriesId);
            const count = regularCount(sq.id, s.seriesId);
            const full = sq.capacity && count >= sq.capacity && !selected;
            const note = seriesNote(sq, s, todayISO);
            return (
              <button
                key={s.seriesId}
                onClick={() => toggleRegular(a, s.seriesId)}
                disabled={full}
                aria-label={`${firstName}: ${DAY_NAMES[s.day]} ${fmtTime(s.start)}`}
                className={`w-full text-left p-3 rounded-lg border flex items-start gap-3 disabled:opacity-50 ${selected ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200'}`}
              >
                <span className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${selected ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300'}`}>
                  {selected && <Check size={10} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-800">{DAY_NAMES[s.day]} · {fmtTime(s.start)}–{fmtTime(s.end)}</span>
                  <span className="block text-xs text-slate-400 flex items-center gap-1"><MapPin size={10} /> {s.location}</span>
                  {note && <span className="block text-xs text-amber-700 mt-0.5">{note}</span>}
                </span>
                {sq.capacity ? (
                  <span className={`text-[11px] shrink-0 ${full ? 'text-rose-600 font-semibold' : 'text-slate-400'}`}>{full ? 'Full' : `${count}/${sq.capacity}`}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className={`${card} space-y-2`}>
          <h3 className="font-semibold text-sm">{firstName} · next {BOOKING_DAYS / 7} weeks</h3>
          <p className="text-xs text-slate-500">Tap a session to change just that date, e.g. if {firstName} is sick or wants an extra session.</p>
          {upcoming.length === 0 && <p className="text-xs text-slate-400">No sessions scheduled in the next {BOOKING_DAYS} days.</p>}
          {upcoming.map((s) => {
            const attending = isAttending(a, s);
            const regular = (a.regularSessions || []).includes(s.seriesId);
            const changed = attending !== regular && !s.cancelled;
            return (
              <div key={`${s.id}-${s.date}`} className="flex justify-between items-center py-1.5 border-b border-slate-50 gap-2">
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${s.cancelled ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{fmtDay(s.date)}</p>
                  <p className="text-xs text-slate-400">{fmtTime(s.start)}–{fmtTime(s.end)} · {s.location}</p>
                  {s.cancelled && <p className="text-xs text-rose-600">Cancelled by coach{s.cancelReason ? ` — ${s.cancelReason}` : ''}</p>}
                  {changed && <p className="text-[11px] text-indigo-600">Changed for this date only</p>}
                </div>
                {s.cancelled ? (
                  <span className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-rose-50 text-rose-600 shrink-0">Cancelled</span>
                ) : (
                  <button
                    onClick={() => toggleDateRsvp(a, s)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg shrink-0 ${attending ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}
                  >
                    {attending ? 'Attending' : 'Not attending'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const renderBookings = () => (
    <div className="space-y-6">
      <h2 className="font-bold text-base">Training Days</h2>
      {parentAthletes.map(renderChildBookings)}
    </div>
  );

  // How this club takes payments (card, bank or both; the demo shows card). The club decides each
  // family's way of paying; parents only see the one for their family.
  const cardOn = !remote || club.payments?.card !== false;
  const bankDetails = remote ? club.payments?.bank || null : null;
  const bothOffered = cardOn && Boolean(bankDetails);

  const renderFamilyPayment = (f) => {
    const kids = membersOf(f);
    const showBank = Boolean(bankDetails) && f.payMethod === 'bank';
    const showCard = cardOn && f.payMethod === 'card';
    const totalAt = (freq) => kids.reduce((sum, k) => sum + Number(squadById(k.squadId)?.[freq] || 0), 0);
    return (
      <div key={f.id} className="space-y-4">
        <div className="bg-gradient-to-r from-indigo-500 to-violet-600 text-white p-4 rounded-xl shadow-md">
          <p className="text-xs text-indigo-100">{f.name} · {kids.length} {kids.length === 1 ? lc(W.member) : lc(W.members)}</p>
          <p className="text-lg font-bold">{money(f.total)} {FREQ_TITLE[f.frequency].toLowerCase()}</p>
          <p className="text-xs mt-2 text-indigo-100">{howPaid(f)}{f.nextBillingDate ? ` · next payment ${fmtShort(f.nextBillingDate)}` : ''}</p>
        </div>

        <div className={`${card} space-y-1`}>
          <h3 className="font-semibold text-sm mb-1">What you pay for</h3>
          {kids.map((k) => {
            const sq = squadById(k.squadId);
            return (
              <div key={k.id} className="flex justify-between items-center py-1.5 border-b border-slate-50 text-sm gap-2">
                <span className="min-w-0">
                  <span className="block font-medium">{k.name}</span>
                  <span className="block text-xs text-slate-400">{sq ? sq.name : `Not in a ${lc(W.group)} yet`}</span>
                </span>
                <span className="font-medium shrink-0">{money(sq?.[f.frequency] || 0)}</span>
              </div>
            );
          })}
          <div className="flex justify-between text-sm font-bold pt-1.5">
            <span>Family total</span><span>{money(f.total)}/{FREQ_LABEL[f.frequency]}</span>
          </div>
        </div>

        <div className={`${card} space-y-2`}>
          <h3 className="font-semibold text-sm">How often does your family pay?</h3>
          {Object.keys(FREQ_TITLE).map((freq) => {
            const selected = f.frequency === freq;
            return (
              <button
                key={freq}
                onClick={() => changeFamilyFrequency(f, freq)}
                disabled={busy === 'freq'}
                className={`w-full flex justify-between items-center p-3 rounded-lg border text-sm disabled:opacity-60 ${selected ? 'border-indigo-500 bg-indigo-50 text-indigo-700 font-semibold' : 'border-slate-200 text-slate-700'}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${selected ? 'border-indigo-600' : 'border-slate-300'}`}>
                    {selected && <span className="w-2 h-2 rounded-full bg-indigo-600" />}
                  </span>
                  {FREQ_TITLE[freq]}
                </span>
                <span>{money(totalAt(freq))}/{FREQ_LABEL[freq]}</span>
              </button>
            );
          })}
          <p className="text-[11px] text-slate-400">
            {f.hasSubscription
              ? 'Your card payments switch to the new schedule from today. Any unused time is credited to your next payment.'
              : showBank ? 'If you change this, update your automatic payment in your banking app to the new amount.' : 'This covers all your children.'}
          </p>
        </div>

        {showBank && (
          <div className={`${card} space-y-2 text-sm`}>
            <h3 className="font-semibold text-sm">Pay by bank transfer</h3>
            <div className="bg-slate-50 rounded-lg p-3 space-y-1 text-xs">
              <p className="flex justify-between gap-2"><span className="text-slate-500">Account name</span><span className="font-medium text-right select-all">{bankDetails.accountName}</span></p>
              <p className="flex justify-between gap-2"><span className="text-slate-500">Account number</span><span className="font-mono font-medium select-all">{bankDetails.accountNumber}</span></p>
              <p className="flex justify-between gap-2"><span className="text-slate-500">Reference</span><span className="font-mono font-medium select-all">{f.reference}</span></p>
              <p className="flex justify-between gap-2"><span className="text-slate-500">Amount</span><span className="font-medium">{money(f.total)} {FREQ_TITLE[f.frequency].toLowerCase()}</span></p>
            </div>
            <button onClick={() => copyText(`${bankDetails.accountNumber}`, 'Account number')} className="w-full text-xs bg-slate-100 text-slate-700 py-2 rounded-lg font-semibold flex items-center justify-center gap-1"><Copy size={12} /> Copy account number</button>
            <div className="text-xs text-slate-600 space-y-1">
              <p className="font-semibold text-slate-700">Set it and forget it: one free automatic payment for the family</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>In your banking app, choose <span className="font-medium">Pay someone</span> or <span className="font-medium">Automatic payment</span>.</li>
                <li>Enter the account name and number above.</li>
                <li>Put <span className="font-mono font-medium">{f.reference}</span> in the reference, so the club knows it's from your family.</li>
                <li>Set it to repeat <span className="font-medium">{FREQ_TITLE[f.frequency].toLowerCase()}</span> for {money(f.total)}.</li>
              </ol>
              {bankDetails.instructions && <p className="text-slate-500">{bankDetails.instructions}</p>}
              <p className="text-[11px] text-slate-400">The club ticks off payments as they arrive.</p>
            </div>
          </div>
        )}

        {showCard && (f.hasSubscription ? (
          <button onClick={() => openBillingPortal(f)} disabled={busy === 'portal'} className={`w-full ${primaryBtn} bg-slate-800`}>
            <CreditCard size={14} /> {busy === 'portal' ? 'Opening…' : 'Update card / manage billing'}
          </button>
        ) : (
          <button onClick={() => startAutoPay(f)} disabled={busy === 'autopay'} className={`w-full ${primaryBtn}`}>
            <CreditCard size={14} /> {busy === 'autopay' ? 'Opening secure checkout…' : `Set up automatic ${FREQ_TITLE[f.frequency].toLowerCase()} card payments (${money(f.total)})`}
          </button>
        ))}
        {f.cardStopping && <p className="text-[11px] text-amber-700 text-center">Your card payments stop at the end of the period already paid{f.nextBillingDate ? ` (${fmtShort(f.nextBillingDate)})` : ''}. After that, please pay by bank transfer.</p>}

        {renderParentPasses(f, kids, showCard, showBank)}

        <p className="text-[11px] text-slate-400 text-center flex items-center justify-center gap-1">
          <Shield size={11} />
          {!remote ? 'Demo mode — no real payments are taken.'
            : f.payMethod === 'card' ? 'Your club has set your family to pay by card. Card details are handled securely by Stripe and never touch this app.'
            : 'Your club has set your family to pay by bank transfer.'}
        </p>
      </div>
    );
  };

  // Passes the club has offered (to buy) and passes in use, for each child and the whole family
  const renderParentPasses = (f, kids, showCard, showBank) => {
    const familyPasses = passes.filter((p) => p.familyId === f.id && p.status !== 'cancelled');
    const childPasses = kids.map((k) => ({ k, list: passes.filter((p) => p.athleteId === k.id && p.status !== 'cancelled') }));
    if (!familyPasses.length && !childPasses.some((c) => c.list.length)) return null;
    const row = (p, who) => (p.status === 'offered' ? (
      <div key={p.id} className="p-3 rounded-lg bg-indigo-50 space-y-2">
        <p className="text-xs text-indigo-900"><span className="font-semibold">The club is offering {who} a pass:</span> {plural(p.sessions, 'session')} for {money(p.price)}.</p>
        {showCard ? (
          <button onClick={() => buyPass(p)} disabled={busy === `pass-${p.id}`} className="w-full py-2.5 bg-indigo-600 text-white rounded-lg font-semibold text-xs disabled:opacity-50">
            {busy === `pass-${p.id}` ? 'Opening secure checkout…' : `Buy it by card (${money(p.price)})`}
          </button>
        ) : showBank ? (
          <p className="text-[11px] text-indigo-800">To buy it, pay {money(p.price)} to the club's account above with reference <span className="font-mono font-medium">{f.reference}</span>. The pass starts once the club sees your payment.</p>
        ) : (
          <p className="text-[11px] text-indigo-800">Talk to the club about paying for it.</p>
        )}
      </div>
    ) : (
      <p key={p.id} className="text-xs flex justify-between gap-2 py-1">
        <span className="text-slate-600">{who}: {p.sessions}-session pass{p.paidBy === 'unpaid' ? ' (not paid yet)' : ''}</span>
        <span className={`font-semibold shrink-0 ${p.left > 0 ? 'text-indigo-700' : 'text-rose-700'}`}>{p.left > 0 ? `${plural(p.left, 'session')} left` : 'Used up'}</span>
      </p>
    ));
    return (
      <div className={`${card} space-y-2`}>
        <h3 className="font-semibold text-sm">Session passes</h3>
        {familyPasses.map((p) => row(p, 'your family (shared by all your children)'))}
        {childPasses.map(({ k, list }) => list.map((p) => row(p, k.name.split(' ')[0])))}
        <p className="text-[11px] text-slate-400">Each session your child is marked present uses one.</p>
      </div>
    );
  };

  const renderPayments = () => (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-bold text-base">Family Payments</h2>
        {syncButton}
      </div>
      {parentFamilies.map(renderFamilyPayment)}
    </div>
  );

  const renderProfile = () => (
    <div className="space-y-6">
      <h2 className="font-bold text-base">Profiles & Medical Vault</h2>
      {parentAthletes.map((a) => {
        const draft = profileDrafts[a.id] || profileFromAthlete(a);
        const set = (k) => (e) => setProfileDrafts((prev) => ({ ...prev, [a.id]: { ...draft, [k]: e.target.value } }));
        const first = a.name.split(' ')[0];
        return (
          <section key={a.id} className="space-y-3">
            <h3 className="font-bold text-sm text-slate-800">{a.name}</h3>
            <div className={`${card} space-y-3 text-sm`}>
              <h4 className="font-semibold text-sm">Contact Details</h4>
              <Field label="Phone Number"><input type="tel" aria-label={`${first}: phone`} className={inputCls} value={draft.phone} onChange={set('phone')} /></Field>
              <Field label="Email Address"><input type="email" aria-label={`${first}: email`} className={inputCls} value={draft.email} onChange={set('email')} /></Field>
              <Field label="Home Address"><textarea rows="2" aria-label={`${first}: address`} className={inputCls} value={draft.address} onChange={set('address')} /></Field>
              <Field label="Emergency Contact (name & phone)"><input aria-label={`${first}: emergency contact`} className={inputCls} value={draft.emergency} onChange={set('emergency')} /></Field>
            </div>
            <div className={`${card} space-y-3 text-sm`}>
              <h4 className="font-semibold text-sm">Medical</h4>
              <Field label="Food & Medical Allergies">
                <textarea rows="2" aria-label={`${first}: allergies`} className={inputCls} placeholder="e.g. Peanuts, bee stings — or None" value={draft.allergies} onChange={set('allergies')} />
              </Field>
              <Field label="Medication">
                <textarea rows="2" aria-label={`${first}: medication`} className={inputCls} placeholder="Name, dose and where it's kept — or None" value={draft.medication} onChange={set('medication')} />
              </Field>
              <p className="text-[11px] text-slate-400">Medical details are shared with coaches only.</p>
            </div>
            <button onClick={() => saveProfile(a)} disabled={!profileDrafts[a.id]} className={`w-full ${primaryBtn}`}>Save {first}'s details</button>
          </section>
        );
      })}
    </div>
  );

  // ----- Finance (treasurer + coach) -----
  const renderFinanceStats = () => (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className={card}>
          <p className="text-xs text-slate-400">YTD Income</p>
          <p className="text-xl font-bold text-emerald-600">{money(ytd.income)}</p>
        </div>
        <div className={card}>
          <p className="text-xs text-slate-400">YTD Expenses</p>
          <p className="text-xl font-bold text-slate-700">{money(ytd.expenses)}</p>
        </div>
        <div className={card}>
          <p className="text-xs text-slate-400">Net YTD</p>
          <p className={`text-xl font-bold ${ytd.income - ytd.expenses >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{money(ytd.income - ytd.expenses)}</p>
        </div>
        <div className={card}>
          <p className="text-xs text-slate-400">Overdue Accounts</p>
          <p className="text-xl font-bold text-rose-600">{overdueAthletes.length} {overdueAthletes.length === 1 ? W.member : W.members}</p>
        </div>
      </div>
      <p className="text-[11px] text-slate-400 px-1">Financial year from {fmtLong(fyStart)}</p>
    </>
  );

  // Demo mode keeps one family per child, so changes go straight onto that child
  const demoFamilyPatch = (f, patch) => { for (const id of f.athleteIds) updateAthlete(id, patch); };

  // A payment that arrived outside the app (usually a bank transfer), for the whole family
  const recordPayment = async (f) => {
    const amount = Number(recording?.amount);
    if (!Number.isFinite(amount) || amount <= 0) { showFlash('Enter the amount received'); return; }
    if (!remote) {
      demoFamilyPatch(f, { status: 'paid', lastPaidOn: todayISO });
      setTransactions((prev) => [...prev, { id: Date.now(), date: todayISO, type: 'Income', category: 'Subscription', description: `${f.name} - Bank transfer`, amount, gst: true }]);
      setRecording(null);
      showFlash(`${f.name} marked paid (${money(amount)})`);
      return;
    }
    setBusy('record');
    try {
      const res = await api(`/api/families/${f.id}/payment`, { method: 'POST', body: { amount } });
      applyFamily(res.family);
      setTransactions((prev) => [...prev, res.transaction]);
      setRecording(null);
      showFlash(`${f.name} marked paid (${money(amount)})`);
    } catch (e) {
      if (!e.signedOut) showFlash(e.message);
    } finally {
      setBusy('');
    }
  };

  // The club decides how each family pays (only when it offers both card and bank)
  const changeFamilyMethod = async (f, method) => {
    if (!remote || method === f.payMethod) return;
    setBusy(`method-${f.id}`);
    try {
      const res = await api(`/api/families/${f.id}/pay-method`, { method: 'PUT', body: { method } });
      applyFamily(res.family);
      showFlash(res.cardStopsOn
        ? `${f.name} now pays by bank. Their card payments stop after ${fmtShort(res.cardStopsOn)}.`
        : `${f.name} now pays by ${method === 'bank' ? 'bank transfer' : 'card'}`);
    } catch (e) {
      if (!e.signedOut) showFlash(e.message);
    } finally {
      setBusy('');
    }
  };

  const changeFamilyStatus = async (f, status) => {
    if (!remote) { demoFamilyPatch(f, { status }); return; }
    setBusy(`status-${f.id}`);
    try {
      const res = await api(`/api/families/${f.id}/status`, { method: 'PUT', body: { status } });
      applyFamily(res.family);
    } catch (e) {
      if (!e.signedOut) showFlash(e.message);
    } finally {
      setBusy('');
    }
  };

  const familyHow = (f) => {
    if (f.payMethod === 'bank') return `bank · ref ${f.reference}`;
    if (f.hasSubscription) return `card auto-pay${f.cardStopping ? ' (stopping)' : ''}`;
    return 'card · not set up yet';
  };

  const renderReconciliation = () => (
    <div className={card}>
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold text-sm">Payment Reconciliation</h3>
        {syncButton}
      </div>
      <p className="text-[11px] text-slate-400 mb-2">One line per family: brothers and sisters share one payment.</p>
      {[...families].sort((x, y) => x.name.localeCompare(y.name)).map((f) => {
        const kids = membersOf(f);
        const first = kids[0];
        return (
          <div key={f.id} className="py-2 border-b border-slate-50 text-sm">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <p className="font-medium">{f.name} <span className="text-xs text-slate-400 font-normal">· {money(f.total)}/{FREQ_LABEL[f.frequency]}</span></p>
                <p className="text-xs text-slate-500">{kids.map((k) => `${k.name.split(' ')[0]} (${squadById(k.squadId)?.name || 'no ' + lc(W.group)})`).join(', ')}</p>
                <p className="text-xs text-slate-400">{familyHow(f)}{f.lastPaidOn ? ` · last paid ${fmtShort(f.lastPaidOn)}` : ''}</p>
              </div>
              <span className={`px-2 py-1 rounded text-xs font-semibold shrink-0 ${f.status === 'paid' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                {f.status.toUpperCase()}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              {remote && bothOffered && (
                <label className="text-xs text-slate-500 flex items-center gap-1">
                  Pays by
                  <select aria-label={`${f.name}: how they pay`} value={f.payMethod} disabled={busy === `method-${f.id}`} onChange={(e) => changeFamilyMethod(f, e.target.value)} className="text-xs border border-slate-200 rounded px-1.5 py-1 bg-white">
                    <option value="card">Card (Stripe)</option>
                    <option value="bank">Bank transfer</option>
                  </select>
                </label>
              )}
              {(!f.hasSubscription || f.payMethod === 'bank') && (
                <button onClick={() => setRecording(recording?.id === f.id ? null : { id: f.id, amount: String(f.total || '') })} className="text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded font-medium">Record payment</button>
              )}
              {f.status === 'paid' && !f.hasSubscription && (
                <button onClick={() => changeFamilyStatus(f, 'overdue')} disabled={busy === `status-${f.id}`} className="text-xs bg-rose-50 text-rose-700 px-2 py-1 rounded font-medium">Mark overdue</button>
              )}
              {f.status === 'overdue' && first && (
                <button onClick={() => setReminderFor(reminderFor === f.id ? null : f.id)} className="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded font-medium">Remind</button>
              )}
            </div>
            {recording?.id === f.id && (
              <form onSubmit={(e) => { e.preventDefault(); recordPayment(f); }} className="mt-2 p-3 bg-emerald-50 rounded-lg space-y-2">
                <p className="text-xs text-emerald-900">Money received from the {f.name} (reference {f.reference}):</p>
                <div className="flex gap-2">
                  <input inputMode="decimal" aria-label={`Amount received from ${f.name}`} value={recording.amount} onChange={(e) => setRecording({ ...recording, amount: e.target.value })} className={`${inputCls} mt-0 flex-1`} />
                  <button type="submit" disabled={busy === 'record'} className="px-3 bg-emerald-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50">{busy === 'record' ? 'Saving…' : 'Mark paid'}</button>
                  <button type="button" onClick={() => setRecording(null)} className="px-3 bg-white text-slate-600 rounded-lg text-xs font-semibold border border-slate-200">Cancel</button>
                </div>
                <p className="text-[11px] text-emerald-800">Marks the whole family paid and adds the income to your books.</p>
              </form>
            )}
            {reminderFor === f.id && first && (
              <div className="mt-2 p-3 bg-slate-50 rounded-lg space-y-2">
                <p className="text-xs text-slate-500 whitespace-pre-line">{fillFamilyTemplate(smsTemplate, f)}</p>
                <div className="flex gap-2">
                  <a href={`sms:${phoneDigits(first.phone)}?&body=${encodeURIComponent(fillFamilyTemplate(smsTemplate, f))}`} className="flex-1 text-center text-xs bg-indigo-600 text-white py-2 rounded-lg font-semibold flex items-center justify-center gap-1"><Phone size={12} /> SMS</a>
                  <a href={`mailto:${mailAddress(first.email)}?subject=${encodeURIComponent('Overdue payment')}&body=${encodeURIComponent(fillFamilyTemplate(emailTemplate, f))}`} className="flex-1 text-center text-xs bg-indigo-600 text-white py-2 rounded-lg font-semibold flex items-center justify-center gap-1"><Mail size={12} /> Email</a>
                  <button onClick={() => copyText(fillFamilyTemplate(smsTemplate, f), 'Reminder')} className="flex-1 text-xs bg-slate-200 text-slate-700 py-2 rounded-lg font-semibold flex items-center justify-center gap-1"><Copy size={12} /> Copy</button>
                </div>
                {copyFallback && copyFallback.label === 'Reminder' && (
                  <textarea id="reminder-copy-fallback" readOnly rows="3" className={`${inputCls} text-xs`} value={copyFallback.text} onFocus={(e) => e.target.select()} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const searchTerm = athleteSearch.trim().toLowerCase();
  const searchDigits = searchTerm.replace(/\D/g, '');
  const matchesSearch = (a) => {
    if (!searchTerm) return true;
    const haystack = [a.name, a.parent, a.email, a.address, squadById(a.squadId)?.name].join(' ').toLowerCase();
    if (haystack.includes(searchTerm)) return true;
    return searchDigits.length >= 3 && (a.phone || '').replace(/\D/g, '').includes(searchDigits);
  };
  const shownAthletes = athletes.filter(matchesSearch).sort((x, y) => x.name.localeCompare(y.name));
  // Grouped by squad, in the same order as the Squads tab; empty groups are hidden
  const athleteGroups = [
    ...squads.map((sq) => ({ key: `sq-${sq.id}`, title: sq.name, list: shownAthletes.filter((a) => a.squadId === sq.id) })),
    { key: 'none', title: `No ${lc(W.group)}`, list: shownAthletes.filter((a) => !squadById(a.squadId)) },
  ].filter((g) => g.list.length > 0);

  const renderAddAthlete = () => {
    const f = newAthlete;
    const set = (k) => (e) => setNewAthlete({ ...f, [k]: k === 'squadId' ? Number(e.target.value) : e.target.value });
    return (
      <div className={`${card} space-y-2 border-indigo-200`}>
        <h3 className="font-semibold text-sm">New {W.member}</h3>
        <Field label={`${W.member}'s name`}><input className={inputCls} value={f.name} onChange={set('name')} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={W.group}>
            <select className={inputCls} value={f.squadId} onChange={set('squadId')}>
              {squads.map((sq) => <option key={sq.id} value={sq.id}>{sq.name}</option>)}
            </select>
          </Field>
          <Field label="Pays">
            <select className={inputCls} value={f.frequency} onChange={set('frequency')}>
              {Object.keys(FREQ_TITLE).map((k) => <option key={k} value={k}>{FREQ_TITLE[k]}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Parent / Guardian"><input className={inputCls} value={f.parent} onChange={set('parent')} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Phone"><input type="tel" className={inputCls} value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input type="email" className={inputCls} value={f.email} onChange={set('email')} /></Field>
        </div>
        <Field label="Home Address"><input className={inputCls} value={f.address} onChange={set('address')} /></Field>
        {isCoach ? (
          <>
            <Field label="Emergency Contact"><input className={inputCls} value={f.emergency} onChange={set('emergency')} /></Field>
            <Field label="Allergies"><input className={inputCls} value={f.allergies} onChange={set('allergies')} placeholder="None" /></Field>
            <Field label="Medication"><input className={inputCls} value={f.medication} onChange={set('medication')} placeholder="None" /></Field>
          </>
        ) : (
          <p className="text-[11px] text-slate-400">Parents add medical details themselves once they've signed in.</p>
        )}
        <div className="flex gap-2 pt-1">
          <button onClick={addAthlete} className={`flex-1 ${primaryBtn} py-2`}><Check size={12} /> Add {lc(W.member)}</button>
          <button onClick={() => { setShowAddAthlete(false); setNewAthlete(null); }} className={`flex-1 ${ghostBtn}`}><X size={12} /> Cancel</button>
        </div>
      </div>
    );
  };

  const renderAthletes = () => (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 -mx-4 px-4 pt-1 pb-2 bg-slate-50 space-y-2">
        <div className="flex justify-between items-center">
          <h2 className="font-bold text-base">{W.members}</h2>
          {!showAddAthlete && (
            <button onClick={() => { setNewAthlete(blankAthlete()); setShowAddAthlete(true); }} className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1"><Plus size={12} /> Add {lc(W.member)}</button>
          )}
        </div>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            id="athlete-search"
            type="search"
            value={athleteSearch}
            onChange={(e) => { setAthleteSearch(e.target.value); setExpandedAthleteId(null); }}
            placeholder={`Search name, parent, phone, email or ${lc(W.group)}`}
            className="w-full pl-9 pr-9 py-2.5 border border-slate-200 rounded-xl text-sm bg-white"
            aria-label={`Search ${lc(W.members)}`}
          />
          {athleteSearch && (
            <button onClick={() => setAthleteSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400" aria-label="Clear search"><X size={14} /></button>
          )}
        </div>
        <p className="text-[11px] text-slate-400">
          {searchTerm ? `${shownAthletes.length} of ${athletes.length} athletes` : `${athletes.length} athletes · tap a name for full details`}
        </p>
      </div>
      {showAddAthlete && newAthlete && renderAddAthlete()}
      {athletes.length === 0 && !showAddAthlete && (
        <div className={`${card} text-center text-sm text-slate-500`}>No {lc(W.members)} yet. Tap Add {lc(W.member)} to add the first one.</div>
      )}
      {athletes.length > 0 && shownAthletes.length === 0 && (
        <div className={`${card} text-center text-sm text-slate-500`}>No athletes match "{athleteSearch.trim()}".</div>
      )}
      {athleteGroups.map(({ key, title, list }) => (
        <section key={key} className="space-y-2" aria-label={title}>
          <h3 className="flex justify-between items-baseline px-1 pt-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</span>
            <span className="text-[11px] text-slate-400">{list.length} {list.length === 1 ? lc(W.member) : lc(W.members)}</span>
          </h3>
      {list.map((a) => (
        <div key={a.id} className="bg-white p-3 rounded-xl shadow-sm border border-slate-100">
          {editingAthleteId === a.id ? (
            <div className="space-y-2">
              <p className="font-medium text-sm">{a.name}</p>
              <Field label={W.group}>
                <select className={inputCls} value={athleteDraft.squadId} onChange={(e) => setAthleteDraft({ ...athleteDraft, squadId: Number(e.target.value) })}>
                  {squads.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Family pays">
                  <select className={inputCls} value={athleteDraft.frequency} onChange={(e) => setAthleteDraft({ ...athleteDraft, frequency: e.target.value })}>
                    {Object.keys(FREQ_TITLE).map((f) => <option key={f} value={f}>{FREQ_TITLE[f]}</option>)}
                  </select>
                </Field>
                {bothOffered && (
                  <Field label="Family pays by">
                    <select className={inputCls} value={athleteDraft.payMethod || ''} onChange={(e) => setAthleteDraft({ ...athleteDraft, payMethod: e.target.value })}>
                      {!athleteDraft.payMethod && <option value="">Not chosen yet</option>}
                      <option value="bank">Bank transfer</option>
                      <option value="card">Card (Stripe)</option>
                    </select>
                  </Field>
                )}
                <Field label={remote && a.hasSubscription ? 'Family status (from Stripe)' : 'Family status'}>
                  <select className={inputCls} disabled={remote && a.hasSubscription} value={athleteDraft.status} onChange={(e) => setAthleteDraft({ ...athleteDraft, status: e.target.value })}>
                    <option value="paid">Paid</option>
                    <option value="overdue">Overdue</option>
                  </select>
                </Field>
              </div>
              <p className="text-xs text-slate-500">Price for {a.name.split(' ')[0]}: {money(squadById(athleteDraft.squadId)?.[athleteDraft.frequency])}/{FREQ_LABEL[athleteDraft.frequency]}. How often and how the family pays applies to all their children.</p>
              {athleteDraft.squadId !== a.squadId && <p className="text-[11px] text-amber-700">Moving {lc(W.groups)} clears their regular training days so the parent can pick new ones.</p>}

              <Field label="Parent / Guardian"><input className={inputCls} value={athleteDraft.parent} onChange={(e) => setAthleteDraft({ ...athleteDraft, parent: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Phone"><input type="tel" className={inputCls} value={athleteDraft.phone} onChange={(e) => setAthleteDraft({ ...athleteDraft, phone: e.target.value })} /></Field>
                <Field label="Email"><input type="email" className={inputCls} value={athleteDraft.email} onChange={(e) => setAthleteDraft({ ...athleteDraft, email: e.target.value })} /></Field>
              </div>
              <Field label="Home Address"><input className={inputCls} value={athleteDraft.address} onChange={(e) => setAthleteDraft({ ...athleteDraft, address: e.target.value })} /></Field>

              {isCoach && (
                <>
                  <Field label="Emergency Contact"><input className={inputCls} value={athleteDraft.emergency} onChange={(e) => setAthleteDraft({ ...athleteDraft, emergency: e.target.value })} /></Field>
                  <Field label="Allergies"><input className={inputCls} value={athleteDraft.allergies} onChange={(e) => setAthleteDraft({ ...athleteDraft, allergies: e.target.value })} /></Field>
                  <Field label="Medication"><input className={inputCls} value={athleteDraft.medication} onChange={(e) => setAthleteDraft({ ...athleteDraft, medication: e.target.value })} /></Field>
                </>
              )}

              <div className="flex gap-2 pt-1">
                <button onClick={saveAthlete} disabled={busy === 'athlete'} className={`flex-1 ${primaryBtn} py-2`}><Check size={12} /> Save</button>
                <button onClick={() => setEditingAthleteId(null)} className={`flex-1 ${ghostBtn}`}><X size={12} /> Cancel</button>
              </div>
            </div>
          ) : (
            renderAthleteSummary(a)
          )}
        </div>
      ))}
        </section>
      ))}
    </div>
  );

  // ----- Session passes (coach and treasurer) -----

  const startPassForm = (a) => {
    setPassEdit(null);
    setPassForm({ athleteId: a.id, sessions: '10', price: '', paidBy: 'offer', forFamily: false });
  };

  const issuePass = async (a) => {
    const sessions = parseInt(passForm?.sessions, 10);
    const price = passForm.paidBy === 'free' ? 0 : parseFloat(passForm.price);
    if (!Number.isInteger(sessions) || sessions < 1 || sessions > 500) { showFlash('Enter the number of sessions (1 to 500)'); return; }
    if (!Number.isFinite(price) || price < 0) { showFlash('Enter a price'); return; }
    const { paidBy, forFamily } = passForm;
    if (paidBy === 'offer' && !(price > 0)) { showFlash('Enter the price the parents will pay'); return; }
    const who = forFamily ? `The ${families.find((f) => f.athleteIds.includes(a.id))?.name || 'family'}` : a.name.split(' ')[0];
    const done = paidBy === 'offer' ? `Pass offered: ${who} can buy ${plural(sessions, 'session')} for ${money(price)}` : `${who} now has a ${sessions}-session pass`;
    if (!remote) {
      const familyId = forFamily ? familyIdOf(a.id) : null;
      setPasses((prev) => [...prev, {
        id: Date.now(), athleteId: familyId ? null : a.id, familyId, sessions, used: 0, left: sessions, price,
        paidBy: paidBy === 'offer' ? 'unpaid' : paidBy, status: paidBy === 'offer' ? 'offered' : 'active', issuedOn: todayISO,
      }]);
      if ((paidBy === 'bank' || paidBy === 'cash') && price > 0) {
        setTransactions((prev) => [...prev, { id: Date.now(), date: todayISO, type: 'Income', category: 'Session Pass', description: `${forFamily ? who.replace(/^The /, '') : a.name} - ${sessions}-Session Pass (${PAID_BY_LABEL[paidBy]})`, amount: price, gst: true }]);
      }
      setPassForm(null);
      showFlash(done);
      return;
    }
    setBusy('pass-issue');
    try {
      const res = await api(`/api/athletes/${a.id}/passes`, { method: 'POST', body: { sessions, price, paidBy, forFamily: Boolean(forFamily) } });
      setPasses((prev) => [...prev, res.pass]);
      if (res.transaction) setTransactions((prev) => [...prev, res.transaction]);
      setPassForm(null);
      showFlash(done);
    } catch (e) {
      if (!e.signedOut) showFlash(e.message);
    } finally {
      setBusy('');
    }
  };

  // Change a pass: { left }, { paidBy } for one not paid yet, or { status: 'cancelled' }
  const changePass = async (p, body, done) => {
    if (!remote) {
      setPasses((prev) => prev.map((x) => {
        if (x.id !== p.id) return x;
        if (body.status) return { ...x, status: body.status };
        if (body.left != null) return { ...x, sessions: x.used + body.left, left: body.left };
        return { ...x, paidBy: body.paidBy, status: 'active' };
      }));
      if (body.paidBy && p.price > 0) {
        setTransactions((prev) => [...prev, { id: Date.now(), date: todayISO, type: 'Income', category: 'Session Pass', description: `${passOwnerLabel(p)} - ${p.sessions}-Session Pass (${PAID_BY_LABEL[body.paidBy]})`, amount: p.price, gst: true }]);
      }
      showFlash(done);
      return;
    }
    setBusy(`pass-${p.id}`);
    try {
      const res = await api(`/api/passes/${p.id}`, { method: 'PUT', body });
      setPasses((prev) => prev.map((x) => (x.id === p.id ? res.pass : x)));
      if (res.transaction) setTransactions((prev) => [...prev, res.transaction]);
      showFlash(done);
    } catch (e) {
      if (!e.signedOut) showFlash(e.message);
    } finally {
      setBusy('');
    }
  };


  const renderAthletePasses = (a) => {
    const list = passes.filter((p) => p.status !== 'cancelled' && passBelongs(p, a.id));
    const first = a.name.split(' ')[0];
    const f = passForm?.athleteId === a.id ? passForm : null;
    const fam = families.find((x) => x.athleteIds.includes(a.id));
    const siblings = fam ? membersOf(fam).filter((k) => k.id !== a.id) : [];
    return (
      <div>
        <p className="text-xs font-semibold text-slate-700 pb-1">Session passes</p>
        {list.length === 0 && !f && <p className="text-xs text-slate-400 pb-1">No pass. Offer one if {first} doesn't come every week.</p>}
        {list.map((p) => (
          <div key={p.id} className="py-1.5 border-b border-slate-50 text-xs space-y-1">
            <div className="flex justify-between gap-2">
              <span className="min-w-0">
                {p.familyId != null && <span className="block text-[10px] uppercase tracking-wide text-violet-700 font-semibold">{fam?.name || 'Family'} pass · shared</span>}
                {p.status === 'offered'
                  ? <span className="font-semibold text-slate-800">Offered: {plural(p.sessions, 'session')} for {money(p.price)}</span>
                  : <span className={`font-semibold ${p.left > 0 ? 'text-slate-800' : 'text-rose-700'}`}>{p.left} of {p.sessions} sessions left</span>}
                <span className="block text-slate-400">{p.status === 'offered' ? `Waiting for the parents to buy it · offered ${fmtShort(p.issuedOn)}` : `${p.paidBy === 'free' ? 'Free' : `${money(p.price)} · ${PAID_BY_LABEL[p.paidBy]}`} · given ${fmtShort(p.issuedOn)}`}</span>
              </span>
              {p.status === 'offered'
                ? <span className="text-[10px] px-1.5 py-0.5 h-fit rounded bg-indigo-50 text-indigo-700 font-semibold shrink-0">OFFERED</span>
                : p.paidBy === 'unpaid' && <span className="text-[10px] px-1.5 py-0.5 h-fit rounded bg-amber-50 text-amber-700 font-semibold shrink-0">NOT PAID</span>}
            </div>
            {passEdit?.id === p.id ? (
              <form onSubmit={(e) => { e.preventDefault(); const left = parseInt(passEdit.left, 10); if (!Number.isInteger(left) || left < 0) { showFlash('Enter the sessions left'); return; } changePass(p, { left }, 'Pass updated'); setPassEdit(null); }} className="flex gap-2 items-center">
                <input type="number" min="0" aria-label={`${first}: sessions left`} value={passEdit.left} onChange={(e) => setPassEdit({ ...passEdit, left: e.target.value })} className={`${inputCls} mt-0 w-20`} />
                <span className="text-slate-500">sessions left</span>
                <button type="submit" className="px-2 py-1 bg-indigo-600 text-white rounded font-semibold">Save</button>
                <button type="button" onClick={() => setPassEdit(null)} className="px-2 py-1 bg-slate-100 rounded font-semibold">Cancel</button>
              </form>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {p.paidBy === 'unpaid' && (
                  <>
                    <button onClick={() => changePass(p, { paidBy: 'bank' }, 'Pass marked paid')} disabled={busy === `pass-${p.id}`} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded font-medium">Paid by bank</button>
                    <button onClick={() => changePass(p, { paidBy: 'cash' }, 'Pass marked paid')} disabled={busy === `pass-${p.id}`} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded font-medium">Paid in cash</button>
                  </>
                )}
                {p.status === 'active' && <button onClick={() => setPassEdit({ id: p.id, left: String(p.left) })} className="px-2 py-1 bg-slate-100 text-slate-700 rounded font-medium">Change sessions left</button>}
                <button onClick={() => changePass(p, { status: 'cancelled' }, p.status === 'offered' ? 'Offer withdrawn' : 'Pass cancelled')} disabled={busy === `pass-${p.id}`} className="px-2 py-1 bg-rose-50 text-rose-700 rounded font-medium">{p.status === 'offered' ? 'Withdraw offer' : 'Cancel pass'}</button>
              </div>
            )}
          </div>
        ))}
        {f ? (
          <form onSubmit={(e) => { e.preventDefault(); issuePass(a); }} className="mt-2 p-3 bg-indigo-50 rounded-lg space-y-2">
            <p className="text-xs font-semibold text-indigo-900">New pass</p>
            {siblings.length > 0 && (
              <Field label="Who it's for">
                <select aria-label="Who the pass is for" className={inputCls} value={f.forFamily ? 'family' : 'child'} onChange={(e) => setPassForm({ ...f, forFamily: e.target.value === 'family' })}>
                  <option value="child">{first} only</option>
                  <option value="family">The {fam.name} (shared with {siblings.map((k) => k.name.split(' ')[0]).join(', ')})</option>
                </select>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Number of sessions"><input type="number" min="1" max="500" aria-label="Number of sessions" className={inputCls} value={f.sessions} onChange={(e) => setPassForm({ ...f, sessions: e.target.value })} /></Field>
              <Field label="Price ($)"><input type="number" step="0.01" min="0" aria-label="Pass price" placeholder="e.g. 60" className={inputCls} disabled={f.paidBy === 'free'} value={f.paidBy === 'free' ? '0' : f.price} onChange={(e) => setPassForm({ ...f, price: e.target.value })} /></Field>
            </div>
            <Field label="How it's paid">
              <select aria-label="How it's paid" className={inputCls} value={f.paidBy} onChange={(e) => setPassForm({ ...f, paidBy: e.target.value })}>
                <option value="offer">Offer it to the parents to buy</option>
                <option value="bank">Already paid by bank transfer</option>
                <option value="cash">Already paid in cash</option>
                <option value="unpaid">Start now, paid later</option>
                <option value="free">Free</option>
              </select>
            </Field>
            <p className="text-[11px] text-indigo-800">
              {f.paidBy === 'offer'
                ? `The parents see the offer on their Payments page and can buy it (by card, or by bank transfer for you to mark paid). It starts once paid.`
                : `Starts now. Each session ${f.forFamily ? 'one of the children is' : `${first} is`} marked present uses one. Money received goes in the books.`}
            </p>
            <div className="flex gap-2">
              <button type="submit" disabled={busy === 'pass-issue'} className={`flex-1 ${primaryBtn} py-2`}><Check size={12} /> {busy === 'pass-issue' ? 'Saving…' : f.paidBy === 'offer' ? 'Offer pass' : 'Give pass'}</button>
              <button type="button" onClick={() => setPassForm(null)} className={`flex-1 ${ghostBtn}`}><X size={12} /> Cancel</button>
            </div>
          </form>
        ) : (
          <button onClick={() => startPassForm(a)} className={`w-full mt-1 ${ghostBtn} bg-indigo-50 text-indigo-700`}><Plus size={12} /> Offer or give a pass</button>
        )}
      </div>
    );
  };

  const DetailRow = ({ label, children }) => (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-1">
      <span className="text-[11px] uppercase tracking-wide text-slate-400 pt-0.5">{label}</span>
      <span className="text-sm text-slate-800 min-w-0 break-words select-text">{children}</span>
    </div>
  );

  const renderAthleteSummary = (a) => {
    const open = expandedAthleteId === a.id;
    const squad = squadById(a.squadId);
    const hasMedical = hasValue(a.allergies) || hasValue(a.medication);
    const regularDays = seriesAsOf(squad, todayISO).filter((s) => (a.regularSessions || []).includes(s.seriesId));
    return (
      <div>
        <button onClick={() => setExpandedAthleteId(open ? null : a.id)} className="w-full text-left flex justify-between items-center gap-2" aria-expanded={open}>
          <span className="min-w-0">
            <span className="block font-medium text-sm">{a.name}</span>
            <span className="block text-xs text-indigo-600 font-medium">{squad?.name} · {money(priceFor(a))}/{FREQ_LABEL[a.frequency]}</span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            {isCoach && hasMedical && <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 font-semibold">Medical</span>}
            {hasPass(a.id) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-semibold">Pass {passLeft(a.id)} left</span>}
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${a.status === 'paid' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{a.status.toUpperCase()}</span>
            {open ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
          </span>
        </button>

        {open && (
          <div className="mt-3 pt-2 border-t border-slate-100 space-y-3">
            <div>
              <p className="text-xs font-semibold text-slate-700 pb-1">Contact</p>
              <DetailRow label="Parent">{a.parent}</DetailRow>
              <DetailRow label="Phone"><a href={`tel:${phoneDigits(a.phone)}`} className="text-indigo-700 underline-offset-2 hover:underline">{a.phone}</a></DetailRow>
              <DetailRow label="Email"><a href={`mailto:${mailAddress(a.email)}`} className="text-indigo-700 underline-offset-2 hover:underline">{a.email}</a></DetailRow>
              <DetailRow label="Address">{a.address || '—'}</DetailRow>
            </div>

            {isCoach && (
              <div>
                <p className="text-xs font-semibold text-slate-700 pb-1">Emergency & Medical</p>
                <DetailRow label="Emergency">{a.emergency || '—'}</DetailRow>
                <DetailRow label="Allergies"><span className={hasValue(a.allergies) ? 'text-rose-700 font-medium' : ''}>{a.allergies || 'None'}</span></DetailRow>
                <DetailRow label="Medication"><span className={hasValue(a.medication) ? 'text-amber-700 font-medium' : ''}>{a.medication || 'None'}</span></DetailRow>
              </div>
            )}

            {isCoach && (
              <div>
                <p className="text-xs font-semibold text-slate-700 pb-1">Training</p>
                <DetailRow label="Regular days">{regularDays.length ? regularDays.map((s) => `${DAY_SHORT[s.day]} ${fmtTime(s.start)}`).join(' · ') : 'None chosen yet'}</DetailRow>
              </div>
            )}

            <div>
              <p className="text-xs font-semibold text-slate-700 pb-1">Billing</p>
              <DetailRow label="Plan">{FREQ_TITLE[a.frequency]} · {money(priceFor(a))}/{FREQ_LABEL[a.frequency]}</DetailRow>
              <DetailRow label="Auto-pay">{a.autoDebit ? `On${a.cardLast4 ? ` · card •••• ${a.cardLast4}` : ''}` : 'Off'}</DetailRow>
              <DetailRow label="Next payment">{a.nextBillingDate ? fmtDay(a.nextBillingDate) : '—'}</DetailRow>
            </div>

            {renderAthletePasses(a)}

            <div className="flex gap-2">
              <button onClick={() => startEditAthlete(a)} className={`flex-1 ${ghostBtn}`}><Edit2 size={12} /> Edit details</button>
              {isCoach && (
                <button onClick={() => deleteAthlete(a)} className={`${ghostBtn} px-3 ${confirmDeleteAthlete === a.id ? 'bg-rose-600 text-white' : 'text-rose-700'}`} aria-label={`Delete ${a.name}`}>
                  <Trash2 size={12} /> {confirmDeleteAthlete === a.id ? 'Tap again' : ''}
                </button>
              )}
              {remote && isCoach && <button onClick={() => inviteParent(a)} className={`flex-1 ${ghostBtn} bg-indigo-50 text-indigo-700`}><UserPlus size={12} /> Invite or link parent</button>}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderReports = () => (
    <div className="space-y-4">
      <h2 className="font-bold text-base">GST & Financial Reports</h2>
      <div className={`${card} space-y-3`}>
        <p className="text-xs text-slate-500">Select reporting window for tax & accounting export:</p>
        <div className="grid grid-cols-3 gap-2">
          {[[2, '2-Month (GST)'], [6, '6-Month'], [12, 'Full Year']].map(([m, label]) => (
            <button key={m} onClick={() => setReportMonths(m)} className={`p-2 text-xs font-semibold rounded-lg text-center ${reportMonths === m ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' : 'bg-slate-100 text-slate-700'}`}>{label}</button>
          ))}
        </div>
        <p className="text-xs text-slate-500">Period: <span className="font-medium text-slate-700">{fmtLong(win.start)} – {fmtLong(win.end)}</span></p>

        <div className="text-xs space-y-1 bg-slate-50 rounded-lg p-3">
          <div className="flex justify-between"><span>Income (incl GST)</span><span>{money(report.income)}</span></div>
          <div className="flex justify-between"><span>Expenses (incl GST)</span><span>{money(report.expenses)}</span></div>
          <div className="flex justify-between text-slate-500"><span>GST collected on sales</span><span>{money(report.gstCollected)}</span></div>
          <div className="flex justify-between text-slate-500"><span>GST paid on purchases</span><span>{money(report.gstPaid)}</span></div>
          <div className="flex justify-between font-semibold pt-1 border-t border-slate-200">
            <span>{report.netGst >= 0 ? 'Net GST to pay' : 'Net GST refund'}</span><span>{money(Math.abs(report.netGst))}</span>
          </div>
        </div>

        {PREVIEW ? (
          <button onClick={() => copyText(buildCsv(), 'CSV report')} className={`w-full ${primaryBtn}`}><Copy size={12} /> Copy CSV report</button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={downloadCsv} className={primaryBtn}><Download size={12} /> Download CSV</button>
            <button onClick={printReport} className={primaryBtn}><Printer size={12} /> Print / PDF</button>
          </div>
        )}
        {copyFallback && (
          <div className="space-y-1">
            <p className="text-[11px] text-slate-500">Copying isn't available here. Select the text below and copy it.</p>
            <textarea id="copy-fallback" readOnly rows="5" className={`${inputCls} text-[11px] font-mono`} value={copyFallback.text} onFocus={(e) => e.target.select()} />
            <button onClick={() => setCopyFallback(null)} className={`w-full ${ghostBtn}`}>Close</button>
          </div>
        )}
        <p className="text-[11px] text-slate-400">Amounts are GST-inclusive; GST is 3/23 of each amount where GST applies (15%).</p>
      </div>

      <div className={`${card} space-y-2`}>
        <div className="flex justify-between items-center">
          <h3 className="font-semibold text-sm">Ledger ({reportTx.length} in period)</h3>
          <button onClick={() => setShowAddTx(!showAddTx)} className="text-xs bg-indigo-50 text-indigo-700 px-2 py-1 rounded-lg font-medium flex items-center gap-1"><Plus size={12} /> Add</button>
        </div>
        {showAddTx && (
          <div className="space-y-2 p-3 bg-slate-50 rounded-lg">
            <div className="grid grid-cols-2 gap-2">
              <input type="date" className={inputCls} value={newTx.date} onChange={(e) => setNewTx({ ...newTx, date: e.target.value })} />
              <select className={inputCls} value={newTx.type} onChange={(e) => setNewTx({ ...newTx, type: e.target.value })}>
                <option>Expense</option><option>Income</option>
              </select>
            </div>
            <input className={inputCls} placeholder="Category (e.g. Facility Hire)" value={newTx.category} onChange={(e) => setNewTx({ ...newTx, category: e.target.value })} />
            <input className={inputCls} placeholder="Description" value={newTx.description} onChange={(e) => setNewTx({ ...newTx, description: e.target.value })} />
            <input type="number" step="0.01" min="0" className={inputCls} placeholder="Amount incl GST" value={newTx.amount} onChange={(e) => setNewTx({ ...newTx, amount: e.target.value })} />
            <label className="text-xs text-slate-600 flex items-center gap-2">
              <input type="checkbox" checked={newTx.gst} onChange={(e) => setNewTx({ ...newTx, gst: e.target.checked })} /> GST applies
            </label>
            <button onClick={addTransaction} className={`w-full ${primaryBtn} py-2`}>Add Transaction</button>
          </div>
        )}
        {reportTx.length === 0 && <p className="text-xs text-slate-400">No transactions in this period.</p>}
        {reportTx.map((t) => (
          <div key={t.id} className="flex justify-between items-center text-xs py-1.5 border-b border-slate-50">
            <div>
              <p className="font-medium text-slate-700">{t.description}</p>
              <p className="text-slate-400">{fmtShort(t.date)} · {t.category}{t.gst ? '' : ' · no GST'}</p>
            </div>
            <span className={`font-semibold ${t.type === 'Income' ? 'text-emerald-600' : 'text-rose-600'}`}>{t.type === 'Income' ? '+' : '−'}{money(t.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  // Any start date: charities, companies and incorporated societies can each have their own balance date
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const renderFinancialYear = () => {
    const [m, d] = financialYearStart.split('-').map(Number);
    const setFy = (month, day) => {
      const dd = Math.min(day, MONTH_DAYS[month - 1]);
      setFinancialYearStart(`${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
      setSettingsDirty(true);
    };
    const start = new Date(2025, m - 1, d);
    const end = new Date(2026, m - 1, d - 1);
    const presets = [['04-01', '1 April'], ['07-01', '1 July'], ['01-01', '1 January']];
    return (
      <div className="space-y-2">
        <p className="text-xs text-slate-500">Financial year starts on</p>
        <div className="grid grid-cols-[80px_1fr] gap-2">
          <select aria-label="Financial year start day" value={d} onChange={(e) => setFy(m, Number(e.target.value))} className={inputCls}>
            {Array.from({ length: MONTH_DAYS[m - 1] }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <select aria-label="Financial year start month" value={m} onChange={(e) => setFy(Number(e.target.value), d)} className={inputCls}>
            {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {presets.map(([v, label]) => (
            <button key={v} type="button" onClick={() => { setFinancialYearStart(v); setSettingsDirty(true); }} className={`text-[11px] px-2 py-1 rounded-full border ${financialYearStart === v ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'}`}>{label}</button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400">Your year runs {start.getDate()} {MONTH_NAMES[start.getMonth()]} to {end.getDate()} {MONTH_NAMES[end.getMonth()]}. It sets the year-to-date figures and the GST and financial reports. Use your balance date from your charity, society or company registration.</p>
      </div>
    );
  };

  const renderFinanceSettings = () => (
    <div className={`${card} space-y-3 text-sm`}>
      <h3 className="font-semibold text-sm">Finance Settings & Templates</h3>
      {renderFinancialYear()}
      <Field label="Overdue SMS Template">
        <textarea className={`${inputCls} text-xs`} rows="3" value={smsTemplate} onChange={(e) => { setSmsTemplate(e.target.value); setSettingsDirty(true); }} />
      </Field>
      <Field label="Overdue Email Template">
        <textarea className={`${inputCls} text-xs`} rows="6" value={emailTemplate} onChange={(e) => { setEmailTemplate(e.target.value); setSettingsDirty(true); }} />
      </Field>
      <p className="text-[11px] text-slate-400">Placeholders: {'{ParentName}'}, {'{AthleteName}'}, {'{Amount}'}, {'{PaymentLink}'}</p>
      <p className="text-[11px] text-slate-400">Payments: {!remote ? 'demo mode' : paymentsConnected ? 'connected to Stripe' : 'Stripe not connected yet'}</p>
      {remote && settingsDirty && (
        <button onClick={saveSettings} className={`w-full ${primaryBtn}`}><Check size={12} /> Save settings</button>
      )}
    </div>
  );

  // How parents pay the club (coach and treasurer)
  const renderPaymentMethods = () => remote && (
    <PaymentMethodsCard club={club} showFlash={showFlash} onClubChange={(c) => updateUser?.({ ...me, club: c })} />
  );

  // Server mode: account security for everyone, plus team & family access for staff
  const renderAccount = () => remote && (
    <AccountSecurity user={me} onUserChange={(u) => updateUser?.(u)} signOut={signOut} showFlash={showFlash} />
  );
  const renderTeamAccess = () => remote && (
    <TeamAccess me={me} athletes={athletes} words={W} showFlash={showFlash} inviteRequest={inviteRequest} onInviteHandled={() => setInviteRequest(null)} />
  );

  // ----- Coach -----
  const renderCoachHome = () => (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="font-bold text-base">Today's Sessions</h2>
        <p className="text-xs text-slate-500 mb-2">{fmtDay(todayISO)}</p>
        {todaysSessions.length === 0 && <p className="text-xs text-slate-400">No training scheduled today.</p>}
        {todaysSessions.map((s) => {
          const roster = squadAthletes(s.squad.id);
          const expected = roster.filter((a) => isAttending(a, s)).length;
          const present = roster.filter((a) => attendance[rsvpKey(a.id, s.seriesId, s.date)]).length;
          return (
            <button key={s.id} onClick={() => openAttendance(s.squad.id, s.id, todayISO)} className="w-full text-left py-2 border-b border-slate-50 flex justify-between items-center">
              <div>
                <p className={`text-sm font-medium ${s.cancelled ? 'line-through text-slate-400' : ''}`}>{fmtTime(s.start)} · {s.squad.name}</p>
                <p className="text-xs text-slate-400">{s.location}</p>
              </div>
              <span className="text-xs text-slate-500">{s.cancelled ? 'Cancelled' : `${present} present / ${expected} coming`}</span>
            </button>
          );
        })}
      </div>
      {renderFinanceStats()}
      {renderReconciliation()}
    </div>
  );

  const renderAttendance = () => {
    const sessions = sessionsAcrossSquads(attendanceDate);
    return (
      <div className="space-y-3">
        <h2 className="font-bold text-base">Poolside Attendance</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setAttendanceDate(addDays(attendanceDate, -1))} className="p-2 bg-white border border-slate-200 rounded-lg" aria-label="Previous day"><ChevronLeft size={16} /></button>
          <input type="date" className="flex-1 p-2 border border-slate-200 rounded-lg text-sm bg-white" value={attendanceDate} onChange={(e) => e.target.value && setAttendanceDate(e.target.value)} />
          <button onClick={() => setAttendanceDate(addDays(attendanceDate, 1))} className="p-2 bg-white border border-slate-200 rounded-lg" aria-label="Next day"><ChevronRight size={16} /></button>
        </div>
        {attendanceDate !== todayISO && (
          <button onClick={() => setAttendanceDate(todayISO)} className="text-xs text-indigo-600 font-medium">Back to today</button>
        )}
        {sessions.length === 0 && <p className="text-xs text-slate-400">No sessions scheduled on {fmtDay(attendanceDate)}.</p>}

        {/* Step 1: pick the group */}
        <div className={`${card} space-y-2`}>
          <h3 className="font-semibold text-sm">Select group</h3>
          {squads.map((sq) => {
            const ss = sessionsOn(sq, attendanceDate);
            const live = ss.find((x) => !x.cancelled);
            const booked = live ? squadAthletes(sq.id).filter((a) => isAttending(a, live)).length : 0;
            const selected = sq.id === attendanceSquadId;
            return (
              <button
                key={sq.id}
                onClick={() => { setAttendanceSquadId(sq.id); setAttendanceSessionId(null); }}
                className={`w-full text-left p-3 rounded-lg border flex justify-between items-center gap-2 ${selected ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200'} ${ss.length ? '' : 'opacity-60'}`}
              >
                <span className="min-w-0">
                  <span className={`block text-sm font-medium ${selected ? 'text-indigo-700' : 'text-slate-800'}`}>{sq.name}</span>
                  <span className="block text-xs text-slate-400">
                    {ss.length ? ss.map((x) => (x.cancelled ? `${fmtTime(x.start)} cancelled` : `${fmtTime(x.start)}–${fmtTime(x.end)}`)).join(' · ') : 'No session this day'}
                  </span>
                </span>
                {live && <span className="text-xs text-slate-500 shrink-0">{booked} booked</span>}
              </button>
            );
          })}
        </div>

        {/* Step 2: the roster for that group */}
        {!attendanceSquadId
          ? <p className="text-xs text-slate-400 text-center">Choose a group to see who's booked in.</p>
          : renderGroupRoster(squadById(attendanceSquadId))}
      </div>
    );
  };

  const renderAttendanceRow = (a, s) => {
    const isPresent = attendance[rsvpKey(a.id, s.seriesId, s.date)] || false;
    return (
      <div key={a.id} className="flex justify-between items-center gap-2 py-2 border-t border-slate-50">
        <button onClick={() => openAthlete(a)} className="min-w-0 text-left font-medium text-sm text-slate-800 hover:text-indigo-700" title={`Open in ${W.members}`}>
          {a.name}
          {hasPass(a.id) && <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded font-semibold ${passLeft(a.id) > 0 ? 'bg-indigo-50 text-indigo-700' : 'bg-rose-50 text-rose-700'}`}>Pass: {passLeft(a.id)} left</span>}
        </button>
        <button
          onClick={() => toggleAttendance(a.id, s)}
          className={`shrink-0 px-3 py-2 rounded-xl text-xs font-bold transition-all ${isPresent ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}
        >
          {isPresent ? 'PRESENT' : 'ABSENT'}
        </button>
      </div>
    );
  };

  const renderGroupRoster = (squad) => {
    if (!squad) return null;
    const ss = sessionsOn(squad, attendanceDate);

    if (ss.length === 0) {
      const next = nextTrainingDate(squad, addDays(attendanceDate, 1));
      return (
        <div className={`${card} space-y-2 text-center`}>
          <p className="text-sm text-slate-600">{squad.name} doesn't train on {fmtDay(attendanceDate)}.</p>
          {next && <button onClick={() => setAttendanceDate(next)} className={`w-full ${ghostBtn}`}>Go to next session · {fmtDay(next)}</button>}
        </div>
      );
    }

    const s = ss.find((x) => x.id === attendanceSessionId) || ss.find((x) => !x.cancelled) || ss[0];
    const byName = (x, y) => x.name.localeCompare(y.name);
    const roster = squadAthletes(squad.id);
    const booked = roster.filter((a) => isAttending(a, s)).sort(byName);
    const rest = roster.filter((a) => !isAttending(a, s)).sort(byName);
    const present = roster.filter((a) => attendance[rsvpKey(a.id, s.seriesId, s.date)]).length;
    const bookedNotMarked = booked.filter((a) => !attendance[rsvpKey(a.id, s.seriesId, s.date)]);

    return (
      <div className={`${card} space-y-3`}>
        {ss.length > 1 && (
          <div className="flex gap-2">
            {ss.map((x) => (
              <button key={x.id} onClick={() => setAttendanceSessionId(x.id)} className={`flex-1 p-2 rounded-lg text-xs font-medium border ${x.id === s.id ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'}`}>
                {fmtTime(x.start)}{x.cancelled ? ' (cancelled)' : ''}
              </button>
            ))}
          </div>
        )}

        <div className="flex justify-between items-start gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-sm">{squad.name}</p>
            <p className="text-xs text-slate-500 flex items-center gap-1"><Clock size={11} /> {fmtDay(s.date)} · {fmtTime(s.start)}–{fmtTime(s.end)}</p>
            <p className="text-xs text-slate-400 flex items-center gap-1"><MapPin size={11} /> {s.location}</p>
          </div>
          {!s.cancelled && (
            <span className="text-xs text-slate-500 shrink-0 text-right">
              <span className="block font-semibold text-slate-700">{present} present</span>
              {booked.length} booked · {roster.length} in {lc(W.group)}
            </span>
          )}
        </div>

        {s.cancelled ? (
          <p className="text-xs text-rose-600">This session is cancelled{s.cancelReason ? ` — ${s.cancelReason}` : ''}.</p>
        ) : roster.length === 0 ? (
          <p className="text-xs text-slate-400">No {lc(W.members)} in this {lc(W.group)} yet.</p>
        ) : (
          <>
            <div>
              <div className="flex justify-between items-center pb-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Booked in · {booked.length}</p>
                {bookedNotMarked.length > 0 && (
                  <button onClick={() => markAllPresent(bookedNotMarked, s)} className={chipBtn}><Check size={10} /> Mark all present</button>
                )}
              </div>
              {booked.length === 0
                ? <p className="text-xs text-slate-400 py-2 border-t border-slate-50">Nobody has booked this session.</p>
                : booked.map((a) => renderAttendanceRow(a, s))}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 pb-1">Rest of {lc(W.group)} · {rest.length}</p>
              {rest.length === 0
                ? <p className="text-xs text-slate-400 py-2 border-t border-slate-50">Everyone in the {lc(W.group)} is booked in.</p>
                : rest.map((a) => renderAttendanceRow(a, s))}
              {rest.length > 0 && <p className="text-[11px] text-slate-400 pt-1">Mark anyone who turns up without booking as present too.</p>}
            </div>
          </>
        )}
      </div>
    );
  };

  // ----- Squads & timetable editor -----

  const renderSquadForm = () => {
    const f = squadForm;
    const set = (k) => (e) => setSquadForm({ ...f, [k]: e.target.value });
    const existing = f.mode === 'edit' ? squadById(f.id) : null;
    return (
      <div className={`${card} space-y-2 border-indigo-200`}>
        <h3 className="font-semibold text-sm">{f.mode === 'create' ? `New ${W.group}` : `Edit ${existing.name}`}</h3>
        <Field label={`${W.group} Name`}><input className={inputCls} value={f.name} onChange={set('name')} placeholder={`e.g. Silver ${W.group}`} /></Field>
        <Field label="Age Group / Level"><input className={inputCls} value={f.level} onChange={set('level')} placeholder="e.g. Ages 12–15 · Competitive" /></Field>
        <Field label="Description"><textarea rows="2" className={inputCls} value={f.description} onChange={set('description')} placeholder={`What the ${lc(W.group)} focuses on`} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Default Location"><input className={inputCls} value={f.location} onChange={set('location')} /></Field>
          <Field label={`Max ${W.members} / Session`}><input type="number" min="1" className={inputCls} value={f.capacity} onChange={set('capacity')} placeholder="No limit" /></Field>
        </div>
        <Field label="Coach"><input className={inputCls} value={f.coach} onChange={set('coach')} placeholder="Coach in charge" /></Field>
        <p className="text-xs font-semibold text-slate-600 pt-1">Pricing (GST-inclusive)</p>
        <div className="grid grid-cols-3 gap-2">
          {[['weekly', 'Weekly'], ['fortnightly', 'Fortnightly'], ['monthly', 'Monthly']].map(([k, label]) => (
            <Field key={k} label={`${label} ($)`}>
              <input type="number" step="0.01" min="0" className={inputCls} value={f[k]} onChange={set(k)} />
            </Field>
          ))}
        </div>
        <p className="text-[11px] text-slate-400">Session passes are offered to a child or family from their record in {W.members}.</p>
        <div className="flex gap-2 pt-1">
          <button onClick={saveSquadForm} disabled={busy === 'squad'} className={`flex-1 ${primaryBtn} py-2`}><Check size={12} /> {f.mode === 'create' ? `Create ${W.group}` : 'Save'}</button>
          <button onClick={() => setSquadForm(null)} className={`flex-1 ${ghostBtn}`}><X size={12} /> Cancel</button>
        </div>
        {existing && (
          <button onClick={() => deleteSquad(existing)} className={`w-full text-xs font-medium flex items-center justify-center gap-1 pt-1 ${confirmDeleteId === existing.id ? 'text-white bg-rose-600 py-2 rounded-lg' : 'text-rose-600'}`}>
            <Trash2 size={12} /> {confirmDeleteId === existing.id ? `Tap again to delete ${existing.name}` : `Delete ${lc(W.group)}`}
          </button>
        )}
      </div>
    );
  };

  const renderApplyChoice = (f, nowLabel, laterLabel) => (
    <div className="space-y-1">
      <p className="text-xs text-slate-400">When should this happen?</p>
      <div className="grid grid-cols-2 gap-2">
        {[['now', nowLabel], ['date', laterLabel]].map(([mode, label]) => (
          <button key={mode} onClick={() => setSessionForm({ ...f, applyMode: mode })} className={`p-2 rounded-lg text-xs font-medium border ${f.applyMode === mode ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'}`}>{label}</button>
        ))}
      </div>
      {f.applyMode === 'date' && (
        <input type="date" min={addDays(todayISO, 1)} className={inputCls} value={f.applyFrom} onChange={(e) => setSessionForm({ ...f, applyFrom: e.target.value })} />
      )}
    </div>
  );

  const renderSessionForm = (squad) => {
    const f = sessionForm;
    const s = f.sessionId ? squad.sessions.find((x) => x.id === f.sessionId) : null;
    const set = (k) => (e) => setSessionForm({ ...f, [k]: e.target.value });
    const actions = (label) => (
      <div className="flex gap-2 pt-1">
        <button onClick={saveSessionForm} className={`flex-1 ${primaryBtn} py-2`}><Check size={12} /> {label}</button>
        <button onClick={() => setSessionForm(null)} className={`flex-1 ${ghostBtn}`}><X size={12} /> Back</button>
      </div>
    );

    if (f.mode === 'add' || f.mode === 'edit') {
      return (
        <div className="p-3 bg-slate-50 rounded-lg space-y-2">
          <p className="text-xs font-semibold text-slate-700">{f.mode === 'add' ? 'Add training time' : `Change ${sessionLabel(s)}`}</p>
          <Field label="Day">
            <select className={inputCls} value={f.day} onChange={(e) => setSessionForm({ ...f, day: Number(e.target.value) })}>
              {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start"><input type="time" className={inputCls} value={f.start} onChange={set('start')} /></Field>
            <Field label="Finish"><input type="time" className={inputCls} value={f.end} onChange={set('end')} /></Field>
          </div>
          <Field label="Location / Lanes"><input className={inputCls} value={f.location} onChange={set('location')} placeholder={squad.location} /></Field>
          {renderApplyChoice(f, f.mode === 'add' ? 'Starts now' : 'Change now', 'From a date')}
          {f.mode === 'edit' && f.applyMode === 'date' && (
            <p className="text-[11px] text-slate-500">The current time keeps running until the day before, then switches. Parents' regular-day picks carry over.</p>
          )}
          {actions(f.mode === 'add' ? 'Add' : f.applyMode === 'date' ? 'Schedule change' : 'Save change')}
        </div>
      );
    }

    if (f.mode === 'cancel') {
      const dates = nextOccurrences(s, todayISO, 10).filter((d) => !(s.cancellations || []).some((c) => c.date === d));
      return (
        <div className="p-3 bg-slate-50 rounded-lg space-y-2">
          <p className="text-xs font-semibold text-slate-700">Cancel one {DAY_NAMES[s.day]} session</p>
          <Field label="Date">
            <select className={inputCls} value={f.cancelDate} onChange={set('cancelDate')}>
              {dates.map((d) => <option key={d} value={d}>{fmtDay(d)}</option>)}
            </select>
          </Field>
          <Field label="Reason (shown to parents)"><input className={inputCls} value={f.reason} onChange={set('reason')} placeholder="e.g. Public holiday, pool closed" /></Field>
          {actions('Cancel session')}
        </div>
      );
    }

    // remove
    return (
      <div className="p-3 bg-slate-50 rounded-lg space-y-2">
        <p className="text-xs font-semibold text-slate-700">Stop running {sessionLabel(s)}</p>
        {renderApplyChoice(f, 'Remove now', 'Stop from a date')}
        <p className="text-[11px] text-slate-500">{f.applyMode === 'date' ? 'Sessions keep running until the day before this date.' : 'It disappears from parents\' bookings straight away.'}</p>
        {actions(f.applyMode === 'date' ? 'Schedule stop' : 'Remove')}
      </div>
    );
  };

  const renderTimetable = (squad) => {
    const current = squad.sessions
      .filter((s) => !s.endsOn || s.endsOn >= todayISO)
      .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start) || String(a.startsOn).localeCompare(String(b.startsOn)));
    const changes = upcomingChanges(squad, todayISO);
    const formHere = sessionForm && sessionForm.squadId === squad.id;
    return (
      <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
        <p className="text-xs font-semibold text-slate-700">Weekly Timetable</p>
        {current.length === 0 && <p className="text-xs text-slate-400">No training times yet.</p>}
        {current.map((s) => (
          <div key={s.id} className="p-2 rounded-lg border border-slate-100 space-y-1.5">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{DAY_NAMES[s.day]} · {fmtTime(s.start)}–{fmtTime(s.end)}</p>
                <p className="text-xs text-slate-400 flex items-center gap-1"><MapPin size={10} /> {s.location}</p>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {s.startsOn && s.startsOn > todayISO && <span className="text-[10px] bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded">From {fmtDay(s.startsOn)}</span>}
                  {s.endsOn && <span className="text-[10px] bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded">Until {fmtDay(s.endsOn)}</span>}
                </div>
              </div>
              <span className="text-[11px] text-slate-400 shrink-0">{regularCount(squad.id, s.seriesId)}{squad.capacity ? `/${squad.capacity}` : ''} regulars</span>
            </div>
            <div className="flex gap-1.5">
              <button onClick={() => openSessionForm(squad, 'edit', s)} className={chipBtn}><Edit2 size={10} /> Edit</button>
              <button onClick={() => openSessionForm(squad, 'cancel', s)} className={chipBtn}><X size={10} /> Cancel a date</button>
              <button onClick={() => openSessionForm(squad, 'remove', s)} className={`${chipBtn} text-rose-600`}><Trash2 size={10} /> Remove</button>
            </div>
            {formHere && sessionForm.sessionId === s.id && renderSessionForm(squad)}
          </div>
        ))}

        {formHere && sessionForm.mode === 'add'
          ? renderSessionForm(squad)
          : <button onClick={() => openSessionForm(squad, 'add')} className={`w-full ${ghostBtn} bg-indigo-50 text-indigo-700`}><Plus size={12} /> Add training time</button>}

        {changes.length > 0 && (
          <div className="pt-2 space-y-1">
            <p className="text-xs font-semibold text-slate-700">Upcoming Changes</p>
            {changes.map((c) => (
              <div key={c.key} className="flex justify-between items-center gap-2 text-xs py-1 border-b border-slate-50">
                <div className="min-w-0">
                  <p className="font-medium text-slate-700">{fmtDay(c.date)}</p>
                  <p className={c.kind === 'cancel' ? 'text-rose-600' : 'text-slate-500'}>{c.text}</p>
                </div>
                <button onClick={() => undoSquadChange(squad, c)} className={chipBtn}><Undo2 size={10} /> Undo</button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderSquads = () => (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h2 className="font-bold text-base">{W.groups} & Timetables</h2>
        {!(squadForm && squadForm.mode === 'create') && (
          <button onClick={startCreateSquad} className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1"><Plus size={12} /> Add {W.group}</button>
        )}
      </div>
      {squadForm && squadForm.mode === 'create' && renderSquadForm()}

      {squads.map((s) => {
        if (squadForm && squadForm.mode === 'edit' && squadForm.id === s.id) return <div key={s.id}>{renderSquadForm()}</div>;
        const open = openTimetable === s.id;
        const series = seriesAsOf(s, todayISO);
        return (
          <div key={s.id} className="bg-white p-3 rounded-xl shadow-sm border border-slate-100">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <p className="font-medium text-sm">{s.name}</p>
                {s.level && <p className="text-xs text-indigo-600">{s.level}</p>}
                {s.description && <p className="text-xs text-slate-500">{s.description}</p>}
                <p className="text-xs text-slate-400">
                  {s.location || 'No location'} · {squadAthletes(s.id).length} athletes{s.capacity ? ` · max ${s.capacity}/session` : ''}{s.coach ? ` · ${s.coach}` : ''}
                </p>
                <p className="text-xs text-slate-400">{money(s.weekly)}/wk · {money(s.fortnightly)}/fn · {money(s.monthly)}/mth</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {series.length === 0 && <span className="text-[10px] text-amber-700">No training times yet</span>}
                  {series.map((x) => <span key={x.seriesId} className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{DAY_SHORT[x.day]} {fmtTime(x.start)}</span>)}
                </div>
              </div>
              <button onClick={() => startEditSquad(s)} className="shrink-0 text-xs bg-slate-100 text-slate-700 px-2 py-1.5 rounded-lg font-medium flex items-center gap-1"><Edit2 size={12} /> Details</button>
            </div>
            <button onClick={() => { setOpenTimetable(open ? null : s.id); setSessionForm(null); }} className="mt-2 w-full text-xs text-indigo-700 bg-indigo-50 py-1.5 rounded-lg font-medium flex items-center justify-center gap-1">
              <Calendar size={12} /> {open ? 'Hide timetable' : 'Days & times'} {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {open && renderTimetable(s)}
          </div>
        );
      })}
    </div>
  );

  const renderCoachSettings = () => (
    <div className="space-y-4">
      <h2 className="font-bold text-base">Settings</h2>
      {!remote && (
        <div className={`${card} text-sm`}>
          <p className="text-slate-600 text-xs">Coaches have full access: every screen, including medical details.</p>
        </div>
      )}
      {remote && <ClubSettings club={club} showFlash={showFlash} onClubChange={(c) => updateUser?.({ ...me, club: c })} onRefresh={loadFromServer} />}
      {renderPaymentMethods()}
      {renderTeamAccess()}
      {renderFinanceSettings()}
      {renderAccount()}
    </div>
  );

  // Parent screens need an athlete linked to their account
  const parentView = (render) => () => {
    if (!parentAthlete) {
      return (
        <div className="space-y-4">
          <div className={`${card} text-sm text-slate-600`}>
            Your account isn't linked to an athlete yet. Please ask the coach or treasurer to link your child to your account.
          </div>
          {activeTab === 'settings' && renderAccount()}
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {render()}
        {activeTab === 'settings' && renderAccount()}
      </div>
    );
  };

  const VIEWS = {
    parent: { home: parentView(renderParentHome), bookings: parentView(renderBookings), payments: parentView(renderPayments), settings: parentView(renderProfile) },
    treasurer: {
      home: () => <div className="space-y-4">{renderFinanceStats()}{renderReconciliation()}</div>,
      athletes: renderAthletes,
      financials: renderReports,
      settings: () => <div className="space-y-4"><h2 className="font-bold text-base">Settings</h2>{renderPaymentMethods()}{renderTeamAccess()}{renderFinanceSettings()}{renderAccount()}</div>,
    },
    coach: {
      home: renderCoachHome, attendance: renderAttendance, athletes: renderAthletes,
      squads: renderSquads, financials: renderReports, settings: renderCoachSettings,
    },
  };

  // ---------- Render ----------
  return (
    <div className="relative flex flex-col h-[100dvh] w-full bg-slate-50 text-slate-800 font-sans overflow-hidden">

      {/* DEMO ROLE SWITCHER BAR (demo mode only) */}
      {!remote && <div className="bg-slate-900 text-white p-2 text-xs flex justify-between items-center px-4">
        <span className="font-semibold flex items-center gap-1"><Shield size={14} /> Demo Mode:</span>
        <div className="flex gap-1">
          {['parent', 'treasurer', 'coach'].map((r) => (
            <button key={r} onClick={() => switchRole(r)} className={`px-2 py-1 rounded capitalize ${currentRole === r ? 'bg-indigo-600' : 'bg-slate-700'}`}>{r}</button>
          ))}
        </div>
      </div>}

      {/* HEADER BAR */}
      <header className="bg-indigo-600 text-white px-5 md:px-8 pb-4 pt-[max(1rem,env(safe-area-inset-top))] flex justify-between items-center shadow-md">
        <div>
          <h1 className="font-bold text-lg flex items-center gap-2 min-w-0">
            {club.branding?.logo && <img src={club.branding.logo} alt="" className="w-7 h-7 rounded-md bg-white object-contain shrink-0" />}
            <span className="truncate">{club.name}</span>
          </h1>
          <p className="text-xs text-indigo-200 uppercase tracking-wider font-medium">{currentRole} Portal{remote && me?.name ? ` · ${me.name}` : ''}</p>
        </div>
        {remote ? (
          <button onClick={() => signOut(false)} className="bg-indigo-700 p-2 rounded-full" aria-label="Sign out" title="Sign out"><LogOut size={20} /></button>
        ) : (
          <div className="bg-indigo-700 p-2 rounded-full">
            {currentRole === 'parent' && <User size={20} />}
            {currentRole === 'treasurer' && <DollarSign size={20} />}
            {currentRole === 'coach' && <CheckSquare size={20} />}
          </div>
        )}
      </header>

      {PREVIEW && (
        <div className="bg-amber-50 text-amber-800 text-[11px] px-4 py-1.5 border-b border-amber-100">
          Team preview · sample families only · no real payments · changes reset when you reload
        </div>
      )}

      {remote && !club.canUse && (
        <div className="bg-amber-50 text-amber-900 text-xs px-4 py-2 border-b border-amber-200 flex items-center justify-between gap-3">
          <span>
            {club.status === 'preview' && "Preview: you're looking at sample data. Nothing can be changed until the club subscribes."}
            {club.status === 'canceled' && "This club's subscription has ended, so the app is look-only. Your data is kept."}
            {club.status === 'suspended' && "This club's access has been switched off. Please contact the app provider."}
          </span>
          {currentRole === 'coach' && club.status !== 'suspended' && activeTab !== 'settings' && (
            <button onClick={() => setActiveTab('settings')} className="shrink-0 px-2.5 py-1 rounded-md bg-amber-600 text-white font-semibold">Subscribe</button>
          )}
        </div>
      )}
      {remote && club.status === 'past_due' && currentRole === 'coach' && (
        <div className="bg-amber-50 text-amber-900 text-xs px-4 py-2 border-b border-amber-200">The club's last payment didn't go through. Update the card in Settings to keep using the app.</div>
      )}

      {/* SERVER ERROR */}
      {serverError && (
        <div className="bg-rose-50 text-rose-700 text-xs px-4 py-2 border-b border-rose-100">{serverError}</div>
      )}

      {/* FLASH MESSAGE */}
      {flash && (
        <div className="absolute top-28 left-4 right-4 md:left-auto md:right-8 md:w-96 z-20 bg-slate-900 text-white text-xs px-3 py-2 rounded-lg shadow-lg flex items-center gap-2">
          <Check size={14} /> {flash}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* SIDE NAVIGATION (tablets and computers) */}
        <nav className="hidden md:flex flex-col gap-1 w-56 shrink-0 bg-white border-r border-slate-200 p-3 overflow-y-auto" aria-label="Main">
          {navFor(currentRole, W).map(([tab, Icon, label]) => (
            <button key={tab} onClick={() => setActiveTab(tab)} aria-current={activeTab === tab ? 'page' : undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-left ${activeTab === tab ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}`}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>

        {/* MAIN CONTENT AREA (SCROLLABLE) */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8 pb-28 md:pb-8">
          <div className="max-w-5xl mx-auto">
            {remote && !loaded
              ? <p className="text-sm text-slate-500 text-center pt-10">{serverError ? 'Tap Refresh in a moment, or sign in again.' : 'Loading your club…'}</p>
              : VIEWS[currentRole][activeTab]?.()}
          </div>
        </main>
      </div>

      {/* BOTTOM TAB NAVIGATION BAR (phones) */}
      <nav className="md:hidden absolute bottom-0 left-0 w-full bg-white border-t border-slate-200 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] px-2 flex justify-around items-center" aria-label="Main">
        {navFor(currentRole, W).map(([tab, Icon, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)} aria-current={activeTab === tab ? 'page' : undefined} className={`flex flex-col items-center gap-1 px-1 ${activeTab === tab ? 'text-indigo-600' : 'text-slate-400'}`}>
            <Icon size={20} /><span className="text-[10px] font-medium">{label}</span>
          </button>
        ))}
      </nav>

    </div>
  );
}
