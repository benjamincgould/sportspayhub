import React, { useState, useEffect } from 'react';
import { Shield, LogOut, Plus, Gift, Ban, RotateCcw, Copy, Check, Search, CreditCard, ExternalLink, UserPlus } from './icons';
import { api } from './api';
import { AccountSecurity } from './AuthScreens';
import SportsClubApp from './SportsClubApp';
import { BRAND_COLOURS, applyBrandColour } from './brand';
import { DEMO_SPORTS, demoClubFrom, demoLink } from './demo';

// The platform owner's screen: every club, its subscription, free access and switching clubs off.
// It deliberately shows no member names, contact details or medical information.

const STATUS = {
  preview: ['Previewing', 'bg-slate-100 text-slate-600'],
  active: ['Paying', 'bg-emerald-50 text-emerald-700'],
  comped: ['Free', 'bg-indigo-50 text-indigo-700'],
  past_due: ['Payment failed', 'bg-amber-50 text-amber-700'],
  canceled: ['Cancelled', 'bg-slate-200 text-slate-600'],
  suspended: ['Switched off', 'bg-rose-50 text-rose-700'],
};
const SPORTS = ['Swimming', 'Football', 'Rugby', 'Netball', 'Basketball', 'Hockey', 'Cricket', 'Athletics', 'Gymnastics', 'Tennis', 'Dance', 'Martial arts', 'Cycling', 'Rowing', 'Other'];
const field = 'w-full mt-1 p-2 border border-slate-200 rounded-lg text-sm bg-white';
const card = 'bg-white p-4 rounded-xl shadow-sm border border-slate-100';
const btn = 'py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold disabled:opacity-50';

const nzd = (n) => `$${Number(n || 0).toFixed(2)}`;
const CHARGE_STATUS = { open: ['Waiting for payment', 'bg-amber-50 text-amber-700'], paid: ['Paid', 'bg-emerald-50 text-emerald-700'], void: ['Cancelled', 'bg-slate-100 text-slate-500'] };

// Add someone to run a club: a treasurer (or another coach), with a title the owner can change
const DEFAULT_TITLE = { treasurer: 'Treasurer', coach: 'Coach' };
function AddClubMember({ club, onDone, onClose, showFlash }) {
  const [form, setForm] = useState({ role: 'treasurer', title: DEFAULT_TITLE.treasurer, name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const setRole = (role) => setForm((f) => ({ ...f, role, title: !f.title || f.title === DEFAULT_TITLE[f.role] ? DEFAULT_TITLE[role] : f.title }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api(`/api/owner/clubs/${club.id}/members`, { method: 'POST', body: form });
      setResult({ ...res, email: form.email });
      onDone();
    } catch (err) {
      showFlash(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2 text-xs text-emerald-900">
        <p>
          {result.alreadyMember ? `${result.email} already has an account at ${club.name}; their title is now "${result.title || DEFAULT_TITLE[result.role]}".`
            : result.emailed ? `Invite emailed to ${result.email}. They choose a password and set up two-step verification, then they're in as ${result.title || DEFAULT_TITLE[result.role]}.`
            : `Email isn't set up, so send ${result.email} this link. It works once, for 3 days.`}
        </p>
        {result.inviteUrl && <code className="block p-2 bg-white rounded border border-emerald-200 break-all select-all font-mono text-[11px]">{result.inviteUrl}</code>}
        <div className="flex gap-3">
          <button type="button" onClick={() => setResult(null)} className="font-semibold">Add another person</button>
          <button type="button" onClick={onClose} className="font-semibold">Done</button>
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="p-3 bg-slate-50 rounded-lg space-y-2">
      <p className="text-xs font-semibold text-slate-700">Add a person to {club.name}</p>
      <label className="block text-xs text-slate-500">Access
        <select value={form.role} onChange={(e) => setRole(e.target.value)} className={field} aria-label="Access">
          <option value="treasurer">Treasurer: payments, reports, contact details (no medical)</option>
          <option value="coach">Coach: everything, including medical details</option>
        </select>
      </label>
      <label className="block text-xs text-slate-500">Title shown in the app
        <input required maxLength={60} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Club Administrator" className={field} aria-label="Title" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-slate-500">Name
          <input maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} aria-label="Their name" />
        </label>
        <label className="block text-xs text-slate-500">Email
          <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={field} aria-label="Their email" />
        </label>
      </div>
      <p className="text-[11px] text-slate-500">They get an email to set their password, and set up two-step verification the first time they sign in. The club's coaches can change their title later.</p>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={`flex-1 ${btn}`}>{busy ? 'Sending…' : 'Send invite'}</button>
        <button type="button" onClick={onClose} className="flex-1 py-2 bg-white border border-slate-200 rounded-lg text-xs font-semibold">Cancel</button>
      </div>
    </form>
  );
}

// The sales demo: dress the sample club in a prospect's name, sport and colour, then show it here
// or send them a link. Nothing in the demo is saved or sent anywhere.
function DemoSetup({ onOpen, showFlash }) {
  const [form, setForm] = useState({ name: '', sport: 'Swimming', colour: 'indigo' });
  const [copied, setCopied] = useState(false);
  const link = demoLink(window.location.origin, form);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); showFlash('Demo link copied'); } catch { showFlash('Select the link and copy it'); }
  };
  return (
    <div className={`${card} space-y-3`}>
      <div>
        <h2 className="font-semibold text-sm">Demo club</h2>
        <p className="text-xs text-slate-500">Show a club what the app looks like before they sign up. It's a pretend club with sample members, groups, bookings and payments, and you can switch between the parent, treasurer and coach views. Nothing is saved, no emails are sent and no real payments are taken; it starts fresh each time.</p>
      </div>
      <label className="block text-xs text-slate-500">Their club's name (optional)
        <input maxLength={60} value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setCopied(false); }} placeholder="e.g. Riverside Rugby Club" className={field} aria-label="Demo club name" />
      </label>
      <label className="block text-xs text-slate-500">Sport
        <select value={form.sport} onChange={(e) => { setForm({ ...form, sport: e.target.value }); setCopied(false); }} className={field} aria-label="Demo sport">
          {DEMO_SPORTS.map((s) => <option key={s}>{s}</option>)}
        </select>
      </label>
      <div className="text-xs text-slate-500">Colour
        <div className="flex flex-wrap gap-2 mt-1">
          {BRAND_COLOURS.map((c) => (
            <button key={c.name} type="button" onClick={() => { setForm({ ...form, colour: c.name }); setCopied(false); }} aria-label={`Colour ${c.label}`} title={c.label}
              className={`w-7 h-7 rounded-full border-2 ${form.colour === c.name ? 'border-slate-900' : 'border-white'}`} style={{ background: c.swatch }} />
          ))}
        </div>
      </div>
      <p className="text-[11px] text-slate-400">They'll see it as a {form.sport.toLowerCase()} club, using words like "{demoClubFrom(form).branding.group}" and "{demoClubFrom(form).branding.member}".</p>
      <button type="button" onClick={() => onOpen(demoClubFrom(form))} className={`w-full ${btn} py-2.5`}>Open the demo</button>
      <div className="pt-2 border-t border-slate-100 space-y-1.5">
        <p className="text-xs font-semibold text-slate-700">Or send them a link to try it themselves</p>
        <p className="text-[11px] text-slate-500">Anyone with the link can open the demo without signing in. It only ever shows the sample club.</p>
        <div className="flex gap-2 items-center">
          <code className="flex-1 p-2 bg-slate-50 rounded border border-slate-200 break-all select-all font-mono text-[11px]">{link}</code>
          <button type="button" onClick={copy} className="p-2 bg-white rounded border border-slate-200" aria-label="Copy demo link">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        </div>
      </div>
    </div>
  );
}

// A club's staff (coaches and treasurers; parents and members are the club's own business):
// change access or title, switch off, delete, or add someone
function ClubPeople({ club, onChanged, showFlash }) {
  const [people, setPeople] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [retitling, setRetitling] = useState(null); // { id, title }
  const base = `/api/owner/clubs/${club.id}/people`;
  const load = async () => {
    try { setPeople(await api(base)); } catch (err) { showFlash(err.message); }
  };
  useEffect(() => { load(); }, [club.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, done) => {
    try { await fn(); showFlash(done); } catch (err) { showFlash(err.message); }
    setConfirm('');
    load();
    onChanged();
  };
  const twoTap = (key, fn, done) => (confirm === key ? act(fn, done) : setConfirm(key));
  const who = (u) => u.name || u.email;

  return (
    <div className="p-3 bg-slate-50 rounded-lg space-y-2">
      <div className="flex justify-between items-center">
        <p className="text-xs font-semibold text-slate-700">People who run {club.name}</p>
        {!adding && <button type="button" onClick={() => setAdding(true)} className="text-[11px] bg-slate-900 text-white px-2 py-1 rounded-md font-medium flex items-center gap-1"><UserPlus size={11} /> Add a person</button>}
      </div>
      {adding && <AddClubMember club={club} onDone={() => { load(); onChanged(); }} onClose={() => setAdding(false)} showFlash={showFlash} />}
      {!people && <p className="text-xs text-slate-400">Loading…</p>}
      {people && people.length === 0 && <p className="text-xs text-slate-400">No coaches or treasurers yet.</p>}
      {people && people.map((u) => (
        <div key={u.id} className="py-2 border-t border-slate-200 space-y-1.5">
          <div className="flex justify-between items-start gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{who(u)}</p>
              <p className="text-xs text-indigo-700">{u.title || (u.role === 'coach' ? 'Coach' : 'Treasurer')}</p>
              <p className="text-[11px] text-slate-400 truncate">{u.email} · {u.lastLoginAt ? `last signed in ${new Date(u.lastLoginAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}` : 'never signed in'}</p>
            </div>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0 ${u.status === 'active' ? 'bg-emerald-50 text-emerald-700' : u.status === 'invited' ? 'bg-amber-50 text-amber-700' : 'bg-slate-200 text-slate-600'}`}>
              {u.status === 'active' ? 'Active' : u.status === 'invited' ? 'Invited' : 'Switched off'}
            </span>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-slate-500">Access
            <select value={u.role} aria-label={`Access for ${u.email}`} onChange={(e) => { const role = e.target.value; act(() => api(`${base}/${u.id}/role`, { method: 'PUT', body: { role } }), `${who(u)} now has ${role} access`); }} className="text-[11px] border border-slate-200 rounded-md px-1.5 py-1 bg-white">
              <option value="coach">Coach: everything, including medical</option>
              <option value="treasurer">Treasurer: payments, reports, contacts</option>
            </select>
          </label>
          {retitling?.id === u.id ? (
            <div className="flex gap-2">
              <input value={retitling.title} maxLength={60} onChange={(e) => setRetitling({ ...retitling, title: e.target.value })} placeholder={u.role === 'coach' ? 'Coach' : 'Treasurer'} aria-label={`Title for ${u.email}`} className={`${field} mt-0 flex-1`} />
              <button type="button" onClick={() => { const title = retitling.title; setRetitling(null); act(() => api(`${base}/${u.id}/title`, { method: 'PUT', body: { title } }), 'Title updated'); }} className="px-3 bg-slate-900 text-white rounded-lg text-xs font-semibold">Save</button>
              <button type="button" onClick={() => setRetitling(null)} className="px-3 bg-white border border-slate-200 rounded-lg text-xs font-semibold">Cancel</button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setRetitling({ id: u.id, title: u.title || '' })} className="text-[11px] bg-white border border-slate-200 text-slate-700 px-2 py-1 rounded-md font-medium">Edit title</button>
              <button type="button" onClick={() => twoTap(`status-${u.id}`, () => api(`${base}/${u.id}/status`, { method: 'POST', body: { status: u.status === 'disabled' ? 'active' : 'disabled' } }), u.status === 'disabled' ? 'Switched back on' : 'Switched off and signed out')} className={`text-[11px] px-2 py-1 rounded-md font-medium ${confirm === `status-${u.id}` ? 'bg-rose-600 text-white' : 'bg-white border border-slate-200 text-rose-700'}`}>
                {confirm === `status-${u.id}` ? 'Tap again to confirm' : u.status === 'disabled' ? 'Switch on' : 'Switch off'}
              </button>
              <button type="button" onClick={() => twoTap(`delete-${u.id}`, () => api(`${base}/${u.id}`, { method: 'DELETE' }), `${who(u)} deleted`)} className={`text-[11px] px-2 py-1 rounded-md font-medium ${confirm === `delete-${u.id}` ? 'bg-rose-600 text-white' : 'bg-white border border-slate-200 text-rose-700'}`}>
                {confirm === `delete-${u.id}` ? 'Tap again: delete for good' : u.status === 'invited' ? 'Cancel invite' : 'Delete'}
              </button>
            </div>
          )}
        </div>
      ))}
      <p className="text-[11px] text-slate-400">Changing access signs them out, so the new access applies straight away. A club always keeps at least one coach. Parents are managed by the club's coaches.</p>
    </div>
  );
}

// One club's price, set-up fee and charges: set them, charge any amount, cancel unpaid charges
function ClubBilling({ club, defaults, onChanged, showFlash }) {
  const p = club.pricing;
  const [price, setPrice] = useState({ monthly: p.customMonthly ? String(p.monthlyPriceNzd) : '', setup: p.customSetupFee ? String(p.setupFeeNzd) : '' });
  const [charge, setCharge] = useState({ amountNzd: '', description: '', kind: 'oneoff' });
  const [charges, setCharges] = useState(null);
  const [busy, setBusy] = useState('');
  const [confirmVoid, setConfirmVoid] = useState(null);

  const loadCharges = () => api(`/api/owner/clubs/${club.id}/charges`).then(setCharges).catch((e) => showFlash(e.message));
  useEffect(() => { loadCharges(); }, [club.id]);

  const savePricing = async (e) => {
    e.preventDefault();
    setBusy('pricing');
    try {
      const res = await api(`/api/owner/clubs/${club.id}/pricing`, { method: 'PUT', body: { monthlyPriceNzd: price.monthly === '' ? null : price.monthly, setupFeeNzd: price.setup === '' ? null : price.setup } });
      showFlash(res.movedSubscription ? `Saved. ${club.name} pays the new price from their next bill.` : 'Pricing saved');
      onChanged();
    } catch (err) { showFlash(err.message); }
    setBusy('');
  };

  const sendCharge = async (e) => {
    e.preventDefault();
    setBusy('charge');
    try {
      await api(`/api/owner/clubs/${club.id}/charges`, { method: 'POST', body: charge });
      showFlash(`Payment request for ${nzd(charge.amountNzd)} emailed to ${club.name}`);
      setCharge({ amountNzd: '', description: '', kind: 'oneoff' });
      loadCharges();
      onChanged();
    } catch (err) { showFlash(err.message); }
    setBusy('');
  };

  const markPaid = async (id) => {
    if (confirmVoid !== `paid-${id}`) { setConfirmVoid(`paid-${id}`); return; }
    setConfirmVoid(null);
    try { await api(`/api/owner/charges/${id}/mark-paid`, { method: 'POST' }); showFlash('Marked as paid'); loadCharges(); onChanged(); } catch (err) { showFlash(err.message); }
  };

  const voidCharge = async (id) => {
    if (confirmVoid !== id) { setConfirmVoid(id); return; }
    setConfirmVoid(null);
    try { await api(`/api/owner/charges/${id}/void`, { method: 'POST' }); showFlash('Charge cancelled'); loadCharges(); onChanged(); } catch (err) { showFlash(err.message); }
  };

  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-4">
      <form onSubmit={savePricing} className="space-y-2">
        <p className="text-xs font-semibold text-slate-700">Price for this club</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-slate-500">Monthly price (NZD)
            <input inputMode="decimal" value={price.monthly} onChange={(e) => setPrice({ ...price, monthly: e.target.value })} placeholder={`Default ${nzd(defaults.priceNzd)}`} className={field} />
          </label>
          <label className="block text-xs text-slate-500">Set-up fee (NZD, once)
            <input inputMode="decimal" value={price.setup} onChange={(e) => setPrice({ ...price, setup: e.target.value })} placeholder={`Default ${nzd(defaults.setupFeeNzd)}`} className={field} />
          </label>
        </div>
        <p className="text-[11px] text-slate-500">
          Leave a box empty to use the default. The set-up fee is added to the club's first subscription payment
          {p.setupFeePaid ? ' (already paid).' : p.setupFeeInvoiced ? ' (already sent as a payment request).' : '.'}
          {' '}A club that's already paying moves to a new monthly price from its next bill.
        </p>
        <button type="submit" disabled={busy !== ''} className="w-full py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold disabled:opacity-50">{busy === 'pricing' ? 'Saving…' : 'Save price'}</button>
      </form>

      <form onSubmit={sendCharge} className="space-y-2 pt-3 border-t border-slate-200">
        <p className="text-xs font-semibold text-slate-700">Charge this club now</p>
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          <label className="block text-xs text-slate-500">Amount (NZD)
            <input inputMode="decimal" required value={charge.amountNzd} onChange={(e) => setCharge({ ...charge, amountNzd: e.target.value })} placeholder="e.g. 150" className={field} />
          </label>
          <label className="block text-xs text-slate-500">What it's for
            <input required maxLength={120} value={charge.description} onChange={(e) => setCharge({ ...charge, description: e.target.value })} placeholder="e.g. Set-up and training" className={field} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={charge.kind === 'setup'} onChange={(e) => setCharge({ ...charge, kind: e.target.checked ? 'setup' : 'oneoff' })} /> This is their set-up fee (so it isn't charged again when they subscribe)
        </label>
        <p className="text-[11px] text-slate-500">
          The club's coaches get an email{defaults.payMethods?.card ? ' with a secure card payment page' : ''}{defaults.payMethods?.bank ? `${defaults.payMethods?.card ? ' and' : ' with'} your bank details and a reference` : ''}. It also shows in their Settings. They have 14 days to pay.
        </p>
        <button type="submit" disabled={busy !== '' || !(defaults.payMethods?.card || defaults.payMethods?.bank)} className="w-full py-2 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1">
          <CreditCard size={12} /> {busy === 'charge' ? 'Sending…' : 'Send payment request'}
        </button>
        {!(defaults.payMethods?.card || defaults.payMethods?.bank) && <p className="text-[11px] text-amber-700">First set up how clubs pay you, in the Payment details tab.</p>}
      </form>

      <div className="space-y-1.5 pt-3 border-t border-slate-200">
        <p className="text-xs font-semibold text-slate-700">Charges</p>
        {charges === null && <p className="text-[11px] text-slate-400">Loading…</p>}
        {charges?.length === 0 && <p className="text-[11px] text-slate-400">No charges yet.</p>}
        {charges?.map((c) => {
          const [label, cls] = CHARGE_STATUS[c.status] || [c.status, ''];
          return (
            <div key={c.id} className="flex items-center justify-between gap-2 text-xs bg-white rounded-md border border-slate-100 p-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{c.description}</p>
                <p className="text-[11px] text-slate-400">{nzd(c.amountNzd)} · {new Date(c.createdAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}{c.reference ? ` · ref ${c.reference}` : ''}{c.kind === 'setup' ? ' · set-up fee' : ''}{c.paidMethod ? ` · paid by ${c.paidMethod === 'bank' ? 'bank transfer' : c.paidMethod}` : ''}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${cls}`}>{label}</span>
                {c.status === 'open' && c.payUrl && <a href={c.payUrl} target="_blank" rel="noopener noreferrer" className="p-1 text-slate-500" aria-label="Open payment page"><ExternalLink size={12} /></a>}
                {c.status === 'open' && (
                  <button type="button" onClick={() => markPaid(c.id)} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${confirmVoid === `paid-${c.id}` ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700'}`}>
                    {confirmVoid === `paid-${c.id}` ? 'Tap again' : 'Mark paid'}
                  </button>
                )}
                {c.status === 'open' && (
                  <button type="button" onClick={() => voidCharge(c.id)} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${confirmVoid === c.id ? 'bg-rose-600 text-white' : 'bg-slate-100 text-rose-700'}`}>
                    {confirmVoid === c.id ? 'Tap again' : 'Cancel'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// How clubs pay you: card through Stripe, bank transfer, or both
function PaymentDetails({ showFlash, onSaved }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/owner/payment-settings').then(setS).catch((e) => showFlash(e.message)); }, []);
  if (!s) return <p className="text-sm text-slate-500">Loading…</p>;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api('/api/owner/payment-settings', { method: 'PUT', body: { card: s.card, bank: s.bank, bankAccountName: s.bankAccountName, bankAccountNumber: s.bankAccountNumber, instructions: s.instructions } });
      setS(res);
      showFlash('Payment details saved');
      onSaved?.();
    } catch (err) { showFlash(err.message); }
    setBusy(false);
  };

  return (
    <form onSubmit={save} className={`${card} space-y-4 text-sm`}>
      <div>
        <h3 className="font-semibold flex items-center gap-1.5"><CreditCard size={14} /> How clubs pay you</h3>
        <p className="text-xs text-slate-500 mt-1">Every payment request you send shows the ways you turn on here. Monthly subscriptions are always by card through Stripe.</p>
      </div>

      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={s.card} disabled={!s.stripeConnected} onChange={(e) => setS({ ...s, card: e.target.checked })} />
        <span>
          <span className="font-medium">Card, through Stripe</span>
          <span className="block text-xs text-slate-500">Clubs pay on a secure page and it's marked paid automatically. Stripe pays the money into the bank account you give Stripe, usually within a few days (fee about 2.7% + 30c).</span>
          {!s.stripeConnected && <span className="block text-xs text-amber-700 mt-1">Not available yet: add STRIPE_SECRET_KEY in Vercel and redeploy.</span>}
        </span>
      </label>

      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={s.bank} onChange={(e) => setS({ ...s, bank: e.target.checked })} />
        <span>
          <span className="font-medium">Bank transfer</span>
          <span className="block text-xs text-slate-500">No fees. Requests show your account and a reference. When the money arrives, tap "Mark paid" on the charge.</span>
        </span>
      </label>

      {s.bank && (
        <div className="space-y-2 pl-6">
          <label className="block text-xs text-slate-500">Account name
            <input required value={s.bankAccountName} onChange={(e) => setS({ ...s, bankAccountName: e.target.value })} placeholder="e.g. Your Business Ltd" maxLength={80} className={field} />
          </label>
          <label className="block text-xs text-slate-500">Account number
            <input required inputMode="numeric" value={s.bankAccountNumber} onChange={(e) => setS({ ...s, bankAccountNumber: e.target.value })} placeholder="12-3456-0123456-00" className={field} />
          </label>
          <label className="block text-xs text-slate-500">Note for payers (optional)
            <input value={s.instructions} onChange={(e) => setS({ ...s, instructions: e.target.value })} placeholder="e.g. Please use the reference so we can match your payment" maxLength={200} className={field} />
          </label>
        </div>
      )}

      {!s.available.card && !s.available.bank && <p className="text-xs text-amber-700">Turn on at least one way to pay before sending payment requests.</p>}
      <button type="submit" disabled={busy} className="w-full py-2.5 bg-slate-900 text-white rounded-lg text-xs font-semibold disabled:opacity-50">{busy ? 'Saving…' : 'Save payment details'}</button>
    </form>
  );
}

export function OwnerConsole({ user, signOut, updateUser }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [form, setForm] = useState(null);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('clubs');
  const [demo, setDemo] = useState(null); // the demo club being shown
  const [deleting, setDeleting] = useState(null); // { id, name, typed }
  const [billingFor, setBillingFor] = useState(null); // club id
  const [addingTo, setAddingTo] = useState(null);     // club id: adding a person

  const showFlash = (m) => { setFlash(m); setTimeout(() => setFlash(''), 3500); };
  const load = () => api('/api/owner/clubs').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const setAccess = async (club, access) => {
    const key = `${access}-${club.id}`;
    if (access !== 'free' && confirm !== key) { setConfirm(key); return; }
    setConfirm(null);
    try {
      await api(`/api/owner/clubs/${club.id}/access`, { method: 'POST', body: { access } });
      showFlash(access === 'free' ? `${club.name} now has free access` : access === 'suspend' ? `${club.name} is switched off` : `${club.name} is back on its normal subscription`);
      load();
    } catch (e) { showFlash(e.message); }
  };

  const deleteClub = async () => {
    try {
      await api(`/api/owner/clubs/${deleting.id}/delete`, { method: 'POST', body: { confirmName: deleting.typed } });
      showFlash(`${deleting.name} and all its data have been deleted`);
      setDeleting(null);
      load();
    } catch (e) { showFlash(e.message); }
  };

  const createClub = async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/owner/clubs', { method: 'POST', body: form });
      setCreated({ email: form.email, url: res.inviteUrl, emailed: res.emailed, charge: res.charge });
      setForm(null);
      load();
    } catch (err) { showFlash(err.message); }
  };

  const clubs = (data?.clubs || []).filter((c) => !query || `${c.name} ${c.sport} ${c.contact?.email || ''}`.toLowerCase().includes(query.toLowerCase()));
  const counts = (data?.clubs || []).reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {});
  const monthly = (data?.clubs || []).filter((c) => ['active', 'past_due'].includes(c.status)).reduce((sum, c) => sum + (c.pricing?.monthlyPriceNzd || 0), 0);
  const owed = (data?.clubs || []).reduce((sum, c) => sum + (c.openChargesNzd || 0), 0);

  if (demo) {
    return <SportsClubApp key={JSON.stringify(demo)} mode="demo" demoClub={demo} onExitDemo={() => { applyBrandColour('indigo'); setDemo(null); }} />;
  }

  return (
    <div className="relative flex flex-col h-[100dvh] w-full bg-slate-50 text-slate-800 font-sans overflow-hidden">
      <header className="bg-slate-900 text-white px-5 md:px-8 pb-4 pt-[max(1rem,env(safe-area-inset-top))] flex justify-between items-center">
        <div>
          <h1 className="font-bold text-lg flex items-center gap-1.5"><Shield size={18} /> Owner Console</h1>
          <p className="text-xs text-slate-300">{user.name || user.email}</p>
        </div>
        <button type="button" onClick={() => signOut(false)} className="bg-slate-700 p-2 rounded-full" aria-label="Sign out" title="Sign out"><LogOut size={20} /></button>
      </header>
      {flash && <div className="absolute top-20 left-4 right-4 md:left-auto md:right-8 md:w-96 z-20 bg-slate-900 text-white text-xs px-3 py-2 rounded-lg shadow-lg flex items-center gap-2"><Check size={14} /> {flash}</div>}

      <div className="border-b border-slate-200 bg-white md:px-8">
        <div className="flex max-w-3xl mx-auto">
          {[['clubs', 'Clubs'], ['demo', 'Demo'], ['payments', 'Payment details'], ['account', 'My account']].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`flex-1 md:flex-none md:px-6 py-2.5 text-sm font-medium ${tab === k ? 'text-slate-900 border-b-2 border-slate-900' : 'text-slate-500'}`}>{label}</button>
          ))}
        </div>
      </div>

      <main className="flex-1 overflow-y-auto p-4 md:p-8 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="max-w-3xl mx-auto space-y-3">
        {tab === 'account' && <AccountSecurity user={user} onUserChange={updateUser} signOut={signOut} showFlash={showFlash} />}
        {tab === 'payments' && <PaymentDetails showFlash={showFlash} onSaved={load} />}
        {tab === 'demo' && <DemoSetup onOpen={setDemo} showFlash={showFlash} />}

        {tab === 'clubs' && (
          <>
            {error && <div className="text-sm text-rose-700 bg-rose-50 p-3 rounded-lg">{error}</div>}
            <div className="grid grid-cols-3 gap-2">
              <div className={`${card} p-3`}><p className="text-[11px] text-slate-400">Paying</p><p className="text-lg font-bold text-emerald-600">{counts.active || 0}</p></div>
              <div className={`${card} p-3`}><p className="text-[11px] text-slate-400">Free</p><p className="text-lg font-bold text-indigo-600">{counts.comped || 0}</p></div>
              <div className={`${card} p-3`}><p className="text-[11px] text-slate-400">Previewing</p><p className="text-lg font-bold text-slate-700">{counts.preview || 0}</p></div>
            </div>
            <p className="text-[11px] text-slate-400 px-1">About {nzd(monthly)} a month from paying clubs (before Stripe fees){owed > 0 ? ` · ${nzd(owed)} in payment requests waiting` : ''}. Default price {nzd(data?.priceNzd)} a month.</p>

            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clubs" aria-label="Search clubs" className="w-full pl-8 pr-3 py-2 border border-slate-200 rounded-lg text-sm bg-white" />
              </div>
              {!form && <button type="button" onClick={() => { setCreated(null); setForm({ clubName: '', sport: 'Swimming', name: '', email: '', free: true, monthlyPriceNzd: '', setupFeeNzd: '' }); }} className="px-3 bg-slate-900 text-white rounded-lg text-xs font-semibold flex items-center gap-1"><Plus size={12} /> Set up a club</button>}
            </div>

            {form && (
              <form onSubmit={createClub} className={`${card} space-y-2`}>
                <p className="text-sm font-semibold">Set up a club for someone</p>
                <label className="block text-xs text-slate-500">Club name<input required value={form.clubName} onChange={(e) => setForm({ ...form, clubName: e.target.value })} className={field} /></label>
                <label className="block text-xs text-slate-500">Sport
                  <select value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })} className={field}>{SPORTS.map((s) => <option key={s}>{s}</option>)}</select>
                </label>
                <label className="block text-xs text-slate-500">Coach's name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} /></label>
                <label className="block text-xs text-slate-500">Coach's email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={field} /></label>
                <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={form.free} onChange={(e) => setForm({ ...form, free: e.target.checked })} /> Free access (no subscription needed)</label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-slate-500">Monthly price (NZD)
                    <input inputMode="decimal" value={form.monthlyPriceNzd} onChange={(e) => setForm({ ...form, monthlyPriceNzd: e.target.value })} placeholder={`Default ${nzd(data?.priceNzd)}`} className={field} />
                  </label>
                  <label className="block text-xs text-slate-500">Set-up fee (NZD, once)
                    <input inputMode="decimal" value={form.setupFeeNzd} onChange={(e) => setForm({ ...form, setupFeeNzd: e.target.value })} placeholder="None" className={field} />
                  </label>
                </div>
                <p className="text-[11px] text-slate-500">{form.free
                  ? 'With free access, a set-up fee is sent to the coach as a payment request straight away.'
                  : 'The set-up fee is added to the club\'s first subscription payment.'}</p>
                <div className="flex gap-2">
                  <button type="submit" className="flex-1 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold">Create club & invite coach</button>
                  <button type="button" onClick={() => setForm(null)} className="flex-1 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
                </div>
              </form>
            )}

            {created && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2 text-xs text-emerald-900">
                <p>{created.emailed ? `Invite emailed to ${created.email}.` : `Send ${created.email} this link. It works once, for 3 days.`}</p>
                {created.charge && <p>A payment request for the {nzd(created.charge.amountNzd)} set-up fee has been emailed too.</p>}
                {created.url && <div className="flex gap-2 items-center">
                  <code className="flex-1 p-2 bg-white rounded border border-emerald-200 break-all select-all font-mono text-[11px]">{created.url}</code>
                  <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(created.url); setCopied(true); } catch { /* select it instead */ } }} className="p-2 bg-white rounded border border-emerald-200" aria-label="Copy link">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
                </div>}
                <button type="button" onClick={() => { setCreated(null); setCopied(false); }} className="font-semibold">Done</button>
              </div>
            )}

            {data && clubs.length === 0 && <p className="text-sm text-slate-500 text-center py-6">{query ? 'No clubs match.' : 'No clubs yet. They appear here as soon as someone signs up.'}</p>}
            {clubs.map((c) => {
              const [label, cls] = STATUS[c.status] || [c.status, 'bg-slate-100 text-slate-600'];
              return (
                <div key={c.id} className={`${card} space-y-2`}>
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm">{c.name}</p>
                      <p className="text-xs text-slate-500">{c.sport} · {c.athletes} members · {c.users} accounts</p>
                      <p className="text-xs text-slate-400 truncate">{c.contact ? `${c.contact.name || 'Coach'} · ${c.contact.email}` : 'No coach yet'}</p>
                      <p className="text-[11px] text-slate-400">Joined {new Date(c.createdAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}{c.renewsOn ? ` · renews ${c.renewsOn}` : ''}</p>
                      <p className="text-[11px] text-slate-500">{nzd(c.pricing.monthlyPriceNzd)}/month{c.pricing.customMonthly ? ' (own price)' : ''}{c.pricing.setupFeeNzd > 0 ? ` · set-up ${nzd(c.pricing.setupFeeNzd)}${c.pricing.setupFeePaid ? ' paid' : ''}` : ''}{c.openCharges ? ` · ${nzd(c.openChargesNzd)} waiting` : ''}</p>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0 ${cls}`}>{label}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => setBillingFor(billingFor === c.id ? null : c.id)} className={`text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 ${billingFor === c.id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}><CreditCard size={11} /> Price & charges</button>
                    <button type="button" onClick={() => setAddingTo(addingTo === c.id ? null : c.id)} className={`text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 ${addingTo === c.id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}><UserPlus size={11} /> People</button>
                    {c.status !== 'comped' && <button type="button" onClick={() => setAccess(c, 'free')} className="text-[11px] bg-indigo-50 text-indigo-700 px-2 py-1 rounded-md font-medium flex items-center gap-1"><Gift size={11} /> Give free access</button>}
                    {['comped', 'suspended'].includes(c.status) && (
                      <button type="button" onClick={() => setAccess(c, 'normal')} className={`text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 ${confirm === `normal-${c.id}` ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}>
                        <RotateCcw size={11} /> {confirm === `normal-${c.id}` ? 'Tap again: back to paying' : 'Back to normal subscription'}
                      </button>
                    )}
                    <button type="button" onClick={() => setDeleting({ id: c.id, name: c.name, typed: '' })} className="text-[11px] px-2 py-1 rounded-md font-medium bg-slate-100 text-rose-700">Delete club…</button>
                    {c.status !== 'suspended' && (
                      <button type="button" onClick={() => setAccess(c, 'suspend')} className={`text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 ${confirm === `suspend-${c.id}` ? 'bg-rose-600 text-white' : 'bg-slate-100 text-rose-700'}`}>
                        <Ban size={11} /> {confirm === `suspend-${c.id}` ? 'Tap again to switch off' : 'Switch off'}
                      </button>
                    )}
                  </div>
                  {addingTo === c.id && <ClubPeople club={c} onChanged={load} showFlash={showFlash} />}
                  {billingFor === c.id && <ClubBilling club={c} defaults={{ priceNzd: data.priceNzd, setupFeeNzd: data.setupFeeNzd, stripe: data.stripe, payMethods: data.payMethods }} onChanged={load} showFlash={showFlash} />}
                  {deleting && deleting.id === c.id && (
                    <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg space-y-2">
                      <p className="text-xs text-rose-900">This permanently deletes {c.name}: every account, member, medical record, group, booking and ledger entry. Their subscription is cancelled. It can't be undone.</p>
                      <label className="block text-xs text-rose-900">Type <b>{c.name}</b> to confirm
                        <input value={deleting.typed} onChange={(e) => setDeleting({ ...deleting, typed: e.target.value })} className={field} aria-label="Club name to confirm" />
                      </label>
                      <div className="flex gap-2">
                        <button type="button" onClick={deleteClub} disabled={deleting.typed !== c.name} className="flex-1 py-2 bg-rose-600 text-white rounded-lg text-xs font-semibold disabled:opacity-40">Delete for good</button>
                        <button type="button" onClick={() => setDeleting(null)} className="flex-1 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
        </div>
      </main>
    </div>
  );
}
